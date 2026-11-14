// The preload of computer use's overlay pages, the light around the real window and the label at
// the top of the screen: the state main sends, and the label's buttons and size. Nothing else.

import { contextBridge, ipcRenderer } from 'electron'
import {
  OVERLAY_CHANNELS,
  type ComputerOverlayApi,
  type ComputerOverlayPart,
  type ComputerOverlayState,
} from '@shared/computer-overlay'
import { isLocale, type Locale } from '@shared/locale'

function argument(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function systemLocale(): Locale {
  const value = argument('kettu-system-locale')
  return isLocale(value) ? value : 'en'
}

const part: ComputerOverlayPart = argument('kettu-overlay-part') === 'light' ? 'light' : 'label'

// Main may send before the page listens, so the latest state waits for its first listener.
let latest: ComputerOverlayState | null = null
const listeners = new Set<(state: ComputerOverlayState) => void>()
ipcRenderer.on(OVERLAY_CHANNELS.state, (_event, state: ComputerOverlayState) => {
  latest = state
  for (const listener of listeners) listener(state)
})

const api: ComputerOverlayApi = {
  platform: process.platform as ComputerOverlayApi['platform'],
  client: 'desktop',
  systemLocale: systemLocale(),
  part,
  onState: (listener) => {
    listeners.add(listener)
    if (latest) listener(latest)
    return () => {
      listeners.delete(listener)
    }
  },
  act: (action) => ipcRenderer.send(OVERLAY_CHANNELS.action, action),
  resize: (width, height) => ipcRenderer.send(OVERLAY_CHANNELS.resize, width, height),
}

contextBridge.exposeInMainWorld('kettu', api)
