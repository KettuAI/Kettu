import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_SESSION_TABS,
  PAGE_SIZES,
  SIZE_LINE_ROOM,
  type BrowserBounds,
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
