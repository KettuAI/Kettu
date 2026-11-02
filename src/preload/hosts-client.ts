// The page's end of its port to the sessions on other hosts, which main relays. It asks for the
// port on first use and never hands the port itself to the page.

import { isOtherHostMethod, type FromHosts, type HostSessionChange } from '@shared/host-sessions'
import type { ClientPort } from './port-client'
import { portError, toError, type PortRejection } from './port-client'

/** How the client reaches main: asking for the port, and hearing it arrive. */
export interface HostsTransport {
  requestPort(): void
  onPort(listener: (port: ClientPort) => void): void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: PortRejection): void
}

interface Queued extends Pending {
  hostId: string
  method: string
  params: unknown
}

export class HostsClient {
  private port: ClientPort | null = null
  private requested = false
  private nextId = 1
  private readonly inFlight = new Map<number, Pending>()
  private queued: Queued[] = []
  private readonly listeners = new Set<(hostId: string, change: HostSessionChange) => void>()

  constructor(private readonly transport: HostsTransport) {
    transport.onPort((port) => this.attach(port))
  }

  request(hostId: string, method: string, params: unknown): Promise<unknown> {
    if (!isOtherHostMethod(method)) {
      return Promise.reject(portError('unknown_method', `Unknown method "${String(method)}"`))
    }
    this.connect()
    return new Promise((resolve, reject) => {
      if (this.port) this.post(this.port, hostId, method, params, { resolve, reject })
      else this.queued.push({ hostId, method, params, resolve, reject })
    })
  }

  onSession(listener: (hostId: string, change: HostSessionChange) => void): () => void {
    this.listeners.add(listener)
    this.connect()
    return () => {
      this.listeners.delete(listener)
    }
  }

  private connect(): void {
    if (this.requested) return
    this.requested = true
    this.transport.requestPort()
  }

  private post(
    port: ClientPort,
    hostId: string,
    method: string,
    params: unknown,
    pending: Pending,
  ): void {
    const id = this.nextId++
    this.inFlight.set(id, pending)
    try {
      port.postMessage({ hostId, message: { type: 'request', id, method, params } })
    } catch (error) {
      this.inFlight.delete(id)
      pending.reject(portError('invalid_params', (error as Error).message))
    }
  }

  private attach(port: ClientPort): void {
    if (!this.requested || this.port) {
      port.close()
      return
    }
    this.port = port
    port.onmessage = (message) => this.receive(message.data)
    port.start()
    const queued = this.queued
    this.queued = []
    for (const { hostId, method, params, resolve, reject } of queued) {
      this.post(port, hostId, method, params, { resolve, reject })
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const message = data as FromHosts
    if (typeof message.hostId !== 'string') return
    if (message.kind === 'open' || message.kind === 'closed') {
      return this.emit(message.hostId, { kind: message.kind })
    }
    if (message.kind !== 'message') return
    const inner = message.message
    if (inner.type === 'resync') return this.emit(message.hostId, { kind: 'resync' })
    if (inner.type === 'terminals.restarted') {
      const ids = inner.ids.filter((id): id is string => typeof id === 'string')
      return this.emit(message.hostId, { kind: 'terminals-restarted', ids })
    }
    if (inner.type === 'event')
      return this.emit(message.hostId, { kind: 'event', event: inner.event })
    const pending = this.inFlight.get(inner.id)
    if (!pending) return
    this.inFlight.delete(inner.id)
    if (inner.type === 'response') pending.resolve(inner.result)
    else pending.reject(toError(inner.error))
  }

  private emit(hostId: string, change: HostSessionChange): void {
    for (const listener of this.listeners) {
      try {
        listener(hostId, change)
      } catch (error) {
        console.error('A listener for another host failed', error)
      }
    }
  }
}
