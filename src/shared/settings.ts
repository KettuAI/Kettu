import type { AgentId } from './thread'

export interface SettingsFile {
  version: 1
  general: {
    defaultAgent: AgentId | null // null: pick one on the project home each time
    sendKey: 'enter' | 'mod-enter' // the other key inserts a newline
    restoreLastSession: boolean
    confirmQuitWhileRunning: boolean
  }
  appearance: {
    theme: 'system' | 'light' | 'dark'
    textSize: 'small' | 'default' | 'large' // thread prose and the composer: 13, 14 or 15 px
    reduceMotion: 'system' | 'always'
  }
  notifications: {
    permission: boolean
    turnEnded: boolean
    error: boolean
    sound: boolean
    badge: boolean // the Dock icon on macOS, the taskbar button on Windows
  }
  agents: Partial<Record<AgentId, { binaryPath?: string }>>
  proxy: ProxySettings
  terminal: {
    shellPath?: string // picked in a native dialog; the platform default when absent
    fontSize: 12 | 13 | 14
  }
  git: { backgroundFetch: boolean }
  updates: { automatic: 'download' | 'notify' | 'off' }
}

export type ProxySettings =
  { mode: 'environment' } | { mode: 'custom'; url: string; noProxy: string }

export const DEFAULT_SETTINGS: SettingsFile = {
  version: 1,
  general: {
    defaultAgent: null,
    sendKey: 'enter',
    restoreLastSession: true,
    confirmQuitWhileRunning: true,
  },
  appearance: { theme: 'system', textSize: 'default', reduceMotion: 'system' },
  notifications: { permission: true, turnEnded: true, error: true, sound: false, badge: true },
  agents: {},
  proxy: { mode: 'environment' },
  terminal: { fontSize: 13 },
  git: { backgroundFetch: false },
  updates: { automatic: 'download' },
}

/**
 * A change from the renderer. Sections merge key by key; `proxy` is replaced whole.
 * Executable paths can only be cleared here (`null`); setting one goes through a native
 * dialog in main, so the renderer never sends a path to a program.
 */
export interface SettingsPatch {
  general?: Partial<SettingsFile['general']>
  appearance?: Partial<SettingsFile['appearance']>
  notifications?: Partial<SettingsFile['notifications']>
  agents?: Partial<Record<AgentId, { binaryPath: null }>>
  proxy?: ProxySettings
  terminal?: { shellPath?: null; fontSize?: SettingsFile['terminal']['fontSize'] }
  git?: Partial<SettingsFile['git']>
  updates?: Partial<SettingsFile['updates']>
}

/** The part of the settings the agent host receives. */
export interface HostSettings {
  agents: SettingsFile['agents']
  proxy: ProxySettings
  git: SettingsFile['git']
}

/** The part of the settings the terminal host receives. */
export interface TerminalSettings {
  shellPath: string | null
  fontSize: SettingsFile['terminal']['fontSize']
}
