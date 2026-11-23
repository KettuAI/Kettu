import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALREADY_ANSWERED, type HostEvent, type SessionSummary } from '@shared/agent-host'
import type { IslandState } from '@shared/island'
import type { ThreadEntry } from '@shared/thread'
import type { UpdateStatus } from '@shared/updates'
import { COALESCE_MS, IslandBridge, type HelperProcess, type IslandBridgeDeps } from './bridge'
import { ISLAND_HOST_METHODS } from './host-feed'
import { ISLAND_PROTOCOL, type MainToIsland } from './protocol'

class FakeHelper implements HelperProcess {
  sent: MainToIsland[] = []
  killed = false
  private out: ((chunk: Uint8Array) => void) | null = null
  private exit: ((code: number | null, signal: string | null) => void) | null = null

  write(line: string): void {
    expect(line.endsWith('\n')).toBe(true)
    this.sent.push(JSON.parse(line) as MainToIsland)
  }
  unread(): number {
    return 0
  }
  onStdout(listener: (chunk: Uint8Array) => void): void {
    this.out = listener
  }
  onStderr(): void {}
  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exit = listener
  }
  kill(): void {
    if (this.killed) return
    this.killed = true
    this.exit?.(null, 'SIGKILL')
  }
  say(message: unknown): void {
    const text = typeof message === 'string' ? message : JSON.stringify(message)
    this.out!(new TextEncoder().encode(`${text}\n`))
  }
  die(): void {
    this.exit?.(1, null)
  }
  of<T extends MainToIsland['type']>(type: T): Extract<MainToIsland, { type: T }>[] {
    return this.sent.filter((m): m is Extract<MainToIsland, { type: T }> => m.type === type)
  }
}

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'fake-agent',
    projectPath: '/work/kettu',
    scratch: false,
    title: `Session ${id}`,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    origin: 'user',
    routine: null,
    description: null,
    missing: false,
    branch: null,
    pr: null,
    cache: null,
    model: null,
    pinnedAt: null,
    archivedAt: null,
    acpSessionId: null,
    ...over,
  }
}

const TOOL: ThreadEntry = {
  kind: 'tool',
  id: 't1',
  title: 'Run pnpm test',
  toolKind: 'execute',
  status: 'pending',
  content: [],
  locations: [],
  rawInput: 'pnpm test',
  permission: {
    requestId: 'r1',
    options: [
      { id: 'allow', name: 'Allow', kind: 'allow_once' },
      { id: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  },
  permissionResult: null,
}

const QUESTION: ThreadEntry = {
  ...TOOL,
  id: 't2',
  title: 'Ask',
  toolKind: 'other',
  question: 'Which one?',
  permission: {
    requestId: 'r2',
    options: [],
    questions: [
      {
        header: 'Pick',
        question: 'Which one?',
        multiSelect: false,
        options: [{ label: 'A' }, { label: 'B' }],
        allowsText: true,
        secret: false,
      },
    ],
  },
}

interface Setup {
  bridge: IslandBridge
  helpers: FakeHelper[]
  helper(): FakeHelper
  request: ReturnType<typeof vi.fn>
  emit(event: HostEvent): void
  states: IslandState[]
  opened: unknown[]
  actions: string[]
  closeHost(): void
  remoteCalls: [string, string, unknown][]
  remoteOpen: Set<string>
}

interface Remote {
  id: string
  name: string
  sessions: SessionSummary[]
  entries?: Record<string, ThreadEntry[]>
}

function hostAnswer(
  sessions: SessionSummary[],
  entries: Record<string, ThreadEntry[]>,
  method: string,
  params: unknown,
): unknown {
  switch (method) {
    case 'sessions.list':
      return sessions
    case 'agents.list':
    case 'agents.options':
      return []
    case 'tasks.list':
      return [{ id: 'task1', title: 'Ship the island' }]
    case 'sessions.requests': {
      const { sessionId } = params as { sessionId: string }
      const list = entries[sessionId] ?? []
      return { entries: list, askedAt: Object.fromEntries(list.map((e) => [e.id, 1000])) }
    }
    default:
      return undefined
  }
}

function setup(
  sessions: SessionSummary[],
  entries: Record<string, ThreadEntry[]> = {},
  remotes: Remote[] = [],
  over: Partial<IslandBridgeDeps> = {},
): Setup {
  const helpers: FakeHelper[] = []
  const states: IslandState[] = []
  const opened: unknown[] = []
  const actions: string[] = []
  let onEvent: ((event: HostEvent) => void) | null = null
  let onClose: (() => void) | null = null
  const request = vi.fn(async (method: string, params: unknown) =>
    hostAnswer(sessions, entries, method, params),
  )
  const remoteCalls: [string, string, unknown][] = []
  const remoteOpen = new Set(remotes.map((remote) => remote.id))
  const deps: IslandBridgeDeps = {
    enabled: () => true,
    allowed: () => true,
    windowFocused: () => false,
    colorMode: () => 'light',
    version: '0.1.13',
    locale: () => 'en',
    strings: () => ({ 'status.running': 'Running' }),
    spawn: async () => {
      const helper = new FakeHelper()
      helpers.push(helper)
      return helper
    },
    callRemote: async (hostId, method, params) => {
      remoteCalls.push([hostId, method, params])
      const remote = remotes.find((r) => r.id === hostId)
      if (!remote || !remoteOpen.has(hostId)) {
        throw { code: 'host_offline', message: 'The host is not connected' }
      }
      return hostAnswer(remote.sessions, remote.entries ?? {}, method, params)
    },
    openRemotes: () => [...remoteOpen],
    connectLocal: (event, close) => {
      onEvent = event
      onClose = close
      return { request: request as never, close: () => onClose?.() }
    },
    open: (target) => opened.push(target),
    updateStatus: () => null,
    noticeAction: (action) => actions.push(action),
    status: (state) => states.push(state),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => Date.now(),
    ...over,
  }
  const bridge = new IslandBridge(deps)
  bridge.remoteHosts(remotes.map(({ id, name }) => ({ id, name })))
  return {
    bridge,
    helpers,
    helper: () => helpers.at(-1)!,
    request,
    emit: (event) => onEvent!(event),
    states,
    opened,
    actions,
    closeHost: () => onClose!(),
    remoteCalls,
    remoteOpen,
  }
}

/** Starts the bridge and has the helper say it is ready; resolves once the host was read. */
async function started(s: Setup): Promise<void> {
  s.bridge.firstWindowShown()
  await vi.advanceTimersByTimeAsync(0)
  s.helper().say({ type: 'ready', protocol: ISLAND_PROTOCOL, version: '0.1.0' })
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  // An hour after the fixtures' sessions were used, so they count as used within the last day.
  vi.setSystemTime(60 * 60_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('handshake', () => {
  it('says hello first and sends the view only once the helper is ready', async () => {
    const s = setup([summary('s1', { status: 'running', attention: 'none' })])
    s.bridge.firstWindowShown()
    await vi.advanceTimersByTimeAsync(0)
    const [hello] = s.helper().sent
    expect(hello).toMatchObject({ type: 'hello', protocol: ISLAND_PROTOCOL, version: '0.1.13' })
    expect(hello).toMatchObject({ strings: { 'status.running': 'Running' } })
    expect(s.helper().of('view')).toEqual([])
    expect(s.bridge.showing()).toBe(false)

    s.helper().say({ type: 'ready', protocol: ISLAND_PROTOCOL, version: '0.1.0' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.bridge.state()).toEqual({ state: 'running' })
    expect(s.bridge.showing()).toBe(true)
    const views = s.helper().of('view')
    expect(views.at(-1)?.rows.map((row) => row.sessionId)).toEqual(['s1'])
    expect(views.map((view) => view.seq)).toEqual(views.map((_, i) => i + 1))
  })

  it('quiets notifications only while it runs: off, or stopped, they come back', async () => {
    let enabled = true
    const s = setup([], {}, [], { enabled: () => enabled })
    await started(s)
    expect(s.bridge.showing()).toBe(true)
    enabled = false
    s.bridge.settingsChanged()
    expect(s.bridge.showing()).toBe(false)
    enabled = true
    s.bridge.settingsChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.bridge.showing()).toBe(false)
    s.helper().say({ type: 'ready', protocol: ISLAND_PROTOCOL, version: '0.1.0' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.bridge.showing()).toBe(true)
  })

  it('stops for good on another protocol version, sending nothing more', async () => {
    const s = setup([summary('s1')])
    s.bridge.firstWindowShown()
    await vi.advanceTimersByTimeAsync(0)
    s.helper().say({ type: 'ready', protocol: ISLAND_PROTOCOL + 1, version: '9' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(s.bridge.state()).toEqual({ state: 'failed', reason: 'protocol' })
    expect(s.bridge.showing()).toBe(false)
    expect(s.helper().killed).toBe(true)
    expect(s.helper().sent.map((m) => m.type)).toEqual(['hello'])
    expect(s.helpers).toHaveLength(1)
  })

  it('ignores what the helper says before it is ready', async () => {
    const s = setup([summary('s1')])
    s.bridge.firstWindowShown()
    await vi.advanceTimersByTimeAsync(0)
    s.helper().say({ type: 'open', row: 's1' })
    s.helper().say({ type: 'resync' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.opened).toEqual([])
    expect(s.helper().of('view')).toEqual([])
  })

  it('does not start before the first window shows', async () => {
    const s = setup([])
    s.bridge.settingsChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.helpers).toEqual([])
  })
})

describe('changes', () => {
  it('merges what changes within the window into one change, numbered after the last', async () => {
    const s = setup([summary('s1'), summary('s2')])
    await started(s)
    const last = s.helper().of('view').at(-1)!.seq
    s.emit({ type: 'session.summary', summary: summary('s1', { status: 'running' }) })
    await vi.advanceTimersByTimeAsync(COALESCE_MS / 2)
    s.emit({ type: 'session.summary', summary: summary('s2', { status: 'running' }) })
    expect(s.helper().of('change')).toEqual([])
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    const changes = s.helper().of('change')
    expect(changes).toHaveLength(1)
    expect(changes[0]!.seq).toBe(last + 1)
    expect(changes[0]!.rows.map((row) => row.status)).toEqual(['running', 'running'])
    expect(changes[0]!.summary).toMatchObject({ running: 2 })

    s.emit({ type: 'session.removed', sessionId: 's2' })
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    const next = s.helper().of('change')[1]!
    expect(next.seq).toBe(last + 2)
    expect(next.removedRows).toEqual(['s2'])
  })

  it('names the menu bar panel’s group of each row, the idle ones last', async () => {
    const s = setup([
      summary('idle'),
      summary('done', { attention: 'unread' }),
      summary('run', { status: 'running' }),
      summary('ask', { status: 'awaiting_permission' }),
    ])
    await started(s)
    const rows = s.helper().of('view').at(-1)!.rows
    expect(rows.map((row) => [row.sessionId, row.group])).toEqual([
      ['ask', 'needs_you'],
      ['run', 'running'],
      ['done', 'finished'],
      ['idle', 'idle'],
    ])
  })

  it('names the plan step a row is on, as the plan chip does', async () => {
    const plan = (done: number, current: { index: number; text: string } | null) => ({
      done,
      total: 4,
      current,
    })
    const s = setup([
      summary('first', { status: 'running', plan: plan(0, { index: 0, text: 'Read' }) }),
      summary('between', { status: 'running', plan: plan(1, null) }),
      summary('all', { status: 'running', plan: plan(4, null) }),
    ])
    await started(s)
    const rows = s.helper().of('view').at(-1)!.rows
    expect(rows.map((row) => [row.sessionId, row.plan?.done, row.plan?.step])).toEqual([
      ['first', 0, 1],
      ['between', 1, 2],
      ['all', 4, 4],
    ])
  })

  it('sends nothing when nothing it shows changed', async () => {
    const s = setup([summary('s1')])
    await started(s)
    const count = s.helper().sent.length
    s.emit({ type: 'session.summary', summary: summary('s1') })
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2)
    expect(s.helper().sent).toHaveLength(count)
  })

  it('sends the whole view, numbered on, when the helper lost a change', async () => {
    const s = setup([summary('s1')])
    await started(s)
    const last = s.helper().of('view').at(-1)!.seq
    s.helper().say({ type: 'resync' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.helper().of('view').at(-1)!.seq).toBe(last + 1)
  })

  it('reads a session again whole after this computer’s host restarted', async () => {
    const s = setup([summary('s1')])
    await started(s)
    const views = s.helper().of('view').length
    s.closeHost()
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(s.helper().of('change').at(-1)?.removedRows).toEqual(['s1'])
    s.bridge.localHostReady()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.helper().of('view')).toHaveLength(views + 1)
    expect(
      s
        .helper()
        .of('view')
        .at(-1)!
        .rows.map((row) => row.sessionId),
    ).toEqual(['s1'])
  })
})

describe('sub-agents', () => {
  const child = (
    id: string,
    status: SessionSummary['status'],
    over: Partial<SessionSummary> = {},
  ) => summary(id, { origin: 'subagent', parentId: 'p', status, ...over })

  it('counts a session’s own sub-agents at work as the sidebar badge does', async () => {
    const s = setup([
      summary('p', { status: 'running' }),
      summary('quiet'),
      child('c1', 'running'),
      child('c2', 'starting'),
      child('c3', 'awaiting_permission'),
      child('done', 'ready'),
      child('failed', 'failed'),
      child('gone', 'running', { archivedAt: 5 }),
      summary('grandchild', { origin: 'subagent', parentId: 'c1', status: 'running' }),
    ])
    await started(s)
    const rows = s.helper().of('view').at(-1)!.rows
    // Sub-agents are no rows of their own.
    expect(rows.map((row) => row.sessionId).sort()).toEqual(['p', 'quiet'])
    expect(rows.find((row) => row.sessionId === 'p')?.subagents).toMatchObject({ running: 3 })
    expect(rows.find((row) => row.sessionId === 'quiet')?.subagents).toBeNull()
  })

  it('changes the row of the session when one of its sub-agents starts or ends', async () => {
    const s = setup([summary('p', { status: 'running' })])
    await started(s)
    s.emit({ type: 'session.summary', summary: child('c1', 'starting') })
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(s.helper().of('change').at(-1)!.rows[0]).toMatchObject({
      sessionId: 'p',
      subagents: { running: 1 },
    })
    s.emit({ type: 'session.summary', summary: child('c1', 'ready') })
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(s.helper().of('change').at(-1)!.rows[0]).toMatchObject({
      sessionId: 'p',
      subagents: null,
    })
  })

  it('shows none for a host that is not connected', async () => {
    const studio = 'b'.repeat(32)
    const s = setup([], {}, [
      {
        id: studio,
        name: 'Studio',
        sessions: [summary('p', { status: 'running' }), child('c1', 'running')],
      },
    ])
    await started(s)
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    const rowOf = () =>
      [
        ...s.helper().of('view').at(-1)!.rows,
        ...s
          .helper()
          .of('change')
          .flatMap((change) => change.rows),
      ]
        .filter((row) => row.sessionId === 'p')
        .at(-1)
    expect(rowOf()?.subagents).toMatchObject({ running: 1 })
    s.remoteOpen.delete(studio)
    s.bridge.remoteClosed(studio)
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(rowOf()?.subagents).toBeNull()
  })
})

describe('answers', () => {
  const waiting = summary('s1', {
    status: 'awaiting_permission',
    attention: 'permission',
    permissionCount: 2,
  })

  async function answering(): Promise<Setup> {
    const s = setup([waiting], { s1: [TOOL, QUESTION] })
    await started(s)
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    return s
  }

  function sentRequests(s: Setup) {
    const view = s.helper().of('view').at(-1)!
    const changes = s.helper().of('change')
    return [...view.requests, ...changes.flatMap((change) => change.requests)]
  }

  it('sends the requests with the options the island may answer, in the card’s order', async () => {
    const s = await answering()
    const requests = sentRequests(s)
    expect(requests.map((r) => [r.key, r.kind, r.options.map((o) => o.id)])).toEqual([
      ['s1#t1', 'permission', ['deny', 'allow']],
      ['s1#t2', 'question', ['q0', 'q1']],
    ])
    expect(requests[0]).toMatchObject({ lines: ['pnpm test'], code: true, askedAt: 1000 })
  })

  it('answers a request it sent with one of its options, as the host takes it', async () => {
    const s = await answering()
    s.helper().say({ type: 'answer', id: 'a1', request: 's1#t1', option: 'allow' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.request).toHaveBeenCalledWith('permissions.respond', {
      sessionId: 's1',
      requestId: 'r1',
      optionId: 'allow',
    })
    s.helper().say({ type: 'answer', id: 'a2', request: 's1#t2', option: 'q1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.request).toHaveBeenCalledWith('permissions.respond', {
      sessionId: 's1',
      requestId: 'r2',
      answers: [{ question: 0, choices: [1] }],
    })
    expect(s.helper().of('answered')).toEqual([
      { type: 'answered', id: 'a1', result: 'answered' },
      { type: 'answered', id: 'a2', result: 'answered' },
    ])
  })

  it('sends the card’s three answers alone, and refuses the others, as for a Kettu tool', async () => {
    const tool: ThreadEntry = {
      ...TOOL,
      id: 't3',
      title: 'mcp__kettu__terminal_run',
      toolKind: 'other',
      // As Claude Code's host keeps it: the command alone.
      rawInput: 'sleep 40 && echo done',
      permission: {
        requestId: 'r3',
        options: [
          { id: 'once', name: 'Yes', kind: 'allow_once' },
          { id: 'project', name: 'Yes, and always allow it in this project', kind: 'allow_always' },
          { id: 'session', name: 'Yes, for this session', kind: 'allow_always' },
          { id: 'no', name: 'Deny, and say what to do instead', kind: 'reject_once' },
          { id: 'never', name: 'Never', kind: 'reject_always' },
        ],
      },
    }
    const s = setup([{ ...waiting, permissionCount: 1 }], { s1: [tool] })
    await started(s)
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    const [request] = sentRequests(s)
    expect(request).toMatchObject({
      title: 'Run in terminal',
      lines: ['sleep 40 && echo done'],
      code: true,
      options: [
        { id: 'no', label: 'Deny', style: 'deny' },
        { id: 'once', label: 'Allow once', style: 'allow_once' },
        { id: 'project', label: 'Always allow', style: 'allow_always' },
      ],
    })
    const calls = s.request.mock.calls.length
    s.helper().say({ type: 'answer', id: 'a1', request: 's1#t3', option: 'session' })
    s.helper().say({ type: 'answer', id: 'a2', request: 's1#t3', option: 'never' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.request.mock.calls).toHaveLength(calls)
    expect(
      s
        .helper()
        .of('answered')
        .map((m) => m.result),
    ).toEqual(['failed', 'failed'])
  })

  it('refuses a request or option it never sent without calling the host', async () => {
    const s = await answering()
    const calls = s.request.mock.calls.length
    s.helper().say({ type: 'answer', id: 'a1', request: 's1#nope', option: 'allow' })
    s.helper().say({ type: 'answer', id: 'a2', request: 's1#t1', option: 'allow_always' })
    s.helper().say({ type: 'answer', id: 'a3', request: 's9#t1', option: 'allow' })
    s.helper().say({ type: 'answer', id: 'a4', request: 's1#t2', option: 'q7' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.request.mock.calls).toHaveLength(calls)
    expect(
      s
        .helper()
        .of('answered')
        .map((m) => [m.id, m.result]),
    ).toEqual([
      ['a1', 'failed'],
      ['a2', 'failed'],
      ['a3', 'failed'],
      ['a4', 'failed'],
    ])
  })

  it('says a request was answered elsewhere when the host had it answered first', async () => {
    const s = await answering()
    s.request.mockImplementationOnce(async () => {
      throw { code: 'not_found', message: 'Answered', data: { reason: ALREADY_ANSWERED } }
    })
    s.helper().say({ type: 'answer', id: 'a1', request: 's1#t1', option: 'deny' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.helper().of('answered')).toEqual([{ type: 'answered', id: 'a1', result: 'elsewhere' }])
  })

  it('says so, without calling the host, for a request that no longer waits', async () => {
    const s = await answering()
    s.emit({
      type: 'session.summary',
      summary: { ...waiting, status: 'running', attention: 'none', permissionCount: 0 },
    })
    const calls = s.request.mock.calls.length
    s.helper().say({ type: 'answer', id: 'a1', request: 's1#t1', option: 'allow' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.request.mock.calls).toHaveLength(calls)
    expect(s.helper().of('answered')).toEqual([{ type: 'answered', id: 'a1', result: 'elsewhere' }])
  })
})

describe('opens and pops', () => {
  it('opens only the rows it sent, and Kettu itself for none', async () => {
    const s = setup([summary('s1')])
    await started(s)
    s.helper().say({ type: 'open', row: 's1' })
    s.helper().say({ type: 'open', row: 'other' })
    s.helper().say({ type: 'open', row: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.opened).toEqual([{ kind: 'session', hostKey: 'local', sessionId: 's1' }, null])
  })

  it('opens only what a request it sent belongs to, a task’s included', async () => {
    const s = setup([summary('s1')])
    s.request.mockImplementation(async (method: string, params: unknown) =>
      method === 'tasks.list'
        ? [
            {
              id: 'task1',
              title: 'Ship the island',
              status: 'running',
              needsYou: true,
              archivedAt: null,
              updatedAt: 5,
              steps: [{ id: 'review', name: 'Review', state: 'needs_you', sessionId: null }],
            },
          ]
        : hostAnswer([summary('s1')], {}, method, params),
    )
    await started(s)
    const request = s.helper().of('view').at(-1)!.requests[0]!
    expect(request).toMatchObject({
      key: 'task:local/task1',
      row: null,
      task: { title: 'Ship the island', step: 'Review' },
      options: [],
    })
    s.helper().say({ type: 'openRequest', request: 'task:local/other' })
    s.helper().say({ type: 'openRequest', request: request.key })
    s.helper().say({ type: 'newSession' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.opened).toEqual([
      { kind: 'task', hostKey: 'local', taskId: 'task1' },
      { kind: 'new-session' },
    ])
  })

  it('pops what needs the user unless a window in front shows that session', async () => {
    let focused = false
    const s = setup([summary('s1')], {}, [], { windowFocused: () => focused })
    await started(s)
    const attention = (any: boolean) => ({
      type: 'host:attention' as const,
      sessionId: 's1',
      kind: 'turn-ended' as const,
      title: 'Done',
      body: 'kettu',
      front: { any, devices: [] },
    })
    s.bridge.attention(attention(true))
    focused = true
    s.bridge.attention(attention(false))
    s.bridge.attention(attention(true))
    expect(s.helper().of('pop')).toEqual([
      { type: 'pop', row: 's1', kind: 'turn-ended', title: 'Done', body: 'kettu' },
      { type: 'pop', row: 's1', kind: 'turn-ended', title: 'Done', body: 'kettu' },
    ])
  })

  it('leaves a workflow task to its notification, popping nothing for it', async () => {
    const s = setup([summary('s1')])
    await started(s)
    const task = {
      kind: 'task-ended' as const,
      taskId: 'task1',
      sessionId: 's1',
      title: 'Ship the island',
      body: 'Done',
    }
    s.bridge.attention(task)
    expect(s.helper().of('pop')).toEqual([])
    expect(s.bridge.shows(task)).toBe(false)
    expect(s.bridge.shows({ kind: 'turn-ended', sessionId: 's1', title: 'Done', body: '' })).toBe(
      true,
    )
  })
})

describe('notices', () => {
  it('acts only on the notices and pops it sent', async () => {
    const status: UpdateStatus = {
      state: { kind: 'ready', version: '0.2.0' },
      mode: 'install',
      readOnly: false,
      current: '0.1.13',
      updatedFrom: null,
      dismissed: null,
      restartWhenIdle: null,
    }
    const s = setup([summary('s1')], {}, [], { updateStatus: () => status })
    await started(s)
    expect(
      s
        .helper()
        .of('view')
        .at(-1)!
        .notices.map((notice) => notice.key),
    ).toEqual(['app-update'])
    s.bridge.attention({
      kind: 'plan-limit',
      agentId: 'claude-code',
      level: 'near',
      key: 'claude-code:me@example.com:five_hour',
      usedPercent: 92,
      title: '5-hour limit 92% used',
      body: 'Claude Max',
    })
    const pop = s.helper().of('pop').at(-1)!
    expect(pop).toMatchObject({ row: null, kind: 'limit-near', percent: 92 })
    s.helper().say({ type: 'notice', notice: 'app-update' })
    s.helper().say({ type: 'notice', notice: pop.action! })
    s.helper().say({ type: 'notice', notice: 'pop:999' })
    s.helper().say({ type: 'notice', notice: 'limit' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.actions).toEqual(['restart', 'usage'])
  })
})

describe('a helper that fails', () => {
  it('starts again after a crash, and stays off after three within a minute', async () => {
    const s = setup([])
    await started(s)
    s.helper().die()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(s.helpers).toHaveLength(2)
    s.helper().die()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(s.helpers).toHaveLength(3)
    s.helper().die()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.helpers).toHaveLength(3)
    expect(s.bridge.state()).toEqual({ state: 'failed', reason: 'crashed' })
    expect(s.bridge.showing()).toBe(false)

    s.bridge.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.helpers).toHaveLength(4)
  })

  it('starts again once it keeps sending what main cannot take', async () => {
    const s = setup([])
    await started(s)
    for (let i = 0; i < 4; i++) s.helper().say('not json')
    expect(s.helper().killed).toBe(false)
    s.helper().say({ type: 'request', method: 'sessions.show' })
    expect(s.helpers[0]!.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(s.helpers).toHaveLength(2)
  })

  it('ends a helper that never answers its hello', async () => {
    const s = setup([])
    s.bridge.firstWindowShown()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.helpers[0]!.killed).toBe(true)
  })
})

describe('workflow steps', () => {
  it('names the task a step’s row belongs to, and follows its title', async () => {
    const step = summary('s1', {
      origin: 'task',
      task: { taskId: 'task1', stepId: 'build', roundId: 'r1' },
      status: 'running',
    })
    const s = setup([step])
    await started(s)
    expect(s.request).toHaveBeenCalledWith('tasks.list', undefined)
    expect(s.helper().of('view').at(-1)!.rows[0]!.parent).toEqual({
      kind: 'task',
      title: 'Ship the island',
    })

    s.emit({
      type: 'task.changed',
      task: { id: 'task1', title: 'Ship the Dynamic Island' } as never,
    })
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(s.helper().of('change').at(-1)!.rows[0]!.parent).toEqual({
      kind: 'task',
      title: 'Ship the Dynamic Island',
    })

    s.emit({ type: 'task.removed', taskId: 'task1' })
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(s.helper().of('change').at(-1)!.rows[0]!.parent).toEqual({
      kind: 'task',
      title: null,
    })
  })

  it('reads a host that has no tasks', async () => {
    const s = setup([summary('s1')])
    s.request.mockImplementation(async (method: string) => {
      if (method === 'tasks.list') throw { code: 'unknown_method', message: 'Unknown' }
      return method === 'sessions.list' ? [summary('s1')] : []
    })
    await started(s)
    expect(
      s
        .helper()
        .of('view')
        .at(-1)!
        .rows.map((row) => row.sessionId),
    ).toEqual(['s1'])
  })
})

describe('other hosts', () => {
  const studio = 'a'.repeat(32)
  const waiting = summary('r1', {
    title: 'Deploy',
    status: 'awaiting_permission',
    attention: 'permission',
    permissionCount: 1,
    updatedAt: 5,
  })

  function current(s: Setup) {
    const view = s.helper().of('view').at(-1)!
    const rows = new Map(view.rows.map((row) => [row.key, row]))
    const requests = new Map(view.requests.map((request) => [request.key, request]))
    for (const change of s
      .helper()
      .of('change')
      .filter((c) => c.seq > view.seq)) {
      for (const key of change.removedRows) rows.delete(key)
      for (const row of change.rows) rows.set(row.key, row)
      for (const key of change.removedRequests) requests.delete(key)
      for (const request of change.requests) requests.set(request.key, request)
    }
    return { rows: [...rows.values()], requests: [...requests.values()] }
  }

  async function withStudio(): Promise<Setup> {
    const s = setup([summary('s1')], {}, [
      { id: studio, name: 'Studio', sessions: [waiting], entries: { r1: [TOOL] } },
    ])
    await started(s)
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    return s
  }

  it('lists their sessions like this computer’s, each row naming its host', async () => {
    const s = await withStudio()
    const { rows, requests } = current(s)
    expect(rows.map((row) => [row.key, row.host])).toEqual([
      [`${studio}/r1`, { id: studio, name: 'Studio', offline: false }],
      ['s1', null],
    ])
    expect(requests.map((request) => request.key)).toEqual([`${studio}/r1#t1`])
  })

  it('marks a host’s rows offline while it is not connected, without its requests', async () => {
    const s = await withStudio()
    s.remoteOpen.delete(studio)
    s.bridge.remoteClosed(studio)
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    let view = current(s)
    expect(view.rows.find((row) => row.key === `${studio}/r1`)?.host?.offline).toBe(true)
    expect(view.requests).toEqual([])

    s.remoteOpen.add(studio)
    s.bridge.remoteOpened(studio)
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    view = current(s)
    expect(view.rows.find((row) => row.key === `${studio}/r1`)?.host?.offline).toBe(false)
    expect(view.requests.map((request) => request.key)).toEqual([`${studio}/r1#t1`])
  })

  it('answers a host’s request on that host, with the island’s methods alone', async () => {
    const s = await withStudio()
    s.helper().say({ type: 'answer', id: 'a1', request: `${studio}/r1#t1`, option: 'allow' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.remoteCalls).toContainEqual([
      studio,
      'permissions.respond',
      { sessionId: 'r1', requestId: 'r1', optionId: 'allow' },
    ])
    expect(s.helper().of('answered')).toEqual([{ type: 'answered', id: 'a1', result: 'answered' }])
    for (const [, method] of s.remoteCalls) {
      expect(ISLAND_HOST_METHODS as readonly string[]).toContain(method)
    }
    expect(s.request).not.toHaveBeenCalledWith('permissions.respond', expect.anything())
  })

  it('follows a host’s events, and pops what needs the user there', async () => {
    const s = await withStudio()
    s.bridge.remoteEvent(studio, {
      type: 'session.summary',
      summary: { ...waiting, status: 'running', attention: 'none', permissionCount: 0 },
    })
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(current(s).rows.find((row) => row.key === `${studio}/r1`)?.status).toBe('running')

    s.bridge.remoteAttention(studio, {
      kind: 'error',
      sessionId: 'r1',
      title: 'Deploy failed',
      body: 'x',
    })
    s.bridge.remoteAttention(studio, { kind: 'error', title: 1 })
    s.bridge.remoteAttention(studio, null)
    s.bridge.remoteAttention('b'.repeat(32), {
      kind: 'error',
      sessionId: 'r1',
      title: 'Unknown host',
      body: '',
    })
    expect(s.helper().of('pop')).toEqual([
      { type: 'pop', row: `${studio}/r1`, kind: 'error', title: 'Deploy failed', body: 'x' },
    ])
  })

  it('ignores a summary it cannot read rather than breaking the view', async () => {
    const s = await withStudio()
    const count = s.helper().sent.length
    s.bridge.remoteEvent(studio, { type: 'session.summary', summary: { id: 7 } })
    s.bridge.remoteEvent(studio, { type: 'session.summary', summary: null })
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(s.helper().sent).toHaveLength(count)
  })

  it('names the task of a host’s step, read from that host', async () => {
    const step = summary('r2', {
      origin: 'task',
      task: { taskId: 'task1', stepId: 'build', roundId: 'x' },
      status: 'running',
    })
    const s = setup([], {}, [{ id: studio, name: 'Studio', sessions: [step] }])
    await started(s)
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(s.remoteCalls).toContainEqual([studio, 'tasks.list', undefined])
    const row = () => current(s).rows.find((r) => r.key === `${studio}/r2`)
    expect(row()?.parent).toEqual({ kind: 'task', title: 'Ship the island' })
    s.bridge.remoteEvent(studio, { type: 'task.changed', task: { id: 'task1', title: 'Renamed' } })
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(row()?.parent).toEqual({ kind: 'task', title: 'Renamed' })
  })

  it('drops a host that is no longer known', async () => {
    const s = await withStudio()
    s.bridge.remoteHosts([])
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(current(s).rows.map((row) => row.key)).toEqual(['s1'])
  })
})
