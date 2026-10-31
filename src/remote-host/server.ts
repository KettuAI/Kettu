// Device connections: each one answered as the Noise IK responder, or as the IKpsk1 responder of
// the open pairing code, then hello and welcome, then the device's session as a port to the agent
// host, whose protocol passes through unchanged.

import type { PortChannel } from '@shared/port-channel'
import type { ActivityActor, NewActivity } from '@shared/remote/activity'
import { forbiddenToDevices } from '@shared/remote/allow-list'
import { Channel, type ChannelMessage } from '@shared/remote/channel'
import {
  normalizeDeviceName,
  type NewDevice,
  type PairedDevice,
  type PortDevice,
} from '@shared/remote/device'
import { Handshake, type KeyPair, type TransportCiphers } from '@shared/remote/noise'
import {
  negotiate,
  parseHello,
  type Addresses,
  type Closing,
  type ClosingReason,
  type DirectAddress,
  type Hello,
  type Renamed,
  type Welcome,
} from '@shared/remote/protocol'
import { removalAt } from '@shared/remote/status'
import type { Transport } from '@shared/remote/transport'
import type { LogFn } from '../agent-host/storage'
import type { ActivityLog } from './activity'
import type { DeviceStore } from './devices'
import type { PairingCode, PairingCodes } from './pairing'
import { SessionTitles } from './titles'

/** How long a connection has from being accepted to its hello. */
const HELLO_TIMEOUT_MS = 10_000

/** Refusals report at most once a second, so a flood of them does not flood main with statuses. */
const REFUSED_REPORT_MS = 1_000
/** How often devices not seen for 90 days are looked for. */
const SWEEP_MS = 60 * 60 * 1000

/** Requests whose success a device's activity notes, by method. */
const NOTED = {
  'sessions.create': 'session-created',
  'sessions.archive': 'session-archived',
  'sessions.delete': 'session-deleted',
} as const

/** The requests of one connection waiting for an answer to note; more are not noted. */
const MAX_NOTED = 64

type NotedKind = (typeof NOTED)[keyof typeof NOTED]

type Summary = { id?: unknown; title?: unknown }

const MAX_HOST_NAME = 256

export interface RemoteServerOptions {
  staticKey: KeyPair
  devices: DeviceStore
  activity: ActivityLog
  pairing: PairingCodes
  host: Welcome['host']
  /** A port to the agent host for a device's session, or null while the agent host is down. */
  openAgentPort(device: PortDevice): Promise<PortChannel | null>
  /** The devices or the sessions open changed, or refusals did, reported at most once a second. */
  changed(): void
  log: LogFn
  helloTimeoutMs?: number
  now?: () => number
}

/** The host's side of every device connection. */
export class RemoteServer {
  private readonly connections = new Set<DeviceConnection>()
  private refusedCount = 0
  private refusedTimer: ReturnType<typeof setTimeout> | null = null
  private refusedUnreported = false
  private directAddresses: DirectAddress[] = []
  private stopped = false
  private sweeper: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(readonly options: RemoteServerOptions) {
    this.now = options.now ?? Date.now
  }

  /** Takes a device's connection, which ends at its first message unless that names a device. */
  accept(transport: Transport): void {
    if (this.stopped) return transport.close()
    this.connections.add(new DeviceConnection(transport, this))
  }

  /** Connections refused, at their first message or by the direct listener's limits. */
  get refused(): number {
    return this.refusedCount
  }

  /** Where devices may connect directly: in each welcome, and sent again when it changes. */
  get addresses(): DirectAddress[] {
    return this.directAddresses
  }

  setAddresses(addresses: DirectAddress[]): void {
    if (JSON.stringify(addresses) === JSON.stringify(this.directAddresses)) return
    this.directAddresses = addresses.map(({ host, port }) => ({ host, port }))
    for (const connection of this.connections) connection.sendAddresses(this.directAddresses)
  }

  /** The ids of the devices with a session open now. */
  online(): string[] {
    const ids = new Set<string>()
    for (const connection of this.connections) {
      if (connection.open && connection.device) ids.add(connection.device.id)
    }
    return [...ids]
  }

  async addDevice(device: NewDevice): Promise<PairedDevice | null> {
    const added = await this.options.devices.add(device)
    if (added) {
      this.options.activity.record(added.id, { kind: 'paired' })
      this.options.changed()
    }
    return added
  }

  /** Forgets a device and ends its sessions at once. */
  async removeDevice(id: string, by: 'owner' | 'unseen' | 'reset' = 'owner'): Promise<boolean> {
    // The store forgets the device before its write, so no handshake accepts it meanwhile.
    const removing = this.options.devices.remove(id)
    const closing = [...this.connections]
      .filter((connection) => connection.device?.id === id)
      .map((connection) => connection.close('removed'))
    const removed = await removing
    await Promise.all(closing)
    if (removed) {
      this.options.activity.record(id, { kind: 'removed', by })
      this.options.changed()
    }
    return removed
  }

  /**
   * Renames a device and tells its open sessions; null when there is no such device or nothing
   * of the name is left once it is cleaned up.
   */
  async renameDevice(id: string, name: unknown, by: ActivityActor): Promise<PairedDevice | null> {
    const kept = normalizeDeviceName(name)
    const before = this.options.devices.get(id)
    if (!kept || !before) return null
    if (kept === before.name) return before
    const renamed = await this.options.devices.rename(id, kept)
    if (!renamed) return null
    this.options.activity.record(id, { kind: 'renamed', from: before.name, to: kept, by })
    for (const connection of this.connections) {
      if (connection.device?.id === id) connection.renamed(kept)
    }
    this.options.changed()
    return renamed
  }

  /** The name the next welcomes carry. */
  setHostName(name: string): void {
    if (name.length > 0 && name.length <= MAX_HOST_NAME) {
      this.options.host = { ...this.options.host, name }
    }
  }

  /** Looks for devices not seen for 90 days now and then every hour, until the server stops. */
  startSweeping(): void {
    if (this.sweeper || this.stopped) return
    void this.sweep()
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS)
  }

  /** Removes the devices not seen for 90 days; one with a session open now is seen. */
  async sweep(): Promise<void> {
    const online = new Set(this.online())
    const now = this.now()
    for (const device of this.options.devices.list()) {
      if (!online.has(device.id) && removalAt(device) <= now) {
        await this.removeDevice(device.id, 'unseen')
      }
    }
  }

  /** Removes every device and voids the code, for main to make a new identity. */
  async reset(): Promise<void> {
    this.options.pairing.stop()
    for (const device of this.options.devices.list()) await this.removeDevice(device.id, 'reset')
    await Promise.all([this.options.devices.flush(), this.options.activity.flush()])
  }

  /** Tells every device why, ends every connection and writes the devices' last connections. */
  async stop(reason: 'remote_off' | 'stopping'): Promise<void> {
    this.stopped = true
    if (this.refusedTimer) clearTimeout(this.refusedTimer)
    this.refusedTimer = null
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    this.options.pairing.stop()
    await Promise.all([...this.connections].map((connection) => connection.close(reason)))
    await Promise.all([this.options.devices.flush(), this.options.activity.flush()])
  }

  note(id: string, event: NewActivity): void {
    this.options.activity.record(id, event)
  }

  refusedOne(): void {
    this.refusedCount++
    if (this.refusedTimer) {
      this.refusedUnreported = true
      return
    }
    this.options.changed()
    this.refusedTimer = setTimeout(() => this.reportRefused(), REFUSED_REPORT_MS)
  }

  private reportRefused(): void {
    this.refusedTimer = null
    if (!this.refusedUnreported || this.stopped) return
    this.refusedUnreported = false
    this.options.changed()
    this.refusedTimer = setTimeout(() => this.reportRefused(), REFUSED_REPORT_MS)
  }

  opened(device: PairedDevice): void {
    this.options.devices.connected(device.id)
    this.options.activity.opened(device.id)
    this.options.changed()
  }

  ended(connection: DeviceConnection, device: PairedDevice | null): void {
    this.connections.delete(connection)
    if (!device) return
    // Last connected is when the session ended, so a device online for months is not unseen.
    this.options.devices.connected(device.id)
    this.options.activity.closed(device.id)
    this.options.changed()
  }
}

type State = 'handshake' | 'hello' | 'confirming' | 'opening' | 'open' | 'closing' | 'closed'

class DeviceConnection {
  device: PairedDevice | null = null
  private state: State = 'handshake'
  private channel: Channel | null = null
  private port: PortChannel | null = null
  private wasOpen = false
  private closing: Promise<void> | null = null
  private received = 0
  private readonly timer: ReturnType<typeof setTimeout>
  /** The code this connection's handshake used, and the key it revealed, until it is added. */
  private pairing: { code: PairingCode; publicKey: Uint8Array } | null = null
  /** False once the first message named a key, so it was no attempt at the pairing code. */
  private mayPair = true
  /** Requests to note in the device's activity once they succeed, by id, with the title then. */
  private readonly noted = new Map<
    number,
    { kind: NotedKind; sessionId: unknown; title: string | null }
  >()
  private readonly titles = new SessionTitles()

  constructor(
    private readonly transport: Transport,
    private readonly server: RemoteServer,
  ) {
    const { options } = server
    this.timer = setTimeout(() => this.end(), options.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
    transport.onClose(() => this.end())
    transport.onMessage((message) => {
      if (this.state === 'closed') return
      this.received++
      if (this.received === 1) void this.answer(message)
      // The device can write a frame only after the host's answer, which follows the channel.
      else if (this.channel) void this.channel.receive(message)
      else this.end()
    })
  }

  get open(): boolean {
    return this.state === 'open'
  }

  sendAddresses(addresses: DirectAddress[]): void {
    if (this.state === 'open') this.send({ type: 'addresses', addresses } satisfies Addresses)
  }

  /** Ends the connection, after telling the device why once the channel is up. */
  close(reason: ClosingReason): Promise<void> {
    if (this.state === 'closing' || this.state === 'closed') {
      return this.closing ?? Promise.resolve()
    }
    this.state = 'closing'
    this.closing = this.sayClosing(reason)
    return this.closing
  }

  /** The device's name changed: its sessions hear the new one. */
  renamed(name: string): void {
    if (!this.device) return
    this.device = { ...this.device, name }
    if (this.state === 'open') this.send({ type: 'renamed', name } satisfies Renamed)
  }

  private async answer(message: Uint8Array): Promise<void> {
    const responder = (await this.known(message)) ?? (await this.pair(message))
    let reply: Uint8Array
    let ciphers: TransportCiphers
    try {
      if (!responder) throw new Error('Refused')
      reply = await responder.writeMessage()
      ciphers = await responder.split()
    } catch {
      // An unknown key, or a first message that is not a handshake's: only counted, never logged
      // with the key or where it came from.
      this.server.refusedOne()
      return this.end()
    }
    if (this.state !== 'handshake') {
      // The connection ended while its handshake was read, after it claimed the code.
      if (this.pairing) this.server.options.pairing.release(this.pairing.code)
      return
    }
    this.channel = new Channel(ciphers, {
      write: (frame) => this.transport.send(frame),
      message: (channelMessage) => this.receive(channelMessage),
      end: () => this.end(),
    })
    this.state = 'hello'
    this.transport.send(reply)
  }

  /** The first message as a paired device's Noise IK, or null. */
  private async known(message: Uint8Array): Promise<Handshake | null> {
    const { options } = this.server
    let named = false
    try {
      const responder = await Handshake.create({
        pattern: 'IK',
        role: 'responder',
        staticKey: options.staticKey,
        accept: (publicKey) => {
          named = true
          this.device = options.devices.withKey(publicKey)
          return this.device !== null
        },
      })
      await responder.readMessage(message)
      return responder
    } catch {
      this.device = null
      // An IK handshake from a key the host does not know, as a removed device's, is no attempt at
      // the code: only a message that did not decrypt as IK may be pairing.
      if (named) this.mayPair = false
      return null
    }
  }

  /** The first message as Noise IKpsk1 with the open code's secret, or null. */
  private async pair(message: Uint8Array): Promise<Handshake | null> {
    const { options } = this.server
    const code = this.mayPair ? options.pairing.current() : null
    if (!code) return null
    let publicKey: Uint8Array | null = null
    try {
      const responder = await Handshake.create({
        pattern: 'IKpsk1',
        role: 'responder',
        staticKey: options.staticKey,
        psk: code.secret,
        // Any key may pair; nothing is trusted until the message's last tag shows the secret.
        accept: (key) => {
          publicKey = key
          return true
        },
      })
      await responder.readMessage(message)
      if (!publicKey || !options.pairing.claim(code)) return null
      this.pairing = { code, publicKey }
      return responder
    } catch {
      options.pairing.failed(code)
      return null
    }
  }

  private receive(message: ChannelMessage): void {
    // Byte streams come with uploads and media; until then they are dropped.
    if (message.kind !== 'json') return
    if (this.state === 'hello') void this.hello(message.value)
    // Nothing but the hello comes before the welcome.
    else if (this.state === 'confirming' || this.state === 'opening') void this.close('invalid')
    else if (this.state === 'open') this.fromDevice(message.value)
  }

  private async hello(value: unknown): Promise<void> {
    const hello = parseHello(value)
    if (!hello) return this.failPairing('invalid')
    clearTimeout(this.timer)
    const version = negotiate(hello.protocol)
    if (typeof version !== 'number') return this.failPairing(version)
    // The device may have been removed since its handshake.
    const device = this.pairing
      ? await this.confirm(hello)
      : this.device && this.server.options.devices.get(this.device.id)
    if (this.state !== 'hello' && this.state !== 'confirming') return
    if (!device) return this.close(this.pairing ? 'invalid' : 'removed')
    this.device = device
    this.state = 'opening'
    const port = await this.server.options.openAgentPort({ id: device.id, name: device.name })
    if (this.state !== 'opening') return port?.close()
    if (!port) return this.close('unavailable')
    this.port = port
    // Sent before the port's listener is set, so nothing from the agent host comes before it.
    this.send({
      type: 'welcome',
      protocol: version,
      host: this.server.options.host,
      features: [],
      role: 'owner',
      device: { id: device.id, name: device.name },
      terminal: false,
      addresses: this.server.addresses,
    } satisfies Welcome)
    this.state = 'open'
    this.wasOpen = true
    port.onMessage((data) => {
      this.fromHost(data)
      this.send(data)
    })
    port.onClose(() => void this.close('unavailable'))
    this.server.opened(device)
  }

  /**
   * Asks whoever opened the code whether to add the device whose secret checked out; the device
   * as added, or null when it was not.
   */
  private async confirm(hello: Hello): Promise<PairedDevice | null> {
    const { code, publicKey } = this.pairing!
    const { options } = this.server
    if (!hello.device) {
      this.failPairing('invalid')
      return null
    }
    this.state = 'confirming'
    const { name, model } = hello.device
    const { kind, platform } = hello.client
    const answer = await options.pairing.ask(code, {
      name,
      model,
      kind,
      platform,
      known: options.devices.withKey(publicKey) !== null,
    })
    if (this.state !== 'confirming') return null
    if (!answer?.add) {
      void this.close('rejected')
      return null
    }
    const added = await this.server.addDevice({
      publicKey: Buffer.from(publicKey).toString('base64'),
      name: normalizeDeviceName(answer.name) ?? name,
      model,
      kind,
      platform,
    })
    if (!added || this.state !== 'confirming') return null
    options.pairing.added(code, added)
    this.pairing = null
    return added
  }

  /** Closes the connection; a pairing one also spends one of its code's attempts. */
  private failPairing(reason: ClosingReason): Promise<void> {
    const code = this.pairing?.code
    const closed = this.close(reason)
    if (!code) return closed
    return closed.then(() => this.server.options.pairing.failed(code))
  }

  /** A message from the device once welcomed. */
  private fromDevice(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const { type, name } = value as Record<string, unknown>
    if (type === 'rename') {
      void this.server.renameDevice(this.device!.id, name, 'device').then((renamed) => {
        if (!renamed) {
          this.server.options.log('warn', `Device ${this.device?.id} asked for a name that is none`)
        }
      })
      return
    }
    this.toHost(value)
  }

  /** A request from the device, unless it is one a device may not make. */
  private toHost(value: object): void {
    const { type, id, method, params } = value as Record<string, unknown>
    // Only requests reach the agent host; anything else a newer device sends is dropped.
    if (type !== 'request') return
    if (typeof method === 'string' && forbiddenToDevices(method, params)) {
      this.server.options.log(
        'warn',
        `Device ${this.device!.id} asked for ${method}, which devices may not call`,
      )
      if (typeof id === 'number') {
        this.send({
          type: 'error',
          id,
          error: { code: 'forbidden', message: `A paired device may not call "${method}"` },
        })
      }
      return
    }
    this.titles.request(id, method)
    if (typeof id === 'number' && Object.hasOwn(NOTED, method as string)) {
      const kind = NOTED[method as keyof typeof NOTED]
      const sessionId = (params as { sessionId?: unknown } | null)?.sessionId
      const title = this.titles.get(sessionId) ?? null
      if (this.noted.size < MAX_NOTED) this.noted.set(id, { kind, sessionId, title })
    }
    this.port?.send(value)
  }

  /**
   * Keeps the titles the device is told, and notes the requests of `NOTED` the agent host
   * answered, before the answer goes on.
   */
  private fromHost(data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const { type, id, result } = data as Record<string, unknown>
    this.titles.received(data as Record<string, unknown>)
    if (this.noted.size === 0) return
    if ((type !== 'response' && type !== 'error') || typeof id !== 'number') return
    const noted = this.noted.get(id)
    if (!noted) return
    this.noted.delete(id)
    // A new session's id and title are in the answer, the others' in the request.
    const created = noted.kind === 'session-created' ? (result as Summary | null) : null
    const sessionId = created ? created.id : noted.sessionId
    const title = created ? (typeof created.title === 'string' ? created.title : null) : noted.title
    if (type === 'response' && typeof sessionId === 'string' && this.device) {
      this.server.note(this.device.id, { kind: noted.kind, sessionId, title })
    }
  }

  private send(value: unknown): void {
    const channel = this.channel
    if (!channel) return
    channel.send({ kind: 'json', value }).catch((error: unknown) => {
      if (this.state === 'closed') return
      const { type, id } = value as { type?: unknown; id?: unknown }
      this.server.options.log(
        'warn',
        `A message for device ${this.device?.id} could not be sent: ${(error as Error).message}`,
      )
      // A response too long for the channel still tells the device its request failed.
      if ((type === 'response' || type === 'error') && typeof id === 'number') {
        const message = 'The answer is too long for the connection'
        const failed = { type: 'error', id, error: { code: 'internal', message } }
        channel.send({ kind: 'json', value: failed }).catch(() => {})
      }
    })
  }

  private async sayClosing(reason: ClosingReason): Promise<void> {
    const port = this.port
    this.port = null
    port?.close()
    if (this.channel) {
      const closing: Closing = { type: 'closing', reason }
      await this.channel.send({ kind: 'json', value: closing }).catch(() => {})
    }
    this.end()
  }

  private end(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    clearTimeout(this.timer)
    const port = this.port
    this.port = null
    port?.close()
    this.transport.close()
    if (this.pairing) this.server.options.pairing.release(this.pairing.code)
    this.server.ended(this, this.wasOpen ? this.device : null)
  }
}
