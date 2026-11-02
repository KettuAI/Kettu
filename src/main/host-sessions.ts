// Relays each window's port to the sessions on other hosts: a request goes to the port of the
// host it names under an id of main's own, so windows never share one, and its answer comes back
// to the window that asked; each host's events and resyncs go to every window.

import { MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import { isOtherHostMethod, type FromHosts, type HostSessionMessage } from '@shared/host-sessions'
import type { PortError } from '@shared/port-rpc'
import { DEVICE_ID } from '@shared/remote/device'
import type { HostStatus } from '@shared/remote/hosts'
import { createLogger } from './log'

const log = createLogger('host-sessions')

/** How long a request waits for a host whose first connection is under way. */
export const HOLD_MS = 20_000

/** Requests held for one host while it connects; more fail at once. */
const MAX_HELD = 500

/** The main end of a window's port, or what tests use in its place. */
export interface RelayPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

interface Window {
  port: RelayPort
}

interface InFlight {
  window: Window
  hostId: string
  /** The id the window gave the request. */
  id: number
}

interface Held {
  window: Window
  id: number
  method: string
  params: unknown
  timer: ReturnType<typeof setTimeout>
}

export interface HostSessionsOptions {
  /** A port pair, which tests replace. */
  channel?: () => { port1: RelayPort; port2: RelayPort }
  holdMs?: number
}

export class HostSessions {
  private readonly hosts = new Map<string, RelayPort>()
  private readonly windows = new Set<Window>()
  private readonly inFlight = new Map<number, InFlight>()
  private readonly held = new Map<string, Held[]>()
  /** The hosts whose first try is under way, where requests wait rather than fail. */
  private connecting = new Set<string>()
  private nextId = 1

  constructor(private readonly options: HostSessionsOptions = {}) {}

  /** Gives the page its port, with an opening for each host whose session is open. */
  connect(webContents: WebContents): void {
    if (webContents.isDestroyed()) return
    const { port1, port2 } = this.channel()
    const window = this.attach(port1)
    webContents.postMessage('host-sessions:port', null, [port2 as MessagePortMain])
    webContents.once('destroyed', () => this.detach(window))
  }

  /** A window's end: what tests and `connect` share. */
  attach(port: RelayPort): Window {
    const window: Window = { port }
    this.windows.add(window)
    port.on('message', ({ data }) => this.fromWindow(window, data))
    port.on('close', () => this.detach(window))
    port.start()
    for (const hostId of this.hosts.keys()) this.post(window, { kind: 'open', hostId })
    return window
  }

  /** A new session with the host: its port carries the host protocol until it closes. */
  opened(hostId: string, port: RelayPort): void {
    const previous = this.hosts.get(hostId)
    if (previous) this.ended(hostId, previous)
    this.hosts.set(hostId, port)
    port.on('message', ({ data }) => this.fromHost(hostId, port, data))
    port.start()
    for (const window of this.windows) this.post(window, { kind: 'open', hostId })
    for (const held of this.held.get(hostId)?.splice(0) ?? []) {
      clearTimeout(held.timer)
      this.send(held.window, hostId, held.id, held.method, held.params)
    }
    this.held.delete(hostId)
  }

  /** The session ended: its requests fail, and the windows hear of it. */
  closed(hostId: string, port: RelayPort): void {
    if (this.hosts.get(hostId) === port) this.ended(hostId, port)
  }

  /** The hosts as the remote host reports them; held requests fail once their host is not trying. */
  connections(hosts: readonly HostStatus[] | null): void {
    this.connecting = new Set(
      (hosts ?? []).filter((h) => h.connection.state === 'connecting').map((h) => h.id),
    )
    for (const hostId of [...this.held.keys()]) {
      if (!this.connecting.has(hostId)) this.failHeld(hostId)
    }
  }

  /** Kettu quits: every port closes. */
  close(): void {
    for (const [hostId, port] of [...this.hosts]) this.ended(hostId, port)
    for (const hostId of [...this.held.keys()]) this.failHeld(hostId)
    for (const window of [...this.windows]) {
      this.detach(window)
      window.port.close()
    }
  }

  private channel(): { port1: RelayPort; port2: RelayPort } {
    return this.options.channel?.() ?? new MessageChannelMain()
  }

  private ended(hostId: string, port: RelayPort): void {
    this.hosts.delete(hostId)
    port.close()
    for (const [mainId, request] of [...this.inFlight]) {
      if (request.hostId !== hostId) continue
      this.inFlight.delete(mainId)
      this.reply(request.window, hostId, request.id, {
        code: 'host_restarted',
        message: 'The connection to the host ended',
      })
    }
    for (const window of this.windows) this.post(window, { kind: 'closed', hostId })
  }

  private detach(window: Window): void {
    if (!this.windows.delete(window)) return
    for (const [mainId, request] of [...this.inFlight]) {
      if (request.window === window) this.inFlight.delete(mainId)
    }
    for (const [hostId, list] of this.held) {
      const kept = list.filter((held) => {
        if (held.window !== window) return true
        clearTimeout(held.timer)
        return false
      })
      if (kept.length > 0) this.held.set(hostId, kept)
      else this.held.delete(hostId)
    }
  }

  private fromWindow(window: Window, data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const { hostId, message } = data as { hostId?: unknown; message?: unknown }
    const { type, id, method, params } = (message ?? {}) as Record<string, unknown>
    if (type !== 'request' || typeof id !== 'number' || !Number.isSafeInteger(id)) {
      log.warn('Ignored a message for another host that is no request')
      return
    }
    if (typeof hostId !== 'string' || !DEVICE_ID.test(hostId)) {
      return this.reply(window, String(hostId), id, {
        code: 'invalid_params',
        message: 'A request for another host must name it',
      })
    }
    if (!isOtherHostMethod(method)) {
      return this.reply(window, hostId, id, {
        code: 'unknown_method',
        message: `Unknown method "${String(method)}"`,
      })
    }
    if (this.hosts.has(hostId)) return this.send(window, hostId, id, method, params)
    const list = this.held.get(hostId) ?? []
    if (!this.connecting.has(hostId) || list.length >= MAX_HELD) {
      return this.reply(window, hostId, id, {
        code: 'host_offline',
        message: 'The host is not connected',
      })
    }
    const timer = setTimeout(() => {
      const waiting = this.held.get(hostId)
      const at = waiting?.indexOf(held) ?? -1
      if (at < 0) return
      waiting!.splice(at, 1)
      this.reply(window, hostId, id, { code: 'host_offline', message: 'The host is not connected' })
    }, this.options.holdMs ?? HOLD_MS)
    const held: Held = { window, id, method, params, timer }
    list.push(held)
    this.held.set(hostId, list)
  }

  private failHeld(hostId: string): void {
    const list = this.held.get(hostId) ?? []
    this.held.delete(hostId)
    for (const held of list) {
      clearTimeout(held.timer)
      this.reply(held.window, hostId, held.id, {
        code: 'host_offline',
        message: 'The host is not connected',
      })
    }
  }

  private send(window: Window, hostId: string, id: number, method: string, params: unknown): void {
    const port = this.hosts.get(hostId)
    if (!port) {
      return this.reply(window, hostId, id, {
        code: 'host_offline',
        message: 'The host is not connected',
      })
    }
    const mainId = this.nextId++
    this.inFlight.set(mainId, { window, hostId, id })
    try {
      port.postMessage({ type: 'request', id: mainId, method, params })
    } catch (error) {
      this.inFlight.delete(mainId)
      this.reply(window, hostId, id, { code: 'invalid_params', message: (error as Error).message })
    }
  }

  private fromHost(hostId: string, port: RelayPort, data: unknown): void {
    if (this.hosts.get(hostId) !== port || typeof data !== 'object' || data === null) return
    const message = data as Record<string, unknown>
    if (message.type === 'response' || message.type === 'error') {
      const request = typeof message.id === 'number' ? this.inFlight.get(message.id) : undefined
      if (!request || request.hostId !== hostId) return
      this.inFlight.delete(message.id as number)
      if (!this.windows.has(request.window)) return
      return this.post(request.window, {
        kind: 'message',
        hostId,
        message: { ...message, id: request.id } as HostSessionMessage,
      })
    }
    if (message.type !== 'event' && message.type !== 'resync') return
    for (const window of this.windows) {
      this.post(window, { kind: 'message', hostId, message: message as HostSessionMessage })
    }
  }

  private reply(window: Window, hostId: string, id: number, error: PortError): void {
    this.post(window, { kind: 'message', hostId, message: { type: 'error', id, error } })
  }

  private post(window: Window, message: FromHosts): void {
    try {
      window.port.postMessage(message)
    } catch (error) {
      log.warn(`A message for a window could not be sent: ${(error as Error).message}`)
    }
  }
}
