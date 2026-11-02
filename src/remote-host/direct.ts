// Direct connections on the same network or a VPN: TCP on every interface, IPv4 and IPv6, each
// connection a stream transport the remote host answers as any other. No TLS: the channel inside
// is the encryption. Browsers reach the same port: a connection that starts with an HTTP request
// goes to the web server, which serves the web client and its channel as a WebSocket.
// connectTransport is the other side, for a device or the desktop app.

import { connect, createServer, type Server, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { DirectStatus } from '@shared/host-control'
import type { DirectAddress } from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'
import type { DirectSettings } from '@shared/settings'
import type { LogFn } from '../agent-host/storage'
import { directAddresses, findAddresses, type Interfaces } from './addresses'
import { CLOSE_GRACE_MS, HandshakeLimits } from './limits'
import type { RemoteServer } from './server'
import { streamTransport } from './stream-transport'
import { WebServer } from './web'

/** How often the interfaces are read again, as when the computer joins another network. */
export const CHECK_ADDRESSES_MS = 30_000

/** TCP keepalive, so the session of a device that left the network without a word ends. */
const KEEPALIVE_MS = 30_000

/** How long a connection has for its first bytes, which tell a channel from a browser's request. */
const FIRST_BYTES_TIMEOUT_MS = 10_000

/** Connections waiting for their first bytes at once; more are cut. */
export const MAX_UNREAD = 64

const SOCKET_OPTIONS = { noDelay: true, keepAlive: true, keepAliveInitialDelay: KEEPALIVE_MS }

export interface DirectListenerOptions {
  server: Pick<RemoteServer, 'accept' | 'refusedOne' | 'setAddresses'>
  /** The status changed. */
  changed(): void
  log: LogFn
  /** Where to listen: every interface unless a test names one. */
  host?: string
  interfaces?: () => Interfaces
  limits?: HandshakeLimits
  /** The folder of the web client's built files, for browsers; null in a build without one. */
  webRoot?: string | null
  firstBytesTimeoutMs?: number
}

/** The listener for direct connections, which follows its settings. */
export class DirectListener {
  private listener: Server | null = null
  /** The port the settings ask for, which may differ from the bound one only in tests (0). */
  private port: number | null = null
  private boundPort = 0
  private own: unknown[] = []
  private failure: Extract<DirectStatus, { state: 'failed' }> | null = null
  private current: DirectStatus = { state: 'off' }
  private readonly sockets = new Set<Socket>()
  /** Connections that have sent nothing yet. */
  private readonly unread = new Set<Socket>()
  private readonly limits: HandshakeLimits
  private readonly web: WebServer
  private timer: ReturnType<typeof setInterval> | null = null
  private changes: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly options: DirectListenerOptions) {
    this.limits = options.limits ?? new HandshakeLimits()
    this.web = new WebServer({
      root: options.webRoot ?? null,
      server: options.server,
      limits: this.limits,
      log: options.log,
    })
  }

  get status(): DirectStatus {
    return this.current
  }

  /** Listens, stops or takes new addresses as the settings say; changes apply in order. */
  apply(settings: DirectSettings | undefined): Promise<void> {
    this.changes = this.changes.then(() => this.applyNow(settings))
    return this.changes
  }

  /** Reads the interfaces again and tells devices when the addresses changed. */
  checkAddresses(): void {
    if (!this.stopped) this.refresh()
  }

  /**
   * Stops listening; the channels stay for the remote host to end with a reason, and the browsers'
   * requests end.
   */
  stop(): void {
    this.stopped = true
    this.closeListener()
    this.endUnclaimed()
  }

  private async applyNow(settings: DirectSettings | undefined): Promise<void> {
    if (this.stopped) return
    const port = settings?.enabled === true ? settings.port : null
    if (!settings || port === null || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
      this.closeListener()
      this.port = null
      this.failure = null
      this.own = []
      for (const socket of this.sockets) socket.destroy()
      return this.refresh()
    }
    this.own = Array.isArray(settings.addresses) ? settings.addresses : []
    if (this.listener && this.port === port) return this.refresh()
    this.closeListener()
    this.endUnclaimed()
    this.port = port
    this.failure = null
    let listener: Server
    try {
      listener = await this.listen(port)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      this.options.log('warn', `Direct connections cannot listen on port ${port}: ${code}`)
      const reason =
        code === 'EADDRINUSE'
          ? 'port_in_use'
          : code === 'EACCES' || code === 'EPERM'
            ? 'not_permitted'
            : 'other'
      this.failure = { state: 'failed', port, reason }
      return this.refresh()
    }
    if (this.stopped) {
      listener.close()
      return
    }
    const address = listener.address()
    this.listener = listener
    this.boundPort = typeof address === 'object' && address ? address.port : port
    this.timer = setInterval(() => this.checkAddresses(), CHECK_ADDRESSES_MS)
    this.refresh()
  }

  private listen(port: number): Promise<Server> {
    const listener = createServer(SOCKET_OPTIONS, (socket) => this.take(socket))
    return new Promise((resolve, reject) => {
      listener.once('error', reject)
      // Without a host Node.js listens on :: when IPv6 is there, taking IPv4 too, else 0.0.0.0.
      listener.listen({ port, host: this.options.host }, () => {
        listener.off('error', reject)
        listener.on('error', (error) => {
          this.options.log('warn', `Direct connections: ${error.message}`)
        })
        resolve(listener)
      })
    })
  }

  private closeListener(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Stops taking connections at once; its callback would wait for the open ones, which go on.
    this.listener?.close()
    this.listener = null
  }

  /** Ends the connections no channel has: those that sent nothing yet and the HTTP ones. */
  private endUnclaimed(): void {
    for (const socket of this.unread) socket.destroy()
    this.web.endAll()
  }

  /** Waits for a connection's first bytes, which say whether it is a channel or a browser's. */
  private take(socket: Socket): void {
    socket.on('error', () => {})
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    if (this.unread.size >= MAX_UNREAD) {
      socket.destroy()
      this.options.server.refusedOne()
      return
    }
    this.unread.add(socket)
    const timeout = this.options.firstBytesTimeoutMs ?? FIRST_BYTES_TIMEOUT_MS
    const timer = setTimeout(() => socket.destroy(), timeout)
    const read = (): void => {
      clearTimeout(timer)
      this.unread.delete(socket)
      socket.off('data', first)
      socket.off('close', read)
    }
    const first = (chunk: Buffer): void => {
      read()
      socket.pause()
      socket.unshift(chunk)
      // A channel starts with the 2-byte big-endian length of the device's first handshake
      // message, about a hundred bytes and far below the 0x4100 an uppercase first byte would
      // mean, so only an HTTP request starts with a method's letter.
      const byte = chunk[0]!
      if (byte >= 0x41 && byte <= 0x5a) this.web.take(socket)
      else this.channel(socket)
      socket.resume()
    }
    socket.on('data', first)
    socket.once('close', read)
  }

  private channel(socket: Socket): void {
    const address = socket.remoteAddress
    const settle = address ? this.limits.admit(address) : null
    if (!settle) {
      socket.destroy()
      if (address) this.options.server.refusedOne()
      return
    }
    socket.once('close', settle)
    this.options.server.accept(directTransport(socket, settle))
  }

  private refresh(): void {
    const listening = this.listener !== null
    const addresses = listening
      ? directAddresses(this.own, findAddresses(this.readInterfaces(), this.boundPort))
      : []
    const status: DirectStatus = listening
      ? { state: 'listening', port: this.boundPort, addresses }
      : (this.failure ?? { state: 'off' })
    if (JSON.stringify(status) === JSON.stringify(this.current)) return
    this.current = status
    this.options.server.setAddresses(addresses)
    this.options.changed()
  }

  private readInterfaces(): Interfaces {
    try {
      return (this.options.interfaces ?? networkInterfaces)()
    } catch (error) {
      this.options.log('warn', `Could not read the network interfaces: ${(error as Error).message}`)
      return {}
    }
  }
}

/** A socket's transport, whose close gives up on an end that does not close in turn. */
function socketTransport(socket: Socket): Transport {
  const transport = streamTransport(socket)
  return {
    ...transport,
    close: () => {
      transport.close()
      setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref()
    },
  }
}

/** A direct connection's transport; the handshake settles at the host's first message or the end. */
function directTransport(socket: Socket, settle: () => void): Transport {
  const transport = socketTransport(socket)
  return {
    ...transport,
    send: (message) => {
      settle()
      transport.send(message)
    },
    close: () => {
      settle()
      transport.close()
    },
  }
}

/**
 * Connects to a host's direct address; it rejects when the connection cannot be made, or when
 * `signal` aborts before it is.
 */
export function connectTransport(address: DirectAddress, signal?: AbortSignal): Promise<Transport> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const socket = connect({ host: address.host, port: address.port, ...SOCKET_OPTIONS })
    const abort = (): void => {
      socket.destroy()
      reject(signal!.reason)
    }
    const failed = (error: Error): void => {
      signal?.removeEventListener('abort', abort)
      reject(error)
    }
    signal?.addEventListener('abort', abort, { once: true })
    socket.once('error', failed)
    socket.once('connect', () => {
      signal?.removeEventListener('abort', abort)
      socket.off('error', failed)
      resolve(socketTransport(socket))
    })
  })
}
