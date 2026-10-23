import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { HOST_METHODS, type AgentsApi, type HostEvent } from '@shared/agent-host'
import type { AppCommand, OverbenchApi, QuitRequest } from '@shared/ipc'
import { isLocale, type Locale } from '@shared/locale'
import { TERMINAL_METHODS, type TerminalEvent, type TerminalsApi } from '@shared/terminal-host'
import { filePaths } from './attachments'
import { hostTransport, invoke, send, subscribe } from './ipc'
import { PortClient } from './port-client'

const agents = new PortClient<HostEvent>({
  label: 'agent host',
  methods: HOST_METHODS,
  transport: hostTransport('agent-host'),
  lazy: false,
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

function systemLocale(): Locale {
  const prefix = '--overbench-system-locale='
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return isLocale(value) ? value : 'en'
}
const onUpdateChanged = subscribe('update:changed')
const onShortcut = subscribe('app:shortcut')
const onArtifactBlocked = subscribe('artifact:blocked')
const onArtifactStopped = subscribe('artifact:stopped')

const api: OverbenchApi = {
  platform: process.platform,
  perf: process.argv.includes('--overbench-perf'),
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
    onBlocked: onArtifactBlocked,
    onStopped: onArtifactStopped,
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    onChanged: onSettingsChanged,
  },
  dialogs: {
    openProject: () => invoke('dialog:open-project'),
    chooseAgentBinary: (agentId) => invoke('dialog:choose-agent-binary', agentId),
    chooseShell: () => invoke('dialog:choose-shell'),
  },
  diagnostics: {
    save: (bundle) => invoke('diagnostics:save', bundle),
  },
  shell: {
    showDataFolder: () => invoke('shell:show-data-folder'),
    showItem: (path) => invoke('shell:show-item', path),
  },
  notifications: {
    test: () => invoke('notifications:test'),
  },
  attachments: {
    pick: (kind, defaultPath) => invoke('dialog:add-attachments', kind, defaultPath),
    // Only a drop, a paste or a file input yields a File with a path, so a page names none itself.
    fromFiles: async (files) => {
      const paths = filePaths(files, (file) => webUtils.getPathForFile(file))
      const granted = await invoke(
        'attachments:grant',
        paths.filter((path) => path !== ''),
      )
      let next = 0
      return paths.map((path) => (path === '' ? null : (granted[next++] ?? null)))
    },
  },
  updates: {
    getStatus: () => invoke('update:get-status'),
    check: () => invoke('update:check'),
    download: () => invoke('update:download'),
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

contextBridge.exposeInMainWorld('overbench', api)
