// What an owner's device asks of a host beyond its sessions: the host's part of the settings and the
// host-level actions of the Settings page. The remote host hands each call to its parent, the
// desktop app's main process or the daemon, which runs it with the checks of the local page.

import type { ThumbnailPage, ThumbnailPart } from '../artifacts'
import { isComputerApp, isStopShortcut, type ComputerUseStatus } from '../computer-use'
import type { DebugStatus } from '../debug'
import type { HostToMain } from '../host-control'
import type { AppInfo, RemotePairingEvent, ReportRecording } from '../ipc'
import type { MarketKeysPatch, MarketKeyState } from '../marketplace'
import {
  DEFAULT_SETTINGS,
  type AgentColor,
  type RelayChoice,
  type SettingsFile,
  type SettingsPatch,
} from '../settings'
import type {
  ShareAccess,
  SharingConnectResult,
  SharingOpenResult,
  SharingResult,
  SharingStatus,
  SharingTarget,
} from '../sharing'
import type { ReportFileInfo, ReportRequest, ReportSubmitResult } from '../report'
import type { AgentId, HarnessId } from '../thread'
import type {
  CatalogInstallResult,
  CatalogState,
  InstalledTheme,
  ThemeInstallResult,
  ThemeLoadFailure,
} from '../themes'
import type { UpdateConfirmationAction, UpdateStatus } from '../updates'
import type { DeviceActivity } from './activity'
import type { DiscoveryRequestEvent, ReverseGrant, ReverseHost } from './discovery'
import type { OwnRelayCheck, OwnRelayInput } from './own-relay'
import { MAX_REGIONS } from './relay'
import { isRegionId } from './relay-regions'
import type { RemoteStatus } from './status'

/**
 * The settings that take effect on the host, by section: all of it, or the keys in it. A client
 * keeps the rest, which only changes the window showing them.
 */
export const HOST_SETTING_KEYS = {
  general: [
    'sessionTitles',
    'promptSuggestions',
    'continueAfterLimit',
    'agentPasswords',
    'lightModel',
  ],
  agents: 'all',
  addedAgents: 'all',
  disabledAgents: 'all',
  proxy: 'all',
  terminal: ['shellPath'],
  git: 'all',
  mcp: 'all',
  marketplace: 'all',
  startModes: 'all',
  idleSessions: 'all',
  workflow: 'all',
  startedSessions: 'all',
  updates: 'all',
  diagnostics: 'all',
  usage: ['fromComputer'],
  remote: [
    'enabled',
    'name',
    'direct',
    'terminal',
    'relay',
    'relayRegions',
    'ownRelayEnabled',
    'ownRelay',
    'discoverable',
  ],
} as const satisfies Partial<Record<keyof SettingsFile, 'all' | readonly string[]>>

/**
 * Host settings a paired device reads through `settings.get` and `settings.changed`, but cannot
 * change over the channel; only the host itself switches them.
 */
export const READ_ONLY_HOST_SETTING_KEYS = {
  cloud: ['enabled'],
  computerUse: 'all',
} as const satisfies Partial<Record<keyof SettingsFile, 'all' | readonly string[]>>

/** The host's part of the settings file. */
export interface HostSettingsPart {
  general: Pick<
    SettingsFile['general'],
    'sessionTitles' | 'promptSuggestions' | 'continueAfterLimit' | 'agentPasswords' | 'lightModel'
  >
  agents: SettingsFile['agents']
  addedAgents: SettingsFile['addedAgents']
  disabledAgents: SettingsFile['disabledAgents']
  proxy: SettingsFile['proxy']
  terminal: Pick<SettingsFile['terminal'], 'shellPath'>
  git: SettingsFile['git']
  mcp: SettingsFile['mcp']
  marketplace: SettingsFile['marketplace']
  startModes: SettingsFile['startModes']
  idleSessions: SettingsFile['idleSessions']
  workflow: SettingsFile['workflow']
  startedSessions: SettingsFile['startedSessions']
  updates: SettingsFile['updates']
  /** Detailed records window of the host; absent from older hosts, which default to off. */
  diagnostics?: SettingsFile['diagnostics']
  usage: Pick<SettingsFile['usage'], 'fromComputer'>
  /**
   * `relay` holds the official Kettu relay boolean; `ownRelayEnabled` holds the independent own-relay
   * boolean (absent from older hosts, which encoded both in `relayChoice`). `relayRegions` holds
   * explicit official relay region ids or null for automatic selection (absent from older hosts).
   */
  remote: Omit<
    SettingsFile['remote'],
    'relay' | 'relayRegions' | 'relayPreference' | 'ownRelay' | 'ownRelayEnabled'
  > & {
    relay: boolean
    relayRegions?: SettingsFile['remote']['relayRegions']
    ownRelayEnabled?: boolean
    relayChoice?: RelayChoice
    ownRelay?: SettingsFile['remote']['ownRelay']
  }
  /**
   * Whether Kettu's cloud services are on for the host; absent from older hosts, which are treated
   * as on. Read-only for paired devices.
   */
  cloud?: Pick<SettingsFile['cloud'], 'enabled'>
  /**
   * Computer use settings of the host; absent from older hosts and from hosts without computer
   * use (such as the daemon), which default to off. Read-only for paired devices.
   */
  computerUse?: SettingsFile['computerUse']
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
  for (const [section, keys] of [
    ...Object.entries(HOST_SETTING_KEYS),
    ...Object.entries(READ_ONLY_HOST_SETTING_KEYS),
  ] as [keyof SettingsFile, Keys][]) {
    const value = file[section]
    part[section] = keys === 'all' ? structuredClone(value) : pick(value as object, keys, true)
  }
  const remote = part.remote as SettingsFile['remote']
  part.remote = {
    ...remote,
    relay: remote.relay,
    ownRelayEnabled: remote.ownRelayEnabled,
    relayChoice: remote.relay ? 'kettu' : remote.ownRelayEnabled ? 'own' : 'off',
  }
  return part as unknown as HostSettingsPart
}

/** The host's remote section as a client keeps it, from a host of any version. */
function remoteOf(
  part: HostSettingsPart['remote'] | undefined,
  localPreference: string,
): SettingsFile['remote'] {
  if (!part)
    return { ...structuredClone(DEFAULT_SETTINGS.remote), relayPreference: localPreference }
  const { relayChoice, relay, relayRegions, ownRelay, ownRelayEnabled, ...rest } = part
  const hasDual = ownRelayEnabled !== undefined
  const official = hasDual
    ? Boolean(relay)
    : relayChoice === 'kettu'
      ? true
      : relayChoice === 'own' || relayChoice === 'off'
        ? false
        : Boolean(relay)
  const ownOn = hasDual
    ? ownRelayEnabled && Boolean(ownRelay)
    : relayChoice === 'own' && Boolean(ownRelay)
  const selectedRegions: string[] | null = Array.isArray(relayRegions)
    ? [
        ...new Set(relayRegions.filter((id): id is string => isRegionId(id) && id !== 'main')),
      ].slice(0, MAX_REGIONS - 1)
    : null
  return {
    ...structuredClone(rest),
    relay: official,
    relayRegions: selectedRegions && selectedRegions.length > 0 ? selectedRegions : null,
    relayPreference: localPreference,
    ownRelayEnabled: ownOn,
    ownRelay: ownRelay ?? null,
  }
}

/** The host's cloud section as a client keeps it, from a host of any version. */
function cloudOf(part: HostSettingsPart['cloud'] | undefined): SettingsFile['cloud'] {
  return typeof part?.enabled === 'boolean'
    ? { enabled: part.enabled }
    : structuredClone(DEFAULT_SETTINGS.cloud)
}

/** The host's computer use section as a client keeps it, from a host of any version. */
function computerUseOf(
  part: HostSettingsPart['computerUse'] | undefined,
): SettingsFile['computerUse'] {
  if (!part || typeof part.enabled !== 'boolean') {
    return structuredClone(DEFAULT_SETTINGS.computerUse)
  }
  return {
    enabled: part.enabled,
    allowedApps: Array.isArray(part.allowedApps)
      ? part.allowedApps.filter(isComputerApp).map((app) => ({ id: app.id, name: app.name }))
      : [],
    pauseOnUse:
      typeof part.pauseOnUse === 'boolean'
        ? part.pauseOnUse
        : DEFAULT_SETTINGS.computerUse.pauseOnUse,
    stopShortcut:
      typeof part.stopShortcut === 'string' && isStopShortcut(part.stopShortcut)
        ? part.stopShortcut
        : DEFAULT_SETTINGS.computerUse.stopShortcut,
  }
}

/** The host's diagnostics section as a client keeps it, from a host of any version. */
function diagnosticsOf(
  part: HostSettingsPart['diagnostics'] | undefined,
): SettingsFile['diagnostics'] {
  if (!part || typeof part !== 'object') return structuredClone(DEFAULT_SETTINGS.diagnostics)
  const { verboseUntil } = part
  return {
    verboseUntil:
      typeof verboseUntil === 'number' && Number.isFinite(verboseUntil) && verboseUntil >= 0
        ? verboseUntil
        : null,
  }
}

/** A client's settings file with the host's part in place of its own. */
export function withHostSettings(file: SettingsFile, part: HostSettingsPart): SettingsFile {
  const next = structuredClone(file) as unknown as Record<string, unknown>
  for (const [section, keys] of Object.entries(HOST_SETTING_KEYS) as [string, Keys][]) {
    const value = (part as unknown as Record<string, unknown>)[section]
    if (section === 'remote') {
      next.remote = remoteOf(
        value as HostSettingsPart['remote'] | undefined,
        file.remote.relayPreference,
      )
      continue
    }
    if (section === 'diagnostics') {
      next.diagnostics = diagnosticsOf(value as HostSettingsPart['diagnostics'] | undefined)
      continue
    }
    if (keys === 'all') {
      // A host older than a section has none, and works as its default.
      const fallback = DEFAULT_SETTINGS[section as keyof SettingsFile]
      next[section] = structuredClone(value === undefined ? fallback : value)
      continue
    }
    // A key the host's part leaves out is unset there, as an unpicked shell is.
    const own = pick(next[section] as object, keys, false)
    next[section] = { ...own, ...(value as object) }
  }
  next.cloud = cloudOf(part.cloud)
  next.computerUse = computerUseOf(part.computerUse)
  return next as unknown as SettingsFile
}

/** Read-only host setting sections touched by `patch`, which paired devices may not change. */
export function readOnlyHostKeys(patch: Record<string, unknown>): string[] {
  const touched: string[] = []
  for (const [section, keys] of Object.entries(READ_ONLY_HOST_SETTING_KEYS) as [string, Keys][]) {
    const value = patch[section]
    if (value === undefined) continue
    if (keys === 'all' || typeof value !== 'object' || value === null || Array.isArray(value)) {
      touched.push(section)
      continue
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    )
    if (entries.length === 0 || entries.some(([key]) => keys.includes(key))) {
      touched.push(section)
    }
  }
  return touched
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

/** A finished recording's time span in Unix milliseconds, matching a `span` report range. */
export interface RecordedSpan {
  from: number
  to: number
}

/**
 * The host's live diagnostics state and which diagnostics actions this host supports. Turning
 * debug mode on stays strictly local on the host computer itself and is never exposed remotely.
 */
export interface DiagnosticsStatus {
  /** Active reproduction recording, or null when idle. */
  recording: ReportRecording | null
  /** Current debug mode status and open local debugging ports of this host. */
  debug: DebugStatus
  /** Whether this host supports starting and stopping a reproduction recording remotely. */
  canRecord: boolean
  /** Whether this host can delete detailed records while verbose logging is off. */
  canClearVerbose: boolean
  /** Whether this host can restart normally (exiting debug mode; never enabling it). */
  canRestartNormally: boolean
}

/** Answer to `diagnostics.stopRecording`: updated diagnostics state and the recorded span, if any. */
export interface DiagnosticsStopRecordingResult {
  status: DiagnosticsStatus
  span: RecordedSpan | null
}

/** A bundle built for an owner's device, or why there is none. */
export type DeviceReport =
  /** `ref`: the bundle as the host keeps it a while, for `host.submitReport`. */
  | { ok: true; zip: string; files: ReportFileInfo[]; size: number; ref: string }
  | { ok: false; reason: 'too_large' | 'failed' }

/** The host's own facts, and what it can do beyond its sessions. */
export interface HostInfo extends AppInfo {
  /** Publishing artifacts, which the desktop app has and the daemon does not. */
  sharing: boolean
  /** Updating Kettu from Settings, which the desktop app has and the daemon does not. */
  updates: boolean
  /**
   * Rich remote update lifecycle status and timing confirmation (`updates.confirm`); absent from
   * older hosts.
   */
  remoteUpdateFlow?: boolean
  /**
   * Turning remote access off, which the desktop app allows; the daemon is reached only through
   * it, so it always serves it.
   */
  remoteSwitch: boolean
  /** Resetting remote access to a new identity, which both hosts have; false from older daemons. */
  remoteReset: boolean
  /** Capturing artifact previews, which the desktop app does and the daemon cannot. */
  thumbnails: boolean
  /** Choosing the owner's own relay, with `remote.useOwnRelay`; absent from hosts before it. */
  ownRelay?: boolean
  /** Supporting independent official and own relay toggles; absent from older hosts. */
  dualRelay?: boolean
  /** Measuring official relay region latency and selecting host relay regions; absent from older hosts. */
  relayMeasure?: boolean
  /**
   * Capturing a preview of one frame, one slide, or a document in one theme, as
   * `artifacts.partThumbnail`; absent from hosts before it.
   */
  partThumbnails?: boolean
  /**
   * Setting an agent's pinned models in order, with `agents.setPinnedModels`; absent from hosts
   * before it.
   */
  pinnedModels?: boolean
  /** Listing a Windows host's drives, with `paths.drives`; absent from hosts before it. */
  drives?: boolean
  /**
   * Reading the host's computer use state (`computer.status` and read-only `computerUse` in
   * `settings.get`), which the desktop app has and the daemon does not; absent from hosts before
   * it.
   */
  computerUse?: boolean
  /**
   * Reaching the host's diagnostics (`diagnostics.verboseUntil` in settings, `diagnostics.status`,
   * `diagnostics.clearVerbose`, `diagnostics.startRecording`, `diagnostics.stopRecording`,
   * `diagnostics.restartNormally` and `diagnostics.changed` events); absent from hosts before it.
   */
  diagnostics?: boolean
  /**
   * What the host's agent host keeps of its artifacts beyond the versions, as its requests and
   * fields name them; absent from hosts before any of them.
   */
  artifactRecords?: ArtifactRecord[]
}

/**
 * `seen`: the owner's seen version (`artifacts.seen`, `seen` in summaries and reads). `changes`:
 * `artifacts.changes`. `held`: direct edits refused for what an agent's running turn wrote, and
 * `held` in presence. `links`: `places` in the artifact tools' results. `pageErrors`: the page
 * script the host serves its pages with reports their uncaught errors. `documentSheet`: comment
 * threads anchor on a document's blocks in its Markdown, and the page script passes on what the
 * document viewer reports of its layout. `repin`: `artifacts.repin`. `deleteComment`:
 * `artifacts.deleteComment`.
 */
export const ARTIFACT_RECORDS = [
  'seen',
  'changes',
  'held',
  'links',
  'pageErrors',
  'documentSheet',
  'repin',
  'deleteComment',
] as const
export type ArtifactRecord = (typeof ARTIFACT_RECORDS)[number]

/** The host's themes folder: the themes it holds, and why the others fail. */
export interface HostThemes {
  installed: InstalledTheme[]
  failed: { id: string; failure: ThemeLoadFailure }[]
}

/**
 * An install's answer to a device: whether the device now shows the theme, as a window does after
 * installing one, and not after updating it from the catalog.
 */
export type DeviceThemeInstall<R> = R extends { status: 'installed' } ? R & { show: boolean } : R

type AttentionMessage = Extract<HostToMain, { type: 'host:attention' }>

/** What the host would notify its own window about, sent to its owner's devices. */
export type HostAttention = AttentionMessage extends infer M
  ? M extends unknown
    ? Omit<M, 'type'>
    : never
  : never

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
  'settings.setAgentColor': { params: { agentId: AgentId; color: AgentColor }; result: null }
  'settings.removeAgent': { params: { agentId: AgentId; trash: boolean }; result: null }
  /** A program on the host for the harness; the host checks it is a file it may run. */
  'settings.setAgentBinary': {
    params: { harnessId: HarnessId; path: string }
    result: HostSettingsPart
  }
  /** A shell on the host; the host checks it is a file it may run. */
  'settings.setShellPath': { params: { path: string }; result: HostSettingsPart }
  /**
   * Fills or clears inputs of a server in the host's `marketplace.mcp`, as `marketplace.setKeys`
   * of the window does; answers which inputs are set, never their values.
   */
  'marketplace.setKeys': { params: { patch: MarketKeysPatch }; result: MarketKeyState }
  'marketplace.setAgentEnv': {
    params: { agentId: string; variable: string; value: string | null }
    result: void
  }
  'remote.status': { params: undefined; result: RemoteStatus }
  /** Opens a pairing code whose progress goes to this device alone; null while remote access is off. */
  'remote.pair': { params: undefined; result: number | null }
  'remote.closePairing': { params: { codeId: number }; result: null }
  'remote.answerPairing': { params: { codeId: number; add: boolean; name: string }; result: null }
  /** The request of a device of the account that waits now, if any. */
  'remote.pendingDiscovery': { params: undefined; result: DiscoveryRequestEvent | null }
  /** The first answer counts; `gone` when it was answered elsewhere, expired or closed. */
  'remote.answerDiscovery': {
    params: { requestId: number; add: boolean; name: string }
    result: 'gone' | null
  }
  /**
   * Keeps the calling computer's own host as a host of this computer's client, after this host
   * added it; `unsupported` where there is no client, as under the daemon.
   */
  'remote.addReverseHost': { params: ReverseHost; result: ReverseGrant | 'unsupported' }
  'remote.renameDevice': { params: { id: string; name: string }; result: 'not_renamed' | null }
  'remote.removeDevice': { params: { id: string }; result: 'not_removed' | null }
  'remote.activity': { params: { id: string }; result: DeviceActivity[] }
  'remote.reset': { params: undefined; result: null }
  'remote.retryDirect': { params: undefined; result: null }
  'remote.retryRelay': { params: undefined; result: null }
  /** Measures latency to every available official relay region on the host. */
  'remote.measureRelays': { params: undefined; result: null }
  /** The key goes to the host alone, which never answers with it. */
  'remote.useOwnRelay': { params: OwnRelayInput; result: OwnRelayCheck }
  'host.info': { params: undefined; result: HostInfo }
  'host.restart': { params: { process: 'agent' | 'terminal' }; result: null }
  'sharing.status': { params: undefined; result: SharingStatus }
  'sharing.refresh': { params: undefined; result: SharingStatus }
  'sharing.connect': {
    params: { token: string; accountId: string | null }
    result: SharingConnectResult
  }
  'sharing.remove': { params: undefined; result: SharingStatus }
  'sharing.publish': {
    params: { id: string; version: number; target: SharingTarget; access: ShareAccess }
    result: SharingResult
  }
  'sharing.update': { params: { id: string; version: number }; result: SharingResult }
  'sharing.setAccess': { params: { id: string; access: ShareAccess }; result: SharingResult }
  'sharing.newCode': { params: { id: string }; result: SharingResult }
  'sharing.openLink': { params: { id: string }; result: SharingOpenResult }
  /** How many people look at the artifact's page on Kettu now; null when nobody can say. */
  'sharing.visitors': { params: { id: string }; result: number | null }
  'sharing.unpublish': { params: { id: string }; result: SharingResult }
  'sharing.setAuto': { params: { enabled: boolean }; result: SharingResult }
  'updates.status': { params: undefined; result: UpdateStatus }
  'updates.check': { params: undefined; result: UpdateStatus }
  'updates.download': { params: undefined; result: UpdateStatus }
  'updates.cancel': { params: undefined; result: UpdateStatus }
  'updates.restart': { params: undefined; result: UpdateStatus }
  'updates.confirm': {
    params: { requestId: string; action: UpdateConfirmationAction }
    result: UpdateStatus
  }
  'updates.dismiss': { params: undefined; result: null }
  /** Read-only computer use status of the host (driver and system permissions). */
  'computer.status': { params: undefined; result: ComputerUseStatus }
  /** Current diagnostics state (recording, debug mode status and supported diagnostics actions). */
  'diagnostics.status': { params: undefined; result: DiagnosticsStatus }
  /** Starts recording steps to reproduce on the host; desktop hosts only. */
  'diagnostics.startRecording': { params: undefined; result: DiagnosticsStatus }
  /** Stops recording steps to reproduce and returns the recorded span; desktop hosts only. */
  'diagnostics.stopRecording': { params: undefined; result: DiagnosticsStopRecordingResult }
  /** Deletes detailed record log files on the host; refused while detailed records are on. */
  'diagnostics.clearVerbose': { params: undefined; result: null }
  /**
   * Restarts the desktop app normally (leaving debug mode); takes no parameters and never enables
   * debug mode.
   */
  'diagnostics.restartNormally': { params: undefined; result: null }
  'themes.get': { params: undefined; result: HostThemes }
  /** Installs a theme file the device read, named `file`, or names the theme it would replace. */
  'themes.add': {
    params: { file: string; text: string }
    result: DeviceThemeInstall<ThemeInstallResult>
  }
  'themes.replace': { params: { token: string }; result: DeviceThemeInstall<ThemeInstallResult> }
  'themes.remove': { params: { id: string }; result: null }
  /** Where an installed theme's file is on the host. */
  'themes.path': { params: { id: string }; result: string }
  'themes.catalog': { params: { refresh: boolean }; result: CatalogState }
  'themes.installCatalog': {
    params: { id: string }
    result: DeviceThemeInstall<CatalogInstallResult>
  }
  /** An artifact version's preview as a data URL; null when it cannot be captured. */
  'artifacts.thumbnail': {
    params: { id: string; version: number; layout: ThumbnailPage[] | null }
    result: string | null
  }
  /** One frame, one slide or a document in one theme as a data URL; null when it cannot be. */
  'artifacts.partThumbnail': {
    params: { id: string; version: number; part: ThumbnailPart }
    result: string | null
  }
  /** A page of a version at its own size as a PNG `data:` URL; null when it cannot render. */
  'artifacts.png': {
    params: {
      id: string
      version: number
      page: { group: number; index: number } | null
      size: { width: number; height: number }
    }
    result: string | null
  }
  /** A typed version printed by its viewer, as a PDF in base64, which only a desktop app prints. */
  'artifacts.printPdf': { params: { id: string; version: number }; result: string }
  /** A problem report's bundle, which the host builds with its own logs: the zip in base64. */
  'host.report': { params: { request: ReportRequest }; result: DeviceReport }
  /** Submits a bundle `host.report` gave, as the device reviewed it, with the host's sign-in. */
  'host.submitReport': { params: { ref: string }; result: ReportSubmitResult }
}

export type HostAdminMethod = keyof HostAdminContract
export type HostAdminParams<M extends HostAdminMethod> = HostAdminContract[M]['params']
export type HostAdminResult<M extends HostAdminMethod> = HostAdminContract[M]['result']

const METHODS: Record<HostAdminMethod, true> = {
  'settings.get': true,
  'settings.update': true,
  'settings.addAgent': true,
  'settings.renameAgent': true,
  'settings.setAgentColor': true,
  'settings.removeAgent': true,
  'settings.setAgentBinary': true,
  'settings.setShellPath': true,
  'marketplace.setKeys': true,
  'marketplace.setAgentEnv': true,
  'remote.status': true,
  'remote.pair': true,
  'remote.closePairing': true,
  'remote.answerPairing': true,
  'remote.pendingDiscovery': true,
  'remote.answerDiscovery': true,
  'remote.addReverseHost': true,
  'remote.renameDevice': true,
  'remote.removeDevice': true,
  'remote.activity': true,
  'remote.reset': true,
  'remote.retryDirect': true,
  'remote.retryRelay': true,
  'remote.measureRelays': true,
  'remote.useOwnRelay': true,
  'host.info': true,
  'host.restart': true,
  'sharing.status': true,
  'sharing.refresh': true,
  'sharing.connect': true,
  'sharing.remove': true,
  'sharing.publish': true,
  'sharing.update': true,
  'sharing.unpublish': true,
  'sharing.setAuto': true,
  'sharing.setAccess': true,
  'sharing.newCode': true,
  'sharing.openLink': true,
  'sharing.visitors': true,
  'updates.status': true,
  'updates.check': true,
  'updates.download': true,
  'updates.cancel': true,
  'updates.restart': true,
  'updates.confirm': true,
  'updates.dismiss': true,
  'computer.status': true,
  'diagnostics.status': true,
  'diagnostics.startRecording': true,
  'diagnostics.stopRecording': true,
  'diagnostics.clearVerbose': true,
  'diagnostics.restartNormally': true,
  'themes.get': true,
  'themes.add': true,
  'themes.replace': true,
  'themes.remove': true,
  'themes.path': true,
  'themes.catalog': true,
  'themes.installCatalog': true,
  'artifacts.thumbnail': true,
  'artifacts.partThumbnail': true,
  'artifacts.png': true,
  'artifacts.printPdf': true,
  'host.report': true,
  'host.submitReport': true,
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
  | { type: 'remote.discovery'; event: DiscoveryRequestEvent }
  | { type: 'remote.deviceJoined'; device: JoinedDevice; via: JoinedVia }
  | { type: 'sharing.changed'; status: SharingStatus }
  | { type: 'updates.changed'; status: UpdateStatus }
  | { type: 'diagnostics.changed'; status: DiagnosticsStatus }
  | { type: 'themes.changed'; themes: HostThemes }
  | { type: 'attention'; attention: HostAttention }

/** How a device joined the host: a pairing code, the account, SSH, or a host it added in turn. */
export type JoinedVia = 'code' | 'account' | 'ssh' | 'reverse'

export interface JoinedDevice {
  id: string
  name: string
  platform?: string
}

const EVENTS: Record<HostAdminEvent['type'], true> = {
  'settings.changed': true,
  'remote.changed': true,
  'remote.pairing': true,
  'remote.discovery': true,
  'remote.deviceJoined': true,
  'sharing.changed': true,
  'updates.changed': true,
  'diagnostics.changed': true,
  'themes.changed': true,
  attention: true,
}

export function isHostAdminEvent(event: { type?: unknown }): event is HostAdminEvent {
  return typeof event.type === 'string' && Object.hasOwn(EVENTS, event.type)
}

/** What `paths.complete` lists: the entries of a folder on the host that start as typed. */
export interface PathCompletion {
  /** The folder the typed path's last part is looked up in, absolute and normalized. */
  folder: string
  /** `repo`: a folder that holds a Git repository; hosts before it was added leave it out. */
  entries: { name: string; kind: 'folder' | 'file'; executable: boolean; repo?: boolean }[]
  /** Whether the typed path itself exists, and what it is. */
  exact: { kind: 'folder' | 'file'; executable: boolean } | null
}

const VIAS: readonly string[] = ['code', 'account', 'ssh', 'reverse']

/** A joined device as the remote host reports it, or null when it is not one. */
export function parseJoined(message: {
  device?: unknown
  via?: unknown
}): { device: JoinedDevice; via: JoinedVia } | null {
  const { device, via } = message
  if (typeof via !== 'string' || !VIAS.includes(via)) return null
  if (typeof device !== 'object' || device === null) return null
  const { id, name, platform } = device as Record<string, unknown>
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return null
  const kept: JoinedDevice = { id, name }
  if (typeof platform === 'string' && platform.length > 0 && platform.length <= 64) {
    kept.platform = platform
  }
  return { device: kept, via: via as JoinedVia }
}
