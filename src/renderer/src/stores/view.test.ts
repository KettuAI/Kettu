import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', { overbench: { perf: false } })

const { closeSettings, openProjectHome, openSession, openSettings, useViewStore } =
  await import('./view')

const settings = () => useViewStore.getState().settings

describe('settings view', () => {
  beforeEach(() => {
    useViewStore.setState({
      main: { kind: 'home' },
      projectPath: null,
      settings: { open: false, section: null },
    })
  })

  it('opens without a section the first time, which the page shows as General', () => {
    openSettings()
    expect(settings()).toEqual({ open: true, section: null })
  })

  it('switches the page when opened at a section while already open', () => {
    openSettings('git')
    openSettings('agents')
    expect(settings()).toEqual({ open: true, section: 'agents' })
  })

  it('shows the section shown last when opened without one', () => {
    openSettings('about')
    closeSettings()
    expect(settings()).toEqual({ open: false, section: 'about' })
    openSettings()
    expect(settings()).toEqual({ open: true, section: 'about' })
  })

  it('keeps the section when a session or project home takes the window', () => {
    openSettings('terminal')
    openSession('s1', '/repo')
    expect(settings()).toEqual({ open: false, section: 'terminal' })
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 's1' })

    openSettings()
    openProjectHome('/repo')
    expect(settings()).toEqual({ open: false, section: 'terminal' })
    expect(useViewStore.getState().main).toEqual({ kind: 'home' })
  })
})
