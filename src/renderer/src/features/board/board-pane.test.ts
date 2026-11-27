import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { ArtifactEntry, ThreadState } from '@shared/thread'

let mockSessionsById: Record<string, SessionSummary> = {}
let mockReplicas: Record<string, { state: ThreadState | null }> = {}
let mockArtifactLive = new Set<string>()
let mockArtifactTitles = new Map<string, string>()

vi.mock('@renderer/lib/platform', () => ({
  platform: 'darwin',
  isMac: true,
  isWindows: false,
  isWeb: false,
  isHosted: false,
}))

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

vi.mock('@renderer/stores/sessions', () => ({
  useSessionsStore: <T>(selector: (state: { byId: Record<string, SessionSummary> }) => T) =>
    selector({ byId: mockSessionsById }),
  hostOfSession: () => null,
  sessionTitle: (summary: SessionSummary) => summary.title ?? summary.id,
}))

vi.mock('@renderer/stores/threads', () => {
  const useThreadsStore = Object.assign(
    <T>(selector: (state: { replicas: Record<string, { state: ThreadState | null }> }) => T) =>
      selector({ replicas: mockReplicas }),
    {
      subscribe: vi.fn(() => () => {}),
      getState: () => ({ replicas: mockReplicas }),
    },
  )
  return { useThreadsStore }
})

vi.mock('@renderer/stores/artifacts', () => ({
  artifactListShown: vi.fn(),
  artifactStanding: (_state: unknown, id: string) =>
    mockArtifactLive.has(id) ? 'live' : 'missing',
  useArtifactsStore: <T>(selector: (state: Record<string, never>) => T) => selector({}),
}))

vi.mock('@renderer/stores/board', () => {
  const useBoardStore = Object.assign(
    <T>(selector: (state: { seen: Record<string, readonly string[]> }) => T) =>
      selector({ seen: {} }),
    {
      setState: vi.fn(),
    },
  )
  return { useBoardStore }
})

vi.mock('@renderer/stores/view', () => ({
  openSession: vi.fn(),
  openArtifactTab: vi.fn(),
  useViewStore: <T>(selector: (state: { sidePane: Record<string, string> }) => T) =>
    selector({ sidePane: {} }),
}))

vi.mock('@renderer/features/session/subagent/progress', async () => {
  const { subagentRunning } = await import('@shared/session-groups')
  return {
    subagentRunning,
    useSubagentDigests: () => ({}),
    useLoadSubagent: vi.fn(),
  }
})

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: ({ agent }: { agent: string }) =>
    createElement('span', { 'data-testid': 'agent-mark', 'data-agent': agent }),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement('button', { type: 'button', className }, children),
}))

vi.mock('@renderer/features/shell/panel-button', () => ({
  PaneBody: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement('div', { className }, children),
  PaneEmpty: ({ title, text }: { title: ReactNode; text?: ReactNode }) =>
    createElement(
      'div',
      { 'data-testid': 'pane-empty' },
      createElement('b', null, title),
      createElement('p', null, text),
    ),
  PaneIcon: () => createElement('span', { 'data-testid': 'pane-icon' }),
}))

vi.mock('./artifact-row', () => ({
  ArtifactRow: ({ artifactId }: { artifactId: string }) =>
    createElement(
      'div',
      { 'data-testid': 'artifact-row', 'data-artifact-id': artifactId },
      mockArtifactTitles.get(artifactId) ?? artifactId,
    ),
}))

vi.mock('./row-parts', () => ({
  Clock: ({ since }: { since: number }) =>
    createElement('span', { 'data-testid': 'clock', 'data-since': String(since) }),
  Countdown: ({ until }: { until: number }) =>
    createElement('span', { 'data-testid': 'countdown', 'data-until': String(until) }),
  Ago: () => createElement('span', null, 'now'),
  Fold: ({ open, children }: { open: boolean; children: ReactNode }) =>
    createElement('div', { 'data-testid': 'fold', 'data-open': String(open) }, children),
}))

vi.mock('./board.css', () => ({}))

import BoardPane from './board-pane'

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'claude-code',
    projectPath: '/proj/a',
    scratch: false,
    title: id,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 100,
    updatedAt: 100,
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

function threadWithArtifact(sessionId: string, artifactId: string, title: string): ThreadState {
  const entry: ArtifactEntry = {
    kind: 'artifact',
    id: `entry-${artifactId}`,
    artifactId,
    action: 'create',
    title,
    version: 1,
    writes: 1,
    after: null,
  }
  return {
    session: {
      id: sessionId,
      agentId: 'claude-code',
      projectPath: '/proj/a',
      acpSessionId: null,
      status: 'ready',
      title: 'Parent',
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
      background: [],
    },
    order: [entry.id],
    byId: { [entry.id]: entry },
  }
}

function renderBoard(sessionId = 'parent'): string {
  return renderToStaticMarkup(createElement(BoardPane, { sessionId }))
}

beforeEach(() => {
  mockSessionsById = { parent: summary('parent', { title: 'Parent session' }) }
  mockReplicas = {}
  mockArtifactLive = new Set()
  mockArtifactTitles = new Map()
})

describe('BoardPane (#2917, #2918)', () => {
  it('hides the redundant idle header when the board is completely empty (#2917)', () => {
    const html = renderBoard()

    expect(html).not.toContain('kb-head')
    expect(html).not.toContain('summary.idle')
    expect(html).toContain('data-testid="pane-empty"')
    expect(html).toContain('empty.title')
    expect(html).toContain('empty.text')
  })

  it('keeps the board empty when only archived or prepared child sessions exist', () => {
    mockSessionsById.archived = summary('archived', {
      parentId: 'parent',
      origin: 'user',
      title: 'Archived task',
      status: 'running',
      archivedAt: 200,
    })
    mockSessionsById.draft = summary('draft', {
      parentId: 'parent',
      origin: 'user',
      title: 'Draft sub-session',
      status: 'starting',
      prepared: { config: [], notices: [], openedAt: 100 },
    })

    const html = renderBoard()

    expect(html).not.toContain('kb-head')
    expect(html).not.toContain('Archived task')
    expect(html).not.toContain('Draft sub-session')
    expect(html).toContain('data-testid="pane-empty"')
  })

  it('shows running start_session user child sessions and counts them in the header (#2918)', () => {
    mockSessionsById.started = summary('started', {
      parentId: 'parent',
      origin: 'user',
      agentId: 'codex',
      title: 'Inspect build failure',
      status: 'running',
      createdAt: 1_000,
      turnStartedAt: 1_200,
    })

    const html = renderBoard()

    expect(html).toContain('kb-head')
    expect(html).toContain('summary.running(count=1)')
    expect(html).not.toContain('summary.idle')
    expect(html).not.toContain('data-testid="pane-empty"')
    expect(html).toContain('sections.now')
    expect(html).toContain('Inspect build failure')
    expect(html).toContain('data-agent="codex"')
    expect(html).toContain('actions.openTitle(title=Inspect build failure)')
    expect(html).toContain('data-since="1200"')
  })

  it('renders both sub-agents and user child sessions once without duplicating sub-agents', () => {
    mockSessionsById.sub = summary('sub', {
      parentId: 'parent',
      origin: 'subagent',
      agentId: 'claude-code',
      title: 'Explore codebase',
      status: 'running',
      createdAt: 1_000,
    })
    mockSessionsById.started = summary('started', {
      parentId: 'parent',
      origin: 'user',
      agentId: 'codex',
      title: 'Verify fix',
      status: 'awaiting_permission',
      createdAt: 1_100,
    })

    const html = renderBoard()

    expect(html).toContain('summary.running(count=1)')
    expect(html).toContain('summary.needs(count=1)')
    expect(html.match(/Explore codebase/g)?.length).toBe(2) // aria-label and visible title once
    expect(html.match(/Verify fix/g)?.length).toBe(2)
    expect(html).toContain('actions.review')
  })

  it('shows finished user child sessions under Earlier with the idle header', () => {
    mockSessionsById.done = summary('done', {
      parentId: 'parent',
      origin: 'user',
      title: 'Completed audit',
      status: 'ready',
      createdAt: 1_000,
      updatedAt: 5_000,
    })

    const html = renderBoard()

    expect(html).toContain('kb-head')
    expect(html).toContain('summary.idle')
    expect(html).not.toContain('data-testid="pane-empty"')
    expect(html).toContain('sections.earlier')
    expect(html).toContain('Completed audit')
    expect(html).toContain('data-open="true"')
  })

  it('keeps the idle header when the board has artifacts but no running tasks (#2917)', () => {
    mockReplicas.parent = { state: threadWithArtifact('parent', 'art-1', 'Design Notes') }
    mockArtifactLive.add('art-1')
    mockArtifactTitles.set('art-1', 'Design Notes')

    const html = renderBoard()

    expect(html).toContain('kb-head')
    expect(html).toContain('summary.idle')
    expect(html).not.toContain('data-testid="pane-empty"')
    expect(html).toContain('sections.artifacts')
    expect(html).toContain('Design Notes')
  })

  it('renders scheduled timers with countdown, cron jobs, and timeout monitors in Now (#2933)', () => {
    const state = threadWithArtifact('parent', 'art-1', 'Notes')
    state.order = []
    state.byId = {}
    state.session.background = [
      {
        id: 'timer-1',
        kind: 'monitor',
        title: 'Check CI build',
        command: 'Timer: 5m',
        status: 'running',
        startedAt: 10_000,
        endedAt: null,
        summary: null,
        entryId: 't:timer-1',
        schedule: { mode: 'timer', durationSeconds: 300, fireAt: 310_000 },
      },
      {
        id: 'cron-1',
        kind: 'monitor',
        title: 'Patrol issues',
        command: 'Cron: */30 * * * *',
        status: 'running',
        startedAt: 20_000,
        endedAt: null,
        summary: null,
        entryId: 't:cron-1',
        schedule: { mode: 'cron', cron: '*/30 * * * *', daemon: true },
      },
    ]
    mockReplicas.parent = { state }

    const html = renderBoard()

    expect(html).toContain('summary.running(count=2)')
    expect(html).toContain('Check CI build')
    expect(html).toContain('Timer: 5m')
    expect(html).toContain('data-testid="countdown" data-until="310000"')
    expect(html).toContain('Patrol issues')
    expect(html).toContain('Cron: */30 * * * *')
    expect(html).toContain('data-testid="clock" data-since="20000"')
  })
})
