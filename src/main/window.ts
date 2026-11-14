import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, screen, shell, type WebContents } from 'electron'
import type { AppCommand } from '@shared/ipc'
import type { Locale } from '@shared/locale'
import { DEFAULT_SETTINGS, type SettingsFile, type ZoomLevel } from '@shared/settings'
import type { Theme } from '@shared/themes'
import { mayOpenWindow } from './artifacts/guards'
import { JsonFileWriter, readJsonFile } from './json-file'
import { createLogger } from './log'
import type { StartMode } from './login-item'
import { loadRenderer, rendererPage } from './renderer'
import { windowColors, type WindowColors } from './themes'
import { parseWindowState, placeWindow, type SavedWindowState } from './window-bounds'
import { titleBarHeight, trafficLightPosition } from './window-controls'

const log = createLogger('window')

// Windows and Linux: must match --bg-sidebar in the renderer's tokens.css, or the window flashes
// on load. On macOS the window is clear over the system's sidebar material, which the page tints.
const BACKGROUND_COLOR = { light: '#f8f8f8', dark: '#0e0e10' }
const CLEAR = '#00000000'

// The symbols of the Windows and Linux window controls: --text-primary of each theme.
const SYMBOL_COLOR = { light: '#10161e', dark: '#e8ecf1' }

// The chosen theme, whose colors replace the two above; null for the built-in theme.
let chosen: Theme | null = null

const DEFAULT_SIZE = { width: 1280, height: 820 }
const MIN_SIZE = { width: 960, height: 600 }

// Packaged builds carry the icon in the bundle; a development run would show Electron's own.
export function devIcon(): string | null {
  return app.isPackaged ? null : join(app.getAppPath(), 'build/icon.png')
}

let zoom: ZoomLevel = DEFAULT_SETTINGS.appearance.zoom

// The menu bar panel's window: never the one to talk to, transparent over the system's material,
// and sized for the menu bar rather than the app's zoom.
const panels = new WeakSet<BrowserWindow>()

export function markPanel(window: BrowserWindow): void {
  panels.add(window)
}

/** Whether `contents` is the menu bar panel's page. */
export function isPanel(contents: WebContents): boolean {
  const window = BrowserWindow.fromWebContents(contents)
  return window !== null && panels.has(window) && !computerOverlays.has(window)
}

// Computer use's windows over the desktop: never the one to talk to, and none of the app's.
const computerOverlays = new WeakSet<BrowserWindow>()
let creatingOverlay = false

/**
 * Creates one of computer use's windows over the desktop. Each is a panel to the rest of the app,
 * and the hooks every new window gets, which run while it is being created, can tell it apart.
 */
export function createOverlayWindow(
  options: Electron.BrowserWindowConstructorOptions,
): BrowserWindow {
  creatingOverlay = true
  try {
    const window = new BrowserWindow(options)
    computerOverlays.add(window)
    panels.add(window)
    return window
  } finally {
    creatingOverlay = false
  }
}

/** Whether `window` is one of computer use's windows, or one being created. */
export function isOverlayWindow(window: BrowserWindow): boolean {
  return creatingOverlay || computerOverlays.has(window)
}

/** Whether `contents` is the page of one of computer use's windows. */
export function isComputerOverlay(contents: WebContents): boolean {
  const window = BrowserWindow.fromWebContents(contents)
  return window !== null && computerOverlays.has(window)
}

/** Whether one of the app's own windows, not a panel or overlay, has the focus. */
export function appFocused(): boolean {
  const focused = BrowserWindow.getFocusedWindow()
  return focused !== null && !focused.isDestroyed() && !panels.has(focused)
}

// The overlays over the browser's pages: the app's own page in a view, which may call main only
// over its own channel.
const overlays = new WeakSet<WebContents>()

export function markOverlay(contents: WebContents): void {
  overlays.add(contents)
}

/** Whether `contents` is a page overlay's, whatever URL its page shows. */
export function isOverlay(contents: WebContents): boolean {
  return overlays.has(contents)
}

/** The app's own windows, without the menu bar panel. */
function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && !panels.has(window),
  )
}

function colors(): WindowColors {
  const mode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const fallback = { background: BACKGROUND_COLOR[mode], symbol: SYMBOL_COLOR[mode] }
  return chosen ? windowColors(chosen[mode].colors, mode, fallback) : fallback
}

export function backgroundColor(): string {
  return process.platform === 'darwin' ? CLEAR : colors().background
}

function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const { background, symbol } = colors()
  return { color: background, symbolColor: symbol, height: titleBarHeight(zoom) }
}

/** Zooms every window and moves its window controls with the top bar. */
export function applyZoom(factor: ZoomLevel): void {
  if (factor === zoom) return
  zoom = factor
  for (const window of appWindows()) {
    window.webContents.setZoomFactor(zoom)
    if (process.platform === 'darwin') window.setWindowButtonPosition(trafficLightPosition(zoom))
    else window.setTitleBarOverlay(titleBarOverlay())
  }
}

export function applyTheme(theme: SettingsFile['appearance']['theme']): void {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme
}

function repaint(): void {
  for (const window of appWindows()) {
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
      ? {
          trafficLightPosition: trafficLightPosition(zoom),
          vibrancy: 'sidebar',
          // Grays out with the window when another one is active, as the system's sidebars do.
          visualEffectState: 'followWindow',
        }
      : { titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The page resolves Settings › General › Language itself; only the system's choice is
      // main's to know.
      additionalArguments: [`--kettu-system-locale=${options.systemLocale}`],
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
    if (rendererPage(url) === 'index') return
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
  if (focused && !focused.isDestroyed() && !panels.has(focused)) return focused
  return appWindows()[0] ?? null
}

// macOS: windows that closing hid, their pages kept as they were.
const hiddenOnClose = new WeakSet<BrowserWindow>()

/** Whether closing `window` hides it: on macOS, the last app window, so reopening it is instant. */
export function hidesOnClose(window: BrowserWindow): boolean {
  return (
    process.platform === 'darwin' &&
    !panels.has(window) &&
    appWindows().every((other) => other === window || !other.isVisible())
  )
}

/** Whether `window` is hidden because it was closed, which no menu command reaches. */
export function isHiddenOnClose(window: BrowserWindow): boolean {
  return hiddenOnClose.has(window)
}

/**
 * Hides a window that is being closed, out of full screen first, since macOS would leave its
 * space behind. Its page hears it, and hears again when the window shows.
 */
export function hideOnClose(window: BrowserWindow): void {
  if (hiddenOnClose.has(window)) return
  hiddenOnClose.add(window)
  tell(window, { kind: 'window-hidden' })
  window.once('show', () => {
    hiddenOnClose.delete(window)
    tell(window, { kind: 'window-shown' })
  })
  if (window.isFullScreen()) {
    window.once('leave-full-screen', () => {
      if (hiddenOnClose.has(window)) window.hide()
    })
    window.setFullScreen(false)
  } else {
    window.hide()
  }
}

// events.ts's sendEvent, which imports this module.
function tell(window: BrowserWindow, command: AppCommand): void {
  if (!window.webContents.isDestroyed()) window.webContents.send('app:command', command)
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
