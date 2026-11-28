// The host's parent answering its owner's devices beyond their sessions: the host's part of the
// settings and the host's actions in Settings, with the checks the window's calls have. Main and
// the daemon each hand it what they run, so it never imports Electron.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { AdminAnswer, HostToMain } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { MarketKeyState } from '@shared/marketplace'
import type { PortErrorCode } from '@shared/port-rpc'
import type { DeviceActivity } from '@shared/remote/activity'
import { DEVICE_ID, normalizeDeviceName } from '@shared/remote/device'
import {
  parseReverseHost,
  type DiscoveryRequestEvent,
  type ReverseGrant,
  type ReverseHost,
} from '@shared/remote/discovery'
import {
  hostSettingsPart,
  isHostAdminMethod,
  splitSettingsPatch,
  type DeviceReport,
  type HostAdminEvent,
  type HostAdminMethod,
  type HostAdminResult,
  type HostAttention,
  type HostInfo,
  type HostThemes,
  type JoinedDevice,
  type JoinedVia,
} from '@shared/remote/host-admin'
import type { PairingState } from '@shared/remote/pairing'
import { parseReportRequest, type ReportRequest, type ReportSubmitResult } from '@shared/report'
import type { RemoteStatus } from '@shared/remote/status'
import type { SettingsFile, SettingsPatch } from '@shared/settings'
import type {
  SharingConnectResult,
  SharingOpenResult,
  SharingResult,
  SharingStatus,
} from '@shared/sharing'
import type { CatalogInstallResult, CatalogState, ThemeInstallResult } from '@shared/themes'
import { isHarnessId } from '@shared/thread'
import {
  isUpdateConfirmationAction,
  type UpdateConfirmationAction,
  type UpdateInitiator,
  type UpdateStatus,
} from '@shared/updates'
import { isAbsolutePath } from '../agent-host/paths'
import type { AgentFolders } from './agent-folders'
import { isExecutableFile } from './executable'
import { t } from './i18n'
import { createLogger } from './log'
import { MarketKeysError } from './market-keys'
import type { SettingsStore } from './settings'
import { SettingsError } from './settings-schema'
import { parseOwnRelayInput } from './own-relay'
import type { OwnRelayCheck, OwnRelayInput } from '@shared/remote/own-relay'
import { checkThemeText, type ThemeReadResult, type ThemeSelect } from './themes'

const log = createLogger('host-admin')

// Windows extended-length paths go up to 32,767 characters.
const PATH_CHARS = 32_767
const FILE_NAME_CHARS = 255

/** A call refused with the code its caller is answered, such as `invalid_params`. */
export class AdminError extends Error {
  constructor(
    readonly code: PortErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AdminError'
  }
}

const invalid = (message: string): AdminError => new AdminError('invalid_params', message)

/** A paired device's id: untrusted input from a window or a device. */
export function deviceIdArg(value: unknown): string {
  if (typeof value !== 'string' || !DEVICE_ID.test(value)) throw invalid('Not a device id')
  return value
}

/** A device's name as the owner typed it, cleaned up as the remote host keeps it. */
export function deviceName(value: unknown): string {
  const name = normalizeDeviceName(value)
  if (!name) throw invalid(t('hostAdmin.deviceNeedsName'))
  return name
}

export function pairingCode(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw invalid('A pairing code id must be an integer')
  return value as number
}

/** A program the host may run, as a dialog picked it or a device typed it; refused otherwise. */
export async function runnableProgram(file: string, platform: Platform): Promise<string> {
  if (!(await isExecutableFile(file, platform))) {
    throw invalid(t('hostAdmin.notProgram', { path: file }))
  }
  return file
}

/** An absolute path on the host as a device typed it, normalized. */
function typedPath(value: unknown, key: string, platform: Platform): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > PATH_CHARS) {
    throw invalid(`${key} must be a path of 1 to ${PATH_CHARS} characters`)
  }
  if (value.includes('\0')) throw invalid(`${key} must not contain a NUL character`)
  if (!isAbsolutePath(value, platform)) throw invalid(`${key} must be an absolute path`)
  return (platform === 'win32' ? path.win32 : path.posix).resolve(value)
}

async function isDirectory(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory()
  } catch {
    return false
  }
}

function fields(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalid('params must be an object')
  }
  return params as Record<string, unknown>
}

/** Remote access as the parent runs it, as Settings > Remote access uses it. */
export interface AdminRemote {
  /** Opens a code, voiding any other, whose progress `listener` hears; null while it is off. */
  pair(listener: (pairing: PairingState) => void): number | null
  closePairing(codeId: number): void
  answerPairing(codeId: number, add: boolean, name: string): void
  /** The request of a device of the account that waits now, if any. */
  pendingDiscovery(): DiscoveryRequestEvent | null
  /** An answer to it from the paired device named `by`: true when it was the first and counted. */
  answerDiscovery(requestId: number, add: boolean, name: string, by: string): Promise<boolean>
  /**
   * Keeps the calling device's own host as a host of this computer's client; `unsupported` where
   * there is none, as under the daemon, and null when it could not be kept.
   */
  addReverseHost(host: ReverseHost): Promise<ReverseGrant | 'unsupported' | null>
  /** False when the device could not be renamed. */
  renameDevice(id: string, name: string): Promise<boolean>
  /** False when the device could not be removed. */
  removeDevice(id: string): Promise<boolean>
  activity(id: string): Promise<DeviceActivity[]>
  reset(): Promise<void>
  retryDirect(): void
  retryRelay(): void
  /** Checks the owner's own relay and switches to it once it passed; the key is never answered. */
  useOwnRelay(input: OwnRelayInput): Promise<OwnRelayCheck>
}

/** Publishing artifacts, whose methods check their own arguments. */
export interface AdminSharing {
  status(): SharingStatus
  refresh(): Promise<SharingStatus>
  connect(token: unknown, accountId: unknown): Promise<SharingConnectResult>
  remove(): SharingStatus
  publish(id: unknown, version: unknown, target: unknown, access: unknown): Promise<SharingResult>
  update(id: unknown, version: unknown): Promise<SharingResult>
  setAccess(id: unknown, access: unknown): Promise<SharingResult>
  newCode(id: unknown): Promise<SharingResult>
  openLink(id: unknown): Promise<SharingOpenResult>
  visitors(id: unknown): Promise<number | null>
  unpublish(id: unknown): Promise<SharingResult>
  setAuto(enabled: unknown): SharingResult
}

/** The themes folder, as main's and the daemon's theme stores keep it. */
export interface AdminThemes {
  hostThemes(): HostThemes
  /** Reads the folder again, so a file changed by hand shows. */
  refresh(): Promise<unknown>
  add(file: string, read: ThemeReadResult, select: ThemeSelect): Promise<ThemeInstallResult>
  replace(token: unknown): Promise<ThemeInstallResult>
  remove(id: unknown): Promise<void>
  fileOf(id: unknown): string
  catalog(refresh: unknown): Promise<CatalogState>
  installCatalog(id: unknown, select: ThemeSelect): Promise<CatalogInstallResult>
}

export interface AdminUpdates {
  getStatus(): UpdateStatus
  check(): Promise<UpdateStatus>
  download(initiator?: UpdateInitiator): Promise<void>
  startRemoteDownload?(initiator: UpdateInitiator): UpdateStatus
  cancel(by?: 'local' | 'remote'): UpdateStatus | void
  restart(initiator?: UpdateInitiator): UpdateStatus | void
  confirm?(
    requestId: string,
    action: UpdateConfirmationAction,
    initiator: UpdateInitiator,
  ): UpdateStatus
  revokeRemoteDevice?(deviceId: string): void
  dismiss(): void
}

export interface HostAdminDeps {
  settings: SettingsStore
  agentFolders: AgentFolders
  platform: Platform
  remote: AdminRemote
  remoteStatus(): RemoteStatus
  info(): Promise<HostInfo>
  /** Starts the agent or terminal host again after it failed, as Settings' Restart does. */
  restart(process: 'agent' | 'terminal'): void
  /** Null where the host publishes nothing, as under the daemon. */
  sharing: AdminSharing | null
  /** Null where Kettu is not updated from Settings, as under the daemon. */
  updates: AdminUpdates | null
  /** Optional per-device host update permission check beyond paired-owner membership. */
  canUpdateDevice?: (deviceId: string) => boolean
  themes: AdminThemes
  /** The Marketplace's keys, which check an untrusted patch themselves. */
  marketKeys: {
    set(patch: unknown): Promise<MarketKeyState>
    setAgentEnv(agentId: string, variable: string, value: string | null): Promise<void>
  }
  /** An artifact version's preview as a data URL; null where the host cannot capture, as the daemon. */
  thumbnail: ((id: unknown, version: unknown, layout: unknown) => Promise<string | null>) | null
  partThumbnail?: ((id: unknown, version: unknown, part: unknown) => Promise<string | null>) | null
  /** A page as a PNG; the host's own windows render it, so the daemon has none. */
  png:
    ((id: unknown, version: unknown, page: unknown, size: unknown) => Promise<Buffer | null>) | null
  /** A typed version's PDF; null where nothing renders artifacts. */
  printPdf?: ((id: unknown, version: unknown) => Promise<Buffer>) | null
  /** A problem report's bundle for an owner's device, built with the host's own logs. */
  report?: (request: ReportRequest) => Promise<DeviceReport>
  /** Submits a bundle `report` gave, with the host's own sign-in. */
  submitReport?: (ref: string) => Promise<ReportSubmitResult>
  /** Remote access is always on, as under the daemon, so a device may not turn it off. */
  remoteAlwaysOn?: boolean
  /** Tells every owner's device but `except`, or only `deviceId`. */
  send(event: HostAdminEvent, deviceId: string | null, except?: string): void
}

/** Answers the owner's devices and tells them what changes on the host. */
export class HostAdmin {
  /** The device that opened each pairing code, which alone hears it and answers it. */
  private readonly codes = new Map<number, string>()
  private sentSettings: string
  private sentRemote: string | null = null
  /** The devices with a session open as remote access last said, which a new one is not among. */
  private online = new Set<string>()
  /** Themes a device's install showed, which its answer tells it to show. */
  private readonly shown = new Set<string>()
  private readonly showOnDevice: ThemeSelect = (id) => void this.shown.add(id)

  constructor(private readonly deps: HostAdminDeps) {
    this.sentSettings = JSON.stringify(this.part(deps.settings.get()))
  }

  /**
   * Runs a device's call as the remote host passed it, checked again here, answered with its
   * result or the error that refused it.
   */
  async answer(deviceId: unknown, method: unknown, params: unknown): Promise<AdminAnswer> {
    try {
      if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) {
        throw invalid('A call names no device')
      }
      if (typeof method !== 'string' || !isHostAdminMethod(method)) {
        throw new AdminError('unknown_method', `Unknown method "${String(method)}"`)
      }
      return { result: await this.run(deviceId, method, params) }
    } catch (error) {
      if (error instanceof AdminError) {
        return { error: { code: error.code, message: error.message } }
      }
      if (error instanceof SettingsError) {
        return { error: { code: 'invalid_params', message: error.message } }
      }
      if (error instanceof MarketKeysError) {
        return { error: { code: error.code, message: error.message } }
      }
      return { error: { code: 'internal', message: (error as Error)?.message ?? String(error) } }
    }
  }

  /** The settings changed: devices hear the host's part when it is not what they last heard. */
  settingsChanged(file: SettingsFile): void {
    const part = this.part(file)
    const sent = JSON.stringify(part)
    if (sent === this.sentSettings) return
    this.sentSettings = sent
    this.deps.send({ type: 'settings.changed', settings: part }, null)
  }

  /**
   * Remote access changed: devices hear its status when it is not what they last heard, and a
   * code whose device has no session open any more is void, as a closed window's is.
   */
  remoteChanged(status: RemoteStatus): void {
    for (const [codeId, deviceId] of [...this.codes]) {
      if (status.online.includes(deviceId)) continue
      this.codes.delete(codeId)
      this.deps.remote.closePairing(codeId)
    }
    // A device that connects while a request waits hears of it, as the others did.
    const pending = this.deps.remote.pendingDiscovery()
    for (const deviceId of status.online) {
      if (pending && !this.online.has(deviceId)) {
        this.deps.send({ type: 'remote.discovery', event: pending }, deviceId)
      }
    }
    this.online = new Set(status.online)
    const pendingConfirmation = this.deps.updates?.getStatus().confirmation
    if (
      pendingConfirmation?.initiator.kind === 'remote' &&
      pendingConfirmation.initiator.deviceId &&
      !this.hasUpdatePermission(pendingConfirmation.initiator.deviceId, status)
    ) {
      this.deps.updates?.revokeRemoteDevice?.(pendingConfirmation.initiator.deviceId)
    }
    const sent = JSON.stringify(status)
    if (sent === this.sentRemote) return
    this.sentRemote = sent
    this.deps.send({ type: 'remote.changed', status }, null)
  }

  /** A device of the account asks to be added, or that request ended: every device hears it. */
  discoveryChanged(event: DiscoveryRequestEvent): void {
    this.deps.send({ type: 'remote.discovery', event }, null)
  }

  /** A device joined: every other device hears it. */
  deviceJoined(device: JoinedDevice, via: JoinedVia): void {
    this.deps.send({ type: 'remote.deviceJoined', device, via }, null, device.id)
  }

  sharingChanged(status: SharingStatus): void {
    this.deps.send({ type: 'sharing.changed', status }, null)
  }

  updatesChanged(status: UpdateStatus): void {
    this.deps.send({ type: 'updates.changed', status }, null)
  }

  themesChanged(themes: HostThemes): void {
    this.deps.send({ type: 'themes.changed', themes }, null)
  }

  /** Reads the themes again, as when plugins bring or take away their own. */
  refreshThemes(): void {
    void this.deps.themes.refresh().catch((error: unknown) => {
      log.error('Could not read the themes plugins bring', error)
    })
  }

  /** What needs the user, which the devices notify about as the host's own window does. */
  attention(message: Extract<HostToMain, { type: 'host:attention' }>): void {
    const { title, body } = message
    let attention: HostAttention
    if (message.kind === 'routine-paused') {
      attention = { kind: message.kind, agentId: message.agentId, title, body }
    } else if (message.kind === 'plan-limit') {
      const { agentId, level, key, usedPercent, sessionId } = message
      attention = {
        kind: message.kind,
        agentId,
        level,
        key,
        usedPercent,
        title,
        body,
        ...(sessionId ? { sessionId } : {}),
      }
    } else if ('taskId' in message) {
      attention = { kind: message.kind, taskId: message.taskId, title, body }
    } else {
      attention = {
        kind: message.kind,
        sessionId: message.sessionId,
        title,
        body,
        ...(message.allowOnce ? { allowOnce: message.allowOnce } : {}),
      }
    }
    this.deps.send({ type: 'attention', attention }, null)
  }

  /** An install's answer, telling the device to show the theme when its install showed it. */
  private answered<R extends { status: string; id?: string }>(
    result: R,
  ): R | (R & { show: boolean }) {
    if (result.status !== 'installed' || result.id === undefined) return result
    return { ...result, show: this.shown.delete(result.id) }
  }

  private hostPart(): HostAdminResult<'settings.get'> {
    return this.part(this.deps.settings.get())
  }

  private part(file: SettingsFile): HostAdminResult<'settings.get'> {
    const part = hostSettingsPart(file)
    // The file keeps the desktop app's default, which a host that always serves never reads.
    if (this.deps.remoteAlwaysOn) part.remote.enabled = true
    return part
  }

  /** A paired device's name, for where an answer came from. */
  private deviceNamed(deviceId: string): string {
    const device = this.deps.remoteStatus().devices.find((entry) => entry.id === deviceId)
    return device?.name ?? deviceId.slice(0, 8)
  }

  private ownCode(deviceId: string, value: unknown): number | null {
    const codeId = pairingCode(value)
    return this.codes.get(codeId) === deviceId ? codeId : null
  }

  private sharing(): AdminSharing {
    if (!this.deps.sharing) throw new AdminError('unavailable', t('hostAdmin.noPublish'))
    return this.deps.sharing
  }

  private updates(): AdminUpdates {
    if (!this.deps.updates) {
      throw new AdminError('unavailable', t('hostAdmin.noUpdates'))
    }
    return this.deps.updates
  }

  /** Whether `deviceId` is still an authorized paired device permitted to control host updates. */
  private hasUpdatePermission(
    deviceId: string,
    status: RemoteStatus = this.deps.remoteStatus(),
  ): boolean {
    if (!this.deps.updates) return false
    if (status.state === 'off') return false
    if (!status.devices.some((entry) => entry.id === deviceId)) return false
    if (this.deps.canUpdateDevice && !this.deps.canUpdateDevice(deviceId)) return false
    return true
  }

  private requireUpdatePermission(deviceId: string): AdminUpdates {
    const updates = this.updates()
    if (updates.getStatus().state.kind === 'off') {
      throw new AdminError('unavailable', t('hostAdmin.noUpdates'))
    }
    if (!this.hasUpdatePermission(deviceId)) {
      throw new AdminError('forbidden', t('hostAdmin.updateNotAllowed'))
    }
    return updates
  }

  private remoteUpdateInitiator(deviceId: string): UpdateInitiator {
    return {
      kind: 'remote',
      deviceId,
      deviceName: this.deviceNamed(deviceId),
    }
  }

  private async run(deviceId: string, method: HostAdminMethod, params: unknown): Promise<unknown> {
    const { settings, agentFolders, platform, remote } = this.deps
    switch (method) {
      case 'settings.get':
        return this.hostPart()
      case 'settings.update': {
        const { patch } = fields(params)
        const { client } = splitSettingsPatch(fields(patch) as SettingsPatch)
        if (client) {
          const keys = Object.keys(client).join(', ')
          throw invalid(`A device keeps these settings itself, not the host: ${keys}`)
        }
        if (this.deps.remoteAlwaysOn && (patch as SettingsPatch).remote?.enabled === false) {
          throw invalid(t('hostAdmin.remoteAlwaysOn'))
        }
        settings.update(patch)
        return this.hostPart()
      }
      case 'settings.addAgent': {
        const { harnessId, name, folder } = fields(params)
        if (folder === null) return agentFolders.add(harnessId, name, null)
        const typed = typedPath(folder, 'folder', platform)
        if (!(await isDirectory(typed))) throw invalid(t('hostAdmin.notFolder', { path: typed }))
        // As the dialog's folder is, once the host has checked it.
        agentFolders.remember(typed)
        return agentFolders.add(harnessId, name, typed)
      }
      case 'settings.renameAgent': {
        const { agentId, name } = fields(params)
        agentFolders.rename(agentId, name)
        return null
      }
      case 'settings.setAgentColor': {
        const { agentId, color } = fields(params)
        settings.colorAgent(agentId, color)
        return null
      }
      case 'settings.removeAgent': {
        const { agentId, trash } = fields(params)
        await agentFolders.remove(agentId, trash)
        return null
      }
      case 'settings.setAgentBinary': {
        const { harnessId, path: file } = fields(params)
        if (!isHarnessId(harnessId)) throw invalid(`Unknown harness "${String(harnessId)}"`)
        const program = await runnableProgram(typedPath(file, 'path', platform), platform)
        settings.setAgentBinary(harnessId, program)
        return this.hostPart()
      }
      case 'settings.setShellPath': {
        const { path: file } = fields(params)
        settings.setShellPath(await runnableProgram(typedPath(file, 'path', platform), platform))
        return this.hostPart()
      }
      case 'marketplace.setKeys':
        return this.deps.marketKeys.set(fields(params).patch)
      case 'marketplace.setAgentEnv': {
        const { agentId, variable, value } = fields(params)
        if (
          typeof agentId !== 'string' ||
          typeof variable !== 'string' ||
          (value !== null && typeof value !== 'string')
        ) {
          throw new TypeError('The agent environment key request is invalid')
        }
        return this.deps.marketKeys.setAgentEnv(agentId, variable, value)
      }
      case 'remote.status':
        return this.deps.remoteStatus()
      case 'remote.pair': {
        const codeId = remote.pair((pairing) => {
          if (pairing.state === 'added' || pairing.state === 'void') this.codes.delete(codeId!)
          this.deps.send({ type: 'remote.pairing', event: { codeId: codeId!, pairing } }, deviceId)
        })
        if (codeId !== null) this.codes.set(codeId, deviceId)
        return codeId
      }
      case 'remote.closePairing': {
        const owned = this.ownCode(deviceId, fields(params).codeId)
        if (owned !== null) {
          this.codes.delete(owned)
          remote.closePairing(owned)
        }
        return null
      }
      case 'remote.answerPairing': {
        const { codeId, add, name } = fields(params)
        if (typeof add !== 'boolean') throw invalid('"add" must be a boolean')
        const owned = this.ownCode(deviceId, codeId)
        if (owned !== null) remote.answerPairing(owned, add, add ? deviceName(name) : '')
        return null
      }
      case 'remote.pendingDiscovery':
        return remote.pendingDiscovery()
      case 'remote.answerDiscovery': {
        const { requestId, add, name } = fields(params)
        if (typeof add !== 'boolean') throw invalid('"add" must be a boolean')
        const by = this.deviceNamed(deviceId)
        const counted = await remote.answerDiscovery(
          pairingCode(requestId),
          add,
          add ? deviceName(name) : '',
          by,
        )
        return counted ? null : 'gone'
      }
      case 'remote.addReverseHost': {
        const host = parseReverseHost(params)
        if (!host) throw invalid("params must be the calling computer's own host")
        const grant = await remote.addReverseHost(host)
        if (grant === null) throw new AdminError('unavailable', t('hostAdmin.noReverseHost'))
        return grant
      }
      case 'remote.renameDevice': {
        const { id, name } = fields(params)
        return (await remote.renameDevice(deviceIdArg(id), deviceName(name))) ? null : 'not_renamed'
      }
      case 'remote.removeDevice':
        return (await remote.removeDevice(deviceIdArg(fields(params).id))) ? null : 'not_removed'
      case 'remote.activity':
        return remote.activity(deviceIdArg(fields(params).id))
      case 'remote.reset':
        await remote.reset()
        return null
      case 'remote.retryDirect':
        remote.retryDirect()
        return null
      case 'remote.retryRelay':
        remote.retryRelay()
        return null
      case 'remote.useOwnRelay': {
        const input = parseOwnRelayInput(params)
        if (!input) throw invalid('params must be an address, a key or null, and a pin or null')
        return remote.useOwnRelay(input)
      }
      case 'host.info':
        return this.deps.info()
      case 'host.restart': {
        const target = fields(params).process
        if (target !== 'agent' && target !== 'terminal') {
          throw invalid('"process" must be agent or terminal')
        }
        this.deps.restart(target)
        return null
      }
      case 'sharing.status':
        return this.sharing().status()
      case 'sharing.refresh':
        return this.sharing().refresh()
      case 'sharing.connect': {
        const { token, accountId } = fields(params)
        return this.sharing().connect(token, accountId)
      }
      case 'sharing.remove':
        return this.sharing().remove()
      case 'sharing.publish': {
        const { id, version, target, access } = fields(params)
        return this.sharing().publish(id, version, target, access)
      }
      case 'sharing.update': {
        const { id, version } = fields(params)
        return this.sharing().update(id, version)
      }
      case 'sharing.setAccess': {
        const { id, access } = fields(params)
        return this.sharing().setAccess(id, access)
      }
      case 'sharing.newCode':
        return this.sharing().newCode(fields(params).id)
      case 'sharing.openLink':
        return this.sharing().openLink(fields(params).id)
      case 'sharing.visitors':
        return this.sharing().visitors(fields(params).id)
      case 'sharing.unpublish':
        return this.sharing().unpublish(fields(params).id)
      case 'sharing.setAuto':
        return this.sharing().setAuto(fields(params).enabled)
      case 'updates.status':
        return this.updates().getStatus()
      case 'updates.check':
        return this.updates().check()
      case 'updates.download': {
        const updates = this.requireUpdatePermission(deviceId)
        const initiator = this.remoteUpdateInitiator(deviceId)
        if (updates.startRemoteDownload) {
          return updates.startRemoteDownload(initiator)
        }
        const download = updates.download(initiator)
        download.catch(() => {})
        return updates.getStatus()
      }
      case 'updates.cancel': {
        const updates = this.requireUpdatePermission(deviceId)
        const status = updates.getStatus()
        if (status.confirmation) {
          if (
            status.confirmation.initiator.kind !== 'remote' ||
            status.confirmation.initiator.deviceId !== deviceId
          ) {
            throw new AdminError('forbidden', t('hostAdmin.updateConfirmationWrongCaller'))
          }
        } else if (
          status.restartWhenIdle &&
          status.initiator?.kind === 'remote' &&
          status.initiator.deviceId !== deviceId
        ) {
          throw new AdminError('forbidden', t('hostAdmin.updateConfirmationWrongCaller'))
        }
        return updates.cancel('remote') ?? updates.getStatus()
      }
      case 'updates.restart': {
        const updates = this.requireUpdatePermission(deviceId)
        const initiator = this.remoteUpdateInitiator(deviceId)
        return updates.restart(initiator) ?? updates.getStatus()
      }
      case 'updates.confirm': {
        const { requestId, action } = fields(params)
        if (
          typeof requestId !== 'string' ||
          requestId.trim().length === 0 ||
          requestId.length > 128
        ) {
          throw invalid('"requestId" must be a non-empty string')
        }
        if (!isUpdateConfirmationAction(action)) {
          throw invalid('"action" must be "now", "whenIdle", or "cancel"')
        }
        const updates = this.requireUpdatePermission(deviceId)
        const confirmation = updates.getStatus().confirmation
        if (!confirmation || confirmation.requestId !== requestId) {
          throw new AdminError('conflict', t('hostAdmin.updateConfirmationStale'))
        }
        if (
          confirmation.initiator.kind !== 'remote' ||
          confirmation.initiator.deviceId !== deviceId
        ) {
          throw new AdminError('forbidden', t('hostAdmin.updateConfirmationWrongCaller'))
        }
        if (!confirmation.choices.includes(action)) {
          throw invalid(`Action "${action}" is not allowed for this update request`)
        }
        if (!updates.confirm) {
          throw new AdminError('unavailable', t('hostAdmin.noUpdates'))
        }
        return updates.confirm(requestId, action, this.remoteUpdateInitiator(deviceId))
      }
      case 'updates.dismiss':
        this.updates().dismiss()
        return null
      case 'themes.get':
        await this.deps.themes.refresh()
        return this.deps.themes.hostThemes()
      case 'themes.add': {
        const { file, text } = fields(params)
        if (
          typeof file !== 'string' ||
          file.length === 0 ||
          file.length > FILE_NAME_CHARS ||
          file.includes('\0')
        ) {
          throw invalid(`"file" must be a name of 1 to ${FILE_NAME_CHARS} characters`)
        }
        if (typeof text !== 'string') throw invalid('"text" must be a theme file\'s text')
        return this.answered(
          await this.deps.themes.add(file, checkThemeText(text), this.showOnDevice),
        )
      }
      case 'themes.replace':
        return this.answered(await this.deps.themes.replace(fields(params).token))
      case 'themes.remove':
        await this.deps.themes.remove(fields(params).id)
        return null
      case 'themes.path':
        return this.deps.themes.fileOf(fields(params).id)
      case 'themes.catalog':
        return this.deps.themes.catalog(fields(params).refresh === true)
      case 'themes.installCatalog':
        return this.answered(
          await this.deps.themes.installCatalog(fields(params).id, this.showOnDevice),
        )
      case 'artifacts.thumbnail': {
        if (!this.deps.thumbnail) {
          throw new AdminError('unavailable', t('hostAdmin.noPreviews'))
        }
        const { id, version, layout } = fields(params)
        return this.deps.thumbnail(id, version, layout)
      }
      case 'artifacts.partThumbnail': {
        if (!this.deps.partThumbnail) {
          throw new AdminError('unavailable', t('hostAdmin.noPreviews'))
        }
        const { id, version, part } = fields(params)
        return this.deps.partThumbnail(id, version, part)
      }
      case 'artifacts.png': {
        if (!this.deps.png) throw new AdminError('unavailable', t('hostAdmin.noRender'))
        const { id, version, page, size } = fields(params)
        const image = await this.deps.png(id, version, page, size)
        return image ? `data:image/png;base64,${image.toString('base64')}` : null
      }
      case 'artifacts.printPdf': {
        if (!this.deps.printPdf) throw new AdminError('unavailable', t('hostAdmin.noPrint'))
        const { id, version } = fields(params)
        return (await this.deps.printPdf(id, version)).toString('base64')
      }
      case 'host.report': {
        if (!this.deps.report) throw new AdminError('unavailable', t('hostAdmin.noReports'))
        let request: ReportRequest
        try {
          request = parseReportRequest(fields(params).request)
        } catch (error) {
          throw invalid((error as Error).message)
        }
        return this.deps.report(request)
      }
      case 'host.submitReport': {
        if (!this.deps.submitReport) {
          throw new AdminError('unavailable', t('hostAdmin.noSubmit'))
        }
        const { ref } = fields(params)
        if (typeof ref !== 'string' || ref.length > 100) throw invalid("ref must be a bundle's id")
        return this.deps.submitReport(ref)
      }
    }
  }
}
