import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DigestedToolEntry, SessionSnapshot, ThreadEntry } from '@shared/thread'

const hostMock = vi.fn()

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => hostMock(...args),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

function snapshot(id: string, entries: ThreadEntry[], seq = 1): SessionSnapshot {
  return {
    seq,
    older: null,
    plan: null,
    entries,
    session: {
      id,
      agentId: 'claude-code',
      projectPath: '/p',
      acpSessionId: null,
      status: 'ready',
      title: id,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 1,
      updatedAt: 1,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
  }
}

describe('threads store performance and digests', () => {
  const rafQueue: FrameRequestCallback[] = []

  beforeEach(() => {
    hostMock.mockReset()
    rafQueue.length = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('loads a digested tool entry on demand, deduplicates calls, and preserves fresher status', async () => {
    const digested: DigestedToolEntry = {
      kind: 'tool',
      id: 't1',
      title: 'Edit a.ts',
      toolKind: 'edit',
      status: 'in_progress',
      content: [{ type: 'digest', of: 'diff', path: 'a.ts', size: 12000, added: 5, removed: 2 }],
      locations: [{ path: 'a.ts' }],
      permission: null,
      permissionResult: null,
      rawInputDigest: { size: 4000, lines: 80 },
    }
    const full: ThreadEntry = {
      kind: 'tool',
      id: 't1',
      title: 'Edit a.ts',
      toolKind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'old\n', newText: 'new\n' }],
      locations: [{ path: 'a.ts' }],
      permission: null,
      permissionResult: null,
      rawInput: 'full input',
    }

    let resolveEntry!: (value: ThreadEntry) => void
    hostMock.mockImplementation((method: string) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') {
        return Promise.resolve(snapshot('s1', [digested as unknown as ThreadEntry], 1))
      }
      if (method === 'sessions.entry') {
        return new Promise<ThreadEntry>((resolve) => {
          resolveEntry = resolve
        })
      }
      return Promise.resolve()
    })

    const { focusSession, loadFullEntry, receiveBatch, useThreadsStore } = await import('./threads')
    await focusSession('s1')

    const first = loadFullEntry('s1', 't1')
    const second = loadFullEntry('s1', 't1')
    expect(hostMock.mock.calls.filter((c) => c[0] === 'sessions.entry')).toHaveLength(1)

    // A live patch marks the call completed while the full entry is in flight.
    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [{ op: 'entry.update', id: 't1', changes: { status: 'completed' } }],
    })
    for (const cb of rafQueue.splice(0)) cb(performance.now())

    resolveEntry(full)
    await Promise.all([first, second])

    const updated = useThreadsStore.getState().replicas.s1?.state?.byId.t1
    expect(updated?.kind).toBe('tool')
    if (updated?.kind === 'tool') {
      expect(updated.status).toBe('completed')
      expect(updated.rawInput).toBe('full input')
      expect(updated.content).toEqual(full.content)
    }

    // Calling again on an already-full entry issues no RPC (old-host and loaded compatibility).
    await loadFullEntry('s1', 't1')
    expect(hostMock.mock.calls.filter((c) => c[0] === 'sessions.entry')).toHaveLength(1)
  })

  it('drops queued patches on sequence gaps and triggers a snapshot resync', async () => {
    const snapCalls: unknown[] = []
    hostMock.mockImplementation((method: string, params: unknown) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') return Promise.resolve(snapshot('s1', [], 1))
      if (method === 'sessions.snapshot') {
        snapCalls.push(params)
        return Promise.resolve(snapshot('s1', [], 10))
      }
      return Promise.resolve()
    })

    const { focusSession, receiveBatch } = await import('./threads')
    await focusSession('s1')

    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [{ op: 'session.update', changes: { title: 'a' } }],
    })
    // Sequence gap before frame runs: drops queue and marks session for resync.
    receiveBatch({
      sessionId: 's1',
      seq: 5,
      patches: [{ op: 'session.update', changes: { title: 'b' } }],
    })
    receiveBatch({
      sessionId: 's1',
      seq: 9,
      patches: [{ op: 'session.update', changes: { title: 'c' } }],
    })

    for (const cb of rafQueue.splice(0)) cb(performance.now())
    await Promise.resolve()

    expect(snapCalls).toHaveLength(1)
  })

  it('keeps at most 1 recent unwatched session in the web client', async () => {
    vi.stubGlobal('window', { kettu: { client: 'web' } })
    hostMock.mockImplementation((method: string, params: { sessionId?: string }) => {
      if (method === 'sessions.open') return Promise.resolve(snapshot(params.sessionId ?? 's', []))
      return Promise.resolve()
    })

    const { focusSession, useThreadsStore } = await import('./threads')
    await focusSession('s1')
    await focusSession('s2')
    expect(Object.keys(useThreadsStore.getState().replicas)).toEqual(['s2'])
    expect(hostMock).toHaveBeenCalledWith('sessions.unwatch', { sessionId: 's1' })
  })
})
