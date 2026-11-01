// The web client's transport over Node.js's own WebSocket, the standard one browsers have too,
// against a ws server: opening, each binary message whole, pausing, and what ends it.

import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import type { Transport } from './transport'
import { webSocketTransport } from './websocket-transport'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A ws server's side of a new connection, and the client's transport to it. */
async function connected(): Promise<{ server: ServerSocket; transport: Transport }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())))
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const server = new Promise<ServerSocket>((resolve) => wss.once('connection', resolve))
  const { port } = wss.address() as AddressInfo
  const transport = await webSocketTransport(new WebSocket(`ws://127.0.0.1:${port}`))
  cleanups.push(() => transport.close())
  return { server: await server, transport }
}

function closed(transport: Transport): Promise<void> {
  return new Promise((resolve) => transport.onClose(resolve))
}

describe('webSocketTransport', () => {
  it('rejects when the socket fails before it opens', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    const { port } = wss.address() as AddressInfo
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await expect(webSocketTransport(new WebSocket(`ws://127.0.0.1:${port}`))).rejects.toThrow(
      'The WebSocket closed before it opened',
    )
  })

  it('carries each binary message whole, either way, keeping those before a listener', async () => {
    const { server, transport } = await connected()
    const fromClient: Buffer[] = []
    server.on('message', (data, isBinary) => {
      expect(isBinary).toBe(true)
      fromClient.push(data as Buffer)
    })
    server.send(new Uint8Array([1, 2, 3]))
    server.send(new Uint8Array([4]))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const received: number[][] = []
    transport.onMessage((message) => received.push([...message]))
    expect(received).toEqual([[1, 2, 3], [4]])

    transport.send(new Uint8Array(60_000).fill(7))
    await transport.drained()
    expect(transport.buffered()).toBe(0)
    await expect.poll(() => fromClient.length).toBe(1)
    expect(fromClient[0]).toHaveLength(60_000)
    expect(() => transport.send(new Uint8Array(65536))).toThrow(RangeError)
  })

  it('holds messages while paused and hands them over in order once it resumes', async () => {
    const { server, transport } = await connected()
    const received: number[] = []
    transport.onMessage((message) => {
      received.push(message[0]!)
      if (message[0] === 2) transport.pause()
    })
    for (const n of [1, 2, 3, 4]) server.send(new Uint8Array([n]))
    await expect.poll(() => received).toEqual([1, 2])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).toEqual([1, 2])
    transport.resume()
    expect(received).toEqual([1, 2, 3, 4])
  })

  it('ends on a text message, which no channel sends', async () => {
    const { server, transport } = await connected()
    const ending = closed(transport)
    const code = new Promise<number>((resolve) => server.once('close', resolve))
    server.send('hello')
    await ending
    expect(await code).toBe(1000)
  })

  it('tells of an end from either side, also to a listener that comes after it', async () => {
    const first = await connected()
    const ending = closed(first.transport)
    first.server.close(1001)
    await ending
    await closed(first.transport)

    const second = await connected()
    const code = new Promise<number>((resolve) => second.server.once('close', resolve))
    second.transport.close()
    expect(await code).toBe(1000)
    await closed(second.transport)
  })
})
