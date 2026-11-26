import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import {
  hasNoProjectSessions,
  localHarnessCounts,
  needsYouSummaries,
  needsYouTree,
  pinnedSummaries,
  pinnedTree,
  projectSummaries,
  sessionTree,
  sidebarTabStop,
  useSessionsStore,
} from './sessions'

function makeSummary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'claude-code',
    projectPath: '/proj/a',
    acpSessionId: null,
    status: 'ready',
    title: id,
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    origin: 'user',
    description: null,
    routine: null,
    scratch: false,
    pinnedAt: null,
    archivedAt: null,
    attention: 'none',
    permissionCount: 0,
    missing: false,
    branch: null,
    pr: null,
    cache: null,
    model: null,
    ...overrides,
  }
}

describe('sessions store indexing and deduplication', () => {
  beforeEach(() => {
    useSessionsStore.setState({ byId: {}, loaded: false, error: null })
  })

  it('skips state updates when upsert receives an identical summary', () => {
    const s1 = makeSummary('s1', { updatedAt: 100 })
    useSessionsStore.getState().upsert(s1)
    const before = useSessionsStore.getState().byId

    useSessionsStore.getState().upsert({ ...s1 })
    expect(useSessionsStore.getState().byId).toBe(before)

    useSessionsStore.getState().upsert({ ...s1, updatedAt: 101 })
    expect(useSessionsStore.getState().byId).not.toBe(before)
  })

  it('indexes projects, scratch hosts, pinned trees, needs-you trees, and harness counts', () => {
    const byId: Record<string, SessionSummary> = {
      p1: makeSummary('p1', { projectPath: '/proj/a', updatedAt: 10 }),
      p2: makeSummary('p2', { projectPath: '/proj/b', updatedAt: 20, status: 'running' }),
      pin: makeSummary('pin', { projectPath: '/proj/a', pinnedAt: 5, updatedAt: 30 }),
      pinChild: makeSummary('pinChild', {
        projectPath: '/proj/a',
        parentId: 'pin',
        updatedAt: 35,
      }),
      errParent: makeSummary('errParent', { projectPath: '/proj/b', updatedAt: 40 }),
      errChild: makeSummary('errChild', {
        projectPath: '/proj/b',
        parentId: 'errParent',
        permissionCount: 2,
        updatedAt: 45,
      }),
      scratch: makeSummary('scratch', {
        projectPath: '/tmp/scratch-1',
        scratch: true,
        agentId: 'codex',
        status: 'awaiting_permission',
        updatedAt: 50,
      }),
    }

    expect(projectSummaries(byId, '/proj/a').map((s) => s.id)).toEqual(['p1', 'pin', 'pinChild'])
    expect(sessionTree(byId, '/proj/a')).toBe(sessionTree(byId, '/proj/a'))
    expect(sessionTree(byId, '/proj/a').map((n) => n.summary.id)).toEqual(['p1'])

    expect(pinnedSummaries(byId).map((s) => s.id)).toEqual(['pin', 'pinChild'])
    expect(pinnedTree(byId)).toBe(pinnedTree(byId))
    expect(pinnedTree(byId).map((n) => n.summary.id)).toEqual(['pin'])

    expect(
      needsYouSummaries(byId)
        .map((s) => s.id)
        .sort(),
    ).toEqual(['errChild', 'errParent'])
    expect(needsYouTree(byId)).toBe(needsYouTree(byId))
    expect(needsYouTree(byId).map((n) => n.summary.id)).toEqual(['errParent'])

    expect(hasNoProjectSessions(byId, null)).toBe(true)
    expect(hasNoProjectSessions(byId, 'remote-host')).toBe(false)

    expect(localHarnessCounts(byId)).toEqual([
      { harnessId: 'claude-code', total: 6, running: 1 },
      { harnessId: 'codex', total: 1, running: 1 },
    ])
  })

  it('incrementally updates SessionIndex on single-session upsert without churning unrelated projects', () => {
    const a1 = makeSummary('a1', { projectPath: '/proj/a', updatedAt: 10, status: 'ready' })
    const b1 = makeSummary('b1', { projectPath: '/proj/b', updatedAt: 20, status: 'ready' })
    useSessionsStore.getState().setAll([a1, b1])

    const before = useSessionsStore.getState().byId
    const bSummariesBefore = projectSummaries(before, '/proj/b')
    const bTreeBefore = sessionTree(before, '/proj/b')
    const countsBefore = localHarnessCounts(before)

    // Updating a1's phase/updatedAt should keep /proj/b references and harness counts identical.
    useSessionsStore.getState().upsert({ ...a1, updatedAt: 50, title: 'Updated A1' })
    const afterTitle = useSessionsStore.getState().byId
    expect(projectSummaries(afterTitle, '/proj/b')).toBe(bSummariesBefore)
    expect(sessionTree(afterTitle, '/proj/b')).toBe(bTreeBefore)
    expect(localHarnessCounts(afterTitle)).toBe(countsBefore)
    expect(projectSummaries(afterTitle, '/proj/a')[0]?.title).toBe('Updated A1')

    // Flipping a1 to running updates harness running count while still preserving /proj/b refs.
    useSessionsStore.getState().upsert({ ...a1, updatedAt: 60, status: 'running' })
    const afterRun = useSessionsStore.getState().byId
    expect(projectSummaries(afterRun, '/proj/b')).toBe(bSummariesBefore)
    expect(sessionTree(afterRun, '/proj/b')).toBe(bTreeBefore)
    expect(localHarnessCounts(afterRun)).toEqual([
      { harnessId: 'claude-code', total: 2, running: 1 },
    ])
  })

  it('fast-paths sidebarTabStop for visible active top-level sessions and respects collapsed groups', () => {
    const a1 = makeSummary('a1', { projectPath: '/proj/a', updatedAt: 10 })
    const byId = { a1 }
    const projects = [{ path: '/proj/a', name: 'A', addedAt: 1, missing: false, lastOpenedAt: 1 }]
    expect(
      sidebarTabStop(
        {
          main: { kind: 'session', sessionId: 'a1' },
          collapsedProjects: {},
          expandedParents: {},
        },
        byId,
        projects,
      ),
    ).toEqual({ kind: 'session', id: 'a1' })

    expect(
      sidebarTabStop(
        {
          main: { kind: 'session', sessionId: 'a1' },
          collapsedProjects: { '/proj/a': true },
          expandedParents: {},
        },
        byId,
        projects,
      ),
    ).toEqual({ kind: 'group', key: '/proj/a' })
  })
})
