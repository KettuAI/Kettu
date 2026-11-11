import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  app,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
  webContents,
} from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { ARTIFACT_ID, parseArtifactRef } from '@shared/artifacts'
import { BROWSER_PARTITION } from '@shared/browser'
import { guardKettuFetch } from '@shared/kettu-hosts'
import { matchLocale, resolveLocale, type Locale } from '@shared/locale'
import { HOSTS_FILE, type HostsStatus } from '@shared/remote/hosts'
import { PUSH_URL, PUSH_URL_ENV, pushUrlFrom } from '@shared/remote/push'
import { RELAY_URL, RELAY_URL_ENV, relayUrlFrom } from '@shared/remote/relay'
import type { RemoteStatus } from '@shared/remote/status'
import { stepZoom, type SettingsFile, type ZoomStep } from '@shared/settings'
import { AGENTS_FOLDER, KETTU_HOME_FOLDER } from '@shared/storage'
import { Account } from './account'
import { ACCOUNT_URL, AccountApi, accountBaseUrl, clientInfo } from './account/service'
import { accountFile } from './account/store'
import { AgentFolders } from './agent-folders'
import { AgentHost } from './agent-host'
import { Artifacts, disableDnsPrefetching } from './artifacts'
import { artifactScheme } from './artifacts/protocol'
import { RemoteArtifacts } from './artifacts/remote'
import { AppStateStore } from './app-state'
import { accountAvatarRequestUrl, Avatars } from './avatars'
import { applyBadgeTo, setBadgeCount, setBadgeEnabled } from './badge'
import { RemoteBrowser } from './browser/remote'
import { BrowserViews } from './browser/views'
import { BrowserTools } from './browser/tools'
import { BrowserOriginStore } from './browser/origins'
import { SiteIcons } from './browser/site-icons'
import { asksForDebug, isDebugRun, lockData, startDebugMode } from './debug-mode'
import { broadcast, sendCommand } from './events'
import { HostAdmin } from './host-admin'
import { HostMedia } from './host-media'
import { HostSessions } from './host-sessions'
import { locale as currentLocale, setLocale, t } from './i18n'
import { mainDiagnostics } from './diagnostics'
import { appInfo, launchToInteractive, registerIpcHandlers, registerTrayIpc } from './ipc'
import { Reports } from './report'
import { MediaGrants, mediaScheme, serveMedia } from './media'
import { createLogger } from './log'
import { installMenu } from './menu'
import { isOpenedAtLogin, startMode, syncLoginItem } from './login-item'
import { notifyAttention, notifyDiscovery } from './notifications'
import { RoutinesAwake } from './power-save'
import { sessionProxy } from './proxy'
import { Sharing } from './sharing'
import { KettuUnauthorized } from './sharing/kettu'
import { restrictPermissions } from './permissions'
import { QuitFlow } from './quit'
import { loadStoredDevices } from './remote-devices'
import { RemoteHost } from './remote-host'
import {
  loadDeviceKey,
  loadIdentity,
  loadRelayKey,
  newIdentity,
  newRelayKey,
  type IdentityCipher,
} from './remote-identity'
import { watchPresence } from './presence'
import { RelayToken } from './relay-token'
import { readJsonFile } from './json-file'
import { MarketKeys, marketKeysFile } from './market-keys'
import { computerModelForRun } from './system-model'
import { systemReleaseForRun } from './system-name'
import { rendererPage } from './renderer'
import { SettingsStore } from './settings'
import { effectiveDirect, hostSettings, reachesHost, terminalSettings } from './settings-schema'
import { hasPendingFrame, isRevoked, watchSubframes } from './subframes'
import { DeviceHost } from './device-host'
import { TerminalHost } from './terminal-host'
import { ThemeCatalog } from './theme-catalog'
import { readThemeFolder, readThemeSources, ThemeStore } from './themes'
import { KettuTray } from './tray'
import { openTrayTarget, TrayPanel } from './tray-panel'
import { Updater } from './updater'
import { devUserDataPath } from './user-data'
import {
  applyVerbose,
  logsFolder,
  markRunning,
  openAppLog,
  watchConsole,
  watchProcesses,
} from './app-log'
import { redactLogText } from '@shared/log/process-log'
import { writeReport } from '@shared/log/report-bundle'
import {
  applyTheme,
  applyWindowTheme,
  applyZoom,
  configureWindows,
  createMainWindow,
  currentWindow,
  devIcon,
  showMainWindow,
  watchTheme,
  WindowStateStore,
} from './window'

// Must match appId in electron-builder.yml so Windows groups taskbar entries correctly.
const APP_USER_MODEL_ID = 'sh.kettu.app'

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
  override: process.env['KETTU_USER_DATA'],
  cwd: process.cwd(),
})
if (devUserData) {
  app.setPath('userData', devUserData)
  log.info(`Development run: data in ${devUserData}`)
}
openAppLog(devUserData, isDebugRun())

// Before the app is ready, and only once.
protocol.registerSchemesAsPrivileged([artifactScheme, mediaScheme])
disableDnsPrefetching()

async function start(): Promise<void> {
  const userDataPath = app.getPath('userData')
  const themesDir = join(userDataPath, 'themes')
  const themeSourcesFile = join(userDataPath, 'theme-sources.json')
  // Read while Electron starts, so the first window already has the right theme and bounds.
  const loading = Promise.all([
    SettingsStore.load(userDataPath),
    WindowStateStore.load(userDataPath),
    AppStateStore.load(userDataPath),
    readThemeFolder(themesDir),
    readThemeSources(themeSourcesFile),
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
  const icon = devIcon()
  if (icon) app.dock?.setIcon(icon)
  // The window's page only: the menu bar panel's needs no clipboard.
  restrictPermissions(
    session.defaultSession,
    (url) => rendererPage(url) === 'index',
    (contents) => isRevoked(contents) || hasPendingFrame(contents),
  )
  const [settings, windowState, appState, themeFolder, themeSources] = await loading
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
  const themes = new ThemeStore(themeFolder, themeSources, settings.get().appearance.colorTheme, {
    dir: themesDir,
    sourcesFile: themeSourcesFile,
    catalog,
    select: (id) => settings.update({ appearance: { colorTheme: id } }),
    changed: (state, chosen) => {
      applyWindowTheme(chosen)
      broadcast('themes:changed', state)
      hostAdmin?.themesChanged(themes.hostThemes())
    },
  })
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
  const trayPanel =
    process.platform === 'darwin'
      ? new TrayPanel({
          systemLocale,
          open: (target) => openTrayTarget(target),
          quit: () => app.quit(),
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
  if (trayPanel) registerTrayIpc(trayPanel)

  const mediaGrants = new MediaGrants()
  const browserOrigins = await BrowserOriginStore.load(userDataPath)
  // From the pages' own partition, with the cache they loaded the icon into. The file is read in
  // the background; the window asks for the icons and waits for it then.
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  const siteIcons = SiteIcons.open(userDataPath, {
    fetch: (url, init) => browserSession.fetch(url, init) as unknown as Promise<Response>,
    changed: (event) => broadcast('browser:site-icon', event),
  })
  // The browser tools need the host to answer them, and the pages need the window, so each takes
  // the other's work through this one late binding.
  let browserTools: BrowserTools | null = null
  // The host shows a new origin in the session's thread; it is made after the pages.
  const hostRef: { current: AgentHost | null } = { current: null }
  const browserViews = new BrowserViews({
    window: currentWindow,
    send: (state) => broadcast('browser:state', state),
    dialogOpened: (sessionId, type, accepted) =>
      browserTools?.dialogOpened(sessionId, type, accepted),
    userInput: (sessionId) => browserTools?.userInput(sessionId),
    handBack: (sessionId) => browserTools?.handBack(sessionId),
    stopDriving: (sessionId) => browserTools?.stopDriving(sessionId),
    control: (sessionId) => browserTools?.control.state(sessionId) ?? { kind: 'none' },
    created: (sessionId, contents) => browserTools?.watch(sessionId, contents),
    closed: (sessionId) => browserTools?.forget(sessionId),
    origins: browserOrigins,
    originAsked: (request) => {
      if (!remoteBrowser.originAsked(request)) hostRef.current?.originAsked(request)
    },
    originAnswered: (request) => {
      if (!remoteBrowser.originAnswered(request)) hostRef.current?.originAnswered(request)
    },
    removed: (sessionId) => remoteBrowser.pageRemoved(sessionId),
    siteOpened: (pageUrl, favicons) => {
      if (favicons) void siteIcons.favicons(pageUrl, favicons)
      else siteIcons.visited(pageUrl)
    },
  })
  browserTools = new BrowserTools({
    views: browserViews,
    controlChanged: (sessionId) => browserViews.controlChanged(sessionId),
    opened: (sessionId) => broadcast('browser:opened', { sessionId }),
    log: (level, message) => log[level](`browser: ${message}`),
    waiting: (callId, waiting) => hostRef.current?.browserWaiting(callId, waiting),
  })
  // Other hosts' agents drive the pages of the turns this computer sends them.
  const remoteBrowser = new RemoteBrowser({
    run: (callId, sessionId, tool, args, projectPath, waiting) =>
      browserTools!.call(callId, sessionId, tool, args, projectPath, waiting),
    forward: (hostId, sessionId, forward) => remoteHost.forward(hostId, sessionId, forward),
    closeForwards: (hostId, sessionId) => remoteHost.closeForwards(hostId, sessionId),
    answerOrigin: (sessionId, requestId, decision) =>
      browserViews.answerOrigin(sessionId, requestId, decision),
    request: (hostId, method, params) => hostSessions.request(hostId, method, params),
    log: (level, message) => log[level](`browser: ${message}`),
  })
  const routinesAwake = new RoutinesAwake()
  const terminalHost = new TerminalHost({ settings: () => terminalSettings(settings.get()) })
  const deviceHost = new DeviceHost({ allowDevices: () => true })
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
  const agentHost = new AgentHost({
    settings: () => hostSettings(settings.get(), systemLocale),
    marketKeys: () => marketKeys.contentsForHost(),
    onMarketOAuth: (serverId, state) => void marketKeys.setOAuth(serverId, state),
    onFirstStart: (harnesses) => settings.firstStart(harnesses),
    onAttention: (message) => {
      notifyAttention(message, settings.get(), (sessionId, requestId, optionId) =>
        agentHost.answerPermission(sessionId, requestId, optionId),
      )
      hostAdmin?.attention(message)
      remoteHost.attention(message)
    },
    onWaiting: (sessions) => remoteHost.setWaiting(sessions),
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
    },
    onDown: () => tray.setConnected(false),
    onServicePort: (port) => browserViews.setServicePort(port),
    onOriginDecided: (sessionId, requestId, decision) =>
      browserViews.answerOrigin(sessionId, requestId, decision),
    onComputerAppAllowed: (app) => settings.allowComputerApp(app),
    browser: (request) =>
      remoteBrowser.claimLocal(request.sessionId)
        ? browserTools!.call(
            request.callId,
            request.sessionId,
            request.tool,
            request.args,
            request.projectPath,
          )
        : Promise.resolve({
            error: { code: 'no_page', message: 'Another host’s session has this page.' },
          }),
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
  // Set once the sharing service exists, which publishes with the account.
  let sharingKettuChanged: (() => void) | null = null
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
      broadcast('account:changed', status)
      sharingKettuChanged?.()
      accountChanged()
    },
    log: createLogger('account'),
  })
  const signedIn = (): boolean => account.status().state === 'signed-in'
  // What the relay, push and the account's hosts go by: a sign-in with Kettu's services on.
  const accountInUse = (): boolean => cloudOn() && signedIn()
  const relayOn = (): boolean => settings.get().remote.relay && cloudOn()
  const relayToken = new RelayToken({
    current: () => account.currentToken(),
    signedIn: accountInUse,
    needed: () =>
      settings.get().remote.enabled ||
      remoteHost.pairingHosts ||
      (remoteHost.hosts?.length ?? 0) > 0,
    send: (token) => remoteHost.setToken(token),
  })
  /** The sign-in changed: the relay's token, and the direct connections it holds on without one. */
  function accountChanged(): void {
    relayToken.update()
    remoteHost.directChanged()
    remoteChanged()
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
      relay: !relayOn()
        ? { state: 'off' }
        : !signedIn()
          ? { state: 'signed_out' }
          : { state: 'on', relays: status?.relays ?? [] },
    }
  }
  const remoteChanged = (): void => {
    const status = remoteStatus()
    broadcast('remote:changed', status)
    tray.setRemote(status)
    hostAdmin?.remoteChanged(status)
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
  })
  const hostMedia = new HostMedia((hostId, params) =>
    hostSessions.call(hostId, 'media.read', params),
  )
  const hostSessions: HostSessions = new HostSessions({
    browserCall: (hostId, call) => void remoteBrowser.call(hostId, call),
    originDecided: (hostId, event) => remoteBrowser.originDecided(hostId, event),
    ended: (hostId) => {
      remoteBrowser.hostClosed(hostId)
      remoteArtifacts.ended(hostId)
    },
    artifactEvent: (hostId, event) => {
      if (event.type === 'artifacts.runtime') remoteArtifacts.streamed(hostId, event)
      else if (event.type === 'artifacts.changed' || event.type === 'artifacts.version') {
        remoteArtifacts.changed()
      }
    },
    media: hostMedia,
  })
  const remoteArtifactsDir = join(userDataPath, 'artifacts', 'remote')
  const remoteArtifacts = new RemoteArtifacts({
    call: (hostId, method, params) => hostSessions.call(hostId, method, params),
    dir: remoteArtifactsDir,
  })
  await remoteArtifacts.clear().catch((error: unknown) => {
    log.warn(`Could not remove the files fetched from other hosts: ${String(error)}`)
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
    relay: relayOn,
    discoverable: () => settings.get().remote.discoverable,
    discoveryChanged: (event) => {
      broadcast('remote:discovery', event)
      notifyDiscovery(event, settings.get(), () => void showMainWindow())
    },
    relayTokenReady: () => relayToken.ready(),
    deviceKey: () => loadDeviceKey(userDataPath, identityCipher),
    devicePlatform: systemReleaseForRun,
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
        : { error: { code: 'unavailable', message: 'Kettu is starting' } },
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
    requestRestart: () => quit?.request('update'),
    requestMove: () => quit?.request('move'),
    changed: (status) => hostAdmin?.updatesChanged(status),
  })
  quit = new QuitFlow({
    settings: () => settings.get(),
    busySessions: (timeoutMs) => agentHost.busy(timeoutMs),
    busyTerminals: (timeoutMs) => terminalHost.busy(timeoutMs),
    shutDown: async () => {
      account.stop()
      relayToken.stop()
      // Devices hear that Kettu is stopping before their sessions' agent host goes.
      await Promise.all([
        remoteHost.stop().then(() => agentHost.stop()),
        terminalHost.stop(),
        deviceHost.stop(),
      ])
      hostSessions.close()
      await Promise.all([
        settings.flush(),
        windowState.flush(),
        appState.flush(),
        sharing.flush(),
        marketKeys.flush(),
        browserOrigins.flush(),
        siteIcons.flush(),
      ])
    },
    installUpdate: () => updater.installNow(),
    moveApp: () => updater.moveNow(),
  })
  const quitFlow = quit
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
      onRecording: (recording) => broadcast('report:recording-changed', recording),
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
      remoteSwitch: true,
      remoteReset: true,
      thumbnails: true,
    }),
    restart: (which) => (which === 'agent' ? agentHost.restart() : terminalHost.restart()),
    sharing,
    updates: updater,
    themes,
    marketKeys,
    thumbnail: (id, version, layout) => artifacts.thumbnail(ownArtifact(id), version, layout),
    png: (id, version, page, size) => artifacts.png(ownArtifact(id), version, page, size),
    printPdf: (id, version) => artifacts.printPdf(ownArtifact(id), version),
    report: (request) => reports.forDevice(request),
    submitReport: (ref) => reports.submit(ref),
    send: (event, deviceId) => remoteHost.adminEvent(event, deviceId),
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
    if (changed.has('diagnostics')) applyDiagnostics(next.diagnostics.verboseUntil)
    hostAdmin?.settingsChanged(next)
    const localeChanged = localeOf(next) !== currentLocale()
    if (localeChanged) {
      setLocale(localeOf(next))
      installMenu(menuDeps)
      tray.updateMenu()
    }
    // The agent host reads `general.sessionTitles`, which `reachesHost` cannot single out.
    if (reachesHost(changed) || localeChanged || changed.has('general')) {
      agentHost.pushSettings(hostSettings(next, systemLocale))
    }
    if (changed.has('marketplace')) marketKeys.prune()
    if (changed.has('remote')) {
      remoteHost.directChanged()
      remoteHost.terminalChanged()
      remoteHost.relayChanged()
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
      remoteHost.relayChanged()
      remoteHost.directChanged()
      sharing.kettuChanged()
      remoteChanged()
    }
    // After the remote host, so devices hear why their terminals close; it reads `remote.terminal`.
    if (changed.has('terminal') || changed.has('remote')) {
      terminalHost.pushSettings(terminalSettings(next))
    }
    if (changed.has('appearance')) {
      tray.motionChanged()
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
  })
  ipcReady = true
  installMenu(menuDeps)

  app.on('browser-window-created', (_, window) => {
    // The thumbnails' offscreen windows load no app page and keep their own guards.
    if (window.webContents.isOffscreen()) return
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
  powerMonitor.on('resume', () => {
    agentHost.power('resume')
    remoteHost.resume()
  })

  agentHost.start()
  // A sign-in left from before Kettu cloud was turned off is forgotten here, without the service.
  if (!cloudOn() && account.status().state !== 'signed-out') void account.signOut()
  relayToken.update()
  void remoteHost.setEnabled(settings.get().remote.enabled)
  watchPresence((present) => remoteHost.setPresent(present))
  const window = createMainWindow(start)
  window.once('show', () => updater.start())
  ready = true

  app.on('activate', () => {
    if (!quitFlow.quitting) showMainWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !quitFlow.staysInBackground) app.quit()
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
