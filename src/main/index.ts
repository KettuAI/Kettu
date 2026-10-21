import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { AgentHost } from './agent-host'
import { applyBadgeTo, setBadgeCount, setBadgeEnabled } from './badge'
import { registerIpcHandlers } from './ipc'
import { createLogger } from './log'
import { notifyAttention } from './notifications'
import { SettingsStore } from './settings'
import { hostSettings, terminalSettings } from './settings-schema'
import { TerminalHost } from './terminal-host'
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

async function start(): Promise<void> {
  const perf = process.argv.includes('--overbench-perf')
  const userDataPath = app.getPath('userData')
  // Read while Electron starts, so the first window already has the right theme and bounds.
  const loading = Promise.all([
    SettingsStore.load(userDataPath),
    WindowStateStore.load(userDataPath),
  ])
  let ready = false
  app.on('second-instance', () => {
    if (ready) showMainWindow()
  })

  await app.whenReady()
  electronApp.setAppUserModelId(APP_USER_MODEL_ID)
  const [settings, windowState] = await loading

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

  settings.onChange((next, changed) => {
    if (changed.has('agents') || changed.has('proxy') || changed.has('git')) {
      agentHost.pushSettings(hostSettings(next))
    }
    if (changed.has('terminal')) terminalHost.pushSettings(terminalSettings(next))
    if (changed.has('appearance')) applyTheme(next.appearance.theme)
    if (changed.has('notifications')) setBadgeEnabled(next.notifications.badge)
  })

  app.on('browser-window-created', (_, window) => {
    // F12 toggles DevTools in development; reload shortcuts are disabled in production.
    optimizer.watchWindowShortcuts(window)
    window.once('show', () => applyBadgeTo(window))
  })

  registerIpcHandlers()
  agentHost.start()
  createMainWindow()
  ready = true

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  let stopping = false
  app.on('before-quit', (event) => {
    if (stopping) return
    event.preventDefault()
    stopping = true
    void Promise.all([agentHost.stop(), terminalHost.stop()])
      .then(() => Promise.all([settings.flush(), windowState.flush()]))
      .finally(() => app.quit())
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
