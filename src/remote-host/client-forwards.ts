// The desktop app's side of the forwards to a host's dev servers: for each port an agent there
// navigated a session's page to (and any companion ports it named), a listener on this computer's
// loopback, whose every connection goes to the host as a two-way byte stream. Listeners prefer
// binding the original port on 127.0.0.1 when it is free and safe to use, and fall back cleanly to
// an ephemeral port when occupied so local services are never hijacked or disrupted.

import net from 'node:net'
import { MIN_PREFERRED_FORWARD_PORT, type BrowserForward } from '@shared/browser'
import type { ForwardOpen, StreamCancel, StreamEnd } from '@shared/remote/streams'
import type { LogFn } from '../agent-host/storage'
import { HttpForwardRewriter, type ForwardPortMapping } from './forward-http'

const LOOPBACK = '127.0.0.1'

/** Bytes a connection may have on their way to the host before it reads no more from the page. */
const MAX_PENDING = 1024 * 1024

/** How long a loopback probe waits before conservatively treating the port as occupied. */
const PROBE_TIMEOUT_MS = 150

const FREE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

const FALLBACK_BIND_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'])

export interface ClientForwardsOptions {
  /** A JSON message on the host's session; false while the link has no connection. */
  send(message: ForwardOpen | StreamEnd | StreamCancel): boolean
  /** Bytes on the host's session; null while the link has no connection. */
  sendBytes(stream: number, data: Uint8Array): Promise<void> | null
  /** The id of a stream this side opens, shared with the link's uploads: odd, above the last. */
  nextStream(): number
  /** Local ports owned by Kettu itself that a forward must never bind directly. */
  isPortReserved?(port: number): boolean
  /**
   * Probes whether anything on this machine already accepts loopback connections on `port`.
   * Defaults to probing both 127.0.0.1 and ::1 so wildcard (0.0.0.0 / ::) and IPv6 local servers
   * are detected on platforms where binding 127.0.0.1 alone would silently shadow them.
   */
  probePort?(port: number): Promise<boolean>
  log: LogFn
}

interface Listener {
  key: string
  sessionId: string
  forward: BrowserForward
  server: net.Server | null
  localPort: number | null
  closed: boolean
  port: Promise<number | null>
}

interface Local {
  /** The listener that took it. */
  key: string
  socket: net.Socket
  rewriter: HttpForwardRewriter | null
  sentEnd: boolean
  gotEnd: boolean
  quiet: boolean
  pending: number
}

function listenerKey(sessionId: string, forward: BrowserForward): string {
  return `${sessionId}\n${forward.host}\n${forward.port}`
}

function probeAddress(host: '127.0.0.1' | '::1', port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (occupied: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      resolve(occupied)
    }
    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS)
    timer.unref?.()
    socket.once('connect', () => finish(true))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(!error.code || !FREE_ERROR_CODES.has(error.code))
    })
  })
}

/**
 * True when a local service is already accepting connections on `port` over IPv4 or IPv6 loopback.
 * Checking both prevents 127.0.0.1 binds on macOS/BSD from shadowing local 0.0.0.0, ::, or ::1
 * dev servers.
 */
export async function probeLoopbackPort(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([probeAddress('127.0.0.1', port), probeAddress('::1', port)])
  return v4 || v6
}

function listenOn(
  port: number,
  onConnection: (socket: net.Socket) => void,
): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: true }, onConnection)
    const onError = (error: NodeJS.ErrnoException): void => {
      server.close()
      reject(error)
    }
    server.once('error', onError)
    server.listen({ port, host: LOOPBACK, exclusive: true }, () => {
      server.off('error', onError)
      const address = server.address()
      const bound = typeof address === 'object' && address ? address.port : null
      if (bound === null) {
        server.close()
        reject(new Error('Listener bound without a TCP port'))
        return
      }
      resolve({ server, port: bound })
    })
  })
}

export class ClientForwards {
  private readonly listeners = new Map<string, Listener>()
  private readonly locals = new Map<number, Local>()

  constructor(private readonly options: ClientForwardsOptions) {}

  /**
   * The port on 127.0.0.1 that reaches `forward` for the session's page; null when none could.
   * Prefers `forward.port` when it is non-privileged, not reserved, and free on local loopback,
   * falling back to an ephemeral port otherwise.
   */
  listen(
    sessionId: string,
    forward: BrowserForward,
    reservedPorts?: readonly number[],
  ): Promise<number | null> {
    const key = listenerKey(sessionId, forward)
    const known = this.listeners.get(key)
    if (known) return known.port

    const listener: Listener = {
      key,
      sessionId,
      forward,
      server: null,
      localPort: null,
      closed: false,
      port: Promise.resolve(null),
    }
    listener.port = this.startListener(listener, reservedPorts)
    this.listeners.set(key, listener)
    return listener.port
  }

  /** The session's page is gone: its listeners and their connections go. */
  close(sessionId: string): void {
    for (const [key, listener] of [...this.listeners]) {
      if (listener.sessionId !== sessionId) continue
      this.listeners.delete(key)
      this.stop(listener)
    }
  }

  /** Bytes from the host; false when `stream` is none of these connections'. */
  bytes(stream: number, data: Uint8Array): boolean {
    const local = this.locals.get(stream)
    if (!local) return false
    if (local.gotEnd) return true
    if (!local.rewriter) {
      local.socket.write(data)
      return true
    }
    for (const chunk of local.rewriter.hostToClient(data)) {
      if (chunk.byteLength > 0) local.socket.write(chunk)
    }
    return true
  }

  /** The host's `stream.end` or `stream.cancel` for one of these connections; false otherwise. */
  message(value: unknown): boolean {
    const { type, stream } = (value ?? {}) as { type?: unknown; stream?: unknown }
    if (type !== 'stream.end' && type !== 'stream.cancel') return false
    const local = typeof stream === 'number' ? this.locals.get(stream) : undefined
    if (!local) return false
    if (type === 'stream.end') {
      local.gotEnd = true
      if (local.rewriter) {
        for (const chunk of local.rewriter.flushHostToClient()) {
          if (chunk.byteLength > 0) local.socket.write(chunk)
        }
      }
      local.socket.end()
    } else {
      this.drop(stream as number, local)
    }
    return true
  }

  /** The link's connection dropped: the bytes on their way are lost, so the connections go. */
  dropConnections(): void {
    for (const [stream, local] of [...this.locals]) this.drop(stream, local)
  }

  /** The host's session is gone, or the link closes: every listener goes too. */
  closeAll(): void {
    this.dropConnections()
    for (const listener of this.listeners.values()) this.stop(listener)
    this.listeners.clear()
  }

  private async startListener(
    listener: Listener,
    reservedPorts?: readonly number[],
  ): Promise<number | null> {
    const onConnection = (socket: net.Socket): void => this.accept(listener, socket)
    const preferred = listener.forward.port
    const tryPreferred = await this.canTryPreferred(listener, preferred, reservedPorts)
    if (listener.closed) return null

    if (tryPreferred) {
      try {
        const bound = await listenOn(preferred, onConnection)
        return this.finishBind(listener, bound)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!code || !FALLBACK_BIND_CODES.has(code)) {
          this.options.log(
            'warn',
            `Could not bind preferred forward port ${preferred}: ${(error as Error).message}`,
          )
        } else {
          this.options.log(
            'info',
            `Preferred forward port ${preferred} is unavailable (${code}); falling back to an ephemeral port`,
          )
        }
      }
    }
    if (listener.closed) return null

    try {
      const bound = await listenOn(0, onConnection)
      return this.finishBind(listener, bound)
    } catch (error) {
      this.options.log('warn', `Could not listen for a forward: ${(error as Error).message}`)
      if (this.listeners.get(listener.key) === listener) this.listeners.delete(listener.key)
      return null
    }
  }

  private async canTryPreferred(
    listener: Listener,
    port: number,
    reservedPorts?: readonly number[],
  ): Promise<boolean> {
    if (port < MIN_PREFERRED_FORWARD_PORT || port > 65_535) return false
    if (this.options.isPortReserved?.(port)) return false
    if (reservedPorts?.includes(port)) return false
    for (const existing of this.listeners.values()) {
      if (existing !== listener && existing.localPort === port) return false
    }
    const probe = this.options.probePort ?? probeLoopbackPort
    const occupied = await probe(port).catch(() => true)
    return !occupied
  }

  private finishBind(
    listener: Listener,
    bound: { server: net.Server; port: number },
  ): number | null {
    if (listener.closed || this.listeners.get(listener.key) !== listener) {
      bound.server.close()
      return null
    }
    bound.server.on('error', (error) => {
      this.options.log('warn', `Forward listener on port ${bound.port} failed: ${error.message}`)
    })
    listener.server = bound.server
    listener.localPort = bound.port
    return bound.port
  }

  /** All remapped (fallback) ports for `sessionId`, used to keep HTTP headers consistent. */
  private remappedPorts(sessionId: string): ForwardPortMapping[] {
    const mappings: ForwardPortMapping[] = []
    for (const listener of this.listeners.values()) {
      if (
        listener.sessionId === sessionId &&
        listener.localPort !== null &&
        listener.localPort !== listener.forward.port
      ) {
        mappings.push({ localPort: listener.localPort, remotePort: listener.forward.port })
      }
    }
    return mappings
  }

  private accept(listener: Listener, socket: net.Socket): void {
    const { key, sessionId, forward, localPort } = listener
    const stream = this.options.nextStream()
    const open: ForwardOpen = {
      type: 'forward.open',
      stream,
      sessionId,
      host: forward.host,
      port: forward.port,
    }
    if (!this.options.send(open)) {
      socket.destroy()
      return
    }
    const needsRewrite =
      localPort !== null && (localPort !== forward.port || this.remappedPorts(sessionId).length > 0)
    const rewriter = needsRewrite
      ? new HttpForwardRewriter(localPort, forward.port, () => this.remappedPorts(sessionId))
      : null
    const local: Local = {
      key,
      socket,
      rewriter,
      sentEnd: false,
      gotEnd: false,
      quiet: false,
      pending: 0,
    }
    this.locals.set(stream, local)

    const sendChunk = (chunk: Uint8Array): boolean => {
      if (chunk.byteLength === 0) return true
      const sent = this.options.sendBytes(stream, chunk)
      if (!sent) {
        this.drop(stream, local)
        return false
      }
      local.pending += chunk.byteLength
      if (local.pending > MAX_PENDING) socket.pause()
      void sent.then(
        () => {
          local.pending -= chunk.byteLength
          if (local.pending <= MAX_PENDING) socket.resume()
        },
        () => this.drop(stream, local),
      )
      return true
    }

    socket.on('data', (data: Buffer) => {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      if (!local.rewriter) {
        sendChunk(bytes)
        return
      }
      for (const chunk of local.rewriter.clientToHost(bytes)) {
        if (!sendChunk(chunk)) return
      }
    })
    socket.on('end', () => {
      if (this.locals.get(stream) !== local) return
      if (local.rewriter) {
        for (const chunk of local.rewriter.flushClientToHost()) {
          if (!sendChunk(chunk)) return
        }
      }
      local.sentEnd = true
      this.options.send({ type: 'stream.end', stream })
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.locals.get(stream) !== local) return
      this.locals.delete(stream)
      if (!local.quiet && !(local.sentEnd && local.gotEnd)) {
        this.options.send({ type: 'stream.cancel', stream })
      }
    })
  }

  private drop(stream: number, local: Local): void {
    local.quiet = true
    this.locals.delete(stream)
    local.socket.destroy()
  }

  private stop(listener: Listener): void {
    listener.closed = true
    listener.server?.close()
    listener.server = null
    listener.localPort = null
    for (const [stream, local] of [...this.locals]) {
      if (local.key !== listener.key) continue
      this.options.send({ type: 'stream.cancel', stream })
      this.drop(stream, local)
    }
  }
}
