import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen, shell } from 'electron'
import type { Locale } from '@shared/locale'
import { DEFAULT_SETTINGS, type SettingsFile, type ZoomLevel } from '@shared/settings'
import { JsonFileWriter, readJsonFile } from './json-file'
import { createLogger } from './log'
import { isRendererUrl, loadRenderer } from './renderer'
import { parseWindowState, placeWindow, type SavedWindowState } from './window-bounds'

const log = createLogger('window')

// Must match --bg-app in the renderer's tokens.css, or the window flashes on load.
const BACKGROUND_COLOR = { light: '#ffffff', dark: '#1b1b1a' }

// The symbols of the Windows and Linux window controls: --text-primary of each theme.
const SYMBOL_COLOR = { light: '#262626', dark: '#ececea' }

const TITLE_BAR_HEIGHT = 40
// The traffic lights' height; at 100% they sit at { x: 16, y: 14 }, centred in the top bar.
const TRAFFIC_LIGHTS_HEIGHT = 12
const DEFAULT_SIZE = { width: 1280, height: 820 }
const MIN_SIZE = { width: 960, height: 600 }

let zoom: ZoomLevel = DEFAULT_SETTINGS.appearance.zoom

export function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND_COLOR.dark : BACKGROUND_COLOR.light
}

function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors
  return {
    color: dark ? BACKGROUND_COLOR.dark : BACKGROUND_COLOR.light,
    symbolColor: dark ? SYMBOL_COLOR.dark : SYMBOL_COLOR.light,
    height: Math.round(TITLE_BAR_HEIGHT * zoom),
  }
}

/**
 * The page zoom scales the top bar but not the window controls, so the traffic lights move to
 * stay centred in it and the overlay takes its height. The renderer leaves the traffic lights
 * their unzoomed width (--traffic-lights).
 */
function trafficLightPosition(): { x: number; y: number } {
  return {
    x: Math.round(16 * zoom),
    y: Math.round((TITLE_BAR_HEIGHT * zoom - TRAFFIC_LIGHTS_HEIGHT) / 2),
  }
}

/** Zooms every window and moves its window controls with the top bar. */
export function applyZoom(factor: ZoomLevel): void {
  if (factor === zoom) return
  zoom = factor
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.setZoomFactor(zoom)
    if (process.platform === 'darwin') window.setWindowButtonPosition(trafficLightPosition())
    else window.setTitleBarOverlay(titleBarOverlay())
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
  systemLocale: Locale
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
      ? { trafficLightPosition: trafficLightPosition() }
      : { titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The page resolves Settings › General › Language itself; only the system's choice is
      // main's to know.
      additionalArguments: [
        `--overbench-system-locale=${options.systemLocale}`,
        ...(options.perf ? ['--overbench-perf'] : []),
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
