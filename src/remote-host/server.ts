// Device connections: each one answered as the Noise IK responder, then hello and welcome, then
// the device's session as a port to the agent host, whose protocol passes through unchanged.

import type { PortChannel } from '@shared/port-channel'
import { forbiddenToDevices } from '@shared/remote/allow-list'
import { Channel, type ChannelMessage } from '@shared/remote/channel'
import type { NewDevice, PairedDevice, PortDevice } from '@shared/remote/device'
import { Handshake, type KeyPair, type TransportCiphers } from '@shared/remote/noise'
import {
  negotiate,
  parseHello,
  type Addresses,
  type Closing,
  type ClosingReason,
  type DirectAddress,
  type Welcome,
} from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'
import type { LogFn } from '../agent-host/storage'
import type { DeviceStore } from './devices'

/** How long a connection has from being accepted to its hello. */
const HELLO_TIMEOUT_MS = 10_000

/** Refusals report at most once a second, so a flood of them does not flood main with statuses. */
const REFUSED_REPORT_MS = 1_000

export interface RemoteServerOptions {
  staticKey: KeyPair
  devices: DeviceStore
  host: Welcome['host']
  /** A port to the agent host for a device's session, or null while the agent host is down. */
  openAgentPort(device: PortDevice): Promise<PortChannel | null>
  /** The devices or the sessions open changed, or refusals did, reported at most once a second. */
  changed(): void
  log: LogFn
  helloTimeoutMs?: number
}

/** The host's side of every device connection. */
export class RemoteServer {
  private readonly connections = new Set<DeviceConnection>()
  private refusedCount = 0
  private refusedTimer: ReturnType<typeof setTimeout> | null = null
  private refusedUnreported = false
  private directAddresses: DirectAddress[] = []
  private stopped = false

  constructor(readonly options: RemoteServerOptions) {}

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
    if (added) this.options.changed()
    return added
  }

  /** Forgets a device and ends its sessions at once. */
  async removeDevice(id: string): Promise<boolean> {
    // The store forgets the device before its write, so no handshake accepts it meanwhile.
    const removing = this.options.devices.remove(id)
    const closing = [...this.connections]
      .filter((connection) => connection.device?.id === id)
      .map((connection) => connection.close('removed'))
    const removed = await removing
    await Promise.all(closing)
    if (removed) this.options.changed()
    return removed
  }

  /** Tells every device why, ends every connection and writes the devices' last connections. */
  async stop(reason: 'remote_off' | 'stopping'): Promise<void> {
    this.stopped = true
    if (this.refusedTimer) clearTimeout(this.refusedTimer)
    this.refusedTimer = null
    await Promise.all([...this.connections].map((connection) => connection.close(reason)))
    await this.options.devices.flush()
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
    this.options.changed()
  }

  ended(connection: DeviceConnection, wasOpen: boolean): void {
    this.connections.delete(connection)
    if (wasOpen) this.options.changed()
  }
}

type State = 'handshake' | 'hello' | 'opening' | 'open' | 'closing' | 'closed'

class DeviceConnection {
  device: PairedDevice | null = null
  private state: State = 'handshake'
  private channel: Channel | null = null
  private port: PortChannel | null = null
  private wasOpen = false
  private closing: Promise<void> | null = null
  private received = 0
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(
    private readonly transport: Transport,
    private readonly server: RemoteServer,
  ) {
    const { options } = server
    const handshake = Handshake.create({
      pattern: 'IK',
      role: 'responder',
      staticKey: options.staticKey,
      accept: (publicKey) => {
        this.device = options.devices.withKey(publicKey)
        return this.device !== null
      },
    })
    this.timer = setTimeout(() => this.end(), options.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
    transport.onClose(() => this.end())
    transport.onMessage((message) => {
      if (this.state === 'closed') return
      this.received++
      if (this.received === 1) void this.answer(handshake, message)
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

  private async answer(handshake: Promise<Handshake>, message: Uint8Array): Promise<void> {
    let reply: Uint8Array
    let ciphers: TransportCiphers
    try {
      const responder = await handshake
      await responder.readMessage(message)
      reply = await responder.writeMessage()
      ciphers = await responder.split()
    } catch {
      // An unknown key, or a first message that is not a handshake's: only counted, never logged
      // with the key or where it came from.
      this.server.refusedOne()
      return this.end()
    }
    if (this.state !== 'handshake') return
    this.channel = new Channel(ciphers, {
      write: (frame) => this.transport.send(frame),
      message: (channelMessage) => this.receive(channelMessage),
      end: () => this.end(),
    })
    this.state = 'hello'
    this.transport.send(reply)
  }

  private receive(message: ChannelMessage): void {
    // Byte streams come with uploads and media; until then they are dropped.
    if (message.kind !== 'json') return
    if (this.state === 'hello') void this.hello(message.value)
    // Nothing but the hello comes before the welcome.
    else if (this.state === 'opening') void this.close('invalid')
    else if (this.state === 'open') this.toHost(message.value)
  }

  private async hello(value: unknown): Promise<void> {
    const hello = parseHello(value)
    if (!hello) return this.close('invalid')
    clearTimeout(this.timer)
    const version = negotiate(hello.protocol)
    if (typeof version !== 'number') return this.close(version)
    // The device may have been removed since its handshake.
    const device = this.device && this.server.options.devices.get(this.device.id)
    if (!device) return this.close('removed')
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
      terminal: false,
      addresses: this.server.addresses,
    } satisfies Welcome)
    this.state = 'open'
    this.wasOpen = true
    port.onMessage((data) => this.send(data))
    port.onClose(() => void this.close('unavailable'))
    this.server.opened(device)
  }

  /** A request from the device, unless it is one a device may not make. */
  private toHost(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
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
    this.port?.send(value)
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
    this.server.ended(this, this.wasOpen)
  }
}
