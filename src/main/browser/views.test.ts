import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_SIZES, SIZE_LINE_ROOM, type BrowserBounds, type BrowserState } from '@shared/browser'
import { IDLE_CONTROL, type SurfaceControl } from '@shared/control'

interface SentCommand {
  method: string
  params: Record<string, unknown>
}

class FakeDebugger extends EventEmitter {
  private attached = false
  readonly commands: SentCommand[] = []

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push({ method, params })
    return {}
  }
}

let nextContentsId = 1

class FakeWebContents extends EventEmitter {
  readonly id = nextContentsId++
  readonly debugger = new FakeDebugger()
  readonly mainFrame = { id: 1 }
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => {},
    goForward: () => {},
    getActiveIndex: () => 0,
    getEntryAtIndex: () => undefined,
  }
  private url = ''
  private title = ''
  private destroyed = false
  private zoomFactor = 1

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isCrashed(): boolean {
    return false
  }

  getZoomFactor(): number {
    return this.zoomFactor
  }

  setBackgroundThrottling(): void {}
  setWindowOpenHandler(): void {}
  stop(): void {}
  reload(): void {}

  async loadURL(url: string): Promise<void> {
    this.url = url
    this.emit('did-start-loading')
    this.emit('frame-created', {}, { frame: this.mainFrame })
    this.emit('did-navigate', {}, url, 200)
    this.title = 'Loaded'
    this.emit('did-stop-loading')
  }

  close(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents()
  bounds: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  }
  radius = 0
  visible = false

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = { ...bounds }
  }

  setBorderRadius(radius: number): void {
    this.radius = radius
  }

  setVisible(visible: boolean): void {
    this.visible = visible
  }
}

const createdViews: FakeWebContentsView[] = []

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: {
    fromPartition: () => ({
      getUserAgent: () => 'Mozilla/5.0 Electron/44.0.0 Chrome/152.0.0.0',
      setUserAgent: () => {},
      webRequest: { onBeforeSendHeaders: () => {}, onBeforeRequest: () => {} },
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      setDevicePermissionHandler: () => {},
      on: () => {},
      clearStorageData: async () => {},
      clearCache: async () => {},
    }),
  },
  shell: { openExternal: vi.fn() },
  WebContentsView: class extends FakeWebContentsView {
    constructor() {
      super()
      createdViews.push(this)
    }
  },
}))

vi.mock('./overlay', () => ({
  PageOverlay: class {
    sessionId: string | null = null
    show(): void {}
    move(): void {}
    covers(): boolean {
      return false
    }
    async showStill(): Promise<boolean> {
      return false
    }
    dropStill(): void {}
    hide(): void {}
    send(): void {}
    lookChanged(): void {}
    destroy(): void {}
  },
}))

vi.mock('./policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./policy')>()
  return {
    ...actual,
    BrowserPolicy: class {
      install(): void {}
      setServicePort(): void {}
    },
  }
})

vi.mock('../events', () => ({ sendEvent: vi.fn() }))
vi.mock('../log', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

if (!process.versions.chrome) {
  Object.defineProperty(process.versions, 'chrome', { value: '152.0.0.0', configurable: true })
}

const { BrowserViews } = await import('./views')

const TALL_PANE: BrowserBounds = { x: 400, y: 64, width: 780, height: 920, radius: 10 }
const WIDE_PANE: BrowserBounds = { x: 200, y: 64, width: 1440, height: 900, radius: 10 }

function makeHarness() {
  const states: BrowserState[] = []
  let currentControl: SurfaceControl = IDLE_CONTROL
  const fakeWindow = {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { focus: vi.fn() },
  }
  const views = new BrowserViews({
    window: () => fakeWindow as never,
    send: (state) => states.push(state),
    control: () => currentControl,
    settings: () => ({ appearance: { zoom: 1 } }) as never,
    themes: () => ({}) as never,
    origins: {
      read: () => ({}),
      write: async () => {},
    } as never,
  })
  const setControl = (next: SurfaceControl) => {
    currentControl = next
    views.controlChanged('s1')
  }
  const latestState = () => states.at(-1)
  return { views, states, latestState, setControl }
}

function metricsCommands(view: FakeWebContentsView): SentCommand[] {
  return view.webContents.debugger.commands.filter(
    (c) =>
      c.method === 'Emulation.setDeviceMetricsOverride' ||
      c.method === 'Emulation.clearDeviceMetricsOverride' ||
      c.method === 'Emulation.setTouchEmulationEnabled' ||
      c.method === 'Emulation.setUserAgentOverride',
  )
}

beforeEach(() => {
  createdViews.length = 0
})

describe('BrowserViews desktop full-height layout & viewport modes (#2764)', () => {
  it('fills full height of a tall narrow pane (780x920) with zero bottom gap in desktop mode', async () => {
    const { views, latestState } = makeHarness()
    views.show('s1')
    views.setBounds('s1', TALL_PANE)

    const result = await views.load('s1', 'http://localhost:3000/')
    expect(result.ok).toBe(true)

    const view = createdViews.at(-1)!
    // Native WebContentsView covers the exact full pane bounds (zero bottom empty strip).
    expect(view.bounds).toEqual({ x: 400, y: 64, width: 780, height: 920 })

    // Logical viewport is 1280 wide with height expanded to ~1510 so it fills all 920px height.
    const expectedHeight = Math.round(920 / (780 / 1280))
    expect(expectedHeight).toBe(1510)
    expect(latestState()?.viewport).toEqual({
      name: 'desktop',
      width: 1280,
      height: expectedHeight,
      mobile: false,
    })

    // Chromium 152 frame-created re-sends afresh (clear + set) with the dynamic desktop height.
    const cmds = metricsCommands(view)
    const lastSet = cmds.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride').at(-1)
    expect(lastSet?.params).toMatchObject({
      width: 1280,
      height: expectedHeight,
      mobile: false,
      scale: 780 / 1280,
      dontSetVisibleSize: true,
    })
    expect(cmds.some((c) => c.method === 'Emulation.clearDeviceMetricsOverride')).toBe(true)

    // Mouse pointScale matches exact view scale.
    const tabId = views.agentTab('s1')!
    expect(await views.pointScale(tabId)).toBeCloseTo(780 / 1280, 6)
  })

  it('fills a wide pane (1440x900) natively when idle, and freezes via emulation during an active agent turn', async () => {
    const { views, latestState, setControl } = makeHarness()
    views.show('s1')
    views.setBounds('s1', WIDE_PANE)

    await views.load('s1', 'http://localhost:3000/')
    const view = createdViews.at(-1)!
    const tabId = views.agentTab('s1')!

    expect(view.bounds).toEqual({ x: 200, y: 64, width: 1440, height: 900 })
    expect(latestState()?.viewport).toEqual({
      name: 'desktop',
      width: 1440,
      height: 900,
      mobile: false,
    })
    // Wide idle desktop fills natively without CDP metrics override.
    expect(
      metricsCommands(view).filter((c) => c.method === 'Emulation.setDeviceMetricsOverride'),
    ).toHaveLength(0)
    expect(await views.pointScale(tabId)).toBe(1)

    // Agent takes control: freezes 1440x900 via override so mid-turn panel shrinking never reflows.
    setControl({ kind: 'agent', acting: true })
    const frozenSet = metricsCommands(view)
      .filter((c) => c.method === 'Emulation.setDeviceMetricsOverride')
      .at(-1)
    expect(frozenSet?.params).toMatchObject({ width: 1440, height: 900, scale: 1 })

    // User shrinks side panel mid-turn to 780x920: logical width/height stay frozen at 1440x900!
    views.setBounds('s1', TALL_PANE)
    expect(latestState()?.viewport).toEqual({
      name: 'desktop',
      width: 1440,
      height: 900,
      mobile: false,
    })
    const midTurnSet = metricsCommands(view)
      .filter((c) => c.method === 'Emulation.setDeviceMetricsOverride')
      .at(-1)
    expect(midTurnSet?.params).toMatchObject({
      width: 1440,
      height: 900,
      scale: 780 / 1440,
    })
    expect(await views.pointScale(tabId)).toBeCloseTo(780 / 1440, 6)

    // Agent releases control: immediately unfreezes and fills the full 780x920 height at 1280x1510.
    setControl(IDLE_CONTROL)
    expect(latestState()?.viewport).toEqual({
      name: 'desktop',
      width: 1280,
      height: 1510,
      mobile: false,
    })
    expect(view.bounds).toEqual({ x: 400, y: 64, width: 780, height: 920 })
    expect(await views.pointScale(tabId)).toBeCloseTo(780 / 1280, 6)
  })

  it('freezes resolved narrow-pane desktop dimensions during an active agent turn and re-fits on release', async () => {
    const { views, latestState, setControl } = makeHarness()
    views.show('s1')
    views.setBounds('s1', TALL_PANE)

    setControl({ kind: 'agent', acting: true })
    await views.load('s1', 'http://localhost:3000/')
    const view = createdViews.at(-1)!
    const tabId = views.agentTab('s1')!

    expect(latestState()?.viewport).toEqual({
      name: 'desktop',
      width: 1280,
      height: 1510,
      mobile: false,
    })
    expect(view.bounds).toEqual({ x: 400, y: 64, width: 780, height: 920 })

    // Resizing sidebar narrower mid-turn keeps logical 1280x1510 frozen (no reflow).
    views.setBounds('s1', { x: 400, y: 64, width: 600, height: 920, radius: 10 })
    expect(latestState()?.viewport).toEqual({
      name: 'desktop',
      width: 1280,
      height: 1510,
      mobile: false,
    })
    const midSet = metricsCommands(view)
      .filter((c) => c.method === 'Emulation.setDeviceMetricsOverride')
      .at(-1)
    expect(midSet?.params).toMatchObject({
      width: 1280,
      height: 1510,
      scale: 600 / 1280,
    })
    expect(view.bounds).toEqual({
      x: 400,
      y: 64,
      width: 600,
      height: Math.round(1510 * (600 / 1280)),
    })
    expect(await views.pointScale(tabId)).toBeCloseTo(600 / 1280, 6)

    // Turn ends: unfreezes and stretches seamlessly to fill all 600x920 pixels.
    setControl(IDLE_CONTROL)
    const refitHeight = Math.round(920 / (600 / 1280))
    expect(latestState()?.viewport).toEqual({
      name: 'desktop',
      width: 1280,
      height: refitHeight,
      mobile: false,
    })
    expect(view.bounds).toEqual({ x: 400, y: 64, width: 600, height: 920 })
  })

  it('locks to the first real pane frame when an agent turn starts before the side panel mounts', async () => {
    const { views, latestState, setControl } = makeHarness()

    // Agent navigates while the browser side panel has not mounted yet (framed === false).
    setControl({ kind: 'agent', acting: true })
    await views.load('s1', 'http://localhost:3000/')
    const view = createdViews.at(-1)!

    // Side panel mounts and reports its real bounds for the first time.
    views.show('s1')
    views.setBounds('s1', TALL_PANE)

    expect(latestState()?.viewport).toEqual({
      name: 'desktop',
      width: 1280,
      height: 1510,
      mobile: false,
    })
    expect(view.bounds).toEqual({ x: 400, y: 64, width: 780, height: 920 })

    // Subsequent mid-turn resizes stay frozen at 1280x1510.
    views.setBounds('s1', { x: 400, y: 64, width: 600, height: 920, radius: 10 })
    expect(latestState()?.viewport).toEqual({
      name: 'desktop',
      width: 1280,
      height: 1510,
      mobile: false,
    })
  })

  it('preserves exact fixed dimensions and centered framing for tablet, phone, and custom browser_resize', async () => {
    const { views, latestState } = makeHarness()
    views.show('s1')
    views.setBounds('s1', TALL_PANE)
    await views.load('s1', 'http://localhost:3000/')
    const view = createdViews.at(-1)!
    const tabId = views.agentTab('s1')!

    // Switch to Phone via Page size menu.
    await views.setPageSize('s1', 'phone')
    expect(latestState()?.viewport).toEqual(PAGE_SIZES.phone)
    expect(view.bounds).toEqual({
      x: 400 + Math.floor((780 - 390) / 2),
      y: 64,
      width: 390,
      height: 844,
    })
    expect(
      metricsCommands(view).some(
        (c) => c.method === 'Emulation.setTouchEmulationEnabled' && c.params.enabled === true,
      ),
    ).toBe(true)

    // Switch to Tablet via Page size menu: reserves SIZE_LINE_ROOM below and centers.
    await views.setPageSize('s1', 'tablet')
    expect(latestState()?.viewport).toEqual(PAGE_SIZES.tablet)
    expect(view.bounds.height).toBe(920 - SIZE_LINE_ROOM)
    expect(view.bounds.x).toBeGreaterThan(400)

    // Custom browser_resize preserves exact dimensions and desktop UA/touch off.
    const custom = await views.resizeAgentTab(tabId, {
      name: 'custom',
      width: 1024,
      height: 768,
      mobile: false,
    })
    expect(custom).toEqual({ name: 'custom', width: 1024, height: 768, mobile: false })
    expect(latestState()?.viewport).toEqual(custom)
    expect(view.bounds).toEqual({
      x: 400,
      y: 64,
      width: 780,
      height: Math.round(768 * (780 / 1024)),
    })

    // Switching back to desktop via browser_resize returns the resolved full-height desktop size.
    const backDesktop = await views.resizeAgentTab(tabId, PAGE_SIZES.desktop)
    expect(backDesktop).toEqual({ name: 'desktop', width: 1280, height: 1510, mobile: false })
    expect(view.bounds).toEqual({ x: 400, y: 64, width: 780, height: 920 })
  })

  it('clears emulation cleanly (viewport === null, 100% scale) when switching to Fill pane', async () => {
    const { views, latestState } = makeHarness()
    views.show('s1')
    views.setBounds('s1', TALL_PANE)
    await views.load('s1', 'http://localhost:3000/')
    const view = createdViews.at(-1)!
    const tabId = views.agentTab('s1')!

    // Move to Phone first to ensure touch + UA overrides are also cleared when entering Fill pane.
    await views.setPageSize('s1', 'phone')
    const countBefore = view.webContents.debugger.commands.length

    await views.setPageSize('s1', 'fit')
    expect(latestState()?.viewport).toBeNull()
    expect(view.bounds).toEqual({ x: 400, y: 64, width: 780, height: 920 })
    expect(await views.pointScale(tabId)).toBe(1)

    const after = view.webContents.debugger.commands.slice(countBefore)
    expect(after.some((c) => c.method === 'Emulation.clearDeviceMetricsOverride')).toBe(true)
    expect(
      after.some(
        (c) => c.method === 'Emulation.setTouchEmulationEnabled' && c.params.enabled === false,
      ),
    ).toBe(true)
    expect(
      after.some((c) => c.method === 'Emulation.setUserAgentOverride' && c.params.userAgent === ''),
    ).toBe(true)

    // User can seamlessly switch back to Desktop from Fill pane.
    await views.setPageSize('s1', 'desktop')
    expect(latestState()?.viewport).toEqual({
      name: 'desktop',
      width: 1280,
      height: 1510,
      mobile: false,
    })
    expect(view.bounds).toEqual({ x: 400, y: 64, width: 780, height: 920 })
  })
})
