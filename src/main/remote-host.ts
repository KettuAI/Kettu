// Main's side of the remote host: it runs while remote access is on, gets each device's session a
// port to the agent host, and relays a pairing code's progress to whoever opened Add device.

import type { MessagePortMain } from 'electron'
import type {
  DirectStatus,
  MainToRemoteHost,
  RemoteHostStatus,
  RemoteHostStopReason,
  RemoteHostToMain,
} from '@shared/host-control'
import type { DeviceActivity } from '@shared/remote/activity'
import { isPort, parseDirectAddress } from '@shared/remote/address'
import { parsePortDevice, type NewDevice, type PortDevice } from '@shared/remote/device'
import { isPairingState, type PairingState } from '@shared/remote/pairing'
import type { DirectSettings } from '@shared/settings'
import remoteHostPath from '../remote-host/index?modulePath'
import { createLogger } from './log'
import type { RemoteIdentity } from './remote-identity'
import { UtilityHost } from './utility-host'

const log = createLogger('remote-host')

const MAX_DEVICES = 1000
const MAX_ADDRESSES = 64
const MAX_ACTIVITY = 500
/** How long a request to the remote host may take before it answers with nothing. */
const REQUEST_TIMEOUT_MS = 10_000

export interface RemoteHostDeps {
  userDataPath: string
  appVersion: string
  /** The identity, made on first use; it rejects when the system cannot decrypt the key. */
  identity(): Promise<RemoteIdentity>
  /** Replaces the identity with a new one, after the remote host removed every device. */
  newIdentity(): Promise<unknown>
  /** The name devices show for this computer. */
  hostName(): string
  /** The direct connections' settings now. */
  direct(): DirectSettings
  /** A port to the agent host for a device's session, or null while it is not running. */
  openPort(device: PortDevice): MessagePortMain | null
  /** The state or the report changed, for Settings and the tray. */
  changed?(): void
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

/** Whoever opened Add device hears its code's progress. */
export type PairingListener = (pairing: PairingState) => void

export type RemoteHostState = 'off' | 'starting' | 'on' | 'failed'

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
  private failed = false
  private readonly askers = new Map<number, PairingListener>()
  private nextCode = 1
  private readonly requests = new Map<number, (message: RemoteHostToMain | null) => void>()
  private nextRequest = 1

  constructor(private readonly deps: RemoteHostDeps) {}

  /** What the remote host last reported, or null while it is not running. */
  get status(): RemoteHostStatus | null {
    return this.latest
  }

  get state(): RemoteHostState {
    if (this.failed) return 'failed'
    if (!this.host) return 'off'
    return this.latest ? 'on' : 'starting'
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

  /** Passes the same settings on again, so a port that could not be opened is tried again. */
  retryDirect(): void {
    const direct = this.deps.direct()
    if (this.host?.post({ type: 'remote-host:direct', direct }))
      this.direct = JSON.stringify(direct)
  }

  /** The computer woke from sleep: the host reads its addresses again. */
  resume(): void {
    this.host?.post({ type: 'remote-host:resume' })
  }

  /** Renames a device, which its sessions hear; false while the host is not running. */
  renameDevice(id: string, name: string): boolean {
    return this.host?.post({ type: 'remote-host:rename-device', id, name }) ?? false
  }

  /** The name the next welcomes carry. */
  setHostName(name: string): void {
    this.host?.post({ type: 'remote-host:host-name', name })
  }

  /**
   * Opens a pairing code, voiding any other; `listener` hears its progress until it is added or
   * void. The code's id, or null while the host is not running.
   */
  pair(listener: PairingListener): number | null {
    const codeId = this.nextCode++
    if (!this.host?.post({ type: 'remote-host:pair', codeId })) return null
    this.askers.set(codeId, listener)
    return codeId
  }

  /** Add device closed, which voids its code. */
  closePairing(codeId: number): void {
    if (!this.askers.delete(codeId)) return
    this.host?.post({ type: 'remote-host:pair-close', codeId })
  }

  /** The answer to the device the code's listener was asked about. */
  answerPairing(codeId: number, add: boolean, name: string): void {
    if (!this.askers.has(codeId)) return
    this.host?.post({ type: 'remote-host:pair-answer', codeId, add, name })
  }

  /** A device's activity, newest first; none while the host is not running. */
  async activity(id: string): Promise<DeviceActivity[]> {
    const answer = await this.request((requestId) => ({
      type: 'remote-host:activity',
      requestId,
      id,
    }))
    if (answer?.type !== 'remote-host:activity' || !Array.isArray(answer.events)) return []
    return answer.events.slice(0, MAX_ACTIVITY)
  }

  /**
   * Removes every device, telling each, and gives the host a new identity, so every device has to
   * pair again. Rejects while remote access is not on.
   */
  reset(): Promise<void> {
    const run = this.changes.then(async () => {
      if (!this.host || !this.latest) throw new Error('Remote access is not on')
      const answer = await this.request((requestId) => ({ type: 'remote-host:reset', requestId }))
      if (!answer) throw new Error('The remote host did not reset')
      await this.end('remote_off')
      await this.deps.newIdentity()
      await this.begin()
    })
    this.changes = run.catch(() => {})
    return run
  }

  private request(
    message: (requestId: number) => MainToRemoteHost,
  ): Promise<RemoteHostToMain | null> {
    const requestId = this.nextRequest++
    return new Promise((resolve) => {
      const timer = setTimeout(() => answer(null), REQUEST_TIMEOUT_MS)
      const answer = (reply: RemoteHostToMain | null): void => {
        clearTimeout(timer)
        this.requests.delete(requestId)
        resolve(reply)
      }
      this.requests.set(requestId, answer)
      if (!this.host?.post(message(requestId))) answer(null)
    })
  }

  private async begin(): Promise<void> {
    if (this.host || this.quitting) return
    let identity: RemoteIdentity
    try {
      identity = await this.deps.identity()
    } catch (error) {
      log.error('Remote access cannot start without its key', error)
      this.failed = true
      this.deps.changed?.()
      return
    }
    this.failed = false
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
        if (this.host !== host) return
        this.latest = null
        this.lost()
      },
    })
    this.host = host
    host.start()
    this.deps.changed?.()
  }

  private initDirect(): DirectSettings {
    const direct = this.deps.direct()
    this.direct = JSON.stringify(direct)
    return direct
  }

  private async end(reason: RemoteHostStopReason): Promise<void> {
    this.failed = false
    const host = this.host
    if (!host) return this.deps.changed?.()
    this.host = null
    this.latest = null
    this.lost()
    await host.stop(undefined, { type: 'remote-host:shutdown', reason })
  }

  /** The remote host's process is gone: its codes and the requests it had not answered with it. */
  private lost(): void {
    for (const listener of this.askers.values()) listener({ state: 'void', reason: 'stopped' })
    this.askers.clear()
    for (const answer of [...this.requests.values()]) answer(null)
    this.deps.changed?.()
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
        if (this.host === host && isStatus(message.status)) {
          this.latest = message.status
          this.deps.changed?.()
        }
        break
      case 'remote-host:pairing': {
        const listener = this.host === host ? this.askers.get(message.codeId) : undefined
        if (!listener || !isPairingState(message.pairing)) break
        const { pairing } = message
        // A code ends once added or void; a new one has an id of its own.
        if (pairing.state === 'added' || pairing.state === 'void') {
          this.askers.delete(message.codeId)
        }
        listener(pairing)
        break
      }
      case 'remote-host:activity':
      case 'remote-host:reset':
        if (this.host === host) this.requests.get(message.requestId)?.(message)
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
