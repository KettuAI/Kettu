// Relays each window's port to the sessions on other hosts: a request goes to the port of the
// host it names under an id of main's own, so windows never share one, and its answer comes back
// to the window that asked; each host's events and resyncs go to every window. A host's browser
// calls are main's to run, and its answers to them main's own requests. Main also asks hosts on
// the same ports, and answers a window's media from them on its media scheme.

import { MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import type { DeviceFileContent, FileContent } from '@shared/files'
import { isOtherHostMethod, type FromHosts, type HostSessionMessage } from '@shared/host-sessions'
import type { MediaFile, MediaGrant, MediaOpenResult } from '@shared/media'
import type { PortError } from '@shared/port-rpc'
import { DEVICE_ID } from '@shared/remote/device'
import type { HostStatus } from '@shared/remote/hosts'
import type { MediaReadParams } from '@shared/remote/streams'
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

type Answer = { type: 'response'; result: unknown } | { type: 'error'; error: PortError }

/** Who hears an answer: a window under the id it gave, or main itself. */
interface Asker {
  window: Window | null
  answer(answer: Answer): void
}

interface InFlight {
  hostId: string
  asker: Asker
}

interface Held {
  asker: Asker
  method: string
  params: unknown
  timer: ReturnType<typeof setTimeout>
}

/** A file of another host's, as its media URL reads it again from the host. */
export interface HostMediaFile {
  hostId: string
  projectPath: string
  path: string
  /** The session that names it; null for a file of the project, as the Files pane opens one. */
  sessionId: string | null
}

/** Grants the window a URL for media on another host. */
export interface HostMediaGrants {
  grant(file: HostMediaFile, media: Omit<MediaFile, 'path'>): MediaGrant
}

export interface HostSessionsOptions {
  /** A port pair, which tests replace. */
  channel?: () => { port1: RelayPort; port2: RelayPort }
  holdMs?: number
  /** A host's `browser.call` event, for this computer's page of its session; windows never see it. */
  browserCall?(hostId: string, call: unknown): void
  /** A host's `browser.originDecided` event, for that page too. */
  originDecided?(hostId: string, event: unknown): void
  /** The host's session ended. */
  ended?(hostId: string): void
  media?: HostMediaGrants
}

const OFFLINE: PortError = { code: 'host_offline', message: 'The host is not connected' }

export class HostSessions {
  private readonly hosts = new Map<string, RelayPort>()
  private readonly windows = new Set<Window>()
  private readonly inFlight = new Map<number, InFlight>()
  /** Main's own requests, by id, with their host and method, whose answers go nowhere. */
  private readonly own = new Map<number, { hostId: string; method: string }>()
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
      this.send(held.asker, hostId, held.method, held.params)
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

  /**
   * Main's own request to a host whose session is open, as an answer to its browser call; false
   * when it is not. The host's reply is only logged when it is an error.
   */
  request(hostId: string, method: string, params: unknown): boolean {
    const port = this.hosts.get(hostId)
    if (!port) return false
    const mainId = this.nextId++
    try {
      port.postMessage({ type: 'request', id: mainId, method, params })
    } catch (error) {
      log.warn(`A request for a host could not be sent: ${(error as Error).message}`)
      return false
    }
    this.own.set(mainId, { hostId, method })
    return true
  }

  /** Main's own request to a host whose answer it awaits, held as a window's while it connects. */
  call(hostId: string, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.ask(
        {
          window: null,
          answer: (answer) =>
            answer.type === 'response' ? resolve(answer.result) : reject(answer.error),
        },
        hostId,
        method,
        params,
      )
    })
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
    for (const [mainId, request] of [...this.own]) {
      if (request.hostId === hostId) this.own.delete(mainId)
    }
    this.options.ended?.(hostId)
    for (const [mainId, request] of [...this.inFlight]) {
      if (request.hostId !== hostId) continue
      this.inFlight.delete(mainId)
      request.asker.answer({
        type: 'error',
        error: { code: 'host_restarted', message: 'The connection to the host ended' },
      })
    }
    for (const window of this.windows) this.post(window, { kind: 'closed', hostId })
  }

  private detach(window: Window): void {
    if (!this.windows.delete(window)) return
    for (const [mainId, request] of [...this.inFlight]) {
      if (request.asker.window === window) this.inFlight.delete(mainId)
    }
    for (const [hostId, list] of this.held) {
      const kept = list.filter((held) => {
        if (held.asker.window !== window) return true
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
    const asker = this.windowAsker(window, String(hostId), id)
    if (typeof hostId !== 'string' || !DEVICE_ID.test(hostId)) {
      return asker.answer({
        type: 'error',
        error: { code: 'invalid_params', message: 'A request for another host must name it' },
      })
    }
    if (!isOtherHostMethod(method)) {
      return asker.answer({
        type: 'error',
        error: { code: 'unknown_method', message: `Unknown method "${String(method)}"` },
      })
    }
    const media = this.options.media
    if (media && method === 'media.open') return this.openMedia(media, asker, hostId, params)
    if (media && method === 'files.read') {
      return this.ask(fileMedia(media, asker, hostId, params), hostId, method, params)
    }
    this.ask(asker, hostId, method, params)
  }

  private windowAsker(window: Window, hostId: string, id: number): Asker {
    return {
      window,
      answer: (answer) => {
        if (!this.windows.has(window)) return
        const message = { ...answer, id } as HostSessionMessage
        this.post(window, { kind: 'message', hostId, message })
      },
    }
  }

  /**
   * A window's `media.open` on another host, which a device may not make: the host is asked to
   * read none of the file, which it authorizes as it would open it, and the window gets a URL
   * main reads the file from.
   */
  private openMedia(media: HostMediaGrants, asker: Asker, hostId: string, params: unknown): void {
    const { projectPath, path, sessionId } = (params ?? {}) as Record<string, unknown>
    const read: MediaReadParams = {
      projectPath: projectPath as string,
      path: path as string,
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
      offset: 0,
      length: 0,
    }
    this.ask(
      {
        window: asker.window,
        answer: (answer) => {
          if (answer.type === 'error') return asker.answer(answer)
          const result = answer.result as { kind?: unknown; media?: Omit<MediaFile, 'path'> }
          const opened: MediaOpenResult =
            result?.kind === 'granted' && result.media
              ? {
                  kind: 'granted',
                  grant: media.grant(
                    {
                      hostId,
                      projectPath: read.projectPath,
                      path: read.path,
                      sessionId: read.sessionId ?? null,
                    },
                    result.media,
                  ),
                }
              : { kind: openFailure(result?.kind) }
          asker.answer({ type: 'response', result: opened })
        },
      },
      hostId,
      'media.read',
      read,
    )
  }

  /** Sends now, holds while the host connects, or fails at once. */
  private ask(asker: Asker, hostId: string, method: string, params: unknown): void {
    if (this.hosts.has(hostId)) return this.send(asker, hostId, method, params)
    const list = this.held.get(hostId) ?? []
    if (!this.connecting.has(hostId) || list.length >= MAX_HELD) {
      return asker.answer({ type: 'error', error: OFFLINE })
    }
    const timer = setTimeout(() => {
      const waiting = this.held.get(hostId)
      const at = waiting?.indexOf(held) ?? -1
      if (at < 0) return
      waiting!.splice(at, 1)
      asker.answer({ type: 'error', error: OFFLINE })
    }, this.options.holdMs ?? HOLD_MS)
    const held: Held = { asker, method, params, timer }
    list.push(held)
    this.held.set(hostId, list)
  }

  private failHeld(hostId: string): void {
    const list = this.held.get(hostId) ?? []
    this.held.delete(hostId)
    for (const held of list) {
      clearTimeout(held.timer)
      held.asker.answer({ type: 'error', error: OFFLINE })
    }
  }

  private send(asker: Asker, hostId: string, method: string, params: unknown): void {
    const port = this.hosts.get(hostId)
    if (!port) return asker.answer({ type: 'error', error: OFFLINE })
    const mainId = this.nextId++
    this.inFlight.set(mainId, { hostId, asker })
    try {
      port.postMessage({ type: 'request', id: mainId, method, params })
    } catch (error) {
      this.inFlight.delete(mainId)
      asker.answer({
        type: 'error',
        error: { code: 'invalid_params', message: (error as Error).message },
      })
    }
  }

  private fromHost(hostId: string, port: RelayPort, data: unknown): void {
    if (this.hosts.get(hostId) !== port || typeof data !== 'object' || data === null) return
    const message = data as Record<string, unknown>
    if (message.type === 'response' || message.type === 'error') {
      const own = typeof message.id === 'number' ? this.own.get(message.id) : undefined
      if (own?.hostId === hostId) {
        this.own.delete(message.id as number)
        if (message.type === 'error') {
          const error = message.error as { message?: unknown } | undefined
          log.warn(`Host ${hostId} refused ${own.method}: ${String(error?.message)}`)
        }
        return
      }
      const request = typeof message.id === 'number' ? this.inFlight.get(message.id) : undefined
      if (!request || request.hostId !== hostId) return
      this.inFlight.delete(message.id as number)
      return request.asker.answer(
        message.type === 'response'
          ? { type: 'response', result: message.result }
          : { type: 'error', error: message.error as PortError },
      )
    }
    const passed =
      message.type === 'event' ||
      message.type === 'resync' ||
      (message.type === 'terminals.restarted' && Array.isArray(message.ids))
    if (!passed) return
    const event = message.event as { type?: unknown; call?: unknown } | undefined
    if (message.type === 'event' && event?.type === 'browser.call') {
      this.options.browserCall?.(hostId, event.call)
      return
    }
    if (message.type === 'event' && event?.type === 'browser.originDecided') {
      this.options.originDecided?.(hostId, event)
      return
    }
    for (const window of this.windows) {
      this.post(window, { kind: 'message', hostId, message: message as HostSessionMessage })
    }
  }

  private post(window: Window, message: FromHosts): void {
    try {
      window.port.postMessage(message)
    } catch (error) {
      log.warn(`A message for a window could not be sent: ${(error as Error).message}`)
    }
  }
}

function openFailure(kind: unknown): Exclude<MediaOpenResult['kind'], 'granted'> {
  return kind === 'forbidden' || kind === 'not_media' ? kind : 'not_found'
}

/** A window's `files.read`, whose media the host describes and main grants a URL for. */
function fileMedia(media: HostMediaGrants, asker: Asker, hostId: string, params: unknown): Asker {
  const projectPath = (params as { projectPath?: unknown } | null)?.projectPath
  return {
    window: asker.window,
    answer: (answer) => {
      const content = answer.type === 'response' ? (answer.result as DeviceFileContent) : null
      if (content?.kind !== 'media' || typeof projectPath !== 'string') return asker.answer(answer)
      const file = { hostId, projectPath, path: content.path, sessionId: null }
      const result: FileContent = {
        kind: 'media',
        path: content.path,
        grant: media.grant(file, content.media),
      }
      asker.answer({ type: 'response', result })
    },
  }
}
