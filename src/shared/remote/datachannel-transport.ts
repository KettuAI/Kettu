// A transport over a WebRTC DataChannel opened peer to peer: each binary message is one Noise
// message, as on a WebSocket. It takes the part of the standard RTCDataChannel that browsers and
// node-datachannel's polyfill both have, and imports no Node.js module.

import { MAX_NOISE_MESSAGE } from './noise'
import type { Transport } from './transport'

type Handler<E> = { bivarianceHack(event: E): void }['bivarianceHack'] | null

/** The part of an RTCDataChannel the transport uses. */
export interface RtcDataChannel {
  readonly label: string
  readonly readyState: string
  binaryType: string
  readonly bufferedAmount: number
  bufferedAmountLowThreshold: number
  send(data: Uint8Array<ArrayBuffer>): void
  close(): void
  onopen: Handler<unknown>
  onclose: Handler<unknown>
  onbufferedamountlow: Handler<unknown>
  onmessage: Handler<{ readonly data: unknown }>
}

/**
 * The transport over `channel`, which is open; `ended` runs once when it ends from either side,
 * for its owner to close the peer connection under it.
 */
export function dataChannelTransport(channel: RtcDataChannel, ended: () => void): Transport {
  channel.binaryType = 'arraybuffer'
  channel.bufferedAmountLowThreshold = 0
  let open = channel.readyState === 'open'
  let closed = !open
  let paused = false
  let listener: ((message: Uint8Array) => void) | null = null
  const waiting: Uint8Array[] = []
  const closeListeners: (() => void)[] = []
  const drainers: (() => void)[] = []

  const deliver = (): void => {
    while (open && !paused && listener && waiting.length > 0) listener(waiting.shift()!)
  }
  const drainedNow = (): void => {
    if (!closed && channel.bufferedAmount > 0) return
    for (const resolve of drainers.splice(0)) resolve()
  }
  const finish = (): void => {
    if (closed) return
    open = false
    closed = true
    drainedNow()
    ended()
    for (const notify of closeListeners.splice(0)) notify()
  }
  const end = (): void => {
    if (closed) return
    open = false
    channel.close()
    finish()
  }

  channel.onmessage = (event) => {
    if (!open) return
    const { data } = event
    // The channel carries binary messages only, none longer than a Noise message.
    if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_NOISE_MESSAGE) return end()
    waiting.push(new Uint8Array(data))
    deliver()
  }
  channel.onclose = finish
  channel.onbufferedamountlow = drainedNow

  return {
    send: (message) => {
      if (message.length > MAX_NOISE_MESSAGE) throw new RangeError('Noise message is too long')
      if (!open || channel.readyState !== 'open') return
      try {
        // A Noise message never lives in a SharedArrayBuffer, which the DOM's types allow for.
        channel.send(message as Uint8Array<ArrayBuffer>)
      } catch {
        end()
      }
    },
    onMessage: (next) => {
      listener = next
      deliver()
    },
    onClose: (next) => {
      if (closed) queueMicrotask(next)
      else closeListeners.push(next)
    },
    close: end,
    // The channel reads on regardless, so the messages wait here.
    pause: () => {
      paused = true
    },
    resume: () => {
      if (!paused) return
      paused = false
      deliver()
    },
    buffered: () => (closed ? 0 : channel.bufferedAmount),
    drained: () =>
      new Promise((resolve) => {
        drainers.push(resolve)
        drainedNow()
      }),
  }
}
