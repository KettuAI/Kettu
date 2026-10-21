import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'

const request = vi.fn()
vi.stubGlobal('window', {
  overbench: { agents: { request }, perf: false },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})

const { closeSession } = await import('./actions')
const { useSessionsStore } = await import('@renderer/stores/sessions')
const { useThreadsStore } = await import('@renderer/stores/threads')
const { useViewStore } = await import('@renderer/stores/view')

const summary = { id: 's1', projectPath: '/repo' } as SessionSummary

describe('closeSession', () => {
  beforeEach(() => {
    request.mockReset()
    request.mockResolvedValue(undefined)
    useSessionsStore.setState({ byId: { s1: summary } })
    useThreadsStore.setState({
      replicas: { s1: { state: null, seq: 3, status: 'ready', error: null } },
    })
  })

  it('drops the replica, so opening the session again loads it from the agent', async () => {
    useViewStore.setState({ main: { kind: 'home' }, projectPath: '/repo' })
    await closeSession('s1')
    expect(request).toHaveBeenCalledWith('sessions.close', { sessionId: 's1' })
    expect(useThreadsStore.getState().replicas.s1).toBeUndefined()
    expect(useViewStore.getState().main).toEqual({ kind: 'home' })
  })

  it('drops its sub-sessions too, which the agent host closes with it', async () => {
    const child = { id: 's2', projectPath: '/repo', parentId: 's1' } as SessionSummary
    useSessionsStore.setState({ byId: { s1: summary, s2: child } })
    useThreadsStore.setState({
      replicas: {
        s1: { state: null, seq: 3, status: 'ready', error: null },
        s2: { state: null, seq: 1, status: 'ready', error: null },
      },
    })
    useViewStore.setState({ main: { kind: 'session', sessionId: 's2' }, projectPath: '/repo' })
    await closeSession('s1')
    expect(useThreadsStore.getState().replicas).toEqual({})
    expect(useViewStore.getState().main).toEqual({ kind: 'home' })
  })

  it('leaves the closed session for its project home when it was shown', async () => {
    useViewStore.setState({ main: { kind: 'session', sessionId: 's1' }, projectPath: '/repo' })
    await closeSession('s1')
    expect(useViewStore.getState()).toMatchObject({ main: { kind: 'home' }, projectPath: '/repo' })
  })
})
