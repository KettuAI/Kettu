// Direct connections on the same network or a VPN: TCP on every interface, IPv4 and IPv6, each
// connection a stream transport the remote host answers as any other. No TLS: the channel inside
// is the encryption. connectTransport is the other side, for a device or the desktop app.

import { connect, createServer, type Server, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { DirectStatus } from '@shared/host-control'
import type { DirectAddress } from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'
import type { DirectSettings } from '@shared/settings'
import type { LogFn } from '../agent-host/storage'
import { directAddresses, findAddresses, type Interfaces } from './addresses'
import { HandshakeLimits } from './limits'
import type { RemoteServer } from './server'
import { streamTransport } from './stream-transport'

/** How often the interfaces are read again, as when the computer joins another network. */
export const CHECK_ADDRESSES_MS = 30_000

/** TCP keepalive, so the session of a device that left the network without a word ends. */
const KEEPALIVE_MS = 30_000

/** How long a connection the host ends waits for the device to end its side before it is cut. */
const CLOSE_GRACE_MS = 5_000

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
  private readonly limits: HandshakeLimits
  private timer: ReturnType<typeof setInterval> | null = null
  private changes: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly options: DirectListenerOptions) {
    this.limits = options.limits ?? new HandshakeLimits()
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

  /** Stops listening; the connections stay for the remote host to end with a reason. */
  stop(): void {
    this.stopped = true
    this.closeListener()
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

  private take(socket: Socket): void {
    socket.on('error', () => {})
    const address = socket.remoteAddress
    const settle = address ? this.limits.admit(address) : null
    if (!settle) {
      socket.destroy()
      if (address) this.options.server.refusedOne()
      return
    }
    this.sockets.add(socket)
    socket.once('close', () => {
      this.sockets.delete(socket)
      settle()
    })
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

/** A direct connection's transport; the handshake settles at the host's first message or the end. */
function directTransport(socket: Socket, settle: () => void): Transport {
  const transport = streamTransport(socket)
  return {
    ...transport,
    send: (message) => {
      settle()
      transport.send(message)
    },
    close: () => {
      settle()
      transport.close()
      setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref()
    },
  }
}

/** Connects to a host's direct address; it rejects when the connection cannot be made. */
export function connectTransport(address: DirectAddress): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address.host, port: address.port, ...SOCKET_OPTIONS })
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(streamTransport(socket))
    })
  })
}
