import type { AgentsApi, DiagnosticsBundle } from './agent-host'
import type { ArtifactImportResult, ThumbnailPage } from './artifacts'
import type { GrantedAttachment } from './attachments'
import type { BrowserBounds, BrowserOriginDecision, BrowserState } from './browser'
import type { BusySession, BusyTerminal } from './host-control'
import type { Locale } from './locale'
import type { CarriedMedia } from './media'
import type { Platform } from './platform'
import type { DeviceActivity } from './remote/activity'
import type { PairingState } from './remote/pairing'
import type { RemoteStatus } from './remote/status'
import type { SettingsFile, SettingsPatch } from './settings'
import type { SharingConnectResult, SharingResult, SharingStatus } from './sharing'
import type { TerminalsApi } from './terminal-host'
import type { CatalogInstallResult, CatalogState, ThemeInstallResult, ThemesState } from './themes'
import type { AgentId, HarnessId } from './thread'
import type { UpdateStatus } from './updates'

export interface AppInfo {
  name: string
  version: string
  /** The system and its version, then the architecture, as a bug report names them. */
  system: string
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

/** A project and the origins it always lets agents open, as Settings › Browser lists them. */
export interface AllowedSites {
  projectPath: string
  origins: string[]
}

/** What a perf run (--kettu-perf) reads from main. */
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
  altKey: boolean
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
  // `text`: a whole theme file, which main checks before the save dialog; the saved path, or null
  // when cancelled.
  'themes:export': { args: [text: string]; result: string | null }
  'themes:reveal': { args: [id: string]; result: void }
  // `refresh`: read the index from GitHub again rather than the copy main kept.
  'themes:catalog': { args: [refresh: boolean]; result: CatalogState }
  'themes:install-catalog': { args: [id: string]; result: CatalogInstallResult }
  // `url`: an avatar URL `git.avatarUrl` gave; null when it is none or the picture did not load.
  'avatars:load': { args: [url: string]; result: string | null }
  'dialog:open-project': { args: []; result: string | null }
  'dialog:choose-agent-binary': { args: [harnessId: HarnessId]; result: string | null }
  // A folder for an agent to add, which `settings:add-agent` then accepts; null when cancelled.
  'dialog:choose-agent-folder': { args: []; result: string | null }
  // `folder`: one the dialog returned, or null for a new folder Kettu makes. Resolves to the id.
  'settings:add-agent': {
    args: [harnessId: HarnessId, name: string, folder: string | null]
    result: AgentId
  }
  'settings:rename-agent': { args: [agentId: AgentId, name: string]; result: void }
  // `trash`: move the folder Kettu made for the agent to the trash.
  'settings:remove-agent': { args: [agentId: AgentId, trash: boolean]; result: void }
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
  'shell:open-notices': { args: []; result: void }
  // A media URL main still grants, never a path; copy and save also take the bytes the thread
  // carries. `media:save-as` is false when the save dialog was cancelled.
  'media:copy-image': { args: [source: string | CarriedMedia]; result: void }
  'media:save-as': { args: [source: string | CarriedMedia]; result: boolean }
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
  // `accountId`: the account the user chose, or null to use the one the token reaches.
  'sharing:connect': {
    args: [token: string, accountId: string | null]
    result: SharingConnectResult
  }
  'sharing:remove': { args: []; result: SharingStatus }
  // Main reads the version's HTML from the host, so the page never comes from the renderer.
  'sharing:publish': { args: [id: string, version: number]; result: SharingResult }
  'sharing:update': { args: [id: string, version: number]; result: SharingResult }
  'sharing:unpublish': { args: [id: string]; result: SharingResult }
  'remote:status': { args: []; result: RemoteStatus }
  // A pairing code for this page, voiding any other; null while remote access is not on. Its
  // progress comes as `remote:pairing` under the id.
  'remote:pair': { args: []; result: number | null }
  'remote:pair-close': { args: [codeId: number]; result: void }
  'remote:pair-answer': { args: [codeId: number, add: boolean, name: string]; result: void }
  'remote:rename-device': { args: [id: string, name: string]; result: void }
  'remote:remove-device': { args: [id: string]; result: void }
  'remote:activity': { args: [id: string]; result: DeviceActivity[] }
  'remote:reset': { args: []; result: void }
  // Listens for direct connections again on the same port, as after the port was in use.
  'remote:retry-direct': { args: []; result: void }
  'browser:show': { args: [sessionId: string]; result: void }
  'browser:hide': { args: [sessionId: string]; result: void }
  'browser:bounds': { args: [sessionId: string, bounds: BrowserBounds]; result: void }
  // A URL the renderer normalised; only http(s) ever reaches the page.
  'browser:navigate': { args: [sessionId: string, url: string]; result: void }
  'browser:back': { args: [sessionId: string]; result: void }
  'browser:forward': { args: [sessionId: string]; result: void }
  'browser:reload': { args: [sessionId: string]; result: void }
  'browser:stop': { args: [sessionId: string]; result: void }
  'browser:open-external': { args: [sessionId: string]; result: void }
  // The page as it looks now, for the pane to show while an overlay would cover the view.
  'browser:freeze': { args: [sessionId: string]; result: string | null }
  'browser:thaw': { args: [sessionId: string]; result: void }
  /** The user hands the page back to the agent, after taking control. */
  'browser:hand-back': { args: [sessionId: string]; result: void }
  /** The pane's Stop: the user takes control, and the call in flight fails. */
  'browser:stop-driving': { args: [sessionId: string]; result: void }
  /** The pane's bar or the thread's card: what the user answered a new site's request. */
  'browser:answer-origin': {
    args: [sessionId: string, requestId: number, decision: BrowserOriginDecision]
    result: void
  }
  /** The sites each project always lets agents open. */
  'browser:allowed-sites': { args: []; result: AllowedSites[] }
  'browser:remove-allowed-site': { args: [projectPath: string, origin: string]; result: void }
  'browser:clear-data': { args: []; result: void }
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
  'remote:changed': RemoteStatus
  /** Sent only to the page that opened the code. */
  'remote:pairing': RemotePairingEvent
  'browser:state': BrowserState
  /** An agent's first navigation opened a session's page, so the pane may show it. */
  'browser:opened': { sessionId: string }
}

export type IpcEventChannel = keyof IpcEventContract

export interface RemotePairingEvent {
  codeId: number
  pairing: PairingState
}

/** Messages the renderer sends to main without waiting for an answer. */
export interface IpcSendContract {
  'agent-host:connect': []
  'terminal-host:connect': []
  'perf:interactive': []
  /** The page has no `onConfirmQuit` listener, so main asks with a native dialog instead. */
  'app:confirm-quit-unhandled': [id: number]
  /** Every file with unsaved edits, whenever that changes, so quitting can ask without a round trip. */
  'app:set-unsaved': [files: UnsavedFile[]]
  /** The sessions the renderer still lists, so a page closes once its session leaves the host. */
  'browser:sessions': [sessionIds: string[]]
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

/** API the preload script exposes to the renderer as `window.kettu`. */
export interface KettuApi {
  platform: Platform
  /** Whether the app runs with --kettu-perf, which turns on the renderer's frame counters. */
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
    /**
     * Checks the token with Cloudflare and connects the account it reaches; with an account ID, the
     * one chosen.
     */
    connect(token: string, accountId: string | null): Promise<SharingConnectResult>
    /** Forgets the account and its token; published pages stay as they are. */
    remove(): Promise<SharingStatus>
    publish(id: string, version: number): Promise<SharingResult>
    /** Puts the version on the artifact's page, at the same URL. */
    update(id: string, version: number): Promise<SharingResult>
    unpublish(id: string): Promise<SharingResult>
    onChanged(listener: (status: SharingStatus) => void): () => void
  }
  /** Remote access: devices paired with this computer, and pairing more. */
  remote: {
    status(): Promise<RemoteStatus>
    /** Opens a pairing code for this page; null while remote access is not on. */
    pair(): Promise<number | null>
    /** Add device closed, which voids its code. */
    closePairing(codeId: number): Promise<void>
    /** Adds the device the code paired, under `name`, or rejects it. */
    answerPairing(codeId: number, add: boolean, name: string): Promise<void>
    renameDevice(id: string, name: string): Promise<void>
    /** Removes the device and ends its sessions at once. */
    removeDevice(id: string): Promise<void>
    /** The device's activity of the last 30 days, newest first. */
    activity(id: string): Promise<DeviceActivity[]>
    /** Removes every device and gives this computer a new identity. */
    reset(): Promise<void>
    /** Tries the direct connections' port again. */
    retryDirect(): Promise<void>
    onChanged(listener: (status: RemoteStatus) => void): () => void
    onPairing(listener: (event: RemotePairingEvent) => void): () => void
  }
  settings: {
    get(): Promise<SettingsFile>
    update(patch: SettingsPatch): Promise<SettingsFile>
    onChanged(listener: (settings: SettingsFile) => void): () => void
    /** Adds an agent to Claude Code or Codex, in a folder from `chooseAgentFolder` or a new one. */
    addAgent(harnessId: HarnessId, name: string, folder: string | null): Promise<AgentId>
    renameAgent(agentId: AgentId, name: string): Promise<void>
    removeAgent(agentId: AgentId, trash: boolean): Promise<void>
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
    /** Asks where to save a theme file; the saved file's path, or null when the user cancelled. */
    export(text: string): Promise<string | null>
    /** Shows an installed theme's file in the file manager. */
    reveal(id: string): Promise<void>
    /** The online catalog's themes, read from GitHub when `refresh` is set or the first time. */
    catalog(refresh: boolean): Promise<CatalogState>
    /** Downloads a catalog theme and installs it, or names the file theme it would replace. */
    installCatalog(id: string): Promise<CatalogInstallResult>
    onChanged(listener: (state: ThemesState) => void): () => void
  }
  /** Pull request authors' avatars, which main fetches from GitHub's avatar host. */
  avatars: {
    /** The picture as a data: URL, or null when it is none or did not load. */
    load(url: string): Promise<string | null>
  }
  loginItem: {
    getStatus(): Promise<LoginItemStatus>
  }
  dialogs: {
    openProject(): Promise<string | null>
    chooseAgentBinary(harnessId: HarnessId): Promise<string | null>
    /** Picks or creates a configuration folder for an agent to add, which `addAgent` accepts. */
    chooseAgentFolder(): Promise<string | null>
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
    /** Opens third-party-notices.txt in the system's app for text files. */
    openNotices(): Promise<void>
  }
  /** Actions on a file served on the media scheme, by its URL, or on bytes the thread carries. */
  media: {
    /** Puts the picture on the clipboard as an image. */
    copyImage(source: string | CarriedMedia): Promise<void>
    /** Saves a copy where the save dialog says; false when cancelled. */
    saveAs(source: string | CarriedMedia): Promise<boolean>
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
  /** The page in the side panel's browser, one per session, all in one profile. */
  browser: {
    /** Shows a session's page, or nothing when it has none yet. */
    show(sessionId: string): Promise<void>
    /** Hides the page, keeping it alive for when the pane shows again. */
    hide(sessionId: string): Promise<void>
    /** Where the pane's page sits, in device-independent pixels; null while it is not shown. */
    setBounds(sessionId: string, bounds: BrowserBounds): Promise<void>
    navigate(sessionId: string, url: string): Promise<void>
    back(sessionId: string): Promise<void>
    forward(sessionId: string): Promise<void>
    reload(sessionId: string): Promise<void>
    stop(sessionId: string): Promise<void>
    /** Opens the page's current address in the system browser. */
    openExternal(sessionId: string): Promise<void>
    /** A still of the page for the pane to show, after which main hides the view. */
    freeze(sessionId: string): Promise<string | null>
    thaw(sessionId: string): Promise<void>
    /** Takes the page back from the user, so the agent may drive it again. */
    handBack(sessionId: string): Promise<void>
    /** The driving bar's Stop: the user takes control, and the running call fails. */
    stopDriving(sessionId: string): Promise<void>
    /** The pane's bar or the thread's card: what the user answered a new site's request. */
    answerOrigin(
      sessionId: string,
      requestId: number,
      decision: BrowserOriginDecision,
    ): Promise<void>
    /** The sites each project always lets agents open. */
    allowedSites(): Promise<AllowedSites[]>
    removeAllowedSite(projectPath: string, origin: string): Promise<void>
    /** Clears the profile's cookies, site storage and cache. */
    clearData(): Promise<void>
    /** The sessions that still exist; a page whose session does not is closed. */
    setSessions(sessionIds: string[]): void
    onState(listener: (state: BrowserState) => void): () => void
    /** An agent opened a session's page for the first time. */
    onOpened(listener: (event: { sessionId: string }) => void): () => void
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
