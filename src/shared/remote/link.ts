// A device's connection to a host, which the web client and the other clients share: the encrypted
// channel over what the caller dials (a WebSocket to the host's direct port, or the relay), then
// hello and welcome, then the host protocol as a window's port carries it, with binary values going
// as byte streams both ways. It reconnects with backoff while the client is visible, and stops for
// good once the host says this device may not connect.
// A host of version 2 keeps the session through a drop for a while: the link acknowledges what it
// receives, resumes with the welcome's token, and sends again the requests the host did not read.
// Given several routes, as a relay's regions, it races them to a finished handshake, says hello on
// the winner alone, and later moves the session to a route clearly faster than the one it is on.

import type { PortError, PortErrorCode } from '../port-rpc'
import { Acknowledger } from './acks'
import { BYTES_PER_FRAME, type ChannelMessage } from './channel'
import { HandshakeDropped, startDeviceChannel, type DeviceChannel } from './device-channel'
import { isHostAdminEvent, type HostAdminEvent } from './host-admin'
import {
  DEVICE_KEEPALIVE,
  Keepalive,
  KEEPALIVE_VERSION,
  keepaliveMessage,
  type KeepaliveTimings,
  type Ping,
  type Pong,
} from './keepalive'
import type { KeyPair } from './noise'
import { CompareTimer, PathTimes, PROBE_TIMEOUT_MS, rankPaths, shouldMove } from './paths'
import { bytesOf, isBinary } from './places'
import {
  IMAGE_REFS_FEATURE,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RESUME_MS,
  RESUME_VERSION,
  TOOL_DIGESTS_FEATURE,
  TOOL_OUTPUT_APPEND_FEATURE,
  parseClosing,
  parseWelcome,
  type ClosingReason,
  type Hello,
  type Pace,
  type Welcome,
} from './protocol'
import { AsideConnection } from './standby'
import type { Transport } from './transport'
import { webSocketTransport } from './websocket-transport'

/** What a transport may hold before an upload waits for it to drain, as the host's downloads do. */
const HIGH_WATER = 256 * 1024

/** How long a known host has from the handshake to its welcome. */
const WELCOME_TIMEOUT_MS = 15_000

/** How long a connection kept aside has to answer its promotion with a welcome. */
const PROMOTE_TIMEOUT_MS = 5_000

/** The longest wait between tries. */
const MAX_RETRY_MS = 30_000

/** Deeper than any request or result nests, so nothing below it is looked at. */
const MAX_DEPTH = 64

/**
 * Handshakes the host dropped in a row before this browser counts as unknown there, as after it
 * was removed while away; one alone can be a host busy with other handshakes.
 */
const DROPS_UNKNOWN = 2

/** The path the host takes the channel's WebSocket on. */
export const CHANNEL_PATH = '/channel'

/** `other_account`: the host is signed in to another Kettu account than the one the hello named. */
export type LinkStop = 'removed' | 'update_client' | 'update_host' | 'other_account'

/** Whether a host's closing reason stops the link for good. */
function stops(reason: ClosingReason | null): reason is LinkStop {
  return (
    reason === 'removed' ||
    reason === 'update_client' ||
    reason === 'update_host' ||
    reason === 'other_account'
  )
}

export type LinkState =
  | { kind: 'connecting' }
  | { kind: 'connected'; welcome: Welcome }
  /**
   * Connected before; `reason` is what the host said as it ended, if it said anything. `kept`
   * while the host keeps the session for the link to resume, so nothing in flight is lost yet.
   */
  | { kind: 'reconnecting'; reason: ClosingReason | null; kept: boolean }
  | { kind: 'stopped'; reason: LinkStop }

/** A request's failure as the renderer reads a port's: a plain object with the code. */
export interface LinkError extends PortError {
  name: 'PortRequestError'
}

function linkError(code: PortErrorCode, message: string, data?: unknown): LinkError {
  return { name: 'PortRequestError', code, message, ...(data === undefined ? {} : { data }) }
}

/** The DOMException an aborted fetch rejects with, so callers tell it apart as they do there. */
function aborted(): DOMException {
  return new DOMException('The request was aborted', 'AbortError')
}

/** The WebSocket address of the channel on this page's own origin. */
export function channelUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${CHANNEL_PATH}`
}

/** About 1 s after the first failure, doubling to 30 s, give or take a fifth. */
export function retryDelay(failures: number): number {
  const base = Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.max(0, failures - 1))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

/** Opens a transport to the host; tests give one of their own. */
export type Dial = () => Promise<Transport>

/** One way to the host: a key that names it for ranking, whether a relay carries it, its dial. */
export interface LinkRoute {
  key: string
  relay: boolean
  dial: Dial
}

export function dialWebSocket(url: string): Dial {
  return () => webSocketTransport(new WebSocket(url))
}

interface Pending {
  resolve(value: unknown): void
  // An AbortError once its caller gave it up.
  reject(error: LinkError | DOMException): void
}

/** A request not answered yet; its id once its message went, on the session it went on. */
interface Outgoing {
  method: string
  params: unknown
  pending: Pending
  id: number | null
  /** Its caller gave it up: what its answer brings is cancelled, not read. */
  aborted: boolean
  /** The byte streams its answer brings, while they come. */
  streams: number[]
}

interface Download {
  chunks: Uint8Array[]
  size: number
  resolve(bytes: ArrayBuffer): void
  reject(error: LinkError): void
}

/** One welcomed connection. */
interface Session {
  channel: DeviceChannel
  transport: Transport
  route: LinkRoute
  welcome: Welcome
  closing: ClosingReason | null
  /** From version 3, notices a host that stopped answering on an open connection. */
  keepalive: Keepalive | null
  /** When the last ping went, until its pong times the route. */
  pingedAt: number | null
}

/** A connection kept aside of the session, and how it reaches the host. */
type Aside = AsideConnection<{ route: LinkRoute; transport: Transport }>

/** A connection whose handshake is done, waiting for the host's first word. */
export interface Opened {
  channel: DeviceChannel
  transport: Transport
}

/** What came after the welcome before its taker listened, JSON and stream bytes in order. */
export type Later = ChannelMessage

/**
 * Starts the device's side of a connection and resolves once the host answered the handshake;
 * the hello goes with it. Pairing passes the code's secret.
 */
export async function openChannel(
  dial: Dial,
  options: { hostKey: Uint8Array; key: KeyPair; psk?: Uint8Array; hello: Hello },
): Promise<Opened> {
  const transport = await dial()
  const { opened } = await startDeviceChannel({ transport, ...options })
  return { channel: await opened, transport }
}

/**
 * The host's answer to the hello: the welcome, or why it closed the connection. Ends the
 * connection itself when the welcome does not come within `timeoutMs`; null waits as long as the
 * owner takes to decide on a pairing.
 */
export function awaitWelcome(opened: Opened, timeoutMs: number | null): Promise<Answer> {
  return new Promise((resolve) => {
    let closing: ClosingReason | null = null
    let done = false
    const later: Later[] = []
    const timer = timeoutMs === null ? null : setTimeout(() => opened.channel.close(), timeoutMs)
    const settle = (value: Answer): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    opened.channel.onMessage((value) => {
      // What follows the welcome before its taker listens, for the taker.
      if (done) return void later.push({ kind: 'json', value })
      const welcome = parseWelcome(value)
      if (welcome) return settle({ welcome, later })
      closing = parseClosing(value)?.reason ?? closing
    })
    opened.channel.onBytes((stream, data) => {
      if (done) later.push({ kind: 'bytes', stream, data: data.slice() })
    })
    void opened.channel.closed.then(() => settle({ closing }))
  })
}

export type Answer = { welcome: Welcome; later: Later[] } | { closing: ClosingReason | null }

/** `account`: the Kettu account the device is signed in to, which the host checks against its own. */
export function hello(
  client: Hello['client'],
  device?: Hello['device'],
  account?: string | null,
): Hello {
  return {
    type: 'hello',
    protocol: { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
    client,
    ...(device ? { device } : {}),
    // The web client loads stored images by hash, expands digested tool calls on demand, and applies incremental tool outputs.
    features: [IMAGE_REFS_FEATURE, TOOL_DIGESTS_FEATURE, TOOL_OUTPUT_APPEND_FEATURE],
    ...(account ? { account } : {}),
  }
}

export interface HostLinkOptions {
  dial: Dial
  /** The routes to race and move between, read at each try; `dial` alone, without a relay, when absent. */
  routes?: () => LinkRoute[]
  hostKey: Uint8Array
  key: KeyPair
  hello: Hello
  /** A connection pairing left open and welcomed, which the link takes as its first. */
  adopt?: { opened: Opened; welcome: Welcome; later: Later[]; route?: LinkRoute }
  /** Whether the page is in front; a link in the back waits to reconnect until it is. */
  visible?: () => boolean
  retryDelay?: (failures: number) => number
  /** When a quiet host is pinged and given up, DEVICE_KEEPALIVE unless a test shortens it. */
  keepalive?: KeepaliveTimings
}

/** The host protocol over the channel, kept connected. */
export class HostLink {
  private session: Session | null = null
  private current: LinkState = { kind: 'connecting' }
  private connecting = false
  private stopped = false
  private failures = 0
  private drops = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  // Rising in the order the requests go, so the host's last one read says which went before it.
  private nextId = 1
  // Odd and rising, as the host takes a device's stream ids.
  private nextUpload = 1
  /** Every request not answered yet, in the order it was made. */
  private readonly outgoing = new Set<Outgoing>()
  private readonly inFlight = new Map<number, Outgoing>()
  private readonly downloads = new Map<number, Download>()
  /** The token of the last welcome, while the host keeps the session for the link to resume. */
  private resumeToken: string | null = null
  /** What the host sent on the session, which a host of version 2 hears of. */
  private readonly acks = new Acknowledger((ack) => this.send({ ...ack }))
  /** Gives up a session the host keeps once it would no longer, while the link cannot reach it. */
  private keptTimer: ReturnType<typeof setTimeout> | null = null
  private keptUntil = 0
  private paceMs = 0
  private readonly hostListeners = new Set<(event: unknown) => void>()
  private readonly terminalListeners = new Set<(event: unknown) => void>()
  private readonly deviceListeners = new Set<(event: unknown) => void>()
  private readonly adminListeners = new Set<(event: HostAdminEvent) => void>()
  private readonly stateListeners = new Set<(state: LinkState) => void>()
  private readonly messageListeners = new Set<(message: Record<string, unknown>) => void>()
  /** Each route's round trips and failures, which moving to the fastest goes by. */
  private readonly times = new PathTimes()
  /** Moving the session to another route, or taking it over on a connection kept aside. */
  private taking = false
  private comparing: Promise<boolean> | null = null
  private readonly compares = new CompareTimer(() => void this.compare())
  /** The connection a move left, until its move is welcomed or it takes the session back. */
  private aside: Aside | null = null

  constructor(private readonly options: HostLinkOptions) {}

  private routes(): LinkRoute[] {
    return this.options.routes?.() ?? [{ key: 'host', relay: false, dial: this.options.dial }]
  }

  get state(): LinkState {
    return this.current
  }

  start(): void {
    const adopted = this.options.adopt
    if (adopted) {
      const route = adopted.route ?? this.routes()[0]!
      this.welcomed(adopted.opened, adopted.welcome, adopted.later, false, route)
    } else void this.connect()
  }

  /**
   * Tries at once, as when the page comes to the front or the network changed; connected, it
   * pings the host, so a connection that went is noticed soon, and compares the routes again.
   */
  wake(): void {
    if (this.stopped || this.connecting || this.taking) return
    const session = this.session
    if (session) {
      session.keepalive?.pingNow()
      return this.compareSoon(0)
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.compares.stop()
    this.acks.pause()
    if (this.keptTimer) clearTimeout(this.keptTimer)
    this.session?.channel.close()
    this.aside?.close()
    this.aside = null
  }

  /** How often the host may send patches, in milliseconds; 0 as they come. */
  setPace(ms: number): void {
    if (ms === this.paceMs) return
    this.paceMs = ms
    const session = this.session
    if (session && resumable(session)) this.send({ type: 'pace', ms } satisfies Pace)
  }

  onState(listener: (state: LinkState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.current)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  /** The agent host's events. */
  onHostEvent(listener: (event: unknown) => void): () => void {
    this.hostListeners.add(listener)
    return () => {
      this.hostListeners.delete(listener)
    }
  }

  /** The host's own events for its owner, such as its settings changing; kept from the others. */
  onAdminEvent(listener: (event: HostAdminEvent) => void): () => void {
    this.adminListeners.add(listener)
    return () => {
      this.adminListeners.delete(listener)
    }
  }

  /** The terminal host's events, which share the channel. */
  /** The device host's events, frames with their data in base64 as the host sends them. */
  onDeviceEvent(listener: (event: unknown) => void): () => void {
    this.deviceListeners.add(listener)
    return () => {
      this.deviceListeners.delete(listener)
    }
  }

  onTerminalEvent(listener: (event: unknown) => void): () => void {
    this.terminalListeners.add(listener)
    return () => {
      this.terminalListeners.delete(listener)
    }
  }

  /** The channel's own messages around the host protocol, such as `renamed` and `terminal`. */
  onMessage(listener: (message: Record<string, unknown>) => void): () => void {
    this.messageListeners.add(listener)
    return () => {
      this.messageListeners.delete(listener)
    }
  }

  /** Sends one of the channel's own messages, such as `rename`; dropped while disconnected. */
  send(message: Record<string, unknown>): void {
    void this.session?.channel.send(message).catch(() => {})
  }

  /**
   * A request to the host. Once `signal` aborts, it fails at once: a request not sent yet is not
   * sent, and the byte streams of its answer, whether coming or still to come, are cancelled.
   */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped) {
      return Promise.reject(
        linkError('host_restarted', 'This browser no longer connects to the host'),
      )
    }
    if (signal?.aborted) return Promise.reject(aborted())
    return new Promise((resolve, reject) => {
      const outgoing: Outgoing = {
        method,
        params,
        pending: { resolve, reject },
        id: null,
        aborted: false,
        streams: [],
      }
      this.outgoing.add(outgoing)
      if (this.session) void this.post(this.session, outgoing)
      signal?.addEventListener('abort', () => this.abort(outgoing), { once: true })
    })
  }

  private abort(outgoing: Outgoing): void {
    if (outgoing.aborted) return
    outgoing.aborted = true
    const { reject } = outgoing.pending
    outgoing.pending = { resolve: () => {}, reject: () => {} }
    reject(aborted())
    // Not sent, or sent and not answered yet: nothing more goes, and the answer finds it aborted.
    if (outgoing.id === null) this.settle(outgoing)
    for (const stream of outgoing.streams) this.cancelDownload(stream)
  }

  /** Gives up a download the page no longer wants, so the host stops sending it. */
  private cancelDownload(stream: number): void {
    const download = this.downloads.get(stream)
    if (!download) return
    this.downloads.delete(stream)
    download.reject(linkError('internal', 'The download was cancelled'))
    this.send({ type: 'stream.cancel', stream })
  }

  private setState(state: LinkState): void {
    this.current = state
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch (error) {
        console.error('A connection listener failed', error)
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.session || this.connecting || this.taking) return
    this.connecting = true
    let opened: Opened
    let route: LinkRoute
    const resume = this.resumeToken
      ? { token: this.resumeToken, received: this.acks.received }
      : null
    try {
      ;({ opened, route } = await this.race(this.routes()))
      // Said on the winner alone, so a losing route never spends the token.
      void opened.channel
        .send(resume ? { ...this.options.hello, resume } : this.options.hello)
        .catch(() => opened.channel.close())
    } catch (error) {
      this.connecting = false
      // The host took the WebSocket and dropped the handshake: it may not know this key now.
      if (error instanceof HandshakeDropped && ++this.drops >= DROPS_UNKNOWN) {
        return this.end('removed')
      }
      this.expireKept()
      return this.retry()
    }
    this.drops = 0
    this.times.sample(route.key, opened.channel.handshakeMs)
    const answer = await awaitWelcome(opened, WELCOME_TIMEOUT_MS)
    this.connecting = false
    if ('welcome' in answer) {
      return this.welcomed(opened, answer.welcome, answer.later, resume !== null, route)
    }
    const reason = answer.closing
    if (stops(reason)) {
      return this.end(reason)
    }
    this.expireKept()
    this.retry(reason)
  }

  private retry(reason: ClosingReason | null = null): void {
    if (this.stopped) return
    if (this.current.kind === 'connected' || this.current.kind === 'reconnecting') {
      this.setState({ kind: 'reconnecting', reason, kept: this.resumeToken !== null })
    }
    if (this.options.visible && !this.options.visible()) return
    const delay = (this.options.retryDelay ?? retryDelay)(++this.failures)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, delay)
  }

  private end(reason: LinkStop): void {
    this.stopped = true
    if (this.keptTimer) clearTimeout(this.keptTimer)
    this.resumeToken = null
    const ended = linkError('host_restarted', 'This browser no longer connects to the host')
    this.lose(ended)
    for (const outgoing of [...this.outgoing]) this.settle(outgoing).reject(ended)
    this.setState({ kind: 'stopped', reason })
  }

  /** `askedResume`: the hello named the last session, which the host may have kept. */
  private welcomed(
    opened: Opened,
    welcome: Welcome,
    later: Later[],
    askedResume: boolean,
    route: LinkRoute,
  ): void {
    const session: Session = {
      ...opened,
      route,
      welcome,
      closing: null,
      keepalive: null,
      pingedAt: null,
    }
    if (welcome.protocol >= KEEPALIVE_VERSION) {
      session.keepalive = new Keepalive({
        ...(this.options.keepalive ?? DEVICE_KEEPALIVE),
        ping: () => {
          session.pingedAt = Date.now()
          void session.channel.send({ type: 'ping' } satisfies Ping).catch(() => {})
        },
        // Ended now as if the network went, so the link reconnects and resumes the session: a
        // stopped host never finishes the close.
        silent: () => {
          session.channel.close()
          this.ended(session)
        },
      })
    }
    const resumed = askedResume && welcome.resumed !== undefined
    if (this.keptTimer) clearTimeout(this.keptTimer)
    this.keptTimer = null
    // A move's welcome: the connection it left goes, the host having dropped it too.
    this.aside?.close()
    this.aside = null
    if (!resumed) {
      // The host has none of the last session, so what was in flight on it is lost.
      this.lose(linkError('host_restarted', 'The connection to the host ended'))
      this.nextId = 1
      if (this.current.kind === 'reconnecting' && this.current.kept) {
        this.setState({ ...this.current, kept: false })
      }
    }
    this.resumeToken = welcome.resume ?? null
    this.session = session
    this.failures = 0
    for (const message of later.splice(0)) {
      if (message.kind === 'json') this.receive(session, message.value)
      else this.receiveBytes(session, message.stream, message.data)
    }
    opened.channel.onMessage((value) => this.receive(session, value))
    opened.channel.onBytes((stream, data) => this.receiveBytes(session, stream, data))
    void opened.channel.closed.then(() => this.ended(session))
    if (resumable(session) && this.paceMs !== 0) {
      this.send({ type: 'pace', ms: this.paceMs } satisfies Pace)
    }
    this.setState({ kind: 'connected', welcome })
    // The host read the requests up to the one it names; the rest go again, as new ones.
    const read = resumed ? welcome.resumed!.request : 0
    for (const outgoing of [...this.outgoing]) {
      // Given up while the host was away: its answer is not wanted.
      if (outgoing.aborted) {
        this.settle(outgoing)
        continue
      }
      if (outgoing.id !== null && outgoing.id <= read) continue
      if (outgoing.id !== null) this.inFlight.delete(outgoing.id)
      outgoing.id = null
      void this.post(session, outgoing)
    }
  }

  private ended(session: Session): void {
    session.keepalive?.stop()
    if (this.session !== session) return
    this.session = null
    this.acks.pause()
    const reason = session.closing
    if (stops(reason)) {
      return this.end(reason)
    }
    if (reason === null) this.times.failed(session.route.key)
    this.dropped(reason, resumable(session))
  }

  /** The session's connection went: it is resumed when the host keeps it, or begun anew. */
  private dropped(reason: ClosingReason | null, resumes: boolean): void {
    // A host that says why ends the session; one that just went keeps it for a while.
    if (reason !== null || !resumes) this.resumeToken = null
    if (this.resumeToken === null) {
      this.lose(linkError('host_restarted', 'The connection to the host ended'))
    } else if (!this.keptTimer) {
      this.keptUntil = Date.now() + RESUME_MS
      this.keptTimer = setTimeout(() => {
        this.keptTimer = null
        this.expireKept()
      }, RESUME_MS)
    }
    this.retry(reason)
  }

  /** Compares the routes after `delay`, once, however often it is asked meanwhile, the soonest. */
  private compareSoon(delay: number): void {
    if (!this.stopped) this.compares.soon(delay)
  }

  /** One comparison at a time: one asked while another runs gets false. */
  private compare(failing = false): Promise<boolean> {
    if (this.comparing) return Promise.resolve(false)
    const comparing = this.compareNow(failing).finally(() => {
      this.comparing = null
    })
    this.comparing = comparing
    return comparing
  }

  /**
   * Opens the other routes to a finished handshake each, for their round trips, and moves the
   * session to the best when it is clearly faster than the one it is on.
   */
  private async compareNow(failing: boolean): Promise<boolean> {
    const session = this.session
    if (this.stopped || this.connecting || this.taking || !session) return false
    if (!resumable(session) || this.resumeToken === null) return false
    const others = this.routes().filter((route) => route.key !== session.route.key)
    if (others.length === 0) return false
    this.compares.started()
    const probed = await Promise.all(others.map((route) => this.probe(route)))
    const opened = probed.flatMap(({ opened, ...route }) => (opened ? [{ ...route, opened }] : []))
    for (const path of probed) {
      if (path.opened) this.times.sample(path.key, path.opened.channel.handshakeMs)
      else this.times.failed(path.key)
    }
    const current = { key: session.route.key, relay: session.route.relay }
    const ranked: { key: string; relay: boolean }[] = rankPaths([current, ...opened], this.times)
    // Off a failing route, the best of the others will do.
    const best = opened.find(
      (path) => path === (failing ? ranked.find((r) => r !== current) : ranked[0]),
    )
    const moving = this.session === session && !this.taking && !this.stopped
    const target = moving && best && shouldMove(current, best, this.times, failing) ? best : null
    for (const path of opened) if (path !== target) path.opened.channel.close()
    if (!target) return false
    await this.move(target.opened, target)
    return true
  }

  /**
   * The relay region the route `key` goes through drains: a session on it moves to another route,
   * or leaves it and resumes elsewhere when none opens; any other connection through it leaves.
   */
  drained(key: string, leave: () => void): void {
    const session = this.session
    if (!session || session.route.key !== key || this.taking) return leave()
    this.times.failed(key)
    void (async () => {
      // A comparison under way may move the session already; a failing one follows it.
      while (this.comparing) await this.comparing
      const moved = this.session === session && (await this.compare(true))
      if (!moved && this.session === session) leave()
    })()
  }

  /** A route's connection past its handshake, without a hello, or null within the probe's time. */
  private async probe(route: LinkRoute): Promise<LinkRoute & { opened: Opened | null }> {
    let transport: Transport | null = null
    let late = false
    const timer = setTimeout(() => {
      late = true
      transport?.close()
    }, PROBE_TIMEOUT_MS)
    try {
      transport = await route.dial()
      if (late) throw new Error('Too late')
      const { opened } = await startDeviceChannel({
        transport,
        hostKey: this.options.hostKey,
        key: this.options.key,
        hello: null,
      })
      return { ...route, opened: { channel: await opened, transport } }
    } catch {
      transport?.close()
      return { ...route, opened: null }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Every route at once; the first to finish its handshake wins and the others are closed. */
  private race(routes: LinkRoute[]): Promise<{ opened: Opened; route: LinkRoute }> {
    return new Promise((resolve, reject) => {
      let failed = 0
      let dropped = false
      let done = false
      for (const route of routes) {
        void (async () => {
          let transport: Transport | null = null
          try {
            transport = await route.dial()
            if (done) return transport.close()
            const { opened } = await startDeviceChannel({
              transport,
              hostKey: this.options.hostKey,
              key: this.options.key,
              hello: null,
            })
            const channel = await opened
            if (done) return channel.close()
            done = true
            resolve({ opened: { channel, transport }, route })
          } catch (error) {
            transport?.close()
            if (error instanceof HandshakeDropped) dropped = true
            if (++failed === routes.length && !done) {
              done = true
              reject(dropped ? new HandshakeDropped() : error)
            }
          }
        })()
      }
      if (routes.length === 0) reject(new Error('No route to the host'))
    })
  }

  /**
   * Moves the session to a connection past its handshake. From the hello on, the old connection
   * carries nothing of the session: the host sends again on the new one what came after what was
   * counted here, and says which requests it read. A move that fails takes the session back on
   * the old connection.
   */
  private async move(opened: Opened, route: LinkRoute): Promise<void> {
    const from = this.session
    const token = this.resumeToken
    if (!from || token === null) return opened.channel.close()
    this.taking = true
    from.keepalive?.stop()
    this.session = null
    this.acks.pause()
    this.aside = new AsideConnection(
      from.channel,
      { route: from.route, transport: from.transport },
      { ...(this.options.keepalive ? { timings: this.options.keepalive } : {}) },
    )
    void opened.channel
      .send({ ...this.options.hello, resume: { token, received: this.acks.received } })
      .catch(() => opened.channel.close())
    const answer = await awaitWelcome(opened, WELCOME_TIMEOUT_MS)
    this.taking = false
    if (this.stopped) return opened.channel.close()
    if ('welcome' in answer) return this.welcomed(opened, answer.welcome, answer.later, true, route)
    this.times.failed(route.key)
    this.fallBack(answer.closing)
  }

  /** A try to take the session over failed: the connection a move left takes it back, if open. */
  private fallBack(reason: ClosingReason | null): void {
    const aside = this.aside
    this.aside = null
    if (reason === null && aside?.open && this.resumeToken !== null) return void this.promote(aside)
    aside?.close()
    if (stops(reason)) {
      return this.end(reason)
    }
    this.dropped(reason, true)
  }

  /** Takes the session over on a connection kept aside; nothing shows a drop meanwhile. */
  private async promote(aside: Aside): Promise<void> {
    this.taking = true
    const opened: Opened = {
      channel: aside.promote(this.acks.received),
      transport: aside.via.transport,
    }
    const answer = await awaitWelcome(opened, PROMOTE_TIMEOUT_MS)
    this.taking = false
    if (this.stopped) return opened.channel.close()
    if ('welcome' in answer) {
      return this.welcomed(opened, answer.welcome, answer.later, true, aside.via.route)
    }
    this.fallBack(answer.closing)
  }

  /**
   * Gives up the session the host kept once it would keep it no longer, unless a try that names
   * it is under way, whose welcome says.
   */
  private expireKept(): void {
    if (this.resumeToken === null || this.session || this.connecting) return
    if (Date.now() < this.keptUntil) return
    this.resumeToken = null
    this.lose(linkError('host_restarted', 'The connection to the host ended'))
    if (this.current.kind === 'reconnecting') this.setState({ ...this.current, kept: false })
  }

  /**
   * The session is gone: the requests that went on it fail, as do the downloads; the ones that
   * never went wait for the next.
   */
  private lose(error: LinkError): void {
    this.acks.reset()
    for (const outgoing of [...this.outgoing]) {
      if (outgoing.id !== null) this.settle(outgoing).reject(error)
    }
    const downloads = [...this.downloads.values()]
    this.downloads.clear()
    for (const { reject } of downloads) reject(error)
  }

  /** Forgets an answered or failed request, for its caller to hear. */
  private settle(outgoing: Outgoing): Pending {
    this.outgoing.delete(outgoing)
    if (outgoing.id !== null) this.inFlight.delete(outgoing.id)
    return outgoing.pending
  }

  private async post(session: Session, outgoing: Outgoing): Promise<void> {
    try {
      const params = await this.withUploads(session, outgoing.params, 0)
      // The connection went while uploading: the request goes again on the next one.
      if (this.session !== session || !this.outgoing.has(outgoing)) return
      const id = this.nextId++
      outgoing.id = id
      this.inFlight.set(id, outgoing)
      await session.channel.send({ type: 'request', id, method: outgoing.method, params })
    } catch (error) {
      if (this.session !== session || !this.outgoing.has(outgoing)) return
      this.settle(outgoing).reject(
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as LinkError)
          : linkError('internal', (error as Error).message),
      )
    }
  }

  /** A copy of `value` with each binary value sent ahead as an upload and named in its place. */
  private async withUploads(session: Session, value: unknown, depth: number): Promise<unknown> {
    if (isBinary(value)) return { $stream: await this.upload(session, bytesOf(value)) }
    if (typeof value !== 'object' || value === null || depth >= MAX_DEPTH) return value
    if (Array.isArray(value)) {
      const copy: unknown[] = []
      for (const item of value) copy.push(await this.withUploads(session, item, depth + 1))
      return copy
    }
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      copy[key] = await this.withUploads(session, item, depth + 1)
    }
    return copy
  }

  private async upload(session: Session, bytes: Uint8Array): Promise<number> {
    const stream = this.nextUpload
    this.nextUpload += 2
    const { channel, transport } = session
    await channel.send({ type: 'stream.open', stream, size: bytes.length })
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_FRAME) {
      await channel.sendBytes(stream, bytes.subarray(offset, offset + BYTES_PER_FRAME))
      if (transport.buffered() > HIGH_WATER) await transport.drained()
      if (this.session !== session) throw linkError('host_restarted', 'The connection ended')
    }
    await channel.send({ type: 'stream.end', stream })
    return stream
  }

  private receive(session: Session, value: unknown): void {
    if (this.session !== session || typeof value !== 'object' || value === null) return
    if (session.keepalive) {
      session.keepalive.heard()
      const own = keepaliveMessage(value)
      if (own === 'ping') void session.channel.send({ type: 'pong' } satisfies Pong).catch(() => {})
      if (own === 'pong' && session.pingedAt !== null) {
        // A ping far slower than before: another route may do better now.
        if (this.times.sample(session.route.key, Date.now() - session.pingedAt) && !this.stopped) {
          this.compares.slow()
        }
        session.pingedAt = null
      }
      if (own) return
    }
    const message = value as Record<string, unknown>
    if (message.type !== 'closing' && resumable(session)) this.acks.counted()
    switch (message.type) {
      case 'response': {
        const outgoing = this.takeOutgoing(message.id)
        if (!outgoing) return
        // Registered now, before the bytes that follow the result on the channel.
        const done = this.withDownloads(message.result, 0, outgoing.streams)
        if (outgoing.aborted) {
          for (const stream of outgoing.streams) this.cancelDownload(stream)
          done.catch(() => {})
          return
        }
        void done.then(
          (result) => outgoing.pending.resolve(result),
          (error: LinkError) => outgoing.pending.reject(error),
        )
        return
      }
      case 'error': {
        const pending = this.takeOutgoing(message.id)?.pending
        if (!pending) return
        const error = message.error as Partial<PortError> | undefined
        pending.reject(
          typeof error?.code === 'string' && typeof error.message === 'string'
            ? linkError(error.code, error.message, error.data)
            : linkError('internal', 'The host sent a malformed error'),
        )
        return
      }
      case 'event': {
        const event = message.event as { type?: unknown } | undefined
        if (typeof event?.type !== 'string') return
        if (isHostAdminEvent(event)) return emit(this.adminListeners, event)
        if (event.type.startsWith('device.') || event.type.startsWith('devices.')) {
          return emit(this.deviceListeners, event)
        }
        const terminal = event.type.startsWith('terminal.')
        return emit(terminal ? this.terminalListeners : this.hostListeners, event)
      }
      case 'stream.end': {
        const stream = message.stream as number
        const download = this.downloads.get(stream)
        if (!download) return
        this.downloads.delete(stream)
        download.resolve(joined(download.chunks, download.size))
        return
      }
      case 'stream.cancel': {
        const stream = message.stream as number
        const download = this.downloads.get(stream)
        if (!download) return
        this.downloads.delete(stream)
        const error = message.error as Partial<PortError> | undefined
        download.reject(
          linkError(
            typeof error?.code === 'string' ? error.code : 'internal',
            typeof error?.message === 'string' ? error.message : 'The host gave up a download',
          ),
        )
        return
      }
      case 'closing': {
        session.closing = parseClosing(message)?.reason ?? session.closing
        return
      }
    }
    for (const listener of this.messageListeners) listener(message)
  }

  private receiveBytes(session: Session, stream: number, data: Uint8Array): void {
    if (this.session !== session) return
    session.keepalive?.heard()
    if (resumable(session)) this.acks.counted(data.length)
    const download = this.downloads.get(stream)
    if (!download) return
    download.chunks.push(data.slice())
    download.size += data.length
  }

  private takeOutgoing(id: unknown): Outgoing | null {
    if (typeof id !== 'number') return null
    const outgoing = this.inFlight.get(id)
    if (!outgoing) return null
    this.settle(outgoing)
    return outgoing
  }

  /**
   * `value` with each stream it names replaced by that stream's bytes, once they all came; the
   * streams' ids go into `streams`.
   */
  private withDownloads(value: unknown, depth: number, streams: number[]): Promise<unknown> {
    if (typeof value !== 'object' || value === null || depth >= MAX_DEPTH) {
      return Promise.resolve(value)
    }
    if (isStreamRef(value)) {
      streams.push(value.$stream)
      return new Promise((resolve, reject) => {
        this.downloads.set(value.$stream, { chunks: [], size: 0, resolve, reject })
      })
    }
    const entries = Array.isArray(value)
      ? value.map((item, i) => [i, item] as const)
      : Object.entries(value)
    const resolved = entries.map(([key, item]) =>
      this.withDownloads(item, depth + 1, streams).then((done) => [key, done] as const),
    )
    return Promise.all(resolved).then((done) => {
      if (Array.isArray(value)) return done.map(([, item]) => item)
      return Object.fromEntries(done)
    })
  }
}

/** Whether the host keeps this session through a drop and hears acknowledgements. */
function resumable(session: Session): boolean {
  return session.welcome.protocol >= RESUME_VERSION
}

function emit<T>(listeners: ReadonlySet<(event: T) => void>, event: T): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      console.error('A host event listener failed', error)
    }
  }
}

/** A stream named in a result: `$stream`, with its size or alone. */
function isStreamRef(value: object): value is { $stream: number; size?: number } {
  const keys = Object.keys(value)
  const { $stream, size } = value as Record<string, unknown>
  return (
    typeof $stream === 'number' &&
    keys.every((key) => key === '$stream' || key === 'size') &&
    (size === undefined || typeof size === 'number')
  )
}

function joined(chunks: Uint8Array[], size: number): ArrayBuffer {
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out.buffer
}
