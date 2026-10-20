import { join } from 'node:path'
import { BrowserWindow, nativeTheme, shell } from 'electron'
import { isRendererUrl, loadRenderer } from './renderer'

// Must match --background in the renderer theme, or the window flashes on load.
const BACKGROUND_COLOR = { light: '#ffffff', dark: '#0a0a0a' }

export function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors
      ? BACKGROUND_COLOR.dark
      : BACKGROUND_COLOR.light,
    autoHideMenuBar: true,
    titleBarStyle: isMac ? 'hidden' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 14 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    openIfExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (isRendererUrl(url)) return
    event.preventDefault()
    openIfExternal(url)
  })

  void loadRenderer(window)
  return window
}

function openIfExternal(url: string): void {
  const protocol = URL.parse(url)?.protocol
  if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url)
}
