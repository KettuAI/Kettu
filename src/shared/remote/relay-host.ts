// The host's side of the relay: a control socket on every relay while it has an access token,
// each signed in with the host's key, and one more socket for every device the relay announces,
// handed on as a device connection like a direct one. Runs on the standard WebSocket API alone,
// so the remote host runs it under Electron and Node.js alike.

import {
  ACCEPT_TIMEOUT_MS,
  MAX_REGIONS,
  PING,
  PONG,
  RELAY_CLOSE,
  SIGN_IN_TIMEOUT_MS,
  acceptSocketPath,
  hostSocketPath,
  parseRelayInfo,
  parseRelayToHost,
  relayInfoPath,
  relayList,
  relayOrigin,
  relayRefusal,
  relaySocketUrl,
  signInMessage,
  type RelayKey,
  type RelayRefusal,
  type RelayRegion,
} from './relay'

/** Why the last try on a relay ended. */
export type RelayHostError =
  | RelayRefusal
  /** The socket failed before it opened. */
  | 'unreachable'
  /** It closed without the relay saying why, or sent what this side cannot read. */
  | 'closed'
  /** No answer in time: no `ready` after the sign-in, or no `pong` after a ping. */
  | 'no_answer'

/** How one relay is doing, for Settings and the menu bar. */
export type RelayConnection =
  | { state: 'connecting' }
  | { state: 'connected' }
  /** Waiting to try again after `error`. */
  | { state: 'retrying'; error: RelayHostError }
  /** Replaced too often: another copy of Kettu signs in with this host's key. Waits for retry. */
  | { state: 'conflict' }
  /** Refused the key or the token, or too many connections; tried again later. */
  | { state: 'refused'; error: RelayHostError }

export type RelayStatus = RelayRegion & { connection: RelayConnection }

export interface RelayHostTimings {
  /** The first wait after a failure, doubling up to `maxRetryMs`. */
  retryMs: number
  maxRetryMs: number
  /** The wait after 4401, 4409 or 4429. */
  refusedMs: number
  /** How often a connected control socket pings, and how long it waits for `pong`. */
  pingMs: number
  pongMs: number
  /** Replacements within `conflictWindowMs` that stop the relay in `conflict`. */
  conflicts: number
  conflictWindowMs: number
  /** How often the region list is read again. */
  regionsMs: number
}

export const RELAY_HOST_TIMINGS: RelayHostTimings = {
  retryMs: 500,
  maxRetryMs: 30_000,
  refusedMs: 30_000,
  pingMs: 30_000,
  pongMs: 10_000,
  conflicts: 3,
  conflictWindowMs: 10 * 60_000,
  regionsMs: 6 * 60 * 60_000,
}

export interface RelayHostOptions {
  /** The main relay's origin, which lists the regions. */
  main: string
  /** The host's relay id, derived from `key`. */
  id: string
  key: RelayKey
  openSocket(url: string): WebSocket
  /** Reads JSON from a relay's URL; rejects when it cannot. */
  fetchInfo(url: string): Promise<unknown>
  /** A device's socket, open and joined by the relay, to become a device connection. */
  accepted(socket: WebSocket, relay: string): void
  /** A relay's state or the list changed. */
  changed(): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** The regions a run before read, until the main relay answers. */
  regions?: RelayRegion[]
  timings?: Partial<RelayHostTimings>
  now?: () => number
}

/** One relay's control socket, signed in and kept up while the host has a token. */
class Control {
  connection: RelayConnection = { state: 'connecting' }
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private replacedAt: number[] = []
  private closed = false
  /** The device sockets this relay handed on, closed with it. */
  private readonly accepted = new Set<WebSocket>()

  constructor(
    private readonly host: RelayHost,
    public region: RelayRegion,
  ) {}

  private get options(): RelayHostOptions {
    return this.host.options
  }

  private get timings(): RelayHostTimings {
    return this.host.timings
  }

  start(): void {
    if (this.closed || this.socket || this.timer || this.connection.state === 'conflict') return
    if (!this.host.token) return
    this.open()
  }

  /** Tries now, after a conflict or while it waits. */
  retry(): void {
    if (this.closed) return
    this.clearTimer()
    this.replacedAt = []
    this.failures = 0
    if (this.socket) return
    this.set({ state: 'connecting' })
    this.start()
  }

  /** A fresh access token: sent to a relay signed in, or the reason to sign in now. */
  renewed(token: string): void {
    if (this.connection.state === 'connected') this.sendJson({ type: 'token', token })
    else if (!this.socket && this.connection.state !== 'conflict') this.retry()
  }

  /** Signed out, or the host stops: the control socket and the device sockets close. */
  close(): void {
    this.closed = true
    this.end()
    for (const socket of this.accepted) closeSocket(socket, 1000)
    this.accepted.clear()
  }

  /** Signed out: closes everything, and waits for a token to sign in again. */
  pause(): void {
    this.end()
    for (const socket of this.accepted) closeSocket(socket, 1000)
    this.accepted.clear()
    this.failures = 0
    this.set({ state: 'connecting' })
  }

  private end(): void {
    this.clearTimer()
    this.stopPings()
    const socket = this.socket
    this.socket = null
    if (socket) closeSocket(socket, 1000)
  }

  private open(): void {
    const url = relaySocketUrl(this.region.url, hostSocketPath(this.options.id))
    let socket: WebSocket
    try {
      socket = this.options.openSocket(url)
    } catch (error) {
      this.options.log('warn', `Cannot open the relay socket: ${(error as Error).message}`)
      return this.failed('unreachable')
    }
    this.socket = socket
    let opened = false
    let ready = false
    // From the socket's opening, the challenge and its answer take well within this.
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.socket === socket && !ready) this.dropped(socket, 'no_answer')
    }, SIGN_IN_TIMEOUT_MS * 2)
    socket.addEventListener('open', () => {
      opened = true
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      const data: unknown = event.data
      if (data === PONG) return this.heard()
      const message = parseRelayToHost(data)
      if (!message) return this.dropped(socket, 'closed')
      this.heard()
      switch (message.type) {
        case 'challenge':
          return void this.signIn(socket, message.nonce)
        case 'ready':
          if (ready) return
          ready = true
          this.clearTimer()
          this.failures = 0
          this.set({ state: 'connected' })
          return this.schedulePing()
        case 'incoming':
          if (ready) this.acceptDevice(message.token)
          return
        case 'replaced':
          return
      }
    })
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearTimer()
      this.stopPings()
      const code = (event as CloseEvent).code
      this.ended(opened ? (relayRefusal(code) ?? 'closed') : 'unreachable', code)
    })
  }

  private async signIn(socket: WebSocket, nonce: string): Promise<void> {
    const token = this.host.token
    if (!token) return this.dropped(socket, 'closed')
    try {
      const message = await signInMessage(
        this.options.key,
        this.region.url,
        this.options.id,
        nonce,
        token,
      )
      if (this.socket === socket) this.sendJson(message)
    } catch (error) {
      this.options.log('error', `Cannot sign in to the relay: ${(error as Error).message}`)
      this.dropped(socket, 'closed')
    }
  }

  private acceptDevice(token: string): void {
    const url = relaySocketUrl(this.region.url, acceptSocketPath(this.options.id, token))
    let socket: WebSocket
    try {
      socket = this.options.openSocket(url)
    } catch {
      return
    }
    const timer = setTimeout(() => closeSocket(socket, 1000), ACCEPT_TIMEOUT_MS)
    const failed = (): void => {
      clearTimeout(timer)
      socket.removeEventListener('open', opened)
    }
    const opened = (): void => {
      clearTimeout(timer)
      socket.removeEventListener('close', failed)
      if (this.closed || !this.host.token) return closeSocket(socket, 1000)
      this.accepted.add(socket)
      socket.addEventListener('close', () => this.accepted.delete(socket))
      this.options.accepted(socket, this.region.url)
    }
    socket.addEventListener('open', opened, { once: true })
    socket.addEventListener('close', failed, { once: true })
  }

  private ended(error: RelayHostError, code: number): void {
    if (this.closed || !this.host.token) return
    if (code === RELAY_CLOSE.replaced) {
      const now = this.host.now()
      this.replacedAt = [...this.replacedAt, now].filter(
        (at) => now - at < this.timings.conflictWindowMs,
      )
      if (this.replacedAt.length >= this.timings.conflicts) {
        this.options.log('warn', 'Another copy of Kettu signs in to the relay as this host')
        return this.set({ state: 'conflict' })
      }
      return this.wait({ state: 'retrying', error }, this.timings.refusedMs)
    }
    if (code === RELAY_CLOSE.unauthorized || code === RELAY_CLOSE.tooMany) {
      return this.wait({ state: 'refused', error }, this.timings.refusedMs)
    }
    this.failed(error)
  }

  private failed(error: RelayHostError): void {
    const { retryMs, maxRetryMs } = this.timings
    const delay = Math.min(maxRetryMs, retryMs * 2 ** this.failures)
    this.failures++
    this.wait({ state: 'retrying', error }, delay)
  }

  private wait(connection: RelayConnection, delay: number): void {
    this.set(connection)
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.start()
    }, delay)
  }

  /** Ends a socket that misbehaved or went quiet; its close event tries again. */
  private dropped(socket: WebSocket, error: RelayHostError): void {
    if (this.socket !== socket) return
    this.socket = null
    this.clearTimer()
    this.stopPings()
    closeSocket(socket, 1000)
    this.failed(error)
  }

  private schedulePing(): void {
    this.stopPings()
    this.pingTimer = setTimeout(() => {
      const socket = this.socket
      if (!socket) return
      this.sendText(PING)
      this.pingTimer = setTimeout(() => this.dropped(socket, 'no_answer'), this.timings.pongMs)
    }, this.timings.pingMs)
  }

  /** Anything from the relay answers a ping. */
  private heard(): void {
    if (this.connection.state === 'connected') this.schedulePing()
  }

  private stopPings(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer)
    this.pingTimer = null
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private sendJson(message: object): void {
    this.sendText(JSON.stringify(message))
  }

  private sendText(text: string): void {
    const socket = this.socket
    if (socket?.readyState === socket?.OPEN) socket!.send(text)
  }

  private set(connection: RelayConnection): void {
    this.connection = connection
    this.options.changed()
  }
}

function closeSocket(socket: WebSocket, code: number): void {
  try {
    socket.close(code)
  } catch {
    // Already closing.
  }
}

/** Every relay the host signs in to: the main one and the regions it lists. */
export class RelayHost {
  readonly timings: RelayHostTimings
  readonly now: () => number
  token: string | null = null
  private controls: Control[] = []
  private regionTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private started = false

  constructor(readonly options: RelayHostOptions) {
    this.timings = { ...RELAY_HOST_TIMINGS, ...options.timings }
    this.now = options.now ?? Date.now
    this.list(options.regions ?? [])
  }

  /** The relays, in order, each with how it is doing. */
  get status(): RelayStatus[] {
    return this.controls.map(({ region, connection }) => ({ ...region, connection }))
  }

  /** The relays in order, for welcomes and pairing codes. */
  get relays(): RelayRegion[] {
    return this.controls.map(({ region }) => region)
  }

  /** Reads the regions and signs in wherever a token allows; again every few hours. */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    void this.readRegions()
    for (const control of this.controls) control.start()
  }

  /** The access token to sign in with, renewed or gone: null signs out of every relay. */
  setToken(token: string | null): void {
    if (this.stopped || token === this.token) return
    const had = this.token
    this.token = token
    if (!token) {
      for (const control of this.controls) control.pause()
      return
    }
    for (const control of this.controls) {
      if (had) control.renewed(token)
      else control.start()
    }
  }

  /** Tries every relay now, as Retry does after a conflict or an error. */
  retry(): void {
    for (const control of this.controls) control.retry()
  }

  stop(): void {
    this.stopped = true
    if (this.regionTimer) clearTimeout(this.regionTimer)
    this.regionTimer = null
    for (const control of this.controls) control.close()
  }

  private async readRegions(): Promise<void> {
    const { main } = this.options
    try {
      const info = parseRelayInfo(await this.options.fetchInfo(`${main}${relayInfoPath()}`))
      if (!info) throw new Error('it is not a Kettu relay of this protocol')
      if (!this.stopped) this.list(info.regions)
    } catch (error) {
      // The list read before stays.
      this.options.log('warn', `Cannot read the relay regions: ${(error as Error).message}`)
    }
    if (this.stopped) return
    this.regionTimer = setTimeout(() => void this.readRegions(), this.timings.regionsMs)
  }

  /** Signs in to each relay of the list, keeping those it had and leaving the others. */
  private list(regions: RelayRegion[]): void {
    const next = relayList(this.options.main, regions)
    const kept: Control[] = []
    for (const region of next) {
      const control =
        this.controls.find((entry) => entry.region.url === region.url) ?? new Control(this, region)
      kept.push(control)
    }
    const same =
      kept.length === this.controls.length &&
      kept.every((control, i) => control === this.controls[i] && next[i]!.id === control.region.id)
    if (same) return
    for (const control of this.controls) if (!kept.includes(control)) control.close()
    kept.forEach((control, i) => (control.region = next[i]!))
    this.controls = kept
    if (this.started) for (const control of this.controls) control.start()
    this.options.changed()
  }
}

const CONNECTIONS: readonly string[] = [
  'connecting',
  'connected',
  'retrying',
  'conflict',
  'refused',
]
const ERRORS: readonly string[] = [
  'malformed',
  'unauthorized',
  'forbidden',
  'offline',
  'timeout',
  'replaced',
  'too_big',
  'too_many',
  'unreachable',
  'closed',
  'no_answer',
]

/** The relays as the remote host reports them, checked where they cross a process; null if not. */
export function parseRelayStatuses(value: unknown): RelayStatus[] | null {
  if (!Array.isArray(value) || value.length > MAX_REGIONS) return null
  const kept: RelayStatus[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null
    const { id, url, connection } = entry as Record<string, unknown>
    const { state, error } = (connection ?? {}) as Record<string, unknown>
    if (typeof id !== 'string' || id.length > 32 || typeof url !== 'string') return null
    if (relayOrigin(url) !== url || !CONNECTIONS.includes(state as string)) return null
    const failed = state === 'retrying' || state === 'refused'
    if (failed && !ERRORS.includes(error as string)) return null
    kept.push({
      id,
      url,
      connection: (failed ? { state, error } : { state }) as RelayConnection,
    })
  }
  return kept
}
