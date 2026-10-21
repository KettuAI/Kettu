import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  shell,
} from 'electron'
import type { AppInfo, IpcInvokeChannel, IpcInvokeResult, IpcSendContract } from '@shared/ipc'
import { AGENT_IDS, type AgentId } from '@shared/thread'
import type { AgentHost } from './agent-host'
import { mainDiagnostics, saveDiagnostics } from './diagnostics'
import { isExecutableFile } from './executable'
import { createLogger } from './log'
import type { QuitFlow } from './quit'
import { isRendererUrl } from './renderer'
import type { SettingsStore } from './settings'
import type { TerminalHost } from './terminal-host'
import type { Updater } from './updater'

const log = createLogger('ipc')

export interface IpcDeps {
  settings: SettingsStore
  agentHost: AgentHost
  terminalHost: TerminalHost
  updater: Updater
  quit: QuitFlow
}

interface Caller {
  window: BrowserWindow | null
  event: IpcMainInvokeEvent | IpcMainEvent
}

/** Only the app's own pages, in its own windows, may call main. */
function isTrusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame
  return (
    frame !== null &&
    frame === event.sender.mainFrame &&
    isRendererUrl(frame.url) &&
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

async function chooseProgram(window: BrowserWindow | null, title: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title,
    properties: ['openFile', 'dontAddToRecent'],
    ...(process.platform === 'win32'
      ? { filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat', 'com'] }] }
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
      title: 'Open Project',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle('dialog:choose-agent-binary', 1, async ({ window }, id) => {
    const agent = agentId(id)
    const path = await chooseProgram(window, 'Choose Agent Program')
    if (path) settings.setAgentBinary(agent, path)
    return path
  })

  handle('dialog:choose-shell', 0, async ({ window }) => {
    const path = await chooseProgram(window, 'Choose Shell')
    if (path) settings.setShellPath(path)
    return path
  })

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

  on('agent-host:connect', (event) => agentHost.connect(event.sender))
  on('terminal-host:connect', (event) => terminalHost.connect(event.sender))

  on('app:confirm-quit-unhandled', (event, id) => {
    if (Number.isSafeInteger(id)) quit.unhandled(id as number, event.sender)
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
