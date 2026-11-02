import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { ThreadState } from '@shared/thread'

vi.stubGlobal('window', { kettu: { agents: { request: vi.fn() } } })

let shown: string[] = []
vi.mock('@renderer/stores/view', async (original) => ({
  ...(await original<typeof import('@renderer/stores/view')>()),
  openSession: vi.fn(),
  shownLayoutSessions: () => shown,
}))
vi.mock('@renderer/stores/threads', async (original) => ({
  ...(await original<typeof import('@renderer/stores/threads')>()),
  loadThrough: vi.fn(() => Promise.resolve(true)),
}))

const { openSession } = await import('@renderer/stores/view')
const { loadThrough, useThreadsStore } = await import('@renderer/stores/threads')
const { useSessionsStore } = await import('@renderer/stores/sessions')
const { revealRequest, revealSubagent, takeReveal } = await import('./reveal-subagent')

const parent = { id: 'p', projectPath: '/repo' } as SessionSummary

function replica(entryIds: string[], older: number | null) {
  const state = {
    order: entryIds,
    byId: Object.fromEntries(entryIds.map((id) => [id, { kind: 'subagent', id, sessionId: id }])),
  } as unknown as ThreadState
  useThreadsStore.setState({
    replicas: {
      p: { state, seq: 1, status: 'ready', error: null, older, loadingOlder: false, plan: null },
    },
  })
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  shown = []
  vi.mocked(openSession).mockClear()
  vi.mocked(loadThrough).mockClear()
  useSessionsStore.setState({ byId: { p: parent } })
  useThreadsStore.setState({ replicas: {} })
})

afterEach(() => {
  const standing = revealRequest()
  if (standing) takeReveal(standing)
  vi.useRealTimers()
})

describe('revealSubagent', () => {
  it('shows the parent when no pane in view shows it, and asks for the block', async () => {
    replica(['s:c'], null)
    revealSubagent('p', 'c')
    expect(openSession).toHaveBeenCalledWith('p', '/repo')
    expect(revealRequest()?.entryId).toBe('s:c')
    await settled()
    expect(loadThrough).not.toHaveBeenCalled()
  })

  it('leaves the panes alone when one shows the parent', () => {
    shown = ['p']
    replica(['s:c'], null)
    revealSubagent('p', 'c')
    expect(openSession).not.toHaveBeenCalled()
  })

  it('loads the older pages once the parent is ready, when the block lies in them', async () => {
    revealSubagent('p', 'c')
    await settled()
    expect(loadThrough).not.toHaveBeenCalled()
    replica(['s:other'], 60)
    await settled()
    expect(loadThrough).toHaveBeenCalledWith('p', 0)
  })

  it('ends a request its block took, and one nothing took in time', () => {
    vi.useFakeTimers()
    replica(['s:c'], null)
    revealSubagent('p', 'c')
    const first = revealRequest()!
    revealSubagent('p', 'c')
    const second = revealRequest()!
    expect(second.nonce).not.toBe(first.nonce)
    takeReveal(first)
    expect(revealRequest()).toBe(second)
    vi.advanceTimersByTime(10_000)
    expect(revealRequest()).toBeNull()
  })

  it('does nothing for a parent it does not know', () => {
    revealSubagent('gone', 'c')
    expect(openSession).not.toHaveBeenCalled()
    expect(revealRequest()).toBeNull()
  })
})
