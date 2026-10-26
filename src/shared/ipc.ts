import type { AgentsApi, DiagnosticsBundle } from './agent-host'
import type { ArtifactImportResult, ThumbnailPage } from './artifacts'
import type { GrantedAttachment } from './attachments'
import type { BusySession, BusyTerminal } from './host-control'
import type { Locale } from './locale'
import type { Platform } from './platform'
import type { SettingsFile, SettingsPatch } from './settings'
import type { SharingResult, SharingStatus } from './sharing'
import type { TerminalsApi } from './terminal-host'
import type { ThemeInstallResult, ThemesState } from './themes'
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

/** Whether the app can register a login item, and whether macOS waits for the user's approval. */
export interface LoginItemStatus {
  /** A development build cannot register one. */
  available: boolean
  requiresApproval: boolean
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

/** What a perf run (--overbench-perf) reads from main. */
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
  | { kind: 'open-routines' }

/**
 * `artifact:open`: the artifact's origin URL, without a query, or why it cannot be shown:
 * `not_found` when the host does not know it, `unavailable` when the host cannot answer now.
 */
export type ArtifactOpenResult = { url: string } | { failed: 'not_found' | 'unavailable' }

/** A frame of an artifact tried to leave its origin for an http(s) address, which never loads. */
export interface ArtifactBlockedEvent {
  origin: string // the artifact's, as `artifact:open` gave it, without the path
  url: string
  /** The frame the app holds tried it, and shows an error page now, so the app loads it again. */
  reload: boolean
}

/** The process of an artifact's frame stopped, so the frame shows nothing until it reloads. */
export interface ArtifactStoppedEvent {
  origin: string
}

/** An app shortcut typed while a page's frame had focus, which main passes to the app's page. */
export interface ForwardedKey {
  key: string
  code: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/** Request/response contract of every `ipcRenderer.invoke` channel, keyed by channel name. */
export interface IpcInvokeContract {
  'app:get-info': { args: []; result: AppInfo }
  'app:respond-quit': { args: [id: number, confirmed: boolean]; result: void }
  'settings:get': { args: []; result: SettingsFile }
  'settings:update': { args: [patch: SettingsPatch]; result: SettingsFile }
  'login-item:status': { args: []; result: LoginItemStatus }
  'themes:get': { args: []; result: ThemesState }
  'themes:install': { args: []; result: ThemeInstallResult }
  // `token`: from the `conflict` answer of the last `themes:install`.
  'themes:replace': { args: [token: string]; result: ThemeInstallResult }
  'themes:remove': { args: [id: string]; result: void }
  // `text`: a whole theme file, which main checks before the save dialog; false when cancelled.
  'themes:export': { args: [text: string]; result: boolean }
  'themes:reveal': { args: [id: string]; result: void }
  'dialog:open-project': { args: []; result: string | null }
  'dialog:choose-agent-binary': { args: [agentId: AgentId]; result: string | null }
  'dialog:choose-agent-config-folder': { args: [agentId: AgentId]; result: string | null }
  'dialog:choose-shell': { args: []; result: string | null }
  // `defaultPath`: the folder the dialog opens in, the session's; an empty list when cancelled.
  'dialog:add-attachments': {
    args: [kind: 'files' | 'folder', defaultPath: string | null]
    result: GrantedAttachment[]
  }
  // Paths the preload read off dropped or pasted files, granted as the dialog's are; in their
  // order, null for one that is neither a file nor a folder.
  'attachments:grant': { args: [paths: string[]]; result: (GrantedAttachment | null)[] }
  // Every file copied in the file manager, granted in the order copied, when the clipboard lists
  // `pastedPath`, the first file a paste carried; null when it lists no files or not that one.
  'attachments:clipboard-files': {
    args: [pastedPath: string]
    result: GrantedAttachment[] | null
  }
  'diagnostics:save': { args: [bundle: DiagnosticsBundle]; result: string | null }
  'shell:show-data-folder': { args: []; result: void }
  'shell:show-item': { args: [path: string]; result: void }
  // A media URL main still grants, never a path.
  'media:reveal': { args: [url: string]; result: void }
  'media:open-external': { args: [url: string]; result: void }
  'notifications:test': { args: []; result: boolean }
  'update:get-status': { args: []; result: UpdateStatus }
  'update:check': { args: []; result: UpdateStatus }
  'update:download': { args: []; result: void }
  'update:cancel': { args: []; result: void }
  'update:restart': { args: []; result: void }
  'update:dismiss': { args: []; result: void }
  'agent-host:restart': { args: []; result: void }
  'terminal-host:restart': { args: []; result: void }
  'perf:metrics': { args: []; result: PerfMetrics }
  'artifact:open': { args: [id: string]; result: ArtifactOpenResult }
  'artifact:close': { args: [url: string]; result: void }
  'artifact:thumbnail': {
    args: [id: string, version: number, layout: ThumbnailPage[] | null]
    result: string | null
  }
  'artifact:open-external': { args: [id: string, version: number]; result: void }
  'artifact:export': { args: [id: string, version: number]; result: boolean }
  // `project`: a registered project's folder, or null for No project.
  'artifact:import': { args: [project: string | null]; result: ArtifactImportResult }
  'sharing:status': { args: []; result: SharingStatus }
  'sharing:connect': { args: [accountId: string, token: string]; result: SharingResult }
  'sharing:remove': { args: []; result: SharingStatus }
  // Main reads the version's HTML from the host, so the page never comes from the renderer.
  'sharing:publish': { args: [id: string, version: number]; result: SharingResult }
  'sharing:update': { args: [id: string, version: number]; result: SharingResult }
  'sharing:unpublish': { args: [id: string]; result: SharingResult }
}

export type IpcInvokeChannel = keyof IpcInvokeContract
export type IpcInvokeArgs<C extends IpcInvokeChannel> = IpcInvokeContract[C]['args']
export type IpcInvokeResult<C extends IpcInvokeChannel> = IpcInvokeContract[C]['result']

/** Events main sends to the renderer, keyed by channel name. */
export interface IpcEventContract {
  'settings:changed': SettingsFile
  'themes:changed': ThemesState
  'update:changed': UpdateStatus
  'app:confirm-quit': QuitRequest
  'app:command': AppCommand
  'app:shortcut': ForwardedKey
  'artifact:blocked': ArtifactBlockedEvent
  'artifact:stopped': ArtifactStoppedEvent
  'sharing:changed': SharingStatus
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
    /** App shortcuts typed in an artifact's frame, which the page itself never sees. */
    onShortcut(listener: (key: ForwardedKey) => void): () => void
  }
  artifacts: {
    /** Lets the window frame the artifact, if the host knows it. */
    open(id: string): Promise<ArtifactOpenResult>
    /** Undoes one `open`, once the frame is gone. */
    close(url: string): Promise<void>
    /**
     * A version's card image as a `data:` URL, or null when it could not render. A canvas passes
     * its pages laid out, which main cannot find without parsing the HTML.
     */
    thumbnail(id: string, version: number, layout: ThumbnailPage[] | null): Promise<string | null>
    /** Opens a copy of the version in the default browser, outside the app's isolation. */
    openExternal(id: string, version: number): Promise<void>
    /** Asks where to save the version's HTML; false when the user cancelled. */
    export(id: string, version: number): Promise<boolean>
    /**
     * Asks for an HTML file and makes it an artifact in the project, or in No project when null;
     * null when the user cancelled.
     */
    import(project: string | null): Promise<ArtifactImportResult>
    onBlocked(listener: (event: ArtifactBlockedEvent) => void): () => void
    onStopped(listener: (event: ArtifactStoppedEvent) => void): () => void
  }
  /** Publishing artifacts online; main holds the account's token and makes every request. */
  sharing: {
    status(): Promise<SharingStatus>
    /** Checks the account and token with Cloudflare, then keeps them. */
    connect(accountId: string, token: string): Promise<SharingResult>
    /** Forgets the account and its token; published pages stay as they are. */
    remove(): Promise<SharingStatus>
    publish(id: string, version: number): Promise<SharingResult>
    /** Puts the version on the artifact's page, at the same URL. */
    update(id: string, version: number): Promise<SharingResult>
    unpublish(id: string): Promise<SharingResult>
    onChanged(listener: (status: SharingStatus) => void): () => void
  }
  settings: {
    get(): Promise<SettingsFile>
    update(patch: SettingsPatch): Promise<SettingsFile>
    onChanged(listener: (settings: SettingsFile) => void): () => void
  }
  /** The themes folder, which main reads and checks; the page never names a path. */
  themes: {
    /** Reads the folder again. */
    get(): Promise<ThemesState>
    /** Asks for a theme file and installs it, or names the installed theme it would replace. */
    install(): Promise<ThemeInstallResult>
    /** Installs the file a `conflict` answer named, in place of the installed theme. */
    replace(token: string): Promise<ThemeInstallResult>
    remove(id: string): Promise<void>
    /** Asks where to save a theme file; false when the user cancelled. */
    export(text: string): Promise<boolean>
    /** Shows an installed theme's file in the file manager. */
    reveal(id: string): Promise<void>
    onChanged(listener: (state: ThemesState) => void): () => void
  }
  loginItem: {
    getStatus(): Promise<LoginItemStatus>
  }
  dialogs: {
    openProject(): Promise<string | null>
    chooseAgentBinary(agentId: AgentId): Promise<string | null>
    /** Picks or creates a configuration folder for Claude Code or Codex and stores it. */
    chooseAgentConfigFolder(agentId: AgentId): Promise<string | null>
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
  /** Actions on a file served on the media scheme, by its URL. */
  media: {
    /** Shows the file in the system file manager. */
    reveal(url: string): Promise<void>
    /** Opens the file in the system's default app for it. */
    openExternal(url: string): Promise<void>
  }
  notifications: {
    /** Shows a sample notification at once; false when the system does not support them. */
    test(): Promise<boolean>
  }
  updates: {
    getStatus(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    /** Update: downloads, then restarts once the download is ready. */
    download(): Promise<void>
    /** Stops a download that `download()` started. */
    cancel(): Promise<void>
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
    /**
     * The files and folders a paste carries, copied in the file manager: all of them, from the
     * clipboard, or the paste's own files without a list there. Null when the first has no file
     * on disk behind it, so the paste is an image or text.
     */
    fromClipboard(files: File[]): Promise<GrantedAttachment[]> | null
  }
  agents: AgentsApi
  terminals: TerminalsApi
}
