import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { BackgroundTaskView, ThreadState } from '@shared/thread'

let mockSessionsById: Record<string, SessionSummary> = {}
let mockReplicas: Record<string, { state: ThreadState | null }> = {}
let mockNow = 100_000

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key
      const suffix = Object.entries(params)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',')
      return `${key}(${suffix})`
    },
  }),
}))

vi.mock('@renderer/lib/use-now', () => ({
  useSeconds: () => mockNow,
}))

vi.mock('@renderer/lib/format', () => ({
  timeLeft: (ms: number) => `${Math.ceil(ms / 1000)}s`,
}))

vi.mock('@renderer/features/split/pane-context', () => ({
  usePane: () => null,
}))

vi.mock('@renderer/stores/view', () => ({
  focusPane: vi.fn(),
  toggleBoard: vi.fn(),
}))

vi.mock('@renderer/stores/sessions', () => ({
  useSessionsStore: <T>(selector: (state: { byId: Record<string, SessionSummary> }) => T) =>
    selector({ byId: mockSessionsById }),
}))

vi.mock('@renderer/stores/threads', () => ({
  useThreadsStore: <T>(
    selector: (state: { replicas: Record<string, { state: ThreadState | null }> }) => T,
  ) => selector({ replicas: mockReplicas }),
}))

import { StillRunningLine } from './still-running-line'

function summary(stillRunning: SessionSummary['stillRunning']): SessionSummary {
  return {
    id: 's1',
    agentId: 'antigravity',
    projectPath: '/repo',
    scratch: false,
    title: 'Session',
    status: 'running',
    phase: 'waiting_background',
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
    stillRunning,
  }
}

function replicaWith(background: BackgroundTaskView[]): { state: ThreadState } {
  return {
    state: {
      session: {
        id: 's1',
        agentId: 'antigravity',
        projectPath: '/repo',
        acpSessionId: null,
        status: 'running',
        waitingBackground: true,
        title: 'Session',
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
        background,
      },
      order: [],
      byId: {},
    },
  }
}

beforeEach(() => {
  mockSessionsById = {}
  mockReplicas = {}
  mockNow = 100_000
})

describe('StillRunningLine (#2933)', () => {
  it('shows live remaining countdown for a single running timer', () => {
    mockSessionsById.s1 = summary({
      commands: 0,
      subagents: 0,
      scheduled: 1,
      reportsBack: true,
    })
    mockReplicas.s1 = replicaWith([
      {
        id: 't1',
        kind: 'monitor',
        title: 'Check CI',
        command: 'Timer: 1m',
        status: 'running',
        startedAt: 90_000,
        endedAt: null,
        summary: null,
        entryId: 't:t1',
        schedule: { mode: 'timer', durationSeconds: 60, fireAt: 150_000 },
      },
    ])

    const html = renderToStaticMarkup(createElement(StillRunningLine, { sessionId: 's1' }))
    expect(html).toContain('stillRunning.timerLeft(left=50s)')
    expect(html).toContain('stillRunning.lineReports')
    expect(html).not.toContain('lineUnnamed')
  })

  it('shows the cron expression for a single running recurring schedule and monitor count for watchers', () => {
    mockSessionsById.s1 = summary({
      commands: 0,
      subagents: 0,
      monitors: 1,
      scheduled: 1,
      reportsBack: true,
    })
    mockReplicas.s1 = replicaWith([
      {
        id: 'm1',
        kind: 'monitor',
        title: 'Run build',
        command: 'pnpm build',
        status: 'running',
        startedAt: 90_000,
        endedAt: null,
        summary: null,
        entryId: 't:m1',
        schedule: { mode: 'timeout', durationSeconds: 60, fireAt: 150_000 },
      },
      {
        id: 'c1',
        kind: 'monitor',
        title: 'Patrol issues',
        command: 'Cron: */30 * * * *',
        status: 'running',
        startedAt: 90_000,
        endedAt: null,
        summary: null,
        entryId: 't:c1',
        schedule: { mode: 'cron', cron: '*/30 * * * *', daemon: true },
      },
    ])

    const html = renderToStaticMarkup(createElement(StillRunningLine, { sessionId: 's1' }))
    expect(html).toContain('stillRunning.monitors(count=1)')
    expect(html).toContain('stillRunning.cronExpr(cron=*/30 * * * *)')
  })

  it('keeps the unnamed fallback when no specific tasks or sub-agents are listed', () => {
    mockSessionsById.s1 = summary({
      commands: 0,
      subagents: 0,
      reportsBack: true,
      unnamed: true,
    })

    const html = renderToStaticMarkup(createElement(StillRunningLine, { sessionId: 's1' }))
    expect(html).toContain('stillRunning.lineUnnamedReports')
  })
})
