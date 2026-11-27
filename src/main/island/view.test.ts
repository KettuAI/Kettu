import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { buildView, type HostState } from './view'

function makeSummary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'antigravity',
    projectPath: '/work/kettu',
    scratch: false,
    title: `Session ${id}`,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1,
    updatedAt: 1_000,
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
    ...overrides,
  }
}

function hostOf(sessions: SessionSummary[]): HostState {
  return {
    key: 'local',
    host: null,
    sessions: new Map(sessions.map((s) => [s.id, s])),
    agents: new Map(),
    options: new Map(),
    requests: new Map(),
    tasks: new Map(),
  }
}

describe('island buildView with waiting_background sessions (#2855)', () => {
  it('treats waiting_background as non-running until the session wakes back up', () => {
    const waiting = makeSummary('agy-bg', {
      status: 'running',
      phase: 'waiting_background',
      turnStartedAt: null,
      stillRunning: { commands: 0, subagents: 1, reportsBack: true },
      updatedAt: 5_000,
    })
    const idleView = buildView([hostOf([waiting])], 6_000).view
    expect(idleView.summary.running).toBe(0)
    const idleRow = idleView.rows.find((row) => row.sessionId === 'agy-bg')
    expect(idleRow?.status).toBe('idle')
    expect(idleRow?.group).toBe('idle')
    expect(idleRow?.phase).toBeNull()

    const woken = {
      ...waiting,
      phase: 'writing' as const,
      turnStartedAt: 6_500,
      stillRunning: null,
    }
    const runningView = buildView([hostOf([woken])], 7_000).view
    expect(runningView.summary.running).toBe(1)
    const runningRow = runningView.rows.find((row) => row.sessionId === 'agy-bg')
    expect(runningRow?.status).toBe('running')
    expect(runningRow?.group).toBe('running')
    expect(runningRow?.phase).toBe('write')
  })
})
