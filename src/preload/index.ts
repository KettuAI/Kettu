import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { HOST_METHODS, type AgentsApi, type HostEvent } from '@shared/agent-host'
import type { GrantedAttachment } from '@shared/attachments'
import type { AppCommand, KettuApi, QuitRequest } from '@shared/ipc'
import { isLocale, type Locale } from '@shared/locale'
import { TERMINAL_METHODS, type TerminalEvent, type TerminalsApi } from '@shared/terminal-host'
import { DEVICE_METHODS, type DeviceEvent } from '@shared/device-host'
import { hostRequestLimit } from '@shared/host-request-limits'
import { filePaths } from './attachments'
import { HostsClient } from './hosts-client'
import { hostTransport, invoke, send, subscribe } from './ipc'
import { PortClient, type ClientPort } from './port-client'

const agents = new PortClient<HostEvent>({
  label: 'agent host',
  methods: HOST_METHODS,
  transport: hostTransport('agent-host'),
  lazy: false,
  limitMs: hostRequestLimit,
})

const otherHosts = new HostsClient({
  requestPort: () => ipcRenderer.send('host-sessions:connect'),
  onPort: (listener) => {
    ipcRenderer.on('host-sessions:port', (event) => {
      const [port] = event.ports as unknown as ClientPort[]
      if (port) listener(port)
    })
  },
})

const terminals = new PortClient<TerminalEvent>({
  label: 'terminal host',
  methods: TERMINAL_METHODS,
  transport: hostTransport('terminal-host'),
  lazy: true,
})

const devices = new PortClient<DeviceEvent>({
  label: 'device host',
  methods: DEVICE_METHODS,
  transport: hostTransport('device-host'),
  lazy: true,
})

// Without a listener, main falls back to a native dialog instead of waiting forever.
const quitListeners = new Set<(request: QuitRequest) => void>()
ipcRenderer.on('app:confirm-quit', (_, request: QuitRequest) => {
  if (quitListeners.size === 0) {
    send('app:confirm-quit-unhandled', request.id)
    return
  }
  for (const listener of quitListeners) listener(request)
})

// A command can arrive before the page subscribes, for example from a notification that
// opened the window; it is held for the first listener.
const commandListeners = new Set<(command: AppCommand) => void>()
let heldCommands: AppCommand[] = []
ipcRenderer.on('app:command', (_, command: AppCommand) => {
  if (commandListeners.size === 0) {
    heldCommands = [...heldCommands.slice(-9), command]
    return
  }
  for (const listener of commandListeners) listener(command)
})

const onSettingsChanged = subscribe('settings:changed')
const onThemesChanged = subscribe('themes:changed')

function systemLocale(): Locale {
  const prefix = '--kettu-system-locale='
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return isLocale(value) ? value : 'en'
}
const onUpdateChanged = subscribe('update:changed')
const onDebugChanged = subscribe('debug:changed')
const onRecordingChanged = subscribe('report:recording-changed')
const onShortcut = subscribe('app:shortcut')
const onArtifactBlocked = subscribe('artifact:blocked')
const onArtifactStopped = subscribe('artifact:stopped')
const onArtifactSelected = subscribe('artifact:selected')
const onAccountChanged = subscribe('account:changed')
const onSharingChanged = subscribe('sharing:changed')
const onRemoteChanged = subscribe('remote:changed')
const onRemotePairing = subscribe('remote:pairing')
const onRemoteDiscovery = subscribe('remote:discovery')
const onHostsChanged = subscribe('hosts:changed')
const onHostPairing = subscribe('hosts:pairing')
const onBrowserState = subscribe('browser:state')
const onBrowserOpened = subscribe('browser:opened')
const onDeviceOpened = subscribe('devices:opened')
const onSiteIcon = subscribe('browser:site-icon')

const pathOf = (file: File) => webUtils.getPathForFile(file)

// Only a drop, a paste or a file input yields a File with a path, so a page names none itself.
async function fromFiles(files: File[]): Promise<(GrantedAttachment | null)[]> {
  const paths = filePaths(files, pathOf)
  const granted = await invoke(
    'attachments:grant',
    paths.filter((path) => path !== ''),
  )
  let next = 0
  return paths.map((path) => (path === '' ? null : (granted[next++] ?? null)))
}

const api: KettuApi = {
  platform: process.platform,
  client: 'desktop',
  hostPlatform: () => process.platform,
  systemLocale: systemLocale(),
  app: {
    getInfo: () => invoke('app:get-info'),
    defaultBrowser: () => invoke('app:default-browser'),
    captureRect: (rect) => invoke('app:capture-rect', rect),
    respondQuit: (id, answer) => invoke('app:respond-quit', id, answer),
    onConfirmQuit: (listener) => {
      quitListeners.add(listener)
      return () => {
        quitListeners.delete(listener)
      }
    },
    onCommand: (listener) => {
      commandListeners.add(listener)
      const held = heldCommands
      heldCommands = []
      for (const command of held) listener(command)
      return () => {
        commandListeners.delete(listener)
      }
    },
    reportInteractive: () => send('perf:interactive'),
    setUnsaved: (files) => send('app:set-unsaved', files),
    closeWindow: () => send('app:close-window'),
    onShortcut,
  },
  artifacts: {
    open: (id) => invoke('artifact:open', id),
    close: (url) => invoke('artifact:close', url),
    thumbnail: (id, version, layout) => invoke('artifact:thumbnail', id, version, layout),
    openExternal: (id, version) => invoke('artifact:open-external', id, version),
    export: (id, version) => invoke('artifact:export', id, version),
    exportAs: (id, version, format) => invoke('artifact:export-as', id, version, format),
    import: (project, kind) => invoke('artifact:import', project, kind),
    onSelected: onArtifactSelected,
    png: (id, version, page, size, name) => invoke('artifact:png', id, version, page, size, name),
    pageImage: (id, version, page, size) => invoke('artifact:page-image', id, version, page, size),
    onBlocked: onArtifactBlocked,
    onStopped: onArtifactStopped,
  },
  remote: {
    status: () => invoke('remote:status'),
    pair: () => invoke('remote:pair'),
    closePairing: (codeId) => invoke('remote:pair-close', codeId),
    answerPairing: (codeId, add, name) => invoke('remote:pair-answer', codeId, add, name),
    pendingDiscovery: () => invoke('remote:discovery-pending'),
    answerDiscovery: (requestId, add, name) =>
      invoke('remote:discovery-answer', requestId, add, name),
    onDiscovery: onRemoteDiscovery,
    renameDevice: (id, name) => invoke('remote:rename-device', id, name),
    removeDevice: (id) => invoke('remote:remove-device', id),
    activity: (id) => invoke('remote:activity', id),
    reset: () => invoke('remote:reset'),
    retryDirect: () => invoke('remote:retry-direct'),
    retryRelay: () => invoke('remote:retry-relay'),
    onChanged: onRemoteChanged,
    onPairing: onRemotePairing,
  },
  hosts: {
    status: () => invoke('hosts:status'),
    pair: (link) => invoke('hosts:pair', link),
    addSsh: (target) => invoke('hosts:add-ssh', target),
    closePairing: (pairId) => invoke('hosts:pair-close', pairId),
    discover: () => invoke('hosts:discover'),
    pairDiscovered: (relayId) => invoke('hosts:pair-discovered', relayId),
    matchPairing: (pairId, match) => invoke('hosts:pair-match', pairId, match),
    rename: (id, name) => invoke('hosts:rename', id, name),
    setAddresses: (id, addresses) => invoke('hosts:set-addresses', id, addresses),
    remove: (id) => invoke('hosts:remove', id),
    retry: () => invoke('hosts:retry'),
    onChanged: onHostsChanged,
    onPairing: onHostPairing,
    request: (hostId, method, params) => otherHosts.request(hostId, method, params),
    onSession: (listener) => otherHosts.onSession(listener),
  },
  account: {
    status: () => invoke('account:status'),
    check: () => invoke('account:check'),
    signIn: () => invoke('account:sign-in'),
    cancelSignIn: () => invoke('account:cancel-sign-in'),
    signOut: () => invoke('account:sign-out'),
    onChanged: onAccountChanged,
  },
  sharing: {
    status: () => invoke('sharing:status'),
    refresh: () => invoke('sharing:refresh'),
    connect: (token, accountId) => invoke('sharing:connect', token, accountId),
    remove: () => invoke('sharing:remove'),
    publish: (id, version, target, access) =>
      invoke('sharing:publish', id, version, target, access),
    update: (id, version) => invoke('sharing:update', id, version),
    setAccess: (id, access) => invoke('sharing:set-access', id, access),
    newCode: (id) => invoke('sharing:new-code', id),
    openLink: (id) => invoke('sharing:open-link', id),
    visitors: (id) => invoke('sharing:visitors', id),
    unpublish: (id) => invoke('sharing:unpublish', id),
    setAuto: (enabled) => invoke('sharing:set-auto', enabled),
    onChanged: onSharingChanged,
  },
  marketplace: {
    setKeys: (patch) => invoke('marketplace:set-keys', patch),
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    onChanged: onSettingsChanged,
    addAgent: (harnessId, name, folder) => invoke('settings:add-agent', harnessId, name, folder),
    renameAgent: (agentId, name) => invoke('settings:rename-agent', agentId, name),
    setAgentColor: (agentId, color) => invoke('settings:set-agent-color', agentId, color),
    removeAgent: (agentId, trash) => invoke('settings:remove-agent', agentId, trash),
  },
  themes: {
    get: () => invoke('themes:get'),
    install: () => invoke('themes:install'),
    replace: (token) => invoke('themes:replace', token),
    remove: (id) => invoke('themes:remove', id),
    export: (text) => invoke('themes:export', text),
    reveal: (id) => invoke('themes:reveal', id),
    catalog: (refresh) => invoke('themes:catalog', refresh),
    installCatalog: (id) => invoke('themes:install-catalog', id),
    onChanged: onThemesChanged,
  },
  avatars: {
    load: (url) => invoke('avatars:load', url),
  },
  loginItem: {
    getStatus: () => invoke('login-item:status'),
  },
  dialogs: {
    openProject: () => invoke('dialog:open-project'),
    chooseAgentBinary: (harnessId) => invoke('dialog:choose-agent-binary', harnessId),
    chooseAgentFolder: () => invoke('dialog:choose-agent-folder'),
    chooseShell: () => invoke('dialog:choose-shell'),
  },
  debug: {
    get: () => invoke('debug:get'),
    restart: (debug) => invoke('debug:restart', debug),
    onChanged: onDebugChanged,
  },
  report: {
    capture: () => invoke('report:capture'),
    prepare: (request) => invoke('report:prepare', request),
    adopt: (zip) => invoke('report:adopt', zip),
    view: (id, path) => invoke('report:view', id, path),
    save: (id) => invoke('report:save', id),
    discard: (id) => invoke('report:discard', id),
    submit: (id) => invoke('report:submit', id),
    recording: () => invoke('report:recording'),
    record: (on) => invoke('report:record', on),
    onRecording: onRecordingChanged,
    crashNotice: () => invoke('report:crash-notice'),
    dismissCrashNotice: () => invoke('report:dismiss-crash-notice'),
  },
  diagnostics: {
    clearVerbose: () => invoke('diagnostics:clear-verbose'),
    recordActions: (actions) => send('diagnostics:actions', actions),
  },
  shell: {
    showDataFolder: () => invoke('shell:show-data-folder'),
    showItem: (path) => invoke('shell:show-item', path),
  },
  editors: {
    list: () => invoke('editors:list'),
    open: (editorId, path) => invoke('editors:open', editorId, path),
    choose: (path) => invoke('editors:choose', path),
  },
  media: {
    copyImage: (source) => invoke('media:copy-image', source),
    saveAs: (source) => invoke('media:save-as', source),
    reveal: (url) => invoke('media:reveal', url),
    openExternal: (url) => invoke('media:open-external', url),
  },
  notifications: {
    test: () => invoke('notifications:test'),
  },
  computer: {
    status: () => invoke('computer:status'),
    requestPermission: (kind) => invoke('computer:request-permission', kind),
    appIcon: (path) => invoke('computer:app-icon', path),
  },
  browser: {
    show: (id, agent) => invoke('browser:show', id, agent),
    hide: (id) => invoke('browser:hide', id),
    close: (id) => invoke('browser:close', id),
    setBounds: (id, bounds) => invoke('browser:bounds', id, bounds),
    navigate: (id, url) => invoke('browser:navigate', id, url),
    back: (id) => invoke('browser:back', id),
    forward: (id) => invoke('browser:forward', id),
    reload: (id) => invoke('browser:reload', id),
    stop: (id) => invoke('browser:stop', id),
    openExternal: (id) => invoke('browser:open-external', id),
    freeze: (id) => invoke('browser:freeze', id),
    thaw: (id) => invoke('browser:thaw', id),
    capture: (id) => invoke('browser:capture', id),
    takeOver: (id) => invoke('browser:take-over', id),
    handBack: (id) => invoke('browser:hand-back', id),
    answerAsk: (id, outcome) => invoke('browser:answer-ask', id, outcome),
    answerOrigin: (id, requestId, decision) =>
      invoke('browser:answer-origin', id, requestId, decision),
    allowedSites: () => invoke('browser:allowed-sites'),
    removeAllowedSite: (projectPath, origin) =>
      invoke('browser:remove-allowed-site', projectPath, origin),
    clearData: () => invoke('browser:clear-data'),
    siteIcons: () => invoke('browser:site-icons'),
    loadSiteIcon: (url) => invoke('browser:load-site-icon', url),
    onSiteIcon,
    siteOpened: (url) => invoke('browser:site-opened', url),
    setSessions: (ids) => send('browser:sessions', ids),
    onState: onBrowserState,
    onOpened: onBrowserOpened,
  },
  attachments: {
    pick: (kind, defaultPath) => invoke('dialog:add-attachments', kind, defaultPath),
    fromFiles,
    // Chromium's paste event can carry fewer files than were copied, so main reads them from the
    // clipboard, and only while it lists the file this paste carried.
    fromClipboard: (files) => {
      const [pasted] = filePaths(files, pathOf)
      if (!pasted) return null
      return invoke('attachments:clipboard-files', pasted).then(
        async (granted) =>
          granted ?? (await fromFiles(files)).flatMap((item) => (item ? [item] : [])),
      )
    },
  },
  updates: {
    getStatus: () => invoke('update:get-status'),
    check: () => invoke('update:check'),
    download: () => invoke('update:download'),
    cancel: () => invoke('update:cancel'),
    restart: () => invoke('update:restart'),
    dismiss: () => invoke('update:dismiss'),
    onChanged: onUpdateChanged,
  },
  agents: {
    request: (method, params) => agents.request(method, params),
    onEvent: (listener) => agents.onEvent(listener),
    onConnection: (listener) => agents.onConnection(listener),
    restart: () => invoke('agent-host:restart'),
  } as AgentsApi,
  terminals: {
    request: (method, params) => terminals.request(method, params),
    onEvent: (listener) => terminals.onEvent(listener),
    onConnection: (listener) => terminals.onConnection(listener),
    restart: () => invoke('terminal-host:restart'),
    running: () => invoke('terminal-host:running'),
  } as TerminalsApi,
  devices: {
    request: (method, params) => devices.request(method, params),
    onEvent: (listener) => devices.onEvent(listener),
    onConnection: (listener) => devices.onConnection(listener),
    restart: () => invoke('device-host:restart'),
    onOpened: onDeviceOpened,
  } as KettuApi['devices'],
}

contextBridge.exposeInMainWorld('kettu', api)
