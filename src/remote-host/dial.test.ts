// Racing routes to a host: the hello, which may carry a resume token the host spends, goes on the
// winning connection alone.

import { describe, expect, it } from 'vitest'
import type { DeviceChannel } from '@shared/remote/device-channel'
import type { Transport } from '@shared/remote/transport'
import { dial } from './dial'

interface Route {
  transport: Transport
  sent: unknown[]
  closed: boolean
  answer(): void
}

function route(): Route {
  let answer!: () => void
  const answered = new Promise<void>((resolve) => (answer = resolve))
  const kept: Route = {
    sent: [],
    closed: false,
    answer: () => answer(),
    transport: {
      send: () => {},
      onMessage: () => {},
      onClose: () => {},
      close: () => (kept.closed = true),
      buffered: () => 0,
      drained: () => Promise.resolve(),
      pause: () => {},
      resume: () => {},
    },
  }
  ;(kept.transport as Transport & { answered: Promise<void> }).answered = answered
  return kept
}

function channelOf(kept: Route): DeviceChannel {
  return {
    handshakeHash: new Uint8Array(32),
    handshakeMs: 1,
    onMessage: () => {},
    onBytes: () => {},
    closed: new Promise(() => {}),
    send: async (value) => void kept.sent.push(value),
    sendBytes: async () => {},
    buffered: () => 0,
    drained: () => Promise.resolve(),
    close: () => (kept.closed = true),
  }
}

describe('dial', () => {
  it('says hello on the winner alone when two handshakes finish together', async () => {
    const routes = { a: route(), b: route() }
    const hello = { type: 'hello', resume: { token: 'once', received: 3 } }
    const dialing = dial({
      addresses: [
        { host: 'a', port: 1 },
        { host: 'b', port: 1 },
      ],
      connect: async (address) => routes[address.host as 'a' | 'b'].transport,
      start: async (transport) => {
        const kept = Object.values(routes).find((candidate) => candidate.transport === transport)!
        const { answered } = transport as Transport & { answered: Promise<void> }
        return { opened: answered.then(() => channelOf(kept)) }
      },
      hello,
      timeoutMs: 1_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    routes.a.answer()
    routes.b.answer()
    const result = await dialing
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result).toMatchObject({ kind: 'open', via: { address: { host: 'a', port: 1 } } })
    expect(routes.a.sent).toEqual([hello])
    expect(routes.a.closed).toBe(false)
    expect(routes.b.sent).toEqual([])
    expect(routes.b.closed).toBe(true)
  })
})
