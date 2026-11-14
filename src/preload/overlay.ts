// The page overlay's preload: the settings and themes it reads to look as the window does, and its
// own channel to main, exposed as window.kettu so the shared settings, theme and language code runs
// unchanged. Main answers these from the overlay's own contents alone.

import { contextBridge, ipcRenderer } from 'electron'
import {
  OVERLAY_CHANNELS,
  type ControlOverlayApi,
  type ControlOverlayEvent,
  type ControlOverlayRequest,
} from '@shared/control'
import { isLocale, type Locale } from '@shared/locale'
import type { SettingsFile } from '@shared/settings'
import type { ThemesState } from '@shared/themes'

function systemLocale(): Locale {
  const prefix = '--kettu-system-locale='
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return isLocale(value) ? value : 'en'
}

function listen<T>(channel: string): (listener: (payload: T) => void) => () => void {
  const listeners = new Set<(payload: T) => void>()
  ipcRenderer.on(channel, (_, payload: T) => {
    for (const listener of listeners) listener(payload)
  })
  return (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

const api: ControlOverlayApi = {
  platform: process.platform,
  client: 'desktop',
  systemLocale: systemLocale(),
  settings: {
    get: () => ipcRenderer.invoke(OVERLAY_CHANNELS.settings) as Promise<SettingsFile>,
    onChanged: listen<SettingsFile>(OVERLAY_CHANNELS.settingsChanged),
  },
  themes: {
    get: () => ipcRenderer.invoke(OVERLAY_CHANNELS.themes) as Promise<ThemesState>,
    onChanged: listen<ThemesState>(OVERLAY_CHANNELS.themesChanged),
  },
  overlay: {
    onEvent: listen<ControlOverlayEvent>(OVERLAY_CHANNELS.event),
    request: (request: ControlOverlayRequest) =>
      ipcRenderer.send(OVERLAY_CHANNELS.request, request),
  },
}

contextBridge.exposeInMainWorld('kettu', api)
