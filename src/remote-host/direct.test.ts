import { connect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Transport } from '@shared/remote/transport'
import { DirectListener, MAX_UNREAD, MAX_UNREAD_PER_SOURCE } from './direct'
import { HandshakeLimits } from './limits'

interface Harness {
  direct: DirectListener
  port: number
  accepted: Transport[]
  refused: number
  openIdle(remoteAddress?: string): Promise<{ client: Socket; serverSocket: Socket }>
  closeAndWait(client: Socket, serverSocket: Socket): Promise<void>
  cleanup(): Promise<void>
}

async function startListener(options?: { firstBytesTimeoutMs?: number }): Promise<Harness> {
  const accepted: Transport[] = []
  let refused = 0
  const direct = new DirectListener({
    server: {
      accept: (transport) => {
        accepted.push(transport)
      },
      refusedOne: () => {
        refused++
      },
      setAddresses: () => {},
      frameFile: async () => null,
    },
    changed: () => {},
    log: () => {},
    host: '127.0.0.1',
    interfaces: () => ({}),
    limits: new HandshakeLimits(),
    firstBytesTimeoutMs: options?.firstBytesTimeoutMs ?? 30_000,
  })

  await direct.apply({ enabled: true, port: 0, addresses: [] })
  const status = direct.status
  if (status.state !== 'listening') throw new Error(`Expected listening, got ${status.state}`)
  const port = status.port

  const rawListener = (direct as unknown as { listener: Server }).listener
  const pendingRemotes: (string | undefined)[] = []
  const pendingAccepts: ((socket: Socket) => void)[] = []
  const clients = new Set<Socket>()

  // Assign synthetic remoteAddress before DirectListener.take runs, mimicking Node's behavior
  // where remoteAddress becomes undefined once the socket is destroyed.
  rawListener.prependListener('connection', (socket: Socket) => {
    const fakeAddress = pendingRemotes.shift()
    if (fakeAddress !== undefined) {
      Object.defineProperty(socket, 'remoteAddress', {
        configurable: true,
        get: () => (socket.destroyed ? undefined : fakeAddress),
      })
    }
  })
  // Runs synchronously after DirectListener.take has processed the new socket.
  rawListener.on('connection', (socket: Socket) => {
    pendingAccepts.shift()?.(socket)
  })

  const openIdle = async (
    remoteAddress?: string,
  ): Promise<{ client: Socket; serverSocket: Socket }> => {
    pendingRemotes.push(remoteAddress)
    const serverReady = new Promise<Socket>((resolve) => pendingAccepts.push(resolve))
    const client = connect({ host: '127.0.0.1', port })
    clients.add(client)
    client.on('error', () => {})
    client.once('close', () => clients.delete(client))
    const serverSocket = await serverReady
    return { client, serverSocket }
  }

  const closeAndWait = async (client: Socket, serverSocket: Socket): Promise<void> => {
    const serverClosed = serverSocket.destroyed
      ? Promise.resolve()
      : new Promise<void>((resolve) => serverSocket.once('close', () => resolve()))
    client.destroy()
    await serverClosed
  }

  return {
    direct,
    port,
    accepted,
    get refused() {
      return refused
    },
    openIdle,
    closeAndWait,
    cleanup: async () => {
      for (const client of clients) client.destroy()
      for (const transport of accepted) transport.close()
      direct.stop()
      await new Promise((resolve) => setTimeout(resolve, 10))
    },
  }
}

let harness: Harness | null = null

afterEach(async () => {
  await harness?.cleanup()
  harness = null
})

describe('DirectListener unread connection limits', () => {
  it('caps unread connections per source without blocking other sources', async () => {
    harness = await startListener()
    const held: { client: Socket; serverSocket: Socket }[] = []

    for (let i = 0; i < MAX_UNREAD_PER_SOURCE; i++) {
      const pair = await harness.openIdle('192.0.2.10')
      expect(pair.serverSocket.destroyed).toBe(false)
      held.push(pair)
    }

    // Same IPv4 and its IPv4-mapped IPv6 form are both rejected once the per-source cap is full.
    const extraV4 = await harness.openIdle('192.0.2.10')
    expect(extraV4.serverSocket.destroyed).toBe(true)
    const extraMapped = await harness.openIdle('::ffff:192.0.2.10')
    expect(extraMapped.serverSocket.destroyed).toBe(true)
    expect(harness.refused).toBe(2)

    // Another source is unaffected and can connect and start a channel handshake.
    const peer = await harness.openIdle('192.0.2.20')
    expect(peer.serverSocket.destroyed).toBe(false)
    peer.client.write(Buffer.from([0x00, 0x04, 0x01, 0x02, 0x03, 0x04]))
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (harness!.accepted.length > 0) resolve()
        else setTimeout(check, 5)
      }
      check()
    })
    expect(harness.accepted.length).toBe(1)

    // Closing one unread connection frees the slot cleanly (even though remoteAddress drops on close).
    await harness.closeAndWait(held[0]!.client, held[0]!.serverSocket)
    const replacement = await harness.openIdle('192.0.2.10')
    expect(replacement.serverSocket.destroyed).toBe(false)
    expect(harness.refused).toBe(2)
  })

  it('releases a source slot once first bytes arrive and does not double-decrement on close', async () => {
    harness = await startListener()
    const held: { client: Socket; serverSocket: Socket }[] = []

    for (let i = 0; i < MAX_UNREAD_PER_SOURCE; i++) {
      held.push(await harness.openIdle('2001:db8:1:2::1'))
    }

    // Another address in the same /64 shares the cap.
    const blocked = await harness.openIdle('2001:db8:1:2::99')
    expect(blocked.serverSocket.destroyed).toBe(true)
    expect(harness.refused).toBe(1)

    // Sending first bytes hands the socket to the channel path and releases its unread slot.
    held[0]!.client.write(Buffer.from([0x00, 0x02, 0xaa, 0xbb]))
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (harness!.accepted.length === 1) resolve()
        else setTimeout(check, 5)
      }
      check()
    })

    // Closing that upgraded socket must not underflow the per-source unread counter.
    await harness.closeAndWait(held[0]!.client, held[0]!.serverSocket)

    const replacement = await harness.openIdle('2001:db8:1:2::2')
    expect(replacement.serverSocket.destroyed).toBe(false)
    const stillCapped = await harness.openIdle('2001:db8:1:2::3')
    expect(stillCapped.serverSocket.destroyed).toBe(true)
    expect(harness.refused).toBe(2)
  })

  it('still enforces the global unread cap across distinct sources', async () => {
    harness = await startListener()
    const sources = Math.ceil(MAX_UNREAD / MAX_UNREAD_PER_SOURCE)
    const held: { client: Socket; serverSocket: Socket }[] = []

    for (let s = 0; s < sources && held.length < MAX_UNREAD; s++) {
      for (let i = 0; i < MAX_UNREAD_PER_SOURCE && held.length < MAX_UNREAD; i++) {
        const pair = await harness.openIdle(`10.0.${s}.1`)
        expect(pair.serverSocket.destroyed).toBe(false)
        held.push(pair)
      }
    }

    const overflow = await harness.openIdle('10.99.0.1')
    expect(overflow.serverSocket.destroyed).toBe(true)
    expect(harness.refused).toBe(1)

    await harness.closeAndWait(held[0]!.client, held[0]!.serverSocket)
    const admitted = await harness.openIdle('10.99.0.1')
    expect(admitted.serverSocket.destroyed).toBe(false)
  })
})
