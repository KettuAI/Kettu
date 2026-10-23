import { isAbsolute } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  shell,
} from 'electron'
import { ATTACHMENT_LIMIT } from '@shared/attachments'
import type {
  AppInfo,
  IpcInvokeChannel,
  IpcInvokeResult,
  IpcSendContract,
  UnsavedFile,
} from '@shared/ipc'
import { AGENT_IDS, type AgentId } from '@shared/thread'
import type { AgentHost } from './agent-host'
import { grantPaths } from './attachments'
import { mainDiagnostics, saveDiagnostics } from './diagnostics'
import { isExecutableFile } from './executable'
import { t } from './i18n'
import { createLogger } from './log'
import { notifyTest } from './notifications'
import type { QuitFlow } from './quit'
import { isRendererUrl } from './renderer'
import type { SettingsStore } from './settings'
import { hasSubframe } from './subframes'
import type { TerminalHost } from './terminal-host'
import type { Updater } from './updater'

const log = createLogger('ipc')

export interface IpcDeps {
  settings: SettingsStore
  agentHost: AgentHost
  terminalHost: TerminalHost
  updater: Updater
  quit: QuitFlow
  /** Started with --overbench-perf. */
  perf: boolean
}

interface Caller {
  window: BrowserWindow | null
  event: IpcMainInvokeEvent | IpcMainEvent
}

/** Only the app's own pages, in its own windows and with no subframe, may call main. */
export function isTrusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame
  return (
    frame !== null &&
    frame === event.sender.mainFrame &&
    isRendererUrl(frame.url) &&
    !hasSubframe(event.sender) &&
    BrowserWindow.fromWebContents(event.sender) !== null
  )
}

function handle<C extends IpcInvokeChannel>(
  channel: C,
  arity: number,
  handler: (caller: Caller, ...args: unknown[]) => IpcInvokeResult<C> | Promise<IpcInvokeResult<C>>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrusted(event)) throw new Error(`Rejected "${channel}" call from untrusted sender`)
    if (args.length !== arity) {
      throw new Error(`"${channel}" takes ${arity} argument(s), got ${args.length}`)
    }
    return handler({ window: BrowserWindow.fromWebContents(event.sender), event }, ...args)
  })
}

function on<C extends keyof IpcSendContract>(
  channel: C,
  handler: (event: IpcMainEvent, ...args: unknown[]) => void,
): void {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (!isTrusted(event)) {
      log.warn(`Rejected "${channel}" message from untrusted sender`)
      return
    }
    handler(event, ...args)
  })
}

function agentId(value: unknown): AgentId {
  if (typeof value !== 'string' || !AGENT_IDS.includes(value as AgentId)) {
    throw new Error(`Unknown agent "${String(value)}"`)
  }
  return value as AgentId
}

const SHOW_ITEM_MAX_CHARS = 4_096

/** A path to reveal in the file manager: untrusted input from the renderer. */
function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SHOW_ITEM_MAX_CHARS) {
    throw new Error(`A path must be a string of 1 to ${SHOW_ITEM_MAX_CHARS} characters`)
  }
  if (value.includes('\0')) throw new Error('A path must not contain a NUL character')
  if (!isAbsolute(value)) throw new Error('A path must be absolute')
  return value
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
  agentHost,
  terminalHost,
  updater,
  quit,
  perf,
}: IpcDeps): void {
  handle('app:get-info', 0, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
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
    const agent = agentId(id)
    const path = await chooseProgram(window, t('dialogs.chooseAgentProgram'))
    if (path) settings.setAgentBinary(agent, path)
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

  handle('notifications:test', 0, () => notifyTest(settings.get()))

  handle('update:get-status', 0, () => updater.getStatus())
  handle('update:check', 0, () => updater.check())
  handle('update:download', 0, () => updater.download())
  handle('update:restart', 0, () => updater.restart())
  handle('update:dismiss', 0, () => updater.dismiss())

  handle('agent-host:restart', 0, () => {
    agentHost.restart()
  })
  handle('terminal-host:restart', 0, () => {
    terminalHost.restart()
  })

  handle('perf:metrics', 0, () => {
    if (!perf) throw new Error('"perf:metrics" needs --overbench-perf')
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
