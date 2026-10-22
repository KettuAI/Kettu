import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', { overbench: { perf: false } })

const {
  closeSettings,
  openAgentSettings,
  openProjectHome,
  openSession,
  openSettings,
  settingsBack,
  useViewStore,
} = await import('./view')

const settings = () => useViewStore.getState().settings

describe('settings view', () => {
  beforeEach(() => {
    useViewStore.setState({
      main: { kind: 'home' },
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

  it('keeps the section when a session or project home takes the window', () => {
    openSettings('terminal')
    openSession('s1', '/repo')
    expect(settings()).toEqual({ open: false, section: 'terminal', agent: null })
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 's1' })

    openSettings()
    openProjectHome('/repo')
    expect(settings()).toEqual({ open: false, section: 'terminal', agent: null })
    expect(useViewStore.getState().main).toEqual({ kind: 'home' })
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
