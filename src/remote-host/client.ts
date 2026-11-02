// The desktop app as a device of other hosts: one connection to each known host, kept up with
// backoff, pairing with the host of a pasted link, and adding a machine over SSH. Each session's
// host protocol reaches main through a port of its own, with its binary values carried as byte
// streams. A host of version 2 keeps the session through a drop for a while: the link
// acknowledges what it receives, resumes with the welcome's token, keeps main's port, and sends
// again the requests the host did not read.

import type { BrowserForward } from '@shared/browser'
import type { PortChannel } from '@shared/port-channel'
import { Acknowledger } from '@shared/remote/acks'
import type { ChannelMessage } from '@shared/remote/channel'
import { normalizeDeviceName, isDeviceModel } from '@shared/remote/device'
import { startDeviceChannel, type DeviceChannel } from '@shared/remote/device-channel'
import {
  DEVICE_KEEPALIVE,
  Keepalive,
  KEEPALIVE_VERSION,
  keepaliveMessage,
  type KeepaliveTimings,
  type Ping,
  type Pong,
} from '@shared/remote/keepalive'
import {
  PAIR_HOST_TIMEOUT_MS,
  type HostConnection,
  type HostPairingFailure,
  type HostPairingState,
  type HostStatus,
  type KnownHost,
  type SshAddFailure,
  type SshRoute,
} from '@shared/remote/hosts'
import type { KeyPair } from '@shared/remote/noise'
import type { PairingPayload } from '@shared/remote/pairing'
import {
  BROWSER_FEATURE,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RESUME_MS,
  RESUME_VERSION,
  parseAddresses,
  parseClosing,
  parseWelcome,
  type ClosingReason,
  type DirectAddress,
  type Hello,
  type Welcome,
} from '@shared/remote/protocol'
import { BYTES_FEATURE } from '@shared/remote/streams'
import type { LogFn } from '../agent-host/storage'
import { compareVersions } from '../agent-host/versions'
import { ClientForwards } from './client-forwards'
import { dial, type Connect } from './dial'
import { publicKeyBytes } from './devices'
import { connectTransport } from './direct'
import type { HostStore } from './hosts'
import { LinkRequests, type RequestWire } from './link-requests'
import {
  INSTALL_TIMEOUT_MS,
  installRun,
  lastLines,
  parseSetupReport,
  runSsh,
  SETUP_TIMEOUT_MS,
  setupScript,
  SSH_LOOPBACK,
  SshForward,
  SYSTEM_SSH,
  unsupportedSystem,
  type SshDevice,
  type SshHostInfo,
  type SshProblem,
  type SshProgram,
  type SshRun,
  type SshSetupReport,
} from './ssh'

/** How long a known host has from the handshake to its welcome. */
const WELCOME_TIMEOUT_MS = 15_000

/** The longest wait between tries, which a host that needs an update also waits. */
const MAX_RETRY_MS = 60_000

/** Host protocol messages kept for main's port while it is on its way; more are dropped. */
const MAX_QUEUED = 1000

/** How long a try through SSH has, which may log in through jump hosts first. */
const SSH_TIMEOUT_MS = 45_000

/** How `kettu ssh-setup` exits when the daemon is not running, as `kettu status` does. */
const NOT_RUNNING = 3

/** About 1 s after the first failure, doubling to a minute, give or take a fifth. */
export function retryDelay(failures: number): number {
  const base = Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.max(0, failures - 1))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

export interface HostClientOptions {
  /** The desktop app's own key as a device, separate from its key as a host. */
  key: KeyPair
  hosts: HostStore
  /** Who says hello: kind `desktop`, the app's version and the system. */
  client: Hello['client']
  /** This computer's name, which pairing suggests. */
  name(): string
  /** A port to main for a welcomed host's session, or null when there is none. */
  openMainPort?(hostId: string): Promise<PortChannel | null>
  /** The hosts or their connections changed. */
  changed(): void
  /** How a pairing goes, for the Add host that pasted its link. */
  pairing(pairId: number, state: HostPairingState): void
  log: LogFn
  connect?: Connect
  /** How long a try has to finish a handshake. */
  timeoutMs?: number
  /** The same through SSH. */
  sshTimeoutMs?: number
  /** The ssh to run; the system's by default. */
  ssh?: SshProgram
  /** The script that installs the daemon's `version`; the release's own by default. */
  installScript?: (version: string) => string
  retryDelay?: (failures: number) => number
  now?: () => number
  /** When a quiet host is pinged and given up, DEVICE_KEEPALIVE unless a test shortens it. */
  keepalive?: KeepaliveTimings
}

type SessionEnd = { welcomed: boolean; reason: ClosingReason | null }

interface SessionHandlers {
  welcomed(welcome: Welcome): void
  addresses(addresses: DirectAddress[]): void
  renamed(name: string): void
  /**
   * The host protocol's messages and stream bytes, and the channel's own the session does not
   * read itself; until a handler takes them they wait, as while a pairing is being added.
   */
  message?(message: ChannelMessage): void
  ended(end: SessionEnd): void
}

/** One connection to a host past its handshake: its welcome, then the host protocol around it. */
class HostSession {
  welcome: Welcome | null = null
  private handlers: SessionHandlers = IGNORED
  private reason: ClosingReason | null = null
  private readonly waiting: ChannelMessage[] = []
  private over = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** From version 3, notices a host that stopped answering on an open connection. */
  private keepalive: Keepalive | null = null

  constructor(
    readonly channel: DeviceChannel,
    readonly address: DirectAddress,
    private readonly log: LogFn,
    private readonly timings: KeepaliveTimings = DEVICE_KEEPALIVE,
  ) {}

  get open(): boolean {
    return this.welcome !== null && !this.over
  }

  /**
   * Reads the host's messages from here on, the ones already waiting first, so `handlers` are set
   * before any arrives. Without a welcome within `welcomeTimeoutMs` the connection ends; null
   * waits as long as the host's owner takes to decide on a pairing.
   */
  start(handlers: SessionHandlers, welcomeTimeoutMs: number | null): void {
    this.handlers = handlers
    if (welcomeTimeoutMs !== null) {
      this.timer = setTimeout(() => {
        if (!this.welcome) this.channel.close()
      }, welcomeTimeoutMs)
    }
    this.channel.onMessage((value) => this.receive(value))
    this.channel.onBytes((stream, data) => {
      this.keepalive?.heard()
      this.pass({ kind: 'bytes', stream, data })
    })
    void this.channel.closed.then(() => this.end())
  }

  /** Hands the session to whoever takes it from here, as a link takes a pairing's. */
  handOver(handlers: SessionHandlers): void {
    this.handlers = handlers
    if (!handlers.message) return
    for (const message of this.waiting.splice(0)) handlers.message(message)
  }

  send(value: unknown): void {
    this.channel.send(value).catch((error: unknown) => {
      this.log('warn', `A message for a host could not be sent: ${(error as Error).message}`)
    })
  }

  /** What main's requests go on while this session is the link's. */
  wire(): RequestWire {
    const { channel } = this
    return {
      send: (value) => this.send(value),
      sendBytes: (stream, data) => channel.sendBytes(stream, data),
      buffered: () => channel.buffered(),
      drained: () => channel.drained(),
      bytes: this.welcome?.features.includes(BYTES_FEATURE) ?? false,
    }
  }

  close(): void {
    this.channel.close()
  }

  private receive(value: unknown): void {
    if (this.over) return
    if (this.keepalive) {
      this.keepalive.heard()
      const own = keepaliveMessage(value)
      if (own === 'ping') this.send({ type: 'pong' } satisfies Pong)
      if (own) return
    }
    const type = (value as { type?: unknown } | null)?.type
    if (type === 'closing') {
      this.reason = parseClosing(value)?.reason ?? null
      return
    }
    if (!this.welcome) {
      const welcome = parseWelcome(value)
      if (!welcome) {
        this.log('warn', 'A host answered the hello with something that is no welcome')
        return this.channel.close()
      }
      this.welcome = welcome
      if (this.timer) clearTimeout(this.timer)
      if (welcome.protocol >= KEEPALIVE_VERSION) {
        this.keepalive = new Keepalive({
          ...this.timings,
          ping: () => this.send({ type: 'ping' } satisfies Ping),
          // Ended now as if the network went, so the link reconnects and resumes the session: a
          // stopped host never finishes the close.
          silent: () => {
            this.log('warn', 'A host stopped answering; connecting again')
            this.channel.close()
            this.end()
          },
        })
      }
      return this.handlers.welcomed(welcome)
    }
    const fields = value as Record<string, unknown>
    if (type === 'addresses') this.handlers.addresses(parseAddresses(fields.addresses))
    else if (type === 'renamed') {
      const name = normalizeDeviceName(fields.name)
      if (name) this.handlers.renamed(name)
    }
    // The link counts these too, and keeps the session's own from main.
    this.pass({ kind: 'json', value })
  }

  private pass(message: ChannelMessage): void {
    if (this.over || !this.welcome) return
    if (this.handlers.message) this.handlers.message(message)
    else if (this.waiting.length < MAX_QUEUED) this.waiting.push(message)
  }

  private end(): void {
    if (this.over) return
    this.over = true
    if (this.timer) clearTimeout(this.timer)
    this.keepalive?.stop()
    this.waiting.length = 0
    this.handlers.ended({ welcomed: this.welcome !== null, reason: this.reason })
  }
}

const IGNORED: SessionHandlers = {
  welcomed: () => {},
  addresses: () => {},
  renamed: () => {},
  ended: () => {},
}

/** The session's own messages, which main never hears. */
const OWN: ReadonlySet<unknown> = new Set(['addresses', 'renamed'])

/** The connection to one known host, tried again with backoff until it is forgotten. */
class HostLink {
  connection: HostConnection = { state: 'connecting' }
  private session: HostSession | null = null
  private trying: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private closed = false
  /** Main's port for the host's session, kept while the host keeps the session. */
  private port: PortChannel | null = null
  /** What came for main before its port did. */
  private readonly queued: unknown[] = []
  /** Main's requests not answered yet, sent again when the host did not read them. */
  private readonly requests: LinkRequests
  /** The token of the last welcome, while the host keeps the session for this link to resume. */
  private resumeToken: string | null = null
  private keptTimer: ReturnType<typeof setTimeout> | null = null
  private keptUntil = 0
  /** Counts the host's sessions, so a port for one that went is closed when it comes. */
  private sessions = 0
  /** A host reached over SSH was asked for its port since it was last online. */
  private askedPort = false
  private readonly acks = new Acknowledger((ack) => this.session?.send(ack))
  /** The host's dev servers that its agents opened in this computer's browser. */
  private readonly forwards: ClientForwards
  /** The streams this side opens, uploads and forwards alike, are odd and each above the last. */
  private streams = 1

  constructor(
    private readonly client: HostClient,
    readonly id: string,
  ) {
    this.forwards = new ClientForwards({
      send: (message) => {
        if (!this.session?.open) return false
        this.session.send(message)
        return true
      },
      sendBytes: (stream, data) =>
        this.session?.open ? this.session.channel.sendBytes(stream, data) : null,
      nextStream: () => this.nextStream(),
      log: client.options.log,
    })
    this.requests = new LinkRequests({
      toMain: (message) => this.toMain(message),
      nextStream: () => this.nextStream(),
      log: client.options.log,
    })
  }

  private get host(): KnownHost | null {
    return this.client.options.hosts.get(this.id)
  }

  private nextStream(): number {
    const stream = this.streams
    this.streams += 2
    return stream
  }

  start(): void {
    if (this.host?.removed) return this.set({ state: 'stopped', reason: 'removed' })
    void this.connect()
  }

  /** Tries now, as after the computer woke, unless the host said not to. */
  retry(): void {
    if (this.closed || this.session || this.trying) return
    if (this.stoppedFor('removed', 'update_client')) return
    this.failures = 0
    this.cancel()
    void this.connect()
  }

  /** Takes a pairing's welcomed session in place of the one it had, if any. */
  adopt(session: HostSession): void {
    this.cancel()
    this.drop()
    this.session = session
    // Welcomed first, so what came after the welcome counts on the new session.
    if (session.open) this.welcomed(session, session.welcome!, false)
    session.handOver(this.handlersFor(session, false))
    if (!session.open) this.ended(session, { welcomed: true, reason: null })
  }

  /** The owner changed the addresses here: a host not reached is tried at them at once. */
  addressesChanged(): void {
    if (this.connection.state !== 'online') this.retry()
  }

  rename(name: string): boolean {
    if (!this.session?.open) return false
    this.session.send({ type: 'rename', name })
    return true
  }

  /** A port on this computer that reaches `forward` on the host; null without its session. */
  forward(sessionId: string, forward: BrowserForward): Promise<number | null> {
    if (!this.port) return Promise.resolve(null)
    return this.forwards.listen(sessionId, forward)
  }

  /** The session's page is gone, so its forwards go. */
  closeForwards(sessionId: string): void {
    this.forwards.close(sessionId)
  }

  /** Forgotten, or the client stops: the connection ends and is not tried again. */
  close(): void {
    this.closed = true
    this.cancel()
    this.drop()
    this.lose()
  }

  private stoppedFor(...reasons: string[]): boolean {
    return this.connection.state === 'stopped' && reasons.includes(this.connection.reason)
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.trying?.abort()
    this.trying = null
  }

  /** Ends the session without its end counting as the host's. */
  private drop(): void {
    const session = this.session
    this.session = null
    this.acks.pause()
    this.requests.detach()
    session?.close()
  }

  private async connect(): Promise<void> {
    const host = this.host
    if (this.closed || this.session || this.trying || !host || host.removed) return
    const { options } = this.client
    const trying = (this.trying = new AbortController())
    const hostKey = publicKeyBytes(host.publicKey)!
    const resume = this.resumeToken
      ? { token: this.resumeToken, received: this.acks.received }
      : null
    const hello = { ...this.client.hello(), ...(resume ? { resume } : {}) }
    const route = host.ssh ?? null
    const forward = route ? new SshForward(this.client.ssh, route.target) : null
    const result = await dial({
      addresses: route ? [{ host: SSH_LOOPBACK, port: route.port }] : host.addresses,
      connect: forward?.connect ?? this.client.connect,
      start: (transport) => startDeviceChannel({ transport, hostKey, key: options.key, hello }),
      timeoutMs: route ? this.client.sshTimeoutMs : this.client.timeoutMs,
      signal: trying.signal,
    })
    if (this.trying !== trying) {
      if (result.kind === 'open') result.channel.close()
      return
    }
    this.trying = null
    if (result.kind === 'aborted') return
    if (result.kind !== 'open') {
      if (route && this.mayAskPort(forward!.problem())) return void this.askPort(route)
      return this.failed()
    }
    const session = new HostSession(result.channel, result.address, options.log, options.keepalive)
    this.session = session
    session.start(this.handlersFor(session, resume !== null), WELCOME_TIMEOUT_MS)
  }

  /**
   * Whether to ask the daemon for its port: once between two connections, when ssh got through
   * but the channel did not, as when the daemon started again on another port.
   */
  private mayAskPort(problem: SshProblem | null): boolean {
    return !this.askedPort && (problem === 'refused' || problem === null)
  }

  /** Runs the setup script for the port alone, and tries it at once when it changed. */
  private async askPort(route: SshRoute): Promise<void> {
    this.askedPort = true
    const trying = (this.trying = new AbortController())
    const setup = await this.client.sshSetup(route.target, null, trying.signal)
    if (this.trying !== trying) return
    this.trying = null
    const info = setup?.report.host
    const host = this.host
    if (host?.ssh && info && info.publicKey === host.publicKey && info.port !== host.ssh.port) {
      this.client.options.hosts.update(this.id, { ssh: { ...host.ssh, port: info.port } })
      return void this.connect()
    }
    this.failed()
  }

  /** `askedResume`: the session's hello named the last one, which the host may have kept. */
  private handlersFor(session: HostSession, askedResume: boolean): SessionHandlers {
    const mine = (): boolean => this.session === session
    return {
      welcomed: (welcome) => {
        if (mine()) this.welcomed(session, welcome, askedResume)
      },
      addresses: (addresses) => {
        if (mine()) this.addresses(addresses, session.address)
      },
      renamed: (name) => {
        if (!mine()) return
        this.client.options.hosts.update(this.id, { deviceName: name })
        this.client.options.changed()
      },
      message: (message) => {
        if (mine()) this.message(session, message)
      },
      ended: (end) => {
        if (!mine()) return
        this.session = null
        this.ended(session, end)
      },
    }
  }

  private welcomed(session: HostSession, welcome: Welcome, askedResume: boolean): void {
    const { hosts, now } = this.client.options
    const resumed = askedResume && welcome.resumed !== undefined
    if (this.keptTimer) clearTimeout(this.keptTimer)
    this.keptTimer = null
    // A new session: main's port for the last one goes, and with it what was in flight.
    if (!resumed) this.lose()
    this.resumeToken = welcome.resume ?? null
    this.askedPort = false
    // A host added over SSH is reached through it alone, whatever addresses it has.
    const ssh = this.host?.ssh !== undefined
    hosts.update(this.id, {
      name: welcome.host.name,
      platform: welcome.host.platform,
      version: welcome.host.version,
      deviceName: welcome.device.name,
      addresses: ssh ? [] : merged(session.address, welcome.addresses, this.host?.addresses ?? []),
      lastOnlineAt: (now ?? Date.now)(),
      removed: false,
    })
    this.failures = 0
    this.set({ state: 'online', address: session.address })
    // The host read main's requests up to the one it names; the rest go again.
    this.requests.attach(session.wire(), resumed ? welcome.resumed!.request : 0)
    if (!resumed) void this.openPort(session, ++this.sessions)
  }

  private async openPort(session: HostSession, sessions: number): Promise<void> {
    const port = (await this.client.options.openMainPort?.(this.id).catch(() => null)) ?? null
    if (!port) return
    if (this.sessions !== sessions || this.port || !session.welcome) return port.close()
    this.port = port
    port.onMessage((data) => this.fromMain(data))
    for (const value of this.queued.splice(0)) port.send(value)
  }

  /** A request from main goes now, or once the host is back; it is kept until answered. */
  private fromMain(data: unknown): void {
    const { type, id } = (data ?? {}) as { type?: unknown; id?: unknown }
    if (type === 'request' && typeof id === 'number' && Number.isSafeInteger(id)) {
      return this.requests.request(data as Record<string, unknown>)
    }
    if (this.session?.open) this.session.send(data)
  }

  private message(session: HostSession, message: ChannelMessage): void {
    if (session.welcome!.protocol >= RESUME_VERSION) {
      this.acks.counted(message.kind === 'bytes' ? message.data.length : 0)
    }
    if (message.kind === 'bytes') {
      if (this.forwards.bytes(message.stream, message.data)) return
      return this.requests.bytes(message.stream, message.data)
    }
    const value = message.value
    if (typeof value !== 'object' || value === null) return
    if (OWN.has((value as { type?: unknown }).type) || this.forwards.message(value)) return
    this.requests.received(value as Record<string, unknown>)
  }

  private toMain(message: unknown): void {
    if (this.port) this.port.send(message)
    else if (this.queued.length < MAX_QUEUED) this.queued.push(message)
  }

  private addresses(addresses: DirectAddress[], answered: DirectAddress): void {
    const host = this.host
    if (!host || host.ssh) return
    this.client.options.hosts.update(this.id, {
      addresses: merged(answered, addresses, host.addresses),
    })
    this.client.options.changed()
  }

  private ended(session: HostSession, { welcomed, reason }: SessionEnd): void {
    this.forwards.dropConnections()
    if (this.closed) return
    this.acks.pause()
    this.requests.detach()
    const { hosts } = this.client.options
    if (welcomed) hosts.online(this.id)
    // A host that says why ends the session; one that just went keeps it for a while.
    const kept =
      welcomed &&
      reason === null &&
      this.resumeToken !== null &&
      (session.welcome?.protocol ?? 0) >= RESUME_VERSION
    if (kept) {
      this.keptUntil = Date.now() + RESUME_MS
      if (this.keptTimer) clearTimeout(this.keptTimer)
      this.keptTimer = setTimeout(() => {
        this.keptTimer = null
        this.expireKept()
      }, RESUME_MS)
    } else if (welcomed) {
      this.lose()
    }
    if (reason === 'removed') {
      hosts.update(this.id, { removed: true })
      return this.set({ state: 'stopped', reason: 'removed' })
    }
    if (reason === 'update_client') return this.set({ state: 'stopped', reason })
    if (reason === 'update_host') {
      this.set({ state: 'stopped', reason })
      return this.schedule(MAX_RETRY_MS)
    }
    if (!welcomed) return this.failed()
    // Reconnecting in place: the host shows as offline only once a try fails.
    this.failures = 0
    this.set({ state: 'connecting' })
    this.schedule(this.client.retryDelay(1))
  }

  /** The host's session is gone, or no longer to be resumed: main's port for it closes. */
  private lose(): void {
    this.sessions++
    if (this.keptTimer) clearTimeout(this.keptTimer)
    this.keptTimer = null
    this.resumeToken = null
    this.acks.reset()
    this.requests.lose()
    this.queued.length = 0
    this.forwards.closeAll()
    const port = this.port
    this.port = null
    port?.close()
  }

  /** Gives up the session the host kept once it would keep it no longer, between tries. */
  private expireKept(): void {
    if (this.resumeToken === null || this.session || this.trying) return
    if (Date.now() >= this.keptUntil) this.lose()
  }

  private failed(): void {
    this.failures++
    this.expireKept()
    // A host that needs an update keeps saying so, and waits the longest, between its tries.
    if (this.stoppedFor('update_host')) return this.schedule(MAX_RETRY_MS)
    this.set({ state: 'offline' })
    this.schedule(this.client.retryDelay(this.failures))
  }

  private schedule(delay: number): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, delay)
  }

  private set(connection: HostConnection): void {
    this.connection = connection
    this.client.options.changed()
  }
}

/** The answering address first, then the host's own list, or what was kept while it sends none. */
function merged(
  answered: DirectAddress,
  told: DirectAddress[],
  kept: DirectAddress[],
): DirectAddress[] {
  return [answered, ...(told.length > 0 ? told : kept)]
}

/** Pairing with the host of a pasted link, until it is added or the pairing ends. */
class Pairing {
  private readonly aborting = new AbortController()
  private session: HostSession | null = null
  private done = false

  constructor(
    private readonly client: HostClient,
    readonly pairId: number,
  ) {}

  async run(payload: PairingPayload, model: string): Promise<void> {
    const { options } = this.client
    this.say({ state: 'connecting' })
    const result = await dial({
      addresses: payload.addresses,
      connect: this.client.connect,
      start: (transport) =>
        startDeviceChannel({
          transport,
          hostKey: payload.hostKey,
          key: options.key,
          psk: payload.secret,
          hello: this.client.hello(model),
        }),
      timeoutMs: this.client.timeoutMs,
      signal: this.aborting.signal,
    })
    if (result.kind === 'aborted') return
    if (this.done) {
      if (result.kind === 'open') result.channel.close()
      return
    }
    if (result.kind === 'dropped') return this.fail('void')
    if (result.kind === 'unreachable') return this.fail('unreachable')
    this.say({ state: 'confirm' })
    const publicKey = Buffer.from(payload.hostKey).toString('base64')
    const session = new HostSession(result.channel, result.address, options.log, options.keepalive)
    this.session = session
    session.start(
      {
        welcomed: (welcome) => void this.added(session, publicKey, payload, welcome),
        addresses: () => {},
        renamed: () => {},
        ended: ({ reason }) =>
          this.fail(
            reason === 'rejected' || reason === 'update_client' || reason === 'update_host'
              ? reason
              : 'void',
          ),
      },
      null,
    )
  }

  /** Add host closed: a pairing the host has not added ends, and the host frees its code. */
  close(): void {
    if (this.done) return
    this.done = true
    this.aborting.abort()
    if (!this.session?.welcome) this.session?.close()
    this.client.ended(this)
  }

  /** The host added this computer: it is kept, even when Add host closed meanwhile. */
  private async added(
    session: HostSession,
    publicKey: string,
    payload: PairingPayload,
    welcome: Welcome,
  ): Promise<void> {
    // Its end until the link takes it is the link's to handle, as it reconnects.
    session.handOver(IGNORED)
    const host = await this.client.options.hosts.add({
      publicKey,
      name: welcome.host.name,
      platform: welcome.host.platform,
      version: welcome.host.version,
      addresses: merged(session.address, welcome.addresses, payload.addresses),
      deviceName: welcome.device.name,
    })
    if (!host) {
      this.client.options.log('warn', 'A host that welcomed this computer could not be kept')
      session.close()
      return this.fail('void')
    }
    const status = this.client.adopt(host, session)
    if (this.done) return
    this.done = true
    this.client.ended(this)
    this.say({ state: 'added', host: status })
  }

  private fail(reason: HostPairingFailure): void {
    if (this.done) return
    this.done = true
    this.session?.close()
    this.client.ended(this)
    this.say({ state: 'failed', reason })
  }

  private say(state: HostPairingState): void {
    this.client.options.pairing(this.pairId, state)
  }
}

/** What a failed ssh means for adding a machine. */
const SSH_FAILURES: Record<SshProblem, SshAddFailure> = {
  missing: 'ssh_missing',
  unreachable: 'ssh_unreachable',
  auth: 'ssh_auth',
  host_unknown: 'ssh_host_unknown',
  host_changed: 'ssh_host_changed',
  forwarding: 'ssh_forwarding',
  // The forward reached nothing, after the daemon said where it listens.
  refused: 'ssh_not_running',
}

/**
 * Adding a machine over SSH: the daemon is installed when missing and updated when older than
 * this app, never moved back from a newer one; this computer's key is recorded on it, which the
 * login proves the user may do, and the channel opens through ssh. The host is kept once it
 * welcomes this computer.
 */
class SshAdding {
  private readonly aborting = new AbortController()
  private session: HostSession | null = null
  private done = false

  constructor(
    private readonly client: HostClient,
    readonly pairId: number,
  ) {}

  async run(target: string, model: string): Promise<void> {
    const { options } = this.client
    const wanted = options.client.version
    const device: SshDevice = {
      publicKey: Buffer.from(options.key.publicKey).toString('base64'),
      name: normalizeDeviceName(options.name()) ?? 'Kettu',
      kind: options.client.kind,
      platform: options.client.platform,
      model: isDeviceModel(model) ? model : '',
    }
    this.say({ state: 'ssh', step: 'connecting' })
    let setup = await this.setup(target, device)
    if (!setup) return
    const unsupported = unsupportedSystem(setup.report.system)
    if (unsupported) return this.fail('ssh_unsupported', unsupported)
    const installed = setup.report.version
    if (installed === null || compareVersions(installed, wanted) < 0) {
      this.say(
        installed === null
          ? { state: 'ssh', step: 'installing', version: wanted }
          : { state: 'ssh', step: 'updating', from: installed, to: wanted },
      )
      const install = await this.ssh(target, this.client.installScript(wanted), INSTALL_TIMEOUT_MS)
      if (!install) return
      if (install.code !== 0) {
        return this.fail('ssh_install', lastLines(`${install.stdout}\n${install.stderr}`))
      }
      this.say({ state: 'ssh', step: 'adding' })
      setup = await this.setup(target, device)
      if (!setup) return
    }
    const info = setup.report.host
    const hostKey = info ? publicKeyBytes(info.publicKey) : null
    if (!info || !hostKey) {
      if (setup.report.failed === NOT_RUNNING) return this.fail('ssh_not_running')
      return this.fail('ssh_failed', lastLines(setup.run.stderr))
    }
    this.say({ state: 'ssh', step: 'opening' })
    const forward = new SshForward(this.client.ssh, target)
    const result = await dial({
      addresses: [{ host: SSH_LOOPBACK, port: info.port }],
      connect: forward.connect,
      start: (transport) =>
        startDeviceChannel({ transport, hostKey, key: options.key, hello: this.client.hello() }),
      timeoutMs: this.client.sshTimeoutMs,
      signal: this.aborting.signal,
    })
    if (result.kind === 'aborted') return
    if (this.done) {
      if (result.kind === 'open') result.channel.close()
      return
    }
    if (result.kind !== 'open') {
      const problem = forward.problem()
      return this.fail(problem ? SSH_FAILURES[problem] : 'ssh_failed', forward.detail())
    }
    const session = new HostSession(result.channel, result.address, options.log, options.keepalive)
    this.session = session
    session.start(
      {
        welcomed: (welcome) => void this.added(session, target, info, welcome),
        addresses: () => {},
        renamed: () => {},
        ended: ({ reason }) =>
          reason === 'update_client' || reason === 'update_host'
            ? this.fail(reason)
            : this.fail('ssh_failed', forward.detail()),
      },
      WELCOME_TIMEOUT_MS,
    )
  }

  /** Add host closed: what runs over ssh stops, and a host not welcomed yet is not kept. */
  close(): void {
    if (this.done) return
    this.done = true
    this.aborting.abort()
    if (!this.session?.welcome) this.session?.close()
    this.client.ended(this)
  }

  /** The setup script's run and report, or null once adding failed or ended. */
  private async setup(
    target: string,
    device: SshDevice,
  ): Promise<{ run: SshRun; report: SshSetupReport } | null> {
    const run = await this.ssh(target, setupScript(device), SETUP_TIMEOUT_MS)
    if (!run) return null
    const report = parseSetupReport(run.stdout)
    // No POSIX shell answered, as on Windows.
    if (!report.system) {
      this.fail('ssh_unsupported')
      return null
    }
    return { run, report }
  }

  /** A script's run once ssh got through, or null once adding failed for ssh or ended. */
  private async ssh(target: string, script: string, timeoutMs: number): Promise<SshRun | null> {
    const run = await runSsh(this.client.ssh, target, script, {
      timeoutMs,
      signal: this.aborting.signal,
    })
    if (!run || this.done) return null
    if (run.problem) this.fail(SSH_FAILURES[run.problem], lastLines(run.stderr))
    else if (run.code === 255 || run.code === null) this.fail('ssh_failed', lastLines(run.stderr))
    else return run
    return null
  }

  private async added(
    session: HostSession,
    target: string,
    info: SshHostInfo,
    welcome: Welcome,
  ): Promise<void> {
    session.handOver(IGNORED)
    // The key the handshake was made to, as the daemon printed it over the login.
    const host = await this.client.options.hosts.add({
      publicKey: info.publicKey,
      name: welcome.host.name,
      platform: welcome.host.platform,
      version: welcome.host.version,
      addresses: [],
      deviceName: welcome.device.name,
      ssh: { target, port: info.port },
    })
    if (!host) {
      this.client.options.log('warn', 'A host added over SSH could not be kept')
      session.close()
      return this.fail('ssh_failed')
    }
    const status = this.client.adopt(host, session)
    if (this.done) return
    this.done = true
    this.client.ended(this)
    this.say({ state: 'added', host: status })
  }

  private fail(reason: HostPairingFailure, detail?: string): void {
    if (this.done) return
    this.done = true
    this.aborting.abort()
    this.session?.close()
    this.client.ended(this)
    this.say({ state: 'failed', reason, ...(detail ? { detail } : {}) })
  }

  private say(state: HostPairingState): void {
    this.client.options.pairing(this.pairId, state)
  }
}

export class HostClient {
  readonly connect: Connect
  readonly timeoutMs: number
  readonly sshTimeoutMs: number
  readonly ssh: SshProgram
  readonly installScript: (version: string) => string
  readonly retryDelay: (failures: number) => number
  private readonly links = new Map<string, HostLink>()
  private readonly pairings = new Map<number, Pairing | SshAdding>()
  private stopped = false

  constructor(readonly options: HostClientOptions) {
    this.connect = options.connect ?? connectTransport
    this.timeoutMs = options.timeoutMs ?? PAIR_HOST_TIMEOUT_MS
    this.sshTimeoutMs = options.sshTimeoutMs ?? SSH_TIMEOUT_MS
    this.ssh = options.ssh ?? SYSTEM_SSH
    this.installScript = options.installScript ?? ((version) => installRun(version))
    this.retryDelay = options.retryDelay ?? retryDelay
  }

  /** Starts a connection to each known host. */
  start(): void {
    for (const host of this.options.hosts.list()) this.linkFor(host.id).start()
  }

  list(): HostStatus[] {
    return this.options.hosts.list().map((host) => this.status(host))
  }

  hello(model?: string): Hello {
    const hello: Hello = {
      type: 'hello',
      protocol: { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
      client: this.options.client,
      // Main runs the browser calls of the turns this computer sends.
      features: [BROWSER_FEATURE],
    }
    if (model === undefined) return hello
    const name = normalizeDeviceName(this.options.name()) ?? 'Kettu'
    return { ...hello, device: { name, model: isDeviceModel(model) ? model : '' } }
  }

  /** Pairs with the host a link names; its progress goes to `options.pairing` under `pairId`. */
  pair(pairId: number, payload: PairingPayload, model: string): void {
    if (this.stopped || this.pairings.has(pairId)) return
    const pairing = new Pairing(this, pairId)
    this.pairings.set(pairId, pairing)
    void pairing.run(payload, model)
  }

  /** Adds the machine at an SSH address; its progress goes to `options.pairing` under `pairId`. */
  addSsh(pairId: number, target: string, model: string): void {
    if (this.stopped || this.pairings.has(pairId)) return
    const adding = new SshAdding(this, pairId)
    this.pairings.set(pairId, adding)
    void adding.run(target, model)
  }

  closePairing(pairId: number): void {
    this.pairings.get(pairId)?.close()
  }

  /** Runs the setup script on a machine: its run, and what it printed; null once aborted. */
  async sshSetup(
    target: string,
    device: SshDevice | null,
    signal: AbortSignal,
  ): Promise<{ run: SshRun; report: SshSetupReport } | null> {
    const run = await runSsh(this.ssh, target, setupScript(device), {
      timeoutMs: SETUP_TIMEOUT_MS,
      signal,
    })
    return run && { run, report: parseSetupReport(run.stdout) }
  }

  /** Renames this computer on a host it is connected to; false when it is not. */
  rename(id: string, name: string): boolean {
    return this.links.get(id)?.rename(name) ?? false
  }

  /** A port on this computer that reaches a dev server on a host; null when none can. */
  forward(id: string, sessionId: string, forward: BrowserForward): Promise<number | null> {
    return this.links.get(id)?.forward(sessionId, forward) ?? Promise.resolve(null)
  }

  closeForwards(id: string, sessionId: string): void {
    this.links.get(id)?.closeForwards(sessionId)
  }

  setAddresses(id: string, addresses: DirectAddress[]): boolean {
    if (!this.options.hosts.update(id, { addresses })) return false
    this.options.changed()
    this.links.get(id)?.addressesChanged()
    return true
  }

  /** Forgets a host here: its connection ends, and the host is told nothing. */
  async remove(id: string): Promise<boolean> {
    this.links.get(id)?.close()
    this.links.delete(id)
    const removed = await this.options.hosts.remove(id)
    if (removed) this.options.changed()
    return removed
  }

  /** The computer woke, maybe on another network: the hosts not connected are tried now. */
  resume(): void {
    for (const link of this.links.values()) link.retry()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const pairing of [...this.pairings.values()]) pairing.close()
    for (const link of this.links.values()) link.close()
    this.links.clear()
    await this.options.hosts.flush()
  }

  /** A pairing's welcomed session becomes its host's connection. */
  adopt(host: KnownHost, session: HostSession): HostStatus {
    if (this.stopped) {
      session.close()
      return this.status(host)
    }
    const link = this.linkFor(host.id)
    link.adopt(session)
    this.options.changed()
    return this.status(this.options.hosts.get(host.id) ?? host)
  }

  ended(pairing: { pairId: number }): void {
    this.pairings.delete(pairing.pairId)
  }

  private linkFor(id: string): HostLink {
    let link = this.links.get(id)
    if (!link) {
      link = new HostLink(this, id)
      this.links.set(id, link)
    }
    return link
  }

  private status(host: KnownHost): HostStatus {
    const fallback: HostConnection = host.removed
      ? { state: 'stopped', reason: 'removed' }
      : { state: 'offline' }
    return { ...host, connection: this.links.get(host.id)?.connection ?? fallback }
  }
}
