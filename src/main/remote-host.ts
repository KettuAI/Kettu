// Main's side of the remote host: it runs while remote access is on, while this computer knows
// another host or while Add host pairs with one. It gets each device's session a port to the
// agent host, takes each other host's session on a port of its own, and relays a pairing's
// progress to whoever opened Add device or Add host.

import { MessageChannelMain, type MessagePortMain } from 'electron'
import type {
  MainToRemoteHost,
  RemoteHostStatus,
  RemoteHostStopReason,
  RemoteHostToMain,
} from '@shared/host-control'
import type { DeviceActivity } from '@shared/remote/activity'
import { isDirectStatus } from '@shared/remote/address'
import { parsePortDevice, type NewDevice, type PortDevice } from '@shared/remote/device'
import {
  parseHostPairingState,
  parseHostStatus,
  type HostPairingState,
  type HostStatus,
} from '@shared/remote/hosts'
import { isPairingState, type PairingState } from '@shared/remote/pairing'
import type { DirectAddress } from '@shared/remote/protocol'
import type { DirectSettings } from '@shared/settings'
import remoteHostPath from '../remote-host/index?modulePath'
import { createLogger } from './log'
import type { RemoteIdentity } from './remote-identity'
import { UtilityHost } from './utility-host'

const log = createLogger('remote-host')

const MAX_DEVICES = 1000
const MAX_HOSTS = 100
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
  /** The key this computer connects to other hosts with, made on first use; rejects like it. */
  deviceKey(): Promise<RemoteIdentity>
  /** The system as this computer's hello names it, such as "macOS 26.1". */
  devicePlatform(): Promise<string>
  /** Whether the data folder lists any host this computer was added to; read once at launch. */
  hostsKnown(): Promise<boolean>
  /** The name devices show for this computer, and the one it suggests to a host. */
  hostName(): string
  /** The direct connections' settings now. */
  direct(): DirectSettings
  /** A port to the agent host for a device's session, or null while it is not running. */
  openPort(device: PortDevice): MessagePortMain | null
  /** The state or the report changed, for Settings and the tray. */
  changed?(): void
  /** The known hosts, their connections or the device key changed, for Settings › Hosts. */
  hostsChanged?(): void
}

/** Whoever opened Add device hears its code's progress. */
export type PairingListener = (pairing: PairingState) => void

/** Whoever pasted a link into Add host hears how pairing with its host goes, under its id. */
export type HostPairingListener = (pairId: number, pairing: HostPairingState) => void

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
  private ownKey: string | null = null
  private direct: string | null = null
  private quitting = false
  private failed = false
  /** The setting: whether this computer serves devices. */
  private enabled = false
  /** Whether the running process serves them, with `identity`'s key. */
  private serving = false
  private identity: RemoteIdentity | null = null
  private device: RemoteIdentity | null = null
  private deviceFailed = false
  private platform = ''
  private launchRead: Promise<void> | null = null
  private known = false
  private hostList: HostStatus[] | null = null
  private readonly hostPorts = new Map<string, MessagePortMain>()
  private readonly askers = new Map<number, PairingListener>()
  private nextCode = 1
  private readonly hostPairings = new Map<number, HostPairingListener>()
  private nextPair = 1
  private readonly requests = new Map<number, (message: RemoteHostToMain | null) => void>()
  private nextRequest = 1

  constructor(private readonly deps: RemoteHostDeps) {}

  /** What the remote host last reported of the devices, or null while it does not serve them. */
  get status(): RemoteHostStatus | null {
    return this.serving ? this.latest : null
  }

  get state(): RemoteHostState {
    if (this.failed) return 'failed'
    if (!this.host || !this.serving) return 'off'
    return this.latest ? 'on' : 'starting'
  }

  /** This computer's public key as a host, once it has served devices in this run. */
  get publicKey(): string | null {
    return this.ownKey
  }

  /** The known hosts, or null while the remote host has not reported them yet. */
  get hosts(): HostStatus[] | null {
    if (this.hostList) return this.hostList
    return this.host || this.known ? null : []
  }

  /** The device key is kept in a file only the user can read, without the system's encryption. */
  get plainTextDeviceKey(): boolean {
    return this.device?.plainText ?? false
  }

  /** The system cannot decrypt the device key. */
  get deviceKeyFailed(): boolean {
    return this.deviceFailed
  }

  /** Serves devices while the setting is on; the changes apply in the order they come. */
  setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled
    return this.reconcile()
  }

  /** Tells every device why and stops for good, as when Kettu quits. */
  stop(): Promise<void> {
    this.quitting = true
    this.changes = this.changes.then(() => this.end('stopping'))
    return this.changes
  }

  /** Pairs a device; false while the host does not serve devices. */
  addDevice(device: NewDevice): boolean {
    return this.toServer({ type: 'remote-host:add-device', device })
  }

  /** Forgets a device and ends its sessions; false while the host does not serve devices. */
  removeDevice(id: string): boolean {
    return this.toServer({ type: 'remote-host:remove-device', id })
  }

  /** Passes the direct connections' settings on when they changed; each start reads them anew. */
  directChanged(): void {
    const direct = this.deps.direct()
    const sent = JSON.stringify(direct)
    if (!this.serving || sent === this.direct) return
    if (this.toServer({ type: 'remote-host:direct', direct })) this.direct = sent
  }

  /** Passes the same settings on again, so a port that could not be opened is tried again. */
  retryDirect(): void {
    const direct = this.deps.direct()
    if (this.toServer({ type: 'remote-host:direct', direct })) this.direct = JSON.stringify(direct)
  }

  /** The computer woke from sleep: the host reads its addresses again and tries its hosts. */
  resume(): void {
    this.host?.post({ type: 'remote-host:resume' })
  }

  /** Renames a device, which its sessions hear; false while the host does not serve devices. */
  renameDevice(id: string, name: string): boolean {
    return this.toServer({ type: 'remote-host:rename-device', id, name })
  }

  /** The name the next welcomes carry, and the one pairing suggests to a host. */
  setHostName(name: string): void {
    this.host?.post({ type: 'remote-host:host-name', name })
  }

  /**
   * Opens a pairing code, voiding any other; `listener` hears its progress until it is added or
   * void. The code's id, or null while the host does not serve devices.
   */
  pair(listener: PairingListener): number | null {
    const codeId = this.nextCode++
    if (!this.toServer({ type: 'remote-host:pair', codeId })) return null
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

  /**
   * Pairs with the host of a pairing link, starting the remote host if it is not running;
   * `listener` hears how it goes until the host is added or it fails. The pairing's id, or null
   * when the device key cannot be read.
   */
  async pairHost(
    link: string,
    model: string,
    listener: HostPairingListener,
  ): Promise<number | null> {
    if (!(await this.loadDevice())) return null
    const pairId = this.nextPair++
    this.hostPairings.set(pairId, listener)
    await this.reconcile()
    if (!this.hostPairings.has(pairId)) return pairId
    if (!this.host?.post({ type: 'remote-host:pair-host', pairId, link, model })) {
      this.finishPairing(pairId, { state: 'failed', reason: 'unreachable' })
    }
    return pairId
  }

  /** Add host closed: its pairing ends unless the host was added. */
  closeHostPairing(pairId: number): void {
    if (!this.hostPairings.delete(pairId)) return
    this.host?.post({ type: 'remote-host:pair-host-close', pairId })
    void this.reconcile()
  }

  /** Renames this computer on a host; false when the host is not connected. */
  renameOnHost(id: string, name: string): boolean {
    const host = this.hostList?.find((entry) => entry.id === id)
    if (host?.connection.state !== 'online') return false
    return this.host?.post({ type: 'remote-host:rename-on-host', id, name }) ?? false
  }

  /** Sets the addresses a host is tried at; false when it is not known. */
  setHostAddresses(id: string, addresses: DirectAddress[]): boolean {
    if (!this.hostList?.some((entry) => entry.id === id)) return false
    return this.host?.post({ type: 'remote-host:host-addresses', id, addresses }) ?? false
  }

  /** Forgets a host here; false when it is not known. */
  removeHost(id: string): boolean {
    if (!this.hostList?.some((entry) => entry.id === id)) return false
    return this.host?.post({ type: 'remote-host:remove-host', id }) ?? false
  }

  /** A device's activity, newest first; none while the host does not serve devices. */
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
   * pair again; the hosts this computer connects to stay connected. Rejects while remote access is
   * not on.
   */
  reset(): Promise<void> {
    const run = this.changes.then(async () => {
      if (!this.host || !this.serving || !this.latest) throw new Error('Remote access is not on')
      const answer = await this.request((requestId) => ({ type: 'remote-host:reset', requestId }))
      if (!answer) throw new Error('The remote host did not reset')
      this.stopServing()
      await this.deps.newIdentity()
      await this.apply()
    })
    this.changes = run.catch(() => {})
    return run
  }

  private toServer(message: MainToRemoteHost): boolean {
    return this.serving && (this.host?.post(message) ?? false)
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

  private reconcile(): Promise<void> {
    this.changes = this.changes.then(() => this.apply())
    return this.changes
  }

  /** Runs the process while anything needs it, serving devices while the setting is on. */
  private async apply(): Promise<void> {
    if (this.quitting) return
    this.launchRead ??= this.deps
      .hostsKnown()
      .then((known) => {
        this.known ||= known
      })
      .catch(() => {})
    await this.launchRead
    // A key that would not decrypt is remote access's failure, which ends with the setting.
    if (!this.enabled) this.failed = false
    if (!this.enabled && !this.known && this.hostPairings.size === 0) return this.end('remote_off')
    if (!this.host) return this.begin()
    if (this.enabled && !this.serving) return this.startServing()
    if (!this.enabled && this.serving) return this.stopServing()
    this.deps.changed?.()
  }

  /** The device key, loaded once; null when the system cannot decrypt it. */
  private async loadDevice(): Promise<RemoteIdentity | null> {
    if (this.device) return this.device
    try {
      this.device = await this.deps.deviceKey()
      this.platform = await this.deps.devicePlatform()
      this.deviceFailed = false
    } catch (error) {
      log.error('Cannot connect to other hosts without the device key', error)
      this.deviceFailed = true
    }
    this.deps.hostsChanged?.()
    return this.device
  }

  /** The identity, or null when the system cannot decrypt it, which remote access then says. */
  private async loadIdentity(): Promise<RemoteIdentity | null> {
    try {
      this.identity = await this.deps.identity()
      this.failed = false
    } catch (error) {
      log.error('Remote access cannot start without its key', error)
      this.identity = null
      this.failed = true
    }
    return this.identity
  }

  private async begin(): Promise<void> {
    if (this.host || this.quitting) return
    const identity = this.enabled ? await this.loadIdentity() : null
    const device = await this.loadDevice()
    const forHosts = device !== null && (this.known || this.hostPairings.size > 0)
    if (!identity && !forHosts) {
      this.deps.changed?.()
      return
    }
    const host = new UtilityHost<MainToRemoteHost, RemoteHostToMain>({
      label: 'remote-host',
      modulePath: remoteHostPath,
      serviceName: 'Kettu Remote Host',
      initMessage: () => this.initMessage(),
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

  /** What the process starts with, each time it starts. */
  private initMessage(): MainToRemoteHost {
    const identity = this.enabled ? this.identity : null
    this.serving = identity !== null
    return {
      type: 'remote-host:init',
      userDataPath: this.deps.userDataPath,
      appVersion: this.deps.appVersion,
      platform: process.platform,
      hostName: this.deps.hostName(),
      ...(identity ? { privateKey: identity.privateKey } : {}),
      plainTextKey: identity?.plainText ?? false,
      direct: this.initDirect(),
      ...(this.device
        ? { device: { privateKey: this.device.privateKey, platform: this.platform } }
        : {}),
    }
  }

  private initDirect(): DirectSettings {
    const direct = this.deps.direct()
    this.direct = JSON.stringify(direct)
    return direct
  }

  private async startServing(): Promise<void> {
    const identity = await this.loadIdentity()
    if (!identity || !this.host || !this.enabled) return this.deps.changed?.()
    const { privateKey, plainText } = identity
    this.serving = this.host.post({
      type: 'remote-host:serve',
      privateKey,
      plainTextKey: plainText,
      direct: this.initDirect(),
    })
    this.deps.changed?.()
  }

  /** Devices hear that remote access is off; the connections to other hosts go on. */
  private stopServing(): void {
    this.host?.post({ type: 'remote-host:stop-serving' })
    this.serving = false
    this.latest = null
    this.voidCodes()
    this.deps.changed?.()
  }

  private async end(reason: RemoteHostStopReason): Promise<void> {
    this.failed = false
    const host = this.host
    if (!host) return this.deps.changed?.()
    this.host = null
    this.latest = null
    this.serving = false
    this.hostList = null
    this.lost()
    await host.stop(undefined, { type: 'remote-host:shutdown', reason })
  }

  private voidCodes(): void {
    for (const listener of this.askers.values()) listener({ state: 'void', reason: 'stopped' })
    this.askers.clear()
  }

  /** The process is gone: its codes, pairings, ports and unanswered requests with it. */
  private lost(): void {
    this.voidCodes()
    for (const pairId of [...this.hostPairings.keys()]) {
      this.finishPairing(pairId, { state: 'failed', reason: 'unreachable' })
    }
    for (const port of this.hostPorts.values()) port.close()
    this.hostPorts.clear()
    this.hostList =
      this.hostList?.map((entry) =>
        entry.connection.state === 'online'
          ? { ...entry, connection: { state: 'offline' } }
          : entry,
      ) ?? null
    for (const answer of [...this.requests.values()]) answer(null)
    this.deps.changed?.()
    this.deps.hostsChanged?.()
  }

  private finishPairing(pairId: number, pairing: HostPairingState): void {
    const listener = this.hostPairings.get(pairId)
    if (!listener) return
    // A host just added is known before its pairing ends, so the process keeps running.
    if (pairing.state === 'added') this.known = true
    if (pairing.state === 'added' || pairing.state === 'failed') {
      this.hostPairings.delete(pairId)
      void this.reconcile()
    }
    listener(pairId, pairing)
  }

  /** Main's end of a host's session port: kept open for the sessions on other hosts. */
  private openHostPort(
    host: UtilityHost<MainToRemoteHost, RemoteHostToMain>,
    requestId: number,
    hostId: string,
  ): void {
    const { port1, port2 } = new MessageChannelMain()
    if (!host.post({ type: 'remote-host:host-port', requestId }, [port1])) {
      port1.close()
      port2.close()
      return
    }
    this.hostPorts.get(hostId)?.close()
    this.hostPorts.set(hostId, port2)
    port2.on('close', () => {
      if (this.hostPorts.get(hostId) === port2) this.hostPorts.delete(hostId)
    })
    // Nothing reads the host protocol here yet; started, so nothing piles up unread.
    port2.on('message', () => {})
    port2.start()
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
      case 'remote-host:open-host-port':
        if (
          this.host === host &&
          Number.isSafeInteger(message.requestId) &&
          typeof message.hostId === 'string'
        ) {
          this.openHostPort(host, message.requestId, message.hostId)
        }
        break
      case 'remote-host:status':
        if (this.host === host && this.serving && isStatus(message.status)) {
          this.latest = message.status
          this.ownKey = message.status.publicKey
          this.deps.changed?.()
        }
        break
      case 'remote-host:hosts': {
        if (this.host !== host || !Array.isArray(message.hosts)) break
        const hosts = message.hosts.slice(0, MAX_HOSTS).map(parseHostStatus)
        if (hosts.some((entry) => entry === null)) {
          log.warn('Ignored a hosts report with a host that is not one')
          break
        }
        this.hostList = hosts as HostStatus[]
        const known = this.hostList.length > 0
        const forgotten = this.known && !known
        this.known = known
        this.deps.hostsChanged?.()
        if (forgotten) void this.reconcile()
        break
      }
      case 'remote-host:host-pairing': {
        if (this.host !== host) break
        const pairing = parseHostPairingState(message.pairing)
        if (pairing) this.finishPairing(message.pairId, pairing)
        break
      }
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
