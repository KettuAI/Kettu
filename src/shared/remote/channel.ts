// Channel messages over the Noise transport ciphers a handshake splits into. Each frame is one
// transport message: a flags byte, the payload's length, the payload, and zeros up to one of a
// few sizes, so the relay learns only those. A message too long for one frame spans several.

import { MAX_NOISE_MESSAGE, type TransportCiphers } from './noise'

/** The longest message, joined from its frames or inflated. */
export const MAX_MESSAGE = 32 * 1024 * 1024

const TAGLEN = 16
const MAX_FRAME = MAX_NOISE_MESSAGE - TAGLEN
const MIN_FRAME = 256
const HEADER = 3
const MAX_PAYLOAD = MAX_FRAME - HEADER
const STREAM_ID = 4
const COMPRESS_OVER = 1024

/** The most bytes of a stream one frame carries, so a bytes message this long is one frame. */
export const BYTES_PER_FRAME = MAX_PAYLOAD - STREAM_ID

const KIND = 0b11
const JSON_KIND = 0
const DEFLATED_JSON_KIND = 1
const BYTES_KIND = 2
const REKEY = 0x40
const MORE = 0x80
const KNOWN_FLAGS = KIND | REKEY | MORE

const REKEY_BYTES = 1024 ** 3
const REKEY_INTERVAL = 60 * 60 * 1000

export type ChannelMessage =
  | { kind: 'json'; value: unknown }
  /** Part of the byte stream `stream`, a 32-bit unsigned id. */
  | { kind: 'bytes'; stream: number; data: Uint8Array }

export interface ChannelHandlers {
  /** Takes each transport message to send, in order. */
  write: (frame: Uint8Array) => void
  message: (message: ChannelMessage) => void
  /** The channel has ended for good, for the caller to close its connection. */
  end: (error: Error) => void
}

export interface ChannelOptions {
  /** Bytes a sending key carries before it changes, 1 GiB unless a test lowers it. */
  rekeyBytes?: number
  /** Milliseconds a sending key is used before it changes, an hour unless a test lowers it. */
  rekeyInterval?: number
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

// WebCrypto and Blob take views of an ArrayBuffer; nothing here holds a SharedArrayBuffer.
const buffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => bytes as Uint8Array<ArrayBuffer>

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** The smallest of 256, 512, 1,024 and so on that holds `length`, or the largest frame. */
function paddedSize(length: number): number {
  let size = MIN_FRAME
  while (size < length && size < MAX_FRAME) size *= 2
  return Math.min(size, MAX_FRAME)
}

function checkLength(length: number): void {
  if (length > MAX_MESSAGE) throw new RangeError('Channel message is longer than 32 MiB')
}

function encode(message: ChannelMessage): { kind: number; body: Uint8Array } {
  if (message.kind === 'json') {
    const json = JSON.stringify(message.value) as string | undefined
    if (json === undefined) throw new TypeError('Channel message is not JSON')
    const body = new TextEncoder().encode(json)
    checkLength(body.length)
    return { kind: JSON_KIND, body }
  }
  const { stream, data } = message
  if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff) {
    throw new RangeError(`Channel stream id ${stream} is not a 32-bit unsigned integer`)
  }
  checkLength(STREAM_ID + data.length)
  const body = new Uint8Array(STREAM_ID + data.length)
  new DataView(body.buffer).setUint32(0, stream)
  body.set(data, STREAM_ID)
  return { kind: BYTES_KIND, body }
}

async function decode(kind: number, body: Uint8Array): Promise<ChannelMessage> {
  if (kind === BYTES_KIND) {
    if (body.length < STREAM_ID) throw new Error('Channel bytes message has no stream id')
    const stream = new DataView(body.buffer, body.byteOffset, body.length).getUint32(0)
    return { kind: 'bytes', stream, data: body.subarray(STREAM_ID) }
  }
  const json = kind === DEFLATED_JSON_KIND ? await inflate(body) : body
  return { kind: 'json', value: JSON.parse(utf8.decode(json)) }
}

async function deflate(body: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([buffer(body)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Stops as soon as the output passes the longest message, however small the input. */
async function inflate(body: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([buffer(body)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader()
  const parts: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return concat(parts, length)
    length += value.length
    if (length > MAX_MESSAGE) {
      await reader.cancel()
      throw new Error('Channel message inflates past 32 MiB')
    }
    parts.push(value)
  }
}

/**
 * One side of a channel. Messages leave and arrive in the order they are sent, though every
 * encryption is asynchronous. A frame that fails to decrypt, has an unknown flag, a length past
 * the frame or padding that is not zero, or a message past 32 MiB ends the channel.
 */
export class Channel {
  private readonly ciphers: TransportCiphers
  private readonly handlers: ChannelHandlers
  private readonly rekeyBytes: number
  private readonly rekeyInterval: number
  private sending: Promise<void> = Promise.resolve()
  private receiving: Promise<void> = Promise.resolve()
  private error: Error | null = null
  private sentOnKey = 0
  private keySince = Date.now()
  private partial: { kind: number; parts: Uint8Array[]; length: number } | null = null

  constructor(ciphers: TransportCiphers, handlers: ChannelHandlers, options: ChannelOptions = {}) {
    this.ciphers = ciphers
    this.handlers = handlers
    this.rekeyBytes = options.rekeyBytes ?? REKEY_BYTES
    this.rekeyInterval = options.rekeyInterval ?? REKEY_INTERVAL
  }

  /**
   * Sends a message after every one sent before it, and resolves once its last frame is written.
   * A message that cannot be sent rejects without ending the channel.
   */
  async send(message: ChannelMessage): Promise<void> {
    if (this.error) throw this.error
    const { kind, body } = encode(message)
    const sent = this.sending.then(() => this.transmit(kind, body))
    this.sending = sent.catch(() => {})
    return sent
  }

  /**
   * Reads one transport message from the other side, after every one before it. Resolves once it
   * is handled and never rejects: a failure ends the channel instead.
   */
  receive(frame: Uint8Array): Promise<void> {
    this.receiving = this.receiving.then(async () => {
      if (this.error) return
      try {
        await this.read(frame)
      } catch (error) {
        this.fail(error)
      }
    })
    return this.receiving
  }

  private async transmit(kind: number, body: Uint8Array): Promise<void> {
    if (kind === JSON_KIND && body.length > COMPRESS_OVER) {
      body = await deflate(body)
      kind = DEFLATED_JSON_KIND
    }
    let offset = 0
    do {
      const payload = body.subarray(offset, offset + MAX_PAYLOAD)
      offset += payload.length
      await this.writeFrame(kind | (offset < body.length ? MORE : 0), payload)
    } while (offset < body.length)
  }

  private async writeFrame(flags: number, payload: Uint8Array): Promise<void> {
    if (this.error) throw this.error
    const frame = new Uint8Array(paddedSize(HEADER + payload.length))
    this.sentOnKey += frame.length
    // The last frame on a key says so, and the other side changes its key once it has read it.
    const rekey =
      this.sentOnKey >= this.rekeyBytes || Date.now() - this.keySince >= this.rekeyInterval
    frame[0] = flags | (rekey ? REKEY : 0)
    frame[1] = payload.length >> 8
    frame[2] = payload.length & 0xff
    frame.set(payload, HEADER)
    try {
      const sealed = await this.ciphers.send.encrypt(frame)
      if (rekey) {
        await this.ciphers.send.rekey()
        this.sentOnKey = 0
        this.keySince = Date.now()
      }
      if (this.error) throw this.error
      this.handlers.write(sealed)
    } catch (error) {
      // The frame's nonce is spent, so the other side could read nothing after it.
      throw this.fail(error)
    }
  }

  private async read(sealed: Uint8Array): Promise<void> {
    const frame = await this.ciphers.receive.decrypt(sealed)
    if (frame.length < HEADER) throw new Error('Channel frame is too short')
    const flags = frame[0]
    const kind = flags & KIND
    if ((flags & ~KNOWN_FLAGS) !== 0 || kind === KIND) {
      throw new Error(`Channel frame has unknown flags ${flags.toString(2)}`)
    }
    const end = HEADER + ((frame[1] << 8) | frame[2])
    if (end > frame.length) throw new Error('Channel frame length is past the frame')
    if (frame.subarray(end).some((byte) => byte !== 0)) {
      throw new Error('Channel frame padding is not zero')
    }
    if (flags & REKEY) await this.ciphers.receive.rekey()

    const partial = this.partial ?? { kind, parts: [], length: 0 }
    if (partial.kind !== kind) throw new Error('Channel message changes kind between frames')
    partial.length += end - HEADER
    if (partial.length > MAX_MESSAGE) throw new Error('Channel message is longer than 32 MiB')
    partial.parts.push(frame.subarray(HEADER, end))
    if (flags & MORE) {
      this.partial = partial
      return
    }
    this.partial = null
    this.handlers.message(await decode(kind, concat(partial.parts, partial.length)))
  }

  private fail(error: unknown): Error {
    if (!this.error) {
      this.error = error instanceof Error ? error : new Error(String(error))
      this.handlers.end(this.error)
    }
    return this.error
  }
}
