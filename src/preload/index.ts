import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { HOST_METHODS, type AgentsApi, type HostEvent } from '@shared/agent-host'
import type { GrantedAttachment } from '@shared/attachments'
import type { AppCommand, KettuApi, QuitRequest } from '@shared/ipc'
import { isLocale, type Locale } from '@shared/locale'
import { TERMINAL_METHODS, type TerminalEvent, type TerminalsApi } from '@shared/terminal-host'
import { filePaths } from './attachments'
import { HostsClient } from './hosts-client'
import { hostTransport, invoke, send, subscribe } from './ipc'
import { PortClient, type ClientPort } from './port-client'

const agents = new PortClient<HostEvent>({
  label: 'agent host',
  methods: HOST_METHODS,
  transport: hostTransport('agent-host'),
  lazy: false,
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
const onShortcut = subscribe('app:shortcut')
const onArtifactBlocked = subscribe('artifact:blocked')
const onArtifactStopped = subscribe('artifact:stopped')
const onAccountChanged = subscribe('account:changed')
const onSharingChanged = subscribe('sharing:changed')
const onRemoteChanged = subscribe('remote:changed')
const onRemotePairing = subscribe('remote:pairing')
const onHostsChanged = subscribe('hosts:changed')
const onHostPairing = subscribe('hosts:pairing')
const onBrowserState = subscribe('browser:state')
const onBrowserOpened = subscribe('browser:opened')

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
  perf: process.argv.includes('--kettu-perf'),
  systemLocale: systemLocale(),
  app: {
    getInfo: () => invoke('app:get-info'),
    respondQuit: (id, confirmed) => invoke('app:respond-quit', id, confirmed),
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
    perfMetrics: () => invoke('perf:metrics'),
    onShortcut,
  },
  artifacts: {
    open: (id) => invoke('artifact:open', id),
    close: (url) => invoke('artifact:close', url),
    thumbnail: (id, version, layout) => invoke('artifact:thumbnail', id, version, layout),
    openExternal: (id, version) => invoke('artifact:open-external', id, version),
    export: (id, version) => invoke('artifact:export', id, version),
    import: (project) => invoke('artifact:import', project),
    onBlocked: onArtifactBlocked,
    onStopped: onArtifactStopped,
  },
  remote: {
    status: () => invoke('remote:status'),
    pair: () => invoke('remote:pair'),
    closePairing: (codeId) => invoke('remote:pair-close', codeId),
    answerPairing: (codeId, add, name) => invoke('remote:pair-answer', codeId, add, name),
    renameDevice: (id, name) => invoke('remote:rename-device', id, name),
    removeDevice: (id) => invoke('remote:remove-device', id),
    activity: (id) => invoke('remote:activity', id),
    reset: () => invoke('remote:reset'),
    retryDirect: () => invoke('remote:retry-direct'),
    onChanged: onRemoteChanged,
    onPairing: onRemotePairing,
  },
  hosts: {
    status: () => invoke('hosts:status'),
    pair: (link) => invoke('hosts:pair', link),
    closePairing: (pairId) => invoke('hosts:pair-close', pairId),
    rename: (id, name) => invoke('hosts:rename', id, name),
    setAddresses: (id, addresses) => invoke('hosts:set-addresses', id, addresses),
    remove: (id) => invoke('hosts:remove', id),
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
    connect: (token, accountId) => invoke('sharing:connect', token, accountId),
    remove: () => invoke('sharing:remove'),
    publish: (id, version) => invoke('sharing:publish', id, version),
    update: (id, version) => invoke('sharing:update', id, version),
    unpublish: (id) => invoke('sharing:unpublish', id),
    onChanged: onSharingChanged,
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    onChanged: onSettingsChanged,
    addAgent: (harnessId, name, folder) => invoke('settings:add-agent', harnessId, name, folder),
    renameAgent: (agentId, name) => invoke('settings:rename-agent', agentId, name),
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
  diagnostics: {
    save: (bundle) => invoke('diagnostics:save', bundle),
  },
  shell: {
    showDataFolder: () => invoke('shell:show-data-folder'),
    showItem: (path) => invoke('shell:show-item', path),
    openNotices: () => invoke('shell:open-notices'),
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
  browser: {
    show: (id) => invoke('browser:show', id),
    hide: (id) => invoke('browser:hide', id),
    setBounds: (id, bounds) => invoke('browser:bounds', id, bounds),
    navigate: (id, url) => invoke('browser:navigate', id, url),
    back: (id) => invoke('browser:back', id),
    forward: (id) => invoke('browser:forward', id),
    reload: (id) => invoke('browser:reload', id),
    stop: (id) => invoke('browser:stop', id),
    openExternal: (id) => invoke('browser:open-external', id),
    freeze: (id) => invoke('browser:freeze', id),
    thaw: (id) => invoke('browser:thaw', id),
    handBack: (id) => invoke('browser:hand-back', id),
    stopDriving: (id) => invoke('browser:stop-driving', id),
    answerOrigin: (id, requestId, decision) =>
      invoke('browser:answer-origin', id, requestId, decision),
    allowedSites: () => invoke('browser:allowed-sites'),
    removeAllowedSite: (projectPath, origin) =>
      invoke('browser:remove-allowed-site', projectPath, origin),
    clearData: () => invoke('browser:clear-data'),
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
  } as TerminalsApi,
}

contextBridge.exposeInMainWorld('kettu', api)
