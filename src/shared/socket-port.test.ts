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
