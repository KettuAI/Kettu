// The menu bar panel: the page the tray icon's left click opens on macOS, anchored under the icon
// on the system's popover material, gone as soon as it loses focus.

import { join } from 'node:path'
import { BrowserWindow, screen, type Rectangle, type WebContents } from 'electron'
import type { Locale } from '@shared/locale'
import { TRAY_PANEL_HEIGHT, type TrayTarget } from '@shared/tray'
import { sendCommand } from './events'
import { createLogger } from './log'
import { loadRenderer, rendererPage } from './renderer'
import { markPanel, showMainWindow } from './window'

const log = createLogger('tray-panel')

export const PANEL_WIDTH = 340
// Below the menu bar, and clear of the screen's edges.
const GAP = 6
const MARGIN = 8
// A click on the icon blurs the open panel before the click arrives, so a click this soon after
// the blur closed it leaves it closed instead of opening it again.
const REOPEN_AFTER_BLUR_MS = 300
// How long an opening waits for the page to say its height before it shows anyway.
const SIZE_WAIT_MS = 3000

/**
 * Where the panel goes: centred under the icon, or over it when the icon sits low on its screen,
 * kept inside the work area.
 */
export function panelBounds(icon: Rectangle, height: number, workArea: Rectangle): Rectangle {
  const h = Math.min(height, workArea.height - 2 * MARGIN)
  const left = workArea.x + MARGIN
  const right = workArea.x + workArea.width - MARGIN - PANEL_WIDTH
  const x = Math.round(Math.min(Math.max(icon.x + icon.width / 2 - PANEL_WIDTH / 2, left), right))
  const below = icon.y + icon.height / 2 < workArea.y + workArea.height / 2
  // The menu bar's edge needs no margin: the gap under the icon is the panel's own.
  const top = workArea.y
  const bottom = workArea.y + workArea.height - MARGIN - h
  const y = below ? icon.y + icon.height + GAP : icon.y - GAP - h
  return { x, y: Math.round(Math.min(Math.max(y, top), bottom)), width: PANEL_WIDTH, height: h }
}

/** The page's height, or null for anything but a finite number of pixels. */
export function panelHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(Math.min(Math.max(value, TRAY_PANEL_HEIGHT.min), TRAY_PANEL_HEIGHT.max))
}

/** Brings the main window forward at the panel's target. */
export function openTrayTarget(target: TrayTarget): void {
  switch (target.kind) {
    case 'app':
      showMainWindow()
      return
    case 'new-session':
      sendCommand({ kind: 'new-session' })
      return
    case 'settings':
      sendCommand({ kind: 'open-settings' })
      return
    case 'session':
      sendCommand({ kind: 'open-session', sessionId: target.sessionId })
  }
}

export interface TrayPanelDeps {
  systemLocale: Locale
  /** Brings the main window forward at `target`. */
  open(target: TrayTarget): void
  quit(): void
}

export class TrayPanel {
  private window: BrowserWindow | null = null
  private icon: Rectangle | null = null
  private height: number = TRAY_PANEL_HEIGHT.min
  // The page has said its height once, so it is up and answers 'tray:shown' with it.
  private reported = false
  // The page let an opening run out without saying its height; the next one starts a fresh page.
  private failed = false
  // An opening that waits for the page's height, so it shows the page's new content at its size.
  private pending: ReturnType<typeof setTimeout> | null = null
  private blurredAt = 0

  constructor(private readonly deps: TrayPanelDeps) {}

  /** Whether `sender` is the panel's own page, the only one the tray's calls are taken from. */
  owns(sender: WebContents): boolean {
    return this.window !== null && !this.window.isDestroyed() && sender === this.window.webContents
  }

  toggle(icon: Rectangle): void {
    // A click while an opening waits cancels it, so a slow page never pops up after the user left.
    if (this.pending || this.window?.isVisible()) {
      this.hide()
      return
    }
    if (Date.now() - this.blurredAt < REOPEN_AFTER_BLUR_MS) return
    this.icon = icon
    this.show()
  }

  hide(): void {
    this.stopWaiting()
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) this.window.hide()
  }

  open(target: TrayTarget): void {
    this.hide()
    this.deps.open(target)
  }

  quit(): void {
    this.hide()
    this.deps.quit()
  }

  resize(value: unknown): void {
    const height = panelHeight(value)
    if (height === null) return
    this.height = height
    this.reported = true
    this.failed = false
    if (this.pending || this.window?.isVisible()) this.place()
  }

  private show(): void {
    let window = this.window && !this.window.isDestroyed() ? this.window : null
    // A page that let the last opening run out may be dead, so it makes way for a fresh one.
    if (window && this.failed) {
      window.destroy()
      window = null
    }
    window ??= this.create()
    // A page that never reports, such as one that failed to start, still opens, to be seen.
    this.pending = setTimeout(() => {
      log.warn('The panel did not report its height')
      this.failed = true
      this.place()
    }, SIZE_WAIT_MS)
    if (this.reported) window.webContents.send('tray:shown', null)
  }

  private stopWaiting(): void {
    if (this.pending) clearTimeout(this.pending)
    this.pending = null
  }

  private place(): void {
    this.stopWaiting()
    const window = this.window
    if (!window || window.isDestroyed() || !this.icon) return
    const { workArea } = screen.getDisplayMatching(this.icon)
    window.setBounds(panelBounds(this.icon, this.height, workArea))
    if (!window.isVisible()) {
      window.show()
      window.focus()
    }
  }

  private create(): BrowserWindow {
    this.reported = false
    this.failed = false
    const window = new BrowserWindow({
      width: PANEL_WIDTH,
      height: this.height,
      show: false,
      frame: false,
      // An NSPanel that floats over full-screen apps and takes the keyboard without bringing the
      // app's other windows forward.
      type: 'panel',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      vibrancy: 'popover',
      visualEffectState: 'active',
      roundedCorners: true,
      hasShadow: true,
      webPreferences: {
        preload: join(__dirname, '../preload/tray.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: [`--kettu-system-locale=${this.deps.systemLocale}`],
      },
    })
    markPanel(window)
    window.setAlwaysOnTop(true, 'pop-up-menu')
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    window.on('blur', () => {
      this.blurredAt = Date.now()
      this.hide()
    })
    window.on('closed', () => {
      // A failed window closing after its replacement opened leaves the replacement alone.
      if (this.window !== window) return
      this.window = null
      this.stopWaiting()
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Its own page may reload, as the dev server asks after some changes; it goes nowhere else.
    window.webContents.on('will-navigate', (event, url) => {
      if (rendererPage(url) !== 'tray') event.preventDefault()
    })
    window.webContents.on('render-process-gone', () => window.destroy())
    window.webContents.on('did-fail-load', (_event, code, description) =>
      log.error(`The panel did not load: ${code} ${description}`),
    )
    this.window = window
    void loadRenderer(window, 'tray').catch((error: unknown) =>
      log.error('Could not load the panel', error),
    )
    return window
  }
}
