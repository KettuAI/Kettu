import { afterEach, describe, expect, it, vi } from 'vitest'
import enTerminal from '@shared/locales/en/terminal.json'
import zhTerminal from '@shared/locales/zh-CN/terminal.json'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { TerminalInfo } from '@shared/terminal-host'

const PANEL = 'sess-1'
const OTHER_PANEL = 'sess-2'
const PROJECT = '/work/repo'

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
}

function makeTerminal(id: string, overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    projectPath: PROJECT,
    sessionId: PANEL,
    title: id,
    shell: 'zsh',
    createdAt: 1,
    busy: false,
    exitCode: null,
    owner: null,
    agentAllowed: false,
    control: { kind: 'idle' },
    waiting: null,
    name: null,
    namedBy: null,
    ...overrides,
  }
}

interface FakeElement {
  tagName: string
  children: FakeElement[]
  parentNode: FakeElement | null
  isConnected: boolean
  appendChild(child: FakeElement): FakeElement
  remove(): void
  closest(selector: string): unknown
}

function makeFakeElement(tag = 'div', selectorMatches: Record<string, unknown> = {}): FakeElement {
  const children: FakeElement[] = []
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    children,
    parentNode: null,
    isConnected: false,
    appendChild(child: FakeElement) {
      if (child.parentNode) {
        const index = child.parentNode.children.indexOf(child)
        if (index >= 0) child.parentNode.children.splice(index, 1)
      }
      child.parentNode = el
      child.isConnected = el.isConnected
      children.push(child)
      return child
    },
    remove() {
      if (!el.parentNode) return
      const index = el.parentNode.children.indexOf(el)
      if (index >= 0) el.parentNode.children.splice(index, 1)
      el.parentNode = null
      el.isConnected = false
    },
    closest(selector: string) {
      if (selector in selectorMatches) return selectorMatches[selector]
      return el.parentNode ? el.parentNode.closest(selector) : null
    },
  }
  return el
}

const originalWindow = globalThis.window
const originalLocalStorage = globalThis.localStorage
const originalRaf = globalThis.requestAnimationFrame

function restoreGlobals() {
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    value: originalLocalStorage,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: originalRaf,
    configurable: true,
    writable: true,
  })
}

async function setupEnv(initialStorage: Record<string, string> = {}) {
  vi.resetModules()
  const storage = memoryStorage(initialStorage)
  const terminalsRpc = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  Object.defineProperty(globalThis, 'window', {
    value: {
      kettu: {
        platform: 'darwin',
        client: 'desktop',
        systemLocale: 'en',
        terminals: {
          request: terminalsRpc,
          running: async () => true,
          onEvent: () => () => undefined,
          onConnection: () => () => undefined,
          restart: async () => undefined,
        },
        browser: {
          selectTab: vi.fn(),
        },
      },
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    },
    configurable: true,
  })

  const view = await import('./view')
  const surfaceTabs = await import('./surface-tabs')
  const terminals = await import('./terminals')
  const browser = await import('./browser')
  const settings = await import('./settings-store')
  const openSurfaces = await import('@renderer/features/shell/open-surfaces')
  const dock = await import('./terminal-dock')
  const layout = await import('@renderer/features/split/layout')

  settings.useSettingsStore.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    loaded: true,
  })

  return {
    storage,
    terminalsRpc,
    view,
    surfaceTabs,
    terminals,
    browser,
    settings,
    openSurfaces,
    dock,
    layout,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetModules()
  restoreGlobals()
})

describe('terminal placement defaults, persistence and validation', () => {
  it('defaults to side for fresh and legacy saves, and falls back on invalid stored values', async () => {
    const fresh = await setupEnv()
    expect(fresh.view.useViewStore.getState().terminalPlacement).toBe('side')
    expect(fresh.view.useViewStore.getState().bottomTerminalOpen).toEqual({})

    expect(fresh.view.readTerminalPlacement('side')).toBe('side')
    expect(fresh.view.readTerminalPlacement('bottom')).toBe('bottom')
    for (const bad of [undefined, null, '', 'left', 'top', 42, {}, []]) {
      expect(fresh.view.readTerminalPlacement(bad)).toBe('side')
    }

    const legacy = await setupEnv({
      'view:v1': JSON.stringify({
        sidePanes: { [PANEL]: 'terminal' },
      }),
    })
    expect(legacy.view.useViewStore.getState().terminalPlacement).toBe('side')
    expect(legacy.view.useViewStore.getState().sidePane[PANEL]).toBe('terminal')

    const corrupt = await setupEnv({
      'view:v1': JSON.stringify({
        terminalPlacement: 'floating',
        bottomTerminals: { [PANEL]: true },
      }),
    })
    expect(corrupt.view.useViewStore.getState().terminalPlacement).toBe('side')
    expect(corrupt.view.useViewStore.getState().bottomTerminalOpen).toEqual({})
  })

  it('persists placement and bottom dock open state across reloads and reconciles mixed state', async () => {
    vi.useFakeTimers()
    const first = await setupEnv()
    first.view.openSession(PANEL, PROJECT)
    first.view.toggleTerminal(PANEL, true)
    first.view.setTerminalPlacement('bottom', { panel: PANEL })

    expect(first.view.useViewStore.getState().terminalPlacement).toBe('bottom')
    expect(first.view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBe(true)

    vi.advanceTimersByTime(350)
    const savedRaw = first.storage.store.get('view:v1')
    expect(savedRaw).toBeTruthy()
    const saved = JSON.parse(savedRaw!) as {
      terminalPlacement?: string
      bottomTerminals?: Record<string, true>
    }
    expect(saved.terminalPlacement).toBe('bottom')
    expect(saved.bottomTerminals).toEqual({ [PANEL]: true })

    // Reloading from the saved JSON restores bottom placement and dock visibility.
    const reloaded = await setupEnv({ 'view:v1': savedRaw! })
    expect(reloaded.view.useViewStore.getState().terminalPlacement).toBe('bottom')
    expect(reloaded.view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBe(true)
    expect(reloaded.view.useViewStore.getState().sidePane[PANEL]).toBeUndefined()

    // Mixed persisted state (bottom placement + stale sidePane terminal) reconciles cleanly.
    const mixed = await setupEnv({
      'view:v1': JSON.stringify({
        terminalPlacement: 'bottom',
        sidePanes: { [PANEL]: 'terminal', [OTHER_PANEL]: 'terminal' },
        sideLast: { [PANEL]: 'terminal' },
        sideTabs: { [OTHER_PANEL]: ['files'] },
      }),
    })
    const state = mixed.view.useViewStore.getState()
    expect(state.terminalPlacement).toBe('bottom')
    expect(state.bottomTerminalOpen).toEqual({ [PANEL]: true, [OTHER_PANEL]: true })
    expect(state.sidePane[PANEL]).toBeUndefined()
    expect(state.sidePane[OTHER_PANEL]).toBe('files')
    expect(state.sideLast[PANEL]).toBeUndefined()
  })
})

describe('moving terminal between side and bottom without disrupting PTYs or side previews', () => {
  it('closes the side panel when terminal was the only open tab, and re-docks cleanly back to side', async () => {
    const { view, terminals, openSurfaces, terminalsRpc } = await setupEnv()
    view.openSession(PANEL, PROJECT)
    view.toggleSidePane(PANEL, 'terminal', true)
    view.useViewStore.setState({ sidePaneMaximized: true })

    // Register two live terminals in a split with custom tab order.
    terminals.takeTerminalEvent({
      type: 'terminal.info',
      info: makeTerminal('t1', { createdAt: 1 }),
    })
    terminals.takeTerminalEvent({
      type: 'terminal.info',
      info: makeTerminal('t2', { createdAt: 2 }),
    })
    terminals.useTerminalsStore.setState({
      active: { [PANEL]: 't1' },
      split: { [PANEL]: 't2' },
      focusedSide: { [PANEL]: 'right' },
      order: { [PANEL]: ['t2', 't1'] },
    })

    // Move to bottom: closes the side panel (even with closeSidePanelWithLastTab=false) and keeps
    // every terminal process, split and order intact without any kill/create RPCs.
    openSurfaces.moveTerminalPlacement('bottom', PANEL)
    expect(terminalsRpc).not.toHaveBeenCalled()

    const afterBottom = view.useViewStore.getState()
    expect(afterBottom.terminalPlacement).toBe('bottom')
    expect(afterBottom.bottomTerminalOpen[PANEL]).toBe(true)
    expect(afterBottom.sidePane[PANEL]).toBeUndefined()
    expect(afterBottom.sidePaneMaximized).toBe(false)

    const termAfterBottom = terminals.useTerminalsStore.getState()
    expect(Object.keys(termAfterBottom.byId).sort()).toEqual(['t1', 't2'])
    expect(termAfterBottom.active[PANEL]).toBe('t1')
    expect(termAfterBottom.split[PANEL]).toBe('t2')
    expect(termAfterBottom.focusedSide[PANEL]).toBe('right')
    expect(termAfterBottom.order[PANEL]).toEqual(['t2', 't1'])
    expect(termAfterBottom.focusing).toBe('t2')

    // Move back to side: re-docks terminal into side panel and clears bottom dock completely.
    openSurfaces.moveTerminalPlacement('side', PANEL)
    expect(terminalsRpc).not.toHaveBeenCalled()

    const afterSide = view.useViewStore.getState()
    expect(afterSide.terminalPlacement).toBe('side')
    expect(afterSide.sidePane[PANEL]).toBe('terminal')
    expect(afterSide.bottomTerminalOpen).toEqual({})

    const termAfterSide = terminals.useTerminalsStore.getState()
    expect(Object.keys(termAfterSide.byId).sort()).toEqual(['t1', 't2'])
    expect(termAfterSide.active[PANEL]).toBe('t1')
    expect(termAfterSide.split[PANEL]).toBe('t2')
    expect(termAfterSide.order[PANEL]).toEqual(['t2', 't1'])
    expect(termAfterSide.focusing).toBe('t2')
  })

  it('keeps other side-panel previews open when moving terminal to bottom and allows using them independently', async () => {
    const { view, surfaceTabs, terminals, browser, openSurfaces } = await setupEnv()
    view.openSession(PANEL, PROJECT)
    view.toggleSidePane(PANEL, 'files', true)
    view.openDoc(PANEL, { kind: 'artifact', id: 'art-1' })
    view.toggleSidePane(PANEL, 'terminal', true)
    surfaceTabs.recordSurfaceOrder(PANEL, ['files:', 'artifact:art-1', 'terminal:t1'])
    terminals.takeTerminalEvent({ type: 'terminal.info', info: makeTerminal('t1') })

    // Move terminal to bottom: side panel stays open on the nearest non-terminal tab (artifact).
    openSurfaces.moveTerminalPlacement('bottom', PANEL)
    let state = view.useViewStore.getState()
    expect(state.bottomTerminalOpen[PANEL]).toBe(true)
    expect(state.sidePane[PANEL]).toBe('artifact')
    expect(state.sideDoc[PANEL]).toBe('artifact:art-1')

    // User can freely switch side panel between Files, Browser and Artifacts while bottom terminal stays open.
    view.toggleSidePane(PANEL, 'files', true)
    expect(view.useViewStore.getState().sidePane[PANEL]).toBe('files')
    expect(view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBe(true)

    view.toggleSidePane(PANEL, 'browser', true)
    expect(view.useViewStore.getState().sidePane[PANEL]).toBe('browser')
    expect(view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBe(true)

    // Moving back to side focuses terminal while keeping Files and Artifact tabs available.
    openSurfaces.moveTerminalPlacement('side', PANEL)
    state = view.useViewStore.getState()
    expect(state.sidePane[PANEL]).toBe('terminal')
    expect(state.sideTabs[PANEL]).toEqual(['files'])
    expect(state.sideDocs[PANEL]?.map((d) => d.id)).toEqual(['art-1'])
    expect(state.bottomTerminalOpen).toEqual({})

    // Stale closed browser entries in sideOrder do not keep an otherwise empty side panel open.
    view.useViewStore.setState({
      sideTabs: {},
      sideDocs: {},
      sideDoc: {},
      sideOrder: { [PANEL]: ['browser:gone-tab', 'terminal:t1'] },
      sidePane: { [PANEL]: 'terminal' },
    })
    browser.useBrowserStore.setState({ bySession: {} })
    openSurfaces.moveTerminalPlacement('bottom', PANEL)
    expect(view.useViewStore.getState().sidePane[PANEL]).toBeUndefined()
    expect(view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBe(true)
  })

  it('honors remembered placement across toggleTerminal, revealTerminal, revealSurface, foldSurface, reopenSidePanel and New session handoff', async () => {
    const { view, surfaceTabs, terminals, openSurfaces, layout } = await setupEnv()
    view.openSession(PANEL, PROJECT)
    view.setTerminalPlacement('bottom')
    view.toggleSidePane(PANEL, 'files', true)

    // toggleTerminal toggles only the bottom dock and leaves Files open on the side.
    view.toggleTerminal(PANEL)
    expect(view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBe(true)
    expect(view.useViewStore.getState().sidePane[PANEL]).toBe('files')

    view.toggleTerminal(PANEL)
    expect(view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBeUndefined()
    expect(view.useViewStore.getState().sidePane[PANEL]).toBe('files')

    // revealTerminal and revealSurface open the bottom dock and focus the target terminal.
    terminals.takeTerminalEvent({ type: 'terminal.info', info: makeTerminal('t-agent') })
    terminals.revealTerminal('t-agent')
    expect(view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBe(true)
    expect(view.useViewStore.getState().sidePane[PANEL]).toBe('files')
    expect(terminals.useTerminalsStore.getState().focusing).toBe('t-agent')

    view.closeBottomTerminal(PANEL)
    openSurfaces.revealSurface(PANEL, 'terminal', 't-agent')
    expect(view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBe(true)
    expect(view.useViewStore.getState().sidePane[PANEL]).toBe('files')

    // Closing the last terminal folds the bottom dock without touching the side panel.
    terminals.forgetTerminal('t-agent')
    expect(view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBeUndefined()
    expect(view.useViewStore.getState().sidePane[PANEL]).toBe('files')

    // Reopening a closed side panel while terminal is docked at the bottom does not open terminal on the side.
    view.closeSidePanel(PANEL)
    view.useViewStore.setState({
      sideTabs: {},
      sideLast: { [PANEL]: 'terminal' },
      sideOrder: { [PANEL]: ['terminal:t-live'] },
    })
    terminals.takeTerminalEvent({ type: 'terminal.info', info: makeTerminal('t-live') })
    expect(openSurfaces.reopenSidePanel(PANEL, PROJECT)).toBe(true)
    expect(view.useViewStore.getState().sidePane[PANEL]).toBe('surfaces')

    // foldSurface for terminal in bottom mode closes the bottom dock only.
    view.toggleTerminal(PANEL, true)
    surfaceTabs.foldSurface(PANEL, 'terminal')
    expect(view.useViewStore.getState().bottomTerminalOpen[PANEL]).toBeUndefined()
    expect(view.useViewStore.getState().sidePane[PANEL]).toBe('surfaces')

    // New session with bottom terminal open hands bottomTerminalOpen to the newly created session.
    view.restoreLayout(layout.createLayout({ ...layout.newSessionView(), projectPath: PROJECT }))
    const draftPanel = view.newSessionPanel(PROJECT)
    view.toggleTerminal(draftPanel, true)
    expect(view.useViewStore.getState().bottomTerminalOpen[draftPanel]).toBe(true)
    const paneId = view.newSessionAt()!
    expect(view.showCreatedSession(paneId, 'sess-new', PROJECT)).toBe(true)
    expect(view.useViewStore.getState().bottomTerminalOpen['sess-new']).toBe(true)
    expect(view.useViewStore.getState().bottomTerminalOpen[draftPanel]).toBeUndefined()
  })
})

describe('xterm reparenting across side and bottom docks', () => {
  it('reparents the existing element, preserves scroll position, ignores stale unmounts and refits cleanly', async () => {
    const env = await setupEnv()
    env.terminalsRpc.mockResolvedValue(undefined)
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: (cb: FrameRequestCallback) => {
        cb(0)
        return 1
      },
      configurable: true,
    })

    const { mount, unmount, fitNow } = await import('@renderer/features/terminal/xterm-registry')

    const scrollToLine = vi.fn()
    const scrollToBottom = vi.fn()
    const resize = vi.fn()
    const refresh = vi.fn()
    const open = vi.fn()
    let proposed = { cols: 80, rows: 24 }
    let viewportY = 12
    let baseY = 40

    const sideContainer = makeFakeElement('div')
    sideContainer.isConnected = true
    const bottomContainer = makeFakeElement('div', {
      // Bottom dock lives inside #content, so even while the outer pane area glides it is not
      // inside a gliding side panel.
      '.kettu-pane-area[data-glide]': {},
      '.kettu-pane-area[data-glide] > [data-panel]:not(#content)': null,
    })
    bottomContainer.isConnected = true
    const termElement = makeFakeElement('div')

    const instance = {
      id: 'term-live',
      term: {
        element: termElement as unknown as HTMLElement,
        rows: 24,
        cols: 80,
        buffer: {
          get active() {
            return { viewportY, baseY }
          },
        },
        open,
        resize,
        refresh,
        scrollToLine,
        scrollToBottom,
      },
      fit: {
        proposeDimensions: () => proposed,
      },
      element: termElement as unknown as HTMLDivElement,
      container: null,
      savedScroll: null,
      visible: false,
      size: { cols: 0, rows: 0 },
      webgl: null,
    } as unknown as import('@renderer/features/terminal/xterm-registry').Instance

    // Initial mount in side panel does not re-open an already-open xterm instance.
    mount(instance, sideContainer as unknown as HTMLElement, false)
    expect(open).not.toHaveBeenCalled()
    expect(sideContainer.children).toEqual([termElement])
    expect(resize).toHaveBeenCalledWith(80, 24)
    expect(env.terminalsRpc).toHaveBeenCalledWith('terminals.resize', {
      id: 'term-live',
      cols: 80,
      rows: 24,
    })

    // Unmount from side panel records scrolled-up viewportY and preserves the buffer.
    unmount(instance, sideContainer as unknown as HTMLElement)
    expect(instance.visible).toBe(false)
    expect(instance.savedScroll).toEqual({ atBottom: false, viewportY: 12 })

    // Remount into bottom dock with wider/shorter dimensions restores scroll line and refits.
    proposed = { cols: 140, rows: 14 }
    mount(instance, bottomContainer as unknown as HTMLElement, false)
    expect(bottomContainer.children).toEqual([termElement])
    expect(scrollToLine).toHaveBeenCalledWith(12)
    expect(resize).toHaveBeenCalledWith(140, 14)
    expect(refresh).toHaveBeenCalled()

    // A stale unmount from the previous side container is ignored and does not detach the bottom view.
    unmount(instance, sideContainer as unknown as HTMLElement)
    expect(instance.visible).toBe(true)
    expect(bottomContainer.children).toEqual([termElement])

    // When scrolled to bottom, reparenting back keeps the viewport pinned to the bottom.
    viewportY = 40
    baseY = 40
    unmount(instance, bottomContainer as unknown as HTMLElement)
    proposed = { cols: 90, rows: 30 }
    mount(instance, sideContainer as unknown as HTMLElement, false)
    expect(scrollToBottom).toHaveBeenCalled()
    expect(resize).toHaveBeenCalledWith(90, 30)

    // fitNow still works in bottom dock even when the outer pane area is marked gliding.
    unmount(instance, sideContainer as unknown as HTMLElement)
    mount(instance, bottomContainer as unknown as HTMLElement, false)
    proposed = { cols: 150, rows: 16 }
    fitNow(instance)
    expect(resize).toHaveBeenCalledWith(150, 16)
  })
})

describe('bottom dock height clamping, dragging, keyboard steps and persistence', () => {
  it('clamps height across normal, tall, short and degenerate viewports', async () => {
    const { dock } = await setupEnv()

    expect(dock.bottomHeightBounds(900)).toEqual({ min: 140, max: 630 })
    expect(dock.clampBottomTerminalHeight(260, 900)).toBe(260)
    expect(dock.clampBottomTerminalHeight(80, 900)).toBe(140)
    expect(dock.clampBottomTerminalHeight(800, 900)).toBe(630)

    // Medium window (600px): keeps at least MIN_MAIN_HEIGHT (200px) for thread + composer.
    expect(dock.bottomHeightBounds(600)).toEqual({ min: 140, max: 400 })
    expect(dock.clampBottomTerminalHeight(500, 600)).toBe(400)

    // Very short window (280px): max shrinks to 80px and min never exceeds max.
    expect(dock.bottomHeightBounds(280)).toEqual({ min: 80, max: 80 })
    expect(dock.clampBottomTerminalHeight(260, 280)).toBe(80)

    // Extremely short or invalid available heights never produce negative or NaN values.
    expect(dock.clampBottomTerminalHeight(260, 150)).toBe(0)
    expect(dock.clampBottomTerminalHeight(260, 0)).toBe(0)
    expect(dock.clampBottomTerminalHeight(Number.NaN, 800)).toBe(dock.DEFAULT_BOTTOM_HEIGHT)
    expect(dock.clampBottomTerminalHeight(260, Number.NaN)).toBe(0)
  })

  it('computes vertical drag deltas and keyboard resize steps accurately', async () => {
    const { dock } = await setupEnv()

    // Dragging upward (negative deltaY) increases dock height; downward shrinks it.
    expect(dock.dragBottomTerminalHeight(260, 900, -100)).toBe(360)
    expect(dock.dragBottomTerminalHeight(260, 900, 100)).toBe(160)
    expect(dock.dragBottomTerminalHeight(260, 900, 300)).toBe(140)
    expect(dock.dragBottomTerminalHeight(260, 900, -600)).toBe(630)

    // Keyboard stepping adjusts by 32px (128px with Shift) and Home requests reset.
    expect(dock.stepBottomTerminalHeight(260, 900, 'ArrowUp', false)).toBe(292)
    expect(dock.stepBottomTerminalHeight(260, 900, 'ArrowUp', true)).toBe(388)
    expect(dock.stepBottomTerminalHeight(260, 900, 'ArrowDown', false)).toBe(228)
    expect(dock.stepBottomTerminalHeight(260, 900, 'Home', false)).toBeNull()
    expect(dock.stepBottomTerminalHeight(260, 900, 'Enter', false)).toBeUndefined()
  })

  it('persists custom heights with debounce, clears storage on reset and sanitizes corrupt values', async () => {
    vi.useFakeTimers()
    const env = await setupEnv({ 'terminal-bottom-height': '340.4' })
    expect(env.dock.useBottomTerminalHeight.getState().height).toBe(340)

    env.dock.setBottomTerminalHeight(420)
    expect(env.dock.useBottomTerminalHeight.getState().height).toBe(420)
    vi.advanceTimersByTime(350)
    expect(env.storage.store.get('terminal-bottom-height')).toBe('420')

    // Reloading reads the persisted height.
    const reloaded = await setupEnv({ 'terminal-bottom-height': '420' })
    expect(reloaded.dock.useBottomTerminalHeight.getState().height).toBe(420)

    // Reset clears localStorage immediately.
    reloaded.dock.resetBottomTerminalHeight()
    expect(reloaded.dock.useBottomTerminalHeight.getState().height).toBe(
      reloaded.dock.DEFAULT_BOTTOM_HEIGHT,
    )
    expect(reloaded.storage.store.has('terminal-bottom-height')).toBe(false)

    // Invalid stored values fall back to default height.
    for (const bad of ['50', '"tall"', 'null', 'NaN', '{bad']) {
      reloaded.storage.store.set('terminal-bottom-height', bad)
      expect(reloaded.dock.readStoredBottomTerminalHeight()).toBe(
        reloaded.dock.DEFAULT_BOTTOM_HEIGHT,
      )
    }
  })
})

describe('terminal dock bilingual copy parity', () => {
  it('provides matching English and Simplified Chinese strings for placement and resize controls', () => {
    expect(enTerminal.panel.moveToBottom).toBe('Move to bottom')
    expect(enTerminal.panel.moveToSide).toBe('Move to side')
    expect(enTerminal.panel.hide).toBe('Hide terminal')
    expect(enTerminal.panel.resize).toBe('Resize terminal height')
    expect(enTerminal.panel.resizeHint).toBeTruthy()

    expect(zhTerminal.panel.moveToBottom).toBe('移到底部')
    expect(zhTerminal.panel.moveToSide).toBe('移回右侧')
    expect(zhTerminal.panel.hide).toBe('隐藏终端')
    expect(zhTerminal.panel.resize).toBe('调整终端高度')
    expect(zhTerminal.panel.resizeHint).toBeTruthy()

    expect(Object.keys(zhTerminal.panel).sort()).toEqual(Object.keys(enTerminal.panel).sort())
  })
})
