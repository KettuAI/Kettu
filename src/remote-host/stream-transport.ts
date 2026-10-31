// A transport over a stream socket, as the local socket a host run under Node.js listens on: each
// Noise message is a 2-byte big-endian length and the message, as Noise frames it over TCP.

import { createServer, type Server, type Socket } from 'node:net'
import { MAX_NOISE_MESSAGE } from '@shared/remote/noise'
import type { Transport } from '@shared/remote/transport'

const HEADER_BYTES = 2

/** The transport on one end of a connected socket. */
export function streamTransport(socket: Socket): Transport {
  let pending: Buffer = Buffer.alloc(0)
  let open = true
  let closed = false
  let paused = false
  let listener: ((message: Uint8Array) => void) | null = null
  const waiting: Uint8Array[] = []
  const closeListeners: (() => void)[] = []

  /** Hands over each whole message received, until the transport pauses or ends. */
  const deliver = (): void => {
    while (open && !paused && pending.length >= HEADER_BYTES) {
      const end = HEADER_BYTES + pending.readUInt16BE(0)
      if (pending.length < end) return
      // A copy, so a message keeps no larger chunk alive.
      const message = new Uint8Array(pending.subarray(HEADER_BYTES, end))
      pending = pending.subarray(end)
      if (listener) listener(message)
      else waiting.push(message)
    }
  }

  socket.on('data', (chunk: Buffer) => {
    if (!open) return
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    deliver()
  })
  // A reset or a broken pipe; 'close' follows it.
  socket.on('error', () => {})
  socket.on('close', () => {
    open = false
    closed = true
    for (const notify of closeListeners.splice(0)) notify()
  })

  return {
    send: (message) => {
      if (message.length > MAX_NOISE_MESSAGE) throw new RangeError('Noise message is too long')
      if (!open || !socket.writable) return
      const header = Buffer.allocUnsafe(HEADER_BYTES)
      header.writeUInt16BE(message.length, 0)
      socket.write(Buffer.concat([header, message]))
    },
    onMessage: (next) => {
      listener = next
      for (const message of waiting.splice(0)) next(message)
    },
    onClose: (next) => {
      if (closed) queueMicrotask(next)
      else closeListeners.push(next)
    },
    close: () => {
      open = false
      socket.end()
    },
    pause: () => {
      paused = true
      socket.pause()
    },
    resume: () => {
      if (!paused) return
      paused = false
      deliver()
      // A message handed over may have paused it again.
      if (!paused) socket.resume()
    },
    buffered: () => socket.writableLength,
    drained: () =>
      new Promise((resolve) => {
        // Only a write the socket had no room for brings a drain.
        if (closed || !socket.writableNeedDrain) return resolve()
        const done = (): void => {
          socket.off('drain', done)
          socket.off('close', done)
          resolve()
        }
        socket.on('drain', done)
        socket.on('close', done)
      }),
  }
}

/** Listens on `socketPath` and hands over each connection as a transport. */
export function listenTransports(
  socketPath: string,
  onTransport: (transport: Transport) => void,
): Promise<Server> {
  const server = createServer((socket) => onTransport(streamTransport(socket)))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
