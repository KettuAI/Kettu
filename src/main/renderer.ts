import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'

const devServerUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined

export function loadRenderer(window: BrowserWindow): Promise<void> {
  if (devServerUrl) return window.loadURL(devServerUrl)
  return window.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Whether a URL belongs to the app's own renderer, as opposed to remote content. */
export function isRendererUrl(url: string | undefined): boolean {
  if (!url) return false
  return devServerUrl ? url.startsWith(devServerUrl) : url.startsWith('file://')
}
