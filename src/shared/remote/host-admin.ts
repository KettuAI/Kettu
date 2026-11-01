// What an owner's device asks of a host beyond its sessions: the host's part of the settings and the
// host-level actions of the Settings page. The remote host hands each call to its parent, the
// desktop app's main process or the daemon, which runs it with the checks of the local page.

import type { AppInfo, RemotePairingEvent } from '../ipc'
import type { SettingsFile, SettingsPatch } from '../settings'
import type { SharingConnectResult, SharingResult, SharingStatus } from '../sharing'
import type { AgentId, HarnessId } from '../thread'
import type { UpdateStatus } from '../updates'
import type { DeviceActivity } from './activity'
import type { RemoteStatus } from './status'

/**
 * The settings that take effect on the host, by section: all of it, or the keys in it. A client
 * keeps the rest, which only changes the window showing them.
 */
export const HOST_SETTING_KEYS = {
  general: ['sessionTitles'],
  agents: 'all',
  addedAgents: 'all',
  proxy: 'all',
  terminal: ['shellPath'],
  git: 'all',
  mcp: 'all',
  updates: 'all',
  usage: ['fromComputer'],
  remote: 'all',
} as const satisfies Partial<Record<keyof SettingsFile, 'all' | readonly string[]>>

/** The host's part of the settings file. */
export interface HostSettingsPart {
  general: Pick<SettingsFile['general'], 'sessionTitles'>
  agents: SettingsFile['agents']
  addedAgents: SettingsFile['addedAgents']
  proxy: SettingsFile['proxy']
  terminal: Pick<SettingsFile['terminal'], 'shellPath'>
  git: SettingsFile['git']
  mcp: SettingsFile['mcp']
  updates: SettingsFile['updates']
  usage: Pick<SettingsFile['usage'], 'fromComputer'>
  remote: SettingsFile['remote']
}

type Keys = 'all' | readonly string[]

function hostKeys(section: string): Keys | undefined {
  return (HOST_SETTING_KEYS as Record<string, Keys>)[section]
}

function pick(value: object, keys: readonly string[], kept: boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key) === kept))
}

/** The host's part of a settings file. */
export function hostSettingsPart(file: SettingsFile): HostSettingsPart {
  const part: Record<string, unknown> = {}
  for (const [section, keys] of Object.entries(HOST_SETTING_KEYS) as [keyof SettingsFile, Keys][]) {
    const value = file[section]
    part[section] = keys === 'all' ? structuredClone(value) : pick(value as object, keys, true)
  }
  return part as unknown as HostSettingsPart
}

/** A client's settings file with the host's part in place of its own. */
export function withHostSettings(file: SettingsFile, part: HostSettingsPart): SettingsFile {
  const next = structuredClone(file) as unknown as Record<string, unknown>
  for (const [section, keys] of Object.entries(HOST_SETTING_KEYS) as [string, Keys][]) {
    const value = (part as unknown as Record<string, unknown>)[section]
    if (keys === 'all') {
      next[section] = structuredClone(value)
      continue
    }
    // A key the host's part leaves out is unset there, as an unpicked shell is.
    const own = pick(next[section] as object, keys, false)
    next[section] = { ...own, ...(value as object) }
  }
  return next as unknown as SettingsFile
}

/** A patch split into what the host keeps and what the client keeps; null for an empty side. */
export function splitSettingsPatch(patch: SettingsPatch): {
  host: SettingsPatch | null
  client: SettingsPatch | null
} {
  const host: Record<string, unknown> = {}
  const client: Record<string, unknown> = {}
  for (const [section, value] of Object.entries(patch) as [string, unknown][]) {
    if (value === undefined) continue
    const keys = hostKeys(section)
    if (keys === 'all') host[section] = value
    else if (!keys) client[section] = value
    else {
      const kept = pick(value as object, keys, true)
      const rest = pick(value as object, keys, false)
      if (Object.keys(kept).length > 0) host[section] = kept
      if (Object.keys(rest).length > 0) client[section] = rest
    }
  }
  return {
    host: Object.keys(host).length > 0 ? (host as SettingsPatch) : null,
    client: Object.keys(client).length > 0 ? (client as SettingsPatch) : null,
  }
}

/** The host's own facts, and what it can do beyond its sessions. */
export interface HostInfo extends AppInfo {
  /** Publishing artifacts, which the desktop app has and the daemon does not. */
  sharing: boolean
  /** Updating Kettu from Settings, which the desktop app has and the daemon does not. */
  updates: boolean
  /**
   * Turning remote access off, which the desktop app allows; the daemon is reached only through
   * it, so it always serves it.
   */
  remoteSwitch: boolean
  /** Resetting remote access to a new identity, which the desktop app has and the daemon not yet. */
  remoteReset: boolean
}

/** The calls an owner's device makes of the host's parent, by method. */
export interface HostAdminContract {
  'settings.get': { params: undefined; result: HostSettingsPart }
  /** Refused unless every key it sets is the host's. */
  'settings.update': { params: { patch: SettingsPatch }; result: HostSettingsPart }
  /** Adds an agent to Claude Code or Codex, in a folder on the host or a new one. */
  'settings.addAgent': {
    params: { harnessId: HarnessId; name: string; folder: string | null }
    result: AgentId
  }
  'settings.renameAgent': { params: { agentId: AgentId; name: string }; result: null }
  'settings.removeAgent': { params: { agentId: AgentId; trash: boolean }; result: null }
  /** A program on the host for the harness; the host checks it is a file it may run. */
  'settings.setAgentBinary': {
    params: { harnessId: HarnessId; path: string }
    result: HostSettingsPart
  }
  /** A shell on the host; the host checks it is a file it may run. */
  'settings.setShellPath': { params: { path: string }; result: HostSettingsPart }
  'remote.status': { params: undefined; result: RemoteStatus }
  /** Opens a pairing code whose progress goes to this device alone; null while remote access is off. */
  'remote.pair': { params: undefined; result: number | null }
  'remote.closePairing': { params: { codeId: number }; result: null }
  'remote.answerPairing': { params: { codeId: number; add: boolean; name: string }; result: null }
  'remote.renameDevice': { params: { id: string; name: string }; result: 'not_renamed' | null }
  'remote.removeDevice': { params: { id: string }; result: 'not_removed' | null }
  'remote.activity': { params: { id: string }; result: DeviceActivity[] }
  'remote.reset': { params: undefined; result: null }
  'remote.retryDirect': { params: undefined; result: null }
  'host.info': { params: undefined; result: HostInfo }
  'host.restart': { params: { process: 'agent' | 'terminal' }; result: null }
  'sharing.status': { params: undefined; result: SharingStatus }
  'sharing.connect': {
    params: { token: string; accountId: string | null }
    result: SharingConnectResult
  }
  'sharing.remove': { params: undefined; result: SharingStatus }
  'sharing.publish': { params: { id: string; version: number }; result: SharingResult }
  'sharing.update': { params: { id: string; version: number }; result: SharingResult }
  'sharing.unpublish': { params: { id: string }; result: SharingResult }
  'updates.status': { params: undefined; result: UpdateStatus }
  'updates.check': { params: undefined; result: UpdateStatus }
  'updates.download': { params: undefined; result: null }
  'updates.cancel': { params: undefined; result: null }
  'updates.restart': { params: undefined; result: null }
  'updates.dismiss': { params: undefined; result: null }
}

export type HostAdminMethod = keyof HostAdminContract
export type HostAdminParams<M extends HostAdminMethod> = HostAdminContract[M]['params']
export type HostAdminResult<M extends HostAdminMethod> = HostAdminContract[M]['result']

const METHODS: Record<HostAdminMethod, true> = {
  'settings.get': true,
  'settings.update': true,
  'settings.addAgent': true,
  'settings.renameAgent': true,
  'settings.removeAgent': true,
  'settings.setAgentBinary': true,
  'settings.setShellPath': true,
  'remote.status': true,
  'remote.pair': true,
  'remote.closePairing': true,
  'remote.answerPairing': true,
  'remote.renameDevice': true,
  'remote.removeDevice': true,
  'remote.activity': true,
  'remote.reset': true,
  'remote.retryDirect': true,
  'host.info': true,
  'host.restart': true,
  'sharing.status': true,
  'sharing.connect': true,
  'sharing.remove': true,
  'sharing.publish': true,
  'sharing.update': true,
  'sharing.unpublish': true,
  'updates.status': true,
  'updates.check': true,
  'updates.download': true,
  'updates.cancel': true,
  'updates.restart': true,
  'updates.dismiss': true,
}

export function isHostAdminMethod(method: string): method is HostAdminMethod {
  return Object.hasOwn(METHODS, method)
}

/**
 * What the host tells its owner's devices as it changes, as `event` messages beside the agent
 * host's. A pairing's progress goes only to the device that opened the code.
 */
export type HostAdminEvent =
  | { type: 'settings.changed'; settings: HostSettingsPart }
  | { type: 'remote.changed'; status: RemoteStatus }
  | { type: 'remote.pairing'; event: RemotePairingEvent }
  | { type: 'sharing.changed'; status: SharingStatus }
  | { type: 'updates.changed'; status: UpdateStatus }

const EVENTS: Record<HostAdminEvent['type'], true> = {
  'settings.changed': true,
  'remote.changed': true,
  'remote.pairing': true,
  'sharing.changed': true,
  'updates.changed': true,
}

export function isHostAdminEvent(event: { type?: unknown }): event is HostAdminEvent {
  return typeof event.type === 'string' && Object.hasOwn(EVENTS, event.type)
}

/** What `paths.complete` lists: the entries of a folder on the host that start as typed. */
export interface PathCompletion {
  /** The folder the typed path's last part is looked up in, absolute and normalized. */
  folder: string
  entries: { name: string; kind: 'folder' | 'file'; executable: boolean }[]
  /** Whether the typed path itself exists, and what it is. */
  exact: { kind: 'folder' | 'file'; executable: boolean } | null
}
