// The daemon's answers to its owner's devices beyond their sessions, as main's, from its own
// settings, hosts and themes folder. It publishes no artifacts, captures no previews and is not
// updated from Settings, and every change of the settings reaches the hosts that read them.

import { mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { BUILTIN_THEME_ID } from '@shared/themes'
import { AgentFolders } from '../main/agent-folders'
import { AdminError, HostAdmin } from '../main/host-admin'
import type { SettingsStore } from '../main/settings'
import { nodeSystemNameForRun } from '../main/system-name'
import { ThemeCatalog } from '../main/theme-catalog'
import { readThemeFolder, readThemeSources, ThemeStore } from '../main/themes'
import { ControlError } from './control'
import type { Hosts } from './hosts'

/** What of the hosts the owner's calls and the settings reach. */
export type DaemonHosts = Pick<
  Hosts,
  | 'remoteAccess'
  | 'onRemoteChanged'
  | 'pair'
  | 'closePairing'
  | 'answerPairing'
  | 'renameDevice'
  | 'removeDevice'
  | 'activity'
  | 'retryDirect'
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
}: DaemonAdminOptions): Promise<HostAdmin> {
  const themesDir = path.join(dataPath, 'themes')
  const sourcesFile = path.join(dataPath, 'theme-sources.json')
  let admin: HostAdmin | null = null
  const themes = new ThemeStore(
    await readThemeFolder(themesDir),
    await readThemeSources(sourcesFile),
    BUILTIN_THEME_ID,
    {
      dir: themesDir,
      sourcesFile,
      catalog: new ThemeCatalog((url, init) => fetch(url, init)),
      // The daemon has no window to show a theme in; each device shows the one it chose.
      select: () => {},
      changed: () => admin?.themesChanged(themes.hostThemes()),
    },
  )
  const removed = path.join(dataPath, 'removed-agent-config')
  const agentFolders = new AgentFolders(settings, path.join(dataPath, 'agent-config'), (folder) =>
    setAside(folder, removed),
  )
  admin = new HostAdmin({
    settings,
    agentFolders,
    platform: process.platform,
    remote: {
      pair: (listener) => unlessStopped(() => hosts.pair(listener)),
      closePairing: (codeId) => hosts.closePairing(codeId),
      answerPairing: (codeId, add, name) =>
        void unlessStopped(() => hosts.answerPairing(codeId, add, name)),
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
        throw new AdminError('unavailable', 'The daemon cannot reset remote access')
      },
      retryDirect: () => hosts.retryDirect(),
    },
    remoteStatus: () => hosts.remoteAccess(),
    info: async () => ({
      name: 'Kettu',
      version,
      system: await nodeSystemNameForRun(),
      userDataPath: dataPath,
      isPackaged: true,
      sharing: false,
      updates: false,
      remoteSwitch: false,
      remoteReset: false,
      thumbnails: false,
    }),
    restart: (which) => void hosts.restart(which),
    sharing: null,
    updates: null,
    themes,
    thumbnail: null,
    remoteAlwaysOn: true,
    send: (event, deviceId) => hosts.adminEvent(event, deviceId),
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
