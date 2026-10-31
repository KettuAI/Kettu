// A port over a local socket, for a host run under Node.js: each message is a 4-byte big-endian
// length and that many bytes of JSON. The host and the process that connects to it both use it.

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { PortChannel } from './port-channel'

/** Beyond any message a port carries, so a longer length means the stream is not a port's. */
export const MAX_MESSAGE_BYTES = 256 * 1024 * 1024

const HEADER_BYTES = 4

/** One message as it goes on the socket. */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.allocUnsafe(HEADER_BYTES)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** The port on one end of a connected socket. */
export function socketPort<Out = unknown>(socket: Socket): PortChannel<Out> {
  const chunks: Buffer[] = []
  let buffered = 0
  // The length of the message being read, or -1 while its header is.
  let length = -1
  let open = true
  let closed = false
  let listener: ((data: unknown) => void) | null = null
  const waiting: unknown[] = []
  const closeListeners: (() => void)[] = []

  const take = (count: number): Buffer => {
    buffered -= count
    const first = chunks[0]!
    if (first.length >= count) {
      if (first.length === count) chunks.shift()
      else chunks[0] = first.subarray(count)
      return first.subarray(0, count)
    }
    const out = Buffer.allocUnsafe(count)
    let offset = 0
    while (offset < count) {
      const chunk = chunks[0]!
      const used = Math.min(chunk.length, count - offset)
      chunk.copy(out, offset, 0, used)
      offset += used
      if (used === chunk.length) chunks.shift()
      else chunks[0] = chunk.subarray(used)
    }
    return out
  }

  const fail = (): void => {
    open = false
    socket.destroy()
  }

  socket.on('data', (chunk: Buffer) => {
    if (!open) return
    chunks.push(chunk)
    buffered += chunk.length
    for (;;) {
      if (length < 0) {
        if (buffered < HEADER_BYTES) return
        length = take(HEADER_BYTES).readUInt32BE(0)
        if (length > MAX_MESSAGE_BYTES) return fail()
      }
      if (buffered < length) return
      const body = take(length)
      length = -1
      let message: unknown
      try {
        message = JSON.parse(body.toString('utf8'))
      } catch {
        return fail()
      }
      if (listener) listener(message)
      else waiting.push(message)
      if (!open) return
    }
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
      if (open && socket.writable) socket.write(encodeMessage(message))
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
  }
}

/** Listens on `socketPath` and hands over each connection as a port. */
export function listenPorts(
  socketPath: string,
  onPort: (port: PortChannel) => void,
): Promise<Server> {
  const server = createServer((socket) => onPort(socketPort(socket)))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

/** Connects to a host listening on `socketPath`. */
export function connectPort<Out = unknown>(socketPath: string): Promise<PortChannel<Out>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socketPort<Out>(socket))
    })
  })
}

export interface SocketPath {
  path: string
  /** Removes the folder that holds the socket; a named pipe needs nothing. */
  remove(): Promise<void>
}

/**
 * A new place for a host to listen: a Unix socket in a folder only the user can open, which
 * `mkdtemp` creates, or a named pipe on Windows.
 */
export async function privateSocketPath(name: string): Promise<SocketPath> {
  if (process.platform === 'win32') {
    const pipe = `\\\\.\\pipe\\kettu-${name}-${randomBytes(16).toString('hex')}`
    return { path: pipe, remove: async () => {} }
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-'))
  return {
    path: path.join(dir, `${name}.sock`),
    remove: () => rm(dir, { recursive: true, force: true }),
  }
}
