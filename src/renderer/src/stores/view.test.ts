import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', { overbench: { perf: false } })

const {
  closeArtifact,
  closeSettings,
  openAgentSettings,
  openArtifact,
  openArtifacts,
  openNewSession,
  openSession,
  openSettings,
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
      settings: { open: false, section: null, agent: null },
    })
  })

  it('opens without a section the first time, which the page shows as General', () => {
    openSettings()
    expect(settings()).toEqual({ open: true, section: null, agent: null })
  })

  it('switches the page when opened at a section while already open', () => {
    openSettings('git')
    openSettings('agents')
    expect(settings()).toEqual({ open: true, section: 'agents', agent: null })
  })

  it('shows the section shown last when opened without one', () => {
    openSettings('about')
    closeSettings()
    expect(settings()).toEqual({ open: false, section: 'about', agent: null })
    openSettings()
    expect(settings()).toEqual({ open: true, section: 'about', agent: null })
  })

  it('keeps the section when a session or New session takes the window', () => {
    openSettings('terminal')
    openSession('s1', '/repo')
    expect(settings()).toEqual({ open: false, section: 'terminal', agent: null })
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 's1' })

    openSettings()
    openNewSession('/repo', null)
    expect(settings()).toEqual({ open: false, section: 'terminal', agent: null })
    expect(useViewStore.getState().main).toEqual({ kind: 'new', agentId: null, noProject: false })
  })

  it("opens an agent's page under Agents, and a section clears it", () => {
    openAgentSettings('codex')
    expect(settings()).toEqual({ open: true, section: 'agents', agent: 'codex' })
    openSettings('git')
    expect(settings()).toEqual({ open: true, section: 'git', agent: null })
  })

  it("comes back to the agent's page when opened without a section", () => {
    openAgentSettings('claude-code')
    closeSettings()
    openSettings()
    expect(settings()).toEqual({ open: true, section: 'agents', agent: 'claude-code' })
  })

  it("goes back from an agent's page to the list, then out of Settings", () => {
    openAgentSettings('opencode')
    settingsBack()
    expect(settings()).toEqual({ open: true, section: 'agents', agent: null })
    settingsBack()
    expect(settings()).toEqual({ open: false, section: 'agents', agent: null })
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
      settings: { open: true, section: 'git', agent: null },
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
