import { isAbsolute, join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  shell,
} from 'electron'
import { ATTACHMENT_LIMIT } from '@shared/attachments'
import type { BrowserBounds, BrowserOriginDecision } from '@shared/browser'
import type {
  AppInfo,
  IpcInvokeChannel,
  IpcInvokeResult,
  IpcSendContract,
  UnsavedFile,
} from '@shared/ipc'
import { isHarnessId, type HarnessId } from '@shared/thread'
import { AgentFolders } from './agent-folders'
import type { AgentHost } from './agent-host'
import { grantClipboardFiles, grantPaths } from './attachments'
import type { Artifacts } from './artifacts'
import type { Avatars } from './avatars'
import type { BrowserViews } from './browser/views'
import { originOf } from './browser/origins'
import { mainDiagnostics, saveDiagnostics } from './diagnostics'
import { isExecutableFile } from './executable'
import { t } from './i18n'
import { loginItemStatus } from './login-item'
import { createLogger } from './log'
import { grantedPath, type MediaGrants } from './media'
import { copyImage, revealMedia, saveMediaAs } from './media-actions'
import { notifyTest } from './notifications'
import type { QuitFlow } from './quit'
import { isRendererUrl } from './renderer'
import type { SettingsStore } from './settings'
import type { Sharing } from './sharing'
import { framesSettled, isRevoked } from './subframes'
import { systemNameForRun } from './system-name'
import type { TerminalHost } from './terminal-host'
import type { ThemeStore } from './themes'
import type { Updater } from './updater'

const log = createLogger('ipc')

export interface IpcDeps {
  settings: SettingsStore
  themes: ThemeStore
  avatars: Avatars
  agentHost: AgentHost
  terminalHost: TerminalHost
  artifacts: Artifacts
  browserViews: BrowserViews
  mediaGrants: MediaGrants
  sharing: Sharing
  updater: Updater
  quit: QuitFlow
  /** Started with --kettu-perf. */
  perf: boolean
}

interface Caller {
  window: BrowserWindow | null
  event: IpcMainInvokeEvent | IpcMainEvent
}

/**
 * Only the app's own pages, in its own windows and with no frame the frame guard refused, may call
 * main.
 */
export function isTrusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame
  return (
    frame !== null &&
    frame === event.sender.mainFrame &&
    isRendererUrl(frame.url) &&
    !isRevoked(event.sender) &&
    BrowserWindow.fromWebContents(event.sender) !== null
  )
}

/**
 * Runs `run` with `isTrusted`, at once, or while a frame of the page is pending, once every frame
 * has committed. Held calls and messages start in the order they came, before any that come after.
 */
export function whenSettled<T>(
  event: IpcMainInvokeEvent | IpcMainEvent,
  run: (trusted: boolean) => T,
): T | Promise<T> {
  const settling = framesSettled(event.sender)
  return settling ? settling.then<T>(() => run(isTrusted(event))) : run(isTrusted(event))
}

function handle<C extends IpcInvokeChannel>(
  channel: C,
  arity: number,
  handler: (caller: Caller, ...args: unknown[]) => IpcInvokeResult<C> | Promise<IpcInvokeResult<C>>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) =>
    whenSettled(event, (trusted) => {
      if (!trusted) throw new Error(`Rejected "${channel}" call from untrusted sender`)
      if (args.length !== arity) {
        throw new Error(`"${channel}" takes ${arity} argument(s), got ${args.length}`)
      }
      return handler({ window: BrowserWindow.fromWebContents(event.sender), event }, ...args)
    }),
  )
}

function on<C extends keyof IpcSendContract>(
  channel: C,
  handler: (event: IpcMainEvent, ...args: unknown[]) => void,
): void {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    void whenSettled(event, (trusted) => {
      if (trusted) handler(event, ...args)
      else log.warn(`Rejected "${channel}" message from untrusted sender`)
    })
  })
}

function harnessId(value: unknown): HarnessId {
  if (!isHarnessId(value)) throw new Error(`Unknown harness "${String(value)}"`)
  return value
}

const SESSION_ID_MAX_CHARS = 256
const URL_MAX_CHARS = 8_192
const BOUNDS_MAX = 100_000

/** A session a browser call is for: untrusted input from the renderer. */
function sessionId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SESSION_ID_MAX_CHARS ||
    value.includes('\0')
  ) {
    throw new Error(`A session id must be a string of 1 to ${SESSION_ID_MAX_CHARS} characters`)
  }
  return value
}

/** An address the browser may open, and nothing else. */
function browserUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX_CHARS) {
    throw new Error(`A browser URL must be a string of 1 to ${URL_MAX_CHARS} characters`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('A browser URL must be absolute')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('A browser URL must be http or https')
  }
  return url.href
}

function browserBounds(value: unknown): BrowserBounds {
  if (typeof value !== 'object' || value === null)
    throw new Error('Browser bounds must be an object')
  const { x, y, width, height, radius } = value as Record<string, unknown>
  const numbers = [x, y, width, height, radius]
  if (
    numbers.some(
      (number) =>
        typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > BOUNDS_MAX,
    )
  ) {
    throw new Error('Browser bounds take five numbers from 0 to 100000')
  }
  return {
    x: Math.round(x as number),
    y: Math.round(y as number),
    width: Math.round(width as number),
    height: Math.round(height as number),
    radius: Math.round(radius as number),
  }
}

const SHOW_ITEM_MAX_CHARS = 4_096

/** An origin Settings lists: scheme, host and port, as it was stored. */
function browserOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX_CHARS) {
    throw new Error(`An origin must be a string of 1 to ${URL_MAX_CHARS} characters`)
  }
  if (originOf(value) !== value) throw new Error('An origin is a scheme, a host and a port')
  return value
}

/** A request id main handed out for a new origin. */
function originRequestId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('A browser origin request id must be a positive integer')
  }
  return value as number
}

/** The user's answer to a new origin, as the pane or the card gives it. */
function originDecision(value: unknown): BrowserOriginDecision {
  if (value !== 'session' && value !== 'project' && value !== 'deny') {
    throw new Error('A browser origin answer must be session, project or deny')
  }
  return value
}

/** A path to reveal in the file manager: untrusted input from the renderer. */
function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SHOW_ITEM_MAX_CHARS) {
    throw new Error(`A path must be a string of 1 to ${SHOW_ITEM_MAX_CHARS} characters`)
  }
  if (value.includes('\0')) throw new Error('A path must not contain a NUL character')
  if (!isAbsolute(value)) throw new Error('A path must be absolute')
  return value
}

/**
 * `shell:open-notices`: third-party-notices.txt from the resources folder, or the last build's in
 * a development run, in the system's app for text files.
 */
export async function openNotices(): Promise<void> {
  const file = app.isPackaged
    ? join(process.resourcesPath, 'third-party-notices.txt')
    : join(app.getAppPath(), 'out', 'third-party-notices.txt')
  const error = await shell.openPath(file)
  if (error) throw new Error(error)
}

/** The `text/uri-list` the clipboard holds, as the file manager writes copied files. */
async function clipboardUriList(): Promise<string | null> {
  const [item] = await clipboard.read()
  if (!item?.types.includes('text/uri-list')) return null
  return (await item.getType('text/uri-list')).text()
}

/** Dropped or pasted paths: the renderer passes no more than fit in one message. */
function attachmentPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMIT) {
    throw new Error(`Attachments take a list of at most ${ATTACHMENT_LIMIT} paths`)
  }
  return value.map(absolutePath)
}

// One open file per project, so more than this many is not what the renderer sends.
const UNSAVED_MAX_FILES = 1_000

/** The renderer's files with unsaved edits, or null when they are not that shape. */
function unsavedFiles(value: unknown): UnsavedFile[] | null {
  if (!Array.isArray(value) || value.length > UNSAVED_MAX_FILES) return null
  const files: UnsavedFile[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const { projectPath, path } = item as Record<string, unknown>
    if (typeof projectPath !== 'string' || projectPath.length > SHOW_ITEM_MAX_CHARS) return null
    if (typeof path !== 'string' || path.length > SHOW_ITEM_MAX_CHARS) return null
    files.push({ projectPath, path })
  }
  return files
}

async function chooseProgram(window: BrowserWindow | null, title: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title,
    properties: ['openFile', 'dontAddToRecent'],
    ...(process.platform === 'win32'
      ? { filters: [{ name: t('dialogs.programs'), extensions: ['exe', 'cmd', 'bat', 'com'] }] }
      : {}),
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  const [path] = result.filePaths
  if (result.canceled || !path) return null
  if (!(await isExecutableFile(path, process.platform))) {
    throw new Error(`"${path}" is not a program that can be run`)
  }
  return path
}

let launchToInteractiveMs: number | null = null

export function registerIpcHandlers({
  settings,
  themes,
  avatars,
  agentHost,
  terminalHost,
  artifacts,
  browserViews,
  mediaGrants,
  sharing,
  updater,
  quit,
  perf,
}: IpcDeps): void {
  handle('app:get-info', 0, async (): Promise<AppInfo> => ({
    name: app.getName(),
    version: app.getVersion(),
    system: await systemNameForRun(),
    userDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
  }))

  handle('app:respond-quit', 2, (_, id, confirmed) => {
    if (!Number.isSafeInteger(id) || typeof confirmed !== 'boolean') {
      throw new Error('"app:respond-quit" takes a request id and a boolean')
    }
    quit.respond(id as number, confirmed)
  })

  handle('settings:get', 0, () => settings.get())
  handle('settings:update', 1, (_, patch) => settings.update(patch))
  const agentFolders = new AgentFolders(settings, join(app.getPath('userData'), 'agent-config'))
  handle('settings:add-agent', 3, (_, harness, name, folder) =>
    agentFolders.add(harness, name, folder),
  )
  handle('settings:rename-agent', 2, (_, id, name) => agentFolders.rename(id, name))
  handle('settings:remove-agent', 2, (_, id, trash) => agentFolders.remove(id, trash))
  handle('login-item:status', 0, () => loginItemStatus())

  handle('themes:get', 0, () => themes.refresh())
  handle('themes:install', 0, ({ window }) => themes.install(window))
  handle('themes:replace', 1, (_, token) => themes.replace(token))
  handle('themes:remove', 1, (_, id) => themes.remove(id))
  handle('themes:export', 1, ({ window }, text) => themes.export(window, text))
  handle('themes:reveal', 1, (_, id) => themes.reveal(id))
  handle('themes:catalog', 1, (_, refresh) => themes.catalog(refresh))
  handle('themes:install-catalog', 1, (_, id) => themes.installCatalog(id))
  handle('avatars:load', 1, (_, url) => {
    if (typeof url !== 'string' || url.length > URL_MAX_CHARS) {
      throw new Error(`An avatar URL must be a string of at most ${URL_MAX_CHARS} characters`)
    }
    return avatars.load(url)
  })

  handle('dialog:open-project', 0, async ({ window }) => {
    const options: Electron.OpenDialogOptions = {
      title: t('dialogs.openProject'),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle('dialog:choose-agent-binary', 1, async ({ window }, id) => {
    const harness = harnessId(id)
    const path = await chooseProgram(window, t('dialogs.chooseAgentProgram'))
    if (path) settings.setAgentBinary(harness, path)
    return path
  })

  handle('dialog:choose-agent-folder', 0, async ({ window }) => {
    const options: Electron.OpenDialogOptions = {
      title: t('dialogs.chooseAgentFolder'),
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles', 'dontAddToRecent'],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const path = result.canceled ? null : (result.filePaths[0] ?? null)
    if (path) agentFolders.remember(path)
    return path
  })

  handle('dialog:choose-shell', 0, async ({ window }) => {
    const path = await chooseProgram(window, t('dialogs.chooseShell'))
    if (path) settings.setShellPath(path)
    return path
  })

  handle('dialog:add-attachments', 2, async ({ window }, kind, defaultPath) => {
    if (kind !== 'files' && kind !== 'folder') throw new Error('kind must be files or folder')
    const options: Electron.OpenDialogOptions = {
      title: t(kind === 'files' ? 'dialogs.addFiles' : 'dialogs.addFolder'),
      properties: [
        kind === 'files' ? 'openFile' : 'openDirectory',
        'multiSelections',
        'dontAddToRecent',
      ],
      ...(defaultPath === null ? {} : { defaultPath: absolutePath(defaultPath) }),
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    const granted = await grantPaths(result.filePaths, (grants) => agentHost.grant(grants))
    return granted.flatMap((item) => (item ? [item] : []))
  })

  handle('attachments:grant', 1, (_, paths) =>
    grantPaths(attachmentPaths(paths), (grants) => agentHost.grant(grants)),
  )

  handle('attachments:clipboard-files', 1, async (_, pastedPath) =>
    grantClipboardFiles(absolutePath(pastedPath), await clipboardUriList(), (grants) =>
      agentHost.grant(grants),
    ),
  )

  handle('diagnostics:save', 1, ({ window }, bundle) =>
    saveDiagnostics(
      window,
      bundle,
      mainDiagnostics({ agentHost, terminalHost, launchToInteractiveMs }),
    ),
  )

  handle('shell:show-data-folder', 0, async () => {
    const error = await shell.openPath(app.getPath('userData'))
    if (error) throw new Error(error)
  })

  // Revealing selects the item in the file manager and never runs it, unlike shell.openPath.
  handle('shell:show-item', 1, (_, target) => {
    shell.showItemInFolder(absolutePath(target))
  })

  handle('shell:open-notices', 0, () => openNotices())

  handle('media:copy-image', 1, (_, source) => copyImage(source, mediaGrants))
  handle('media:save-as', 1, ({ window }, source) => saveMediaAs(window, source, mediaGrants))
  handle('media:reveal', 1, (_, url) => revealMedia(url, mediaGrants))

  handle('media:open-external', 1, async (_, url) => {
    const error = await shell.openPath(await grantedPath(url, mediaGrants))
    if (error) throw new Error(error)
  })

  handle('notifications:test', 0, () => notifyTest(settings.get()))

  handle('update:get-status', 0, () => updater.getStatus())
  handle('update:check', 0, () => updater.check())
  handle('update:download', 0, () => updater.download())
  handle('update:cancel', 0, () => updater.cancel())
  handle('update:restart', 0, () => updater.restart())
  handle('update:dismiss', 0, () => updater.dismiss())

  handle('agent-host:restart', 0, () => {
    agentHost.restart()
  })
  handle('terminal-host:restart', 0, () => {
    terminalHost.restart()
  })

  handle('perf:metrics', 0, () => {
    if (!perf) throw new Error('"perf:metrics" needs --kettu-perf')
    return {
      launchToInteractiveMs,
      processes: app.getAppMetrics().map((metric) => ({
        type: metric.type,
        name: metric.name ?? null,
        pid: metric.pid,
        workingSetKB: metric.memory.workingSetSize,
      })),
    }
  })

  handle('artifact:open', 1, ({ event }, id) => artifacts.open(event.sender, id))
  handle('artifact:close', 1, ({ event }, url) => artifacts.close(event.sender, url))
  handle('artifact:thumbnail', 3, (_, id, version, layout) =>
    artifacts.thumbnail(id, version, layout),
  )
  handle('artifact:open-external', 2, (_, id, version) => artifacts.openExternal(id, version))
  handle('artifact:export', 2, ({ window }, id, version) => artifacts.export(window, id, version))
  handle('artifact:import', 1, ({ window }, project) => artifacts.import(window, project))

  handle('sharing:status', 0, () => sharing.status())
  handle('sharing:connect', 2, (_, token, accountId) => sharing.connect(token, accountId))
  handle('sharing:remove', 0, () => sharing.remove())
  handle('sharing:publish', 2, (_, id, version) => sharing.publish(id, version))
  handle('sharing:update', 2, (_, id, version) => sharing.update(id, version))
  handle('sharing:unpublish', 1, (_, id) => sharing.unpublish(id))

  handle('browser:show', 1, (_, id) => browserViews.show(sessionId(id)))
  handle('browser:hide', 1, (_, id) => browserViews.hide(sessionId(id)))
  handle('browser:bounds', 2, (_, id, bounds) =>
    browserViews.setBounds(sessionId(id), browserBounds(bounds)),
  )
  // The pane's own controls act for the user: each first takes control from an agent driving.
  handle('browser:navigate', 2, (_, id, url) => {
    browserViews.userInput(sessionId(id))
    browserViews.navigate(sessionId(id), browserUrl(url))
  })
  handle('browser:back', 1, (_, id) => {
    browserViews.userInput(sessionId(id))
    browserViews.back(sessionId(id))
  })
  handle('browser:forward', 1, (_, id) => {
    browserViews.userInput(sessionId(id))
    browserViews.forward(sessionId(id))
  })
  handle('browser:reload', 1, (_, id) => {
    browserViews.userInput(sessionId(id))
    browserViews.reload(sessionId(id))
  })
  handle('browser:stop', 1, (_, id) => browserViews.stop(sessionId(id)))
  handle('browser:open-external', 1, (_, id) => browserViews.openExternal(sessionId(id)))
  handle('browser:freeze', 1, (_, id) => browserViews.freeze(sessionId(id)))
  handle('browser:thaw', 1, (_, id) => browserViews.thaw(sessionId(id)))
  handle('browser:hand-back', 1, (_, id) => browserViews.handBack(sessionId(id)))
  handle('browser:stop-driving', 1, (_, id) => browserViews.stopDriving(sessionId(id)))
  // The pane's bar and the thread's card both answer through main, so the page and the thread agree.
  handle('browser:answer-origin', 3, (_, id, requestId, decision) => {
    browserViews.answerOrigin(sessionId(id), originRequestId(requestId), originDecision(decision))
  })
  handle('browser:allowed-sites', 0, () => browserViews.allowedSites())
  handle('browser:remove-allowed-site', 2, (_, projectPath, origin) => {
    browserViews.removeAllowedSite(absolutePath(projectPath), browserOrigin(origin))
  })
  handle('browser:clear-data', 0, () => browserViews.clearData())

  on('agent-host:connect', (event) => agentHost.connect(event.sender))
  on('terminal-host:connect', (event) => terminalHost.connect(event.sender))

  on('app:confirm-quit-unhandled', (event, id) => {
    if (Number.isSafeInteger(id)) quit.unhandled(id as number, event.sender)
  })

  on('app:set-unsaved', (event, files) => {
    const valid = unsavedFiles(files)
    if (valid) quit.setUnsaved(event.sender, valid)
    else log.warn('Rejected "app:set-unsaved" with malformed files')
  })

  on('browser:sessions', (_event, ids) => {
    if (
      !Array.isArray(ids) ||
      ids.length > 100_000 ||
      !ids.every((id) => typeof id === 'string' && id.length <= SESSION_ID_MAX_CHARS)
    ) {
      log.warn('Rejected "browser:sessions" with malformed ids')
      return
    }
    browserViews.setSessions(ids as string[])
  })

  on('perf:interactive', () => {
    const ms = Math.round(process.uptime() * 1000)
    if (launchToInteractiveMs === null) {
      launchToInteractiveMs = ms
      log.info(`perf:interactive ${ms} ms after launch`)
    } else {
      log.info(`perf:interactive again (a reload) at ${ms} ms`)
    }
  })
}
