import type { LanguageSetting, Locale } from './locale'
import type { DirectAddress } from './remote/protocol'
import { BUILTIN_THEME_ID } from './themes'
import type { AgentId, HarnessId } from './thread'

export interface SettingsFile {
  version: 1
  general: {
    language: LanguageSetting
    defaultAgent: AgentId | null // null: pick one on the New session screen each time
    sendKey: 'enter' | 'mod-enter' // the other key inserts a newline
    restoreLastSession: boolean
    confirmQuitWhileRunning: boolean
    openAtLogin: boolean // start at login, so routines keep their schedule
    background: boolean // keep running with the tray icon after the last window closes
    sessionTitles: boolean // a small model titles a session its agent leaves untitled
  }
  thread: {
    outlineSummaries: boolean // a small model titles the outline's messages
    confirmLinks: boolean // show where a link goes before it opens in the default browser
  }
  appearance: {
    theme: 'system' | 'light' | 'dark' // the color mode, which picks a theme's variant
    colorTheme: string // an installed theme's id, or BUILTIN_THEME_ID
    textSize: 'small' | 'default' | 'large' // thread prose and the composer: 13, 14 or 15 px
    reduceMotion: 'system' | 'always'
    zoom: ZoomLevel // Chromium's page zoom of the whole window
  }
  notifications: {
    permission: boolean
    turnEnded: boolean
    error: boolean
    routines: boolean // a routine's run ended, or its routines paused at a plan limit
    sound: boolean
    badge: boolean // the Dock icon on macOS, the taskbar button on Windows
  }
  // Keyed by harness: the program picked for it, and its default agent's folder and visibility.
  // configDir: a folder picked before agents could be added, which the default agent keeps.
  agents: Partial<Record<HarnessId, { binaryPath?: string; configDir?: string; hidden?: true }>>
  addedAgents: AddedAgent[] // in the order they were added
  proxy: ProxySettings
  terminal: {
    shellPath?: string // picked in a native dialog; the platform default when absent
    fontSize: 12 | 13 | 14
  }
  git: { backgroundFetch: boolean }
  mcp: { kettu: { off: AgentId[] } } // the agents whose sessions get no Kettu MCP server
  updates: { automatic: 'download' | 'restart' | 'notify' | 'off' }
  privacy: { hideAccount: boolean } // masks emails and account names on screen
  usage: {
    fromComputer: boolean // read the agents' own logs
    sidebar: 'today' | 'cost' | 'limit' | 'off' // what the sidebar's Usage row shows at its end
  }
  remote: {
    enabled: boolean // paired devices may connect to this computer; keeps Kettu in the background
    name: string | null // the name devices show for this computer; null for the system's
    direct: DirectSettings // on while remote access is, since devices have no other way yet
  }
}

/** Devices connecting over TCP on the same network or a VPN, without the relay. */
export interface DirectSettings {
  enabled: boolean
  // Picked at random the first time direct connections turn on, then kept, so firewall rules and
  // forwarded ports stay valid.
  port: number | null
  addresses: DirectAddress[] // the owner's own, such as a forwarded port, listed before the found
}

/** An agent added beside a harness's default one, with a configuration folder of its own. */
export interface AddedAgent {
  id: AgentId // `<harness>~<slug>`, see `addedAgentId`
  name: string
  configDir: string // Kettu's own new folder, or one picked in a native dialog
  created: boolean // Kettu made the folder, so removing the agent offers to move it to the trash
}

/** The longest name an added agent may have. */
export const AGENT_NAME_CHARS = 40

/** The variable that moves each harness's configuration folder, for those that carry agents. */
export const CONFIG_VARIABLES: Partial<Record<HarnessId, string>> = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
}

/** Chrome's page zoom steps from 80% to 150%. */
export const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const
export type ZoomLevel = (typeof ZOOM_LEVELS)[number]
export type ZoomStep = -1 | 0 | 1

export type ProxySettings =
  { mode: 'environment' } | { mode: 'custom'; url: string; noProxy: string }

export const DEFAULT_SETTINGS: SettingsFile = {
  version: 1,
  general: {
    language: 'system',
    defaultAgent: null,
    sendKey: 'enter',
    restoreLastSession: true,
    confirmQuitWhileRunning: true,
    openAtLogin: false,
    background: false,
    sessionTitles: true,
  },
  thread: { outlineSummaries: true, confirmLinks: true },
  appearance: {
    theme: 'system',
    colorTheme: BUILTIN_THEME_ID,
    textSize: 'default',
    reduceMotion: 'system',
    zoom: 1,
  },
  notifications: {
    permission: true,
    turnEnded: true,
    error: true,
    routines: true,
    sound: false,
    badge: true,
  },
  agents: {},
  addedAgents: [],
  proxy: { mode: 'environment' },
  terminal: { fontSize: 13 },
  git: { backgroundFetch: false },
  mcp: { kettu: { off: [] } },
  updates: { automatic: 'download' },
  privacy: { hideAccount: false },
  usage: { fromComputer: false, sidebar: 'today' },
  remote: { enabled: false, name: null, direct: { enabled: false, port: null, addresses: [] } },
}

/** The zoom one step in (1) or out (-1), held at the ends; 0 returns to the default. */
export function stepZoom(zoom: ZoomLevel, step: ZoomStep): ZoomLevel {
  if (step === 0) return DEFAULT_SETTINGS.appearance.zoom
  const at = ZOOM_LEVELS.indexOf(zoom) + step
  return ZOOM_LEVELS[Math.min(Math.max(at, 0), ZOOM_LEVELS.length - 1)]!
}

/**
 * A change from the renderer. Sections merge key by key; `proxy` is replaced whole.
 * Executable paths and configuration folders can only be cleared here (`null`); setting one goes
 * through a native dialog in main, so the renderer never sends a path to a program or folder.
 */
export interface SettingsPatch {
  general?: Partial<SettingsFile['general']>
  thread?: Partial<SettingsFile['thread']>
  appearance?: Partial<SettingsFile['appearance']>
  notifications?: Partial<SettingsFile['notifications']>
  agents?: Partial<Record<HarnessId, { binaryPath?: null; configDir?: null; hidden?: boolean }>>
  proxy?: ProxySettings
  terminal?: { shellPath?: null; fontSize?: SettingsFile['terminal']['fontSize'] }
  git?: Partial<SettingsFile['git']>
  mcp?: { kettu: { off: AgentId[] } } // the list is replaced whole
  updates?: Partial<SettingsFile['updates']>
  privacy?: Partial<SettingsFile['privacy']>
  usage?: Partial<SettingsFile['usage']>
  remote?: {
    enabled?: boolean
    name?: string | null
    // `port` from 1024: below it a port may need privileges; the list is replaced whole.
    direct?: { enabled?: boolean; port?: number; addresses?: DirectAddress[] }
  }
}

/** The part of the settings the agent host receives. */
export interface HostSettings {
  locale: Locale // the language of the text the host writes for the user
  agents: SettingsFile['agents']
  addedAgents: AddedAgent[]
  proxy: ProxySettings
  git: SettingsFile['git']
  mcp: SettingsFile['mcp']
  usage: { fromComputer: boolean }
  sessionTitles: boolean // write a title for a session its agent leaves untitled
}

/** The part of the settings the terminal host receives. */
export interface TerminalSettings {
  shellPath: string | null
  fontSize: SettingsFile['terminal']['fontSize']
}
