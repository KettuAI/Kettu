// A port over a local socket, for a host run under Node.js: each message is a 4-byte big-endian
// length and that many bytes of JSON. The host and the process that connects to it both use it.
// A message holding ArrayBuffers, as a MessagePort carries them, sets the length's top bit: its
// body is the JSON's length, the JSON of the message with null for each buffer and the paths to
// them, then each buffer as its length and bytes.

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { PortChannel } from './port-channel'

/** Beyond any message a port carries, so a longer length means the stream is not a port's. */
export const MAX_MESSAGE_BYTES = 256 * 1024 * 1024

const HEADER_BYTES = 4
const WITH_BUFFERS = 0x80000000
/** Deeper than any message nests, so a buffer below it is not looked for. */
const MAX_DEPTH = 64

type Path = (string | number)[]

/** The ArrayBuffers in a message and where each is. */
function findBuffers(message: unknown): { buffers: ArrayBuffer[]; paths: Path[] } {
  const buffers: ArrayBuffer[] = []
  const paths: Path[] = []
  // One path, grown and cut as the walk goes, copied only for a buffer.
  const path: Path = []
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (value instanceof ArrayBuffer) {
      buffers.push(value)
      paths.push([...path])
      return
    }
    if (path.length >= MAX_DEPTH || ArrayBuffer.isView(value)) return
    const record = value as Record<string | number, unknown>
    const keys: (string | number)[] = Array.isArray(value) ? [...value.keys()] : Object.keys(value)
    for (const key of keys) {
      path.push(key)
      visit(record[key])
      path.pop()
    }
  }
  visit(message)
  return { buffers, paths }
}

/** One message as it goes on the socket. */
export function encodeMessage(message: unknown): Buffer {
  const { buffers, paths } = findBuffers(message)
  const header = Buffer.allocUnsafe(HEADER_BYTES)
  if (buffers.length === 0) {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    header.writeUInt32BE(body.length, 0)
    return Buffer.concat([header, body])
  }
  const json = Buffer.from(
    JSON.stringify([message, paths], (_, value) => (value instanceof ArrayBuffer ? null : value)),
    'utf8',
  )
  const parts: Buffer[] = [header, uint32(json.length), json]
  for (const buffer of buffers) parts.push(uint32(buffer.byteLength), Buffer.from(buffer))
  const body = parts.reduce((sum, part) => sum + part.length, 0) - HEADER_BYTES
  header.writeUInt32BE((WITH_BUFFERS | body) >>> 0, 0)
  return Buffer.concat(parts)
}

function uint32(value: number): Buffer {
  const out = Buffer.allocUnsafe(4)
  out.writeUInt32BE(value, 0)
  return out
}

/** A message with buffers as `encodeMessage` wrote it; throws when it is not one. */
function decodeWithBuffers(body: Buffer): unknown {
  let offset = 0
  const take = (count: number): Buffer => {
    if (offset + count > body.length) throw new Error('The message ends early')
    offset += count
    return body.subarray(offset - count, offset)
  }
  const jsonLength = take(4).readUInt32BE(0)
  const parsed: unknown = JSON.parse(take(jsonLength).toString('utf8'))
  if (!Array.isArray(parsed) || parsed.length !== 2 || !Array.isArray(parsed[1])) {
    throw new Error('The message has no paths')
  }
  let [message] = parsed as [unknown]
  for (const path of parsed[1] as unknown[]) {
    const bytes = take(take(4).readUInt32BE(0))
    message = place(message, path, new Uint8Array(bytes).buffer)
  }
  if (offset !== body.length) throw new Error('The message has bytes past its buffers')
  return message
}

/** The message with a buffer where the encoded one holds its null, the message itself for []. */
function place(message: unknown, path: unknown, buffer: ArrayBuffer): unknown {
  if (!Array.isArray(path)) throw new Error('A buffer has no path')
  if (path.length === 0) {
    if (message !== null) throw new Error('A buffer path does not lead to its place')
    return buffer
  }
  let holder = message
  for (const [index, key] of path.entries()) {
    const valid =
      typeof holder === 'object' &&
      holder !== null &&
      (typeof key === 'string' || typeof key === 'number') &&
      key !== '__proto__' &&
      Object.hasOwn(holder, key)
    if (!valid) throw new Error('A buffer path leads nowhere')
    const value = (holder as Record<string | number, unknown>)[key]
    if (index < path.length - 1) {
      holder = value
      continue
    }
    if (value !== null) throw new Error('A buffer path does not lead to its place')
    ;(holder as Record<string | number, unknown>)[key] = buffer
  }
  return message
}

/** The port on one end of a connected socket. */
export function socketPort<Out = unknown>(socket: Socket): PortChannel<Out> {
  const chunks: Buffer[] = []
  let buffered = 0
  // The length of the message being read, or -1 while its header is.
  let length = -1
  let withBuffers = false
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
        const header = take(HEADER_BYTES).readUInt32BE(0)
        withBuffers = (header & WITH_BUFFERS) !== 0
        length = header & ~WITH_BUFFERS
        if (length > MAX_MESSAGE_BYTES) return fail()
      }
      if (buffered < length) return
      const body = take(length)
      length = -1
      let message: unknown
      try {
        message = withBuffers ? decodeWithBuffers(body) : JSON.parse(body.toString('utf8'))
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
