// Reaching a host at every address it may be at and through the relay, all at once: the first
// handshake to finish wins and the other connections are closed.

import { HandshakeDropped, type DeviceChannel } from '@shared/remote/device-channel'
import type { RelayProblem } from '@shared/remote/hosts'
import type { DirectAddress } from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'

/** Opens a connection to an address; rejects when it cannot, or once `signal` aborts. */
export type Connect = (address: DirectAddress, signal: AbortSignal) => Promise<Transport>

/** How a session reached its host: at a direct address, or through the relay at an origin. */
export type Via = { address: DirectAddress } | { relay: string }

/** The relay did not join the host, and why. */
export class RelayMissed extends Error {
  constructor(readonly problem: RelayProblem) {
    super(`The relay did not reach the host: ${problem}`)
    this.name = 'RelayMissed'
  }
}

/** Joins the host through the relay; rejects with RelayMissed, or once `signal` aborts. */
export type RelayRoute = (signal: AbortSignal) => Promise<{ transport: Transport; relay: string }>

export type DialResult =
  | { kind: 'open'; channel: DeviceChannel; via: Via }
  /**
   * Every route failed, at least one by ending the handshake, as the host does for a key or a
   * code it refuses.
   */
  | { kind: 'dropped' }
  /** No handshake finished in time, or none was ended; `relay` says what the relay answered. */
  | { kind: 'unreachable'; relay?: RelayProblem }
  | { kind: 'aborted' }

export interface DialOptions {
  addresses: DirectAddress[]
  connect: Connect
  /** The relay, tried alongside the addresses; absent for a host without one. */
  relay?: RelayRoute | null
  /** Starts the handshake on a connection, as `startDeviceChannel` does. */
  start(transport: Transport): Promise<{ opened: Promise<DeviceChannel> }>
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Tries every route at once. An ended handshake is the answer only once every other route has
 * failed too: a proxy that takes every connection and closes it ends one of an unreachable
 * host's, while the host may still answer at another.
 */
export function dial(options: DialOptions): Promise<DialResult> {
  const { addresses, connect, relay, start, timeoutMs, signal } = options
  return new Promise((resolve) => {
    const connecting = new AbortController()
    const waiting = new Set<Transport>()
    let unsettled = addresses.length + (relay ? 1 : 0)
    let dropped = false
    let problem: RelayProblem | undefined
    let done = false

    const finish = (result: DialResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      connecting.abort(new Error('Dialing is over'))
      for (const transport of waiting) transport.close()
      waiting.clear()
      resolve(result)
    }
    const missed = (): DialResult =>
      problem ? { kind: 'unreachable', relay: problem } : { kind: 'unreachable' }
    const abort = (): void => finish({ kind: 'aborted' })
    const settled = (): void => {
      unsettled--
      if (!done && unsettled === 0) finish(dropped ? { kind: 'dropped' } : missed())
    }
    const timer = setTimeout(() => finish(missed()), timeoutMs)

    const attempt = async (open: () => Promise<{ transport: Transport; via: Via }>) => {
      let transport: Transport
      let via: Via
      try {
        ;({ transport, via } = await open())
      } catch (error) {
        if (error instanceof RelayMissed) problem = error.problem
        return settled()
      }
      if (done) return transport.close()
      waiting.add(transport)
      try {
        const { opened } = await start(transport)
        const channel = await opened
        waiting.delete(transport)
        if (done) return channel.close()
        finish({ kind: 'open', channel, via })
      } catch (error) {
        waiting.delete(transport)
        transport.close()
        // Anything else, as an answer that does not decrypt, is a route that is not the host.
        if (error instanceof HandshakeDropped) dropped = true
        settled()
      }
    }

    if (signal?.aborted) return finish({ kind: 'aborted' })
    signal?.addEventListener('abort', abort, { once: true })
    if (unsettled === 0) return finish({ kind: 'unreachable' })
    for (const address of addresses) {
      void attempt(async () => ({
        transport: await connect(address, connecting.signal),
        via: { address },
      }))
    }
    if (relay) {
      void attempt(async () => {
        const joined = await relay(connecting.signal)
        return { transport: joined.transport, via: { relay: joined.relay } }
      })
    }
  })
}
