import { connect, type Server, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { PortChannel } from './port-channel'
import {
  connectPort,
  encodeMessage,
  listenPorts,
  MAX_MESSAGE_BYTES,
  privateSocketPath,
  socketPort,
  type SocketPath,
} from './socket-port'

let place: SocketPath | null = null
let server: Server | null = null

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  await place?.remove()
  place = null
})

/** A host listening on a fresh socket, and the ports it was handed. */
async function listen(): Promise<{ path: string; ports: PortChannel[] }> {
  place = await privateSocketPath('test')
  const ports: PortChannel[] = []
  server = await listenPorts(place.path, (port) => ports.push(port))
  return { path: place.path, ports }
}

function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('Timed out'))
      }
    }, 5)
  })
}

/** A port on a stream the test writes the bytes of, each write arriving as one read. */
function streamPort(): { stream: PassThrough; port: PortChannel; received: unknown[] } {
  const stream = new PassThrough()
  const port = socketPort(stream as unknown as Socket)
  const received: unknown[] = []
  port.onMessage((data) => received.push(data))
  return { stream, port, received }
}

describe('socketPort', () => {
  it('carries messages both ways, holding those that arrive before a listener', async () => {
    const { path, ports } = await listen()
    const client = await connectPort(path)
    const large = 'x'.repeat(2 * 1024 * 1024)
    client.send({ type: 'request', id: 1, text: 'héllo' })
    client.send({ type: 'request', id: 2, text: large })
    await until(() => ports.length === 1)
    const host = ports[0]!
    // Long enough for both messages to arrive with no one listening.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const received: unknown[] = []
    host.onMessage((data) => received.push(data))
    await until(() => received.length === 2)
    expect(received).toEqual([
      { type: 'request', id: 1, text: 'héllo' },
      { type: 'request', id: 2, text: large },
    ])

    const replies: unknown[] = []
    client.onMessage((data) => replies.push(data))
    host.send({ type: 'event', event: { n: [1, null, true] } })
    await until(() => replies.length === 1)
    expect(replies).toEqual([{ type: 'event', event: { n: [1, null, true] } }])

    let hostClosed = false
    let clientClosed = false
    host.onClose(() => (hostClosed = true))
    client.onClose(() => (clientClosed = true))
    client.close()
    await until(() => hostClosed && clientClosed)
    // A listener added after the close still hears of it.
    let late = false
    host.onClose(() => (late = true))
    await until(() => late)
  })

  it('reads a message split across reads, and several in one read', async () => {
    const { stream, received } = streamPort()
    const bytes = encodeMessage({ text: 'split 文字' })
    for (const byte of bytes) stream.write(Buffer.from([byte]))
    await until(() => received.length === 1)
    expect(received).toEqual([{ text: 'split 文字' }])

    stream.write(Buffer.concat([encodeMessage(1), encodeMessage('two'), encodeMessage([3])]))
    await until(() => received.length === 4)
    expect(received.slice(1)).toEqual([1, 'two', [3]])

    // A header split between two reads, each also holding part of a body.
    const pair = Buffer.concat([encodeMessage({ a: 'first' }), encodeMessage({ b: 'second' })])
    const cut = encodeMessage({ a: 'first' }).length + 2
    stream.write(pair.subarray(0, cut))
    stream.write(pair.subarray(cut))
    await until(() => received.length === 6)
    expect(received.slice(4)).toEqual([{ a: 'first' }, { b: 'second' }])
  })

  it('closes the port on a length past the limit', async () => {
    const { path, ports } = await listen()
    const raw = connect(path)
    let rawClosed = false
    raw.on('error', () => {})
    raw.on('close', () => (rawClosed = true))
    await until(() => ports.length === 1)
    const host = ports[0]!
    const received: unknown[] = []
    let closed = false
    host.onMessage((data) => received.push(data))
    host.onClose(() => (closed = true))
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_MESSAGE_BYTES + 1, 0)
    raw.write(header)
    await until(() => closed && rawClosed)
    expect(received).toEqual([])
  })

  it('carries ArrayBuffers where a message holds them, as a MessagePort does', async () => {
    const { stream, received } = streamPort()
    const bytes = (...values: number[]) => new Uint8Array(values).buffer
    const message = {
      type: 'request',
      id: 1,
      params: { source: { bytes: bytes(1, 2, 3), name: 'a.png' }, list: [bytes(), null, 'x'] },
    }
    const top = bytes(9)
    stream.write(Buffer.concat([encodeMessage(message), encodeMessage(top), encodeMessage(null)]))
    await until(() => received.length === 3)
    expect(received[0]).toEqual(message)
    const params = (received[0] as typeof message).params
    expect(params.source.bytes).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(params.source.bytes)).toEqual(new Uint8Array([1, 2, 3]))
    expect(params.list[0]).toBeInstanceOf(ArrayBuffer)
    expect(received[1]).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(received[1] as ArrayBuffer)).toEqual(new Uint8Array([9]))
    expect(received[2]).toBeNull()
    // A message without buffers is plain JSON, as before.
    expect(encodeMessage({ a: 1 }).subarray(4).toString('utf8')).toBe('{"a":1}')
  })

  it('closes the port on buffers that do not fit their message', async () => {
    const one = [new Uint8Array([1])]
    const bad: [string, Uint8Array[]][] = [
      // A path to a place that holds something else, and the message for a second buffer.
      ['[{"a":1},[["a"]]]', one],
      ['[null,[[],[]]]', [new Uint8Array([1]), new Uint8Array([2])]],
      // A path to nowhere, and one to the prototype.
      ['[{"a":null},[["b"]]]', one],
      ['[{"__proto__":null},[["__proto__"]]]', one],
      // A buffer missing, and bytes past the last one.
      ['[{"a":null},[["a"]]]', []],
      ['[{"a":null},[["a"]]]', [new Uint8Array([1]), new Uint8Array([2])]],
    ]
    for (const [json, buffers] of bad) {
      const { stream, port, received } = streamPort()
      let closed = false
      port.onClose(() => (closed = true))
      const text = Buffer.from(json, 'utf8')
      const parts = [Buffer.alloc(4), text]
      parts[0]!.writeUInt32BE(text.length, 0)
      for (const buffer of buffers) {
        const length = Buffer.alloc(4)
        length.writeUInt32BE(buffer.length, 0)
        parts.push(length, Buffer.from(buffer))
      }
      const body = Buffer.concat(parts)
      const header = Buffer.alloc(4)
      header.writeUInt32BE((0x80000000 | body.length) >>> 0, 0)
      stream.write(Buffer.concat([header, body, encodeMessage({ after: true })]))
      await until(() => closed)
      expect(received).toEqual([])
    }
  })

  it('closes the port on a message that is not JSON', async () => {
    const { stream, port, received } = streamPort()
    let closed = false
    port.onClose(() => (closed = true))
    const body = Buffer.from('{not json', 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length, 0)
    stream.write(Buffer.concat([header, body, encodeMessage({ after: true })]))
    await until(() => closed)
    expect(received).toEqual([])
  })
})
