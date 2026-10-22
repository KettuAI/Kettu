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
const { chooseNewSessionProject, useViewStore } = await import('@renderer/stores/view')

const summary = { id: 's1', projectPath: '/repo' } as SessionSummary

const replica = {
  state: null,
  seq: 0,
  status: 'ready',
  error: null,
  older: null,
  loadingOlder: false,
  plan: null,
} as const

describe('closeSession', () => {
  beforeEach(() => {
    request.mockReset()
    request.mockResolvedValue(undefined)
    useSessionsStore.setState({ byId: { s1: summary } })
    useThreadsStore.setState({
      replicas: { s1: { ...replica, seq: 3 } },
    })
  })

  it('drops the replica, so opening the session again loads it afresh', async () => {
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
        s1: { ...replica, seq: 3 },
        s2: { ...replica, seq: 1 },
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
    useViewStore.setState({
      main: { kind: 'new', agentId: 'opencode', noProject: false },
      projectPath: '/repo',
    })
    newSession('/other')
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', agentId: 'opencode' },
      projectPath: '/other',
    })
  })
})

describe('New session with No project', () => {
  beforeEach(() => {
    request.mockReset()
    usePendingSession.setState({ pending: null })
    useSessionsStore.setState({ byId: {} })
  })

  it("starts there when asked, or when the selected folder is a scratch session's", () => {
    useViewStore.setState({ main: { kind: 'home' }, projectPath: '/repo' })
    newSession(null, true)
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', noProject: true },
      projectPath: '/repo',
    })

    const scratch = { id: 'x1', projectPath: '/data/scratch/a', scratch: true } as SessionSummary
    useSessionsStore.setState({ byId: { x1: scratch } })
    useViewStore.setState({
      main: { kind: 'session', sessionId: 'x1' },
      projectPath: scratch.projectPath,
    })
    newSession()
    expect(useViewStore.getState().main).toMatchObject({ kind: 'new', noProject: true })
  })

  it('switches between No project and a project', () => {
    useViewStore.setState({
      main: { kind: 'new', agentId: 'codex', noProject: false },
      projectPath: '/repo',
    })
    chooseNewSessionProject(null)
    expect(useViewStore.getState()).toMatchObject({
      main: { noProject: true },
      projectPath: '/repo',
    })
    newSession()
    expect(useViewStore.getState().main).toMatchObject({ noProject: true })
    chooseNewSessionProject('/other')
    expect(useViewStore.getState()).toMatchObject({
      main: { noProject: false },
      projectPath: '/other',
    })
  })

  it('creates the session without a folder and shows it in the one the host made', async () => {
    useViewStore.setState({
      main: { kind: 'new', agentId: 'codex', noProject: true },
      projectPath: '/repo',
    })
    const made = {
      id: 'x2',
      projectPath: '/data/scratch/b',
      scratch: true,
      agentId: 'codex',
      status: 'ready',
    } as SessionSummary
    request.mockImplementation(async (method: string) =>
      method === 'sessions.create' ? made : undefined,
    )
    const started = createSession('codex', null)
    expect(usePendingSession.getState().pending).toMatchObject({ projectPath: null })
    expect(useViewStore.getState().projectPath).toBe('/repo')
    await started
    expect(request).toHaveBeenCalledWith('sessions.create', { agentId: 'codex', projectPath: null })
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'session', sessionId: 'x2' },
      projectPath: '/data/scratch/b',
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
    useViewStore.setState({
      main: { kind: 'new', agentId: 'codex', noProject: false },
      projectPath: '/repo',
    })
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
