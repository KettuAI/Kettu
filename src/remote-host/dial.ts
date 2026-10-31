// Reaching a host at every address it may be at, all at once: the first handshake to finish wins
// and the other connections are closed.

import { HandshakeDropped, type DeviceChannel } from '@shared/remote/device-channel'
import type { DirectAddress } from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'

/** Opens a connection to an address; rejects when it cannot, or once `signal` aborts. */
export type Connect = (address: DirectAddress, signal: AbortSignal) => Promise<Transport>

export type DialResult =
  | { kind: 'open'; channel: DeviceChannel; address: DirectAddress }
  /** The host ended a handshake, as it does for a key or a code it refuses, and none finished. */
  | { kind: 'dropped' }
  /** No handshake finished in time. */
  | { kind: 'unreachable' }
  | { kind: 'aborted' }

export interface DialOptions {
  addresses: DirectAddress[]
  connect: Connect
  /** Starts the handshake on a connection, as `startDeviceChannel` does. */
  start(transport: Transport): Promise<{ opened: Promise<DeviceChannel> }>
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Tries every address at once. A host that ends a handshake while no other is waiting for its
 * answer settles it at once: its other addresses lead to the same host, which ends theirs too.
 */
export function dial(options: DialOptions): Promise<DialResult> {
  const { addresses, connect, start, timeoutMs, signal } = options
  return new Promise((resolve) => {
    const connecting = new AbortController()
    const waiting = new Set<Transport>()
    let unsettled = addresses.length
    let dropped = false
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
    const abort = (): void => finish({ kind: 'aborted' })
    const settled = (): void => {
      unsettled--
      if (done) return
      if (dropped && waiting.size === 0) finish({ kind: 'dropped' })
      else if (unsettled === 0) finish({ kind: 'unreachable' })
    }
    const timer = setTimeout(() => finish({ kind: dropped ? 'dropped' : 'unreachable' }), timeoutMs)

    const attempt = async (address: DirectAddress): Promise<void> => {
      let transport: Transport
      try {
        transport = await connect(address, connecting.signal)
      } catch {
        return settled()
      }
      if (done) return transport.close()
      waiting.add(transport)
      try {
        const { opened } = await start(transport)
        const channel = await opened
        waiting.delete(transport)
        if (done) return channel.close()
        finish({ kind: 'open', channel, address })
      } catch (error) {
        waiting.delete(transport)
        transport.close()
        // Anything else, as an answer that does not decrypt, is an address that is not the host.
        if (error instanceof HandshakeDropped) dropped = true
        settled()
      }
    }

    if (signal?.aborted) return finish({ kind: 'aborted' })
    signal?.addEventListener('abort', abort, { once: true })
    if (addresses.length === 0) return finish({ kind: 'unreachable' })
    for (const address of addresses) void attempt(address)
  })
}
