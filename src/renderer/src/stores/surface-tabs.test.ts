import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { TerminalInfo } from '@shared/terminal-host'

const PANEL = 's1'
const OTHER_PANEL = 's2'
const PROJECT = '/repo'

function storageMock() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}

let useSettingsStore: typeof import('./settings-store').useSettingsStore
let useViewStore: typeof import('./view').useViewStore
let openSession: typeof import('./view').openSession
let openDoc: typeof import('./view').openDoc
let closeDoc: typeof import('./view').closeDoc
let toggleSidePane: typeof import('./view').toggleSidePane
let removeSideTab: typeof import('./view').removeSideTab
let leaveEmptySidePanel: typeof import('./view').leaveEmptySidePanel
let nextAfterClose: typeof import('./surface-tabs').nextAfterClose
let recordSurfaceOrder: typeof import('./surface-tabs').recordSurfaceOrder
let foldSurface: typeof import('./surface-tabs').foldSurface
let useTerminalsStore: typeof import('./terminals').useTerminalsStore
let takeTerminalEvent: typeof import('./terminals').takeTerminalEvent
let forgetTerminal: typeof import('./terminals').forgetTerminal
let reopenSidePanel: typeof import('@renderer/features/shell/open-surfaces').reopenSidePanel
let WebSettings: typeof import('@renderer/web/settings').WebSettings

function setCloseSetting(enabled: boolean): void {
  useSettingsStore.setState({
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      appearance: {
        ...structuredClone(DEFAULT_SETTINGS.appearance),
        closeSidePanelWithLastTab: enabled,
      },
    },
    loaded: true,
  })
}

function resetStores(closeSidePanelWithLastTab = false): void {
  setCloseSetting(closeSidePanelWithLastTab)
  useViewStore.setState({
    sidePane: {},
    sideLast: {},
    sideTabs: {},
    sideOrder: {},
    sideDocs: {},
    sideDoc: {},
    sidePaneMaximized: false,
  })
  useTerminalsStore.setState({
    byId: {},
    active: {},
    order: {},
    split: {},
    focusedSide: {},
    focusing: null,
    errors: {},
    controls: {},
  })
}

function makeTerminal(id: string, sessionId = PANEL): TerminalInfo {
  return {
    id,
    projectPath: PROJECT,
    sessionId,
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
  }
}

beforeAll(async () => {
  vi.stubGlobal('window', {
    kettu: { platform: 'darwin', client: 'desktop', systemLocale: 'en' },
  })
  vi.stubGlobal('localStorage', storageMock())
  ;({ useSettingsStore } = await import('./settings-store'))
  ;({
    useViewStore,
    openSession,
    openDoc,
    closeDoc,
    toggleSidePane,
    removeSideTab,
    leaveEmptySidePanel,
  } = await import('./view'))
  ;({ nextAfterClose, recordSurfaceOrder, foldSurface } = await import('./surface-tabs'))
  ;({ useTerminalsStore, takeTerminalEvent, forgetTerminal } = await import('./terminals'))
  ;({ reopenSidePanel } = await import('@renderer/features/shell/open-surfaces'))
  ;({ WebSettings } = await import('@renderer/web/settings'))
}, 30_000)

beforeEach(() => {
  vi.useFakeTimers()
  resetStores(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('nextAfterClose', () => {
  it('selects the nearest unselected neighbor, or returns empty for the last tab', () => {
    const a = { key: 'file:a.ts', selected: false }
    const b = { key: 'file:b.ts', selected: true }
    const c = { key: 'terminal:t1', selected: false }

    expect(nextAfterClose([a, b, c], b)).toEqual({ select: c })
    expect(nextAfterClose([a, b], b)).toEqual({ select: a })
    expect(nextAfterClose([a, b], a)).toBe('keep')
    expect(nextAfterClose([b], b)).toBe('empty')
  })

  it('keeps the panel open when closing one side of a split terminal', () => {
    const left = { key: 'terminal:t1', selected: true }
    const right = { key: 'terminal:t2', selected: true }
    const files = { key: 'files:', selected: false }

    expect(nextAfterClose([left, right], right)).toBe('keep')
    expect(nextAfterClose([left, right], left)).toBe('keep')
    expect(nextAfterClose([left, right, files], right)).toBe('keep')
  })
})

describe('leaveEmptySidePanel', () => {
  it('switches to surfaces when closeSidePanelWithLastTab is false', () => {
    toggleSidePane(PANEL, 'files', true)
    leaveEmptySidePanel(PANEL)
    expect(useViewStore.getState().sidePane[PANEL]).toBe('surfaces')
  })

  it('collapses the side panel and clears stale state when closeSidePanelWithLastTab is true', () => {
    setCloseSetting(true)
    openSession(PANEL, PROJECT)
    toggleSidePane(PANEL, 'files', true)
    useViewStore.setState({ sidePaneMaximized: true, sideLast: { [PANEL]: 'files' } })

    leaveEmptySidePanel(PANEL)
    const state = useViewStore.getState()
    expect(state.sidePane[PANEL]).toBeUndefined()
    expect(state.sideLast[PANEL]).toBeUndefined()
    expect(state.sidePaneMaximized).toBe(false)

    // Reopening the collapsed empty panel lands cleanly on the pane list.
    useViewStore.setState({ sideTabs: {} })
    expect(reopenSidePanel(PANEL, PROJECT)).toBe(true)
    expect(useViewStore.getState().sidePane[PANEL]).toBe('surfaces')
  })

  it('does not affect another focused pane when a background panel collapses', () => {
    setCloseSetting(true)
    openSession(PANEL, PROJECT)
    toggleSidePane(PANEL, 'files', true)
    toggleSidePane(OTHER_PANEL, 'git', true)
    useViewStore.setState({ sidePaneMaximized: true })

    leaveEmptySidePanel(OTHER_PANEL)
    const state = useViewStore.getState()
    expect(state.sidePane[OTHER_PANEL]).toBeUndefined()
    expect(state.sidePane[PANEL]).toBe('files')
    expect(state.sidePaneMaximized).toBe(true)
  })

  it('is a no-op when the panel is already closed', () => {
    leaveEmptySidePanel(PANEL)
    expect(useViewStore.getState().sidePane[PANEL]).toBeUndefined()
  })
})

describe('foldSurface and last surface closure', () => {
  it('switches to surfaces for terminal, browser and devices when the setting is off', () => {
    for (const kind of ['terminal', 'browser', 'devices'] as const) {
      resetStores(false)
      toggleSidePane(PANEL, kind, true)
      recordSurfaceOrder(PANEL, [`${kind}:1`])
      foldSurface(PANEL, kind)
      expect(useViewStore.getState().sidePane[PANEL]).toBe('surfaces')
    }
  })

  it('collapses the side panel for terminal, browser and devices when the setting is on', () => {
    for (const kind of ['terminal', 'browser', 'devices'] as const) {
      resetStores(true)
      toggleSidePane(PANEL, kind, true)
      recordSurfaceOrder(PANEL, [`${kind}:1`])
      foldSurface(PANEL, kind)
      expect(useViewStore.getState().sidePane[PANEL]).toBeUndefined()
    }
  })

  it('keeps the side panel open on a neighbor tab even when the setting is on', () => {
    setCloseSetting(true)
    openDoc(PANEL, { kind: 'file', id: 'src/a.ts' })
    toggleSidePane(PANEL, 'browser', true)
    recordSurfaceOrder(PANEL, ['file:src/a.ts', 'browser:p1'])

    foldSurface(PANEL, 'browser')
    const state = useViewStore.getState()
    expect(state.sidePane[PANEL]).toBe('file')
    expect(state.sideDoc[PANEL]).toBe('file:src/a.ts')
  })

  it('ignores stale sideOrder entries for already-removed tabs when folding', () => {
    setCloseSetting(true)
    toggleSidePane(PANEL, 'files', true)
    toggleSidePane(PANEL, 'browser', true)
    recordSurfaceOrder(PANEL, ['files:', 'browser:p1'])
    removeSideTab(PANEL, 'files')

    foldSurface(PANEL, 'browser')
    expect(useViewStore.getState().sidePane[PANEL]).toBeUndefined()
  })

  it('respects the setting when the last terminal exits via forgetTerminal', () => {
    toggleSidePane(PANEL, 'terminal', true)
    recordSurfaceOrder(PANEL, ['terminal:t1'])
    takeTerminalEvent({ type: 'terminal.info', info: makeTerminal('t1') })
    forgetTerminal('t1')
    expect(useViewStore.getState().sidePane[PANEL]).toBe('surfaces')

    resetStores(true)
    toggleSidePane(PANEL, 'terminal', true)
    recordSurfaceOrder(PANEL, ['terminal:t1'])
    takeTerminalEvent({ type: 'terminal.info', info: makeTerminal('t1') })
    forgetTerminal('t1')
    expect(useViewStore.getState().sidePane[PANEL]).toBeUndefined()
  })

  it('keeps the terminal pane open when one side of a split terminal exits', () => {
    setCloseSetting(true)
    toggleSidePane(PANEL, 'terminal', true)
    takeTerminalEvent({ type: 'terminal.info', info: makeTerminal('t1') })
    takeTerminalEvent({ type: 'terminal.info', info: makeTerminal('t2') })
    useTerminalsStore.setState({
      active: { [PANEL]: 't1' },
      split: { [PANEL]: 't2' },
      focusedSide: { [PANEL]: 'right' },
    })

    forgetTerminal('t2')
    expect(useViewStore.getState().sidePane[PANEL]).toBe('terminal')
    expect(useTerminalsStore.getState().split[PANEL]).toBeUndefined()
    expect(useTerminalsStore.getState().active[PANEL]).toBe('t1')

    forgetTerminal('t1')
    expect(useViewStore.getState().sidePane[PANEL]).toBeUndefined()
  })
})

describe('closeDoc', () => {
  it('switches to surfaces on the last doc when the setting is off', () => {
    openDoc(PANEL, { kind: 'file', id: 'src/a.ts' })
    closeDoc(PANEL, 'file:src/a.ts')
    expect(useViewStore.getState().sidePane[PANEL]).toBe('surfaces')
    expect(useViewStore.getState().sideDocs[PANEL]).toBeUndefined()
  })

  it('collapses the side panel on the last doc when the setting is on', () => {
    setCloseSetting(true)
    openSession(PANEL, PROJECT)
    openDoc(PANEL, { kind: 'file', id: 'src/a.ts' })
    useViewStore.setState({ sidePaneMaximized: true })

    closeDoc(PANEL, 'file:src/a.ts')
    const state = useViewStore.getState()
    expect(state.sidePane[PANEL]).toBeUndefined()
    expect(state.sideDoc[PANEL]).toBeUndefined()
    expect(state.sideDocs[PANEL]).toBeUndefined()
    expect(state.sidePaneMaximized).toBe(false)
  })

  it('keeps the side panel open on a remaining doc or single tab when the setting is on', () => {
    setCloseSetting(true)
    toggleSidePane(PANEL, 'files', true)
    openDoc(PANEL, { kind: 'file', id: 'src/a.ts' })
    openDoc(PANEL, { kind: 'file', id: 'src/b.ts' })

    closeDoc(PANEL, 'file:src/b.ts')
    expect(useViewStore.getState().sidePane[PANEL]).toBe('file')
    expect(useViewStore.getState().sideDoc[PANEL]).toBe('file:src/a.ts')

    closeDoc(PANEL, 'file:src/a.ts')
    expect(useViewStore.getState().sidePane[PANEL]).toBe('files')
  })
})

describe('web client settings persistence', () => {
  it('persists closeSidePanelWithLastTab locally in browser storage', async () => {
    const storage = storageMock()
    const first = new WebSettings(storage)
    expect(first.current().appearance.closeSidePanelWithLastTab).toBe(false)

    await first.update({ appearance: { closeSidePanelWithLastTab: true } })
    expect(first.current().appearance.closeSidePanelWithLastTab).toBe(true)

    const reloaded = new WebSettings(storage)
    expect(reloaded.current().appearance.closeSidePanelWithLastTab).toBe(true)
  })
})
