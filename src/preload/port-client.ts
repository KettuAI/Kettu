// The renderer's end of a host port. It lives in the preload's isolated world and never hands
// the port itself to the page.

import type { HostResetEvent } from '@shared/ipc'
import type { FromPort, PortConnectionState, PortError, PortErrorCode } from '@shared/port-rpc'

/** The DOM `MessagePort` members the client uses; the preload has no DOM typings. */
export interface ClientPort {
  postMessage(message: unknown): void
  start(): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

/** How a client reaches main: asking for a port, and hearing about ports and resets. */
export interface PortTransport {
  requestPort(): void
  onPort(listener: (port: ClientPort) => void): void
  onReset(listener: (event: HostResetEvent) => void): void
}

export interface PortClientOptions {
  label: string // "agent host", for error messages
  methods: readonly string[]
  transport: PortTransport
  /** Connect on the first request instead of at once, so an unused host never starts. */
  lazy: boolean
}

/**
 * How a failed request reaches the page. `contextBridge` drops an `Error`'s own properties, so
 * the code would be lost; a plain object keeps it. `new PortRequestError(error)` from
 * `@shared/port-rpc` turns it back into an `Error`, and `isPortError` recognizes it.
 */
export interface PortRejection extends PortError {
  name: 'PortRequestError'
}

interface Pending {
  resolve(value: unknown): void
  reject(error: PortRejection): void
}

interface Queued extends Pending {
  method: string
  params: unknown
}

function portError(code: PortErrorCode, message: string, data?: unknown): PortRejection {
  return { name: 'PortRequestError', code, message, ...(data === undefined ? {} : { data }) }
}

export class PortClient<Event> {
  private port: ClientPort | null = null
  private state: PortConnectionState | null = null
  private requested = false
  private nextId = 1
  private readonly inFlight = new Map<number, Pending>()
  private queued: Queued[] = []
  private readonly eventListeners = new Set<(event: Event) => void>()
  private readonly connectionListeners = new Set<(state: PortConnectionState) => void>()

  constructor(private readonly options: PortClientOptions) {
    options.transport.onPort((port) => this.attach(port))
    options.transport.onReset((event) => this.reset(event))
    if (!options.lazy) this.connect()
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (typeof method !== 'string' || !this.options.methods.includes(method)) {
      return Promise.reject(portError('unknown_method', `Unknown method "${String(method)}"`))
    }
    this.connect()
    if (this.state === 'failed') {
      return Promise.reject(portError('host_restarted', `The ${this.options.label} is not running`))
    }
    return new Promise((resolve, reject) => {
      if (this.port) this.post(this.port, method, params, { resolve, reject })
      else this.queued.push({ method, params, resolve, reject })
    })
  }

  onEvent(listener: (event: Event) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onConnection(listener: (state: PortConnectionState) => void): () => void {
    this.connectionListeners.add(listener)
    if (this.state) listener(this.state)
    return () => {
      this.connectionListeners.delete(listener)
    }
  }

  private connect(): void {
    if (this.requested) return
    this.requested = true
    this.options.transport.requestPort()
  }

  private post(port: ClientPort, method: string, params: unknown, pending: Pending): void {
    const id = this.nextId++
    this.inFlight.set(id, pending)
    try {
      port.postMessage({ type: 'request', id, method, params })
    } catch (error) {
      // Params that cannot be cloned, such as functions, never reach the host.
      this.inFlight.delete(id)
      pending.reject(portError('invalid_params', (error as Error).message))
    }
  }

  private attach(port: ClientPort): void {
    if (!this.requested) {
      port.close()
      return
    }
    this.dropPort(`The ${this.options.label} connection was replaced`)
    this.port = port
    this.nextId = 1
    port.onmessage = (message) => this.receive(port, message.data)
    port.start()
    this.setState('connected')
    const queued = this.queued
    this.queued = []
    for (const { method, params, resolve, reject } of queued) {
      this.post(port, method, params, { resolve, reject })
    }
  }

  private reset({ failed }: HostResetEvent): void {
    if (!this.requested) return
    this.dropPort(`The ${this.options.label} restarted`)
    if (failed) {
      this.setState('failed')
      const queued = this.queued
      this.queued = []
      for (const { reject } of queued) {
        reject(portError('host_restarted', `The ${this.options.label} is not running`))
      }
      return
    }
    this.setState('reconnecting')
    this.options.transport.requestPort()
  }

  /** Forgets the current port; the host will never answer what is still in flight on it. */
  private dropPort(message: string): void {
    const port = this.port
    this.port = null
    if (port) {
      port.onmessage = null
      port.close()
    }
    const inFlight = [...this.inFlight.values()]
    this.inFlight.clear()
    for (const { reject } of inFlight) reject(portError('host_restarted', message))
  }

  private receive(port: ClientPort, data: unknown): void {
    if (port !== this.port || typeof data !== 'object' || data === null) return
    const message = data as FromPort<Event>
    if (message.type === 'event') {
      for (const listener of this.eventListeners) {
        try {
          listener(message.event)
        } catch (error) {
          console.error(`A ${this.options.label} event listener failed`, error)
        }
      }
      return
    }
    const pending = this.inFlight.get(message.id)
    if (!pending) return
    this.inFlight.delete(message.id)
    if (message.type === 'response') pending.resolve(message.result)
    else if (message.type === 'error') pending.reject(toError(message.error))
  }

  private setState(state: PortConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of this.connectionListeners) {
      try {
        listener(state)
      } catch (error) {
        console.error(`A ${this.options.label} connection listener failed`, error)
      }
    }
  }
}

function toError(error: PortError | undefined): PortRejection {
  if (!error || typeof error.message !== 'string' || typeof error.code !== 'string') {
    return portError('internal', 'The host sent a malformed error')
  }
  return portError(error.code, error.message, error.data)
}
