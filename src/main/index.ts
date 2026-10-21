import { app, BrowserWindow, powerMonitor } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { AgentHost } from './agent-host'
import { AppStateStore } from './app-state'
import { applyBadgeTo, setBadgeCount, setBadgeEnabled } from './badge'
import { broadcast } from './events'
import { registerIpcHandlers } from './ipc'
import { createLogger } from './log'
import { installMenu } from './menu'
import { notifyAttention } from './notifications'
import { QuitFlow } from './quit'
import { SettingsStore } from './settings'
import { hostSettings, terminalSettings } from './settings-schema'
import { TerminalHost } from './terminal-host'
import { Updater } from './updater'
import {
  applyTheme,
  configureWindows,
  createMainWindow,
  showMainWindow,
  watchTheme,
  WindowStateStore,
} from './window'

// Must match appId in electron-builder.yml so Windows groups taskbar entries correctly.
const APP_USER_MODEL_ID = 'com.overbench.app'

const log = createLogger('main')

// Chromium draws classic scrollbars with arrow buttons on Linux; overlay ones take no room and
// fade when idle, as on macOS. Windows reads the feature before this code runs, so it keeps
// Chromium's Fluent scrollbars.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar')
}

async function start(): Promise<void> {
  const perf = process.argv.includes('--overbench-perf')
  const userDataPath = app.getPath('userData')
  // Read while Electron starts, so the first window already has the right theme and bounds.
  const loading = Promise.all([
    SettingsStore.load(userDataPath),
    WindowStateStore.load(userDataPath),
    AppStateStore.load(userDataPath),
  ])
  let ready = false
  app.on('second-instance', () => {
    if (ready) showMainWindow()
  })

  await app.whenReady()
  electronApp.setAppUserModelId(APP_USER_MODEL_ID)
  const [settings, windowState, appState] = await loading

  applyTheme(settings.get().appearance.theme)
  watchTheme()
  configureWindows({ state: windowState, perf })
  setBadgeEnabled(settings.get().notifications.badge)

  const terminalHost = new TerminalHost({ settings: () => terminalSettings(settings.get()) })
  const agentHost = new AgentHost({
    settings: () => hostSettings(settings.get()),
    onAttention: (message) => notifyAttention(message, settings.get()),
    onBadge: setBadgeCount,
    onProjects: (paths) => terminalHost.setProjects(paths),
    onAuthCommands: (commands) => terminalHost.setAuthCommands(commands),
  })
  let quit: QuitFlow | null = null
  const updater = new Updater({
    appState,
    settings: () => settings.get(),
    requestRestart: () => quit?.request('update'),
  })
  quit = new QuitFlow({
    settings: () => settings.get(),
    busySessions: (timeoutMs) => agentHost.busy(timeoutMs),
    busyTerminals: (timeoutMs) => terminalHost.busy(timeoutMs),
    shutDown: async () => {
      await Promise.all([agentHost.stop(), terminalHost.stop()])
      await Promise.all([settings.flush(), windowState.flush(), appState.flush()])
    },
    installUpdate: () => updater.installNow(),
  })
  const quitFlow = quit

  settings.onChange((next, changed) => {
    broadcast('settings:changed', next)
    if (changed.has('agents') || changed.has('proxy') || changed.has('git')) {
      agentHost.pushSettings(hostSettings(next))
    }
    if (changed.has('terminal')) terminalHost.pushSettings(terminalSettings(next))
    if (changed.has('appearance')) applyTheme(next.appearance.theme)
    if (changed.has('notifications')) setBadgeEnabled(next.notifications.badge)
    updater.settingsChanged(next, changed)
  })

  registerIpcHandlers({ settings, agentHost, terminalHost, updater, quit: quitFlow, perf })
  installMenu({ checkForUpdates: () => void updater.check() })

  app.on('browser-window-created', (_, window) => {
    // F12 toggles DevTools in development; reload shortcuts are disabled in production.
    optimizer.watchWindowShortcuts(window)
    quitFlow.watchWindow(window)
    window.once('show', () => applyBadgeTo(window))
    window.on('session-end', () => {
      quitFlow.systemShutdown()
      updater.systemShutdown()
    })
  })
  powerMonitor.on('shutdown', () => {
    quitFlow.systemShutdown()
    updater.systemShutdown()
  })

  agentHost.start()
  const window = createMainWindow()
  window.once('show', () => updater.start())
  ready = true

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !quitFlow.quitting) createMainWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  start().catch((error: unknown) => {
    log.error('Startup failed', error)
    app.exit(1)
  })
}
