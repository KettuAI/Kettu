// The stream transport's buffer as the remote host paces byte streams by it: what the socket has
// not passed on yet, and a drain once the other side reads again.

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

  it('stops waiting for a drain when the connection ends', async () => {
    const host = await connected()
    const message = new Uint8Array(60_000)
    for (let sent = 0; sent < 64; sent++) host.send(message)
    const draining = host.drained()
    reader!.destroy()
    await draining
  })
})
