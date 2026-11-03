import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInfo } from '@shared/terminal-host'

const request = vi.fn()
const terminalRequest = vi.fn()
vi.stubGlobal('window', {
  kettu: {
    agents: { request },
    terminals: { request: terminalRequest },
    perf: false,
  },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})

const { openProjectTerminal } = await import('./project-menu-model')
const { openNewSession, openSettings, openUsage, shownSidePane, useViewStore } =
  await import('@renderer/stores/view')
const { useTerminalsStore } = await import('@renderer/stores/terminals')

const info = (id: string, projectPath: string): TerminalInfo => ({
  id,
  projectPath,
  shell: 'zsh',
  title: 'zsh',
  busy: false,
  exitCode: null,
  createdAt: 1,
})

const created = () => terminalRequest.mock.calls.filter(([method]) => method === 'terminals.create')
const shown = () => {
  const s = useViewStore.getState()
  return { kind: s.main.kind, projectPath: s.projectPath, pane: shownSidePane(s) }
}

beforeEach(() => {
  request.mockReset()
  terminalRequest.mockReset()
  terminalRequest.mockImplementation(async (method: string, params: { projectPath: string }) =>
    method === 'terminals.create' ? info('t-new', params.projectPath) : [],
  )
  useTerminalsStore.setState({ byId: {}, active: {}, order: {}, error: null })
  openNewSession('/repo', null)
  useViewStore.setState({ sidePane: {} })
})

describe('openProjectTerminal', () => {
  it('opens the pane beside the project already shown and leaves starting a terminal to it', async () => {
    await openProjectTerminal('/repo')
    expect(shown()).toEqual({ kind: 'new', projectPath: '/repo', pane: 'terminal' })
    expect(terminalRequest).not.toHaveBeenCalled()
  })

  it('shows another project first and starts its terminal when it has none', async () => {
    await openProjectTerminal('/other')
    expect(shown()).toEqual({ kind: 'new', projectPath: '/other', pane: 'terminal' })
    expect(created()).toEqual([
      ['terminals.create', expect.objectContaining({ projectPath: '/other' })],
    ])
  })

  it('starts none in another project that has terminals', async () => {
    terminalRequest.mockImplementation(async (method: string, params: { projectPath: string }) =>
      method === 'terminals.list' ? [info('t1', params.projectPath)] : info('t-new', '/other'),
    )
    await openProjectTerminal('/other')
    expect(shown().pane).toBe('terminal')
    expect(created()).toEqual([])
  })

  it('leaves a page or Settings for the project', async () => {
    openUsage()
    await openProjectTerminal('/repo')
    expect(shown()).toEqual({ kind: 'new', projectPath: '/repo', pane: 'terminal' })

    openSettings('archived')
    await openProjectTerminal('/repo')
    expect(useViewStore.getState().settings.open).toBe(false)
    expect(shown().pane).toBe('terminal')
  })
})
