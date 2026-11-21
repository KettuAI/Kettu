import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALREADY_ANSWERED, type HostEvent, type SessionSummary } from '@shared/agent-host'
import type { IslandState } from '@shared/island'
import type { ThreadEntry } from '@shared/thread'
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
  let onEvent: ((event: HostEvent) => void) | null = null
  let onClose: (() => void) | null = null
  const request = vi.fn(async (method: string, params: unknown) =>
    hostAnswer(sessions, entries, method, params),
  )
  const remoteCalls: [string, string, unknown][] = []
  const remoteOpen = new Set(remotes.map((remote) => remote.id))
  const deps: IslandBridgeDeps = {
    enabled: () => true,
    kindEnabled: () => true,
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

  it('sends the requests with the options the island may answer', async () => {
    const s = await answering()
    const requests = sentRequests(s)
    expect(requests.map((r) => [r.key, r.kind, r.options.map((o) => o.id)])).toEqual([
      ['s1#t1', 'permission', ['allow', 'deny']],
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
    expect(s.opened).toEqual([{ hostKey: 'local', sessionId: 's1' }, null])
  })

  it('pops what needs the user only while no window is in front', async () => {
    const s = setup([summary('s1')])
    await started(s)
    const attention = {
      type: 'host:attention' as const,
      sessionId: 's1',
      kind: 'turn-ended' as const,
      title: 'Done',
      body: 'kettu',
    }
    s.bridge.attention(attention)
    expect(s.helper().of('pop')).toEqual([
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
    expect(s.helper().of('change').at(-1)!.rows[0]!.parent).toEqual({ kind: 'task', title: null })
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
