// A paired device's terminals: a port of the device's own to the terminal host, opened at its first
// `terminals.*` request while the owner allows devices the terminal, and closed once the owner does
// not. Requests, responses and events pass through unchanged; opening and closing a terminal is
// noted in the device's activity with its project, never with what is typed or shown.

import type { PortChannel } from '@shared/port-channel'
import type { PortError } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import type { LogFn } from '../agent-host/storage'

/** Whether a request's method is the terminal host's, which goes to the device's terminal port. */
export function isTerminalMethod(method: unknown): method is string {
  return typeof method === 'string' && method.startsWith('terminals.')
}

export const NOT_ALLOWED: PortError = {
  code: 'terminal_not_allowed',
  message: 'This computer does not allow devices to use its terminal',
}

const UNAVAILABLE: PortError = {
  code: 'host_restarted',
  message: 'The terminal host is not running',
}

const TOO_MANY: PortError = { code: 'busy', message: 'Too many terminal requests are waiting' }

/** The device's terminal requests waiting for an answer; past this many the next are refused. */
const MAX_WAITING = 1024

/**
 * The id of the remote host's own `terminals.list`, which tells it each terminal's project:
 * negative, as the remote host's own requests' are, which a device's never are.
 */
const LIST_ID = -1

export interface DeviceTerminalOptions {
  device: PortDevice
  /** Whether the owner allows devices the terminal now. */
  allowed(): boolean
  /** A port to the terminal host for the device, or null while it cannot have one. */
  open(device: PortDevice): Promise<PortChannel | null>
  /** Sends a message on the device's channel. */
  send(value: unknown): void
  /** The device opened a terminal, created or attached, for its activity. */
  opened(terminalId: string, projectPath: string): void
  /**
   * The device closed a terminal: killed it, or lost it as its port closed; `left` when that was
   * because its session ended, which a reconnect may undo.
   */
  closed(terminalId: string, projectPath: string, left: boolean): void
  log: LogFn
}

interface Waiting {
  method: string
  /** The terminal the request names, for `attach` and `kill`. */
  terminalId: string | null
  /** For `kill`: the terminal's project when it was asked, since its removal comes first. */
  projectPath: string | null
}

type State = 'idle' | 'opening' | 'open' | 'ended'

type Request = { type: 'request'; id?: unknown; method: string; params?: unknown }

export class DeviceTerminal {
  private state: State = 'idle'
  private port: PortChannel | null = null
  /** Counts the ports opened, so one that opens after its turn ended is closed. */
  private generation = 0
  /** The device's requests that wait for the port, in order. */
  private readonly queued: Request[] = []
  /** The device's requests the terminal host has not answered yet, by id. */
  private readonly waiting = new Map<number, Waiting>()
  /** Each terminal's project, as the terminal host reported it. */
  private readonly projects = new Map<string, string>()
  /** The terminals the device opened on this port, with their projects. */
  private readonly opened = new Map<string, string>()

  constructor(private readonly options: DeviceTerminalOptions) {}

  /** A `terminals.*` request from the device. */
  request(request: Request): void {
    if (this.state === 'ended') return
    if (!this.options.allowed()) return this.refuse(request.id, NOT_ALLOWED)
    if (this.queued.length + this.waiting.size >= MAX_WAITING) {
      return this.refuse(request.id, TOO_MANY)
    }
    if (this.state === 'open') return this.forward(request)
    this.queued.push(request)
    if (this.state === 'idle') void this.openPort()
  }

  /**
   * Closes the port, if one is open, and notes the terminals the device had open as closed; they
   * keep running on the host. With `error` the requests still waiting are answered with it, and a
   * later request opens a port again; without it the device's session ended, as a reconnect may
   * undo.
   */
  close(error: PortError | null): void {
    if (this.state === 'ended') return
    const port = this.port
    this.port = null
    this.generation++
    this.state = error ? 'idle' : 'ended'
    this.reset(error)
    port?.close()
  }

  private async openPort(): Promise<void> {
    this.state = 'opening'
    const generation = ++this.generation
    const port = await this.options.open(this.options.device).catch(() => null)
    if (generation !== this.generation) return port?.close()
    if (!port) {
      this.state = 'idle'
      return this.reset(UNAVAILABLE)
    }
    this.port = port
    port.onMessage((data) => {
      if (this.port === port) this.fromHost(data)
    })
    port.onClose(() => {
      if (this.port !== port) return
      this.options.log('warn', `The terminal port of device ${this.options.device.id} closed`)
      this.port = null
      this.state = 'idle'
      this.reset(UNAVAILABLE)
    })
    port.send({ type: 'request', id: LIST_ID, method: 'terminals.list', params: {} })
  }

  private forward(request: Request): void {
    const { id, method, params } = request
    if (typeof id === 'number' && Number.isSafeInteger(id)) {
      const named = (params as { id?: unknown } | null)?.id
      const terminalId = typeof named === 'string' ? named : null
      const projectPath =
        method === 'terminals.kill' && terminalId
          ? (this.opened.get(terminalId) ?? this.projects.get(terminalId) ?? null)
          : null
      this.waiting.set(id, { method, terminalId, projectPath })
    }
    this.port?.send(request)
  }

  private fromHost(data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const { type, id, result, event } = data as Record<string, unknown>
    if ((type === 'response' || type === 'error') && typeof id === 'number') {
      if (this.state === 'opening' && id === LIST_ID) return this.listed(result)
      const request = this.waiting.get(id)
      this.waiting.delete(id)
      if (request && type === 'response') this.answered(request, result)
    } else if (type === 'event') {
      this.event(event)
    }
    this.options.send(data)
  }

  /** The terminals as the port opened, after which the device's requests go. */
  private listed(result: unknown): void {
    if (Array.isArray(result)) for (const info of result) this.learn(info)
    this.state = 'open'
    for (const request of this.queued.splice(0)) this.forward(request)
  }

  private answered(request: Waiting, result: unknown): void {
    const { method, terminalId, projectPath } = request
    if (method === 'terminals.create') {
      const id = this.learn(result)
      if (id) this.opening(id)
    } else if (method === 'terminals.attach' && terminalId) {
      this.opening(terminalId)
    } else if (method === 'terminals.kill' && terminalId) {
      this.opened.delete(terminalId)
      if (projectPath) this.options.closed(terminalId, projectPath, false)
    }
  }

  private event(event: unknown): void {
    if (typeof event !== 'object' || event === null) return
    const { type, info, id } = event as Record<string, unknown>
    if (type === 'terminal.info') this.learn(info)
    // Removed by a window, or by the device itself, whose answer to its kill notes it.
    else if (type === 'terminal.removed' && typeof id === 'string') {
      this.projects.delete(id)
      this.opened.delete(id)
    }
  }

  /** Keeps a terminal's project from its info; its id, or null when the value is none. */
  private learn(info: unknown): string | null {
    if (typeof info !== 'object' || info === null) return null
    const { id, projectPath } = info as Record<string, unknown>
    if (typeof id !== 'string' || typeof projectPath !== 'string') return null
    this.projects.set(id, projectPath)
    return id
  }

  /** The device opened a terminal, created or attached, unless it has it open already. */
  private opening(id: string): void {
    const projectPath = this.projects.get(id)
    if (!projectPath || this.opened.has(id)) return
    this.opened.set(id, projectPath)
    this.options.opened(id, projectPath)
  }

  /** Forgets the port's state: its open terminals are noted closed, its requests answered. */
  private reset(error: PortError | null): void {
    for (const [id, projectPath] of this.opened) this.options.closed(id, projectPath, !error)
    this.opened.clear()
    this.projects.clear()
    const ids = [...this.queued.map((request) => request.id), ...this.waiting.keys()]
    this.queued.length = 0
    this.waiting.clear()
    if (error) for (const id of ids) this.refuse(id, error)
  }

  private refuse(id: unknown, error: PortError): void {
    if (typeof id === 'number' && Number.isSafeInteger(id)) {
      this.options.send({ type: 'error', id, error })
    }
  }
}
