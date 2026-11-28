import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_SESSION_TABS,
  PAGE_SIZES,
  SIZE_LINE_ROOM,
  type BrowserBounds,
  type BrowserElementAnnotatedEvent,
  type BrowserState,
} from '@shared/browser'
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
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 }
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
  readonly loadUrls: string[] = []
  reloadCount = 0

  getURL(): string {
    return this.url
  }

  setUrl(url: string): void {
    this.url = url
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
  reload(): void {
    this.reloadCount += 1
  }

  async loadURL(url: string): Promise<void> {
    this.loadUrls.push(url)
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

const overlayDismissCalls: number[] = []
const overlaySentEvents: unknown[] = []

vi.mock('./overlay', () => ({
  PageOverlay: class {
    sessionId: string | null = null
    show(at: { sessionId: string }): void {
      this.sessionId = at.sessionId
    }
    move(): void {}
    covers(): boolean {
      return false
    }
    async showStill(): Promise<boolean> {
      return false
    }
    dropStill(): void {}
    hide(): void {
      this.sessionId = null
    }
    dismissBubble(): void {
      overlayDismissCalls.push(Date.now())
    }
    send(event: unknown): void {
      overlaySentEvents.push(event)
    }
    lookChanged(): void {}
    destroy(): void {
      this.sessionId = null
    }
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
const { BrowserTools } = await import('./tools')

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
  overlayDismissCalls.length = 0
  overlaySentEvents.length = 0
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

describe('BrowserViews.openLink session tab reuse and creation (#2858)', () => {
  it('activates an existing tab matching the normalized URL without reloading it', () => {
    const { views, latestState } = makeHarness()
    views.show('s1')
    views.setBounds('s1', WIDE_PANE)

    views.openLink('s1', 'https://example.com/docs/')
    const firstTabId = latestState()!.selected!
    const firstView = createdViews[0]!

    views.openLink('s1', 'https://example.com/other')
    const secondTabId = latestState()!.selected!
    const secondView = createdViews[1]!

    expect(latestState()?.tabs.map((tab) => tab.id)).toEqual([firstTabId, secondTabId])
    expect(firstView.visible).toBe(false)
    expect(secondView.visible).toBe(true)

    // Re-opening via canonical equivalent URLs switches to the first tab without reloading.
    views.openLink('s1', 'HTTPS://EXAMPLE.COM:443/docs#')
    expect(latestState()?.selected).toBe(firstTabId)
    expect(latestState()?.tabs).toHaveLength(2)
    expect(firstView.visible).toBe(true)
    expect(secondView.visible).toBe(false)
    expect(firstView.webContents.loadUrls).toEqual(['https://example.com/docs/'])
    expect(firstView.webContents.reloadCount).toBe(0)

    // Re-opening the already-selected URL is a no-op with zero reload or new tab.
    views.openLink('s1', 'https://example.com/docs')
    expect(latestState()?.selected).toBe(firstTabId)
    expect(latestState()?.tabs).toHaveLength(2)
    expect(firstView.webContents.loadUrls).toEqual(['https://example.com/docs/'])
    expect(firstView.webContents.reloadCount).toBe(0)
  })

  it('opens a new tab instead of overwriting the current tab when the URL does not match', () => {
    const { views, latestState } = makeHarness()
    views.show('s1')
    views.setBounds('s1', WIDE_PANE)

    views.openLink('s1', 'https://example.com/page-a')
    const tabA = latestState()!.selected!
    const viewA = createdViews[0]!

    // Distinct path, query, or non-empty hash each opens its own tab without overwriting tabA.
    views.openLink('s1', 'https://example.com/page-a?tab=2')
    const tabQuery = latestState()!.selected!
    views.openLink('s1', 'https://example.com/page-a#details')
    const tabHash = latestState()!.selected!

    expect(latestState()?.tabs.map((tab) => tab.id)).toEqual([tabA, tabQuery, tabHash])
    expect(latestState()?.tabs.map((tab) => tab.url)).toEqual([
      'https://example.com/page-a',
      'https://example.com/page-a?tab=2',
      'https://example.com/page-a#details',
    ])
    expect(latestState()?.selected).toBe(tabHash)
    expect(viewA.webContents.loadUrls).toEqual(['https://example.com/page-a'])
    expect(viewA.visible).toBe(false)
    expect(createdViews[2]!.visible).toBe(true)
  })

  it('reuses a blank selected user tab without leaving an extra blank tab, and never hijacks an agent tab', () => {
    const { views, latestState, setControl } = makeHarness()
    views.show('s1')
    views.setBounds('s1', WIDE_PANE)

    // Single blank user tab is reused in place.
    const blankId = views.newTab('s1')!
    expect(latestState()?.tabs).toHaveLength(1)
    views.openLink('s1', 'https://example.com/first')
    expect(latestState()?.tabs).toHaveLength(1)
    expect(latestState()?.selected).toBe(blankId)
    expect(latestState()?.url).toBe('https://example.com/first')

    // A user tab currently on about:blank is also reused.
    const aboutBlankId = views.newTab('s1')!
    views.navigate('s1', 'https://example.com/temp')
    const aboutBlankView = createdViews.at(-1)!
    aboutBlankView.webContents.setUrl('about:blank')
    aboutBlankView.webContents.emit('did-navigate', {}, 'about:blank', 200)
    expect(latestState()?.url).toBeNull()

    views.openLink('s1', 'https://example.com/second')
    expect(latestState()?.tabs).toHaveLength(2)
    expect(latestState()?.selected).toBe(aboutBlankId)
    expect(latestState()?.url).toBe('https://example.com/second')

    // An agent's blank tab must not be taken over when the user clicks a link in the thread.
    setControl({ kind: 'agent', acting: true })
    const agentBlankId = views.agentNewTab('s1')!
    views.selectTab('s1', agentBlankId)
    views.openLink('s1', 'https://example.com/user-link')
    expect(latestState()?.tabs).toHaveLength(4)
    expect(latestState()?.selected).not.toBe(agentBlankId)
    expect(latestState()?.agentTab).toBe(agentBlankId)
    expect(latestState()?.url).toBe('https://example.com/user-link')
  })

  it('falls back to navigating an existing tab when MAX_SESSION_TABS is reached, while still activating matches', async () => {
    const { views, latestState, setControl } = makeHarness()
    views.show('s1')
    views.setBounds('s1', WIDE_PANE)

    // Open one agent tab first (localhost skips origin confirmation) and fill up to MAX_SESSION_TABS.
    await views.load('s1', 'http://localhost:3000/agent')
    const agentTabId = views.agentTab('s1')!
    for (let i = 1; i < MAX_SESSION_TABS; i++) {
      views.openLink('s1', `https://example.com/page-${i}`)
    }
    expect(latestState()?.tabs).toHaveLength(MAX_SESSION_TABS)

    // Matching a live existing tab at the cap still activates it without reloading.
    const recentUrl = `https://example.com/page-${MAX_SESSION_TABS - 2}`
    const recentTab = latestState()!.tabs.find((tab) => tab.url === recentUrl)!
    const recentView = createdViews.find(
      (view) => !view.webContents.isDestroyed() && view.webContents.getURL() === recentUrl,
    )!
    expect(recentTab.released).toBe(false)
    views.openLink('s1', `${recentUrl}/`)
    expect(latestState()?.selected).toBe(recentTab.id)
    expect(latestState()?.tabs).toHaveLength(MAX_SESSION_TABS)
    expect(recentView.webContents.loadUrls).toEqual([recentUrl])
    expect(recentView.webContents.reloadCount).toBe(0)

    // Opening a brand-new URL at the cap falls back to navigating the selected user tab.
    views.openLink('s1', 'https://example.com/overflow-1')
    expect(latestState()?.tabs).toHaveLength(MAX_SESSION_TABS)
    expect(latestState()?.selected).toBe(recentTab.id)
    expect(latestState()?.url).toBe('https://example.com/overflow-1')

    // At the cap, if the selected tab is actively driven by the agent, fall back to a non-agent tab.
    setControl({ kind: 'agent', acting: true })
    views.selectTab('s1', agentTabId)
    views.openLink('s1', 'https://example.com/overflow-2')
    expect(latestState()?.tabs).toHaveLength(MAX_SESSION_TABS)
    expect(latestState()?.selected).not.toBe(agentTabId)
    expect(latestState()?.url).toBe('https://example.com/overflow-2')
    expect(latestState()?.tabs.find((tab) => tab.id === agentTabId)?.url).toBe(
      'http://localhost:3000/agent',
    )
  })
})

function makeToolsHarness() {
  const states: BrowserState[] = []
  const opened: string[] = []
  const fakeWindow = {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { focus: vi.fn() },
  }
  const toolsRef: { current: InstanceType<typeof BrowserTools> | null } = { current: null }
  const views = new BrowserViews({
    window: () => fakeWindow as never,
    send: (state) => states.push(state),
    control: (sessionId) => toolsRef.current?.control(sessionId) ?? IDLE_CONTROL,
    isInjecting: (tabId) => toolsRef.current?.isInjecting(tabId) ?? false,
    created: (tabId, contents) => toolsRef.current?.watch(tabId, contents),
    closed: (tabId) => toolsRef.current?.forgetTab(tabId),
    ended: (sessionId) => toolsRef.current?.forget(sessionId),
    agentTabClosed: (sessionId) => toolsRef.current?.agentTabClosed(sessionId),
    panelClosed: (sessionId) => {
      toolsRef.current?.releaseTakeover(sessionId)
    },
    settings: () => ({ appearance: { zoom: 1 } }) as never,
    themes: () => ({}) as never,
    origins: {
      read: () => ({}),
      write: async () => {},
    } as never,
  })
  const tools = new BrowserTools({
    views,
    controlChanged: (sessionId) => views.controlChanged(sessionId),
    opened: (sessionId) => opened.push(sessionId),
    log: vi.fn(),
  })
  toolsRef.current = tools
  views.show('s1')
  views.setBounds('s1', WIDE_PANE)
  const latestState = () => states.at(-1)
  return { views, tools, states, opened, latestState }
}

/** Starts a tool call and waits until it enters SurfaceControls' waiting state (waiting(true)). */
function startWaitingCall(
  tools: InstanceType<typeof BrowserTools>,
  callId: number,
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
) {
  let resolveWaiting!: () => void
  const enteredWait = new Promise<void>((resolve) => {
    resolveWaiting = resolve
  })
  const promise = tools.call(callId, sessionId, tool, args, '', (waiting) => {
    if (waiting) resolveWaiting()
  })
  return { promise, enteredWait }
}

describe('Browser takeover cleanup when closing tabs or the browser panel (#2927)', () => {
  it('immediately ends takeover and notifies the waiting agent when closing the taken-over tab among multiple tabs', async () => {
    const { views, tools, latestState } = makeToolsHarness()

    const nav = await tools.call(1, 's1', 'browser_navigate', { url: 'http://localhost:3000/app' })
    expect('result' in nav).toBe(true)
    const agentTabId = views.agentTab('s1')!

    // User opens an unrelated tab alongside the agent tab and takes over the agent tab.
    const userTabId = views.newTab('s1')!
    tools.takeOver('s1')
    expect(tools.control('s1').kind).toBe('you')
    expect(latestState()?.control.kind).toBe('you')

    // Agent calls another browser tool and waits for hand-back.
    const { promise: waitingCall, enteredWait } = startWaitingCall(
      tools,
      2,
      's1',
      'browser_snapshot',
      {},
    )
    await enteredWait

    // Closing the taken-over agent tab immediately clears control and wakes the waiting agent.
    views.closeTab('s1', agentTabId)
    const answer = await waitingCall

    expect(tools.control('s1')).toEqual(IDLE_CONTROL)
    expect(latestState()?.control).toEqual(IDLE_CONTROL)
    expect(latestState()?.agentTab).toBeNull()
    expect(latestState()?.tabs.map((tab) => tab.id)).toEqual([userTabId])
    expect(answer).toEqual({
      error: {
        code: 'no_page',
        message: expect.stringMatching(/closed/i),
      },
    })
  })

  it('immediately clears takeover without emitting stale control when closing the last tab / browser', async () => {
    const { views, tools, states } = makeToolsHarness()

    await tools.call(1, 's1', 'browser_navigate', { url: 'http://localhost:3000/only' })
    const agentTabId = views.agentTab('s1')!
    tools.takeOver('s1')
    const { promise: waitingAsk, enteredWait } = startWaitingCall(
      tools,
      2,
      's1',
      'browser_ask_user',
      {
        step: 'sign_in',
        reason: 'Sign in to continue',
      },
    )
    await enteredWait

    const beforeClose = states.length
    views.closeTab('s1', agentTabId)
    const answer = await waitingAsk

    const emittedAfterClose = states.slice(beforeClose)
    expect(emittedAfterClose.length).toBeGreaterThan(0)
    // Every state emitted after closing the browser already reflects idle control.
    expect(emittedAfterClose.every((state) => state.control.kind === 'idle')).toBe(true)
    expect(emittedAfterClose.at(-1)?.tabs).toEqual([])
    expect(tools.control('s1')).toEqual(IDLE_CONTROL)
    expect(answer).toEqual({
      error: {
        code: 'no_page',
        message: expect.stringMatching(/closed/i),
      },
    })
  })

  it('releases takeover and wakes waiting calls when closing the browser panel during takeover, without disturbing agent-mode hide', async () => {
    const { views, tools, opened, latestState } = makeToolsHarness()

    await tools.call(1, 's1', 'browser_navigate', { url: 'http://localhost:3000/panel' })
    expect(opened).toEqual(['s1'])

    // Hiding / calling releaseTakeover while the agent (not user) holds control leaves it intact.
    views.releaseTakeover('s1')
    expect(tools.control('s1').kind).toBe('agent')

    // Once the user takes over, closing the browser panel clears takeover and notifies the waiting agent.
    views.show('s1')
    tools.takeOver('s1')
    const { promise: waitingCall, enteredWait } = startWaitingCall(
      tools,
      2,
      's1',
      'browser_snapshot',
      {},
    )
    await enteredWait

    views.releaseTakeover('s1')
    const answer = await waitingCall

    expect(tools.control('s1')).toEqual(IDLE_CONTROL)
    expect(latestState()?.control).toEqual(IDLE_CONTROL)
    expect(answer).toEqual({
      error: {
        code: 'no_page',
        message: expect.stringMatching(/closed/i),
      },
    })
  })

  it('does not restart agent control if the browser panel closes while a call is preparing readyAgentTab', async () => {
    const { views, tools, latestState } = makeToolsHarness()

    await tools.call(1, 's1', 'browser_navigate', { url: 'http://localhost:3000/race' })
    tools.takeOver('s1')

    // Start a call and immediately close the panel before readyAgentTab resolves.
    const racingCall = tools.call(2, 's1', 'browser_snapshot', {})
    views.releaseTakeover('s1')
    const answer = await racingCall

    expect(tools.control('s1')).toEqual(IDLE_CONTROL)
    expect(latestState()?.control).toEqual(IDLE_CONTROL)
    expect(answer).toEqual({
      error: {
        code: 'no_page',
        message: expect.stringMatching(/closed/i),
      },
    })
  })

  it('does not end takeover when closing an unrelated user tab', async () => {
    const { views, tools, latestState } = makeToolsHarness()

    await tools.call(1, 's1', 'browser_navigate', { url: 'http://localhost:3000/agent' })
    const agentTabId = views.agentTab('s1')!
    const unrelatedTabId = views.newTab('s1')!

    tools.takeOver('s1')
    const { promise: waitingCall, enteredWait } = startWaitingCall(
      tools,
      2,
      's1',
      'browser_snapshot',
      {},
    )
    await enteredWait
    let settled = false
    void waitingCall.then(() => {
      settled = true
    })

    // Closing the user's unrelated tab must not disturb the taken-over agent tab.
    views.closeTab('s1', unrelatedTabId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    expect(tools.control('s1').kind).toBe('you')
    expect(latestState()?.control.kind).toBe('you')
    expect(latestState()?.agentTab).toBe(agentTabId)

    // Handing back completes the waiting call normally.
    tools.handBack('s1')
    const answer = await waitingCall
    expect('result' in answer).toBe(true)
  })

  it('lets an agent-initiated browser_tabs(close) succeed cleanly without aborting itself', async () => {
    const { tools } = makeToolsHarness()

    await tools.call(1, 's1', 'browser_navigate', { url: 'http://localhost:3000/self-close' })
    const closed = await tools.call(2, 's1', 'browser_tabs', { action: 'close' })

    expect('result' in closed).toBe(true)
    expect(tools.control('s1')).toEqual(IDLE_CONTROL)
  })

  it('dismisses the overlay bubble instead of nudging held input on Escape in an agent-held page', async () => {
    const { tools } = makeToolsHarness()

    await tools.call(1, 's1', 'browser_navigate', { url: 'http://localhost:3000/esc' })
    const view = createdViews.at(-1)!
    const preventDefault = vi.fn()

    view.webContents.emit(
      'before-input-event',
      { preventDefault },
      {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        isAutoRepeat: false,
        control: false,
        meta: false,
        alt: false,
        shift: false,
      },
    )

    expect(preventDefault).toHaveBeenCalled()
    expect(overlayDismissCalls).toHaveLength(1)
    expect(overlaySentEvents).toEqual([])
  })
})

describe('BrowserViews element annotation mode (#1812)', () => {
  function makeAnnotateHarness() {
    const states: BrowserState[] = []
    const annotatedEvents: BrowserElementAnnotatedEvent[] = []
    let currentControl: SurfaceControl = IDLE_CONTROL
    const focus = vi.fn()
    const fakeWindow = {
      isDestroyed: () => false,
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      webContents: { focus },
    }
    const views = new BrowserViews({
      window: () => fakeWindow as never,
      send: (state) => states.push(state),
      annotated: (event) => annotatedEvents.push(event),
      control: () => currentControl,
      settings: () => ({ appearance: { zoom: 1 } }) as never,
      themes: () => ({}) as never,
      origins: { read: () => ({}), write: async () => {} } as never,
    })
    const setControl = (next: SurfaceControl) => {
      currentControl = next
      views.controlChanged('s1')
    }
    const latestState = () => states.at(-1)
    return { views, states, annotatedEvents, latestState, setControl, focus }
  }

  function extractToken(view: FakeWebContentsView): string {
    const evalCmd = view.webContents.debugger.commands
      .filter((c) => c.method === 'Runtime.evaluate')
      .find(
        (c) =>
          typeof c.params.expression === 'string' && c.params.expression.includes('const TOKEN = '),
      )
    const match = /const TOKEN = ("[^"]+")/.exec(String(evalCmd?.params.expression ?? ''))
    if (!match) throw new Error('Could not find injected annotation token')
    return JSON.parse(match[1]!) as string
  }

  function teardownCommands(view: FakeWebContentsView): SentCommand[] {
    return view.webContents.debugger.commands.filter(
      (c) =>
        c.method === 'Runtime.evaluate' &&
        typeof c.params.expression === 'string' &&
        c.params.expression.includes('[data-kettu-annotate-host], [data-kettu-annotate-cursor]'),
    )
  }

  it('enables annotation in an isolated world, forwards sanitized element picks, and exits cleanly', async () => {
    const { views, annotatedEvents, latestState, focus } = makeAnnotateHarness()
    views.show('s1')
    views.setBounds('s1', WIDE_PANE)
    views.navigate('s1', 'https://example.com/app')

    const view = createdViews.at(-1)!
    expect(await views.setAnnotate('s1', true)).toBe(true)
    expect(latestState()?.annotating).toBe(true)

    const methods = view.webContents.debugger.commands.map((c) => c.method)
    expect(methods).toContain('Runtime.enable')
    expect(methods).toContain('Page.createIsolatedWorld')
    expect(methods).toContain('Runtime.addBinding')
    expect(methods).toContain('Runtime.evaluate')

    const token = extractToken(view)

    // Wrong token is ignored.
    view.webContents.debugger.emit('message', {}, 'Runtime.bindingCalled', {
      name: '__kettuAnnotateReport',
      payload: JSON.stringify({
        token: 'wrong-token',
        type: 'pick',
        element: { tag: 'button', selector: '#save', url: 'https://example.com/app' },
      }),
    })
    expect(annotatedEvents).toHaveLength(0)

    // Valid pick is sanitized (including password value redaction) and focuses host window.
    view.webContents.debugger.emit('message', {}, 'Runtime.bindingCalled', {
      name: '__kettuAnnotateReport',
      payload: JSON.stringify({
        token,
        type: 'pick',
        element: {
          url: 'https://example.com/app',
          pageTitle: 'App',
          selector: '#pwd',
          tag: 'input',
          domId: 'pwd',
          role: 'textbox',
          accessibleName: 'Password',
          text: null,
          attributes: { type: 'password', value: 'top-secret', placeholder: 'Password' },
          rect: { x: 10, y: 20, width: 180, height: 32 },
          viewport: { width: 1440, height: 900 },
        },
      }),
    })
    expect(annotatedEvents).toHaveLength(1)
    expect(annotatedEvents[0]!.annotation.attributes.value).toBeUndefined()
    expect(annotatedEvents[0]!.annotation.attributes.placeholder).toBe('Password')
    expect(focus).toHaveBeenCalledTimes(1)

    // Disabling tears down injected overlay DOM and listeners.
    expect(await views.setAnnotate('s1', false)).toBe(false)
    expect(latestState()?.annotating).toBe(false)
    expect(teardownCommands(view)).toHaveLength(1)
    expect(teardownCommands(view)[0]!.params.contextId).toBe(42)
  })

  it('exits annotation mode on Escape key, binding exit, navigation, tab switch, and panel hide', async () => {
    const { views, latestState } = makeAnnotateHarness()
    views.show('s1')
    views.setBounds('s1', WIDE_PANE)
    views.navigate('s1', 'https://example.com/one')
    const view = createdViews.at(-1)!

    // Escape via before-input-event exits and runs teardown.
    expect(await views.setAnnotate('s1', true)).toBe(true)
    const preventDefault = vi.fn()
    view.webContents.emit(
      'before-input-event',
      { preventDefault },
      {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        isAutoRepeat: false,
        control: false,
        meta: false,
        alt: false,
        shift: false,
      },
    )
    expect(preventDefault).toHaveBeenCalled()
    expect(latestState()?.annotating).toBe(false)
    expect(teardownCommands(view).length).toBeGreaterThanOrEqual(1)

    // Same-document SPA navigation exits and tears down listeners.
    expect(await views.setAnnotate('s1', true)).toBe(true)
    const beforeSpa = teardownCommands(view).length
    view.webContents.emit('did-navigate-in-page', {}, 'https://example.com/one#section', true)
    expect(latestState()?.annotating).toBe(false)
    expect(teardownCommands(view).length).toBeGreaterThan(beforeSpa)

    // Cross-document navigation exits cleanly.
    expect(await views.setAnnotate('s1', true)).toBe(true)
    view.webContents.emit('did-navigate', {}, 'https://example.com/two', 200)
    expect(latestState()?.annotating).toBe(false)

    // Tab switch exits cleanly.
    expect(await views.setAnnotate('s1', true)).toBe(true)
    const secondTab = views.newTab('s1')!
    expect(latestState()?.annotating).toBe(false)
    views.selectTab('s1', latestState()!.tabs[0]!.id)
    expect(latestState()?.annotating).toBe(false)

    // Panel hide exits cleanly.
    expect(await views.setAnnotate('s1', true)).toBe(true)
    views.hide('s1')
    expect(latestState()?.annotating).toBe(false)
    expect(secondTab).toBeTruthy()
  })

  it('blocks annotation on blank/error pages and when an agent owns the tab', async () => {
    const { views, latestState, setControl } = makeAnnotateHarness()
    views.show('s1')
    views.setBounds('s1', WIDE_PANE)

    // Blank tab cannot be annotated.
    views.newTab('s1')
    expect(await views.setAnnotate('s1', true)).toBe(false)
    expect(latestState()?.annotating).toBe(false)

    // Load a page in agent tab and give control to the agent (localhost needs no origin prompt).
    await views.load('s1', 'http://localhost:3000/agent-page')
    const view = createdViews.at(-1)!
    setControl({ kind: 'agent', acting: false })
    expect(await views.setAnnotate('s1', true)).toBe(false)
    expect(latestState()?.annotating).toBe(false)

    // Once user takes over (control.kind === 'you'), annotation is allowed.
    setControl({ kind: 'you', since: 200 })
    expect(await views.setAnnotate('s1', true)).toBe(true)
    expect(latestState()?.annotating).toBe(true)

    // If agent regains control mid-annotation, annotation mode exits automatically.
    setControl({ kind: 'agent', acting: false })
    expect(latestState()?.annotating).toBe(false)

    // Load failure also blocks annotation.
    setControl(IDLE_CONTROL)
    view.webContents.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://bad.test/',
      true,
    )
    expect(await views.setAnnotate('s1', true)).toBe(false)
  })
})
