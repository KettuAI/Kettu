// Keeps a lightweight hidden BaseWindow alive on Windows when all visible windows close into the
// tray, so Electron can still receive WM_ENDSESSION (`session-end`) during OS shutdown or logout.

import { BaseWindow } from 'electron'

export interface SessionEndWindow {
  once(event: 'session-end' | 'closed', listener: () => void): unknown
  isDestroyed(): boolean
  destroy(): void
}

export interface WindowsSessionEndWatcherOptions {
  platform?: NodeJS.Platform
  onSessionEnd: () => void
  createWindow?: () => SessionEndWindow
}

function defaultCreateWindow(): SessionEndWindow {
  return new BaseWindow({
    show: false,
    skipTaskbar: true,
    focusable: false,
    width: 0,
    height: 0,
  })
}

export class WindowsSessionEndWatcher {
  private readonly platform: NodeJS.Platform
  private readonly createWindow: () => SessionEndWindow
  private hiddenWindow: SessionEndWindow | null = null
  private stopped = false

  constructor(private readonly options: WindowsSessionEndWatcherOptions) {
    this.platform = options.platform ?? process.platform
    this.createWindow = options.createWindow ?? defaultCreateWindow
  }

  /** Creates the hidden window if needed so Windows can deliver `session-end` while tray-only. */
  ensureHiddenWatcher(): void {
    if (this.platform !== 'win32' || this.stopped) return
    if (this.hiddenWindow && !this.hiddenWindow.isDestroyed()) return
    const win = this.createWindow()
    this.hiddenWindow = win
    win.once('session-end', () => {
      this.stopped = true
      this.options.onSessionEnd()
    })
    win.once('closed', () => {
      if (this.hiddenWindow === win) this.hiddenWindow = null
    })
  }

  /** Destroys the hidden window while a real app window is open. */
  dispose(): void {
    const win = this.hiddenWindow
    this.hiddenWindow = null
    if (win && !win.isDestroyed()) win.destroy()
  }

  /** Permanently stops watching once the app is quitting or the OS session is ending. */
  stop(): void {
    this.stopped = true
    this.dispose()
  }
}
