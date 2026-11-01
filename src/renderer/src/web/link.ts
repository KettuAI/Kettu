// The web client's connection to the host that served it: a WebSocket on the page's own origin
// carrying the encrypted channel, then hello and welcome, then the host protocol as a window's
// port carries it, with binary values going as byte streams both ways. It reconnects with backoff
// while the page is visible, and stops for good once the host says this browser may not connect.

import type { PortError, PortErrorCode } from '@shared/port-rpc'
import { BYTES_PER_FRAME } from '@shared/remote/channel'
import {
  HandshakeDropped,
  startDeviceChannel,
  type DeviceChannel,
} from '@shared/remote/device-channel'
import type { KeyPair } from '@shared/remote/noise'
import { bytesOf, isBinary } from '@shared/remote/places'
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseClosing,
  parseWelcome,
  type ClosingReason,
  type Hello,
  type Welcome,
} from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'
import { webSocketTransport } from '@shared/remote/websocket-transport'

/** What a transport may hold before an upload waits for it to drain, as the host's downloads do. */
const HIGH_WATER = 256 * 1024

/** How long a known host has from the handshake to its welcome. */
const WELCOME_TIMEOUT_MS = 15_000

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
  /** Connected before; `reason` is what the host said as it ended, if it said anything. */
  | { kind: 'reconnecting'; reason: ClosingReason | null }
  | { kind: 'stopped'; reason: LinkStop }

/** A request's failure as the renderer reads a port's: a plain object with the code. */
export interface LinkError extends PortError {
  name: 'PortRequestError'
}

function linkError(code: PortErrorCode, message: string, data?: unknown): LinkError {
  return { name: 'PortRequestError', code, message, ...(data === undefined ? {} : { data }) }
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

export function dialWebSocket(url: string): Dial {
  return () => webSocketTransport(new WebSocket(url))
}

interface Pending {
  resolve(value: unknown): void
  reject(error: LinkError): void
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
  welcome: Welcome
  closing: ClosingReason | null
}

/** A connection whose handshake is done, waiting for the host's first word. */
export interface Opened {
  channel: DeviceChannel
  transport: Transport
}

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
    const later: unknown[] = []
    const timer = timeoutMs === null ? null : setTimeout(() => opened.channel.close(), timeoutMs)
    const settle = (value: Answer): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    opened.channel.onMessage((value) => {
      // What follows the welcome before its taker listens, for the taker.
      if (done) return void later.push(value)
      const welcome = parseWelcome(value)
      if (welcome) return settle({ welcome, later })
      closing = parseClosing(value)?.reason ?? closing
    })
    void opened.channel.closed.then(() => settle({ closing }))
  })
}

export type Answer = { welcome: Welcome; later: unknown[] } | { closing: ClosingReason | null }

export function hello(client: Hello['client'], device?: Hello['device']): Hello {
  return {
    type: 'hello',
    protocol: { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
    client,
    ...(device ? { device } : {}),
  }
}

export interface HostLinkOptions {
  dial: Dial
  hostKey: Uint8Array
  key: KeyPair
  hello: Hello
  /** A connection pairing left open and welcomed, which the link takes as its first. */
  adopt?: { opened: Opened; welcome: Welcome; later: unknown[] }
  /** Whether the page is in front; a link in the back waits to reconnect until it is. */
  visible?: () => boolean
  retryDelay?: (failures: number) => number
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
  private nextId = 1
  // Odd and rising, as the host takes a device's stream ids.
  private nextUpload = 1
  private readonly inFlight = new Map<number, Pending>()
  private readonly downloads = new Map<number, Download>()
  private queued: { message: Record<string, unknown>; pending: Pending }[] = []
  private readonly hostListeners = new Set<(event: unknown) => void>()
  private readonly terminalListeners = new Set<(event: unknown) => void>()
  private readonly stateListeners = new Set<(state: LinkState) => void>()
  private readonly messageListeners = new Set<(message: Record<string, unknown>) => void>()

  constructor(private readonly options: HostLinkOptions) {}

  get state(): LinkState {
    return this.current
  }

  start(): void {
    const adopted = this.options.adopt
    if (adopted) this.welcomed(adopted.opened, adopted.welcome, adopted.later)
    else void this.connect()
  }

  /** Tries at once, as when the page comes to the front or the network comes back. */
  wake(): void {
    if (this.stopped || this.session || this.connecting) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.session?.channel.close()
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

  /** The terminal host's events, which share the channel. */
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

  request(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) {
      return Promise.reject(
        linkError('host_restarted', 'This browser no longer connects to the host'),
      )
    }
    return new Promise((resolve, reject) => {
      const message = { type: 'request', method, params }
      const pending = { resolve, reject }
      if (this.session) void this.post(this.session, message, pending)
      else this.queued.push({ message, pending })
    })
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
    if (this.stopped || this.session || this.connecting) return
    this.connecting = true
    let opened: Opened
    try {
      opened = await openChannel(this.options.dial, {
        hostKey: this.options.hostKey,
        key: this.options.key,
        hello: this.options.hello,
      })
    } catch (error) {
      this.connecting = false
      // The host took the WebSocket and dropped the handshake: it may not know this key now.
      if (error instanceof HandshakeDropped && ++this.drops >= DROPS_UNKNOWN) {
        return this.end('removed')
      }
      return this.retry()
    }
    this.drops = 0
    const answer = await awaitWelcome(opened, WELCOME_TIMEOUT_MS)
    this.connecting = false
    if ('welcome' in answer) return this.welcomed(opened, answer.welcome, answer.later)
    const reason = answer.closing
    if (reason === 'removed' || reason === 'update_client' || reason === 'update_host') {
      return this.end(reason)
    }
    this.retry(reason)
  }

  private retry(reason: ClosingReason | null = null): void {
    if (this.stopped) return
    if (this.current.kind === 'connected' || this.current.kind === 'reconnecting') {
      this.setState({ kind: 'reconnecting', reason })
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
    this.failQueued(linkError('host_restarted', 'This browser no longer connects to the host'))
    this.setState({ kind: 'stopped', reason })
  }

  private welcomed(opened: Opened, welcome: Welcome, later: unknown[]): void {
    const session: Session = { ...opened, welcome, closing: null }
    this.session = session
    this.failures = 0
    this.nextId = 1
    for (const value of later.splice(0)) this.receive(session, value)
    opened.channel.onMessage((value) => this.receive(session, value))
    opened.channel.onBytes((stream, data) => this.receiveBytes(stream, data))
    void opened.channel.closed.then(() => this.ended(session))
    this.setState({ kind: 'connected', welcome })
    const queued = this.queued
    this.queued = []
    for (const { message, pending } of queued) void this.post(session, message, pending)
  }

  private ended(session: Session): void {
    if (this.session !== session) return
    this.session = null
    const lost = linkError('host_restarted', 'The connection to the host ended')
    const inFlight = [...this.inFlight.values()]
    this.inFlight.clear()
    for (const { reject } of inFlight) reject(lost)
    const downloads = [...this.downloads.values()]
    this.downloads.clear()
    for (const { reject } of downloads) reject(lost)
    const reason = session.closing
    if (reason === 'removed' || reason === 'update_client' || reason === 'update_host') {
      return this.end(reason)
    }
    this.retry(reason)
  }

  private failQueued(error: LinkError): void {
    const queued = this.queued
    this.queued = []
    for (const { pending } of queued) pending.reject(error)
  }

  private async post(
    session: Session,
    message: Record<string, unknown>,
    pending: Pending,
  ): Promise<void> {
    const id = this.nextId++
    this.inFlight.set(id, pending)
    try {
      const params = await this.withUploads(session, message.params, 0)
      if (this.session !== session) return
      await session.channel.send({ ...message, id, params })
    } catch (error) {
      if (!this.inFlight.delete(id)) return
      pending.reject(
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
    const message = value as Record<string, unknown>
    switch (message.type) {
      case 'response': {
        const pending = this.takePending(message.id)
        if (!pending) return
        // Registered now, before the bytes that follow the result on the channel.
        void this.withDownloads(message.result, 0).then(pending.resolve, pending.reject)
        return
      }
      case 'error': {
        const pending = this.takePending(message.id)
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
        const listeners = event.type.startsWith('terminal.')
          ? this.terminalListeners
          : this.hostListeners
        for (const listener of listeners) {
          try {
            listener(event)
          } catch (error) {
            console.error('A host event listener failed', error)
          }
        }
        return
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

  private receiveBytes(stream: number, data: Uint8Array): void {
    const download = this.downloads.get(stream)
    if (!download) return
    download.chunks.push(data.slice())
    download.size += data.length
  }

  private takePending(id: unknown): Pending | null {
    if (typeof id !== 'number') return null
    const pending = this.inFlight.get(id)
    if (!pending) return null
    this.inFlight.delete(id)
    return pending
  }

  /** `value` with each stream it names replaced by that stream's bytes, once they all came. */
  private withDownloads(value: unknown, depth: number): Promise<unknown> {
    if (typeof value !== 'object' || value === null || depth >= MAX_DEPTH) {
      return Promise.resolve(value)
    }
    if (isStreamRef(value)) {
      return new Promise((resolve, reject) => {
        this.downloads.set(value.$stream, { chunks: [], size: 0, resolve, reject })
      })
    }
    const entries = Array.isArray(value)
      ? value.map((item, i) => [i, item] as const)
      : Object.entries(value)
    const resolved = entries.map(([key, item]) =>
      this.withDownloads(item, depth + 1).then((done) => [key, done] as const),
    )
    return Promise.all(resolved).then((done) => {
      if (Array.isArray(value)) return done.map(([, item]) => item)
      return Object.fromEntries(done)
    })
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
