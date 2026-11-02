import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ALREADY_ANSWERED, type HostEvent, type SessionSummary } from '@shared/agent-host'
import type { SessionDetail } from '@renderer/features/tray/model'

const api = vi.hoisted(() => ({
  request: vi.fn(),
  hide: vi.fn(),
  listeners: [] as ((event: HostEvent) => void)[],
}))

vi.stubGlobal('window', {
  kettu: {
    agents: {
      request: api.request,
      onEvent: (listener: (event: HostEvent) => void) => api.listeners.push(listener),
      onConnection: () => {},
    },
    remote: { status: () => Promise.resolve(null), onChanged: () => {} },
    tray: { hide: api.hide, onShown: () => {} },
  },
})
// The panel reads threads only while it shows; these tests keep it hidden.
vi.stubGlobal('document', { visibilityState: 'hidden', addEventListener: () => {} })

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
  return { readAt: 1, requests, activity: null, turnStartedAt: null, files: 0 }
}

beforeEach(() => {
  api.request.mockReset()
  api.hide.mockReset()
  useTrayPanelStore.setState({
    sessions: { a: session('a') },
    details: { a: detail([request]) },
    reviewing: 'a',
    answeredElsewhere: false,
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
    expect(useTrayPanelStore.getState()).toMatchObject({ reviewing: null, answeredElsewhere: true })
    expect(api.hide).not.toHaveBeenCalled()
  })

  it('keeps the request on any other failure and gives its message', async () => {
    api.request.mockRejectedValue({ name: 'PortRequestError', code: 'internal', message: 'boom' })
    expect(await answer('a', request, { optionId: 'allow' })).toBe('boom')
    expect(useTrayPanelStore.getState().reviewing).toBe('a')
    expect(useTrayPanelStore.getState().details['a']!.requests).toHaveLength(1)
  })
})

describe('a request settled elsewhere while it is reviewed', () => {
  it('lists again and says so', async () => {
    await initTrayPanel()
    for (const listener of api.listeners) {
      listener({
        type: 'session.summary',
        summary: session('a', { status: 'running', attention: 'none', permissionCount: 0 }),
      })
    }
    expect(useTrayPanelStore.getState()).toMatchObject({ reviewing: null, answeredElsewhere: true })
  })
})
