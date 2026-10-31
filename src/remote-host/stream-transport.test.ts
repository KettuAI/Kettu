// The stream transport's buffer as the remote host paces byte streams by it: what the socket has
// not passed on yet, and a drain once the other side reads again; and its reading, which an upload
// pauses while the disk lags behind.

import { connect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Transport } from '@shared/remote/transport'
import { privateSocketPath, type SocketPath } from '@shared/socket-port'
import { listenTransports } from './stream-transport'

let place: SocketPath | null = null
let server: Server | null = null
let reader: Socket | null = null

afterEach(async () => {
  reader?.destroy()
  reader = null
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  await place?.remove()
  place = null
})

async function connected(): Promise<Transport> {
  place = await privateSocketPath('transport')
  let accepted!: (transport: Transport) => void
  const transport = new Promise<Transport>((resolve) => (accepted = resolve))
  server = await listenTransports(place.path, accepted)
  reader = connect(place.path)
  // The other side reads nothing until the test lets it.
  reader.pause()
  return transport
}

describe('streamTransport', () => {
  it('counts what the other side has not read and drains once it reads', async () => {
    const host = await connected()
    expect(host.buffered()).toBe(0)
    await host.drained()

    // Past what the system's own buffers take, so the socket holds the rest.
    const message = new Uint8Array(60_000)
    for (let sent = 0; sent < 64; sent++) host.send(message)
    expect(host.buffered()).toBeGreaterThan(0)
    let drained = false
    const draining = host.drained().then(() => (drained = true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(drained).toBe(false)

    reader!.resume()
    await draining
    expect(host.buffered()).toBe(0)
  })

  it('stops reading while paused and hands over what waited once it resumes', async () => {
    const host = await connected()
    const received: number[] = []
    host.onMessage((message) => {
      received.push(message[0]!)
      // Paused by a message, the rest of its chunk waits too.
      if (received.length === 1) host.pause()
    })
    const frame = (n: number, size: number): Buffer => {
      const bytes = Buffer.alloc(2 + size)
      bytes.writeUInt16BE(size, 0)
      bytes[2] = n
      return bytes
    }
    reader!.write(Buffer.concat([frame(0, 10), frame(1, 10), frame(2, 10)]))
    await expect.poll(() => received.length).toBe(1)
    // Far more than the system's buffers take: the sender has to keep the rest.
    for (let n = 3; n < 67; n++) reader!.write(frame(n, 60_000))
    await expect.poll(() => reader!.writableLength).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).toEqual([0])

    host.resume()
    await expect.poll(() => received.length).toBe(67)
    expect(received).toEqual(Array.from({ length: 67 }, (_, n) => n))
    await expect.poll(() => reader!.writableLength).toBe(0)
  })

  it('stops waiting for a drain when the connection ends', async () => {
    const host = await connected()
    const message = new Uint8Array(60_000)
    for (let sent = 0; sent < 64; sent++) host.send(message)
    const draining = host.drained()
    reader!.destroy()
    await draining
  })
})
