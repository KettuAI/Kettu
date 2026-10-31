import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel, MAX_MESSAGE, type ChannelMessage, type ChannelOptions } from './channel'
import { Handshake, generateKeyPair, type CipherState, type TransportCiphers } from './noise'

const MINUTE = 60_000
const TAGLEN = 16
const MAX_FRAME = 65519
const MAX_PAYLOAD = MAX_FRAME - 3
const SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, MAX_FRAME]

const KIND = 0b11
const REKEY = 0x40
const MORE = 0x80

async function connect(): Promise<[TransportCiphers, TransportCiphers]> {
  const host = await generateKeyPair()
  const initiator = await Handshake.create({
    role: 'initiator',
    pattern: 'IK',
    staticKey: await generateKeyPair(),
    remoteStaticKey: host.publicKey,
  })
  const responder = await Handshake.create({
    role: 'responder',
    pattern: 'IK',
    staticKey: host,
    accept: () => true,
  })
  await responder.readMessage(await initiator.writeMessage())
  await initiator.readMessage(await responder.writeMessage())
  return [await initiator.split(), await responder.split()]
}

interface Side {
  channel: Channel
  ciphers: TransportCiphers
  /** The transport messages it wrote. */
  frames: Uint8Array[]
  /** Every frame's plaintext before it was encrypted. */
  plaintexts: Uint8Array[]
  messages: ChannelMessage[]
  errors: Error[]
}

function side(ciphers: TransportCiphers, options?: ChannelOptions): Side {
  const frames: Uint8Array[] = []
  const messages: ChannelMessage[] = []
  const errors: Error[] = []
  const encrypt = vi.spyOn(ciphers.send, 'encrypt')
  const channel = new Channel(
    ciphers,
    {
      write: (frame) => frames.push(frame),
      message: (message) => messages.push(message),
      end: (error) => errors.push(error),
    },
    options,
  )
  return {
    channel,
    ciphers,
    frames,
    get plaintexts() {
      return encrypt.mock.calls.map(([plaintext]) => plaintext)
    },
    messages,
    errors,
  }
}

async function pair(options?: ChannelOptions): Promise<{ device: Side; host: Side }> {
  const [device, host] = await connect()
  return { device: side(device, options), host: side(host) }
}

async function deliver(from: Side, to: Side): Promise<void> {
  await Promise.all(from.frames.splice(0).map((frame) => to.channel.receive(frame)))
}

/** A frame as a peer might build it, right or wrong. */
function seal(
  cipher: CipherState,
  flags: number,
  payload: Uint8Array,
  options: { size?: number; length?: number } = {},
): Promise<Uint8Array> {
  const frame = new Uint8Array(options.size ?? SIZES.find((size) => size >= payload.length + 3)!)
  const length = options.length ?? payload.length
  frame[0] = flags
  frame[1] = length >> 8
  frame[2] = length & 0xff
  frame.set(payload, 3)
  return cipher.encrypt(frame)
}

function bytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let index = 0; index < length; index++) out[index] = (index * 31 + 7) & 0xff
  return out
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

async function deflate(body: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([body as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Channel', () => {
  it('sends a short message in one padded frame', async () => {
    const { device, host } = await pair()
    await device.channel.send({ kind: 'json', value: { type: 'hello', version: 1 } })
    expect(device.frames.map((frame) => frame.length)).toEqual([256 + TAGLEN])
    expect(device.plaintexts[0][0]).toBe(0)
    await deliver(device, host)
    expect(host.messages).toEqual([{ kind: 'json', value: { type: 'hello', version: 1 } }])
    expect(host.errors).toEqual([])
  })

  it('pads each frame to the smallest size that holds it', async () => {
    const { device, host } = await pair()
    for (const size of SIZES) {
      await device.channel.send({ kind: 'bytes', stream: 1, data: bytes(size - 3 - 4) })
      if (size < MAX_FRAME) {
        await device.channel.send({ kind: 'bytes', stream: 1, data: bytes(size - 3 - 3) })
      }
    }
    const expected = SIZES.flatMap((size, index) =>
      size < MAX_FRAME ? [size, SIZES[index + 1]] : [size],
    )
    expect(device.plaintexts.map((frame) => frame.length)).toEqual(expected)
    expect(device.frames.map((frame) => frame.length)).toEqual(
      expected.map((size) => size + TAGLEN),
    )
    const smallest = device.plaintexts[1]
    expect(smallest.subarray(3 + 254)).toEqual(new Uint8Array(512 - 257))
    await deliver(device, host)
    expect(host.errors).toEqual([])
    expect(host.messages).toHaveLength(expected.length)
  })

  it('fills one frame at the limit and splits a message one byte longer', async () => {
    const { device, host } = await pair()
    await device.channel.send({ kind: 'bytes', stream: 2, data: bytes(MAX_PAYLOAD - 4) })
    await device.channel.send({ kind: 'bytes', stream: 2, data: bytes(MAX_PAYLOAD - 3) })
    expect(device.frames.map((frame) => frame.length)).toEqual([65535, 65535, 256 + TAGLEN])
    expect(device.plaintexts.map((frame) => frame[0])).toEqual([2, 2 | MORE, 2])
    await deliver(device, host)
    expect(host.messages).toEqual([
      { kind: 'bytes', stream: 2, data: bytes(MAX_PAYLOAD - 4) },
      { kind: 'bytes', stream: 2, data: bytes(MAX_PAYLOAD - 3) },
    ])
  })

  it('joins a message across frames', async () => {
    const { device, host } = await pair()
    await device.channel.send({ kind: 'bytes', stream: 3, data: bytes(200_000) })
    expect(device.plaintexts.map((frame) => frame[0])).toEqual([2 | MORE, 2 | MORE, 2 | MORE, 2])
    await deliver(device, host)
    expect(host.messages).toEqual([{ kind: 'bytes', stream: 3, data: bytes(200_000) }])
  })

  it('carries a message of 32 MiB and refuses one byte more', async () => {
    const { device, host } = await pair()
    const data = bytes(MAX_MESSAGE - 4)
    await expect(
      device.channel.send({ kind: 'bytes', stream: 4, data: new Uint8Array(MAX_MESSAGE - 3) }),
    ).rejects.toThrow('longer than 32 MiB')
    await expect(
      device.channel.send({ kind: 'json', value: 'x'.repeat(MAX_MESSAGE) }),
    ).rejects.toThrow('longer than 32 MiB')
    await device.channel.send({ kind: 'bytes', stream: 4, data })
    await deliver(device, host)
    expect(host.errors).toEqual([])
    const [message] = host.messages
    expect(message.kind === 'bytes' && message.stream === 4 && same(message.data, data)).toBe(true)
  })

  it('ends when frames join past 32 MiB', async () => {
    const { device, host } = await pair()
    const payload = bytes(MAX_PAYLOAD)
    const frames = Math.ceil(MAX_MESSAGE / MAX_PAYLOAD) + 1
    for (let index = 0; index < frames; index++) {
      await host.channel.receive(await seal(device.ciphers.send, 2 | MORE, payload))
    }
    expect(host.errors.map((error) => error.message)).toEqual([
      'Channel message is longer than 32 MiB',
    ])
    expect(host.messages).toEqual([])
  })

  it('compresses JSON over 1 KiB', async () => {
    const { device, host } = await pair()
    const under = 'x'.repeat(1022)
    const over = 'x'.repeat(1023)
    expect(JSON.stringify(under)).toHaveLength(1024)
    await device.channel.send({ kind: 'json', value: under })
    await device.channel.send({ kind: 'json', value: over })
    expect(device.plaintexts.map((frame) => frame[0] & KIND)).toEqual([0, 1])
    expect(device.plaintexts[1].length).toBe(256)
    await deliver(device, host)
    expect(host.messages).toEqual([
      { kind: 'json', value: under },
      { kind: 'json', value: over },
    ])
  })

  it('carries a bytes message with its stream id', async () => {
    const { device, host } = await pair()
    await device.channel.send({ kind: 'bytes', stream: 0xfffffffe, data: bytes(5) })
    await device.channel.send({ kind: 'bytes', stream: 0, data: new Uint8Array(0) })
    expect(device.plaintexts[0].subarray(0, 7)).toEqual(Uint8Array.of(2, 0, 9, 255, 255, 255, 254))
    await deliver(device, host)
    expect(host.messages).toEqual([
      { kind: 'bytes', stream: 0xfffffffe, data: bytes(5) },
      { kind: 'bytes', stream: 0, data: new Uint8Array(0) },
    ])
  })

  it.each([-1, 2 ** 32, 1.5, Number.NaN])('refuses the stream id %s', async (stream) => {
    const { device } = await pair()
    await expect(device.channel.send({ kind: 'bytes', stream, data: bytes(1) })).rejects.toThrow(
      '32-bit unsigned',
    )
    await device.channel.send({ kind: 'json', value: 'still open' })
    expect(device.errors).toEqual([])
  })

  it('ends on a deflated message that inflates past 32 MiB', async () => {
    const { device, host } = await pair()
    const json = new TextEncoder().encode(JSON.stringify('a'.repeat(MAX_MESSAGE)))
    const deflated = await deflate(json)
    expect(deflated.length).toBeLessThan(MAX_PAYLOAD)
    await host.channel.receive(await seal(device.ciphers.send, 1, deflated))
    expect(host.errors.map((error) => error.message)).toEqual([
      'Channel message inflates past 32 MiB',
    ])
    expect(host.messages).toEqual([])
  })

  it.each([0b11, 0b100, 0b1000_0000 | 0b10_0000])('ends on the unknown flags %s', async (flags) => {
    const { device, host } = await pair()
    await host.channel.receive(await seal(device.ciphers.send, flags, bytes(8)))
    expect(host.errors.map((error) => error.message)).toEqual([
      `Channel frame has unknown flags ${flags.toString(2)}`,
    ])
  })

  it('ends on a length past the frame', async () => {
    const { device, host } = await pair()
    await host.channel.receive(await seal(device.ciphers.send, 2, bytes(8), { length: 254 }))
    expect(host.errors.map((error) => error.message)).toEqual([
      'Channel frame length is past the frame',
    ])
  })

  it('ends on padding that is not zero', async () => {
    const { device, host } = await pair()
    const frame = new Uint8Array(256)
    frame.set([2, 0, 5, 0, 0, 0, 1, 9])
    frame[255] = 1
    await host.channel.receive(await device.ciphers.send.encrypt(frame))
    expect(host.errors.map((error) => error.message)).toEqual(['Channel frame padding is not zero'])
  })

  it('ends on a message that changes kind between frames', async () => {
    const { device, host } = await pair()
    await host.channel.receive(await seal(device.ciphers.send, 2 | MORE, bytes(8)))
    await host.channel.receive(await seal(device.ciphers.send, 0, bytes(8)))
    expect(host.errors.map((error) => error.message)).toEqual([
      'Channel message changes kind between frames',
    ])
  })

  it('ends on a frame that fails to decrypt, and stays ended', async () => {
    const { device, host } = await pair()
    await device.channel.send({ kind: 'json', value: 1 })
    await device.channel.send({ kind: 'json', value: 2 })
    const [first, second] = device.frames
    first[20] ^= 1
    await host.channel.receive(first)
    await host.channel.receive(second)
    expect(host.errors.map((error) => error.message)).toEqual(['Noise message failed to decrypt'])
    expect(host.messages).toEqual([])
    await expect(host.channel.send({ kind: 'json', value: 3 })).rejects.toBe(host.errors[0])
  })

  it('keeps the order of sends started at once', async () => {
    const { device, host } = await pair()
    const sent: ChannelMessage[] = [
      { kind: 'json', value: { long: 'y'.repeat(300_000) } },
      { kind: 'json', value: 'short' },
      { kind: 'bytes', stream: 1, data: bytes(150_000) },
      { kind: 'bytes', stream: 2, data: bytes(3) },
      { kind: 'json', value: { long: 'z'.repeat(5_000) } },
      { kind: 'json', value: [1, 2, 3] },
    ]
    await Promise.all(sent.map((message) => device.channel.send(message)))
    await deliver(device, host)
    expect(host.messages).toEqual(sent)
  })

  it('rekeys after the byte limit', async () => {
    const { device, host } = await pair({ rekeyBytes: 1000 })
    const sent = Array.from({ length: 10 }, (_, index): ChannelMessage => ({
      kind: 'json',
      value: index,
    }))
    for (const message of sent) await device.channel.send(message)
    expect(device.plaintexts.map((frame) => (frame[0] & REKEY) !== 0)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      true,
      false,
      false,
    ])
    await deliver(device, host)
    expect(host.errors).toEqual([])
    expect(host.messages).toEqual(sent)
  })

  it('rekeys after an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { device, host } = await pair()
    const rekey = vi.spyOn(device.ciphers.send, 'rekey')
    await device.channel.send({ kind: 'json', value: 1 })
    vi.advanceTimersByTime(59 * MINUTE)
    await device.channel.send({ kind: 'json', value: 2 })
    vi.advanceTimersByTime(MINUTE)
    await device.channel.send({ kind: 'json', value: 3 })
    await device.channel.send({ kind: 'json', value: 4 })
    expect(device.plaintexts.map((frame) => (frame[0] & REKEY) !== 0)).toEqual([
      false,
      false,
      true,
      false,
    ])
    expect(rekey).toHaveBeenCalledTimes(1)
    await deliver(device, host)
    expect(host.errors).toEqual([])
    expect(host.messages.map((message) => message.kind === 'json' && message.value)).toEqual([
      1, 2, 3, 4,
    ])
  })
})
