// Main's bridge to the notch island's helper: it starts and restarts the helper, follows the hosts
// through the island's own calls, sends the view and its changes, and turns what the helper sends
// back into answers and opens after checking each against what it sent. Nothing the helper sends
// reaches a host unchecked, and no method beyond the island's list is ever called.

import { ALREADY_ANSWERED, type HostEvent } from '@shared/agent-host'
import { attentionTarget, attentionText } from '@shared/attention'
import type { HostAttention } from '@shared/remote/host-admin'
import type { IslandState } from '@shared/island'
import { limitReaders } from '@shared/session-groups'
import {
  errorText,
  HostFeed,
  isIslandHostMethod,
  type HostRequest,
  type IslandHostMethod,
} from './host-feed'
import {
  ISLAND_PROTOCOL,
  islandLine,
  LineReader,
  parseIslandLine,
  type AnswerResult,
  type ColorMode,
  type IslandHost,
  type IslandToMain,
  type IslandView,
  type MainToIsland,
  type PopKind,
} from './protocol'
import { buildView, diffView, type BuiltView, type HostState } from './view'

/** Changes this close together go as one message. */
export const COALESCE_MS = 50
/** A helper that crashes this often within `CRASH_WINDOW_MS` is not started again. */
const MAX_CRASHES = 3
const CRASH_WINDOW_MS = 60_000
const RESTART_DELAY_MS = 1_000
/** How long the helper gets to answer the hello, and to leave after `quit`. */
const READY_WAIT_MS = 10_000
const QUIT_WAIT_MS = 1_000
/** Lines in a row main cannot take before it counts the helper as broken. */
const MAX_BAD_LINES = 5
/** How often expanding the island may have the agents read their plan limits again. */
const LIMITS_EVERY_MS = 60_000
/** A tool call with no result for this long shows as stuck. */
export const STUCK_AFTER_MS = 5 * 60_000
/** What the helper may leave unread on its input before it counts as hung. */
const MAX_UNREAD_BYTES = 8 * 1024 * 1024
/** Answers that may wait for their hosts at once. */
const MAX_ANSWERS = 16

/** The helper as a running process, which tests replace. */
export interface HelperProcess {
  write(line: string): void
  /** Bytes written and not yet read by the helper. */
  unread(): number
  onStdout(listener: (chunk: Uint8Array) => void): void
  onStderr(listener: (text: string) => void): void
  onExit(listener: (code: number | null, signal: string | null) => void): void
  kill(): void
}

/** A host's connection for the island: its requests, until it closes. */
export interface IslandConnection {
  request: HostRequest
  close(): void
}

export interface IslandLog {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface IslandBridgeDeps {
  /** The switch in Settings › Notifications. */
  enabled(): boolean
  /** Whether a kind's notification switch is on, which governs the island's pops too. */
  kindEnabled(kind: PopKind): boolean
  windowFocused(): boolean
  colorMode(): ColorMode
  version: string
  locale(): string
  strings(): Record<string, string>
  /** Starts the helper; null when this build has none. */
  spawn(): Promise<HelperProcess | null>
  /**
   * A connection to this computer's agent host, or null while it is not running; `onClose` hears
   * it end, as when the host restarts.
   */
  connectLocal(onEvent: (event: HostEvent) => void, onClose: () => void): IslandConnection | null
  /** Asks another host's agent host through main's relay to it, for the island's methods alone. */
  callRemote(hostId: string, method: IslandHostMethod, params: unknown): Promise<unknown>
  /** The other hosts whose session is open now. */
  openRemotes(): string[]
  /** Brings the window forward at a session, or as it is for null. */
  open(target: { hostKey: string; sessionId: string } | null): void
  status(state: IslandState): void
  log: IslandLog
  now?: () => number
}

type Phase = 'off' | 'starting' | 'handshake' | 'running' | 'failed'

interface Host {
  key: string
  /** Null for this computer; another host's name, and whether its session is closed. */
  host: IslandHost | null
  feed: HostFeed
  request: HostRequest
}

const LOCAL = 'local'

const EMPTY_VIEW: IslandView = {
  rows: [],
  requests: [],
  summary: { running: 0, waiting: 0, failed: 0, limit: null, limits: [] },
}

export class IslandBridge {
  private phase: Phase = 'off'
  private failure: Extract<IslandState, { state: 'failed' }>['reason'] | null = null
  private helper: HelperProcess | null = null
  /** Set while main ends the helper on purpose, so its exit is no crash. */
  private stopping: HelperProcess | null = null
  private windowShown = false
  private crashes: number[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private badLines = 0
  private seq = 0
  /** What the helper was last sent, which its answers and opens are checked against. */
  private sent: BuiltView = { view: EMPTY_VIEW, rows: new Map(), requests: new Map() }
  private readonly answering = new Set<string>()
  private limitsReadAt = -Infinity
  private readonly hosts = new Map<string, Host>()
  private local: IslandConnection | null = null
  private locale: string
  private colorMode: ColorMode
  /** The other hosts this computer knows, by id, with their names. */
  private known = new Map<string, string>()

  constructor(private readonly deps: IslandBridgeDeps) {
    this.locale = deps.locale()
    this.colorMode = deps.colorMode()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * The island runs, so the notifications of the kinds it shows stay quiet: they come back only
   * once it is turned off or stopped after repeated crashes.
   */
  showing(): boolean {
    return this.phase === 'running'
  }

  state(): IslandState {
    switch (this.phase) {
      case 'starting':
      case 'handshake':
        return { state: 'starting' }
      case 'running':
        return { state: 'running' }
      case 'failed':
        return { state: 'failed', reason: this.failure ?? 'crashed' }
      default:
        return { state: 'off' }
    }
  }

  /** The first window showed: the island starts now, so it never slows the launch. */
  firstWindowShown(): void {
    this.windowShown = true
    this.apply()
  }

  /** The settings changed: the switch, the language or the color mode. */
  settingsChanged(): void {
    this.apply()
    const locale = this.deps.locale()
    if (locale !== this.locale) {
      this.locale = locale
      if (this.phase === 'running') {
        this.send({ type: 'strings', locale, strings: this.deps.strings() })
        this.sendView()
      }
    }
    this.appearanceChanged()
  }

  appearanceChanged(): void {
    const colorMode = this.deps.colorMode()
    if (colorMode === this.colorMode) return
    this.colorMode = colorMode
    if (this.phase === 'running') this.send({ type: 'appearance', colorMode })
  }

  /** Settings' Try again after the island stopped. */
  retry(): void {
    if (this.phase !== 'failed') return
    this.crashes = []
    this.failure = null
    this.setPhase('off')
    this.apply()
  }

  /** This computer's agent host is ready, at launch or after a restart. */
  localHostReady(): void {
    if (this.phase === 'off' || this.phase === 'failed' || this.local) return
    this.connectLocal()
  }

  /** The other hosts this computer knows; one no longer listed leaves the island. */
  remoteHosts(hosts: readonly { id: string; name: string }[]): void {
    this.known = new Map(hosts.map((host) => [host.id, host.name]))
    if (this.phase !== 'running') return
    for (const [key, host] of [...this.hosts]) {
      if (key === LOCAL || this.known.has(key)) continue
      host.feed.clear()
      this.hosts.delete(key)
    }
    const open = new Set(this.deps.openRemotes())
    for (const [id, name] of this.known) {
      const host = this.hosts.get(id)
      if (!host) this.addRemote(id, name, open.has(id))
      else if (host.host && host.host.name !== name) host.host = { ...host.host, name }
    }
    this.changed()
  }

  /** A session with another host opened: it is read whole. */
  remoteOpened(hostId: string): void {
    const host = this.hosts.get(hostId)
    if (!host?.host) return
    host.host = { ...host.host, offline: false }
    this.loadRemote(host)
  }

  /** The session with another host ended: its rows stay, marked offline, without its requests. */
  remoteClosed(hostId: string): void {
    const host = this.hosts.get(hostId)
    if (!host?.host || host.host.offline) return
    host.host = { ...host.host, offline: true }
    this.changed()
  }

  /** Another host lost what it kept for this computer, so it is read whole again. */
  remoteResync(hostId: string): void {
    const host = this.hosts.get(hostId)
    if (host?.host && !host.host.offline) this.loadRemote(host)
  }

  /** One of another host's events, for its sessions and agents. */
  remoteEvent(hostId: string, event: unknown): void {
    const host = this.hosts.get(hostId)
    if (!host?.host || typeof event !== 'object' || event === null) return
    host.feed.event(event as HostEvent)
  }

  /** What another host says needs the user, popped as this computer's would be. */
  remoteAttention(hostId: string, attention: unknown): void {
    if (!this.hosts.get(hostId)?.host || typeof attention !== 'object' || attention === null) return
    this.attention(attention as HostAttention, hostId)
  }

  /** This computer's agent host stopped; it is read again once `localHostReady` says it is back. */
  localHostDown(): void {
    this.local?.close()
  }

  /** What the host told main needs the user: the island pops it out unless a window is in front. */
  attention(message: HostAttention, hostKey = LOCAL): void {
    if (this.phase !== 'running' || !attentionTarget(message)) return
    if (!this.deps.kindEnabled(message.kind) || this.deps.windowFocused()) return
    const { title, body } = attentionText(message)
    const row = message.kind === 'routine-paused' ? null : this.rowKeyOf(hostKey, message.sessionId)
    this.send({ type: 'pop', row, kind: message.kind, title, body })
  }

  /** Kettu quits: the helper is told to leave and ended if it stays. */
  quit(): void {
    this.windowShown = false
    this.stop()
  }

  private rowKeyOf(hostKey: string, sessionId: string): string | null {
    for (const [key, row] of this.sent.rows) {
      if (row.hostKey === hostKey && row.sessionId === sessionId) return key
    }
    return null
  }

  private setPhase(phase: Phase): void {
    if (phase === this.phase) return
    this.phase = phase
    this.deps.status(this.state())
  }

  private apply(): void {
    const wanted = this.windowShown && this.deps.enabled()
    if (!wanted) {
      if (this.phase === 'failed' && !this.deps.enabled()) {
        // Turning the switch off and on again starts afresh.
        this.crashes = []
        this.failure = null
        this.setPhase('off')
      }
      this.stop()
      return
    }
    if (this.phase === 'off') void this.start()
  }

  private async start(): Promise<void> {
    this.setPhase('starting')
    let helper: HelperProcess | null
    try {
      helper = await this.deps.spawn()
    } catch (error) {
      this.deps.log.error(`Could not start the island: ${errorText(error)}`)
      helper = null
      if (this.phase === 'starting') {
        this.crashed()
        return
      }
    }
    if (this.phase !== 'starting') {
      helper?.kill()
      return
    }
    if (!helper) {
      this.fail('missing')
      return
    }
    this.helper = helper
    this.badLines = 0
    const reader = new LineReader(
      (line) => this.receive(helper, line),
      (reason) => this.badLine(helper, reason),
    )
    helper.onStdout((chunk) => reader.push(chunk))
    helper.onStderr((text) => {
      for (const line of text.split('\n')) if (line.trim()) this.deps.log.info(`helper: ${line}`)
    })
    helper.onExit((code, signal) => this.exited(helper, code, signal))
    this.setPhase('handshake')
    this.readyTimer = setTimeout(() => {
      this.deps.log.warn('The island did not answer its hello')
      helper.kill()
    }, READY_WAIT_MS)
    this.send({
      type: 'hello',
      protocol: ISLAND_PROTOCOL,
      version: this.deps.version,
      locale: this.locale,
      strings: this.deps.strings(),
      colorMode: this.colorMode,
      stuckAfterMs: STUCK_AFTER_MS,
    })
  }

  private stop(): void {
    this.clearTimers()
    this.disconnect()
    const helper = this.helper
    this.helper = null
    if (this.phase !== 'failed') this.setPhase('off')
    if (!helper) return
    this.stopping = helper
    try {
      helper.write(islandLine({ type: 'quit' })!)
    } catch {
      // Its input already closed; the kill below ends it.
    }
    setTimeout(() => {
      if (this.stopping === helper) helper.kill()
    }, QUIT_WAIT_MS)
  }

  private fail(reason: 'crashed' | 'protocol' | 'missing'): void {
    this.clearTimers()
    this.disconnect()
    const helper = this.helper
    this.helper = null
    this.failure = reason
    this.setPhase('failed')
    if (helper) {
      this.stopping = helper
      helper.kill()
    }
  }

  private clearTimers(): void {
    for (const timer of [this.restartTimer, this.readyTimer, this.flushTimer]) {
      if (timer) clearTimeout(timer)
    }
    this.restartTimer = this.readyTimer = this.flushTimer = null
  }

  private exited(helper: HelperProcess, code: number | null, signal: string | null): void {
    if (this.stopping === helper) {
      this.stopping = null
      return
    }
    if (this.helper !== helper) return
    this.helper = null
    this.deps.log.warn(`The island stopped (${signal ?? `exit code ${code}`})`)
    this.crashed()
  }

  /** The helper died or broke: it starts again, unless that keeps happening. */
  private crashed(): void {
    this.clearTimers()
    this.disconnect()
    const now = this.now()
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now]
    if (this.crashes.length >= MAX_CRASHES) {
      this.deps.log.error(`The island crashed ${MAX_CRASHES} times within a minute; it stays off`)
      this.fail('crashed')
      return
    }
    this.setPhase('off')
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.apply()
    }, RESTART_DELAY_MS)
  }

  private badLine(helper: HelperProcess, reason: string): void {
    if (this.helper !== helper) return
    this.deps.log.warn(`Dropped a message from the island: ${reason}`)
    if (++this.badLines < MAX_BAD_LINES) return
    this.deps.log.warn('The island keeps sending what main cannot take; it starts again')
    helper.kill()
  }

  private receive(helper: HelperProcess, line: string): void {
    if (this.helper !== helper) return
    const message = parseIslandLine(line)
    if (!message) {
      this.badLine(helper, 'not a message main takes')
      return
    }
    this.badLines = 0
    this.handle(message)
  }

  private handle(message: IslandToMain): void {
    if (this.phase === 'handshake') {
      if (message.type !== 'ready') {
        this.deps.log.warn(`The island sent ${message.type} before it was ready`)
        return
      }
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.readyTimer = null
      if (message.protocol !== ISLAND_PROTOCOL) {
        this.deps.log.error(
          `The island speaks protocol ${message.protocol}, Kettu ${ISLAND_PROTOCOL}; it stays off`,
        )
        this.fail('protocol')
        return
      }
      this.deps.log.info(`The island ${message.version} is ready`)
      this.setPhase('running')
      this.connectLocal()
      this.remoteHosts([...this.known].map(([id, name]) => ({ id, name })))
      this.sendView()
      return
    }
    if (this.phase !== 'running') return
    switch (message.type) {
      case 'ready':
        this.deps.log.warn('The island said it was ready twice')
        return
      case 'resync':
        this.sendView()
        return
      case 'open':
        this.open(message.row)
        return
      case 'expanded':
        this.readLimits()
        return
      case 'answer':
        void this.answer(message.id, message.request, message.option)
    }
  }

  private open(row: string | null): void {
    if (row === null) {
      this.deps.open(null)
      return
    }
    const target = this.sent.rows.get(row)
    if (!target) {
      this.deps.log.warn('The island asked to open a row it was not sent')
      return
    }
    this.deps.open(target)
  }

  private readLimits(): void {
    const now = this.now()
    if (now - this.limitsReadAt < LIMITS_EVERY_MS) return
    this.limitsReadAt = now
    for (const host of this.hosts.values()) {
      if (host.host?.offline) continue
      for (const agentId of limitReaders([...host.feed.agents.values()])) {
        host.request('agents.refreshLimits', { agentId }).catch((error: unknown) => {
          this.deps.log.warn(`Could not read the plan limits of ${agentId}: ${errorText(error)}`)
        })
      }
    }
  }

  /**
   * Answers a request the helper was sent and that still waits, with one of the options it was
   * sent; anything else is refused without reaching a host.
   */
  private async answer(id: string, requestKey: string, optionId: string): Promise<void> {
    const reply = (result: AnswerResult) => this.send({ type: 'answered', id, ...result })
    const sent = this.sent.requests.get(requestKey)
    const call = sent?.answers.get(optionId)
    if (!sent || !call) {
      this.deps.log.warn('The island answered a request or option it was not sent')
      reply({ result: 'failed', message: 'Not a request that waits' })
      return
    }
    const host = this.hosts.get(sent.hostKey)
    const entryId = requestKey.slice(requestKey.lastIndexOf('#') + 1)
    const waiting = host?.feed.requests
      .get(sent.sessionId)
      ?.requests.some((request) => request.entryId === entryId)
    if (!host || !waiting) {
      reply({ result: 'elsewhere' })
      return
    }
    if (this.answering.has(requestKey) || this.answering.size >= MAX_ANSWERS) {
      reply({ result: 'failed', message: 'An answer to it is already on its way' })
      return
    }
    this.answering.add(requestKey)
    try {
      await host.request(call.method, call.params as never)
      reply({ result: 'answered' })
    } catch (error) {
      const data = (error as { code?: unknown; data?: { reason?: unknown } }) ?? {}
      if (data.code === 'not_found' && data.data?.reason === ALREADY_ANSWERED) {
        host.feed.reread(sent.sessionId)
        reply({ result: 'elsewhere' })
      } else {
        reply({ result: 'failed', message: errorText(error) })
      }
    } finally {
      this.answering.delete(requestKey)
    }
  }

  private connectLocal(): void {
    if (this.local) return
    const feed = new HostFeed({
      request: (method, params) => {
        if (!this.local) return Promise.reject({ code: 'host_restarted', message: 'Not connected' })
        return this.local.request(method, params)
      },
      changed: () => this.changed(),
      warn: (message) => this.deps.log.warn(message),
    })
    const connection = this.deps.connectLocal(
      (event) => feed.event(event),
      () => {
        if (this.local !== connection) return
        this.local = null
        feed.clear()
        this.hosts.delete(LOCAL)
      },
    )
    if (!connection) return
    this.local = connection
    this.hosts.set(LOCAL, { key: LOCAL, host: null, feed, request: connection.request })
    feed.load().then(
      // A reloaded host is sent whole, as after the agent host restarted.
      () => {
        if (this.phase === 'running') this.sendView()
      },
      (error: unknown) =>
        this.deps.log.warn(`Could not read this computer's sessions: ${errorText(error)}`),
    )
  }

  private addRemote(id: string, name: string, open: boolean): void {
    const request: HostRequest = (method, params) => {
      // The same few methods as this computer's, whatever a caller passes.
      if (!isIslandHostMethod(method)) {
        return Promise.reject({ code: 'forbidden', message: `${String(method)} is not allowed` })
      }
      return this.deps.callRemote(id, method, params) as never
    }
    const feed = new HostFeed({
      request,
      changed: () => this.changed(),
      warn: (message) => this.deps.log.warn(message),
    })
    const host: Host = { key: id, host: { id, name, offline: !open }, feed, request }
    this.hosts.set(id, host)
    if (open) this.loadRemote(host)
  }

  private loadRemote(host: Host): void {
    host.feed.load().catch((error: unknown) => {
      this.deps.log.warn(`Could not read the sessions of host ${host.key}: ${errorText(error)}`)
    })
  }

  private disconnect(): void {
    const local = this.local
    this.local = null
    local?.close()
    for (const host of this.hosts.values()) host.feed.clear()
    this.hosts.clear()
    this.answering.clear()
    this.sent = { view: EMPTY_VIEW, rows: new Map(), requests: new Map() }
  }

  private hostStates(): HostState[] {
    return [...this.hosts.values()].map(({ key, host, feed }) => ({
      key,
      host,
      sessions: feed.sessions,
      agents: feed.agents,
      options: feed.options,
      requests: feed.requests,
      tasks: feed.tasks,
    }))
  }

  private changed(): void {
    if (this.phase !== 'running' || this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, COALESCE_MS)
  }

  /** The view now; null when what a host sent could not be read into one. */
  private build(): BuiltView | null {
    try {
      return buildView(this.hostStates(), this.now())
    } catch (error) {
      this.deps.log.error(`Could not build the island's view: ${errorText(error)}`)
      return null
    }
  }

  private flush(): void {
    if (this.phase !== 'running') return
    const built = this.build()
    if (!built) return
    const change = diffView(this.sent.view, built.view)
    if (!change) return
    this.sent = built
    this.send({ type: 'change', seq: ++this.seq, ...change })
  }

  private sendView(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const built = this.build()
    if (!built) return
    this.sent = built
    this.send({ type: 'view', seq: ++this.seq, ...built.view })
  }

  private send(message: MainToIsland): void {
    const helper = this.helper
    if (!helper) return
    const line = islandLine(message)
    if (line === null) {
      this.deps.log.error(`A ${message.type} message for the island was too long to send`)
      return
    }
    if (helper.unread() > MAX_UNREAD_BYTES) {
      this.deps.log.warn('The island stopped reading its input; it starts again')
      helper.kill()
      return
    }
    try {
      helper.write(line)
    } catch (error) {
      this.deps.log.warn(`Could not write to the island: ${errorText(error)}`)
    }
  }
}
