import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'

const request = vi.fn()
vi.stubGlobal('window', {
  overbench: { agents: { request }, perf: false },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})

const { closeSession, createSession, newSession, retryPendingSession, usePendingSession } =
  await import('./actions')
const { NEW_SESSION_DRAFT, readDraft, writeDraft } =
  await import('@renderer/features/session/composer/drafts')
const { useSessionsStore } = await import('@renderer/stores/sessions')
const { useSettingsStore } = await import('@renderer/stores/settings')
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

describe('newSession', () => {
  beforeEach(() => {
    const settings = useSettingsStore.getState().settings
    useSettingsStore.setState({
      settings: { ...settings, general: { ...settings.general, defaultAgent: 'codex' } },
    })
  })

  it('opens New session with the default agent, in the selected project', () => {
    useViewStore.setState({ main: { kind: 'home' }, projectPath: '/repo' })
    newSession()
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', agentId: 'codex' },
      projectPath: '/repo',
    })
  })

  it('takes the project it is given, and keeps the agent chosen on a shown screen', () => {
    useViewStore.setState({ main: { kind: 'new', agentId: 'opencode' }, projectPath: '/repo' })
    newSession('/other')
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', agentId: 'opencode' },
      projectPath: '/other',
    })
  })
})

describe('createSession with a first message', () => {
  const created = (status: SessionSummary['status']) =>
    ({ id: 'n1', projectPath: '/repo', agentId: 'codex', status }) as SessionSummary

  beforeEach(() => {
    request.mockReset()
    usePendingSession.setState({ pending: null })
    useSessionsStore.setState({ byId: {} })
    useViewStore.setState({ main: { kind: 'new', agentId: 'codex' }, projectPath: '/repo' })
    writeDraft(NEW_SESSION_DRAFT, 'Fix the build')
  })

  it('sends it once the session exists, then shows the session with its thread loaded', async () => {
    let shownWhileLoading: string | null = null
    request.mockImplementation(async (method: string) => {
      if (method === 'sessions.create') return created('ready')
      if (method === 'sessions.open') shownWhileLoading = useViewStore.getState().main.kind
      return undefined
    })
    await createSession('codex', '/repo', null, 'Fix the build')
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'sessions.create',
      'sessions.prompt',
      'sessions.watch',
      'sessions.open',
    ])
    expect(request).toHaveBeenCalledWith('sessions.prompt', {
      sessionId: 'n1',
      content: [{ type: 'text', text: 'Fix the build' }],
    })
    expect(shownWhileLoading).toBe('new')
    expect(readDraft(NEW_SESSION_DRAFT)).toBe('')
    expect(readDraft('n1')).toBe('')
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 'n1' })
  })

  it("leaves it in the session's composer when the agent asks to sign in first", async () => {
    request.mockImplementation(async (method: string) =>
      method === 'sessions.create' ? created('auth_required') : undefined,
    )
    await createSession('codex', '/repo', null, 'Fix the build')
    expect(request).not.toHaveBeenCalledWith('sessions.prompt', expect.anything())
    expect(readDraft('n1')).toBe('Fix the build')
    expect(readDraft(NEW_SESSION_DRAFT)).toBe('')
  })

  it("leaves it in the session's composer when the agent turns it down", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    request.mockImplementation(async (method: string) => {
      if (method === 'sessions.create') return created('ready')
      throw new Error('The session is failed')
    })
    await createSession('codex', '/repo', null, 'Fix the build')
    expect(readDraft('n1')).toBe('Fix the build')
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 'n1' })
  })

  it('keeps it when the agent cannot start, and sends it after a retry', async () => {
    request.mockRejectedValueOnce(new Error('spawn failed'))
    await createSession('codex', '/repo', null, 'Fix the build')
    expect(usePendingSession.getState().pending).toMatchObject({ prompt: 'Fix the build' })
    expect(readDraft(NEW_SESSION_DRAFT)).toBe('Fix the build')

    request.mockImplementation(async (method: string) =>
      method === 'sessions.create' ? created('ready') : undefined,
    )
    retryPendingSession()
    await vi.waitFor(() =>
      expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 'n1' }),
    )
    expect(request).toHaveBeenCalledWith('sessions.prompt', expect.anything())
  })
})
