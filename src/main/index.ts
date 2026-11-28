import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  nativeTheme,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
  webContents,
} from 'electron'
import { ATTENTION_SETTING } from '@shared/attention'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { ARTIFACT_ID, parseArtifactRef } from '@shared/artifacts'
import { BROWSER_PARTITION, sessionBrowserTabsOf } from '@shared/browser'
import { IDLE_CONTROL } from '@shared/control'
import { guardKettuFetch } from '@shared/kettu-hosts'
import { matchLocale, resolveLocale, type Locale } from '@shared/locale'
import type { MarketAccount } from '@shared/market-publish'
import {
  ARTIFACT_RECORDS,
  type DiagnosticsStatus,
  type HostAttention,
} from '@shared/remote/host-admin'
import { restartWaitsFor, type UpdateStatus } from '@shared/updates'
import { HOSTS_FILE, type HostsStatus } from '@shared/remote/hosts'
import { PUSH_URL, PUSH_URL_ENV, pushUrlFrom } from '@shared/remote/push'
import { RELAY_TOKENS_FEATURE, RELAY_URL, RELAY_URL_ENV, relayUrlFrom } from '@shared/remote/relay'
import type { RemoteStatus } from '@shared/remote/status'
import type { ComputerHold } from '@shared/computer-use'
import type { SettingFacts } from '@shared/host-control'
import { stepZoom, type SettingsFile, type ZoomStep } from '@shared/settings'
import { AGENTS_FOLDER, KETTU_HOME_FOLDER } from '@shared/storage'
import { Account, NotSignedIn } from './account'
import { ACCOUNT_URL, AccountApi, accountBaseUrl, clientInfo } from './account/service'
import { accountFile } from './account/store'
import { AgentFolders } from './agent-folders'
import { AgentHost } from './agent-host'
import { Artifacts, disableDnsPrefetching } from './artifacts'
import { artifactScheme } from './artifacts/protocol'
import { RemoteArtifacts } from './artifacts/remote'
import { AppStateStore } from './app-state'
import { applyAppIcon, initAppIcon } from './app-icon'
import { accountAvatarRequestUrl, Avatars } from './avatars'
import { applyBadgeTo, setBadgeCount, setBadgeEnabled } from './badge'
import { RemoteBrowser } from './browser/remote'
import { BrowserTabsReporter } from './browser/tabs-reporter'
import { BrowserViews } from './browser/views'
import { BrowserTools } from './browser/tools'
import { BrowserOriginStore } from './browser/origins'
import { SiteIcons } from './browser/site-icons'
import { startSignIns } from './browser/signins'
import {
  asksForDebug,
  debugStatus,
  isDebugRun,
  lockData,
  onDebugChanged,
  prepareRelaunch,
  startDebugMode,
} from './debug-mode'
import { broadcast, sendCommand } from './events'
import { HostAdmin } from './host-admin'
import { HostMedia } from './host-media'
import { HostSessions } from './host-sessions'
import type { BotHostTarget, BotRemoteAnswer, BotRemoteCall } from '@shared/bots'
import type { AgentStatus, HostEvent, Project, SessionSummary } from '@shared/agent-host'
import type { SessionSnapshot } from '@shared/thread'
import { locale as currentLocale, islandHelperStrings, islandT, setLocale, t } from './i18n'
import { IslandBridge } from './island/bridge'
import { appUpdate } from './island/notices'
import { spawnIslandHelper } from './island/helper'
import { IslandHostPort } from './island/host-port'
import { mainDiagnostics } from './diagnostics'
import {
  appInfo,
  launchToInteractive,
  registerIpcHandlers,
  registerSignInIpc,
  registerTrayIpc,
} from './ipc'
import { configurePageRecovery } from './page-recovery'
import { Reports } from './report'
import { MediaGrants, mediaScheme, serveMedia } from './media'
import { createLogger } from './log'
import { installMenu } from './menu'
import { isOpenedAtLogin, startMode, syncLoginItem } from './login-item'
import {
  notifyAttention,
  notifyDiscovery,
  notifyJoined,
  notifyNotice,
  RepeatedNotices,
} from './notifications'
import { RoutinesAwake } from './power-save'
import { sessionProxy } from './proxy'
import { Sharing } from './sharing'
import { KettuUnauthorized } from './sharing/kettu'
import { restrictPermissions } from './permissions'
import { QuitFlow } from './quit'
import { loadStoredDevices } from './remote-devices'
import { RemoteHost } from './remote-host'
import { RemoteOffers } from './remote-offer'
import {
  loadDeviceKey,
  loadIdentity,
  loadRelayKey,
  loadAccessKey,
  saveAccessKey,
  newIdentity,
  newRelayKey,
  type IdentityCipher,
} from './remote-identity'
import { watchPresence } from './presence'
import { RelayFeatures, RelayToken, readRelayFeatures } from './relay-token'
import { useOwnRelay } from './own-relay'
import { checkRelayHere } from '../remote-host/relay-net'
import { accessKeyEnd, relayChoiceInit } from '@shared/remote/own-relay'
import { relayReport } from '@shared/remote/status'
import { readJsonFile } from './json-file'
import { MarketKeys, marketKeysFile } from './market-keys'
import { installDiscoveredMcp } from './mcp-install'
import { MarketUnauthorized, runMarketCall } from './market-api'
import { computerModelForRun } from './system-model'
import { ComputerOverlay } from './computer-overlay'
import { computerAppIcon, computerUseStatus, serveComputerCapture } from './computer-use'
import { devicePlatformForRun, systemReleaseForRun } from './system-name'
import { rendererPage } from './renderer'
import { SettingsStore } from './settings'
import { answerSettingsCall } from './settings-call'
import { effectiveDirect, hostSettings, reachesHost, terminalSettings } from './settings-schema'
import { hasPendingFrame, isRevoked, watchSubframes } from './subframes'
import { DeviceHost } from './device-host'
import { PluginHost } from './plugin-host'
import { TerminalHost } from './terminal-host'
import { ThemeCatalog } from './theme-catalog'
import { readPluginThemes, readThemeFolder, readThemeSources, ThemeStore } from './themes'
import { KettuTray } from './tray'
import { TrayHostAgentsFeed } from './tray-host-agents'
import { openTrayTarget, TrayPanel } from './tray-panel'
import { Updater } from './updater'
import { clearUpdateResume, saveUpdateResume } from './update-resume'
import { devUserDataPath } from './user-data'
import {
  applyVerbose,
  clearVerboseRecords,
  logsFolder,
  markCleanExit,
  markRunning,
  openAppLog,
  watchConsole,
  watchProcesses,
} from './app-log'
import { WindowsSessionEndWatcher } from './windows-session-end'
import { redactLogText } from '@shared/log/process-log'
import { writeReport } from '@shared/log/report-bundle'
import { PLUGIN_THEMES_FILE } from '@shared/plugin-themes'
import {
  applyTheme,
  applyWindowTheme,
  applyZoom,
  appWindows,
  configureWindows,
  createMainWindow,
  currentWindow,
  isOverlayWindow,
  showMainWindow,
  watchTheme,
  WindowStateStore,
} from './window'

// Must match appId in electron-builder.yml so Windows groups taskbar entries correctly.
const APP_USER_MODEL_ID = 'sh.kettu.app'

const log = createLogger('main')
const actionLog = createLogger('action')

// Chromium draws classic scrollbars with arrow buttons on Linux; overlay ones take no room and
// fade when idle, as on macOS. Windows reads the feature before this code runs, so the renderer
// draws its scrollbars there (globals.css).
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar')
}

// Set before anything reads the data folder and before the single-instance lock, which Electron
// keys on it.
const userDataSwitch = app.commandLine.getSwitchValue('user-data-dir')
const devUserData = devUserDataPath({
  isPackaged: app.isPackaged,
  switchValue: userDataSwitch,
  appData: app.getPath('appData'),
  override: process.env['KETTU_USER_DATA'],
  cwd: process.cwd(),
})
if (devUserData) {
  app.setPath('userData', devUserData)
  log.info(`Development run: data in ${devUserData}`)
}
openAppLog(devUserData ?? (userDataSwitch.trim() ? app.getPath('userData') : null), isDebugRun())

// Before the app is ready, and only once.
protocol.registerSchemesAsPrivileged([artifactScheme, mediaScheme])
disableDnsPrefetching()

async function start(): Promise<void> {
  const userDataPath = app.getPath('userData')
  const themesDir = join(userDataPath, 'themes')
  const themeSourcesFile = join(userDataPath, 'theme-sources.json')
  const pluginThemesFile = join(userDataPath, PLUGIN_THEMES_FILE)
  // Read while Electron starts, so the first window already has the right theme and bounds.
  const loading = Promise.all([
    SettingsStore.load(userDataPath),
    WindowStateStore.load(userDataPath),
    AppStateStore.load(userDataPath),
    readThemeFolder(themesDir),
    readThemeSources(themeSourcesFile),
    readPluginThemes(pluginThemesFile),
  ])
  let ready = false
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    if (!ready) return
    // One Kettu per data folder, so debugging this one takes a restart, which the window asks.
    if (asksForDebug(data) && !isDebugRun()) sendCommand({ kind: 'confirm-debug-restart' })
    else showMainWindow()
  })

  await app.whenReady()
  watchProcesses()
  void markRunning().catch((error: unknown) => log.error('Could not mark the run', error))
  electronApp.setAppUserModelId(APP_USER_MODEL_ID)
  const wasOpenedAtLogin =
    process.platform === 'darwin' ? app.getLoginItemSettings().wasOpenedAtLogin : false
  initAppIcon(appWindows)
  // The session holding the computer, which the overlay draws and the Computer pane shows.
  let computerHold: ComputerHold | null = null
  // The window's page only: the menu bar panel's needs no clipboard.
  restrictPermissions(
    session.defaultSession,
    (url) => rendererPage(url) === 'index',
    (contents) => isRevoked(contents) || hasPendingFrame(contents),
    () => !!computerHold?.window,
  )
  const [settings, windowState, appState, themeFolder, themeSources, pluginThemes] = await loading
  syncLoginItem(settings.get().general.openAtLogin)
  const start = startMode(
    process.platform,
    isOpenedAtLogin(process.platform, process.argv, wasOpenedAtLogin),
    settings.get().general.background,
  )

  // The system's languages are read once; macOS and Windows ask for a restart to change them.
  const systemLocale = matchLocale(app.getPreferredSystemLanguages())
  const localeOf = (file: SettingsFile): Locale =>
    resolveLocale(file.general.language, systemLocale)
  setLocale(localeOf(settings.get()))
  applyAppIcon(settings.get().appearance.appIcon)
  applyTheme(settings.get().appearance.theme)
  applyZoom(settings.get().appearance.zoom)
  // The catalog's own session, so its requests follow the proxy setting and keep no cookies or
  // storage. Only its dialog reads it, so startup does not wait for the proxy.
  const themesSession = session.fromPartition('kettu-themes')
  let themesProxy = themesSession.setProxy(sessionProxy(settings.get().proxy))
  const catalog = new ThemeCatalog(async (url, init) => {
    await themesProxy
    return themesSession.fetch(url, init) as unknown as Promise<Response>
  })
  // Pull request authors' avatars, on a session of their own for the same reasons.
  const avatarsSession = session.fromPartition('kettu-avatars')
  let avatarsProxy = avatarsSession.setProxy(sessionProxy(settings.get().proxy))
  const avatars = new Avatars(async (url, init) => {
    await avatarsProxy
    return avatarsSession.fetch(url, init) as unknown as Promise<Response>
  })
  // Off, nothing of this computer reaches Kettu's services: the account, relay, push and sharing.
  const cloudOn = (): boolean => settings.get().cloud.enabled
  let accountBase = ACCOUNT_URL
  try {
    accountBase = accountBaseUrl(process.env)
  } catch (error) {
    log.error(`Signing in to ${ACCOUNT_URL} instead`, error)
  }
  // The Kettu account's requests and avatars, on a session of their own for the same reasons.
  const accountSession = session.fromPartition('kettu-account')
  let accountProxy = accountSession.setProxy(sessionProxy(settings.get().proxy))
  const accountFetch = guardKettuFetch(
    async (url, init) => {
      await accountProxy
      return accountSession.fetch(url, init) as unknown as Promise<Response>
    },
    cloudOn,
    [accountBase],
  )
  const accountAvatars = new Avatars(accountFetch, (url) =>
    accountAvatarRequestUrl(url, accountBase),
  )
  // Made once sharing and the updater are, before remote access starts and a device can ask.
  let hostAdmin: HostAdmin | null = null
  // The overlays follow the themes as the window does; they are made after them.
  const browserViewsRef: { current: BrowserViews | null } = { current: null }
  const computerOverlayRef: { current: ComputerOverlay | null } = { current: null }
  const themes = new ThemeStore(
    themeFolder,
    themeSources,
    pluginThemes,
    settings.get().appearance.colorTheme,
    {
      dir: themesDir,
      sourcesFile: themeSourcesFile,
      pluginFile: pluginThemesFile,
      catalog,
      select: (id) => settings.update({ appearance: { colorTheme: id } }),
      changed: (state, chosen) => {
        applyWindowTheme(chosen)
        broadcast('themes:changed', state)
        browserViewsRef.current?.lookChanged()
        computerOverlayRef.current?.settingsChanged()
        hostAdmin?.themesChanged(themes.hostThemes())
      },
    },
  )
  applyWindowTheme(themes.chosenTheme())
  watchTheme()
  configureWindows({ state: windowState, systemLocale })
  setBadgeEnabled(settings.get().notifications.badge)
  // From launch until quitting, whatever Run in the background says. The updater is made later.
  let checkForUpdates = (): void => {}
  const reducedMotion = (): boolean =>
    settings.get().appearance.reduceMotion === 'always' ||
    (process.platform !== 'linux' && systemPreferences.getAnimationSettings().prefersReducedMotion)
  // The panel's page reads its settings as it starts, so it opens only once main answers calls.
  let ipcReady = false
  let trayHostAgents: TrayHostAgentsFeed | null = null
  const trayPanel =
    process.platform === 'darwin'
      ? new TrayPanel({
          systemLocale,
          open: (target) => openTrayTarget(target),
          quit: () => app.quit(),
          onShown: () => trayHostAgents?.ensureLoaded(),
          onClosed: () => trayHostAgents?.deactivate(),
        })
      : null
  const tray = new KettuTray({
    open: () => showMainWindow(),
    quit: () => app.quit(),
    newSession: () => sendCommand({ kind: 'new-session' }),
    // As the app menu's item does: About shows the answer, the window being closed or not.
    checkForUpdates: () => {
      sendCommand({ kind: 'open-settings', section: 'about' })
      checkForUpdates()
    },
    openDebugMode: () => sendCommand({ kind: 'open-settings', section: 'advanced' }),
    setRemoteEnabled: (enabled) => void settings.update({ remote: { enabled } }),
    reducedMotion,
    ...(trayPanel
      ? {
          togglePanel: (bounds: Electron.Rectangle) => {
            if (!ipcReady) return false
            trayPanel.toggle(bounds)
            return true
          },
          hidePanel: () => trayPanel.hide(),
        }
      : {}),
  })
  tray.start()

  const mediaGrants = new MediaGrants()
  const browserOrigins = await BrowserOriginStore.load(userDataPath)
  // From the pages' own partition, with the cache they loaded the icon into. The file is read in
  // the background; the window asks for the icons and waits for it then.
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  const siteIcons = SiteIcons.open(userDataPath, {
    fetch: (url, init) => browserSession.fetch(url, init) as unknown as Promise<Response>,
    changed: (event) => broadcast('browser:site-icon', event),
  })
  const signIns = await startSignIns(userDataPath, browserSession.cookies, (sites) =>
    broadcast('sign-ins:changed', sites),
  )
  registerSignInIpc(signIns.signIns)
  // The browser tools need the host to answer them, and the pages need the window, so each takes
  // the other's work through this one late binding.
  let browserTools: BrowserTools | null = null
  // The host shows a new origin in the session's thread; it is made after the pages.
  const hostRef: { current: AgentHost | null } = { current: null }
  const hostSessionsRef: { current: HostSessions | null } = { current: null }
  let remoteBrowserRef: RemoteBrowser | null = null
  const browserTabsReporter = new BrowserTabsReporter({
    hostOf: (sessionId) =>
      remoteBrowserRef?.hostOf(sessionId) ??
      hostSessionsRef.current?.hostOfSession(sessionId) ??
      null,
    reportLocal: (sessionId, tabs) => hostRef.current?.browserTabs(sessionId, tabs),
    syncLocal: (sessions) => hostRef.current?.syncBrowserTabs(sessions),
    reportRemote: (hostId, sessionId, tabs) =>
      hostSessionsRef.current?.request(hostId, 'browser.reportTabs', { sessionId, tabs }) ?? false,
  })
  const browserViews = new BrowserViews({
    window: currentWindow,
    send: (state) => {
      broadcast('browser:state', state)
      browserTabsReporter.update(state.sessionId, sessionBrowserTabsOf(state))
    },
    dialogOpened: (tabId, type, accepted) => browserTools?.dialogOpened(tabId, type, accepted),
    control: (sessionId) => browserTools?.control(sessionId) ?? IDLE_CONTROL,
    isInjecting: (tabId) => browserTools?.isInjecting(tabId) ?? false,
    overlayRequest: (sessionId, request) => {
      if (request.type === 'take-over') browserTools?.takeOver(sessionId)
      else if (request.type === 'hand-back') browserTools?.handBack(sessionId)
      else if (request.type === 'answer') browserTools?.answerAsk(sessionId, request.outcome)
    },
    settings: () => settings.get(),
    themes: () => themes.state(),
    systemLocale,
    created: (tabId, contents) => browserTools?.watch(tabId, contents),
    closed: (tabId) => browserTools?.forgetTab(tabId),
    ended: (sessionId) => {
      browserTools?.forget(sessionId)
      remoteBrowser.pageClosed(sessionId)
      browserTabsReporter.clear(sessionId)
    },
    agentTabClosed: (sessionId) => browserTools?.agentTabClosed(sessionId),
    panelClosed: (sessionId) => {
      browserTools?.releaseTakeover(sessionId)
    },
    failed: (sessionId, kind, message) => browserTools?.pageFailed(sessionId, kind, message),
    origins: browserOrigins,
    originAsked: (request) => {
      if (!remoteBrowser.originAsked(request)) hostRef.current?.originAsked(request)
    },
    originAnswered: (request) => {
      if (!remoteBrowser.originAnswered(request)) hostRef.current?.originAnswered(request)
    },
    removed: (sessionId) => {
      remoteBrowser.pageRemoved(sessionId)
      browserTabsReporter.clear(sessionId)
    },
    siteOpened: (pageUrl, favicons) => {
      if (favicons) void siteIcons.favicons(pageUrl, favicons)
      else siteIcons.visited(pageUrl)
    },
    annotated: (event) => broadcast('browser:annotated', event),
  })
  browserViewsRef.current = browserViews
  browserTools = new BrowserTools({
    views: browserViews,
    controlChanged: (sessionId) => browserViews.controlChanged(sessionId),
    acted: (sessionId, at, click) => browserViews.acted(sessionId, at, click),
    handedBack: (sessionId, ms) => {
      if (!remoteBrowser.handedBack(sessionId, ms))
        hostRef.current?.browserHandedBack(sessionId, ms)
    },
    opened: (sessionId) => broadcast('browser:opened', { sessionId }),
    log: (level, message) => log[level](`browser: ${message}`),
    waiting: (callId, waiting) => hostRef.current?.browserWaiting(callId, waiting),
  })
  // Local artifacts service port; browser forwards never bind directly onto it.
  let localServicePort: number | null = null
  // Other hosts' agents drive the pages of the turns this computer sends them.
  const remoteBrowser = new RemoteBrowser({
    run: (callId, sessionId, tool, args, projectPath, waiting, allowTab) =>
      browserTools!.call(callId, sessionId, tool, args, projectPath, waiting, allowTab),
    forward: (hostId, sessionId, forward) =>
      remoteHost.forward(
        hostId,
        sessionId,
        forward,
        localServicePort === null ? undefined : [localServicePort],
      ),
    closeForwards: (hostId, sessionId) => remoteHost.closeForwards(hostId, sessionId),
    answerOrigin: (sessionId, requestId, decision) =>
      browserViews.answerOrigin(sessionId, requestId, decision),
    request: (hostId, method, params) => hostSessions.request(hostId, method, params),
    turnEnded: (sessionId) => browserTools!.turnEnded(sessionId),
    askAnswered: (sessionId, outcome) => browserTools!.answerAsk(sessionId, outcome),
    log: (level, message) => log[level](`browser: ${message}`),
  })
  remoteBrowserRef = remoteBrowser
  const routinesAwake = new RoutinesAwake()
  const terminalHost = new TerminalHost({
    settings: () => terminalSettings(settings.get()),
    onReady: () => broadcast('terminals:ready', null),
    onHandedBack: (sessionId, ms) => hostRef.current?.terminalHandedBack(sessionId, ms),
  })
  const deviceHost = new DeviceHost({
    allowDevices: () => true,
    onHandedBack: (sessionId, ms) => hostRef.current?.deviceHandedBack(sessionId, ms),
  })
  const pluginHost = new PluginHost({
    handPort: (port) => hostRef.current?.pluginPort(port) ?? false,
  })
  // Set once the sharing service exists; the host reports ready only after that, at each start.
  let reconcileSharing: (() => void) | null = null
  let sharingArtifactsChanged: (() => void) | null = null
  const identityCipher: IdentityCipher = {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    decrypt: (encrypted) => safeStorage.decryptStringAsync(encrypted),
    plainText: () =>
      process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text',
  }
  const marketKeys = await MarketKeys.load({
    file: marketKeysFile(userDataPath),
    cipher: identityCipher,
    plainTextAllowed: false,
    servers: () => settings.get().marketplace.mcp,
    changed: (contents) => hostRef.current?.pushMarketKeys(contents),
    log: createLogger('market-keys'),
  })
  const computerOverlay = new ComputerOverlay({
    control: (sessionId, action) => agentHost.computerControl(sessionId, action),
    frame: () => agentHost.computerFrame(),
    appIcon: (path) => computerAppIcon(path),
    settings: () => settings.get(),
    themes: () => themes.state(),
    systemLocale,
  })
  computerOverlayRef.current = computerOverlay
  serveComputerCapture(
    session.defaultSession,
    () => computerHold,
    (url) => rendererPage(url) === 'index',
  )
  // Made with the updater, further down; the island reads it only once it runs.
  let updaterMade: Updater | null = null
  const islandLog = createLogger('island')
  // Every host signed in to an account says its plan limit notices; this computer says each once.
  const repeatedNotices = new RepeatedNotices()
  const colorMode = (): 'light' | 'dark' => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  // The notch island: macOS only, started once the first window shows.
  const island = new IslandBridge({
    enabled: () => process.platform === 'darwin' && settings.get().notifications.island,
    allowed: (kind) =>
      kind === 'update'
        ? settings.get().notifications.updates
        : settings.get().notifications[ATTENTION_SETTING[kind]],
    windowFocused: () => BrowserWindow.getFocusedWindow() !== null,
    colorMode,
    version: app.getVersion(),
    locale: () => currentLocale(),
    strings: () => islandHelperStrings(),
    spawn: () => spawnIslandHelper(),
    connectLocal: (onEvent, onClose) => {
      const port = agentHost.connectMain()
      if (!port) return null
      const client = new IslandHostPort(port, onEvent, onClose)
      return {
        request: (method, params) => client.request(method, params),
        close: () => client.close(),
      }
    },
    // Another host's session is read and answered through the relay the windows use.
    callRemote: (hostId, method, params) => hostSessions.call(hostId, method, params),
    openRemotes: () => hostSessions.openHosts(),
    open: (target) => {
      if (target?.kind === 'task') {
        sendCommand({ kind: 'open-task', taskId: target.taskId })
        return
      }
      openTrayTarget(
        target === null
          ? { kind: 'app' }
          : target.kind === 'new-session'
            ? { kind: 'new-session' }
            : { kind: 'session', sessionId: target.sessionId },
      )
    },
    updateStatus: () => updaterMade?.getStatus() ?? null,
    noticeAction: (action) => {
      if (action !== 'restart') {
        sendCommand({ kind: action === 'usage' ? 'open-usage' : 'open-updates' })
        return
      }
      try {
        updaterMade?.restart()
      } catch (error) {
        islandLog.warn(`Could not restart to update: ${String(error)}`)
      }
    },
    status: (state) => broadcast('island:changed', state),
    log: islandLog,
  })
  nativeTheme.on('updated', () => island.appearanceChanged())
  nativeTheme.on('updated', () => agentHost.pushColorMode(colorMode()))
  app.on('will-quit', () => island.quit())
  let botRemoteHandler: (call: BotRemoteCall) => Promise<BotRemoteAnswer> = async () => ({
    ok: false,
    code: 'offline',
    message: 'Remote host sessions are still starting.',
  })
  const agentHost = new AgentHost({
    settings: () => hostSettings(settings.get(), systemLocale),
    colorMode,
    marketKeys: () => marketKeys.contentsForHost(),
    onBattery: () => (process.platform === 'win32' ? powerMonitor.isOnBatteryPower() : null),
    browserTabs: () => browserTabsReporter.takeLocalSnapshot(),
    onMarketOAuth: (serverId, state) => void marketKeys.setOAuth(serverId, state),
    installMcp: (entries) => installDiscoveredMcp(settings, marketKeys, entries),
    mcpBackupKey: () =>
      marketKeys.ensureBackupKey().then(
        () => null,
        (error: unknown) => (error as Error).message,
      ),
    pluginSecret: (pluginId, key, value) =>
      marketKeys.setPluginSecret(pluginId, key, value).then(
        () => null,
        (error: unknown) => (error as Error).message,
      ),
    onFirstStart: (harnesses) => settings.firstStart(harnesses),
    onPluginThemes: () =>
      void themes.refresh().catch((error: unknown) => {
        log.error('Could not read the themes plugins bring', error)
      }),
    onAttention: (message) => {
      // While the island runs, it shows what needs the user in place of a notification.
      if (!repeatedNotices.repeated(message)) {
        island.attention(message)
        if (!island.shows(message)) {
          notifyAttention(message, settings.get(), (sessionId, requestId, optionId) => {
            agentHost.answerPermission(sessionId, requestId, optionId)
            return true
          })
        }
      }
      hostAdmin?.attention(message)
      remoteHost.attention(message)
    },
    onWaiting: (sessions) => remoteHost.setWaiting(sessions),
    onLiveActivity: (activity) => remoteHost.setLiveActivity(activity),
    onSeen: (sessionId) => remoteHost.seen(sessionId),
    onBadge: (count) => setBadgeCount(count),
    onBusy: (counts) => tray.setBusy(counts),
    onProjects: (paths) => terminalHost.setProjects(paths),
    onArtifactsChanged: () => sharingArtifactsChanged?.(),
    onSessionsEnded: (sessionIds) => {
      terminalHost.endSessions(sessionIds)
      deviceHost.endSessions(sessionIds)
    },
    onAuthCommands: (commands) => terminalHost.setAuthCommands(commands),
    onMediaGrant: (grant) => mediaGrants.add(grant),
    onMediaRevoke: (sessionId) => mediaGrants.revoke(sessionId),
    onRoutinesWorking: (working) => routinesAwake.set(working),
    onReady: () => {
      tray.setConnected(true)
      reconcileSharing?.()
      island.localHostReady()
    },
    onDown: () => {
      tray.setConnected(false)
      island.localHostDown()
      // No turn of this computer's host runs now; another host's turns go on with their pages.
      browserTools?.endTurns(
        browserTools.controls.keys().filter((sessionId) => !remoteBrowser.isRemote(sessionId)),
      )
      deviceHost.turnEnded(null)
      terminalHost.turnEnded(null)
    },
    onDeviceTurnEnded: (sessionId) => deviceHost.turnEnded(sessionId),
    onTerminalTurnEnded: (sessionId) => terminalHost.turnEnded(sessionId),
    terminal: (call) => terminalHost.call(call),
    botRemote: (call) => botRemoteHandler(call),
    onBrowserTurnEnded: (sessionId) => {
      if (!remoteBrowser.isRemote(sessionId)) browserTools?.turnEnded(sessionId)
    },
    onBrowserAskAnswer: (sessionId, outcome) => {
      if (!remoteBrowser.isRemote(sessionId)) browserTools?.answerAsk(sessionId, outcome)
    },
    onServicePort: (port) => {
      localServicePort = port
      browserViews.setServicePort(port)
    },
    onOriginDecided: (sessionId, requestId, decision) =>
      browserViews.answerOrigin(sessionId, requestId, decision),
    onComputerAppAllowed: (app) => settings.allowComputerApp(app),
    onComputerHold: (hold) => {
      computerHold = hold
      computerOverlay.setHold(hold)
    },
    browser: (request) =>
      remoteBrowser.claimLocal(request.sessionId)
        ? browserTools!.call(
            request.callId,
            request.sessionId,
            request.tool,
            request.args,
            request.projectPath,
            undefined,
            request.allowTab,
          )
        : Promise.resolve({
            error: { code: 'no_page', message: t('browserRemote.otherHost') },
          }),
    settingsCall: (call) =>
      answerSettingsCall(call, {
        settings,
        desktop: true,
        facts: () => settingsFacts(),
        changed: (patch) => actionLog.info('settings.update', { patch, by: 'agent' }),
      }),
    marketAccount: () => marketAccount(),
    accountId: () => activeAccountId(),
    market: (call) =>
      runMarketCall(call, {
        base: accountBase,
        fetch: accountFetch,
        withToken: (run) =>
          account.withAccessToken(run, (error) => error instanceof MarketUnauthorized),
        signedOut: (error) => error instanceof NotSignedIn,
      }),
    pluginHost: (run) => pluginHost.setWanted(run),
    device: (call) =>
      deviceHost.call(call).then((answer) => {
        const opened =
          'result' in answer ? (answer.result.value as { device?: { id?: string } })?.device : null
        if (call.kind === 'open' && opened?.id) {
          broadcast('devices:opened', { sessionId: call.sessionId, deviceId: opened.id })
        }
        return answer
      }),
  })
  hostRef.current = agentHost
  const hostName = (): string => settings.get().remote.name ?? hostname()
  // Set once the sharing and artifacts services exist, which follow the signed-in account.
  let sharingKettuChanged: (() => void) | null = null
  let artifactsAccountChanged: (() => void) | null = null
  let relayUrl = RELAY_URL
  try {
    relayUrl = relayUrlFrom(process.env[RELAY_URL_ENV])
  } catch (error) {
    log.error(`Using the relay at ${RELAY_URL} instead`, error)
  }
  let pushUrl = PUSH_URL
  try {
    pushUrl = pushUrlFrom(process.env[PUSH_URL_ENV])
  } catch (error) {
    log.error(`Using the push gateway at ${PUSH_URL} instead`, error)
  }
  const account = await Account.load({
    file: accountFile(userDataPath),
    api: new AccountApi(accountBase, accountFetch),
    cipher: identityCipher,
    clientInfo: async () =>
      clientInfo({
        kind: 'desktop',
        name: hostName(),
        os: await systemReleaseForRun(),
        arch: process.arch,
        version: app.getVersion(),
      }),
    locale: currentLocale,
    openBrowser: (url) => shell.openExternal(url),
    bringToFront: () => {
      showMainWindow()
      // A window's focus alone leaves the app behind the browser on macOS.
      if (process.platform === 'darwin') app.focus({ steal: true })
    },
    avatar: (url) => accountAvatars.load(url),
    failureText: () => t('account.browserFailed'),
    cloud: cloudOn,
    changed: (status) => {
      agentHost.pushAccount(activeAccountId())
      artifactsAccountChanged?.()
      broadcast('account:changed', status)
      sharingKettuChanged?.()
      accountChanged()
      agentHost.pushMarketAccount(marketAccount())
    },
    log: createLogger('account'),
  })
  const signedIn = (): boolean => account.status().state === 'signed-in'
  /** The active Kettu account id scoping artifact ownership and isolation, or null. */
  function activeAccountId(): string | null {
    return cloudOn() ? (account.signedIn()?.id ?? null) : null
  }
  /** The account the Marketplace tools publish with: a sign-in with Kettu's services on. */
  function marketAccount(): MarketAccount | null {
    const status = account.status()
    return cloudOn() && status.state === 'signed-in'
      ? { name: status.account.name, email: status.account.email }
      : null
  }
  // What the relay, push and the account's hosts go by: a sign-in with Kettu's services on.
  const accountInUse = (): boolean => cloudOn() && signedIn()
  // The own relay's access key, kept like the host's private key; one that cannot be read is
  // given again on the page.
  let ownRelayKey = await loadAccessKey(userDataPath, identityCipher).catch((error: unknown) => {
    log.error('The own relay access key cannot be read', error)
    return null
  })
  const mainRelay = new RelayFeatures(() => readRelayFeatures(relayUrl))
  const relayToken = new RelayToken({
    current: () => account.currentToken(),
    exchange: async () =>
      (await mainRelay.has(RELAY_TOKENS_FEATURE)) ? account.relayToken() : null,
    signedIn: accountInUse,
    needed: () =>
      settings.get().remote.enabled ||
      remoteHost.pairingHosts ||
      (remoteHost.hosts?.length ?? 0) > 0,
    send: (token, relay) => remoteHost.setToken(token, relay),
  })
  // Asks once per other client of the account whether to let it use this computer.
  const remoteOffers = new RemoteOffers({
    eligible: () =>
      accountInUse() && !settings.get().remote.enabled && remoteHost.devices.length === 0,
    clients: () => account.clients(),
    asked: () => appState.get().askedClients,
    keepAsked: (ids) => appState.update({ askedClients: ids }),
    changed: (offer) => broadcast('remote:offer', offer),
  })
  /** The sign-in changed: the relay's token, and the direct connections it holds on without one. */
  function accountChanged(): void {
    relayToken.update()
    remoteHost.accountChanged()
    remoteHost.directChanged()
    remoteChanged()
    void remoteOffers.check()
  }
  const remoteStatus = (): RemoteStatus => {
    const status = remoteHost.status
    return {
      state: remoteHost.state,
      hostName: hostName(),
      systemName: hostname(),
      devices: remoteHost.devices,
      online: status?.online ?? [],
      plainTextKey: status?.plainTextKey ?? false,
      direct: status?.direct ?? { state: 'off' },
      relay: relayReport({
        official: settings.get().remote.relay,
        ownEnabled: settings.get().remote.ownRelayEnabled,
        cloud: cloudOn(),
        signedIn: signedIn(),
        relays: status?.relays ?? [],
        ...(status?.availableRelays ? { available: status.availableRelays } : {}),
        own: settings.get().remote.ownRelay,
        ownStatus: status?.ownRelay ?? null,
        keyEnd: accessKeyEnd(ownRelayKey),
      }),
      ownRelayKeyEnd: accessKeyEnd(ownRelayKey),
      account: remoteHost.account,
    }
  }
  const remoteChanged = (): void => {
    const status = remoteStatus()
    broadcast('remote:changed', status)
    tray.setRemote(status)
    hostAdmin?.remoteChanged(status)
    remoteOffers.refresh()
  }
  let computerModel = ''
  const hostsStatus = (): HostsStatus => ({
    self: {
      name: hostName(),
      platform: process.platform,
      version: app.getVersion(),
      model: computerModel,
    },
    hosts: remoteHost.hosts,
    plainTextKey: remoteHost.plainTextDeviceKey,
    keyFailed: remoteHost.deviceKeyFailed,
    otherAccount: remoteHost.otherAccountHosts,
    ...(remoteHost.relayNodes ? { relayNodes: remoteHost.relayNodes } : {}),
  })
  // What an agent's settings tools read beyond the file: counts, and the account as Settings shows
  // it. A secret goes only as whether it is set.
  const settingsFacts = (): SettingFacts => {
    const facts: SettingFacts = {}
    const status = account.status()
    if (status.state === 'signed-in') {
      facts['account.account'] = status.account.email
      facts['account.plan'] = status.plan?.name ?? null
      facts['account.subscription'] = status.subscription
      facts['account.points'] = status.points
      if (status.plan && status.usage) {
        facts['account.devices'] = `${status.usage.devices} / ${status.plan.maxDevices}`
      }
    } else {
      facts['account.account'] = null
    }
    facts['hosts.hosts'] = remoteHost.hosts?.length ?? null
    facts['hosts.this-computer'] = hostName()
    facts['remote.devices'] = remoteHost.devices.length
    const shared = sharing.status()
    facts['sharing.kettu'] = shared.kettu.account?.email ?? null
    facts['sharing.auto'] = shared.auto.enabled
    facts['sharing.published'] = shared.published.length
    facts['sharing.cloudflare'] = shared.cloudflare !== null
    const shown = themes.state()
    const chosen = shown.installed.find((theme) => theme.id === shown.chosen)
    facts['appearance.theme'] = chosen?.theme.name ?? 'Kettu'
    const update = updater.getStatus()
    facts['about.update'] =
      update.state.kind === 'available' || update.state.kind === 'ready'
        ? `${update.current} → ${update.state.version}`
        : update.current
    facts['advanced.data-folder'] = app.getPath('userData')
    return facts
  }
  const hostMedia = new HostMedia((hostId, params) =>
    hostSessions.call(hostId, 'media.read', params),
  )
  const hostSessions: HostSessions = new HostSessions({
    browserCall: (hostId, call) => void remoteBrowser.call(hostId, call),
    originDecided: (hostId, event) => remoteBrowser.originDecided(hostId, event),
    browserEvent: (hostId, event) => remoteBrowser.browserEvent(hostId, event),
    attention: (hostId, attention) => {
      const host = remoteHost.hosts?.find((known) => known.id === hostId)
      if (!host || typeof attention !== 'object' || attention === null) return
      if (repeatedNotices.repeated(attention as HostAttention)) return
      // While the island runs, it shows another host's too in place of a notification.
      island.remoteAttention(hostId, attention)
      if (island.shows(attention as HostAttention)) return
      notifyAttention(
        attention as HostAttention,
        settings.get(),
        (sessionId, requestId, optionId) =>
          hostSessions.request(hostId, 'permissions.respond', { sessionId, requestId, optionId }),
        { id: hostId, name: host.name },
      )
    },
    ended: (hostId) => {
      // The host's turns that used this computer's pages end with its session.
      browserTools?.endTurns(remoteBrowser.sessionsOf(hostId))
      remoteBrowser.hostClosed(hostId)
      browserTabsReporter.hostClosed(hostId)
      remoteArtifacts.ended(hostId)
      island.remoteClosed(hostId)
      trayHostAgents?.ended(hostId)
      agentHost.pushBotRemoteEvent({ kind: 'host_offline', hostId })
    },
    opened: (hostId) => {
      browserTabsReporter.hostOpened(hostId)
      island.remoteOpened(hostId)
      trayHostAgents?.opened(hostId)
      const known = remoteHost.hosts?.find((h) => h.id === hostId)
      agentHost.pushBotRemoteEvent({
        kind: 'host_online',
        hostId,
        hostName: known?.name ?? hostId,
      })
    },
    event: (hostId, event) => {
      island.remoteEvent(hostId, event)
      trayHostAgents?.event(hostId, event)
      const typed = event as HostEvent
      if (typed?.type === 'session.summary') {
        const s = typed.summary
        agentHost.pushBotRemoteEvent({
          kind: 'session_update',
          hostId,
          sessionId: s.id,
          status: s.status,
          permissionCount: s.permissionCount,
          title: s.title,
          branch: s.branch,
          archivedAt: s.archivedAt,
        })
      }
    },
    resync: (hostId) => {
      island.remoteResync(hostId)
      trayHostAgents?.resync(hostId)
    },
    artifactEvent: (hostId, event) => {
      if (event.type === 'artifacts.runtime') remoteArtifacts.streamed(hostId, event)
      else if (event.type === 'artifacts.changed' || event.type === 'artifacts.version') {
        remoteArtifacts.changed()
      }
    },
    media: hostMedia,
  })
  hostSessionsRef.current = hostSessions
  if (trayPanel) {
    trayHostAgents = new TrayHostAgentsFeed({
      openHosts: () => hostSessions.openHosts(),
      listAgents: (hostId) => hostSessions.call(hostId, 'agents.list', undefined),
      changed: (hosts) => trayPanel.sendHostAgents(hosts),
      warn: (message) => log.warn(message),
    })
  }
  botRemoteHandler = async (call: BotRemoteCall): Promise<BotRemoteAnswer> => {
    if (call.kind === 'account_context') {
      const token = accountInUse() ? await account.currentToken().catch(() => null) : null
      return {
        ok: true,
        data: {
          hostId: hostName() || hostname(),
          accessToken: token,
        },
      }
    }
    const open = new Set(hostSessions.openHosts())
    if (call.kind === 'list_targets') {
      const known = (remoteHost.hosts ?? []).filter((h) => !h.removed)
      const targets: BotHostTarget[] = await Promise.all(
        known.map(async (h) => {
          const online = open.has(h.id)
          if (!online) {
            return {
              hostId: h.id,
              name: h.name,
              platform: h.platform,
              online: false,
              self: false,
              projects: [],
              agents: [],
              load: null,
            }
          }
          const [projRes, agentRes, sessRes] = await Promise.allSettled([
            hostSessions.call(h.id, 'projects.list', undefined) as Promise<Project[]>,
            hostSessions.call(h.id, 'agents.list', undefined) as Promise<AgentStatus[]>,
            hostSessions.call(h.id, 'sessions.list', {}) as Promise<SessionSummary[]>,
          ])
          const projects =
            projRes.status === 'fulfilled' && Array.isArray(projRes.value)
              ? projRes.value.filter((p) => !p.missing).map((p) => ({ path: p.path, name: p.name }))
              : []
          const agents =
            agentRes.status === 'fulfilled' && Array.isArray(agentRes.value)
              ? agentRes.value
                  .filter((a) => !a.disabled && !a.uninstalled)
                  .map((a) => ({
                    id: a.id,
                    name: a.name,
                    ready: a.state === 'ready' || a.state === 'available',
                    mcp: a.kettuServer?.runs !== false && a.capabilities?.mcpHttp !== false,
                  }))
              : []
          const workingSessions =
            sessRes.status === 'fulfilled' && Array.isArray(sessRes.value)
              ? sessRes.value.filter(
                  (s) => s.status === 'running' || s.status === 'awaiting_permission',
                ).length
              : 0
          return {
            hostId: h.id,
            name: h.name,
            platform: h.platform,
            online: true,
            self: false,
            projects,
            agents,
            load: { cpuPct: null, memPct: null, workingSessions },
          }
        }),
      )
      return { ok: true, data: targets }
    }
    if (!open.has(call.hostId)) {
      return { ok: false, code: 'offline', message: `Host ${call.hostId} is offline.` }
    }
    try {
      if (call.kind === 'dispatch_session') {
        const created = (await hostSessions.call(call.hostId, 'sessions.create', {
          agentId: call.agentId,
          projectPath: call.projectPath,
          prompt: [{ type: 'text', text: call.prompt }],
          title: call.title,
          ...(call.model ? { options: { model: call.model } } : {}),
          ...(call.worktree ? { worktree: { base: 'HEAD' } } : {}),
        })) as SessionSummary
        return { ok: true, data: { sessionId: created.id, branch: created.branch } }
      }
      if (call.kind === 'send_session') {
        await hostSessions.call(call.hostId, 'sessions.queue', {
          sessionId: call.sessionId,
          content: [{ type: 'text', text: call.text }],
        })
        return { ok: true, data: null }
      }
      if (call.kind === 'archive_session') {
        await hostSessions.call(call.hostId, 'sessions.archive', {
          sessionId: call.sessionId,
          subSessions: true,
        })
        return { ok: true, data: null }
      }
      if (call.kind === 'read_session_reply') {
        const snap = (await hostSessions.call(call.hostId, 'sessions.snapshot', {
          sessionId: call.sessionId,
        })) as SessionSnapshot
        const lastAgent = [...(snap.entries ?? [])]
          .reverse()
          .find((entry) => entry.kind === 'agent' && entry.markdown.trim().length > 0)
        return {
          ok: true,
          data: lastAgent && lastAgent.kind === 'agent' ? lastAgent.markdown : null,
        }
      }
      return { ok: false, code: 'failed', message: 'Unknown remote Bot call' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const offline = /offline|closed|disconnect|unavailable|not open/i.test(message)
      return { ok: false, code: offline ? 'offline' : 'failed', message }
    }
  }
  const remoteArtifactsDir = join(userDataPath, 'artifacts', 'remote')
  const remoteArtifacts = new RemoteArtifacts({
    call: (hostId, method, params) => hostSessions.call(hostId, method, params),
    dir: remoteArtifactsDir,
  })
  await remoteArtifacts.prune().catch((error: unknown) => {
    log.warn(`Could not prune the files kept from other hosts: ${String(error)}`)
  })
  /** An artifact a window names, on this computer or on another host. */
  const artifactOn = (ref: string): { hostId: string | null; id: string } => {
    const parsed = parseArtifactRef(ref)
    if (!parsed) throw new Error('Not an artifact id')
    return parsed
  }
  /** An id a paired device names, which is this computer's alone: never another host's. */
  const ownArtifact = (id: unknown): unknown => {
    if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) throw new Error('Not an artifact id')
    return id
  }
  const hostsChanged = (): void => {
    hostSessions.connections(remoteHost.hosts)
    island.remoteHosts(
      (remoteHost.hosts ?? [])
        .filter((host) => !host.removed)
        .map((host) => ({ id: host.id, name: host.name })),
    )
    if (remoteHost.hosts !== null) {
      trayHostAgents?.syncHosts(
        remoteHost.hosts.filter((host) => !host.removed).map((host) => host.id),
      )
    }
    broadcast('hosts:changed', hostsStatus())
    relayToken.update()
  }
  const readComputerModel = async (): Promise<string> => {
    const model = await computerModelForRun()
    if (model !== computerModel) {
      computerModel = model
      hostsChanged()
    }
    return model
  }
  const remoteLog = createLogger('remote-devices')
  const remoteHost: RemoteHost = new RemoteHost({
    userDataPath,
    appVersion: app.getVersion(),
    identity: () => loadIdentity(userDataPath, identityCipher),
    newIdentity: () => newIdentity(userDataPath, identityCipher),
    relayKey: () => loadRelayKey(userDataPath, identityCipher),
    newRelayKey: () => newRelayKey(userDataPath, identityCipher),
    relayUrl,
    pushUrl,
    relay: () => ({
      ...relayChoiceInit(settings.get().remote, cloudOn(), ownRelayKey),
      regions: settings.get().remote.relayRegions,
    }),
    relayPreference: () => settings.get().remote.relayPreference,
    useOwnRelay: (input) =>
      useOwnRelay(input, {
        key: () => ownRelayKey,
        saveKey: async (key) => {
          await saveAccessKey(userDataPath, identityCipher, key)
          ownRelayKey = key
        },
        current: () => settings.get().remote.ownRelay,
        apply: (own) => settings.useOwnRelay(own),
        changed: () => {
          remoteHost.relayChanged()
          remoteChanged()
        },
        check: checkRelayHere,
      }),
    discoverable: () => settings.get().remote.discoverable,
    account: () => {
      const status = account.status()
      return accountInUse() && status.state === 'signed-in' ? status.account.id : null
    },
    discoveryChanged: (event) => {
      broadcast('remote:discovery', event)
      hostAdmin?.discoveryChanged(event)
      notifyDiscovery(event, settings.get(), () => void showMainWindow())
    },
    deviceJoined: (device, via) => {
      hostAdmin?.deviceJoined(device, via)
      notifyJoined(device, hostName(), settings.get(), () => {
        void showMainWindow()
        sendCommand({ kind: 'remove-device', deviceId: device.id })
      })
    },
    relayTokenReady: () => relayToken.ready(),
    deviceKey: () => loadDeviceKey(userDataPath, identityCipher),
    devicePlatform: devicePlatformForRun,
    hostsKnown: async () => {
      const read = await readJsonFile(join(userDataPath, ...HOSTS_FILE))
      const hosts = read.kind === 'ok' ? (read.value as { hosts?: unknown } | null)?.hosts : null
      return Array.isArray(hosts) && hosts.length > 0
    },
    hostName,
    devices: () => loadStoredDevices(userDataPath, (level, message) => remoteLog[level](message)),
    direct: () => effectiveDirect(settings.get(), accountInUse()),
    terminal: () => settings.get().remote.terminal,
    openPort: (device) => agentHost.connectDevice(device),
    openTerminalPort: (device) => terminalHost.connectDevice(device),
    openDevicePort: (device) => deviceHost.connectDevice(device),
    admin: async (deviceId, method, params) =>
      hostAdmin
        ? hostAdmin.answer(deviceId, method, params)
        : { error: { code: 'unavailable', message: t('hostAdmin.starting') } },
    changed: remoteChanged,
    hostsChanged,
    hostOpened: (hostId, port) => hostSessions.opened(hostId, port),
    hostClosed: (hostId, port) => hostSessions.closed(hostId, port),
  })
  const artifacts = new Artifacts({
    content: (ref, version) => {
      const { hostId, id } = artifactOn(ref)
      return hostId === null
        ? agentHost.artifactContent(id, version)
        : remoteArtifacts.content(hostId, id, version)
    },
    ready: (ref, version, paths) => {
      const { hostId, id } = artifactOn(ref)
      return hostId === null ? Promise.resolve() : remoteArtifacts.fetch(hostId, id, version, paths)
    },
    contentDir: join(userDataPath, 'artifacts', 'content'),
    remoteDir: remoteArtifactsDir,
    thumbnailDir: join(userDataPath, 'artifacts', 'thumbnails'),
    importFile: (path, project) => agentHost.artifactImport(path, project),
    runtime: (ref, message, answer) => {
      const { hostId, id } = artifactOn(ref)
      return hostId === null
        ? agentHost.artifactRuntime(id, message, answer)
        : remoteArtifacts.runtime(hostId, id, message, answer)
    },
    viewersDir: join(__dirname, '../viewers'),
    exportVersion: (ref, version, format) => {
      const { hostId, id } = artifactOn(ref)
      return hostId === null
        ? agentHost.artifactExport(id, version, format)
        : remoteArtifacts.exportVersion(hostId, id, version, format)
    },
  })
  await artifacts.install(session.defaultSession)
  artifactsAccountChanged = () => artifacts.accountChanged()
  // The window's page only: the menu bar panel's shows no media.
  serveMedia(session.defaultSession, mediaGrants, (url) => rendererPage(url) === 'index', hostMedia)
  // A session of its own, so publishing follows the proxy setting rather than the artifacts'
  // window proxy, and keeps no cookies or storage of its own.
  const sharingSession = session.fromPartition('kettu-sharing')
  await sharingSession.setProxy(sessionProxy(settings.get().proxy))
  const sharing = await Sharing.load({
    userDataPath,
    contentDir: join(userDataPath, 'artifacts', 'content'),
    host: {
      content: (id, version) => agentHost.artifactContent(id, version),
      artifacts: () => agentHost.artifacts(),
      claimOwner: (id, accountId) => agentHost.claimArtifactOwner(id, accountId),
    },
    kettu: {
      base: accountBase,
      account: () => (cloudOn() ? account.signedIn() : null),
      withToken: (call) =>
        account.withAccessToken(call, (error) => error instanceof KettuUnauthorized),
    },
    viewerFiles: (type, languages) => artifacts.viewers.forPage(type, languages),
    locale: currentLocale,
    cipher: {
      encrypt: async (text) => (await safeStorage.encryptStringAsync(text)).toString('base64'),
      decrypt: async (encoded) =>
        (await safeStorage.decryptStringAsync(Buffer.from(encoded, 'base64'))).result,
    },
    encryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    plainText: () =>
      process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text',
    // Kettu's hosts alone: the same session publishes to the user's own Cloudflare account.
    fetch: guardKettuFetch(
      (url, init) => sharingSession.fetch(url, init) as unknown as Promise<Response>,
      cloudOn,
      [accountBase],
    ),
    changed: (status) => {
      broadcast('sharing:changed', status)
      hostAdmin?.sharingChanged(status)
    },
  })
  reconcileSharing = () => void sharing.reconcile()
  sharingKettuChanged = () => sharing.kettuChanged()
  sharingArtifactsChanged = () => sharing.artifactsChanged()
  let quit: QuitFlow | null = null
  const updater = new Updater({
    appState,
    settings: () => settings.get(),
    requestRestart: (confirmed, resumeAfterUpdate = true, options) =>
      quit?.request('update', confirmed, resumeAfterUpdate, options) ?? false,
    clearUpdateResume: () => clearUpdateResume(userDataPath),
    waitableSessions: async () => (await agentHost.busy(2000)).filter(restartWaitsFor).length,
    busyTerminals: async () => (await terminalHost.busy(2000)).length,
    requestMove: (options) => quit?.request('move', false, false, options),
    respondUpdateConfirmation: (requestId, action, by) =>
      quit?.respondUpdate(requestId, action, by) ?? false,
    cancelPendingUpdateConfirmation: (requestId, code) =>
      quit?.cancelPendingUpdate(requestId, code) ?? false,
    flushRemoteEvents: () => remoteHost.flushEvents(1500),
    changed: (status) => {
      hostAdmin?.updatesChanged(status)
      island.updatesChanged()
      announceUpdate(status)
    },
  })
  updaterMade = updater
  /** Kettu's update is said once a version: on the island while it runs, else as a notification. */
  function announceUpdate(status: UpdateStatus): void {
    const update = appUpdate(status)
    if (!update || appState.get().notifiedUpdate === update.version) return
    appState.update({ notifiedUpdate: update.version })
    const { version, ready } = update
    const words = {
      title: islandT(ready ? 'pop.appReady' : 'pop.appAvailable', { version }),
      body: islandT(ready ? 'pop.appReadyBody' : 'pop.appAvailableBody'),
    }
    if (island.updatePopped(ready, words)) return
    if (!settings.get().notifications.updates) return
    notifyNotice(`update:${version}`, words, settings.get(), () =>
      sendCommand({ kind: 'open-updates' }),
    )
  }
  let windowsSessionEnd: WindowsSessionEndWatcher | null = null
  quit = new QuitFlow({
    settings: () => settings.get(),
    busySessions: (timeoutMs) => agentHost.busy(timeoutMs),
    busyTerminals: (timeoutMs) => terminalHost.busy(timeoutMs),
    captureUpdateResume: async (timeoutMs) => {
      const sessions = await agentHost.updateResumeSessions(timeoutMs)
      await saveUpdateResume(userDataPath, {
        fromVersion: app.getVersion(),
        sessions,
      })
    },
    clearUpdateResume: () => clearUpdateResume(userDataPath),
    shutDown: async () => {
      browserTabsReporter.dispose()
      account.stop()
      relayToken.stop()
      // Devices hear that Kettu is stopping before their sessions' agent host goes.
      await Promise.all([
        remoteHost.stop().then(() => agentHost.stop()),
        terminalHost.stop(),
        deviceHost.stop(),
        pluginHost.stop(),
      ])
      hostSessions.close()
      await Promise.all([
        settings.flush(),
        windowState.flush(),
        appState.flush(),
        sharing.flush(),
        marketKeys.flush(),
        browserOrigins.flush(),
        signIns.store.flush(),
        siteIcons.flush(),
      ])
    },
    onCleanExit: () => {
      windowsSessionEnd?.stop()
      markCleanExit()
    },
    installUpdate: () => updater.installNow(),
    moveApp: () => updater.moveNow(),
    restartWhenIdle: (initiator, requestId, busy) =>
      void updater.restartWhenIdle(initiator, requestId, busy).catch((error: unknown) => {
        log.warn(`Could not wait to restart to update: ${String(error)}`)
      }),
    updateVersion: () => updater.targetVersion(),
    onUpdateConfirmation: (confirmation) => updater.handleUpdateConfirmation(confirmation),
    onUpdateCancelled: (info) => updater.handleUpdateCancelled(info),
    onUpdateRestarting: (info) => updater.prepareRestartForInstall(info),
  })
  const quitFlow = quit
  configurePageRecovery({
    restart: () => quitFlow.restart(() => prepareRelaunch(isDebugRun())),
    quit: () => app.quit(),
    quitting: () => quitFlow.quitting,
  })
  checkForUpdates = () => void updater.check()
  const agentFolders = new AgentFolders(
    settings,
    join(homedir(), KETTU_HOME_FOLDER, AGENTS_FOLDER),
    (folder) => shell.trashItem(folder),
    (message) => log.warn(message),
  )
  await agentFolders.moveCreatedAgents(join(userDataPath, 'agent-config'))
  const reportsFolder = join(userDataPath, 'reports')
  const reports = new Reports(
    {
      build: async (params) => {
        if (agentHost.state === 'ready') return agentHost.report(params)
        // The agent host is what the report is often about; main reads the logs itself then.
        return writeReport(
          {
            request: params.request,
            now: Date.now(),
            parent: params.parent,
            settings: params.settings,
            host: null,
            logDir: logsFolder(),
            crashDir: params.crashDir,
            screenshot: params.screenshot
              ? new Uint8Array(Buffer.from(params.screenshot, 'base64'))
              : null,
            redact: redactLogText,
          },
          reportsFolder,
        )
      },
      parent: () =>
        mainDiagnostics({ agentHost, terminalHost, launchToInteractiveMs: launchToInteractive() }),
      settings: () => settings.get(),
      setVerbose: (until) => void settings.update({ diagnostics: { verboseUntil: until } }),
      verboseUntil: () => settings.get().diagnostics.verboseUntil,
      onRecording: (recording) => {
        broadcast('report:recording-changed', recording)
        hostAdmin?.diagnosticsChanged(diagnosticsStatus())
      },
      onRecorded: (span) => sendCommand({ kind: 'report-problem', span }),
      submit: (upload) => account.submitReport(upload),
      about: async () => {
        const info = await appInfo()
        return { version: info.version, system: info.system }
      },
    },
    reportsFolder,
  )
  void reports.clearFolder()

  const diagnosticsStatus = (): DiagnosticsStatus => ({
    recording: reports.recordingState(),
    debug: debugStatus(),
    canRecord: true,
    canClearVerbose: true,
    canRestartNormally: true,
  })
  onDebugChanged(() => hostAdmin?.diagnosticsChanged(diagnosticsStatus()))

  hostAdmin = new HostAdmin({
    settings,
    agentFolders,
    platform: process.platform,
    remote: remoteHost,
    remoteStatus,
    info: async () => ({
      ...(await appInfo()),
      sharing: true,
      updates: updater.getStatus().state.kind !== 'off',
      remoteUpdateFlow: updater.getStatus().state.kind !== 'off',
      remoteSwitch: true,
      remoteReset: true,
      ownRelay: true,
      dualRelay: true,
      relayMeasure: true,
      thumbnails: true,
      partThumbnails: true,
      pinnedModels: true,
      drives: true,
      computerUse: true,
      diagnostics: true,
      artifactRecords: [...ARTIFACT_RECORDS],
    }),
    restart: (which) => (which === 'agent' ? agentHost.restart() : terminalHost.restart()),
    sharing,
    updates: updater,
    computerStatus: computerUseStatus,
    diagnostics: {
      status: diagnosticsStatus,
      startRecording: () => {
        reports.startRecording('remote')
        return diagnosticsStatus()
      },
      stopRecording: () => {
        const span = reports.stopRecording('remote')
        return { status: diagnosticsStatus(), span }
      },
      clearVerbose: () => clearVerboseRecords(),
      restartNormally: () => {
        // Defer one tick so the RPC response reaches the remote host before shutdown begins.
        setImmediate(() => quitFlow.restart(() => prepareRelaunch(false)))
      },
    },
    themes,
    marketKeys,
    thumbnail: (id, version, layout) => artifacts.thumbnail(ownArtifact(id), version, layout),
    partThumbnail: (id, version, part) => artifacts.partThumbnail(ownArtifact(id), version, part),
    png: (id, version, page, size) => artifacts.png(ownArtifact(id), version, page, size),
    printPdf: (id, version) => artifacts.printPdf(ownArtifact(id), version),
    report: (request) => reports.forDevice(request),
    submitReport: (ref) => reports.submit(ref),
    send: (event, deviceId, except) => remoteHost.adminEvent(event, deviceId, except),
  })

  const menuDeps = {
    checkForUpdates: () => void updater.check(),
    browserFocused: () => {
      const focused = webContents.getFocusedWebContents()
      return !!focused && browserViews.owns(focused)
    },
    zoom: (step: ZoomStep) => {
      settings.update({ appearance: { zoom: stepZoom(settings.get().appearance.zoom, step) } })
    },
    reportProblem: () => sendCommand({ kind: 'report-problem' }),
  }
  const applyDiagnostics = (until: number | null): void =>
    applyVerbose(
      until,
      () => settings.update({ diagnostics: { verboseUntil: null } }),
      (level, verbose) => agentHost.setLogLevel(level, verbose),
    )
  applyDiagnostics(settings.get().diagnostics.verboseUntil)
  settings.onChange((next, changed) => {
    broadcast('settings:changed', next)
    if (changed.has('appearance') || changed.has('general')) browserViews.lookChanged()
    if (changed.has('diagnostics')) applyDiagnostics(next.diagnostics.verboseUntil)
    hostAdmin?.settingsChanged(next)
    const localeChanged = localeOf(next) !== currentLocale()
    if (localeChanged) {
      setLocale(localeOf(next))
      installMenu(menuDeps)
      tray.updateMenu()
      remoteHost.localeChanged()
      terminalHost.localeChanged()
      deviceHost.localeChanged()
    }
    island.settingsChanged()
    // The agent host reads `general.sessionTitles` and `general.lightModel`, which `reachesHost`
    // cannot single out.
    if (reachesHost(changed) || localeChanged || changed.has('general')) {
      agentHost.pushSettings(hostSettings(next, systemLocale))
    }
    if (changed.has('marketplace')) marketKeys.prune()
    if (changed.has('remote')) {
      remoteHost.directChanged()
      remoteHost.terminalChanged()
      remoteHost.relayChanged()
      remoteHost.relayPreferenceChanged()
      remoteHost.discoverableChanged()
      relayToken.update()
      void remoteHost.setEnabled(next.remote.enabled)
      remoteHost.setHostName(hostName())
      remoteChanged()
      hostsChanged()
    }
    if (changed.has('cloud')) {
      // The window signs out first, while the service can still be told; this forgets it here.
      if (!next.cloud.enabled && account.status().state !== 'signed-out') void account.signOut()
      relayToken.update()
      remoteHost.accountChanged()
      remoteHost.relayChanged()
      remoteHost.directChanged()
      agentHost.pushAccount(activeAccountId())
      artifacts.accountChanged()
      sharing.kettuChanged()
      remoteChanged()
      void remoteOffers.check()
      agentHost.pushMarketAccount(marketAccount())
    }
    // After the remote host, so devices hear why their terminals close; it reads `remote.terminal`.
    if (changed.has('terminal') || changed.has('remote')) {
      terminalHost.pushSettings(terminalSettings(next))
    }
    if (changed.has('appearance') || changed.has('general') || changed.has('computerUse')) {
      computerOverlay.settingsChanged()
    }
    if (changed.has('appearance')) {
      tray.motionChanged()
      applyAppIcon(next.appearance.appIcon)
      applyTheme(next.appearance.theme)
      applyZoom(next.appearance.zoom)
      themes.choose(next.appearance.colorTheme)
    }
    if (changed.has('notifications')) setBadgeEnabled(next.notifications.badge)
    if (changed.has('general')) syncLoginItem(next.general.openAtLogin)
    if (changed.has('proxy')) {
      void sharingSession.setProxy(sessionProxy(next.proxy))
      themesProxy = themesSession.setProxy(sessionProxy(next.proxy))
      avatarsProxy = avatarsSession.setProxy(sessionProxy(next.proxy))
      accountProxy = accountSession.setProxy(sessionProxy(next.proxy))
    }
    updater.settingsChanged(next, changed)
  })

  registerIpcHandlers({
    settings,
    account,
    agentFolders,
    themes,
    avatars,
    agentHost,
    terminalHost,
    deviceHost,
    artifacts,
    browserViews,
    siteIcons,
    mediaGrants,
    sharing,
    marketKeys,
    remoteHost,
    remoteOffers,
    hostSessions,
    hostMedia,
    remoteStatus,
    hostsStatus: () => {
      void readComputerModel()
      return hostsStatus()
    },
    computerModel: readComputerModel,
    updater,
    quit: quitFlow,
    reports,
    island,
  })
  if (trayPanel && trayHostAgents) registerTrayIpc(trayPanel, trayHostAgents)
  ipcReady = true
  installMenu(menuDeps)

  const handleSystemShutdown = (): void => {
    markCleanExit()
    windowsSessionEnd?.stop()
    quitFlow.systemShutdown()
    updater.systemShutdown()
  }
  windowsSessionEnd = new WindowsSessionEndWatcher({
    onSessionEnd: handleSystemShutdown,
  })
  app.on('will-quit', () => windowsSessionEnd?.stop())

  app.on('browser-window-created', (_, window) => {
    // The thumbnails' offscreen windows load no app page and keep their own guards, and computer
    // use's windows over the desktop are none of the app's windows.
    if (window.webContents.isOffscreen() || isOverlayWindow(window)) return
    // A real app window receives Windows session-end directly, so the tray-only fallback is not needed.
    windowsSessionEnd?.dispose()
    // F12 toggles DevTools in development; reload shortcuts are disabled in production. Without
    // zoom: true it swallows Mod+- and Mod+Shift+=, which the menu and the renderer handle.
    optimizer.watchWindowShortcuts(window, { zoom: true })
    if (isDebugRun() && app.isPackaged) watchDevToolsKeys(window)
    watchConsole(window.webContents, 'renderer')
    quitFlow.watchWindow(window)
    watchSubframes(window.webContents, {
      isOpenedArtifact: (url) => artifacts.origins.isOpenedIn(window.webContents, url),
      onRevoked: () => {
        agentHost.revoke(window.webContents)
        terminalHost.revoke(window.webContents)
        deviceHost.revoke(window.webContents)
      },
    })
    artifacts.watchWindow(window.webContents)
    window.once('show', () => applyBadgeTo(window))
    window.on('closed', () => {
      if (appWindows().length === 0) {
        browserViews.closeAll()
        browserTabsReporter.windowDetached()
      }
    })
    window.on('session-end', handleSystemShutdown)
  })
  powerMonitor.on('shutdown', handleSystemShutdown)
  powerMonitor.on('suspend', () => agentHost.power('suspend'))
  // Elsewhere the host reads the battery itself.
  if (process.platform === 'win32') {
    powerMonitor.on('on-battery', () => agentHost.battery(true))
    powerMonitor.on('on-ac', () => agentHost.battery(false))
  }
  powerMonitor.on('resume', () => {
    agentHost.power('resume')
    remoteHost.resume()
  })

  agentHost.start()
  // A sign-in left from before Kettu cloud was turned off is forgotten here, without the service.
  if (!cloudOn() && account.status().state !== 'signed-out') void account.signOut()
  relayToken.update()
  // After the paired devices are read, which an offer depends on.
  void remoteHost.setEnabled(settings.get().remote.enabled).finally(() => remoteOffers.start())
  watchPresence((present) => remoteHost.setPresent(present))
  const window = createMainWindow(start)
  window.once('show', () => {
    updater.start()
    island.firstWindowShown()
  })
  ready = true

  app.on('activate', () => {
    if (!quitFlow.quitting) showMainWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !quitFlow.staysInBackground) {
      app.quit()
      return
    }
    if (process.platform === 'win32' && quitFlow.staysInBackground && !quitFlow.quitting) {
      windowsSessionEnd?.ensureHiddenWatcher()
    }
  })
}

/**
 * A debug run's developer tools keys where there is no menu to carry them: F12 and Ctrl+Shift+I,
 * as in Chrome. macOS has the View menu's item.
 */
function watchDevToolsKeys(window: Electron.BrowserWindow): void {
  if (process.platform === 'darwin') return
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const inspect = input.control && input.shift && !input.alt && input.key.toLowerCase() === 'i'
    if (input.key !== 'F12' && !inspect) return
    event.preventDefault()
    window.webContents.toggleDevTools()
  })
}

if (!app.requestSingleInstanceLock(lockData())) {
  app.quit()
} else {
  startDebugMode(logsFolder())
  start().catch((error: unknown) => {
    log.error('Startup failed', error)
    app.exit(1)
  })
}
