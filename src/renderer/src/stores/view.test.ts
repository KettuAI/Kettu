import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', { kettu: { perf: false } })

const {
  closeArtifact,
  closeSettings,
  openAgentSettings,
  openArtifact,
  openArtifacts,
  openNewSession,
  openSession,
  openSettings,
  openSettingsItem,
  settingsBack,
  showShortcuts,
  toggleShortcuts,
  useViewStore,
} = await import('./view')

const { useArtifactsStore } = await import('./artifacts')

const settings = () => useViewStore.getState().settings

describe('settings view', () => {
  beforeEach(() => {
    useViewStore.setState({
      main: { kind: 'launch' },
      projectPath: null,
      settings: { open: false, section: null, item: null },
    })
  })

  it('opens without a section the first time, which the page shows as General', () => {
    openSettings()
    expect(settings()).toEqual({ open: true, section: null, item: null })
  })

  it('switches the page when opened at a section while already open', () => {
    openSettings('git')
    openSettings('agents')
    expect(settings()).toEqual({ open: true, section: 'agents', item: null })
  })

  it('shows the section shown last when opened without one', () => {
    openSettings('about')
    closeSettings()
    expect(settings()).toEqual({ open: false, section: 'about', item: null })
    openSettings()
    expect(settings()).toEqual({ open: true, section: 'about', item: null })
  })

  it('keeps the section when a session or New session takes the window', () => {
    openSettings('terminal')
    openSession('s1', '/repo')
    expect(settings()).toEqual({ open: false, section: 'terminal', item: null })
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 's1' })

    openSettings()
    openNewSession('/repo', null)
    expect(settings()).toEqual({ open: false, section: 'terminal', item: null })
    expect(useViewStore.getState().main).toEqual({ kind: 'new', agentId: null, noProject: false })
  })

  it("opens an agent's page under Agents, and a section clears it", () => {
    openAgentSettings('codex')
    expect(settings()).toEqual({ open: true, section: 'agents', item: 'codex' })
    openSettings('git')
    expect(settings()).toEqual({ open: true, section: 'git', item: null })
  })

  it("comes back to the agent's page when opened without a section", () => {
    openAgentSettings('claude-code')
    closeSettings()
    openSettings()
    expect(settings()).toEqual({ open: true, section: 'agents', item: 'claude-code' })
  })

  it("goes back from an agent's page to the list, then out of Settings", () => {
    openAgentSettings('opencode')
    settingsBack()
    expect(settings()).toEqual({ open: true, section: 'agents', item: null })
    settingsBack()
    expect(settings()).toEqual({ open: false, section: 'agents', item: null })
  })

  it("opens the page of one item of any section, and back to that section's list", () => {
    openSettingsItem('mcp', 'kettu')
    expect(settings()).toEqual({ open: true, section: 'mcp', item: 'kettu' })
    settingsBack()
    expect(settings()).toEqual({ open: true, section: 'mcp', item: null })
    settingsBack()
    expect(settings()).toEqual({ open: false, section: 'mcp', item: null })
  })
})

describe('shortcuts view', () => {
  const open = () => useViewStore.getState().shortcutsOpen

  beforeEach(() => {
    useViewStore.setState({ shortcutsOpen: false })
  })

  it('opens the dialog with the shortcut and closes it again', () => {
    toggleShortcuts(false)
    expect(open()).toBe(true)
    toggleShortcuts(false)
    expect(open()).toBe(false)
  })

  it('leaves the dialog closed while another layer is open', () => {
    toggleShortcuts(true)
    expect(open()).toBe(false)
  })

  it('closes an open dialog even while another layer is open', () => {
    toggleShortcuts(false)
    toggleShortcuts(true)
    expect(open()).toBe(false)
  })

  it('shows and hides the dialog', () => {
    showShortcuts(true)
    expect(open()).toBe(true)
    showShortcuts(false)
    expect(open()).toBe(false)
  })
})

describe('artifacts view', () => {
  it('opens the whole list from the sidebar, and the viewer goes back to it', () => {
    useArtifactsStore.setState({ filter: 'report', opened: 'art_1' })
    useViewStore.setState({
      main: { kind: 'usage' },
      settings: { open: true, section: 'git', item: null },
    })
    openArtifacts()
    expect(useViewStore.getState().main).toEqual({ kind: 'artifacts' })
    expect(settings().open).toBe(false)
    expect(useArtifactsStore.getState()).toMatchObject({ filter: '', opened: null })

    openArtifact('art_2')
    expect(useViewStore.getState().main).toEqual({
      kind: 'artifact',
      id: 'art_2',
      back: { kind: 'artifacts' },
    })
    closeArtifact()
    expect(useViewStore.getState().main).toEqual({ kind: 'artifacts' })
  })
})

describe('the split view', () => {
  const sessions = async () => {
    const view = await import('./view')
    const layout = await import('@renderer/features/split/layout')
    return { ...view, ...layout }
  }

  it('focuses the pane that holds a session, and otherwise replaces the pane in focus', async () => {
    const { useViewStore, openSession, splitAt, paneOrder, createLayout, focusedPane, findPane } =
      await sessions()
    let layout = createLayout({
      kind: 'session',
      sessionId: 's1',
      projectPath: '/repo',
    })
    layout = splitAt(
      layout,
      layout.focus,
      'right',
      {
        kind: 'session',
        sessionId: 's2',
        projectPath: '/repo',
      },
      { width: 1920, height: 1080 },
    )!
    useViewStore.setState({ layout, main: { kind: 'session', sessionId: 's2' } })
    const [first] = paneOrder(layout)

    openSession('s1', '/repo')
    const next = useViewStore.getState()
    expect(next.layout.focus).toBe(first)
    expect(next.main).toEqual({ kind: 'session', sessionId: 's1' })

    openSession('s3', '/repo')
    expect(findPane(useViewStore.getState().layout, focusedPane(next.layout).id)?.view).toEqual({
      kind: 'session',
      sessionId: 's3',
      projectPath: '/repo',
    })
    expect(useViewStore.getState().layout.columns).toHaveLength(2)
  })

  it('shows New session in one pane at most', async () => {
    const { useViewStore, openNewSession, splitAt, createLayout, allPanes } = await sessions()
    let layout = createLayout({ kind: 'session', sessionId: 's1', projectPath: '/repo' })
    layout = splitAt(
      layout,
      layout.focus,
      'right',
      {
        kind: 'session',
        sessionId: 's2',
        projectPath: '/repo',
      },
      { width: 1920, height: 1080 },
    )!
    useViewStore.setState({ layout, main: { kind: 'session', sessionId: 's2' } })

    openNewSession('/repo', 'codex')
    openNewSession('/other', null)
    expect(
      allPanes(useViewStore.getState().layout).filter((p) => p.view.kind === 'new'),
    ).toHaveLength(1)
    // The shown New session keeps the agent it had.
    expect(useViewStore.getState().main).toMatchObject({ kind: 'new', agentId: 'codex' })
  })

  it('leaves the layout as it was when a page shows', async () => {
    const { useViewStore, openUsage, createLayout } = await sessions()
    const layout = createLayout({ kind: 'session', sessionId: 's1', projectPath: '/repo' })
    useViewStore.setState({ layout, main: { kind: 'session', sessionId: 's1' } })
    openUsage()
    expect(useViewStore.getState().layout).toEqual(layout)
    expect(useViewStore.getState().main).toEqual({ kind: 'usage' })
  })

  it('keeps the split’s side pane as the focus moves, and hands it to the last pane’s project', async () => {
    const {
      useViewStore,
      toggleSidePane,
      splitAt,
      createLayout,
      focusPane: focusIn,
      paneOrder,
    } = await sessions()
    let layout = createLayout({ kind: 'session', sessionId: 's1', projectPath: '/one' })
    layout = splitAt(
      layout,
      layout.focus,
      'right',
      {
        kind: 'session',
        sessionId: 's2',
        projectPath: '/two',
      },
      { width: 1920, height: 1080 },
    )!
    useViewStore.setState({
      layout,
      main: { kind: 'session', sessionId: 's2' },
      projectPath: '/two',
      sidePane: {},
    })
    toggleSidePane('/two', 'files')
    expect(useViewStore.getState().splitSidePane).toBe('files')
    // The focus moves, and the panel stays on its pane.
    useViewStore.setState((s) => ({ layout: focusIn(s.layout, paneOrder(s.layout)[0]!) }))
    expect(useViewStore.getState().splitSidePane).toBe('files')
    // Back to one pane, the panel belongs to that pane's project.
    const single = paneOrder(useViewStore.getState().layout)[0]!
    const { closeSplitPane } = await import('./view')
    closeSplitPane(paneOrder(useViewStore.getState().layout)[1]!)
    expect(useViewStore.getState().layout.focus).toBe(single)
    expect(useViewStore.getState().splitSidePane).toBeNull()
    expect(useViewStore.getState().sidePane['/one']).toBe('files')
  })
})

describe('history', async () => {
  const view = await import('./view')
  const { allPanes, createLayout, findPane, paneOrder, splitAt } =
    await import('@renderer/features/split/layout')
  const { goBack, goForward, stepBackTo, useViewStore } = view
  const any = () => true
  const state = () => useViewStore.getState()
  const session = (sessionId: string) => ({
    kind: 'session' as const,
    sessionId,
    projectPath: '/repo',
  })
  const shown = (sessionId: string) => ({ kind: 'session', sessionId })
  // Two panes side by side, s1 and s2.
  const split = () => {
    const one = createLayout(session('s1'))
    return splitAt(one, one.focus, 'right', session('s2'), { width: 1920, height: 1080 })!
  }
  // What a launch leaves: the layout shown and no history.
  const start = (layout = createLayout(session('s1'))) => {
    useViewStore.setState({ main: { kind: 'launch' } })
    view.restoreLayout(layout)
    useViewStore.setState({ history: { back: [], forward: [] } })
    return paneOrder(layout)
  }

  it('records a step for each change of what shows, and none for what already shows', () => {
    start()
    view.openSession('s2', '/repo')
    view.openSession('s2', '/repo')
    expect(state().history.back).toHaveLength(1)
    view.openUsage()
    expect(state().history.back).toHaveLength(2)
  })

  it('records nothing for the first view after launch', () => {
    useViewStore.setState({ main: { kind: 'launch' }, history: { back: [], forward: [] } })
    view.restoreLayout(createLayout(session('s1')))
    expect(state().history.back).toEqual([])
  })

  it('goes back and forward, and something new drops the steps ahead', () => {
    start()
    view.openSession('s2', '/repo')
    view.openUsage()
    goBack(any)
    expect(state().main).toEqual(shown('s2'))
    goBack(any)
    expect(state().main).toEqual(shown('s1'))
    expect(state().history.back).toEqual([])
    expect(state().history.forward).toHaveLength(2)
    goForward(any)
    expect(state().main).toEqual(shown('s2'))
    goForward(any)
    expect(state().main).toEqual({ kind: 'usage' })
    goBack(any)
    view.openRoutines()
    expect(state().history.forward).toEqual([])
    expect(state().history.back).toHaveLength(2)
  })

  it('keeps at most 50 steps each way', () => {
    start(createLayout(session('s0')))
    for (let i = 1; i <= 60; i++) view.openSession(`s${i}`, '/repo')
    expect(state().history.back).toHaveLength(50)
    for (let i = 0; i < 60; i++) goBack(any)
    expect(state().main).toEqual(shown('s10'))
    expect(state().history.forward).toHaveLength(50)
  })

  it('skips a step whose view can no longer show', () => {
    start()
    view.openSession('s2', '/repo')
    view.openSession('s3', '/repo')
    goBack((v) => !(v.kind === 'session' && v.sessionId === 's2'))
    expect(state().main).toEqual(shown('s1'))
    expect(state().history.back).toEqual([])
    expect(state().history.forward).toHaveLength(1)
  })

  it('records no step when only the focus moves between panes', () => {
    const [first, second] = start(split())
    view.focusPane(first!)
    view.openSession('s2', '/repo')
    view.focusPane(first!)
    expect(state().layout.focus).toBe(first)
    expect(second).toBeDefined()
    expect(state().history.back).toEqual([])
  })

  it('puts a view back in its pane and gives that pane the focus', () => {
    const [first, second] = start(split())
    view.focusPane(second!)
    view.openSession('s3', '/repo')
    view.focusPane(first!)
    goBack(any)
    expect(findPane(state().layout, second!)?.view).toMatchObject({ sessionId: 's2' })
    expect(findPane(state().layout, first!)?.view).toMatchObject({ sessionId: 's1' })
    expect(state().layout.focus).toBe(second)
    expect(state().main).toEqual(shown('s2'))
    goForward(any)
    expect(findPane(state().layout, second!)?.view).toMatchObject({ sessionId: 's3' })
    expect(state().main).toEqual(shown('s3'))
  })

  it('shows the view in the pane in focus when its pane has closed', () => {
    const [, second] = start(split())
    view.focusPane(second!)
    view.openSession('s3', '/repo')
    view.closeSplitPane(second!)
    goBack(any)
    expect(allPanes(state().layout)).toHaveLength(1)
    expect(state().main).toEqual(shown('s2'))
  })

  it('focuses the pane that shows the session by now', () => {
    const [first, second] = start(split())
    view.focusPane(first!)
    view.openSession('s3', '/repo')
    view.openInSplit(session('s1'), 'right', { width: 1920, height: 1080 })
    const third = state().layout.focus
    view.focusPane(second!)
    goBack(any)
    expect(state().layout.focus).toBe(third)
    expect(state().main).toEqual(shown('s1'))
    expect(findPane(state().layout, first!)?.view).toMatchObject({ sessionId: 's3' })
  })

  it('leaves the split as it was under a page and back', () => {
    const [first] = start(split())
    view.focusPane(first!)
    const layout = state().layout
    view.openUsage()
    goBack(any)
    expect(state().layout).toEqual(layout)
    expect(state().main).toEqual(shown('s1'))
  })

  it('counts New session turned into its session as the same step', () => {
    start()
    view.openNewSession('/repo', null)
    view.showCreatedSession(state().layout.focus, 's9', '/repo')
    expect(state().main).toEqual(shown('s9'))
    expect(state().history.back).toHaveLength(1)
    goBack(any)
    expect(state().main).toEqual(shown('s1'))
  })

  it('counts New routine turned into its routine as the same step', () => {
    start()
    view.openRoutines()
    view.openRoutine(null)
    view.openRoutine('r1', { replace: true })
    expect(state().history.back).toHaveLength(2)
    goBack(any)
    expect(state().main).toEqual({ kind: 'routines' })
  })

  it("goes back as Settings' own back while Settings shows, and not forward", () => {
    start()
    view.openSession('s2', '/repo')
    goBack(any)
    view.openSettingsItem('agents', 'codex')
    goBack(any)
    expect(state().settings).toEqual({ open: true, section: 'agents', item: null })
    goForward(any)
    expect(state().settings.open).toBe(true)
    expect(state().main).toEqual(shown('s1'))
    goBack(any)
    expect(state().settings.open).toBe(false)
    expect(state().main).toEqual(shown('s1'))
    expect(state().history.forward).toHaveLength(1)
  })

  it("steps back for a page's own Back only when the step before leads there", () => {
    start()
    view.openArtifacts()
    view.openArtifact('a1')
    expect(stepBackTo({ kind: 'usage' }, any)).toBe(false)
    expect(state().main).toMatchObject({ kind: 'artifact', id: 'a1' })
    expect(stepBackTo({ kind: 'artifacts' }, any)).toBe(true)
    expect(state().main).toEqual({ kind: 'artifacts' })
    goForward(any)
    expect(state().main).toMatchObject({ kind: 'artifact', id: 'a1' })
  })
})
