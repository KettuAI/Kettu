// A transport over a WebSocket to a host's direct port, as the web client opens one: each binary
// message is one Noise message. It takes a standard WebSocket, a browser's or Node.js's, and
// imports no Node.js module, since browsers run it.

import { MAX_NOISE_MESSAGE } from './noise'
import type { Transport } from './transport'

/** How often drained() looks at what the socket holds, since no event says it has sent it. */
const DRAIN_POLL_MS = 20

/** The transport over `socket` once it opens; rejects when it closes or fails before. */
export function webSocketTransport(socket: WebSocket): Promise<Transport> {
  socket.binaryType = 'arraybuffer'
  let open = true
  let closed = false
  let paused = false
  let listener: ((message: Uint8Array) => void) | null = null
  const waiting: Uint8Array[] = []
  const closeListeners: (() => void)[] = []

  const deliver = (): void => {
    while (open && !paused && listener && waiting.length > 0) listener(waiting.shift()!)
  }
  const end = (): void => {
    if (!open) return
    open = false
    socket.close(1000)
  }

  socket.addEventListener('message', (event) => {
    if (!open) return
    const data: unknown = event.data
    // The channel carries binary messages only, none longer than a Noise message.
    if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_NOISE_MESSAGE) return end()
    waiting.push(new Uint8Array(data))
    deliver()
  })
  socket.addEventListener('close', () => {
    open = false
    closed = true
    for (const notify of closeListeners.splice(0)) notify()
  })

  const transport: Transport = {
    send: (message) => {
      if (message.length > MAX_NOISE_MESSAGE) throw new RangeError('Noise message is too long')
      // A Noise message never lives in a SharedArrayBuffer, which the DOM's types allow for.
      if (open && socket.readyState === socket.OPEN) socket.send(message as Uint8Array<ArrayBuffer>)
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
    // A browser reads on regardless, so the messages wait here.
    pause: () => {
      paused = true
    },
    resume: () => {
      if (!paused) return
      paused = false
      deliver()
    },
    buffered: () => socket.bufferedAmount,
    drained: () =>
      new Promise((resolve) => {
        const check = (): void => {
          if (closed || socket.bufferedAmount === 0) resolve()
          else setTimeout(check, DRAIN_POLL_MS)
        }
        check()
      }),
  }

  return new Promise((resolve, reject) => {
    if (socket.readyState === socket.OPEN) return resolve(transport)
    if (socket.readyState !== socket.CONNECTING) {
      return reject(new Error('The WebSocket is closed'))
    }
    const opened = (): void => {
      socket.removeEventListener('error', failed)
      socket.removeEventListener('close', failed)
      resolve(transport)
    }
    const failed = (): void => {
      socket.removeEventListener('open', opened)
      socket.removeEventListener('error', failed)
      socket.removeEventListener('close', failed)
      reject(new Error('The WebSocket closed before it opened'))
    }
    socket.addEventListener('open', opened)
    socket.addEventListener('error', failed)
    socket.addEventListener('close', failed)
  })
}
