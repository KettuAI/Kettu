import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen, shell } from 'electron'
import type { SettingsFile } from '@shared/settings'
import { JsonFileWriter, readJsonFile } from './json-file'
import { createLogger } from './log'
import { isRendererUrl, loadRenderer } from './renderer'
import { parseWindowState, placeWindow, type SavedWindowState } from './window-bounds'

const log = createLogger('window')

// Must match --background in the renderer theme, oklch(0.991 0 0) and oklch(0.196 0 0),
// or the window flashes on load.
const BACKGROUND_COLOR = { light: '#fcfcfc', dark: '#151515' }

// The symbols of the Windows and Linux window controls: --foreground of each theme.
const SYMBOL_COLOR = { light: '#0a0a0a', dark: '#fafafa' }

const TITLE_BAR_HEIGHT = 40
const DEFAULT_SIZE = { width: 1280, height: 820 }
const MIN_SIZE = { width: 960, height: 600 }

export function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND_COLOR.dark : BACKGROUND_COLOR.light
}

function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors
  return {
    color: dark ? BACKGROUND_COLOR.dark : BACKGROUND_COLOR.light,
    symbolColor: dark ? SYMBOL_COLOR.dark : SYMBOL_COLOR.light,
    height: TITLE_BAR_HEIGHT,
  }
}

export function applyTheme(theme: SettingsFile['appearance']['theme']): void {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme
}

/** Keeps each window's background and window controls in step with the effective theme. */
export function watchTheme(): void {
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.setBackgroundColor(backgroundColor())
      if (process.platform !== 'darwin') window.setTitleBarOverlay(titleBarOverlay())
    }
  })
}

/** Owns window-state.json: the main window's size, position and maximized state. */
export class WindowStateStore {
  private constructor(
    private saved: SavedWindowState | null,
    private readonly writer: JsonFileWriter,
  ) {}

  static async load(userDataPath: string): Promise<WindowStateStore> {
    const path = join(userDataPath, 'window-state.json')
    const read = await readJsonFile(path)
    let saved: SavedWindowState | null = null
    if (read.kind === 'ok') saved = parseWindowState(read.value)
    if (read.kind === 'unreadable' || (read.kind === 'ok' && !saved)) {
      log.warn('window-state.json is invalid; opening at the default size')
    }
    return new WindowStateStore(saved, new JsonFileWriter(path, log))
  }

  placement(): ReturnType<typeof placeWindow> {
    const workAreas = screen.getAllDisplays().map((display) => display.workArea)
    return placeWindow(
      this.saved,
      workAreas,
      screen.getPrimaryDisplay().workArea,
      DEFAULT_SIZE,
      MIN_SIZE,
    )
  }

  track(window: BrowserWindow): void {
    const save = (): void => {
      if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
      // getNormalBounds is the restored size while maximized.
      this.saved = { bounds: window.getNormalBounds(), maximized: window.isMaximized() }
      this.writer.schedule({ version: 1, ...this.saved })
    }
    window.on('resize', save)
    window.on('move', save)
    window.on('maximize', save)
    window.on('unmaximize', save)
    window.on('close', save)
  }

  flush(): Promise<void> {
    return this.writer.flush()
  }
}

export interface WindowOptions {
  state: WindowStateStore
  perf: boolean
}

let options: WindowOptions | null = null

export function configureWindows(windowOptions: WindowOptions): void {
  options = windowOptions
}

export function createMainWindow(): BrowserWindow {
  if (!options) throw new Error('configureWindows must run before a window is created')
  const isMac = process.platform === 'darwin'
  const placement = options.state.placement()

  const window = new BrowserWindow({
    ...placement.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    backgroundColor: backgroundColor(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: options.perf ? ['--overbench-perf'] : [],
    },
  })

  options.state.track(window)
  window.once('ready-to-show', () => {
    if (placement.maximized) window.maximize()
    window.show()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openIfExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (isRendererUrl(url)) return
    event.preventDefault()
    openIfExternal(url)
  })

  void loadRenderer(window).catch((error: unknown) =>
    log.error('Could not load the renderer', error),
  )
  return window
}

/** The window to talk to: the focused one, else the first open one. */
export function currentWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null
}

/** Brings the main window forward, creating it if every window was closed. */
export function showMainWindow(): BrowserWindow {
  const window = currentWindow() ?? createMainWindow()
  if (window.isMinimized()) window.restore()
  if (window.isVisible()) window.focus()
  return window
}

export function openIfExternal(url: string): void {
  const protocol = URL.parse(url)?.protocol
  if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url)
}
