import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALREADY_ANSWERED,
  type AgentStatus,
  type HostEvent,
  type SessionSummary,
} from '@shared/agent-host'
import type { ThreadEntry } from '@shared/thread'
import type { SessionDetail } from '@renderer/features/tray/model'

const api = vi.hoisted(() => ({
  request: vi.fn(),
  hide: vi.fn(),
  listeners: [] as ((event: HostEvent) => void)[],
  shown: [] as (() => void)[],
}))

vi.stubGlobal('window', {
  kettu: {
    agents: {
      request: api.request,
      onEvent: (listener: (event: HostEvent) => void) => api.listeners.push(listener),
      onConnection: () => {},
    },
    remote: { status: () => Promise.resolve(null), onChanged: () => {} },
    tray: { hide: api.hide, onShown: (listener: () => void) => api.shown.push(listener) },
  },
})
// The panel reads threads only while it shows; most of these tests keep it hidden.
const page = vi.hoisted(() => ({ visibilityState: 'hidden', addEventListener: () => {} }))
vi.stubGlobal('document', page)

const { answer, initTrayPanel, useTrayPanelStore } = await import('./tray-panel')

function session(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'claude-code',
    projectPath: '/p',
    scratch: false,
    title: id,
    status: 'awaiting_permission',
    attention: 'permission',
    permissionCount: 1,
    createdAt: 0,
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
    ...patch,
  }
}

const request = {
  kind: 'tool' as const,
  entryId: 'e1',
  tool: { toolKind: 'execute' as const, title: 'Run ls', locations: [], rawInput: 'ls' },
  permission: { requestId: 'r1', options: [] },
}

function detail(requests: SessionDetail['requests']): SessionDetail {
  return {
    readAt: 1,
    readRequests: requests.length,
    requests,
    activity: null,
    turnStartedAt: null,
    files: 0,
  }
}

function emit(event: HostEvent): void {
  for (const listener of api.listeners) listener(event)
}

beforeAll(async () => {
  await initTrayPanel()
})

beforeEach(() => {
  api.request.mockReset()
  api.hide.mockReset()
  page.visibilityState = 'hidden'
  useTrayPanelStore.setState({
    sessions: { a: session('a') },
    details: { a: detail([request]) },
    reviewing: { sessionId: 'a', entryId: 'e1' },
    answeredElsewhere: null,
  })
})

describe('answer', () => {
  it('answers, lists again without the request, and closes when nothing else waits', async () => {
    api.request.mockResolvedValue(undefined)
    expect(await answer('a', request, { optionId: 'allow' })).toBeNull()
    expect(api.request).toHaveBeenCalledWith('permissions.respond', {
      sessionId: 'a',
      requestId: 'r1',
      optionId: 'allow',
    })
    const state = useTrayPanelStore.getState()
    expect(state.reviewing).toBeNull()
    expect(state.details['a']!.requests).toEqual([])
    expect(api.hide).toHaveBeenCalledOnce()
  })

  it('stays open while another session waits', async () => {
    useTrayPanelStore.setState((state) => ({ sessions: { ...state.sessions, b: session('b') } }))
    api.request.mockResolvedValue(undefined)
    await answer('a', request, { optionId: 'allow' })
    expect(api.hide).not.toHaveBeenCalled()
  })

  it('says so when another window or device answered first, and stays open', async () => {
    api.request.mockRejectedValue({
      name: 'PortRequestError',
      code: 'not_found',
      message: 'answered',
      data: { reason: ALREADY_ANSWERED, device: null },
    })
    expect(await answer('a', request, { optionId: 'allow' })).toBeNull()
    expect(useTrayPanelStore.getState()).toMatchObject({ reviewing: null, answeredElsewhere: 'a' })
    expect(api.hide).not.toHaveBeenCalled()
  })

  it('keeps the request on any other failure and gives its message', async () => {
    api.request.mockRejectedValue({ name: 'PortRequestError', code: 'internal', message: 'boom' })
    expect(await answer('a', request, { optionId: 'allow' })).toBe('boom')
    expect(useTrayPanelStore.getState().reviewing).toEqual({ sessionId: 'a', entryId: 'e1' })
    expect(useTrayPanelStore.getState().details['a']!.requests).toHaveLength(1)
  })

  it('takes the session settling before the answer returns as its own answer', async () => {
    let respond = (): void => {}
    api.request.mockReturnValue(new Promise<void>((resolve) => (respond = resolve)))
    const answering = answer('a', request, { optionId: 'allow' })
    emit({
      type: 'session.summary',
      summary: session('a', { status: 'running', attention: 'none', permissionCount: 0 }),
    })
    expect(useTrayPanelStore.getState()).toMatchObject({
      reviewing: { sessionId: 'a', entryId: 'e1' },
      answeredElsewhere: null,
    })
    respond()
    await answering
    expect(useTrayPanelStore.getState()).toMatchObject({ reviewing: null, answeredElsewhere: null })
  })
})

describe('a request settled elsewhere while it is reviewed', () => {
  it('lists again and says so', () => {
    emit({
      type: 'session.summary',
      summary: session('a', { status: 'running', attention: 'none', permissionCount: 0 }),
    })
    expect(useTrayPanelStore.getState()).toMatchObject({ reviewing: null, answeredElsewhere: 'a' })
  })

  it('never puts the next request of the session in its place', async () => {
    page.visibilityState = 'visible'
    const next: ThreadEntry = {
      kind: 'tool',
      id: 'e2',
      title: 'Run rm',
      toolKind: 'execute',
      status: 'pending',
      content: [],
      locations: [],
      permission: { requestId: 'r2', options: [] },
      permissionResult: null,
    }
    api.request.mockResolvedValue({ session: { turnStartedAt: null }, entries: [next] })
    emit({ type: 'session.summary', summary: session('a', { updatedAt: 2 }) })
    await vi.waitFor(() => expect(useTrayPanelStore.getState().details['a']!.readAt).toBe(2))
    expect(useTrayPanelStore.getState()).toMatchObject({ reviewing: null, answeredElsewhere: 'a' })
    expect(api.request).toHaveBeenCalledWith('sessions.snapshot', { sessionId: 'a' })
  })

  it('reads the thread again when only the count of waiting requests moves', async () => {
    page.visibilityState = 'visible'
    const second = { ...request, entryId: 'e2', permission: { requestId: 'r2', options: [] } }
    useTrayPanelStore.setState({
      sessions: { a: session('a', { permissionCount: 2 }) },
      details: { a: detail([request, second]) },
    })
    const left: ThreadEntry = {
      kind: 'tool',
      id: 'e2',
      title: 'Run ls',
      toolKind: 'execute',
      status: 'pending',
      content: [],
      locations: [],
      permission: { requestId: 'r2', options: [] },
      permissionResult: null,
    }
    api.request.mockResolvedValue({ session: { turnStartedAt: null }, entries: [left] })
    emit({ type: 'session.summary', summary: session('a', { permissionCount: 1 }) })
    // The test before read this session, so this read waits out the interval between reads.
    await vi.waitFor(
      () =>
        expect(useTrayPanelStore.getState()).toMatchObject({
          reviewing: null,
          answeredElsewhere: 'a',
        }),
      { timeout: 3000 },
    )
  })
})

describe('when the panel comes forward', () => {
  const agent = (id: string, patch: Partial<AgentStatus> = {}) =>
    ({ id, state: 'ready', capabilities: { reports: true }, ...patch }) as AgentStatus

  it('reads the plan limits again of the added agents that report them', () => {
    api.request.mockResolvedValue(undefined)
    useTrayPanelStore.setState({
      agents: [
        agent('claude-code'),
        agent('codex', { registered: false }),
        agent('pi', { capabilities: { reports: false } as AgentStatus['capabilities'] }),
      ],
    })
    for (const listener of api.shown) listener()
    expect(api.request.mock.calls).toEqual([['agents.refreshLimits', { agentId: 'claude-code' }]])
  })
})
