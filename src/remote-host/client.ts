// The desktop app as a device of other hosts: one connection to each known host, kept up with
// backoff, and pairing with the host of a pasted link. Each welcomed connection's host protocol
// reaches main through a port of its own.

import type { PortChannel } from '@shared/port-channel'
import { normalizeDeviceName, isDeviceModel } from '@shared/remote/device'
import { startDeviceChannel, type DeviceChannel } from '@shared/remote/device-channel'
import {
  PAIR_HOST_TIMEOUT_MS,
  type HostConnection,
  type HostPairingFailure,
  type HostPairingState,
  type HostStatus,
  type KnownHost,
} from '@shared/remote/hosts'
import type { KeyPair } from '@shared/remote/noise'
import type { PairingPayload } from '@shared/remote/pairing'
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseAddresses,
  parseClosing,
  parseWelcome,
  type ClosingReason,
  type DirectAddress,
  type Hello,
  type Welcome,
} from '@shared/remote/protocol'
import type { LogFn } from '../agent-host/storage'
import { dial, type Connect } from './dial'
import { publicKeyBytes } from './devices'
import { connectTransport } from './direct'
import type { HostStore } from './hosts'

/** How long a known host has from the handshake to its welcome. */
const WELCOME_TIMEOUT_MS = 15_000

/** The longest wait between tries, which a host that needs an update also waits. */
const MAX_RETRY_MS = 60_000

/** Host protocol messages kept for main's port while it is on its way; more are dropped. */
const MAX_QUEUED = 1000

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
  retryDelay?: (failures: number) => number
  now?: () => number
}

type SessionEnd = { welcomed: boolean; reason: ClosingReason | null }

interface SessionHandlers {
  welcomed(welcome: Welcome): void
  addresses(addresses: DirectAddress[]): void
  renamed(name: string): void
  ended(end: SessionEnd): void
}

/** One connection to a host past its handshake: its welcome, then the host protocol around it. */
class HostSession {
  welcome: Welcome | null = null
  private handlers: SessionHandlers = IGNORED
  private reason: ClosingReason | null = null
  private port: PortChannel | null = null
  private readonly queued: unknown[] = []
  private over = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly channel: DeviceChannel,
    readonly address: DirectAddress,
    private readonly log: LogFn,
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
    void this.channel.closed.then(() => this.end())
  }

  /** Hands the session to whoever takes it from here, as a link takes a pairing's. */
  handOver(handlers: SessionHandlers): void {
    this.handlers = handlers
  }

  /** Main's port for the host protocol; what came before it goes first. */
  connectPort(port: PortChannel): void {
    if (this.over) return port.close()
    this.port = port
    port.onMessage((data) => {
      this.channel.send(data).catch((error: unknown) => {
        this.log('warn', `A message for a host could not be sent: ${(error as Error).message}`)
      })
    })
    for (const value of this.queued.splice(0)) port.send(value)
  }

  send(value: unknown): void {
    this.channel.send(value).catch(() => {})
  }

  close(): void {
    this.channel.close()
  }

  private receive(value: unknown): void {
    if (this.over) return
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
      return this.handlers.welcomed(welcome)
    }
    const fields = value as Record<string, unknown>
    if (type === 'addresses') return this.handlers.addresses(parseAddresses(fields.addresses))
    if (type === 'renamed') {
      const name = normalizeDeviceName(fields.name)
      if (name) this.handlers.renamed(name)
      return
    }
    if (this.port) this.port.send(value)
    else if (this.queued.length < MAX_QUEUED) this.queued.push(value)
  }

  private end(): void {
    if (this.over) return
    this.over = true
    if (this.timer) clearTimeout(this.timer)
    this.port?.close()
    this.port = null
    this.queued.length = 0
    this.handlers.ended({ welcomed: this.welcome !== null, reason: this.reason })
  }
}

const IGNORED: SessionHandlers = {
  welcomed: () => {},
  addresses: () => {},
  renamed: () => {},
  ended: () => {},
}

/** The connection to one known host, tried again with backoff until it is forgotten. */
class HostLink {
  connection: HostConnection = { state: 'connecting' }
  private session: HostSession | null = null
  private trying: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private closed = false

  constructor(
    private readonly client: HostClient,
    readonly id: string,
  ) {}

  private get host(): KnownHost | null {
    return this.client.options.hosts.get(this.id)
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
    session.handOver(this.handlersFor(session))
    if (session.open) this.welcomed(session, session.welcome!)
    else this.ended({ welcomed: true, reason: null })
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

  /** Forgotten, or the client stops: the connection ends and is not tried again. */
  close(): void {
    this.closed = true
    this.cancel()
    this.drop()
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
    session?.close()
  }

  private async connect(): Promise<void> {
    const host = this.host
    if (this.closed || this.session || this.trying || !host || host.removed) return
    const { options } = this.client
    const trying = (this.trying = new AbortController())
    const hostKey = publicKeyBytes(host.publicKey)!
    const result = await dial({
      addresses: host.addresses,
      connect: this.client.connect,
      start: (transport) =>
        startDeviceChannel({ transport, hostKey, key: options.key, hello: this.client.hello() }),
      timeoutMs: this.client.timeoutMs,
      signal: trying.signal,
    })
    if (this.trying !== trying) {
      if (result.kind === 'open') result.channel.close()
      return
    }
    this.trying = null
    if (result.kind === 'aborted') return
    if (result.kind !== 'open') return this.failed()
    const session = new HostSession(result.channel, result.address, options.log)
    this.session = session
    session.start(this.handlersFor(session), WELCOME_TIMEOUT_MS)
  }

  private handlersFor(session: HostSession): SessionHandlers {
    const mine = (): boolean => this.session === session
    return {
      welcomed: (welcome) => {
        if (mine()) this.welcomed(session, welcome)
      },
      addresses: (addresses) => {
        if (mine()) this.addresses(addresses, session.address)
      },
      renamed: (name) => {
        if (!mine()) return
        this.client.options.hosts.update(this.id, { deviceName: name })
        this.client.options.changed()
      },
      ended: (end) => {
        if (!mine()) return
        this.session = null
        this.ended(end)
      },
    }
  }

  private welcomed(session: HostSession, welcome: Welcome): void {
    const { hosts, now } = this.client.options
    hosts.update(this.id, {
      name: welcome.host.name,
      platform: welcome.host.platform,
      version: welcome.host.version,
      deviceName: welcome.device.name,
      addresses: merged(session.address, welcome.addresses, this.host?.addresses ?? []),
      lastOnlineAt: (now ?? Date.now)(),
      removed: false,
    })
    this.failures = 0
    this.set({ state: 'online', address: session.address })
    void this.openPort(session)
  }

  private async openPort(session: HostSession): Promise<void> {
    const port = (await this.client.options.openMainPort?.(this.id).catch(() => null)) ?? null
    if (!port) return
    if (this.session === session && session.open) session.connectPort(port)
    else port.close()
  }

  private addresses(addresses: DirectAddress[], answered: DirectAddress): void {
    const host = this.host
    if (!host) return
    this.client.options.hosts.update(this.id, {
      addresses: merged(answered, addresses, host.addresses),
    })
    this.client.options.changed()
  }

  private ended({ welcomed, reason }: SessionEnd): void {
    if (this.closed) return
    const { hosts } = this.client.options
    if (welcomed) hosts.online(this.id)
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

  private failed(): void {
    this.failures++
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
    const session = new HostSession(result.channel, result.address, options.log)
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

export class HostClient {
  readonly connect: Connect
  readonly timeoutMs: number
  readonly retryDelay: (failures: number) => number
  private readonly links = new Map<string, HostLink>()
  private readonly pairings = new Map<number, Pairing>()
  private stopped = false

  constructor(readonly options: HostClientOptions) {
    this.connect = options.connect ?? connectTransport
    this.timeoutMs = options.timeoutMs ?? PAIR_HOST_TIMEOUT_MS
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

  closePairing(pairId: number): void {
    this.pairings.get(pairId)?.close()
  }

  /** Renames this computer on a host it is connected to; false when it is not. */
  rename(id: string, name: string): boolean {
    return this.links.get(id)?.rename(name) ?? false
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

  ended(pairing: Pairing): void {
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
