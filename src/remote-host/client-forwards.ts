// The desktop app's side of the forwards to a host's dev servers: for each port an agent there
// navigated a session's page to, a listener on this computer's loopback, whose every connection
// goes to the host as a two-way byte stream. They live while the host keeps this computer's
// session and the session's page is kept; the connections go when the link drops.

import net from 'node:net'
import type { BrowserForward } from '@shared/browser'
import type { ForwardOpen, StreamCancel, StreamEnd } from '@shared/remote/streams'
import type { LogFn } from '../agent-host/storage'

/** Bytes a connection may have on their way to the host before it reads no more from the page. */
const MAX_PENDING = 1024 * 1024

export interface ClientForwardsOptions {
  /** A JSON message on the host's session; false while the link has no connection. */
  send(message: ForwardOpen | StreamEnd | StreamCancel): boolean
  /** Bytes on the host's session; null while the link has no connection. */
  sendBytes(stream: number, data: Uint8Array): Promise<void> | null
  log: LogFn
}

interface Listener {
  key: string
  sessionId: string
  server: net.Server
  port: Promise<number | null>
}

interface Local {
  /** The listener that took it. */
  key: string
  socket: net.Socket
  sentEnd: boolean
  gotEnd: boolean
  quiet: boolean
  pending: number
}

function listenerKey(sessionId: string, forward: BrowserForward): string {
  return `${sessionId}\n${forward.host}\n${forward.port}`
}

export class ClientForwards {
  private readonly listeners = new Map<string, Listener>()
  private readonly locals = new Map<number, Local>()
  /** The ids this side opens are odd and each above the last, over every session with the host. */
  private next = 1

  constructor(private readonly options: ClientForwardsOptions) {}

  /** The port on 127.0.0.1 that reaches `forward` for the session's page; null when none could. */
  listen(sessionId: string, forward: BrowserForward): Promise<number | null> {
    const key = listenerKey(sessionId, forward)
    const known = this.listeners.get(key)
    if (known) return known.port
    const server = net.createServer({ allowHalfOpen: true }, (socket) =>
      this.accept(key, sessionId, forward, socket),
    )
    const port = new Promise<number | null>((resolve) => {
      server.once('error', (error) => {
        this.options.log('warn', `Could not listen for a forward: ${error.message}`)
        if (this.listeners.get(key)?.server === server) this.listeners.delete(key)
        resolve(null)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : null)
      })
    })
    this.listeners.set(key, { key, sessionId, server, port })
    return port
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
    if (!local.gotEnd) local.socket.write(data)
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

  private accept(
    key: string,
    sessionId: string,
    forward: BrowserForward,
    socket: net.Socket,
  ): void {
    const stream = this.next
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
    this.next += 2
    const local: Local = { key, socket, sentEnd: false, gotEnd: false, quiet: false, pending: 0 }
    this.locals.set(stream, local)
    socket.on('data', (data: Buffer) => {
      const sent = this.options.sendBytes(
        stream,
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      )
      if (!sent) return this.drop(stream, local)
      local.pending += data.byteLength
      if (local.pending > MAX_PENDING) socket.pause()
      void sent.then(
        () => {
          local.pending -= data.byteLength
          if (local.pending <= MAX_PENDING) socket.resume()
        },
        () => this.drop(stream, local),
      )
    })
    socket.on('end', () => {
      if (this.locals.get(stream) !== local) return
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
    listener.server.close()
    for (const [stream, local] of [...this.locals]) {
      if (local.key !== listener.key) continue
      this.options.send({ type: 'stream.cancel', stream })
      this.drop(stream, local)
    }
  }
}
