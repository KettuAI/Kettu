// The host's side of the relay: a control socket on every relay while it has a token, each signed
// in with the host's key, and one more socket for every device the relay announces, handed on as
// a device connection like a direct one. The relays are the regions of `GET /v1`, or those the
// region rules picked from the signed list; each control socket times its pings for the host's
// leg, and a region that drains is left once no device is joined through it. Runs on the
// standard WebSocket API alone, so the remote host runs it under Electron and Node.js alike.

import {
  ACCEPT_TIMEOUT_MS,
  HOSTS_FEATURE,
  RELAY_TOKENS_FEATURE,
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
  type RelayHostProfile,
  type RelayKey,
  type RelayRefusal,
  type RelayRegion,
} from './relay'
import { DRAINED_MS } from './relay-regions'

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
  /** How long a region left behind keeps the devices joined through it. */
  leaveMs: number
  /** How long a region that said it drains is not signed in to again. */
  drainedMs: number
  /** Round trips a control socket keeps for the host's leg, whose median it reports. */
  rttSamples: number
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
  leaveMs: 10 * 60_000,
  drainedMs: DRAINED_MS,
  rttSamples: 5,
}

export interface RelayHostOptions {
  /** The main relay's origin, which lists the regions. */
  main: string
  /** The host's relay id, derived from `key`. */
  id: string
  key: RelayKey
  /** Opens a socket to a relay, checking its certificate by `pin` when it has one. */
  openSocket(url: string, pin?: string): WebSocket
  /** Reads JSON from a relay's URL, through its pin when it has one; rejects when it cannot. */
  fetchInfo(url: string, pin?: string): Promise<unknown>
  /** A device's socket, open and joined by the relay, to become a device connection. */
  accepted(socket: WebSocket, relay: string): void
  /**
   * How the host is listed to its account's devices, null for not at all; sent to each relay
   * that has HOSTS_FEATURE once signed in. Without it the host sends no profile.
   */
  profile?(): RelayHostProfile | null
  /** A relay's state or the list changed. */
  changed(): void
  /** A region said it drains: the host reads the list again and signs in elsewhere. */
  drained?(region: RelayRegion): void
  /** A region could not be reached or did not answer, reason to read the list again. */
  failed?(region: RelayRegion): void
  /** A sign-in to a region was made or failed, for the day's report. */
  connected?(region: RelayRegion, ok: boolean): void
  /** A round trip timed on a region's control socket, in milliseconds. */
  measured?(region: RelayRegion, rtt: number): void
  /** The host's leg to a region changed, or the regions it is signed in to did. */
  legsChanged?(): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** The regions a run before read, until the main relay answers. */
  regions?: RelayRegion[]
  /**
   * A relay the owner runs, the only one signed in to, with the access key as the token: no
   * regions are read and no plan applies. `main` is its origin.
   */
  own?: RelayRegion
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
  /** Whether this relay has HOSTS_FEATURE, once its `GET /v1` was read. */
  private listsHosts: boolean | null = null
  /** The profile the relay holds from this socket, as JSON; null for none. */
  private sentProfile: string | null = null
  /** Whether the socket now open has signed in. */
  private ready = false
  /** When the ping waiting for its `pong` went out. */
  private pingAt: number | null = null
  private readonly rtts: number[] = []
  /** Left out of the regions to sign in to: closes once no device is joined through it. */
  leaving = false
  private leaveTimer: ReturnType<typeof setTimeout> | null = null

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

  /** The host's leg: the median of the last round trips timed, null before the first. */
  get rtt(): number | null {
    if (this.rtts.length === 0) return null
    const sorted = [...this.rtts].sort((a, b) => a - b)
    return sorted[Math.floor((sorted.length - 1) / 2)]!
  }

  /** Devices joined through this relay now. */
  get devices(): number {
    return this.accepted.size
  }

  /**
   * No longer one to sign in to: closes at once without devices joined through it, else once the
   * last of them is gone or `ms` have passed, taking no new device meanwhile.
   */
  leave(ms: number): void {
    if (this.leaving) return
    this.leaving = true
    if (this.accepted.size === 0 || !this.socket) return this.host.left(this)
    this.leaveTimer = setTimeout(() => this.host.left(this), ms)
  }

  /** One to sign in to again. */
  stay(): void {
    this.leaving = false
    if (this.leaveTimer) clearTimeout(this.leaveTimer)
    this.leaveTimer = null
  }

  /** Signed out, or the host stops: the control socket and the device sockets close. */
  close(): void {
    this.closed = true
    this.stay()
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
    this.sentProfile = null
    this.ready = false
    if (socket) closeSocket(socket, 1000)
  }

  private open(): void {
    const url = relaySocketUrl(this.region.url, hostSocketPath(this.options.id))
    let socket: WebSocket
    this.ready = false
    try {
      socket = this.options.openSocket(url, this.region.pin)
    } catch (error) {
      this.options.log('warn', `Cannot open the relay socket: ${(error as Error).message}`)
      return this.failed('unreachable')
    }
    this.socket = socket
    let opened = false
    // From the socket's opening, the challenge and its answer take well within this.
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.socket === socket && !this.ready) this.dropped(socket, 'no_answer')
    }, SIGN_IN_TIMEOUT_MS * 2)
    socket.addEventListener('open', () => {
      opened = true
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      const data: unknown = event.data
      if (data === PONG) {
        this.timed()
        return this.heard()
      }
      const message = parseRelayToHost(data)
      if (!message) return this.dropped(socket, 'closed')
      this.heard()
      switch (message.type) {
        case 'challenge':
          return void this.signIn(socket, message.nonce)
        case 'ready':
          if (this.ready) return
          this.ready = true
          this.clearTimer()
          this.failures = 0
          this.options.connected?.(this.region, true)
          this.set({ state: 'connected' })
          // The first round trip at once, for the host's leg; then as the keepalive goes.
          this.sendPing()
          this.schedulePing()
          return void this.sendProfile()
        case 'incoming':
          if (this.ready && !this.leaving) this.acceptDevice(message.token)
          return
        case 'drain':
          if (this.ready) this.host.drained(this)
          return
        case 'replaced':
          return
      }
    })
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.sentProfile = null
      this.clearTimer()
      this.stopPings()
      const code = (event as CloseEvent).code
      this.ended(opened ? (relayRefusal(code) ?? 'closed') : 'unreachable', code)
    })
  }

  /** A `pong`: the round trip of the ping waiting for it. */
  private timed(): void {
    if (this.pingAt === null) return
    const rtt = Math.max(0, Math.round(this.host.now() - this.pingAt))
    this.pingAt = null
    this.rtts.push(rtt)
    if (this.rtts.length > this.timings.rttSamples) this.rtts.shift()
    this.options.measured?.(this.region, rtt)
    this.host.legsChanged()
  }

  /**
   * Sends the host's profile when it changed since the socket's last, to a relay that takes it;
   * null only to take back one sent on this socket, so a host never listed sends nothing.
   */
  async sendProfile(): Promise<void> {
    const socket = this.socket
    const { profile } = this.options
    if (!socket || !profile || this.connection.state !== 'connected') return
    if (profile() === null && this.sentProfile === null) return
    if (this.listsHosts === null) {
      try {
        const url = `${this.region.url}${relayInfoPath()}`
        const info = parseRelayInfo(await this.options.fetchInfo(url, this.region.pin))
        // Read again on the next change when the relay could not say.
        if (info) this.listsHosts = info.features.includes(HOSTS_FEATURE)
      } catch {
        return
      }
    }
    if (!this.listsHosts || this.socket !== socket || this.connection.state !== 'connected') return
    const current = profile()
    const sent = current && JSON.stringify(current)
    if (sent === this.sentProfile) return
    this.sentProfile = sent
    this.sendJson({ type: 'profile', profile: current })
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
      socket = this.options.openSocket(url, this.region.pin)
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
      socket.addEventListener('close', () => {
        this.accepted.delete(socket)
        if (this.leaving && this.accepted.size === 0) this.host.left(this)
      })
      this.options.accepted(socket, this.region.url)
    }
    socket.addEventListener('open', opened, { once: true })
    socket.addEventListener('close', failed, { once: true })
  }

  private ended(error: RelayHostError, code: number): void {
    const wasReady = this.ready
    this.ready = false
    if (this.closed || !this.host.token) return
    // A region left behind is not signed in to again.
    if (this.leaving) return this.host.left(this)
    if (!wasReady) this.attemptFailed(error)
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

  /** A try that ended before its sign-in, which the day's report counts. */
  private attemptFailed(error: RelayHostError): void {
    if (error === 'replaced') return
    this.options.connected?.(this.region, false)
    if (error === 'unreachable' || error === 'no_answer') this.options.failed?.(this.region)
  }

  /** Ends a socket that misbehaved or went quiet; its close event tries again. */
  private dropped(socket: WebSocket, error: RelayHostError): void {
    if (this.socket !== socket) return
    const wasReady = this.ready
    this.socket = null
    this.sentProfile = null
    this.ready = false
    this.clearTimer()
    this.stopPings()
    closeSocket(socket, 1000)
    if (this.leaving) return this.host.left(this)
    if (!wasReady) this.attemptFailed(error)
    this.failed(error)
  }

  private sendPing(): void {
    this.pingAt = this.host.now()
    this.sendText(PING)
  }

  private schedulePing(): void {
    // A ping in flight keeps its time: its pong still counts.
    if (this.pingTimer) clearTimeout(this.pingTimer)
    this.pingTimer = setTimeout(() => {
      const socket = this.socket
      if (!socket) return
      this.sendPing()
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
    this.pingAt = null
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

/**
 * Every relay the host signs in to: the main one and the regions `GET /v1` lists, or the regions
 * the region rules picked once there is a plan.
 */
export class RelayHost {
  readonly timings: RelayHostTimings
  readonly now: () => number
  token: string | null = null
  private controls: Control[] = []
  /** Regions no longer signed in to, kept while devices are joined through them. */
  private readonly leaving = new Set<Control>()
  /** The regions `GET /v1` listed. */
  private listed: RelayRegion[] = []
  /** The regions the region rules picked; null to use those `GET /v1` lists. */
  private plan: RelayRegion[] | null = null
  /** Regions that said they drain, by origin, and until when they are passed over. */
  private readonly draining = new Map<string, number>()
  private regionTimer: ReturnType<typeof setTimeout> | null = null
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private started = false

  constructor(readonly options: RelayHostOptions) {
    this.timings = { ...RELAY_HOST_TIMINGS, ...options.timings }
    this.now = options.now ?? Date.now
    this.listed = options.regions ?? []
    if (options.own) this.plan = [options.own]
    this.apply()
  }

  /** The relays, in order, each with how it is doing. */
  get status(): RelayStatus[] {
    return this.controls.map(({ region, connection }) => ({ ...region, connection }))
  }

  /** The relays in order, for welcomes and pairing codes. */
  get relays(): RelayRegion[] {
    return this.controls.map(({ region }) => region)
  }

  /** The relays signed in to now, each with the host's leg to it. */
  legs(): (RelayRegion & { hostRtt: number | null })[] {
    return this.controls
      .filter((control) => control.connection.state === 'connected')
      .map(({ region, rtt }) => ({ ...region, hostRtt: rtt }))
  }

  /** Reads the regions and signs in wherever a token allows; again every few hours. */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    if (!this.options.own) void this.readRegions()
    for (const control of this.controls) control.start()
  }

  /** The regions the region rules picked, the main relay first; null to use `GET /v1`'s. */
  setPlan(regions: RelayRegion[] | null): void {
    if (this.stopped || this.options.own) return
    if (JSON.stringify(regions) === JSON.stringify(this.plan)) return
    this.plan = regions
    this.apply()
  }

  /** The token to sign in with, renewed or gone: null signs out of every relay. */
  setToken(token: string | null): void {
    if (this.stopped || token === this.token) return
    const had = this.token
    this.token = token
    if (!token) {
      for (const control of this.leaving) control.close()
      this.leaving.clear()
      for (const control of this.controls) control.pause()
      return
    }
    // A region being left keeps the token it signed in with, which outlasts its leaving; the new
    // one may be the access token, which a region of the signed list must never get.
    for (const control of this.controls) {
      if (had) control.renewed(token)
      else control.start()
    }
  }

  /** The profile changed, as when the host was renamed or no longer lets devices find it. */
  profileChanged(): void {
    for (const control of this.controls) void control.sendProfile()
  }

  /** Tries every relay now, as Retry does after a conflict or an error. */
  retry(): void {
    for (const control of this.controls) control.retry()
  }

  stop(): void {
    this.stopped = true
    if (this.regionTimer) clearTimeout(this.regionTimer)
    this.regionTimer = null
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = null
    for (const control of this.controls) control.close()
    for (const control of this.leaving) control.close()
    this.leaving.clear()
  }

  /** A region said it drains: passed over for a while, and left once its devices are gone. */
  drained(control: Control): void {
    const { region } = control
    if (region.url === relayOrigin(this.options.main)) return
    this.options.log('info', `Relay region ${region.id} is draining; signing in elsewhere`)
    this.draining.set(region.url, this.now() + this.timings.drainedMs)
    this.options.drained?.(region)
    this.apply()
  }

  /** A region left behind has no device joined through it, or waited long enough. */
  left(control: Control): void {
    if (!this.leaving.delete(control)) return
    control.close()
    this.legsChanged()
  }

  legsChanged(): void {
    this.options.legsChanged?.()
  }

  private async readRegions(): Promise<void> {
    const { main } = this.options
    try {
      const info = parseRelayInfo(await this.options.fetchInfo(`${main}${relayInfoPath()}`))
      if (!info) throw new Error('it is not a Kettu relay of this protocol')
      if (!this.stopped) {
        // A main relay that takes relay tokens gives its regions in the signed list, which the
        // plan brings with a relay token; the access token goes to the main relay alone.
        this.listed = info.features.includes(RELAY_TOKENS_FEATURE) ? [] : info.regions
        this.apply()
      }
    } catch (error) {
      // The list read before stays.
      this.options.log('warn', `Cannot read the relay regions: ${(error as Error).message}`)
    }
    if (this.stopped) return
    this.regionTimer = setTimeout(() => void this.readRegions(), this.timings.regionsMs)
  }

  /**
   * Signs in to each relay to use, keeping those it had; one no longer to use is left once no
   * device is joined through it.
   */
  private apply(): void {
    const now = this.now()
    for (const [url, until] of this.draining) if (until <= now) this.draining.delete(url)
    // Picks again once the first region passed over may be used, whatever else changes by then.
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = null
    if (this.draining.size > 0 && !this.stopped) {
      const next = Math.min(...this.draining.values())
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null
        this.apply()
      }, next - now)
    }
    const main = relayOrigin(this.options.main)
    const wanted = (this.plan ?? relayList(this.options.main, this.listed)).filter(
      (region) => region.url === main || !this.draining.has(region.url),
    )
    const next = wanted.slice(0, MAX_REGIONS)
    const kept: Control[] = []
    // A region whose pin changed is a new one: its socket was let through by the old pin.
    const sameRelay = (entry: Control, region: RelayRegion): boolean =>
      entry.region.url === region.url && entry.region.pin === region.pin
    for (const region of next) {
      let control = this.controls.find((entry) => sameRelay(entry, region))
      if (!control) {
        control = [...this.leaving].find((entry) => sameRelay(entry, region))
        if (control) {
          this.leaving.delete(control)
          control.stay()
        }
      }
      kept.push(control ?? new Control(this, region))
    }
    const same =
      kept.length === this.controls.length &&
      kept.every(
        (control, i) =>
          control === this.controls[i] &&
          next[i]!.id === control.region.id &&
          next[i]!.pin === control.region.pin,
      )
    if (same) return
    for (const control of this.controls) {
      if (kept.includes(control)) continue
      this.leaving.add(control)
      control.leave(this.timings.leaveMs)
    }
    kept.forEach((control, i) => (control.region = next[i]!))
    this.controls = kept
    if (this.started) for (const control of this.controls) control.start()
    this.options.changed()
    this.legsChanged()
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
