import type { AgentsApi, DiagnosticsBundle } from './agent-host'
import type { BusySession, BusyTerminal } from './host-control'
import type { Platform } from './platform'
import type { SettingsFile, SettingsPatch } from './settings'
import type { TerminalsApi } from './terminal-host'
import type { AgentId } from './thread'
import type { UpdateStatus } from './updates'

export interface AppInfo {
  name: string
  version: string
  platform: string
  arch: string
  versions: { electron: string; chrome: string; node: string }
  userDataPath: string
  isPackaged: boolean
}

/** What main asks the focused window to confirm before it quits or restarts to update. */
export interface QuitRequest {
  id: number
  reason: 'quit' | 'update'
  sessions: BusySession[]
  terminals: BusyTerminal[]
}

/** Commands main sends to the renderer, from the app menu or a notification. */
export type AppCommand =
  | { kind: 'open-project' }
  | { kind: 'new-session' }
  | { kind: 'open-settings'; section?: string }
  | { kind: 'toggle-sidebar' }
  | { kind: 'open-session'; sessionId: string }

/** Request/response contract of every `ipcRenderer.invoke` channel, keyed by channel name. */
export interface IpcInvokeContract {
  'app:get-info': { args: []; result: AppInfo }
  'app:respond-quit': { args: [id: number, confirmed: boolean]; result: void }
  'settings:get': { args: []; result: SettingsFile }
  'settings:update': { args: [patch: SettingsPatch]; result: SettingsFile }
  'dialog:open-project': { args: []; result: string | null }
  'dialog:choose-agent-binary': { args: [agentId: AgentId]; result: string | null }
  'dialog:choose-shell': { args: []; result: string | null }
  'diagnostics:save': { args: [bundle: DiagnosticsBundle]; result: string | null }
  'shell:show-data-folder': { args: []; result: void }
  'update:get-status': { args: []; result: UpdateStatus }
  'update:check': { args: []; result: UpdateStatus }
  'update:download': { args: []; result: void }
  'update:restart': { args: []; result: void }
  'update:dismiss': { args: []; result: void }
  'agent-host:restart': { args: []; result: void }
  'terminal-host:restart': { args: []; result: void }
}

export type IpcInvokeChannel = keyof IpcInvokeContract
export type IpcInvokeArgs<C extends IpcInvokeChannel> = IpcInvokeContract[C]['args']
export type IpcInvokeResult<C extends IpcInvokeChannel> = IpcInvokeContract[C]['result']

/** Events main sends to the renderer, keyed by channel name. */
export interface IpcEventContract {
  'settings:changed': SettingsFile
  'update:changed': UpdateStatus
  'app:confirm-quit': QuitRequest
  'app:command': AppCommand
}

export type IpcEventChannel = keyof IpcEventContract

/** Messages the renderer sends to main without waiting for an answer. */
export interface IpcSendContract {
  'agent-host:connect': []
  'terminal-host:connect': []
  'perf:interactive': []
  /** The page has no `onConfirmQuit` listener, so main asks with a native dialog instead. */
  'app:confirm-quit-unhandled': [id: number]
}

/** Payload of `agent-host:reset` and `terminal-host:reset`. */
export interface HostResetEvent {
  /** The host crashed too often and stays down until the renderer calls `restart()`. */
  failed: boolean
}

/** Messages main sends to the preload alone; they are never forwarded to the page. */
export interface PreloadEventContract {
  'agent-host:port': [] // the MessagePort travels in the event's ports
  'agent-host:reset': HostResetEvent
  'terminal-host:port': []
  'terminal-host:reset': HostResetEvent
}

/** API the preload script exposes to the renderer as `window.overbench`. */
export interface OverbenchApi {
  platform: Platform
  /** Whether the app runs with --overbench-perf, which turns on the renderer's frame counters. */
  perf: boolean
  app: {
    getInfo(): Promise<AppInfo>
    respondQuit(id: number, confirmed: boolean): Promise<void>
    onConfirmQuit(listener: (request: QuitRequest) => void): () => void
    onCommand(listener: (command: AppCommand) => void): () => void
    reportInteractive(): void
  }
  settings: {
    get(): Promise<SettingsFile>
    update(patch: SettingsPatch): Promise<SettingsFile>
    onChanged(listener: (settings: SettingsFile) => void): () => void
  }
  dialogs: {
    openProject(): Promise<string | null>
    chooseAgentBinary(agentId: AgentId): Promise<string | null>
    chooseShell(): Promise<string | null>
  }
  diagnostics: {
    /** Asks where to save and writes the bundle; resolves to the path, or null if cancelled. */
    save(bundle: DiagnosticsBundle): Promise<string | null>
  }
  shell: {
    showDataFolder(): Promise<void>
  }
  updates: {
    getStatus(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    download(): Promise<void>
    restart(): Promise<void>
    dismiss(): Promise<void>
    onChanged(listener: (status: UpdateStatus) => void): () => void
  }
  agents: AgentsApi
  terminals: TerminalsApi
}
