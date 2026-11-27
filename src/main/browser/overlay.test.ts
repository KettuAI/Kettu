import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlOverlayEvent, ControlOverlayState } from '@shared/control'

class FakeOverlayWebContents extends EventEmitter {
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  readonly ipc = {
    handle: vi.fn(),
    on: (channel: string, listener: (event: unknown, value: unknown) => void) => {
      this.ipcListeners.set(channel, listener)
    },
  }
  readonly mainFrame = { url: 'http://localhost:5173/overlay.html' }
  private readonly ipcListeners = new Map<string, (event: unknown, value: unknown) => void>()
  private destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  setZoomFactor(): void {}
  setWindowOpenHandler(): void {}
  async loadURL(): Promise<void> {}
  async loadFile(): Promise<void> {}
  focus(): void {}

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }

  emitIpc(channel: string, value: unknown): void {
    this.ipcListeners.get(channel)?.({ senderFrame: this.mainFrame }, value)
  }

  close(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

class FakeOverlayView {
  readonly webContents = new FakeOverlayWebContents()
  bounds: Electron.Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  radius = 0
  setBackgroundColor(): void {}
  setBounds(bounds: Electron.Rectangle): void {
    this.bounds = { ...bounds }
  }
  setBorderRadius(radius: number): void {
    this.radius = radius
  }
}

const createdOverlayViews: FakeOverlayView[] = []

vi.mock('electron', () => ({
  View: class {},
  WebContentsView: class extends FakeOverlayView {
    constructor() {
      super()
      createdOverlayViews.push(this)
    }
  },
}))

vi.mock('../log', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

vi.mock('../renderer', () => ({
  overlayEntry: () => ({ kind: 'dev-server', url: 'http://localhost:5173/overlay.html' }),
}))

vi.mock('../window', () => ({
  markOverlay: vi.fn(),
}))

const { PageOverlay, isOutsideBounds } = await import('./overlay')

class FakeHostWebContents extends EventEmitter {
  private destroyed = false
  private zoomFactor = 1

  isDestroyed(): boolean {
    return this.destroyed
  }

  getZoomFactor(): number {
    return this.zoomFactor
  }

  setZoom(factor: number): void {
    this.zoomFactor = factor
  }
}

class FakeHostWindow extends EventEmitter {
  readonly webContents = new FakeHostWebContents()
  private destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }
}

function setup() {
  const hostWindow = new FakeHostWindow()
  const parent = {
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  }
  const pageContents = {
    isFocused: () => false,
  }
  const overlay = new PageOverlay({
    window: () => hostWindow as never,
    systemLocale: 'en',
    settings: () => ({ appearance: { zoom: 1 } }) as never,
    themes: () => ({}) as never,
    zoom: () => 1,
    request: vi.fn(),
    key: () => false,
  })
  const at = {
    sessionId: 's1',
    contents: pageContents as never,
    parent: parent as never,
    bounds: { x: 600, y: 80, width: 600, height: 700 },
    radius: 8,
  }
  const agentLook: Omit<ControlOverlayState, 'width'> = {
    control: { kind: 'agent', acting: true },
    agent: null,
    scope: 'tab',
    layout: 'full',
    radius: 8,
  }
  const markReady = () => {
    const view = createdOverlayViews.at(-1)!
    view.webContents.emitIpc('control-overlay:request', { type: 'ready' })
    return view
  }
  const events = (view: FakeOverlayView): ControlOverlayEvent[] =>
    view.webContents.sent.map((entry) => entry.payload as ControlOverlayEvent)
  return { overlay, hostWindow, at, agentLook, markReady, events }
}

beforeEach(() => {
  createdOverlayViews.length = 0
})

describe('isOutsideBounds', () => {
  it('distinguishes points outside the browser overlay from points inside it', () => {
    const bounds = { x: 600, y: 80, width: 600, height: 700 }
    expect(isOutsideBounds({ x: 200, y: 300 }, bounds)).toBe(true)
    expect(isOutsideBounds({ x: 800, y: 40 }, bounds)).toBe(true)
    expect(isOutsideBounds({ x: 1200, y: 300 }, bounds)).toBe(true)
    expect(isOutsideBounds({ x: 600, y: 80 }, bounds)).toBe(false)
    expect(isOutsideBounds({ x: 900, y: 400 }, bounds)).toBe(false)
  })
})

describe('PageOverlay external dismiss handling (#2927)', () => {
  it('dismisses the held bubble when clicking outside the browser pane in the host window', () => {
    const { overlay, hostWindow, at, agentLook, markReady, events } = setup()
    overlay.show(at, agentLook)
    const view = markReady()
    view.webContents.sent.length = 0

    // Clicking inside the chat thread (left of the browser bounds) dismisses immediately.
    hostWindow.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 240, y: 360 })
    // Clicking the browser toolbar / top bar above the page area also dismisses immediately.
    hostWindow.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 820, y: 32 })
    expect(events(view)).toEqual([{ type: 'dismiss' }, { type: 'dismiss' }])

    // Non-click mouse events (hover / move / wheel) never dismiss.
    view.webContents.sent.length = 0
    hostWindow.webContents.emit('before-mouse-event', {}, { type: 'mouseMove', x: 100, y: 100 })
    expect(events(view)).toEqual([])

    // A click inside the overlay rectangle itself must not self-dismiss the bubble.
    hostWindow.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 820, y: 360 })
    expect(events(view)).toEqual([])
  })

  it('dismisses the held bubble on Escape from host window and on overlay or host blur', () => {
    const { overlay, hostWindow, at, agentLook, markReady, events } = setup()
    overlay.show(at, agentLook)
    const view = markReady()
    view.webContents.sent.length = 0

    const preventDefault = vi.fn()
    hostWindow.webContents.emit(
      'before-input-event',
      { preventDefault },
      { type: 'keyDown', key: 'Escape', isAutoRepeat: false },
    )
    expect(preventDefault).not.toHaveBeenCalled()

    // Non-Escape or auto-repeat keys do not dismiss.
    hostWindow.webContents.emit(
      'before-input-event',
      { preventDefault },
      { type: 'keyDown', key: 'Escape', isAutoRepeat: true },
    )
    hostWindow.webContents.emit(
      'before-input-event',
      { preventDefault },
      { type: 'keyDown', key: 'a', isAutoRepeat: false },
    )

    view.webContents.emit('blur')
    hostWindow.emit('blur')
    expect(events(view)).toEqual([{ type: 'dismiss' }, { type: 'dismiss' }, { type: 'dismiss' }])
  })

  it('detaches host window watchers when leaving full agent mode or hiding the overlay', () => {
    const { overlay, hostWindow, at, agentLook, markReady, events } = setup()
    overlay.show(at, agentLook)
    const view = markReady()

    // Switching to pill layout (user takeover) detaches host watchers.
    overlay.show(at, {
      ...agentLook,
      control: { kind: 'you', since: 1 },
      layout: 'pill',
    })
    view.webContents.sent.length = 0
    expect(hostWindow.webContents.listenerCount('before-mouse-event')).toBe(0)
    expect(hostWindow.webContents.listenerCount('before-input-event')).toBe(0)
    expect(hostWindow.listenerCount('blur')).toBe(0)

    hostWindow.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 100, y: 100 })
    expect(events(view)).toEqual([])

    // Re-entering agent mode re-attaches, and hide() cleans everything up.
    overlay.show(at, agentLook)
    expect(hostWindow.webContents.listenerCount('before-mouse-event')).toBe(1)
    overlay.hide()
    expect(hostWindow.webContents.listenerCount('before-mouse-event')).toBe(0)
    expect(hostWindow.webContents.listenerCount('before-input-event')).toBe(0)
    expect(hostWindow.listenerCount('blur')).toBe(0)
  })
})
