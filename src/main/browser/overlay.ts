// The overlay over the shown page while a turn uses it: a transparent view of the app's own page,
// stacked over the page's view. While the agent has the page it covers all of it, so the user's
// clicks and keys stop there and only the wheel goes through; while the user has it, it covers
// only the pill. Its page talks to main over its own channel and may call nothing else.

import { join } from 'node:path'
import { View, WebContentsView, type BrowserWindow, type Input, type Rectangle } from 'electron'
import {
  OVERLAY_CHANNELS,
  OVERLAY_PILL_BOTTOM,
  OVERLAY_PILL_ROOM,
  parseOverlayRequest,
  type ControlOverlayEvent,
  type ControlOverlayRequest,
  type ControlOverlayState,
} from '@shared/control'
import type { SettingsFile } from '@shared/settings'
import type { ThemesState } from '@shared/themes'
import { createLogger } from '../log'
import { overlayEntry } from '../renderer'
import { markOverlay } from '../window'

const log = createLogger('browser')

/** The pill's box before its page reports it. */
const PILL_DEFAULT = { width: 360, height: 60 }

export interface PageOverlayDeps {
  window(): BrowserWindow | null
  /** The system's language, which the page reads as the window's does. */
  systemLocale: string
  settings(): SettingsFile
  themes(): ThemesState
  /** The app's zoom, which the overlay's page takes as the window's does. */
  zoom(): number
  /** The overlay's page asked for something on the page it covers. */
  request(sessionId: string, request: ControlOverlayRequest): void
  /** A key typed in the overlay; true when it was the app's and went to the window. */
  key(sessionId: string, input: Input): boolean
}

/** The views the overlay sits over: the page's own, and the frame around it on macOS. */
export interface OverlayParent {
  sessionId: string
  /** The page's own contents. */
  contents: Electron.WebContents
  /** The view it is added to, after the page so it stacks above. */
  parent: View
  /** The page's box in `parent`'s coordinates. */
  bounds: Rectangle
  /** Whether `parent` clips the corners, so the overlay needs no radius of its own. */
  framed: boolean
  radius: number
}

export class PageOverlay {
  private view: WebContentsView | null = null
  private ready = false
  private queued: ControlOverlayEvent[] = []
  private at: OverlayParent | null = null
  private state: ControlOverlayState | null = null
  private pill = PILL_DEFAULT

  constructor(private readonly deps: PageOverlayDeps) {}

  /** The session whose page it covers now, or null while it covers none. */
  get sessionId(): string | null {
    return this.at?.sessionId ?? null
  }

  /** Covers `at`'s page with `state`, making the overlay's view the first time. */
  show(at: OverlayParent, look: Omit<ControlOverlayState, 'width'>): void {
    const view = this.view ?? this.create()
    const state = { ...look, width: this.widthOf(at) }
    // A page made again sits above it, so it is added again over the new one.
    const moved = this.at?.parent !== at.parent || this.at?.contents !== at.contents
    if (moved) {
      if (this.at && this.at.parent !== at.parent) this.at.parent.removeChildView(view)
      at.parent.addChildView(view)
    }
    const covered = this.state?.layout === 'full'
    this.at = at
    this.state = state
    this.place()
    this.send({ type: 'state', state })
    // The keys a focused page would take go to the overlay, which holds them back.
    if (state.layout === 'full' && !covered && at.contents.isFocused()) {
      view.webContents.focus()
    }
  }

  /** The page moved or resized under it. */
  move(at: OverlayParent): void {
    if (this.at?.contents !== at.contents || this.at.parent !== at.parent) return
    this.at = at
    this.place()
    const width = this.widthOf(at)
    if (this.state && this.state.width !== width) {
      this.state = { ...this.state, width }
      this.send({ type: 'state', state: this.state })
    }
  }

  /** Takes the overlay off the page; it may be shown again. */
  hide(): void {
    if (!this.view || !this.at) return
    this.at.parent.removeChildView(this.view)
    this.at = null
    this.state = null
  }

  send(event: ControlOverlayEvent): void {
    if (!this.view) return
    if (!this.ready) {
      // Only the latest state matters before the page can take it.
      if (event.type === 'state') this.queued = this.queued.filter((e) => e.type !== 'state')
      this.queued.push(event)
      return
    }
    const contents = this.view.webContents
    if (!contents.isDestroyed()) contents.send(OVERLAY_CHANNELS.event, event)
  }

  /** The settings or the themes changed: the overlay's page follows, as the window does. */
  lookChanged(): void {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return
    contents.send(OVERLAY_CHANNELS.settingsChanged, this.deps.settings())
    contents.send(OVERLAY_CHANNELS.themesChanged, this.deps.themes())
    contents.setZoomFactor(this.deps.zoom())
  }

  /** Whether `contents` is the overlay's page. */
  owns(contents: Electron.WebContents): boolean {
    return this.view?.webContents === contents
  }

  destroy(): void {
    const view = this.view
    if (!view) return
    this.hide()
    this.view = null
    this.ready = false
    this.queued = []
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private create(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        additionalArguments: [`--kettu-system-locale=${this.deps.systemLocale}`],
      },
    })
    view.setBackgroundColor('#00000000')
    markOverlay(view.webContents)
    this.view = view
    this.ready = false
    const contents = view.webContents
    contents.on('did-navigate', () => contents.setZoomFactor(this.deps.zoom()))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('render-process-gone', (_event, details) => {
      log.warn(`The page overlay's renderer is gone: ${details.reason}`)
      if (this.view === view) this.destroy()
    })
    contents.on('before-input-event', (event, input) => {
      const sessionId = this.at?.sessionId
      if (sessionId && this.deps.key(sessionId, input)) event.preventDefault()
    })
    const ownFrame = (frame: Electron.WebFrameMain | null): boolean =>
      frame !== null && frame === contents.mainFrame && frame.url === overlayEntry().url
    contents.ipc.handle(OVERLAY_CHANNELS.settings, (event) => {
      if (!ownFrame(event.senderFrame)) throw new Error('Not the overlay')
      return this.deps.settings()
    })
    contents.ipc.handle(OVERLAY_CHANNELS.themes, (event) => {
      if (!ownFrame(event.senderFrame)) throw new Error('Not the overlay')
      return this.deps.themes()
    })
    contents.ipc.on(OVERLAY_CHANNELS.request, (event, value: unknown) => {
      if (!ownFrame(event.senderFrame)) return
      const request = parseOverlayRequest(value)
      if (!request) {
        log.warn('Ignored a malformed request from the page overlay')
        return
      }
      if (request.type === 'ready') {
        this.ready = true
        const queued = this.queued
        this.queued = []
        for (const item of queued) this.send(item)
        return
      }
      if (request.type === 'pill') {
        this.pill = { width: request.width, height: request.height }
        this.place()
        return
      }
      const sessionId = this.at?.sessionId
      if (sessionId) this.deps.request(sessionId, request)
    })
    const entry = overlayEntry()
    const load =
      entry.kind === 'dev-server' ? contents.loadURL(entry.url) : contents.loadFile(entry.path)
    load.catch((error: unknown) => {
      log.warn(`Could not load the page overlay: ${(error as Error).message}`)
    })
    return view
  }

  /** The page's width in the overlay's CSS pixels. */
  private widthOf(at: OverlayParent): number {
    return Math.round(at.bounds.width / this.deps.zoom())
  }

  /** Over the whole page, or over the pill alone at the page's bottom. */
  private place(): void {
    const view = this.view
    const at = this.at
    if (!view || !at || !this.state) return
    const { bounds } = at
    if (this.state.layout === 'full') {
      view.setBounds(bounds)
      view.setBorderRadius(at.framed ? 0 : at.radius)
      return
    }
    const zoom = this.deps.zoom()
    const width = Math.min(bounds.width, Math.ceil(this.pill.width * zoom))
    const height = Math.min(bounds.height, Math.ceil(this.pill.height * zoom))
    view.setBorderRadius(0)
    view.setBounds({
      x: Math.round(bounds.x + (bounds.width - width) / 2),
      y: Math.round(
        bounds.y + bounds.height - height - (OVERLAY_PILL_BOTTOM - OVERLAY_PILL_ROOM) * zoom,
      ),
      width,
      height,
    })
  }
}
