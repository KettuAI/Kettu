import type { AgentsApi, DiagnosticsBundle } from './agent-host'
import type { GrantedAttachment } from './attachments'
import type { BusySession, BusyTerminal } from './host-control'
import type { Locale } from './locale'
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

/** A file the Files pane holds unsaved edits for, by its project and its path in it. */
export interface UnsavedFile {
  projectPath: string
  path: string
}

/**
 * What main asks a window to confirm before it quits, restarts to update or, on macOS, closes
 * with unsaved files.
 */
export interface QuitRequest {
  id: number
  reason: 'quit' | 'update' | 'close'
  sessions: BusySession[]
  terminals: BusyTerminal[]
  unsaved: UnsavedFile[]
}

/** What a perf run (--overbench-perf) reads from main; see docs/design/testing.md. */
export interface PerfMetrics {
  launchToInteractiveMs: number | null
  /** From `app.getAppMetrics()`; a utility process is named by the serviceName it was forked with. */
  processes: { type: string; name: string | null; pid: number; workingSetKB: number }[]
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
  // `defaultPath`: the folder the dialog opens in, the session's; an empty list when cancelled.
  'dialog:add-attachments': {
    args: [kind: 'files' | 'folder', defaultPath: string | null]
    result: GrantedAttachment[]
  }
  // Paths the preload read off dropped or pasted files, granted as the dialog's are; in their
  // order, null for one that is neither a file nor a folder.
  'attachments:grant': { args: [paths: string[]]; result: (GrantedAttachment | null)[] }
  'diagnostics:save': { args: [bundle: DiagnosticsBundle]; result: string | null }
  'shell:show-data-folder': { args: []; result: void }
  'shell:show-item': { args: [path: string]; result: void }
  'notifications:test': { args: []; result: boolean }
  'update:get-status': { args: []; result: UpdateStatus }
  'update:check': { args: []; result: UpdateStatus }
  'update:download': { args: []; result: void }
  'update:restart': { args: []; result: void }
  'update:dismiss': { args: []; result: void }
  'agent-host:restart': { args: []; result: void }
  'terminal-host:restart': { args: []; result: void }
  'perf:metrics': { args: []; result: PerfMetrics }
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
  /** Every file with unsaved edits, whenever that changes, so quitting can ask without a round trip. */
  'app:set-unsaved': [files: UnsavedFile[]]
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
  /** The interface language the system's preferred languages pick, for Language › System. */
  systemLocale: Locale
  app: {
    getInfo(): Promise<AppInfo>
    respondQuit(id: number, confirmed: boolean): Promise<void>
    onConfirmQuit(listener: (request: QuitRequest) => void): () => void
    setUnsaved(files: UnsavedFile[]): void
    onCommand(listener: (command: AppCommand) => void): () => void
    reportInteractive(): void
    /** Only answers in a perf run; rejects otherwise. */
    perfMetrics(): Promise<PerfMetrics>
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
    /** Shows a file or folder in the system file manager; the path must be absolute. */
    showItem(path: string): Promise<void>
  }
  notifications: {
    /** Shows a sample notification at once; false when the system does not support them. */
    test(): Promise<boolean>
  }
  updates: {
    getStatus(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    download(): Promise<void>
    restart(): Promise<void>
    dismiss(): Promise<void>
    onChanged(listener: (status: UpdateStatus) => void): () => void
  }
  /** What the user chose to attach, granted to the agent host by main; never a path. */
  attachments: {
    /** Shows the system's file or folder dialog, opening in `defaultPath`. */
    pick(kind: 'files' | 'folder', defaultPath: string | null): Promise<GrantedAttachment[]>
    /** Dropped or pasted files, in their order; null for one with no file on disk behind it. */
    fromFiles(files: File[]): Promise<(GrantedAttachment | null)[]>
  }
  agents: AgentsApi
  terminals: TerminalsApi
}
