import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TFunction } from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { BackgroundTaskView, ThreadState } from '@shared/thread'

let mockSessionsById: Record<string, SessionSummary> = {}
let mockReplicas: Record<string, { state: ThreadState | null }> = {}
let mockNow = 100_000

vi.hoisted(() => {
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        kettu: { platform: 'darwin' },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
})

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const normalized = key.replace(/^(session|control|terminal):/, '')
      if (!params) return normalized
      const suffix = Object.entries(params)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',')
      return `${normalized}(${suffix})`
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

vi.mock('@renderer/components/control/use-control-agent', () => ({
  useControlAgent: () => ({ id: 'antigravity', name: 'Antigravity', dot: null }),
}))

vi.mock('./app-icon', () => ({
  useAppIcon: () => null,
}))

vi.mock('@renderer/stores/settings', () => ({
  useSettingsStore: <T>(
    selector: (state: { settings: { computerUse: { stopShortcut: string } } }) => T,
  ) => selector({ settings: { computerUse: { stopShortcut: 'Cmd+Shift+.' } } }),
}))

vi.mock('@renderer/stores/browser', () => ({
  useBrowserStore: <T>(selector: (state: { bySession: Record<string, never> }) => T) =>
    selector({ bySession: {} }),
}))

vi.mock('@renderer/stores/devices', () => ({
  controlDevice: vi.fn(),
  useDevicesStore: <T>(selector: (state: { devices: never[] }) => T) => selector({ devices: [] }),
}))

vi.mock('@renderer/stores/terminals', () => ({
  handBackTerminal: vi.fn(),
  orderTerminals: <T>(list: readonly T[]) => [...list],
  revealTerminal: vi.fn(),
  takeOverTerminal: vi.fn(),
  useTerminalsStore: <T>(
    selector: (state: { byId: Record<string, never>; order: Record<string, string[]> }) => T,
  ) => selector({ byId: {}, order: {} }),
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

import { formatBackgroundDisplay, selectScheduleHint } from './live-dock-model'
import { SessionLiveDock } from './session-live-dock'

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

function renderDock(): string {
  return renderToStaticMarkup(
    createElement(SessionLiveDock, {
      sessionId: 's1',
      agentId: 'antigravity',
      hostId: null,
      computerView: null,
      showSurfaces: true,
      showBackground: true,
      onError: () => undefined,
    }),
  )
}

beforeEach(() => {
  mockSessionsById = {}
  mockReplicas = {}
  mockNow = 100_000
})

describe('Background still-running work in SessionLiveDock (#2933, #2947, #2951)', () => {
  it('shows live remaining countdown with 3x3 fox dots and neutral board button for a single running timer', () => {
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

    const html = renderDock()
    expect(html).toContain('stillRunning.timerLeft(left=50s)')
    expect(html).toContain('stillRunning.dockRunning')
    expect(html).toContain('stillRunning.reportsBack')
    expect(html).toContain('stillRunning.openBoard')
    expect(html).toContain('data-turn-dots')
    expect(html).toContain('ks-dock__board-pill')
    expect(html).not.toContain('ks-still__open')
    expect(html).not.toContain('dockUnnamed')
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

    const html = renderDock()
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

    const html = renderDock()
    expect(html).toContain('stillRunning.dockUnnamed')
    expect(html).toContain('stillRunning.reportsBack')
  })

  it('formats subagents, commands, both, multiple scheduled tasks, and reportsBack=false cleanly', () => {
    const t = ((key: string, params?: Record<string, unknown>) =>
      params
        ? `${key}(${Object.entries(params)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(',')})`
        : key) as unknown as TFunction<'session'>
    const noHint = selectScheduleHint(undefined)

    expect(
      formatBackgroundDisplay(
        t,
        { commands: 0, subagents: 2, monitors: 0, scheduled: 0, reportsBack: true, unnamed: false },
        noHint,
      ),
    ).toEqual({
      headline: 'stillRunning.dockRunning(work=stillRunning.subagents(count=2))',
      summary: 'stillRunning.subagents(count=2)',
      hint: 'stillRunning.reportsBack',
      hasCountdown: false,
    })

    expect(
      formatBackgroundDisplay(
        t,
        {
          commands: 1,
          subagents: 2,
          monitors: 0,
          scheduled: 0,
          reportsBack: false,
          unnamed: false,
        },
        noHint,
      ),
    ).toEqual({
      headline:
        'stillRunning.dockRunning(work=stillRunning.both(subagents=stillRunning.subagents(count=2),commands=stillRunning.commands(count=1)))',
      summary:
        'stillRunning.both(subagents=stillRunning.subagents(count=2),commands=stillRunning.commands(count=1))',
      hint: null,
      hasCountdown: false,
    })

    expect(
      formatBackgroundDisplay(
        t,
        { commands: 1, subagents: 1, monitors: 2, scheduled: 3, reportsBack: true, unnamed: false },
        noHint,
      ),
    ).toEqual({
      headline:
        'stillRunning.dockRunning(work=stillRunning.subagents(count=1)stillRunning.listSeparatorstillRunning.commands(count=1)stillRunning.listSeparatorstillRunning.monitors(count=2)stillRunning.listSeparatorstillRunning.scheduled(count=3))',
      summary:
        'stillRunning.subagents(count=1)stillRunning.listSeparatorstillRunning.commands(count=1)stillRunning.listSeparatorstillRunning.monitors(count=2)stillRunning.listSeparatorstillRunning.scheduled(count=3)',
      hint: 'stillRunning.reportsBack',
      hasCountdown: false,
    })
  })
})
