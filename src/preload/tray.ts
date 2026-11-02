// The menu bar panel's preload: the few reads the panel shares with the window and its own calls,
// exposed as window.kettu so the shared settings, theme and language code runs unchanged.

import { contextBridge } from 'electron'
import type { HostEvent } from '@shared/agent-host'
import { isLocale, type Locale } from '@shared/locale'
import { TRAY_HOST_METHODS, type TrayPanelApi } from '@shared/tray'
import { hostTransport, invoke, send, subscribe } from './ipc'
import { PortClient } from './port-client'

const agents = new PortClient<HostEvent>({
  label: 'agent host',
  methods: TRAY_HOST_METHODS,
  transport: hostTransport('agent-host'),
  lazy: false,
})

function systemLocale(): Locale {
  const prefix = '--kettu-system-locale='
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return isLocale(value) ? value : 'en'
}

const onShown = subscribe('tray:shown')

const api: TrayPanelApi = {
  platform: process.platform,
  client: 'desktop',
  systemLocale: systemLocale(),
  settings: {
    get: () => invoke('settings:get'),
    onChanged: subscribe('settings:changed'),
  },
  themes: {
    get: () => invoke('themes:get'),
    onChanged: subscribe('themes:changed'),
  },
  remote: {
    status: () => invoke('remote:status'),
    onChanged: subscribe('remote:changed'),
  },
  agents: {
    request: (method, params) => agents.request(method, params),
    onEvent: (listener) => agents.onEvent(listener),
    onConnection: (listener) => agents.onConnection(listener),
  } as TrayPanelApi['agents'],
  tray: {
    open: (target) => send('tray:open', target),
    quit: () => send('tray:quit'),
    hide: () => send('tray:hide'),
    resize: (height) => send('tray:resize', height),
    onShown: (listener) => onShown(() => listener()),
  },
}

contextBridge.exposeInMainWorld('kettu', api)
