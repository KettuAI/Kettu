// Main's side of the remote host: it runs while remote access is on, and gets each device's session
// a port to the agent host.

import type { MessagePortMain } from 'electron'
import type {
  DirectStatus,
  MainToRemoteHost,
  RemoteHostStatus,
  RemoteHostStopReason,
  RemoteHostToMain,
} from '@shared/host-control'
import { isPort, parseDirectAddress } from '@shared/remote/address'
import { parsePortDevice, type NewDevice, type PortDevice } from '@shared/remote/device'
import type { DirectSettings } from '@shared/settings'
import remoteHostPath from '../remote-host/index?modulePath'
import { createLogger } from './log'
import type { RemoteIdentity } from './remote-identity'
import { UtilityHost } from './utility-host'

const log = createLogger('remote-host')

const MAX_DEVICES = 1000
const MAX_ADDRESSES = 64

export interface RemoteHostDeps {
  userDataPath: string
  appVersion: string
  /** The identity, made on first use; it rejects when the system cannot decrypt the key. */
  identity(): Promise<RemoteIdentity>
  /** The name devices show for this computer. */
  hostName(): string
  /** The direct connections' settings now. */
  direct(): DirectSettings
  /** A port to the agent host for a device's session, or null while it is not running. */
  openPort(device: PortDevice): MessagePortMain | null
}

function isDirectStatus(value: unknown): value is DirectStatus {
  if (typeof value !== 'object' || value === null) return false
  const { state, port, addresses, reason } = value as Record<string, unknown>
  if (state === 'off') return true
  if (state === 'failed') {
    return isPort(port) && ['port_in_use', 'not_permitted', 'other'].includes(reason as string)
  }
  return (
    state === 'listening' &&
    isPort(port) &&
    Array.isArray(addresses) &&
    addresses.length <= MAX_ADDRESSES &&
    addresses.every((address) => parseDirectAddress(address) !== null)
  )
}

function isStatus(value: unknown): value is RemoteHostStatus {
  if (typeof value !== 'object' || value === null) return false
  const { publicKey, plainTextKey, devices, online, refused, direct } = value as Record<
    string,
    unknown
  >
  return (
    typeof publicKey === 'string' &&
    typeof plainTextKey === 'boolean' &&
    Array.isArray(devices) &&
    devices.length <= MAX_DEVICES &&
    devices.every(
      (device: unknown) =>
        typeof device === 'object' &&
        device !== null &&
        typeof (device as { id?: unknown }).id === 'string' &&
        typeof (device as { name?: unknown }).name === 'string',
    ) &&
    Array.isArray(online) &&
    online.length <= MAX_DEVICES &&
    online.every((id) => typeof id === 'string') &&
    typeof refused === 'number' &&
    Number.isSafeInteger(refused) &&
    refused >= 0 &&
    isDirectStatus(direct)
  )
}

export class RemoteHost {
  private host: UtilityHost<MainToRemoteHost, RemoteHostToMain> | null = null
  private changes: Promise<void> = Promise.resolve()
  private latest: RemoteHostStatus | null = null
  private direct: string | null = null
  private quitting = false

  constructor(private readonly deps: RemoteHostDeps) {}

  /** What the remote host last reported, or null while it is not running. */
  get status(): RemoteHostStatus | null {
    return this.latest
  }

  /** Runs the host while the setting is on; the changes apply in the order they come. */
  setEnabled(enabled: boolean): Promise<void> {
    this.changes = this.changes.then(() => (enabled ? this.begin() : this.end('remote_off')))
    return this.changes
  }

  /** Tells every device why and stops for good, as when Kettu quits. */
  stop(): Promise<void> {
    this.quitting = true
    this.changes = this.changes.then(() => this.end('stopping'))
    return this.changes
  }

  /** Pairs a device; false while the host is not running. */
  addDevice(device: NewDevice): boolean {
    return this.host?.post({ type: 'remote-host:add-device', device }) ?? false
  }

  /** Forgets a device and ends its sessions; false while the host is not running. */
  removeDevice(id: string): boolean {
    return this.host?.post({ type: 'remote-host:remove-device', id }) ?? false
  }

  /** Passes the direct connections' settings on when they changed; each start reads them anew. */
  directChanged(): void {
    const direct = this.deps.direct()
    const sent = JSON.stringify(direct)
    if (!this.host || sent === this.direct) return
    if (this.host.post({ type: 'remote-host:direct', direct })) this.direct = sent
  }

  /** The computer woke from sleep: the host reads its addresses again. */
  resume(): void {
    this.host?.post({ type: 'remote-host:resume' })
  }

  private async begin(): Promise<void> {
    if (this.host || this.quitting) return
    let identity: RemoteIdentity
    try {
      identity = await this.deps.identity()
    } catch (error) {
      log.error('Remote access cannot start without its key', error)
      return
    }
    const host = new UtilityHost<MainToRemoteHost, RemoteHostToMain>({
      label: 'remote-host',
      modulePath: remoteHostPath,
      serviceName: 'Kettu Remote Host',
      initMessage: () => ({
        type: 'remote-host:init',
        userDataPath: this.deps.userDataPath,
        appVersion: this.deps.appVersion,
        platform: process.platform,
        hostName: this.deps.hostName(),
        privateKey: identity.privateKey,
        plainTextKey: identity.plainText,
        direct: this.initDirect(),
      }),
      shutdownMessage: { type: 'remote-host:shutdown', reason: 'stopping' },
      readyType: 'remote-host:ready',
      stoppedType: 'remote-host:stopped',
      onMessage: (message) => this.receive(host, message),
      onExit: () => {
        if (this.host === host) this.latest = null
      },
    })
    this.host = host
    host.start()
  }

  private initDirect(): DirectSettings {
    const direct = this.deps.direct()
    this.direct = JSON.stringify(direct)
    return direct
  }

  private async end(reason: RemoteHostStopReason): Promise<void> {
    const host = this.host
    if (!host) return
    this.host = null
    this.latest = null
    await host.stop(undefined, { type: 'remote-host:shutdown', reason })
  }

  private receive(
    host: UtilityHost<MainToRemoteHost, RemoteHostToMain>,
    message: RemoteHostToMain,
  ): void {
    switch (message.type) {
      case 'remote-host:open-port': {
        const device = parsePortDevice(message.device)
        if (!Number.isSafeInteger(message.requestId) || !device) {
          log.warn('Ignored a port request that names no device')
          return
        }
        const port = this.deps.openPort(device)
        const answer: MainToRemoteHost = { type: 'remote-host:port', requestId: message.requestId }
        if (!host.post(answer, port ? [port] : [])) port?.close()
        break
      }
      case 'remote-host:status':
        if (this.host === host && isStatus(message.status)) this.latest = message.status
        break
      case 'remote-host:log': {
        const text = typeof message.message === 'string' ? message.message : ''
        if (message.level === 'error') log.error(text)
        else if (message.level === 'warn') log.warn(text)
        else log.info(text)
        break
      }
      default:
        log.warn(`Ignored unknown message "${(message as { type: string }).type}"`)
    }
  }
}
