import { join } from 'node:path'
import { app, powerMonitor, protocol, safeStorage, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { matchLocale, resolveLocale, type Locale } from '@shared/locale'
import { stepZoom, type SettingsFile, type ZoomStep } from '@shared/settings'
import { AgentHost } from './agent-host'
import { Artifacts, disableDnsPrefetching } from './artifacts'
import { artifactScheme } from './artifacts/protocol'
import { AppStateStore } from './app-state'
import { applyBadgeTo, setBadgeCount, setBadgeEnabled } from './badge'
import { broadcast } from './events'
import { locale as currentLocale, setLocale } from './i18n'
import { registerIpcHandlers } from './ipc'
import { MediaGrants, mediaScheme, serveMedia } from './media'
import { createLogger } from './log'
import { installMenu } from './menu'
import { isOpenedAtLogin, startMode, syncLoginItem } from './login-item'
import { notifyAttention } from './notifications'
import { RoutinesAwake } from './power-save'
import { sessionProxy } from './proxy'
import { Sharing } from './sharing'
import { restrictPermissions } from './permissions'
import { QuitFlow } from './quit'
import { isRendererUrl } from './renderer'
import { SettingsStore } from './settings'
import { hostSettings, reachesHost, terminalSettings } from './settings-schema'
import { hasPendingFrame, isRevoked, watchSubframes } from './subframes'
import { TerminalHost } from './terminal-host'
import { readThemeFolder, ThemeStore } from './themes'
import { Updater } from './updater'
import { devUserDataPath } from './user-data'
import {
  applyTheme,
  applyWindowTheme,
  applyZoom,
  configureWindows,
  createMainWindow,
  devIcon,
  showMainWindow,
  watchTheme,
  WindowStateStore,
} from './window'

// Must match appId in electron-builder.yml so Windows groups taskbar entries correctly.
const APP_USER_MODEL_ID = 'com.overbench.app'

const log = createLogger('main')

// Chromium draws classic scrollbars with arrow buttons on Linux; overlay ones take no room and
// fade when idle, as on macOS. Windows reads the feature before this code runs, so the renderer
// draws its scrollbars there (globals.css).
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar')
}

// Set before anything reads the data folder and before the single-instance lock, which Electron
// keys on it.
const devUserData = devUserDataPath({
  isPackaged: app.isPackaged,
  switchValue: app.commandLine.getSwitchValue('user-data-dir'),
  appData: app.getPath('appData'),
  override: process.env['OVERBENCH_USER_DATA'],
  cwd: process.cwd(),
})
if (devUserData) {
  app.setPath('userData', devUserData)
  log.info(`Development run: data in ${devUserData}`)
}

// Before the app is ready, and only once.
protocol.registerSchemesAsPrivileged([artifactScheme, mediaScheme])
disableDnsPrefetching()

async function start(): Promise<void> {
  const perf = process.argv.includes('--overbench-perf')
  const userDataPath = app.getPath('userData')
  const themesDir = join(userDataPath, 'themes')
  // Read while Electron starts, so the first window already has the right theme and bounds.
  const loading = Promise.all([
    SettingsStore.load(userDataPath),
    WindowStateStore.load(userDataPath),
    AppStateStore.load(userDataPath),
    readThemeFolder(themesDir),
  ])
  let ready = false
  app.on('second-instance', () => {
    if (ready) showMainWindow()
  })

  await app.whenReady()
  electronApp.setAppUserModelId(APP_USER_MODEL_ID)
  const wasOpenedAtLogin =
    process.platform === 'darwin' ? app.getLoginItemSettings().wasOpenedAtLogin : false
  const start = startMode(
    process.platform,
    isOpenedAtLogin(process.platform, process.argv, wasOpenedAtLogin),
  )
  const icon = devIcon()
  if (icon) app.dock?.setIcon(icon)
  restrictPermissions(
    session.defaultSession,
    isRendererUrl,
    (contents) => isRevoked(contents) || hasPendingFrame(contents),
  )
  const [settings, windowState, appState, themeFolder] = await loading
  syncLoginItem(settings.get().general.openAtLogin)

  // The system's languages are read once; macOS and Windows ask for a restart to change them.
  const systemLocale = matchLocale(app.getPreferredSystemLanguages())
  const localeOf = (file: SettingsFile): Locale =>
    resolveLocale(file.general.language, systemLocale)
  setLocale(localeOf(settings.get()))
  applyTheme(settings.get().appearance.theme)
  applyZoom(settings.get().appearance.zoom)
  const themes = new ThemeStore(themeFolder, settings.get().appearance.colorTheme, {
    dir: themesDir,
    select: (id) => settings.update({ appearance: { colorTheme: id } }),
    changed: (state, chosen) => {
      applyWindowTheme(chosen)
      broadcast('themes:changed', state)
    },
  })
  applyWindowTheme(themes.chosenTheme())
  watchTheme()
  configureWindows({ state: windowState, perf, systemLocale })
  setBadgeEnabled(settings.get().notifications.badge)

  const mediaGrants = new MediaGrants()
  const routinesAwake = new RoutinesAwake()
  const terminalHost = new TerminalHost({ settings: () => terminalSettings(settings.get()) })
  // Set once the sharing service exists; the host reports ready only after that, at each start.
  let reconcileSharing: (() => void) | null = null
  const agentHost = new AgentHost({
    settings: () => hostSettings(settings.get(), systemLocale),
    onAttention: (message) => notifyAttention(message, settings.get()),
    onBadge: setBadgeCount,
    onProjects: (paths) => terminalHost.setProjects(paths),
    onAuthCommands: (commands) => terminalHost.setAuthCommands(commands),
    onMediaGrant: (grant) => mediaGrants.add(grant),
    onMediaRevoke: (sessionId) => mediaGrants.revoke(sessionId),
    onRoutinesWorking: (working) => routinesAwake.set(working),
    onReady: () => reconcileSharing?.(),
  })
  const artifacts = new Artifacts({
    content: (id, version) => agentHost.artifactContent(id, version),
    contentDir: join(userDataPath, 'artifacts', 'content'),
    thumbnailDir: join(userDataPath, 'artifacts', 'thumbnails'),
    importFile: (path, project) => agentHost.artifactImport(path, project),
  })
  await artifacts.install(session.defaultSession)
  serveMedia(session.defaultSession, mediaGrants, isRendererUrl)
  // A session of its own, so publishing follows the proxy setting rather than the artifacts'
  // window proxy, and keeps no cookies or storage of its own.
  const sharingSession = session.fromPartition('overbench-sharing')
  await sharingSession.setProxy(sessionProxy(settings.get().proxy))
  const sharing = await Sharing.load({
    userDataPath,
    contentDir: join(userDataPath, 'artifacts', 'content'),
    host: {
      content: (id, version) => agentHost.artifactContent(id, version),
      ids: () => agentHost.artifactIds(),
    },
    cipher: {
      encrypt: async (text) => (await safeStorage.encryptStringAsync(text)).toString('base64'),
      decrypt: async (encoded) =>
        (await safeStorage.decryptStringAsync(Buffer.from(encoded, 'base64'))).result,
    },
    encryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    plainText: () =>
      process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text',
    fetch: (url, init) => sharingSession.fetch(url, init) as unknown as Promise<Response>,
    changed: (status) => broadcast('sharing:changed', status),
  })
  reconcileSharing = () => void sharing.reconcile()
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
      await Promise.all([settings.flush(), windowState.flush(), appState.flush(), sharing.flush()])
    },
    installUpdate: () => updater.installNow(),
  })
  const quitFlow = quit

  const menuDeps = {
    checkForUpdates: () => void updater.check(),
    zoom: (step: ZoomStep) => {
      settings.update({ appearance: { zoom: stepZoom(settings.get().appearance.zoom, step) } })
    },
  }
  settings.onChange((next, changed) => {
    broadcast('settings:changed', next)
    const localeChanged = localeOf(next) !== currentLocale()
    if (localeChanged) {
      setLocale(localeOf(next))
      installMenu(menuDeps)
    }
    if (reachesHost(changed) || localeChanged) {
      agentHost.pushSettings(hostSettings(next, systemLocale))
    }
    if (changed.has('terminal')) terminalHost.pushSettings(terminalSettings(next))
    if (changed.has('appearance')) {
      applyTheme(next.appearance.theme)
      applyZoom(next.appearance.zoom)
      themes.choose(next.appearance.colorTheme)
    }
    if (changed.has('notifications')) setBadgeEnabled(next.notifications.badge)
    if (changed.has('general')) syncLoginItem(next.general.openAtLogin)
    if (changed.has('proxy')) void sharingSession.setProxy(sessionProxy(next.proxy))
    updater.settingsChanged(next, changed)
  })

  registerIpcHandlers({
    settings,
    themes,
    agentHost,
    terminalHost,
    artifacts,
    mediaGrants,
    sharing,
    updater,
    quit: quitFlow,
    perf,
  })
  installMenu(menuDeps)

  app.on('browser-window-created', (_, window) => {
    // The thumbnails' offscreen windows load no app page and keep their own guards.
    if (window.webContents.isOffscreen()) return
    // F12 toggles DevTools in development; reload shortcuts are disabled in production. Without
    // zoom: true it swallows Mod+- and Mod+Shift+=, which the menu and the renderer handle.
    optimizer.watchWindowShortcuts(window, { zoom: true })
    quitFlow.watchWindow(window)
    watchSubframes(window.webContents, {
      isOpenedArtifact: (url) => artifacts.origins.isOpenedIn(window.webContents, url),
      onRevoked: () => {
        agentHost.revoke(window.webContents)
        terminalHost.revoke(window.webContents)
      },
    })
    artifacts.watchWindow(window.webContents)
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
  powerMonitor.on('suspend', () => agentHost.power('suspend'))
  powerMonitor.on('resume', () => agentHost.power('resume'))

  agentHost.start()
  const window = createMainWindow(start)
  window.once('show', () => updater.start())
  ready = true

  app.on('activate', () => {
    if (!quitFlow.quitting) showMainWindow()
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
