import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'

const request = vi.fn()
const openProject = vi.fn()
vi.stubGlobal('window', {
  overbench: { agents: { request }, dialogs: { openProject }, perf: false },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})

const {
  closeSession,
  createSession,
  deleteSession,
  followShownSession,
  newSession,
  newSessionInPlace,
  openProjectDialog,
  removeEmptySessions,
  retryPendingSession,
  sessionRemoved,
  startNewSession,
  usePendingSession,
} = await import('./actions')
const { clearDraft, draftedSessions, NEW_SESSION_DRAFT, readDraft, writeDraft } =
  await import('@renderer/features/session/composer/drafts')
const { pickOption, useAgentOptionsStore } = await import('@renderer/stores/agent-options')
const { useProjectsStore } = await import('@renderer/stores/projects')
const { useSessionsStore } = await import('@renderer/stores/sessions')
const { useSettingsStore } = await import('@renderer/stores/settings')
const { useThreadsStore } = await import('@renderer/stores/threads')
const { chooseNewSessionProject, openNewSubSession, useViewStore } =
  await import('@renderer/stores/view')

const summary = { id: 's1', projectPath: '/repo' } as SessionSummary
const scratch = { id: 'x1', projectPath: '/data/scratch/a', scratch: true } as SessionSummary

const setDefaultAgent = (defaultAgent: 'codex' | null) => {
  const settings = useSettingsStore.getState().settings
  useSettingsStore.setState({
    settings: { ...settings, general: { ...settings.general, defaultAgent } },
  })
}

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
    setDefaultAgent('codex')
    useSessionsStore.setState({ byId: { s1: summary } })
    useThreadsStore.setState({
      replicas: { s1: { ...replica, seq: 3 } },
    })
  })

  it('drops the replica, so opening the session again loads it afresh', async () => {
    useViewStore.setState({ main: { kind: 'usage' }, projectPath: '/repo' })
    await closeSession('s1')
    expect(request).toHaveBeenCalledWith('sessions.close', { sessionId: 's1' })
    expect(useThreadsStore.getState().replicas.s1).toBeUndefined()
    expect(useViewStore.getState().main).toEqual({ kind: 'usage' })
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
    expect(useViewStore.getState().main).toEqual({
      kind: 'new',
      agentId: 'codex',
      noProject: false,
    })
  })

  it('leaves the closed session for New session in its project when it was shown', async () => {
    useViewStore.setState({ main: { kind: 'session', sessionId: 's1' }, projectPath: '/other' })
    await closeSession('s1')
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', agentId: 'codex', noProject: false },
      projectPath: '/repo',
    })
  })

  it('leaves a closed scratch session for New session with No project', async () => {
    useSessionsStore.setState({ byId: { x1: scratch } })
    useViewStore.setState({
      main: { kind: 'session', sessionId: 'x1' },
      projectPath: scratch.projectPath,
    })
    await closeSession('x1')
    expect(useViewStore.getState().main).toEqual({ kind: 'new', agentId: 'codex', noProject: true })
  })
})

describe('a shown session that goes away', () => {
  let unfollow: () => void

  beforeEach(() => {
    request.mockReset()
    request.mockResolvedValue(undefined)
    setDefaultAgent('codex')
    useSessionsStore.setState({ byId: { s1: summary, x1: scratch } })
    unfollow = followShownSession()
    return () => unfollow()
  })

  it('leaves for New session in its project when it is deleted', async () => {
    useViewStore.setState({ main: { kind: 'session', sessionId: 's1' }, projectPath: '/repo' })
    await deleteSession('s1')
    expect(request).toHaveBeenCalledWith('sessions.delete', { sessionId: 's1' })
    expect(useSessionsStore.getState().byId.s1).toBeUndefined()
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', agentId: 'codex', noProject: false },
      projectPath: '/repo',
    })
  })

  it('leaves a deleted scratch session for New session with No project', async () => {
    useViewStore.setState({
      main: { kind: 'session', sessionId: 'x1' },
      projectPath: scratch.projectPath,
    })
    await deleteSession('x1')
    expect(useViewStore.getState().main).toEqual({ kind: 'new', agentId: 'codex', noProject: true })
  })

  it('leaves for New session when the agent host removes it, as with its parent', () => {
    const child = { id: 's2', projectPath: '/repo', parentId: 's1' } as SessionSummary
    useSessionsStore.getState().upsert(child)
    useViewStore.setState({ main: { kind: 'session', sessionId: 's2' }, projectPath: '/repo' })
    useSessionsStore.getState().remove('s2')
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', agentId: 'codex', noProject: false },
      projectPath: '/repo',
    })
  })

  it('leaves the view alone when another session goes', async () => {
    useViewStore.setState({ main: { kind: 'session', sessionId: 'x1' }, projectPath: '/repo' })
    await deleteSession('s1')
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 'x1' })
  })

  it('keeps Settings open when the session behind it goes', () => {
    const settings = { open: true, section: 'advanced', agent: null } as const
    useViewStore.setState({
      main: { kind: 'session', sessionId: 's1' },
      projectPath: '/repo',
      settings,
    })
    useSessionsStore.getState().remove('s1')
    expect(useViewStore.getState()).toMatchObject({ main: { kind: 'new' }, settings })
  })
})

describe('openProjectDialog', () => {
  beforeEach(() => {
    request.mockReset()
    openProject.mockReset()
    setDefaultAgent('codex')
    useProjectsStore.setState({ projects: [] })
    useViewStore.setState({ main: { kind: 'welcome' }, projectPath: null })
  })

  it('adds the folder and opens New session in it', async () => {
    openProject.mockResolvedValue('/new')
    request.mockImplementation(async (method: string) =>
      method === 'projects.add' ? { path: '/new', name: 'new', missing: false } : undefined,
    )
    await openProjectDialog()
    expect(useProjectsStore.getState().projects.map((p) => p.path)).toEqual(['/new'])
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', agentId: 'codex', noProject: false },
      projectPath: '/new',
    })
  })

  it('leaves the view alone when the dialog is cancelled', async () => {
    openProject.mockResolvedValue(null)
    await openProjectDialog()
    expect(request).not.toHaveBeenCalled()
    expect(useViewStore.getState().main).toEqual({ kind: 'welcome' })
  })
})

describe('newSession', () => {
  beforeEach(() => setDefaultAgent('codex'))

  it('opens New session with the default agent, in the selected project', () => {
    useViewStore.setState({ main: { kind: 'welcome' }, projectPath: '/repo' })
    newSession()
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', agentId: 'codex' },
      projectPath: '/repo',
    })
  })

  it('closes Settings when asked for, and leaves it open in place of a session', () => {
    const settings = { open: true, section: 'general', agent: null } as const
    useViewStore.setState({ main: { kind: 'welcome' }, projectPath: '/repo', settings })
    newSessionInPlace()
    expect(useViewStore.getState()).toMatchObject({ main: { kind: 'new' }, settings })
    newSession()
    expect(useViewStore.getState().settings.open).toBe(false)
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
    useViewStore.setState({ main: { kind: 'welcome' }, projectPath: '/repo' })
    newSession(null, true)
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', noProject: true },
      projectPath: '/repo',
    })

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

describe('createSession with start values', () => {
  const created = { id: 'n1', projectPath: '/repo', agentId: 'codex', status: 'ready' }

  beforeEach(() => {
    request.mockReset()
    usePendingSession.setState({ pending: null })
    useAgentOptionsStore.setState({ picks: {} })
  })

  it('sends them with the request, then lets the host remember what carries over', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'sessions.create' ? created : undefined,
    )
    pickOption('codex', 'model', 'gpt-5.5')
    await createSession('codex', '/repo', null, null, { model: 'gpt-5.5', mode: 'auto' })
    expect(request).toHaveBeenCalledWith('sessions.create', {
      agentId: 'codex',
      projectPath: '/repo',
      options: { model: 'gpt-5.5', mode: 'auto' },
    })
    expect(useAgentOptionsStore.getState().picks).toEqual({})
  })

  it('leaves them out when there are none, and keeps them for a retry', async () => {
    request.mockRejectedValueOnce(new Error('spawn failed'))
    pickOption('codex', 'model', 'gpt-5.5')
    await createSession('codex', '/repo', null, null, { model: 'gpt-5.5' })
    expect(usePendingSession.getState().pending?.options).toEqual({ model: 'gpt-5.5' })
    expect(useAgentOptionsStore.getState().picks.codex).toEqual({ model: 'gpt-5.5' })

    request.mockReset()
    request.mockImplementation(async (method: string) =>
      method === 'sessions.create' ? created : undefined,
    )
    retryPendingSession()
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('sessions.create', {
        agentId: 'codex',
        projectPath: '/repo',
        options: { model: 'gpt-5.5' },
      }),
    )

    request.mockClear()
    await createSession('codex', '/repo', null, null, {})
    expect(request).toHaveBeenCalledWith('sessions.create', {
      agentId: 'codex',
      projectPath: '/repo',
    })
  })
})

describe('New sub-session', () => {
  const parent = { id: 'p1', projectPath: '/repo', agentId: 'codex' } as SessionSummary
  const child = {
    id: 'c1',
    projectPath: '/repo',
    agentId: 'opencode',
    status: 'ready',
    parentId: 'p1',
  } as SessionSummary

  beforeEach(() => {
    request.mockReset()
    request.mockResolvedValue(undefined)
    usePendingSession.setState({ pending: null })
    useSessionsStore.setState({ byId: { p1: parent } })
    useViewStore.setState({
      main: { kind: 'session', sessionId: 'p1' },
      projectPath: '/other',
      settings: { open: true, section: 'general', agent: null },
    })
  })

  it("opens New session for it in the parent's project, and creates nothing yet", () => {
    openNewSubSession(parent, 'opencode')
    expect(useViewStore.getState()).toMatchObject({
      main: { kind: 'new', agentId: 'opencode', noProject: false, parentId: 'p1' },
      projectPath: '/repo',
      settings: { open: false },
    })
    expect(request).not.toHaveBeenCalled()
    expect(usePendingSession.getState().pending).toBeNull()
  })

  it('takes the agent the menu chose over the one New session shows', () => {
    useViewStore.setState({ main: { kind: 'new', agentId: 'codex', noProject: true } })
    openNewSubSession(parent, 'opencode')
    expect(useViewStore.getState().main).toEqual({
      kind: 'new',
      agentId: 'opencode',
      noProject: false,
      parentId: 'p1',
    })
  })

  it('creates the session under the parent with the first message, then shows it', async () => {
    openNewSubSession(parent, 'opencode')
    request.mockImplementation(async (method: string) =>
      method === 'sessions.create' ? child : undefined,
    )
    await startNewSession('opencode', '/repo', 'Write the tests', null)
    expect(request).toHaveBeenCalledWith('sessions.create', {
      agentId: 'opencode',
      projectPath: '/repo',
      parentId: 'p1',
    })
    expect(request).toHaveBeenCalledWith('sessions.prompt', {
      sessionId: 'c1',
      content: [{ type: 'text', text: 'Write the tests' }],
    })
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 'c1' })
  })

  it('starts a session of its own when New session opens again', async () => {
    openNewSubSession(parent, 'opencode')
    newSession('/repo')
    expect(useViewStore.getState().main).toEqual({
      kind: 'new',
      agentId: 'opencode',
      noProject: false,
    })
    request.mockImplementation(async (method: string) =>
      method === 'sessions.create' ? { ...child, parentId: null } : undefined,
    )
    await startNewSession('opencode', '/repo', 'Write the tests', null)
    expect(request).toHaveBeenCalledWith('sessions.create', {
      agentId: 'opencode',
      projectPath: '/repo',
    })
  })

  it('leaves for New session in its project when the parent goes', () => {
    const unfollow = followShownSession()
    openNewSubSession(parent, 'opencode')
    useSessionsStore.getState().remove('p1')
    unfollow()
    expect(useViewStore.getState()).toMatchObject({ projectPath: '/repo' })
    expect(useViewStore.getState().main).toEqual({
      kind: 'new',
      agentId: 'opencode',
      noProject: false,
    })
  })
})

describe('sessions the host removes', () => {
  beforeEach(() => {
    request.mockReset()
    request.mockResolvedValue(undefined)
    for (const id of draftedSessions()) clearDraft(id)
  })

  it('asks for the one-time removal keeping the sessions with a draft', async () => {
    writeDraft('d1', 'Fix the build')
    writeDraft('d2', ' \n ')
    writeDraft(NEW_SESSION_DRAFT, 'Something new')
    await removeEmptySessions()
    expect(request).toHaveBeenCalledWith('sessions.removeEmpty', { keep: ['d1'] })
  })

  it('takes one off the list with its replica and its draft', () => {
    useSessionsStore.setState({ byId: { s1: summary } })
    useThreadsStore.setState({ replicas: { s1: { ...replica, seq: 2 } } })
    writeDraft('s1', 'Unsent')
    sessionRemoved('s1')
    expect(useSessionsStore.getState().byId.s1).toBeUndefined()
    expect(useThreadsStore.getState().replicas.s1).toBeUndefined()
    expect(readDraft('s1')).toBe('')
  })
})
