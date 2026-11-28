// The daemon's answers to its owner's devices beyond their sessions, as main's, from its own
// settings, hosts and themes folder. It publishes no artifacts, captures no previews and is not
// updated from Settings, and every change of the settings reaches the hosts that read them.

import { mkdir, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { logFolder } from '@shared/log/process-log'
import { ARTIFACT_RECORDS } from '@shared/remote/host-admin'
import { AGENTS_FOLDER, KETTU_HOME_FOLDER } from '@shared/storage'
import { PLUGIN_THEMES_FILE } from '@shared/plugin-themes'
import { BUILTIN_THEME_ID } from '@shared/themes'
import { AgentFolders } from '../main/agent-folders'
import { AdminError, HostAdmin, type AdminRemote, type HostAdminDeps } from '../main/host-admin'
import { t } from '../main/i18n'
import type { SettingsStore } from '../main/settings'
import { nodeSystemNameForRun } from '../main/system-name'
import { ThemeCatalog } from '../main/theme-catalog'
import { readPluginThemes, readThemeFolder, readThemeSources, ThemeStore } from '../main/themes'
import { ControlError } from './control'
import type { Hosts } from './hosts'
import { proxiedFetch } from './proxy'

/** What of the hosts the owner's calls and the settings reach. */
export type DaemonHosts = Pick<
  Hosts,
  | 'remoteAccess'
  | 'onRemoteChanged'
  | 'pair'
  | 'closePairing'
  | 'answerPairing'
  | 'pendingDiscovery'
  | 'answerDiscovery'
  | 'renameDevice'
  | 'removeDevice'
  | 'activity'
  | 'resetRemote'
  | 'retryDirect'
  | 'retryRelay'
  | 'measureRelays'
  | 'restart'
  | 'adminEvent'
  | 'settingsChanged'
  | 'onAttention'
>

export interface DaemonAdminOptions {
  dataPath: string
  version: string
  settings: SettingsStore
  hosts: DaemonHosts
  /** The daemon's environment, whose proxy variables apply unless the settings name a proxy. */
  env: NodeJS.ProcessEnv
  /** The home folder Kettu keeps its agent folders under; the system's unless a test picks one. */
  home?: string
  /** A problem report's bundle for the owner's device. */
  report?: HostAdminDeps['report']
  /** Submits a bundle `report` gave, with the daemon's sign-in. */
  submitReport?: HostAdminDeps['submitReport']
  /** Daemon diagnostics state and verbose record cleanup (no desktop recording or restart). */
  diagnostics?: HostAdminDeps['diagnostics']
  marketKeys: HostAdminDeps['marketKeys']
  /** Checks the owner's own relay and switches to it once it passed. */
  useOwnRelay: AdminRemote['useOwnRelay']
}

/** A server has no trash, so a folder Kettu made moves into one of the daemon's own. */
async function setAside(folder: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true, mode: 0o700 })
  await rename(folder, path.join(into, `${path.basename(folder)}-${Date.now()}`))
}

/** Null for what the hosts refuse because remote access does not run. */
function unlessStopped<T>(run: () => T): T | null {
  try {
    return run()
  } catch (error) {
    if (error instanceof ControlError) return null
    throw error
  }
}

/** Answers the owner's devices, and passes every change of the settings to the hosts. */
export async function startDaemonAdmin({
  dataPath,
  version,
  settings,
  hosts,
  env,
  home = os.homedir(),
  report,
  submitReport,
  diagnostics,
  marketKeys,
  useOwnRelay,
}: DaemonAdminOptions): Promise<HostAdmin> {
  const themesDir = path.join(dataPath, 'themes')
  const sourcesFile = path.join(dataPath, 'theme-sources.json')
  const pluginFile = path.join(dataPath, PLUGIN_THEMES_FILE)
  let admin: HostAdmin | null = null
  const themes = new ThemeStore(
    await readThemeFolder(themesDir),
    await readThemeSources(sourcesFile),
    await readPluginThemes(pluginFile),
    BUILTIN_THEME_ID,
    {
      dir: themesDir,
      sourcesFile,
      pluginFile,
      catalog: new ThemeCatalog(proxiedFetch(() => settings.get().proxy, env)),
      // The daemon has no window to show a theme in; each device shows the one it chose.
      select: () => {},
      changed: () => admin?.themesChanged(themes.hostThemes()),
    },
  )
  const removed = path.join(dataPath, 'removed-agent-config')
  const agentFolders = new AgentFolders(
    settings,
    path.join(home, KETTU_HOME_FOLDER, AGENTS_FOLDER),
    (folder) => setAside(folder, removed),
  )
  await agentFolders.moveCreatedAgents(path.join(dataPath, 'agent-config'))
  admin = new HostAdmin({
    settings,
    agentFolders,
    platform: process.platform,
    remote: {
      pair: (listener) => unlessStopped(() => hosts.pair(listener)),
      closePairing: (codeId) => hosts.closePairing(codeId),
      answerPairing: (codeId, add, name) =>
        void unlessStopped(() => hosts.answerPairing(codeId, add, name)),
      pendingDiscovery: () => hosts.pendingDiscovery(),
      answerDiscovery: (requestId, add, name, by) =>
        hosts.answerDiscovery(requestId, add, name, by),
      // The daemon connects to no host, so it cannot be given one.
      addReverseHost: async () => 'unsupported',
      renameDevice: async (id, name) => hosts.renameDevice(id, name),
      removeDevice: async (id) => {
        try {
          await hosts.removeDevice(id)
          return true
        } catch (error) {
          if (error instanceof ControlError) return false
          throw error
        }
      },
      activity: (id) => hosts.activity(id),
      reset: async () => {
        try {
          await hosts.resetRemote()
        } catch (error) {
          if (error instanceof ControlError) {
            throw new AdminError('unavailable', t('remoteHost.resetFailed'))
          }
          throw error
        }
      },
      retryDirect: () => hosts.retryDirect(),
      retryRelay: () => hosts.retryRelay(),
      measureRelays: () => hosts.measureRelays(),
      useOwnRelay,
    },
    remoteStatus: () => hosts.remoteAccess(),
    info: async () => {
      const logs = logFolder()
      return {
        name: 'Kettu',
        version,
        system: await nodeSystemNameForRun(),
        userDataPath: dataPath,
        ...(logs ? { logsPath: logs } : {}),
        isPackaged: true,
        sharing: false,
        updates: false,
        remoteUpdateFlow: false,
        remoteSwitch: false,
        remoteReset: true,
        ownRelay: true,
        dualRelay: true,
        relayMeasure: true,
        thumbnails: false,
        partThumbnails: false,
        pinnedModels: true,
        drives: true,
        computerUse: false,
        diagnostics: Boolean(diagnostics),
        artifactRecords: [...ARTIFACT_RECORDS],
      }
    },
    restart: (which) => void hosts.restart(which),
    sharing: null,
    updates: null,
    computerStatus: null,
    diagnostics: diagnostics ?? null,
    themes,
    marketKeys,
    thumbnail: null,
    png: null,
    remoteAlwaysOn: true,
    cloudAlwaysOn: true,
    report,
    submitReport,
    send: (event, deviceId, except) => hosts.adminEvent(event, deviceId, except),
  })
  settings.onChange((next, changed) => {
    hosts.settingsChanged(changed)
    admin.settingsChanged(next)
    // The remote host reports no change of the host's name, which the settings hold.
    if (changed.has('remote')) admin.remoteChanged(hosts.remoteAccess())
  })
  hosts.onRemoteChanged(() => admin.remoteChanged(hosts.remoteAccess()))
  hosts.onAttention((message) => admin.attention(message))
  return admin
}
