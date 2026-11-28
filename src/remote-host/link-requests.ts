// Main's requests to another host and the host's answers, with the bytes in them carried as the
// channel's streams, as a paired device carries them: each binary value in a request goes ahead as
// an upload the request then names, and each stream an answer names comes back as bytes before
// main hears the answer. A request goes on the wire under an id of the link's own, taken once its
// uploads are sent, so the ids the host reads rise in the order they arrive and its count of what
// it read stays true; one whose upload a dropped connection cut short goes again, upload and all.

import { inflateRawSync } from 'node:zlib'
import type { LogFn } from '../agent-host/storage'
import { BYTES_PER_FRAME, MAX_MESSAGE } from '@shared/remote/channel'
import { bytesOf, findPlaces, isBinary, type Place } from '@shared/remote/places'
import { MAX_UPLOAD_BYTES } from '@shared/remote/streams'
import { portError } from '@shared/hosts-text'
import type { PortError } from '@shared/port-rpc'

/** Bytes the transport may hold before an upload waits for them to leave. */
const HIGH_WATER = 256 * 1024

/** Deeper than any request nests. */
const MAX_DEPTH = 64

/** The session requests go on. */
export interface RequestWire {
  send(value: unknown): void
  sendBytes(stream: number, data: Uint8Array): Promise<void>
  buffered(): number
  drained(): Promise<void>
  /** Whether the host takes byte streams, as its welcome says. */
  readonly bytes: boolean
}

interface Outgoing {
  /** Main's id, which the answer goes back under. */
  id: number
  message: Record<string, unknown>
  /** The id it went on the wire under; null until it went. */
  wire: number | null
  /** Counts its posts, so an upload for one that was posted again stops. */
  attempt: number
}

interface Upload {
  ref: { $stream: number }
  bytes: Uint8Array
}

/** An answer whose streams are still coming. */
interface Awaited {
  message: Record<string, unknown>
  streams: number[]
  left: number
}

type Download =
  | {
      kind: 'field'
      place: Place
      size: number
      received: number
      chunks: Uint8Array[]
      awaited: Awaited
    }
  | {
      /** 大响应整体通过字节流分块传回（支持可选 raw deflate 压缩）。 */
      kind: 'response'
      encoding?: 'deflate'
      size: number
      received: number
      chunks: Uint8Array[]
      awaited: Awaited
    }

export interface LinkRequestsOptions {
  toMain(message: unknown): void
  /** The id of a stream this side opens, shared with the link's forwards: odd, above the last. */
  nextStream(): number
  log: LogFn
}

export class LinkRequests {
  /** Main's requests not answered yet, by main's id, in the order main sent them. */
  private readonly outgoing = new Map<number, Outgoing>()
  private readonly byWire = new Map<number, Outgoing>()
  private readonly downloads = new Map<number, Download>()
  /** Uploads under way, for the host to give one up. */
  private readonly uploads = new Map<number, Outgoing>()
  private wire: RequestWire | null = null
  private nextWire = 1
  /** The link's own requests, under negative ids main never uses, by id. */
  private readonly own = new Map<number, (answer: Record<string, unknown>) => void>()
  private nextOwn = -1

  constructor(private readonly options: LinkRequestsOptions) {}

  private toMain(message: unknown): void {
    const id = (message as { id?: unknown } | null)?.id
    const own = typeof id === 'number' ? this.own.get(id) : undefined
    if (!own) return this.options.toMain(message)
    this.own.delete(id as number)
    own(message as Record<string, unknown>)
  }

  /** A request of the link's own, as main's go: its `response` or `error` message. */
  call(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextOwn--
    return new Promise((resolve) => {
      this.own.set(id, resolve)
      this.request({ type: 'request', id, method, params })
    })
  }

  /** Requests waiting for an answer. */
  get waiting(): number {
    return this.outgoing.size
  }

  /** A request from main, which goes now if a session is up, or on the next. */
  request(message: Record<string, unknown>): void {
    const id = message.id as number
    const outgoing: Outgoing = { id, message, wire: null, attempt: 0 }
    this.outgoing.set(id, outgoing)
    if (this.wire) this.post(this.wire, outgoing)
  }

  /**
   * A session to send on. A resumed one names the last request the host read, whose answers still
   * come; the rest go again.
   */
  attach(wire: RequestWire, read: number): void {
    this.wire = wire
    for (const outgoing of this.outgoing.values()) {
      if (outgoing.wire !== null && outgoing.wire <= read) continue
      this.post(wire, outgoing)
    }
  }

  /** The session went for now: requests wait for the next, and uploads under way stop. */
  detach(): void {
    this.wire = null
  }

  /** The host's session is gone: nothing more is answered here. */
  lose(): void {
    this.wire = null
    for (const [id, own] of [...this.own]) {
      this.own.delete(id)
      own({ type: 'error', id, error: internal('The host is gone') })
    }
    this.outgoing.clear()
    this.byWire.clear()
    this.downloads.clear()
    this.uploads.clear()
  }

  /** A JSON message from the host: its answers and streams are handled here, the rest go to main. */
  received(value: Record<string, unknown>): void {
    switch (value.type) {
      case 'response':
      case 'error':
        return this.answered(value)
      case 'response.stream':
        return this.streamedResponse(value)
      case 'stream.end':
        return this.ended(value.stream)
      case 'stream.cancel':
        return this.cancelled(value.stream, value.error)
    }
    this.toMain(value)
  }

  /** A part of one of the host's streams. */
  bytes(stream: number, data: Uint8Array): void {
    const download = this.downloads.get(stream)
    if (!download) return
    if (download.received + data.length > download.size) {
      return this.fail(download.awaited, internal('The host sent more bytes than it said'))
    }
    download.chunks.push(data.slice())
    download.received += data.length
  }

  private post(wire: RequestWire, outgoing: Outgoing): void {
    const attempt = ++outgoing.attempt
    if (outgoing.wire !== null) this.byWire.delete(outgoing.wire)
    outgoing.wire = null
    const uploads: Upload[] = []
    const message = withRefs(outgoing.message, uploads, 0) as Record<string, unknown>
    if (uploads.length === 0) return this.put(wire, outgoing, message)
    if (!wire.bytes) {
      return this.reject(outgoing, portError('invalid_params', 'remote.noFiles'))
    }
    if (uploads.some((upload) => upload.bytes.length > MAX_UPLOAD_BYTES)) {
      return this.reject(
        outgoing,
        portError('invalid_params', 'remote.uploadTooLarge', { max: MAX_UPLOAD_BYTES }),
      )
    }
    void this.upload(wire, outgoing, attempt, message, uploads)
  }

  private async upload(
    wire: RequestWire,
    outgoing: Outgoing,
    attempt: number,
    message: Record<string, unknown>,
    uploads: Upload[],
  ): Promise<void> {
    const current = (): boolean =>
      this.wire === wire &&
      outgoing.attempt === attempt &&
      this.outgoing.get(outgoing.id) === outgoing
    const streams: number[] = []
    try {
      for (const { ref, bytes } of uploads) {
        const stream = this.options.nextStream()
        ref.$stream = stream
        streams.push(stream)
        this.uploads.set(stream, outgoing)
        wire.send({ type: 'stream.open', stream, size: bytes.length })
        for (let offset = 0; offset < bytes.length; offset += BYTES_PER_FRAME) {
          await wire.sendBytes(stream, bytes.subarray(offset, offset + BYTES_PER_FRAME))
          if (wire.buffered() > HIGH_WATER) await wire.drained()
          if (!current()) return
        }
        wire.send({ type: 'stream.end', stream })
      }
      if (current()) this.put(wire, outgoing, message)
    } catch (error) {
      if (current()) this.reject(outgoing, internal((error as Error).message))
    } finally {
      for (const stream of streams) this.uploads.delete(stream)
    }
  }

  private put(wire: RequestWire, outgoing: Outgoing, message: Record<string, unknown>): void {
    const id = this.nextWire++
    outgoing.wire = id
    this.byWire.set(id, outgoing)
    wire.send({ ...message, id })
  }

  /** Main hears a request failed here, before or without the host answering it. */
  private reject(outgoing: Outgoing, error: PortError): void {
    this.outgoing.delete(outgoing.id)
    if (outgoing.wire !== null) this.byWire.delete(outgoing.wire)
    outgoing.attempt++
    this.toMain({ type: 'error', id: outgoing.id, error })
  }

  private answered(value: Record<string, unknown>): void {
    const outgoing = typeof value.id === 'number' ? this.byWire.get(value.id) : undefined
    if (!outgoing) return
    this.byWire.delete(outgoing.wire!)
    this.outgoing.delete(outgoing.id)
    const message = { ...value, id: outgoing.id }
    const places = value.type === 'response' ? findPlaces(message, 'result', isStreamRef) : []
    if (places.length === 0) return this.toMain(message)
    // Registered now, before the bytes that follow the answer on the channel.
    const awaited: Awaited = { message, streams: [], left: places.length }
    for (const place of places) {
      const { $stream, size } = place.holder[place.key] as { $stream: number; size: number }
      awaited.streams.push($stream)
      this.downloads.set($stream, { kind: 'field', place, size, received: 0, chunks: [], awaited })
    }
  }

  /** 注册一条大响应流：先于后续 bytes 帧到达，收齐后解压并还原为常规 response 交付主进程。 */
  private streamedResponse(value: Record<string, unknown>): void {
    const outgoing = typeof value.id === 'number' ? this.byWire.get(value.id) : undefined
    if (!outgoing) return
    this.byWire.delete(outgoing.wire!)
    this.outgoing.delete(outgoing.id)
    const { stream, size, encoding } = value
    const validEncoding = encoding === undefined || encoding === 'deflate'
    if (
      typeof stream !== 'number' ||
      !Number.isSafeInteger(stream) ||
      stream <= 0 ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_MESSAGE ||
      !validEncoding
    ) {
      if (typeof stream === 'number' && Number.isSafeInteger(stream) && stream > 0) {
        this.wire?.send({ type: 'stream.cancel', stream })
      }
      return this.toMain({
        type: 'error',
        id: outgoing.id,
        error: internal('The host sent an invalid streamed response header'),
      })
    }
    const message: Record<string, unknown> = { type: 'response', id: outgoing.id }
    const awaited: Awaited = { message, streams: [stream], left: 1 }
    this.downloads.set(stream, {
      kind: 'response',
      ...(encoding === 'deflate' ? { encoding: 'deflate' } : {}),
      size,
      received: 0,
      chunks: [],
      awaited,
    })
  }

  private ended(stream: unknown): void {
    const download = typeof stream === 'number' ? this.downloads.get(stream) : undefined
    if (!download) return
    const { awaited } = download
    if (download.received !== download.size) {
      return this.fail(awaited, portError('internal', 'remote.streamShort'))
    }
    this.downloads.delete(stream as number)
    if (download.kind === 'response') {
      try {
        const joinedBytes = new Uint8Array(joined(download.chunks, download.size))
        const plain =
          download.encoding === 'deflate'
            ? inflateRawSync(joinedBytes, { maxOutputLength: MAX_MESSAGE })
            : joinedBytes
        const json = new TextDecoder('utf-8', { fatal: true }).decode(plain)
        awaited.message.result = JSON.parse(json)
        this.toMain(awaited.message)
      } catch {
        this.fail(awaited, internal('The streamed response could not be decoded'))
      }
      return
    }
    download.place.holder[download.place.key] = joined(download.chunks, download.size)
    if (--awaited.left === 0) this.toMain(awaited.message)
  }

  private cancelled(stream: unknown, error: unknown): void {
    if (typeof stream !== 'number') return
    const reason = isPortError(error) ? error : portError('internal', 'remote.streamGivenUp')
    const upload = this.uploads.get(stream)
    if (upload) {
      this.uploads.delete(stream)
      this.options.log('warn', `A host gave up an upload: ${reason.code}`)
      return this.reject(upload, reason)
    }
    const download = this.downloads.get(stream)
    if (!download) return
    this.downloads.delete(stream)
    this.fail(download.awaited, reason)
  }

  /** An answer whose bytes did not all come fails, and the host stops sending the rest. */
  private fail(awaited: Awaited, error: PortError): void {
    for (const stream of awaited.streams) {
      if (!this.downloads.delete(stream)) continue
      this.wire?.send({ type: 'stream.cancel', stream })
    }
    this.toMain({ type: 'error', id: awaited.message.id, error })
  }
}

function internal(message: string): PortError {
  return { code: 'internal', message }
}

function isPortError(value: unknown): value is PortError {
  const { code, message } = (value ?? {}) as Record<string, unknown>
  return typeof code === 'string' && typeof message === 'string'
}

/** A stream an answer names: `$stream` and its `size`, and nothing else. */
function isStreamRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { $stream, size } = value as Record<string, unknown>
  return (
    Object.keys(value).length === 2 &&
    Number.isSafeInteger($stream) &&
    Number.isSafeInteger(size) &&
    (size as number) >= 0
  )
}

/** A copy of `value` with each binary value replaced by a ref its upload fills in. */
function withRefs(value: unknown, uploads: Upload[], depth: number): unknown {
  if (isBinary(value)) {
    const ref = { $stream: 0 }
    uploads.push({ ref, bytes: bytesOf(value) })
    return ref
  }
  if (typeof value !== 'object' || value === null || depth >= MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => withRefs(item, uploads, depth + 1))
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) copy[key] = withRefs(item, uploads, depth + 1)
  return copy
}

function joined(chunks: Uint8Array[], size: number): ArrayBuffer {
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out.buffer
}
