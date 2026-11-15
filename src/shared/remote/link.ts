// A device's connection to a host, which the web client and the other clients share: the encrypted
// channel over what the caller dials (a WebSocket to the host's direct port, or the relay), then
// hello and welcome, then the host protocol as a window's port carries it, with binary values going
// as byte streams both ways. It reconnects with backoff while the client is visible, and stops for
// good once the host says this device may not connect.
// A host of version 2 keeps the session through a drop for a while: the link acknowledges what it
// receives, resumes with the welcome's token, and sends again the requests the host did not read.
// Given several routes, as a relay's regions, it races them to a finished handshake, says hello on
// the winner alone, and later moves the session to a route clearly faster than the one it is on.
// Through the relay it also tries a peer-to-peer path while the page is in front, keeping the
// relay connection as the session's standby once it moves there.

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
import { isP2pMessage, P2P_FEATURE, parseP2p, PeerOffer, type PeerSystem } from './p2p'
import { PathTimes, PROBE_TIMEOUT_MS, rankPaths, shouldMove, type PathRef } from './paths'
import { bytesOf, isBinary } from './places'
import {
  IMAGE_REFS_FEATURE,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RESUME_MS,
  RESUME_VERSION,
  STANDBY_FEATURE,
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

/** How long after a welcome on the relay a peer-to-peer path is first tried. */
const COMPARE_AFTER_MS = 3_000

/** How long after a peer-to-peer path failed to open none is tried, unless the network changes. */
const PEER_RETRY_MS = 5 * 60_000

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

export type LinkStop = 'removed' | 'update_client' | 'update_host'

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

/** The peer-to-peer path, which opens through the session's own signaling, never by a dial. */
const PEER_ROUTE: LinkRoute = {
  key: 'p2p',
  relay: false,
  dial: () => Promise.reject(new Error('A peer-to-peer path opens through the session')),
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

export function hello(client: Hello['client'], device?: Hello['device']): Hello {
  return {
    type: 'hello',
    protocol: { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
    client,
    ...(device ? { device } : {}),
    // The web client shows the thread with the window's components.
    features: [IMAGE_REFS_FEATURE],
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
  /** Peer-to-peer paths, tried through the relay while the page is in front; none when absent. */
  peers?(): PeerSystem | null
  /** A peer-to-peer path was tried, and whether it opened, for the daily report. */
  punched?(opened: boolean): void
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
  private comparing = false
  private compareTimer: ReturnType<typeof setTimeout> | null = null
  private compareAt = 0
  /** The connection a move left, until the host makes it the standby or it ends. */
  private aside: Aside | null = null
  /** Whether the move asked the host to keep that connection as the standby. */
  private keepAside = false
  /** The relay connection kept beside a session on a peer-to-peer path, once the host took it. */
  private standby: Aside | null = null
  /** What the last welcome's host offers: a standby for the session, and peer-to-peer paths. */
  private standbys = false
  private offersP2p = false
  /** The peer-to-peer path being opened, and when another may be tried after one failed. */
  private peerOffer: PeerOffer | null = null
  private peerAfter = 0

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
      this.peerAfter = 0
      return this.compareSoon(0)
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.connect()
  }

  /**
   * The page went to the back, where nothing keeps a peer-to-peer path's NAT mapping: a session on
   * one goes back to the relay standby, and none is tried until the page is in front again.
   */
  background(): void {
    this.closePeerOffer()
    const session = this.session
    const standby = this.standby?.standby ? this.standby : null
    if (this.stopped || this.taking || session?.route !== PEER_ROUTE || !standby) return
    this.takeOver(session, standby)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.compareTimer) clearTimeout(this.compareTimer)
    this.acks.pause()
    if (this.keptTimer) clearTimeout(this.keptTimer)
    this.closePeerOffer()
    this.session?.channel.close()
    this.aside?.close()
    this.aside = null
    this.standby?.close()
    this.standby = null
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
    if (reason === 'removed' || reason === 'update_client' || reason === 'update_host') {
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
    this.standbys = welcome.features.includes(STANDBY_FEATURE)
    this.offersP2p = welcome.features.includes(P2P_FEATURE)
    // A standby is kept only beside a session the host resumed on a path without a relay.
    if (!resumed || route.relay) {
      this.standby?.close()
      this.standby = null
    }
    this.settleAside(resumed)
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
    if (route.relay && this.mayOfferPeer(session)) this.compareSoon(COMPARE_AFTER_MS)
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
    if (reason === 'removed' || reason === 'update_client' || reason === 'update_host') {
      return this.end(reason)
    }
    if (reason === null) this.times.failed(session.route.key)
    // The connection a move left, or the relay standby, takes the session over at once.
    const aside = this.aside?.open ? this.aside : this.standby?.standby ? this.standby : null
    if (reason === null && aside && resumable(session) && this.resumeToken !== null) {
      return void this.promote(aside)
    }
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
    if (this.stopped || (this.compareTimer && this.compareAt <= Date.now() + delay)) return
    if (this.compareTimer) clearTimeout(this.compareTimer)
    this.compareAt = Date.now() + delay
    this.compareTimer = setTimeout(() => {
      this.compareTimer = null
      void this.compare()
    }, delay)
  }

  /**
   * Opens the other routes to a finished handshake each, for their round trips, and moves the
   * session to the best when it is clearly faster than the one it is on.
   */
  private async compare(): Promise<void> {
    const session = this.session
    if (this.stopped || this.connecting || this.taking || this.comparing || !session) return
    if (!resumable(session) || this.resumeToken === null) return
    if (this.mayOfferPeer(session)) void this.offerPeer(session)
    // The standby's pings time its route already.
    const standby = this.standby?.standby ? this.standby : null
    const others = this.routes().filter(
      (route) => route.key !== session.route.key && route.key !== standby?.via.route.key,
    )
    if (others.length === 0 && !standby) return
    this.comparing = true
    const probed = await Promise.all(others.map((route) => this.probe(route)))
    this.comparing = false
    const opened = probed.flatMap(({ opened, ...route }) => (opened ? [{ ...route, opened }] : []))
    for (const path of probed) {
      if (path.opened) this.times.sample(path.key, path.opened.channel.handshakeMs)
      else this.times.failed(path.key)
    }
    const current: PathRef = { key: session.route.key, relay: session.route.relay }
    const kept: PathRef[] = standby ? [standby.via.route] : []
    const [best] = rankPaths<PathRef>([current, ...kept, ...opened], this.times)
    const moving = this.session === session && !this.taking && !this.stopped
    const move = moving && best && shouldMove(current, best, this.times, false) ? best : null
    const target = opened.find((path) => path === move) ?? null
    for (const path of opened) if (path !== target) path.opened.channel.close()
    if (target) return this.move(target.opened, target)
    // The standby is the faster path: it takes the session over and the peer-to-peer path goes.
    if (move && standby && move === kept[0] && standby.standby) this.takeOver(session, standby)
  }

  /** Whether to try a peer-to-peer path for a session on the relay. */
  private mayOfferPeer(session: Session): boolean {
    return (
      this.offersP2p &&
      this.standbys &&
      session.route.relay &&
      this.peerOffer === null &&
      Date.now() >= this.peerAfter &&
      (this.options.visible?.() ?? true) &&
      (this.options.peers?.() ?? null) !== null
    )
  }

  /**
   * Opens a peer-to-peer path through the session's own signaling, finishes its handshake and
   * moves the session to it when it is clearly faster, the relay connection kept as the standby.
   */
  private async offerPeer(session: Session): Promise<void> {
    const system = this.options.peers?.()
    if (!system) return
    let offer: PeerOffer
    try {
      offer = new PeerOffer({ system, send: (message) => this.send({ ...message }) })
    } catch {
      this.peerAfter = Date.now() + PEER_RETRY_MS
      return
    }
    this.peerOffer = offer
    let reached = false
    let opened: Opened | null = null
    try {
      const transport = await offer.opened
      reached = true
      const timer = setTimeout(() => transport.close(), PROBE_TIMEOUT_MS)
      try {
        const started = await startDeviceChannel({
          transport,
          hostKey: this.options.hostKey,
          key: this.options.key,
          hello: null,
        })
        opened = { channel: await started.opened, transport }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // The path did not open, or its handshake did not finish.
    } finally {
      if (this.peerOffer === offer) this.peerOffer = null
    }
    this.options.punched?.(reached)
    if (!opened) {
      this.times.failed(PEER_ROUTE.key)
      this.peerAfter = Date.now() + PEER_RETRY_MS
      return
    }
    this.times.sample(PEER_ROUTE.key, opened.channel.handshakeMs)
    const front = this.options.visible?.() ?? true
    if (this.stopped || this.session !== session || this.taking || !front) {
      return opened.channel.close()
    }
    const current: PathRef = { key: session.route.key, relay: session.route.relay }
    const [best] = rankPaths<PathRef>([current, PEER_ROUTE], this.times)
    if (best === PEER_ROUTE && shouldMove(current, PEER_ROUTE, this.times, false)) {
      return this.move(opened, PEER_ROUTE)
    }
    opened.channel.close()
  }

  private closePeerOffer(): void {
    const offer = this.peerOffer
    this.peerOffer = null
    offer?.close()
  }

  /** Leaves the session's connection for a connection kept aside, which takes the session over. */
  private takeOver(session: Session, aside: Aside): void {
    session.keepalive?.stop()
    this.session = null
    this.acks.pause()
    session.channel.close()
    void this.promote(aside)
  }

  /** A connection kept aside, whose pings time its route, and which the host may make the standby. */
  private setAside(channel: DeviceChannel, route: LinkRoute, transport: Transport): Aside {
    const aside: Aside = new AsideConnection(
      channel,
      { route, transport },
      {
        ...(this.options.keepalive ? { timings: this.options.keepalive } : {}),
        rtt: (ms) => this.times.sample(route.key, ms),
        standingBy: () => {
          if (aside !== this.aside || this.taking) return
          this.aside = null
          this.setStandby(aside)
        },
        ended: () => {
          if (aside === this.aside) this.aside = null
          if (aside === this.standby) this.standby = null
        },
      },
    )
    return aside
  }

  private setStandby(aside: Aside): void {
    const before = this.standby
    this.standby = aside
    if (before && before !== aside) before.close()
  }

  /** A welcome after a move: the connection it left becomes the standby once the host says so. */
  private settleAside(resumed: boolean): void {
    const aside = this.aside
    if (!aside) return
    if (!resumed || !this.keepAside) {
      this.aside = null
      aside.close()
      return
    }
    if (!aside.standby) return
    this.aside = null
    this.setStandby(aside)
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
    // Leaving the relay for a path without one, the relay connection stays as the standby.
    const keep = this.standbys && from.route.relay && !route.relay
    this.keepAside = keep
    this.aside?.close()
    this.aside = this.setAside(from.channel, from.route, from.transport)
    void opened.channel
      .send({
        ...this.options.hello,
        resume: { token, received: this.acks.received },
        ...(keep ? { standby: 'keep' as const } : {}),
      } satisfies Hello)
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
    if (reason === 'removed' || reason === 'update_client' || reason === 'update_host') {
      return this.end(reason)
    }
    this.dropped(reason, true)
  }

  /** Takes the session over on a connection kept aside; nothing shows a drop meanwhile. */
  private async promote(aside: Aside): Promise<void> {
    if (aside === this.aside) this.aside = null
    if (aside === this.standby) this.standby = null
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
        if (this.times.sample(session.route.key, Date.now() - session.pingedAt)) {
          this.compareSoon(0)
        }
        session.pingedAt = null
      }
      if (own) return
    }
    const message = value as Record<string, unknown>
    if (message.type !== 'closing' && resumable(session)) this.acks.counted()
    if (isP2pMessage(message)) {
      const signal = parseP2p(message)
      if (signal) this.peerOffer?.signal(signal)
      return
    }
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
