import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { createLogger } from './log'
import { SettingsStore } from './settings'
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
  settings.onChange((next, changed) => {
    if (changed.has('appearance')) applyTheme(next.appearance.theme)
  })

  // F12 toggles DevTools in development; reload shortcuts are disabled in production.
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  registerIpcHandlers()
  createMainWindow()
  ready = true

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => {
    void Promise.all([settings.flush(), windowState.flush()])
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
