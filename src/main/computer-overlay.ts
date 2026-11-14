// Computer use while Kettu is in the background: a label floats at the top of the screen with
// Take over, Stop and Hand back, and the light and the agent's pointer are drawn around the real
// window in a transparent window that lets every click through, placed just above that window so
// windows over it cover the light too. Both go when one of Kettu's windows comes to the front.
// The stop shortcut works from anywhere while a session holds the computer.

import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  type IpcMainEvent,
  type Rectangle,
  type WebContents,
} from 'electron'
import {
  isComputerOverlayAction,
  OVERLAY_CHANNELS,
  type ComputerOverlayAction,
  type ComputerOverlayPart,
  type ComputerOverlayState,
} from '@shared/computer-overlay'
import { defaultStopShortcut, type ComputerFrame, type ComputerHold } from '@shared/computer-use'
import type { Locale } from '@shared/locale'
import { createLogger } from './log'
import { loadRenderer, rendererPage } from './renderer'
import { appFocused, createOverlayWindow } from './window'

const log = createLogger('computer-overlay')

/** How often the real window's place is read while the light follows it. */
const FOLLOW_MS = 300
/** Room around the real window for the light, which reaches past its edges. */
const LIGHT_PAD = 96
/** The label's distance from the top of the screen's work area. */
const LABEL_TOP = 6
/** A window this close to its screen's work area fills it, and takes the light inside. */
const FILL_SLACK = 2
const MAX_LABEL = { width: 960, height: 120 }

export interface ComputerOverlayDeps {
  control(sessionId: string, action: ComputerOverlayAction): void
  frame(): Promise<ComputerFrame | null>
  appIcon(path: string): Promise<string | null>
  /** The settings the pages follow, read whenever they are sent. */
  look(): { shortcut: string; dark: boolean; reduceMotion: boolean; locale: Locale }
  systemLocale: Locale
}

interface Page {
  window: BrowserWindow
  part: ComputerOverlayPart
  loaded: boolean
}

/** An accelerator that is empty means the platform's own. */
export function stopAccelerator(shortcut: string, platform: NodeJS.Platform): string {
  return shortcut || defaultStopShortcut(platform)
}

/** Whether `bounds` covers the work area it lies on, as a maximized or full-screen window does. */
export function fillsScreen(bounds: Rectangle, area: Rectangle): boolean {
  return (
    bounds.x <= area.x + FILL_SLACK &&
    bounds.y <= area.y + FILL_SLACK &&
    bounds.x + bounds.width >= area.x + area.width - FILL_SLACK &&
    bounds.y + bounds.height >= area.y + area.height - FILL_SLACK
  )
}

export class ComputerOverlay {
  private hold: ComputerHold | null = null
  private frame: ComputerFrame | null = null
  private label: Page | null = null
  private light: Page | null = null
  private labelSize: { width: number; height: number } | null = null
  private follow: ReturnType<typeof setTimeout> | null = null
  private reading = false
  private icons = new Map<string, string | null>()
  private shortcut: string | null = null
  private syncing: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: ComputerOverlayDeps) {
    ipcMain.on(OVERLAY_CHANNELS.action, (event, action: unknown) => this.onAction(event, action))
    ipcMain.on(OVERLAY_CHANNELS.resize, (event, width: unknown, height: unknown) =>
      this.onResize(event, width, height),
    )
    // Focus moves between windows as a blur then a focus: the next turn sees where it went.
    const later = () => this.syncSoon()
    app.on('browser-window-focus', later)
    app.on('browser-window-blur', later)
    app.on('did-become-active', later)
    app.on('did-resign-active', later)
    app.on('will-quit', () => this.end())
  }

  /** The host's hold changed: what the pages draw follows it. */
  setHold(hold: ComputerHold | null): void {
    const before = this.hold
    this.hold = hold
    if (!hold) {
      this.end()
      return
    }
    if (before?.window?.id !== hold.window?.id || before?.window?.pid !== hold.window?.pid) {
      this.frame = null
    }
    if (hold.appPath && !this.icons.has(hold.appPath)) {
      const path = hold.appPath
      this.icons.set(path, null)
      void this.deps.appIcon(path).then((icon) => {
        this.icons.set(path, icon)
        this.send()
      })
    }
    this.syncShortcut()
    this.sync()
  }

  /** The settings changed: the shortcut and the pages' look follow them. */
  settingsChanged(): void {
    this.syncShortcut()
    this.send()
  }

  /** Whether `contents` is one of the overlay's pages, the only senders of its channels. */
  owns(contents: WebContents): boolean {
    return [this.label, this.light].some(
      (page) => page !== null && !page.window.isDestroyed() && page.window.webContents === contents,
    )
  }

  private syncSoon(): void {
    if (this.syncing) return
    this.syncing = setTimeout(() => {
      this.syncing = null
      this.sync()
    }, 0)
  }

  /** Shows what Kettu in the background shows, and hides it all while Kettu is in front. */
  private sync(): void {
    const hold = this.hold
    const away = hold !== null && !appFocused()
    if (!away) {
      this.hide(this.label)
      this.hide(this.light)
      this.stopFollowing()
      return
    }
    this.label ??= this.create('label')
    this.placeLabel()
    if (hold.window) this.startFollowing()
    else this.stopFollowing()
    this.placeLight()
    this.send()
  }

  private hide(page: Page | null): void {
    if (page && !page.window.isDestroyed() && page.window.isVisible()) page.window.hide()
  }

  /** Everything goes with the hold: the windows, the following and the shortcut. */
  private end(): void {
    this.hold = null
    this.frame = null
    this.labelSize = null
    this.stopFollowing()
    for (const page of [this.label, this.light]) {
      if (page && !page.window.isDestroyed()) page.window.destroy()
    }
    this.label = null
    this.light = null
    this.syncShortcut()
  }

  private startFollowing(): void {
    if (this.follow || this.reading) return
    this.follow = setTimeout(
      () => {
        this.follow = null
        void this.readFrame()
      },
      this.frame ? FOLLOW_MS : 0,
    )
  }

  private stopFollowing(): void {
    if (this.follow) clearTimeout(this.follow)
    this.follow = null
  }

  private async readFrame(): Promise<void> {
    const hold = this.hold
    if (!hold?.window) return
    this.reading = true
    try {
      const frame = await this.deps.frame()
      // A frame read for an earlier window says nothing of this one.
      if (this.hold?.window?.id !== hold.window.id) return
      this.frame = frame
    } finally {
      this.reading = false
    }
    if (this.hold && !appFocused()) {
      this.placeLight()
      this.send()
      this.startFollowing()
    }
  }

  /** The light's window over the real one, or inside its edges when it fills the screen. */
  private placeLight(): void {
    const hold = this.hold
    const frame = this.frame
    if (!hold?.window || !frame?.visible) {
      this.hide(this.light)
      return
    }
    const bounds = toDip(frame.bounds)
    const inside = fillsScreen(bounds, screen.getDisplayMatching(bounds).workArea)
    const pad = inside ? 0 : LIGHT_PAD
    const page = (this.light ??= this.create('light'))
    if (!page.loaded) return
    page.window.setBounds({
      x: Math.round(bounds.x - pad),
      y: Math.round(bounds.y - pad),
      width: Math.round(bounds.width + 2 * pad),
      height: Math.round(bounds.height + 2 * pad),
    })
    if (!page.window.isVisible()) page.window.showInactive()
    try {
      // Just above the real window, so a window over it covers the light as well.
      page.window.moveAbove(`window:${hold.window.id}:0`)
    } catch (error) {
      log.debug(`The light could not go above window ${hold.window.id}: ${String(error)}`)
    }
  }

  /** The label at the top centre of the screen the real window is on. */
  private placeLabel(): void {
    const page = this.label
    const size = this.labelSize
    if (!page || !page.loaded || !size) return
    const bounds = this.frame ? toDip(this.frame.bounds) : null
    const display = bounds
      ? screen.getDisplayMatching(bounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    page.window.setBounds({
      x: Math.round(area.x + (area.width - size.width) / 2),
      y: area.y + LABEL_TOP,
      width: size.width,
      height: size.height,
    })
    if (!page.window.isVisible()) page.window.showInactive()
  }

  private state(part: ComputerOverlayPart): ComputerOverlayState | null {
    const hold = this.hold
    if (!hold) return null
    const look = this.deps.look()
    let frame: ComputerOverlayState['frame'] = null
    if (part === 'light' && this.frame) {
      const bounds = toDip(this.frame.bounds)
      const inside = fillsScreen(bounds, screen.getDisplayMatching(bounds).workArea)
      frame = { width: bounds.width, height: bounds.height, pad: inside ? 0 : LIGHT_PAD, inside }
    }
    return {
      agentId: hold.agentId,
      agentName: hold.agentName,
      app: hold.app,
      appIcon: hold.appPath ? (this.icons.get(hold.appPath) ?? null) : null,
      control: hold.control,
      act: hold.act,
      shortcut: stopAccelerator(look.shortcut, process.platform),
      dark: look.dark,
      reduceMotion: look.reduceMotion,
      locale: look.locale,
      frame,
    }
  }

  private send(): void {
    for (const page of [this.label, this.light]) {
      if (!page || !page.loaded || page.window.isDestroyed()) continue
      const state = this.state(page.part)
      if (state) page.window.webContents.send(OVERLAY_CHANNELS.state, state)
    }
  }

  private create(part: ComputerOverlayPart): Page {
    const mac = process.platform === 'darwin'
    const window = createOverlayWindow({
      width: part === 'label' ? 480 : 400,
      height: part === 'label' ? 64 : 300,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Neither takes the focus from the app the user is in; the label still takes clicks.
      focusable: false,
      ...(part === 'label'
        ? { alwaysOnTop: true, acceptFirstMouse: true, ...(mac ? { type: 'panel' } : {}) }
        : { enableLargerThanScreen: true, roundedCorners: false }),
      webPreferences: {
        preload: join(__dirname, '../preload/computer-overlay.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: [
          `--kettu-system-locale=${this.deps.systemLocale}`,
          `--kettu-overlay-part=${part}`,
        ],
      },
    })
    const page: Page = { window, part, loaded: false }
    if (part === 'light') window.setIgnoreMouseEvents(true)
    else window.setAlwaysOnTop(true, 'floating')
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      if (rendererPage(url) !== 'computer-overlay') event.preventDefault()
    })
    window.webContents.on('did-finish-load', () => {
      page.loaded = true
      this.sync()
    })
    window.webContents.on('render-process-gone', () => {
      if (!window.isDestroyed()) window.destroy()
    })
    window.on('closed', () => {
      if (this.label === page) {
        this.label = null
        this.labelSize = null
      }
      if (this.light === page) this.light = null
    })
    void loadRenderer(window, 'computer-overlay', part).catch((error: unknown) =>
      log.error(`Could not load the ${part} page`, error),
    )
    return page
  }

  private sender(event: IpcMainEvent): Page | null {
    if (!this.owns(event.sender)) return null
    return [this.label, this.light].find((page) => page?.window.webContents === event.sender)!
  }

  private onAction(event: IpcMainEvent, action: unknown): void {
    const page = this.sender(event)
    const hold = this.hold
    if (page?.part !== 'label' || !hold || !isComputerOverlayAction(action)) return
    this.deps.control(hold.sessionId, action)
  }

  private onResize(event: IpcMainEvent, width: unknown, height: unknown): void {
    const page = this.sender(event)
    if (page?.part !== 'label' || typeof width !== 'number' || typeof height !== 'number') return
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    this.labelSize = {
      width: Math.ceil(Math.min(Math.max(width, 1), MAX_LABEL.width)),
      height: Math.ceil(Math.min(Math.max(height, 1), MAX_LABEL.height)),
    }
    if (this.hold && !appFocused()) this.placeLabel()
  }

  /** The stop shortcut, registered while a session holds the computer and only then. */
  private syncShortcut(): void {
    const wanted = this.hold ? stopAccelerator(this.deps.look().shortcut, process.platform) : null
    if (wanted === this.shortcut) return
    if (this.shortcut) globalShortcut.unregister(this.shortcut)
    this.shortcut = null
    if (!wanted) return
    try {
      if (globalShortcut.register(wanted, () => this.stopFromShortcut())) this.shortcut = wanted
      else log.warn(`Another app has the stop shortcut ${wanted}`)
    } catch (error) {
      log.warn(`Could not register the stop shortcut ${wanted}: ${String(error)}`)
    }
  }

  private stopFromShortcut(): void {
    const hold = this.hold
    if (hold) this.deps.control(hold.sessionId, 'stop')
  }
}

/** The driver's screen points as Electron's: Windows reports physical pixels. */
function toDip(bounds: ComputerFrame['bounds']): Rectangle {
  const rect = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  }
  return process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect
}
