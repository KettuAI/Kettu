import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron'
import type { Locale } from '@shared/locale'
import { DEFAULT_SETTINGS, type SettingsFile, type ZoomLevel } from '@shared/settings'
import type { Theme } from '@shared/themes'
import { mayOpenWindow } from './artifacts/guards'
import { JsonFileWriter, readJsonFile } from './json-file'
import { createLogger } from './log'
import type { StartMode } from './login-item'
import { isRendererUrl, loadRenderer } from './renderer'
import { windowColors, type WindowColors } from './themes'
import { parseWindowState, placeWindow, type SavedWindowState } from './window-bounds'
import { titleBarHeight, trafficLightPosition } from './window-controls'

const log = createLogger('window')

// Must match --bg-sidebar in the renderer's tokens.css, or the window flashes on load.
const BACKGROUND_COLOR = { light: '#fafafa', dark: '#171717' }

// The symbols of the Windows and Linux window controls: --text-primary of each theme.
const SYMBOL_COLOR = { light: '#222222', dark: '#ececec' }

// The chosen theme, whose colors replace the two above; null for the built-in theme.
let chosen: Theme | null = null

const DEFAULT_SIZE = { width: 1280, height: 820 }
const MIN_SIZE = { width: 960, height: 600 }

// Packaged builds carry the icon in the bundle; a development run would show Electron's own.
export function devIcon(): string | null {
  return app.isPackaged ? null : join(app.getAppPath(), 'build/icon.png')
}

let zoom: ZoomLevel = DEFAULT_SETTINGS.appearance.zoom

function colors(): WindowColors {
  const mode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const fallback = { background: BACKGROUND_COLOR[mode], symbol: SYMBOL_COLOR[mode] }
  return chosen ? windowColors(chosen[mode].colors, mode, fallback) : fallback
}

export function backgroundColor(): string {
  return colors().background
}

function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const { background, symbol } = colors()
  return { color: background, symbolColor: symbol, height: titleBarHeight(zoom) }
}

/** Zooms every window and moves its window controls with the top bar. */
export function applyZoom(factor: ZoomLevel): void {
  if (factor === zoom) return
  zoom = factor
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.setZoomFactor(zoom)
    if (process.platform === 'darwin') window.setWindowButtonPosition(trafficLightPosition(zoom))
    else window.setTitleBarOverlay(titleBarOverlay())
  }
}

export function applyTheme(theme: SettingsFile['appearance']['theme']): void {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme
}

function repaint(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.setBackgroundColor(backgroundColor())
    if (process.platform !== 'darwin') window.setTitleBarOverlay(titleBarOverlay())
  }
}

/** Gives every window the chosen theme's background and window controls. */
export function applyWindowTheme(next: Theme | null): void {
  chosen = next
  repaint()
}

/** Keeps each window's background and window controls in step with the effective theme. */
export function watchTheme(): void {
  nativeTheme.on('updated', repaint)
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
  systemLocale: Locale
}

let options: WindowOptions | null = null

export function configureWindows(windowOptions: WindowOptions): void {
  options = windowOptions
}

export function createMainWindow(start: StartMode = 'window'): BrowserWindow {
  if (!options) throw new Error('configureWindows must run before a window is created')
  const isMac = process.platform === 'darwin'
  const placement = options.state.placement()
  // On macOS the Dock carries the icon, set once in index.ts.
  const icon = isMac ? null : devIcon()

  const window = new BrowserWindow({
    ...placement.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    backgroundColor: backgroundColor(),
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: trafficLightPosition(zoom) }
      : { titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The page resolves Settings › General › Language itself; only the system's choice is
      // main's to know.
      additionalArguments: [
        `--kettu-system-locale=${options.systemLocale}`,
        ...(options.perf ? ['--kettu-perf'] : []),
      ],
      // A perf run measures frames and timers, which Chromium throttles for a window behind others.
      backgroundThrottling: !options.perf,
    },
  })

  options.state.track(window)
  // Set on every load: webPreferences.zoomFactor would come back on a reload after the user
  // chose 100%. Set here, it applies before the page's first script runs.
  window.webContents.on('did-navigate', () => window.webContents.setZoomFactor(zoom))
  window.once('ready-to-show', () => {
    if (start === 'hidden') return
    if (placement.maximized) window.maximize()
    window.show()
    if (start === 'minimized') window.minimize()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (mayOpenWindow(window.webContents, url)) openIfExternal(url)
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
  window.show()
  window.focus()
  return window
}

export function openIfExternal(url: string): void {
  const protocol = URL.parse(url)?.protocol
  if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url)
}
