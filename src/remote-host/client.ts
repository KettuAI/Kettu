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
  DISCOVER_PROLOGUE,
  deviceDiscovery,
  type DiscoveredHost,
  type DiscoveredHosts,
} from '@shared/remote/discovery'
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
  type RelayProblem,
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
  HOSTS_FEATURE,
  decodeRelayBytes,
  hostsPath,
  parseRelayHosts,
  parseRelayInfo,
  relayInfoPath,
  relayList,
  trustedRelay,
  type HostRelay,
} from '@shared/remote/relay'
import { dialRelay } from '@shared/remote/relay-device'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import {
  BROWSER_FEATURE,
  IMAGE_REFS_FEATURE,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RESUME_MS,
  RESUME_VERSION,
  parseAddresses,
  parseClosing,
  parseHostRenamed,
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
import { dial, RelayMissed, type Connect, type RelayRoute, type Via } from './dial'
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

/** The Kettu relay, as this computer reaches hosts through it. */
export interface RelayClient {
  /** The main relay's origin, tried for every host on the relay. */
  main: string
  /** This computer's access token now; null while it is signed in to no Kettu account. */
  token(): string | null
  openSocket(url: string): WebSocket
  /**
   * Reads JSON from a relay's URL, with the access token as a bearer token when given; rejects
   * when the relay cannot be reached. Without it the account's hosts cannot be listed.
   */
  fetchJson?(url: string, token?: string): Promise<{ status: number; body: unknown }>
}

/** A host of the account that may be paired with, and the relays that listed it. */
type AccountHost = DiscoveredHost & { relays: string[] }

type AccountHosts =
  { state: 'ok'; hosts: AccountHost[] } | Exclude<DiscoveredHosts, { state: 'ok' }>

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
  /** The relay; absent, hosts are reached directly alone. */
  relay?: RelayClient
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
  hostRenamed(name: string): void
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
    readonly via: Via,
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
    } else if (type === 'host.renamed') {
      const name = parseHostRenamed(value)
      if (name) this.handlers.hostRenamed(name)
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
  hostRenamed: () => {},
  ended: () => {},
}

/** The session's own messages, which main never hears. */
const OWN: ReadonlySet<unknown> = new Set(['addresses', 'renamed', 'host.renamed', 'terminal'])

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
  /** The relay that joined last, tried first next time. */
  private lastRelay: string | null = null

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

  /**
   * The Kettu relay may no longer be used, as after signing out or turning Kettu cloud off: a
   * session through it ends, as does a try that may be dialing it, and the host is tried again
   * without it.
   */
  leaveRelay(): void {
    if (this.closed) return
    if (this.session && 'relay' in this.session.via) return this.session.close()
    if (this.trying) {
      this.cancel()
      this.retry()
    }
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
    const relay = route ? null : this.client.relayRoute(host.relay, this.lastRelay)
    const result = await dial({
      addresses: route ? [{ host: SSH_LOOPBACK, port: route.port }] : host.addresses,
      connect: forward?.connect ?? this.client.connect,
      relay: typeof relay === 'function' ? relay : null,
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
      const problem = result.kind === 'unreachable' ? result.relay : undefined
      return this.failed(problem ?? (typeof relay === 'string' ? relay : undefined))
    }
    if ('relay' in result.via) this.lastRelay = result.via.relay
    const session = new HostSession(result.channel, result.via, options.log, options.keepalive)
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
        if (mine()) this.addresses(addresses, session.via)
      },
      renamed: (name) => {
        if (!mine()) return
        this.client.options.hosts.update(this.id, { deviceName: name })
        this.client.options.changed()
      },
      hostRenamed: (name) => {
        if (!mine()) return
        this.client.options.hosts.update(this.id, { name })
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
      addresses: ssh ? [] : merged(session.via, welcome.addresses, this.host?.addresses ?? []),
      // A host that no longer uses the relay says none, and is reached directly alone.
      relay: welcome.relay,
      lastOnlineAt: (now ?? Date.now)(),
      removed: false,
    })
    this.failures = 0
    this.set(online(session.via, welcome.terminal))
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
    const { type, allowed } = value as { type?: unknown; allowed?: unknown }
    // The owner allowed devices the terminal, or stopped allowing it.
    if (type === 'terminal' && this.connection.state === 'online') {
      return this.set(online(viaOf(this.connection), allowed === true))
    }
    if (OWN.has(type) || this.forwards.message(value)) return
    this.requests.received(value as Record<string, unknown>)
  }

  private toMain(message: unknown): void {
    if (this.port) this.port.send(message)
    else if (this.queued.length < MAX_QUEUED) this.queued.push(message)
  }

  private addresses(addresses: DirectAddress[], answered: Via): void {
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

  private failed(relay?: RelayProblem): void {
    this.failures++
    this.expireKept()
    // A host that needs an update keeps saying so, and waits the longest, between its tries.
    if (this.stoppedFor('update_host')) return this.schedule(MAX_RETRY_MS)
    this.set(relay ? { state: 'offline', relay } : { state: 'offline' })
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

function online(via: Via, terminal: boolean): HostConnection {
  return terminal ? { state: 'online', ...via, terminal } : { state: 'online', ...via }
}

function viaOf(connection: Extract<HostConnection, { state: 'online' }>): Via {
  return 'relay' in connection ? { relay: connection.relay } : { address: connection.address }
}

/**
 * The answering address first, then the host's own list, or what was kept while it sends none;
 * a session through the relay answered at no address.
 */
function merged(answered: Via, told: DirectAddress[], kept: DirectAddress[]): DirectAddress[] {
  const rest = told.length > 0 ? told : kept
  return 'address' in answered ? [answered.address, ...rest] : rest
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
    const relay = this.client.relayRoute(payload.relay, null)
    const result = await dial({
      addresses: payload.addresses,
      connect: this.client.connect,
      relay: typeof relay === 'function' ? relay : null,
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
    if (result.kind === 'unreachable') {
      const problem = result.relay ?? (typeof relay === 'string' ? relay : null)
      if (problem === 'wrong_account' || problem === 'signed_out') return this.fail(problem)
      return this.fail('unreachable')
    }
    this.say({ state: 'confirm' })
    const publicKey = Buffer.from(payload.hostKey).toString('base64')
    const session = new HostSession(result.channel, result.via, options.log, options.keepalive)
    this.session = session
    session.start(
      {
        welcomed: (welcome) => void this.added(session, publicKey, payload, welcome),
        addresses: () => {},
        renamed: () => {},
        hostRenamed: () => {},
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
    const status = await keepHost(this.client, session, welcome, publicKey, {
      addresses: payload.addresses,
      relay: payload.relay,
    })
    if (!status) return this.fail('void')
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

/**
 * Keeps a host that welcomed this computer after a pairing, as its link's connection; null when
 * it could not be kept. `paired`: the addresses and relay the pairing knew it by.
 */
async function keepHost(
  client: HostClient,
  session: HostSession,
  welcome: Welcome,
  publicKey: string,
  paired: { addresses: DirectAddress[]; relay: HostRelay | undefined },
): Promise<HostStatus | null> {
  // Its end until the link takes it is the link's to handle, as it reconnects.
  session.handOver(IGNORED)
  const relay = welcome.relay ?? paired.relay
  const host = await client.options.hosts.add({
    publicKey,
    name: welcome.host.name,
    platform: welcome.host.platform,
    version: welcome.host.version,
    addresses: merged(session.via, welcome.addresses, paired.addresses),
    deviceName: welcome.device.name,
    ...(relay ? { relay } : {}),
  })
  if (!host) {
    client.options.log('warn', 'A host that welcomed this computer could not be kept')
    session.close()
    return null
  }
  return client.adopt(host, session)
}

/** Why pairing with a host of the account ended, from the host's closing reason. */
function discoveryFailure(reason: ClosingReason | null): HostPairingFailure {
  switch (reason) {
    case 'rejected':
    case 'busy':
    case 'cooling_down':
    case 'update_client':
    case 'update_host':
      return reason
    case 'remote_off':
    case 'stopping':
    case 'unavailable':
      return 'host_offline'
    default:
      return 'void'
  }
}

/**
 * Pairing with a host of the same Kettu account that the relay lists: the IK handshake with the
 * discovery prologue to the listed key, the code both screens show, and then both the host's
 * owner and this computer's user have to say yes.
 */
class DiscoveryPairing {
  private readonly aborting = new AbortController()
  private session: HostSession | null = null
  private code: string | null = null
  private matched = false
  private done = false

  constructor(
    private readonly client: HostClient,
    readonly pairId: number,
  ) {}

  async run(relayId: string, ownKey: string | null, model: string): Promise<void> {
    const { options } = this.client
    this.say({ state: 'connecting' })
    // Listed again, so the key and relays are the relay's now and not a page's.
    const listed = await this.client.accountHosts(ownKey)
    if (this.done) return
    if (listed.state !== 'ok') {
      return this.fail(listed.state === 'signed_out' ? 'signed_out' : 'unreachable')
    }
    const found = listed.hosts.find((host) => host.relayId === relayId)
    if (!found) return this.fail('host_offline')
    const hostRelay: HostRelay = { id: relayId, urls: found.relays }
    const relay = this.client.relayRoute(hostRelay, null)
    if (typeof relay !== 'function') {
      return this.fail(relay === 'signed_out' ? 'signed_out' : 'unreachable')
    }
    const result = await dial({
      addresses: [],
      connect: this.client.connect,
      relay,
      start: (transport) =>
        startDeviceChannel({
          transport,
          hostKey: new Uint8Array(Buffer.from(found.publicKey, 'base64')),
          key: options.key,
          prologue: DISCOVER_PROLOGUE,
          hello: null,
        }),
      timeoutMs: this.client.timeoutMs,
      signal: this.aborting.signal,
    })
    if (result.kind === 'aborted') return
    if (this.done) {
      if (result.kind === 'open') result.channel.close()
      return
    }
    // A host that drops the handshake no longer lets devices find it, or is not signed in.
    if (result.kind === 'dropped') return this.fail('host_offline')
    if (result.kind === 'unreachable') {
      const problem = result.relay
      if (problem === 'wrong_account' || problem === 'signed_out' || problem === 'host_offline') {
        return this.fail(problem)
      }
      return this.fail('unreachable')
    }
    const exchange = await deviceDiscovery(result.channel)
    if (this.done) return result.channel.close()
    if (!('code' in exchange)) return this.fail(discoveryFailure(exchange.closing))
    this.code = exchange.code
    const session = new HostSession(exchange.channel, result.via, options.log, options.keepalive)
    this.session = session
    session.start(
      {
        welcomed: (welcome) => void this.added(session, found, welcome),
        addresses: () => {},
        renamed: () => {},
        hostRenamed: () => {},
        ended: ({ reason }) => this.fail(discoveryFailure(reason)),
      },
      null,
    )
    session.send(this.client.hello(model))
    this.say({ state: 'compare', code: exchange.code, matched: false })
  }

  /** This computer's user saw the same code on both screens, or not, which ends the pairing. */
  match(match: boolean): void {
    if (this.done) return
    if (!match) return this.fail('void')
    if (!this.session || this.code === null || this.matched) return
    this.matched = true
    this.session.send({ type: 'pair-confirm' })
    this.say({ state: 'compare', code: this.code, matched: true })
  }

  /** Add host closed: a pairing the host has not added ends, and the host's request with it. */
  close(): void {
    if (this.done) return
    this.done = true
    this.aborting.abort()
    if (!this.session?.welcome) this.session?.close()
    this.client.ended(this)
  }

  private async added(session: HostSession, found: AccountHost, welcome: Welcome): Promise<void> {
    const status = await keepHost(this.client, session, welcome, found.publicKey, {
      addresses: [],
      relay: { id: found.relayId, urls: found.relays },
    })
    if (!status) return this.fail('void')
    if (this.done) return
    this.done = true
    this.client.ended(this)
    this.say({ state: 'added', host: status })
  }

  private fail(reason: HostPairingFailure): void {
    if (this.done) return
    this.done = true
    this.aborting.abort()
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
    } else {
      // The login's run already recorded this computer, or found the daemon down.
      this.say({ state: 'ssh', step: 'adding' })
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
    const session = new HostSession(result.channel, result.via, options.log, options.keepalive)
    this.session = session
    session.start(
      {
        welcomed: (welcome) => void this.added(session, target, info, welcome),
        addresses: () => {},
        renamed: () => {},
        hostRenamed: () => {},
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
    // The login reaches one daemon, so a host kept at this address is it before it reset its key.
    for (const kept of this.client.options.hosts.list()) {
      if (kept.id !== host.id && kept.ssh?.target === target) await this.client.remove(kept.id)
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
  private readonly pairings = new Map<number, Pairing | SshAdding | DiscoveryPairing>()
  private stopped = false

  constructor(readonly options: HostClientOptions) {
    this.connect = options.connect ?? connectTransport
    this.timeoutMs = options.timeoutMs ?? PAIR_HOST_TIMEOUT_MS
    this.sshTimeoutMs = options.sshTimeoutMs ?? SSH_TIMEOUT_MS
    this.ssh = options.ssh ?? SYSTEM_SSH
    this.installScript = options.installScript ?? ((version) => installRun(version))
    this.retryDelay = options.retryDelay ?? retryDelay
  }

  /**
   * How to reach a host through the relay: a route over its relays, the one that joined last
   * first; why there is none, as while this computer is signed in to no account; or null for a
   * host not on the relay.
   */
  relayRoute(relay: HostRelay | undefined, last: string | null): RelayRoute | RelayProblem | null {
    const client = this.options.relay
    if (!relay || !client) return null
    const token = client.token()
    if (!token) return 'signed_out'
    // The account's token goes only to the project's relays, whatever a code or a host names.
    const relays = [...new Set([...relay.urls, client.main])].filter((url) =>
      trustedRelay(url, client.main),
    )
    if (last && relays.includes(last)) relays.sort((a, b) => (a === last ? -1 : b === last ? 1 : 0))
    return async (signal) => {
      const result = await dialRelay({
        relays,
        id: relay.id,
        token,
        openSocket: client.openSocket,
        timeoutMs: this.timeoutMs,
        signal,
      })
      switch (result.kind) {
        case 'joined':
          return { transport: await webSocketTransport(result.socket, true), relay: result.relay }
        case 'offline':
          throw new RelayMissed('host_offline')
        case 'forbidden':
          throw new RelayMissed('wrong_account')
        case 'aborted':
          throw new Error('Dialing is over')
        default:
          throw new RelayMissed('unreachable')
      }
    }
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
      features: [BROWSER_FEATURE, IMAGE_REFS_FEATURE],
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

  /**
   * The hosts of this computer's Kettu account that every relay it knows lists, merged by id;
   * those it is paired with, and this computer's own host by `ownKey`, left out.
   */
  async accountHosts(ownKey: string | null): Promise<AccountHosts> {
    const client = this.options.relay
    const fetchJson = client?.fetchJson
    if (!client || !fetchJson) return { state: 'unavailable' }
    const token = client.token()
    if (!token) return { state: 'signed_out' }
    let regions: Parameters<typeof relayList>[1] = []
    try {
      const { status, body } = await fetchJson(`${client.main}${relayInfoPath()}`)
      const info = status === 200 ? parseRelayInfo(body) : null
      if (info && !info.features.includes(HOSTS_FEATURE)) return { state: 'unavailable' }
      if (info) regions = info.regions
    } catch {
      // The main relay alone is asked.
    }
    const relays = relayList(client.main, regions).map((region) => region.url)
    const answers = await Promise.all(
      relays.map(async (url) => {
        try {
          const { status, body } = await fetchJson(`${url}${hostsPath()}`, token)
          if (status === 401) return 'unauthorized' as const
          return status === 200 ? parseRelayHosts(body) : null
        } catch {
          return null
        }
      }),
    )
    if (!answers.some(Array.isArray)) {
      return answers.includes('unauthorized') ? { state: 'signed_out' } : { state: 'unavailable' }
    }
    const paired = new Set(
      this.options.hosts
        .list()
        .filter((host) => !host.removed)
        .map((host) => host.publicKey),
    )
    const byId = new Map<string, AccountHost>()
    answers.forEach((answer, i) => {
      if (!Array.isArray(answer)) return
      for (const listed of answer) {
        const kept = byId.get(listed.id)
        if (kept) {
          if (!kept.relays.includes(relays[i]!)) kept.relays.push(relays[i]!)
          continue
        }
        const publicKey = Buffer.from(decodeRelayBytes(listed.key)!).toString('base64')
        if (publicKey === ownKey || paired.has(publicKey)) continue
        byId.set(listed.id, {
          relayId: listed.id,
          publicKey,
          name: listed.name,
          platform: listed.platform as DiscoveredHost['platform'],
          relays: [relays[i]!],
        })
      }
    })
    return { state: 'ok', hosts: [...byId.values()] }
  }

  /** The hosts of the account this computer may pair with. */
  async discover(ownKey: string | null): Promise<DiscoveredHosts> {
    const listed = await this.accountHosts(ownKey)
    if (listed.state !== 'ok') return listed
    return {
      state: 'ok',
      hosts: listed.hosts.map(({ relayId, publicKey, name, platform }) => ({
        relayId,
        publicKey,
        name,
        platform,
      })),
    }
  }

  /** Pairs with a host `discover` listed; its progress goes to `options.pairing` under `pairId`. */
  pairDiscovered(pairId: number, relayId: string, ownKey: string | null, model: string): void {
    if (this.stopped || this.pairings.has(pairId)) return
    const pairing = new DiscoveryPairing(this, pairId)
    this.pairings.set(pairId, pairing)
    void pairing.run(relayId, ownKey, model)
  }

  /** Whether this computer's user saw the same code as the host's; false ends the pairing. */
  matchPairing(pairId: number, match: boolean): void {
    const pairing = this.pairings.get(pairId)
    if (pairing instanceof DiscoveryPairing) pairing.match(match)
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

  /** The relay's token is gone: no host stays reached through the relay. */
  leaveRelay(): void {
    for (const link of this.links.values()) link.leaveRelay()
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
