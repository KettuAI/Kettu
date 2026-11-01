// The host's parent answering its owner's devices beyond their sessions: the host's part of the
// settings and the host's actions in Settings, with the checks the window's calls have. Main and
// the daemon each hand it what they run, so it never imports Electron.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { AdminAnswer, HostToMain } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { PortErrorCode } from '@shared/port-rpc'
import type { DeviceActivity } from '@shared/remote/activity'
import { DEVICE_ID, normalizeDeviceName } from '@shared/remote/device'
import {
  hostSettingsPart,
  isHostAdminMethod,
  splitSettingsPatch,
  type HostAdminEvent,
  type HostAdminMethod,
  type HostAdminResult,
  type HostAttention,
  type HostInfo,
  type HostThemes,
} from '@shared/remote/host-admin'
import type { PairingState } from '@shared/remote/pairing'
import type { RemoteStatus } from '@shared/remote/status'
import type { SettingsFile, SettingsPatch } from '@shared/settings'
import type { SharingConnectResult, SharingResult, SharingStatus } from '@shared/sharing'
import type { CatalogInstallResult, CatalogState, ThemeInstallResult } from '@shared/themes'
import { isHarnessId } from '@shared/thread'
import type { UpdateStatus } from '@shared/updates'
import { isAbsolutePath } from '../agent-host/paths'
import type { AgentFolders } from './agent-folders'
import { isExecutableFile } from './executable'
import type { SettingsStore } from './settings'
import { SettingsError } from './settings-schema'
import { checkThemeText, type ThemeReadResult, type ThemeSelect } from './themes'

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
  if (!name) throw invalid('A device needs a name')
  return name
}

export function pairingCode(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw invalid('A pairing code id must be an integer')
  return value as number
}

/** A program the host may run, as a dialog picked it or a device typed it; refused otherwise. */
export async function runnableProgram(file: string, platform: Platform): Promise<string> {
  if (!(await isExecutableFile(file, platform))) {
    throw invalid(`"${file}" is not a program that can be run`)
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
  /** False when the device could not be renamed. */
  renameDevice(id: string, name: string): Promise<boolean>
  /** False when the device could not be removed. */
  removeDevice(id: string): Promise<boolean>
  activity(id: string): Promise<DeviceActivity[]>
  reset(): Promise<void>
  retryDirect(): void
}

/** Publishing artifacts, whose methods check their own arguments. */
export interface AdminSharing {
  status(): SharingStatus
  connect(token: unknown, accountId: unknown): Promise<SharingConnectResult>
  remove(): SharingStatus
  publish(id: unknown, version: unknown): Promise<SharingResult>
  update(id: unknown, version: unknown): Promise<SharingResult>
  unpublish(id: unknown): Promise<SharingResult>
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
  download(): Promise<void>
  cancel(): void
  restart(): void
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
  themes: AdminThemes
  /** An artifact version's preview as a data URL; null where the host cannot capture, as the daemon. */
  thumbnail: ((id: unknown, version: unknown, layout: unknown) => Promise<string | null>) | null
  /** Remote access is always on, as under the daemon, so a device may not turn it off. */
  remoteAlwaysOn?: boolean
  /** Tells every owner's device, or only `deviceId`. */
  send(event: HostAdminEvent, deviceId: string | null): void
}

/** Answers the owner's devices and tells them what changes on the host. */
export class HostAdmin {
  /** The device that opened each pairing code, which alone hears it and answers it. */
  private readonly codes = new Map<number, string>()
  private sentSettings: string
  private sentRemote: string | null = null
  /** Calls waiting for the updater to say what it does next. */
  private updateWaiters: (() => void)[] = []
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
    const sent = JSON.stringify(status)
    if (sent === this.sentRemote) return
    this.sentRemote = sent
    this.deps.send({ type: 'remote.changed', status }, null)
  }

  sharingChanged(status: SharingStatus): void {
    this.deps.send({ type: 'sharing.changed', status }, null)
  }

  updatesChanged(status: UpdateStatus): void {
    for (const resolve of this.updateWaiters.splice(0)) resolve()
    this.deps.send({ type: 'updates.changed', status }, null)
  }

  themesChanged(themes: HostThemes): void {
    this.deps.send({ type: 'themes.changed', themes }, null)
  }

  /** What needs the user, which the devices notify about as the host's own window does. */
  attention(message: Extract<HostToMain, { type: 'host:attention' }>): void {
    const { title, body } = message
    const attention: HostAttention =
      message.kind === 'routine-paused'
        ? { kind: message.kind, agentId: message.agentId, title, body }
        : { kind: message.kind, sessionId: message.sessionId, title, body }
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

  private ownCode(deviceId: string, value: unknown): number | null {
    const codeId = pairingCode(value)
    return this.codes.get(codeId) === deviceId ? codeId : null
  }

  private sharing(): AdminSharing {
    if (!this.deps.sharing) throw new AdminError('unavailable', 'This host does not publish')
    return this.deps.sharing
  }

  private updates(): AdminUpdates {
    if (!this.deps.updates) {
      throw new AdminError('unavailable', 'This host is not updated from Settings')
    }
    return this.deps.updates
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
          throw invalid('This host always serves remote access')
        }
        settings.update(patch)
        return this.hostPart()
      }
      case 'settings.addAgent': {
        const { harnessId, name, folder } = fields(params)
        if (folder === null) return agentFolders.add(harnessId, name, null)
        const typed = typedPath(folder, 'folder', platform)
        if (!(await isDirectory(typed))) throw invalid(`"${typed}" is not a folder on this host`)
        // As the dialog's folder is, once the host has checked it.
        agentFolders.remember(typed)
        return agentFolders.add(harnessId, name, typed)
      }
      case 'settings.renameAgent': {
        const { agentId, name } = fields(params)
        agentFolders.rename(agentId, name)
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
      case 'sharing.connect': {
        const { token, accountId } = fields(params)
        return this.sharing().connect(token, accountId)
      }
      case 'sharing.remove':
        return this.sharing().remove()
      case 'sharing.publish': {
        const { id, version } = fields(params)
        return this.sharing().publish(id, version)
      }
      case 'sharing.update': {
        const { id, version } = fields(params)
        return this.sharing().update(id, version)
      }
      case 'sharing.unpublish':
        return this.sharing().unpublish(fields(params).id)
      case 'updates.status':
        return this.updates().getStatus()
      case 'updates.check':
        return this.updates().check()
      case 'updates.download': {
        // A download outlasts a device's call: answer once it starts, or with why it cannot.
        const download = this.updates().download()
        download.catch(() => {})
        await Promise.race([
          download,
          new Promise<void>((resolve) => this.updateWaiters.push(resolve)),
        ])
        return null
      }
      case 'updates.cancel':
        this.updates().cancel()
        return null
      case 'updates.restart':
        this.updates().restart()
        return null
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
          throw new AdminError('unavailable', 'This host does not capture previews')
        }
        const { id, version, layout } = fields(params)
        return this.deps.thumbnail(id, version, layout)
      }
    }
  }
}
