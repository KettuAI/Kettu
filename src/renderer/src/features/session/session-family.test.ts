import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary, SessionUsageItem } from '@shared/agent-host'
import type { SessionUsage } from '@shared/thread'
import enSession from '@shared/locales/en/session.json'
import zhSession from '@shared/locales/zh-CN/session.json'
import { hostOfPath, onHost } from '@renderer/lib/host-paths'
import {
  familyMemberStatus,
  fetchFamilyUsages,
  mergeFamilyUsageSources,
  resolveSessionFamily,
  rollupFamilyUsage,
  selectFamilyMember,
  type MemberUsageState,
} from './session-family-model'

const { mocks, storeState } = vi.hoisted(() => ({
  mocks: {
    hostAt: vi.fn(),
    openSession: vi.fn(),
    backTo: vi.fn((_view: unknown, open: () => void) => open()),
  },
  storeState: {
    sessionsById: {} as Record<string, SessionSummary>,
    replicas: {} as Record<
      string,
      {
        status: 'loading' | 'ready' | 'error'
        state: { session: { usage: SessionUsage | null } } | null
      }
    >,
  },
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const lookup = (obj: Record<string, unknown>, path: string): string | undefined => {
        let cur: unknown = obj
        for (const part of path.split('.')) {
          if (typeof cur !== 'object' || cur === null || !(part in cur)) return undefined
          cur = (cur as Record<string, unknown>)[part]
        }
        return typeof cur === 'string' ? cur : undefined
      }
      const dict = enSession as unknown as Record<string, unknown>
      const count = typeof params?.count === 'number' ? params.count : undefined
      const text =
        (count === 1 ? lookup(dict, `${key}_one`) : undefined) ??
        (count !== undefined ? lookup(dict, `${key}_other`) : undefined) ??
        lookup(dict, key) ??
        key
      if (!params) return text
      return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? ''))
    },
  }),
}))

vi.mock('@renderer/lib/i18n', () => ({
  currentLocale: () => 'en',
  i18n: { t: (key: string) => key },
}))

vi.mock('@renderer/lib/host', () => ({
  hostAt: (...args: unknown[]) => mocks.hostAt(...args),
}))

vi.mock('@renderer/app/history', () => ({
  backTo: (view: unknown, open: () => void) => mocks.backTo(view, open),
}))

vi.mock('@renderer/stores/view', () => ({
  openSession: (...args: unknown[]) => mocks.openSession(...args),
  openRoutine: vi.fn(),
}))

vi.mock('@renderer/stores/sessions', () => ({
  useSessionsStore: <T>(selector: (state: { byId: Record<string, SessionSummary> }) => T) =>
    selector({ byId: storeState.sessionsById }),
  hostOfSession: (summary: Pick<SessionSummary, 'projectPath'>) => hostOfPath(summary.projectPath),
  sessionTitle: (summary: Pick<SessionSummary, 'title' | 'id'>) => summary.title ?? summary.id,
  sessionArchived: (byId: Record<string, SessionSummary>, id: string) =>
    Boolean(byId[id]?.archivedAt),
}))

vi.mock('@renderer/stores/threads', () => ({
  useThreadsStore: <T>(selector: (state: { replicas: typeof storeState.replicas }) => T) =>
    selector({ replicas: storeState.replicas }),
}))

vi.mock('@renderer/stores/agents', () => ({
  agentName: (agentId: string) =>
    agentId === 'claude-code' ? 'Claude Code' : agentId === 'codex' ? 'Codex' : agentId,
}))

vi.mock('@renderer/stores/projects', () => ({
  useProjectsStore: <T>(selector: (state: { projects: unknown[] }) => T) =>
    selector({ projects: [] }),
  isSessionInArchivedProject: () => false,
}))

vi.mock('@renderer/stores/routines', () => ({
  useRoutinesStore: <T>(selector: (state: { byId: Record<string, unknown> }) => T) =>
    selector({ byId: {} }),
}))

vi.mock('@renderer/stores/tasks', () => ({
  useTasksStore: <T>(selector: (state: { summaries: Record<string, unknown> }) => T) =>
    selector({ summaries: {} }),
  taskFrom: () => undefined,
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: ({ agent }: { agent: string }) => createElement('span', { 'data-agent-mark': agent }),
}))

vi.mock('@renderer/components/affect/app-shell', () => ({
  Icon: () => createElement('span', { 'data-icon': '' }),
}))

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  PopoverTrigger: ({ render }: { render: ReactNode }) => createElement('div', null, render),
  PopoverContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) =>
    createElement('div', null, render ?? children),
  TooltipContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/features/split/pane-context', () => ({
  usePane: () => ({ paneId: 'pane-1', focused: true, cornered: false }),
}))

vi.mock('@renderer/features/split/session-drag-model', () => ({
  usePaneDragSource: () => ({ ref: () => undefined }),
}))

vi.mock('@renderer/features/git/pr-bar-chip', () => ({
  PrBarChip: () => null,
}))

vi.mock('@renderer/features/shell/header-tools', () => ({
  HeaderTools: () => null,
  SessionMoreMenu: () => null,
}))

vi.mock('@renderer/features/tasks/step-crumb', () => ({
  StepRoundBadge: () => null,
  TaskCrumb: () => null,
  TaskCrumbLink: () => null,
}))

vi.mock('@renderer/features/tasks/use-task', () => ({
  useStepSessionTitle: () => null,
}))

vi.mock('@renderer/features/session/plan-chip', () => ({
  PlanChip: () => null,
}))

vi.mock('@renderer/features/session/viewers-chip', () => ({
  ViewersChip: () => null,
}))

vi.mock('@renderer/features/session/worktree/worktree-tag', () => ({
  WorktreeBarChip: () => null,
}))

vi.mock('@renderer/features/shell/top-bar', () => ({
  TopBar: ({ children }: { children?: ReactNode }) => createElement('header', null, children),
  NoDrag: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/features/sidebar/session-menu', () => ({
  SessionTitleField: () => null,
}))

vi.mock('@renderer/features/sidebar/use-renaming', () => ({
  useRenaming: () => ({
    renaming: false,
    start: () => undefined,
    finish: () => undefined,
    menu: { onRename: () => undefined, onLeave: () => undefined },
  }),
}))

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    agentId: 'claude-code',
    projectPath: '/repo/kettu',
    scratch: false,
    title: overrides.id,
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

function makeUsage(overrides: {
  total?: number
  input?: number
  output?: number
  cacheRead?: number | null
  cacheWrite?: number | null
  cost?: { amount: number; currency: string } | null
  noTokens?: boolean
}): SessionUsage {
  return {
    used: 10_000,
    size: 200_000,
    cost: overrides.cost === undefined ? { amount: 0.5, currency: 'USD' } : overrides.cost,
    tokens: overrides.noTokens
      ? null
      : {
          total: overrides.total ?? 10_000,
          input: overrides.input ?? 3_000,
          output: overrides.output ?? 2_000,
          thought: null,
          cacheRead: overrides.cacheRead === undefined ? 4_000 : overrides.cacheRead,
          cacheWrite: overrides.cacheWrite === undefined ? 1_000 : overrides.cacheWrite,
        },
  }
}

function flattenBaseKeys(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const keys = new Set<string>()
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of flattenBaseKeys(value as Record<string, unknown>, full)) {
        keys.add(nested)
      }
    } else {
      keys.add(full.replace(/_(zero|one|two|few|many|other)$/, ''))
    }
  }
  return keys
}

beforeEach(() => {
  mocks.hostAt.mockReset()
  mocks.openSession.mockReset()
  mocks.backTo.mockClear()
  storeState.sessionsById = {}
  storeState.replicas = {}
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('resolveSessionFamily', () => {
  it('returns null for standalone sessions with no parent and no children', () => {
    const solo = makeSession({ id: 'solo', title: 'Solo work' })
    expect(resolveSessionFamily({ solo }, 'solo')).toBeNull()
    expect(resolveSessionFamily({ solo }, 'missing')).toBeNull()
  })

  it('resolves the same ordered tree from parent, child, and nested grandchild views', () => {
    const root = makeSession({ id: 'root', title: 'Main task', createdAt: 10 })
    const childB = makeSession({
      id: 'child-b',
      parentId: 'root',
      title: 'Second child',
      createdAt: 30,
      status: 'running',
    })
    const childA = makeSession({
      id: 'child-a',
      parentId: 'root',
      title: 'First child',
      createdAt: 20,
      origin: 'subagent',
      status: 'awaiting_permission',
      permissionCount: 1,
    })
    const grand = makeSession({
      id: 'grand',
      parentId: 'child-a',
      title: 'Grandchild',
      createdAt: 25,
      status: 'failed',
    })
    const prepared = makeSession({
      id: 'draft',
      parentId: 'root',
      createdAt: 40,
      prepared: { agentId: 'codex', projectPath: '/repo/kettu' } as never,
    })
    const archivedChild = makeSession({
      id: 'archived',
      parentId: 'root',
      createdAt: 50,
      archivedAt: 999,
    })

    const byId = {
      root,
      'child-b': childB,
      'child-a': childA,
      grand,
      draft: prepared,
      archived: archivedChild,
    }

    const fromRoot = resolveSessionFamily(byId, 'root')
    expect(fromRoot).not.toBeNull()
    expect(fromRoot!.root.id).toBe('root')
    expect(fromRoot!.parent).toBeNull()
    expect(fromRoot!.childCount).toBe(3)
    expect(fromRoot!.members.map((m) => [m.summary.id, m.depth, m.isRoot, m.isCurrent])).toEqual([
      ['root', 0, true, true],
      ['child-a', 1, false, false],
      ['grand', 2, false, false],
      ['child-b', 1, false, false],
    ])
    expect(fromRoot!.activity).toEqual({
      waitingCount: 1,
      errorCount: 1,
      runningCount: 1,
      backgroundCount: 0,
      startingCount: 0,
      hasActive: true,
    })

    const fromGrand = resolveSessionFamily(byId, 'grand')
    expect(fromGrand).not.toBeNull()
    expect(fromGrand!.root.id).toBe('root')
    expect(fromGrand!.parent?.id).toBe('child-a')
    expect(fromGrand!.members.find((m) => m.summary.id === 'child-a')?.isDirectParent).toBe(true)
    expect(fromGrand!.members.find((m) => m.summary.id === 'grand')?.isCurrent).toBe(true)
  })

  it('guards against parent cycles without infinite loops', () => {
    const a = makeSession({ id: 'a', parentId: 'b', createdAt: 1 })
    const b = makeSession({ id: 'b', parentId: 'a', createdAt: 2 })
    const family = resolveSessionFamily({ a, b }, 'a')
    expect(family).not.toBeNull()
    expect(family!.members.map((m) => m.summary.id)).toEqual(['b', 'a'])
  })

  it('keeps archived children visible when viewing an archived family root', () => {
    const root = makeSession({ id: 'root', archivedAt: 500, createdAt: 1 })
    const child = makeSession({ id: 'child', parentId: 'root', archivedAt: 500, createdAt: 2 })
    const family = resolveSessionFamily({ root, child }, 'root')
    expect(family?.members.map((m) => m.summary.id)).toEqual(['root', 'child'])
  })
})

describe('familyMemberStatus', () => {
  it('applies priority order consistently across all live states', () => {
    expect(
      familyMemberStatus(
        makeSession({ id: 's', status: 'running', permissionCount: 1, attention: 'error' }),
        false,
      ),
    ).toBe('waiting')
    expect(familyMemberStatus(makeSession({ id: 's', status: 'failed' }), false)).toBe('error')
    expect(familyMemberStatus(makeSession({ id: 's', status: 'auth_required' }), false)).toBe(
      'auth',
    )
    expect(familyMemberStatus(makeSession({ id: 's', status: 'running' }), false)).toBe('running')
    expect(
      familyMemberStatus(
        makeSession({ id: 's', status: 'running', phase: 'waiting_background' }),
        false,
      ),
    ).toBe('background')
    expect(
      familyMemberStatus(
        makeSession({
          id: 's',
          status: 'ready',
          stillRunning: { commands: 1, subagents: 0, reportsBack: false },
        }),
        false,
      ),
    ).toBe('background')
    expect(familyMemberStatus(makeSession({ id: 's', status: 'starting' }), false)).toBe('starting')
    expect(familyMemberStatus(makeSession({ id: 's', attention: 'unread' }), false)).toBe('unread')
    expect(familyMemberStatus(makeSession({ id: 's', attention: 'unread' }), true)).toBe('idle')
  })
})

describe('rollupFamilyUsage (verifiable totals & never treating unknown as zero)', () => {
  const members = [
    { summary: makeSession({ id: 'parent' }) },
    { summary: makeSession({ id: 'child-1', parentId: 'parent' }) },
    { summary: makeSession({ id: 'child-2', parentId: 'parent', origin: 'subagent' }) },
  ]

  it('sums tokens (including cache in input) and USD cost accurately when all members report', () => {
    const usageById: Record<string, MemberUsageState> = {
      parent: {
        loadState: 'ready',
        usage: makeUsage({
          total: 120_000,
          input: 10_000,
          output: 20_000,
          cacheRead: 80_000,
          cacheWrite: 10_000,
          cost: { amount: 0.6, currency: 'USD' },
        }),
      },
      'child-1': {
        loadState: 'ready',
        usage: makeUsage({
          total: 45_000,
          input: 15_000,
          output: 5_000,
          cacheRead: 20_000,
          cacheWrite: 5_000,
          cost: { amount: 0.25, currency: 'USD' },
        }),
      },
      'child-2': {
        loadState: 'ready',
        usage: makeUsage({
          total: 10_000,
          input: 8_000,
          output: 2_000,
          cacheRead: null,
          cacheWrite: null,
          cost: { amount: 0.15, currency: 'USD' },
        }),
      },
    }

    const rollup = rollupFamilyUsage(members, usageById)
    expect(rollup.tokens).toEqual({
      total: 175_000,
      input: 148_000,
      output: 27_000,
      cacheRead: 100_000,
      cacheWrite: 15_000,
      knownCount: 3,
      missingCount: 0,
      partial: false,
    })
    expect(rollup.cost.totals).toHaveLength(1)
    expect(rollup.cost.totals[0]!.currency).toBe('USD')
    expect(rollup.cost.totals[0]!.amount).toBeCloseTo(1.0, 6)
    expect(rollup.cost.knownCount).toBe(3)
    expect(rollup.cost.missingCount).toBe(0)
    expect(rollup.cost.partial).toBe(false)
    expect(rollup.missingBothCount).toBe(0)
  })

  it('marks partial cost explicitly when a child has tokens but no cost data', () => {
    const usageById: Record<string, MemberUsageState> = {
      parent: {
        loadState: 'ready',
        usage: makeUsage({ total: 100_000, cost: { amount: 0.5, currency: 'USD' } }),
      },
      'child-1': {
        loadState: 'ready',
        usage: makeUsage({ total: 40_000, cost: null }),
      },
      'child-2': {
        loadState: 'ready',
        usage: null,
      },
    }

    const rollup = rollupFamilyUsage(members, usageById)
    expect(rollup.tokens.total).toBe(140_000)
    expect(rollup.tokens.knownCount).toBe(2)
    expect(rollup.tokens.missingCount).toBe(1)
    expect(rollup.tokens.partial).toBe(true)

    expect(rollup.cost.totals).toEqual([{ currency: 'USD', amount: 0.5 }])
    expect(rollup.cost.knownCount).toBe(1)
    expect(rollup.cost.missingCount).toBe(2)
    expect(rollup.cost.partial).toBe(true)
    expect(rollup.missingBothCount).toBe(1)
    expect(rollup.sameMissingSet).toBe(false)
  })

  it('returns null tokens and empty cost totals (NEVER 0 or $0.00) when all members lack data', () => {
    const usageById: Record<string, MemberUsageState> = {
      parent: { loadState: 'ready', usage: null },
      'child-1': { loadState: 'ready', usage: makeUsage({ noTokens: true, cost: null }) },
      'child-2': { loadState: 'error', usage: null },
    }

    const rollup = rollupFamilyUsage(members, usageById)
    expect(rollup.tokens.total).toBeNull()
    expect(rollup.tokens.input).toBeNull()
    expect(rollup.tokens.output).toBeNull()
    expect(rollup.tokens.knownCount).toBe(0)
    expect(rollup.tokens.missingCount).toBe(3)
    expect(rollup.tokens.partial).toBe(false)

    expect(rollup.cost.totals).toEqual([])
    expect(rollup.cost.knownCount).toBe(0)
    expect(rollup.cost.missingCount).toBe(3)
    expect(rollup.cost.partial).toBe(false)
    expect(rollup.errorCount).toBe(1)
    expect(rollup.sameMissingSet).toBe(true)
  })

  it('distinguishes explicit known zero from missing usage data', () => {
    const two = members.slice(0, 2)
    const usageById: Record<string, MemberUsageState> = {
      parent: {
        loadState: 'ready',
        usage: makeUsage({
          total: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { amount: 0, currency: 'USD' },
        }),
      },
      'child-1': {
        loadState: 'ready',
        usage: makeUsage({
          total: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { amount: 0, currency: 'USD' },
        }),
      },
    }

    const rollup = rollupFamilyUsage(two, usageById)
    expect(rollup.tokens.total).toBe(0)
    expect(rollup.tokens.knownCount).toBe(2)
    expect(rollup.tokens.missingCount).toBe(0)
    expect(rollup.cost.totals).toEqual([{ currency: 'USD', amount: 0 }])
    expect(rollup.cost.knownCount).toBe(2)
    expect(rollup.cost.missingCount).toBe(0)
  })

  it('keeps distinct currencies separate instead of summing them together', () => {
    const two = members.slice(0, 2)
    const usageById: Record<string, MemberUsageState> = {
      parent: {
        loadState: 'ready',
        usage: makeUsage({ total: 1000, cost: { amount: 1.5, currency: 'cny' } }),
      },
      'child-1': {
        loadState: 'ready',
        usage: makeUsage({ total: 2000, cost: { amount: 0.4, currency: 'USD' } }),
      },
    }

    const rollup = rollupFamilyUsage(two, usageById)
    expect(rollup.cost.totals).toEqual([
      { currency: 'USD', amount: 0.4 },
      { currency: 'CNY', amount: 1.5 },
    ])
  })

  it('tracks loading members separately without counting them as missing or zero', () => {
    const two = members.slice(0, 2)
    const usageById: Record<string, MemberUsageState> = {
      parent: {
        loadState: 'ready',
        usage: makeUsage({ total: 5_000, cost: { amount: 0.1, currency: 'USD' } }),
      },
      'child-1': { loadState: 'loading', usage: null },
    }
    const rollup = rollupFamilyUsage(two, usageById)
    expect(rollup.loadingCount).toBe(1)
    expect(rollup.tokens.total).toBe(5_000)
    expect(rollup.tokens.missingCount).toBe(0)
    expect(rollup.cost.missingCount).toBe(0)
  })
})

describe('fetchFamilyUsages & mergeFamilyUsageSources', () => {
  it('groups requests by host and isolates host failures as error state', async () => {
    const remoteHostId = '0123456789abcdef0123456789abcdef'
    const members = [
      { summary: makeSession({ id: 'local-1', projectPath: '/repo/a' }) },
      {
        summary: makeSession({
          id: 'remote-1',
          parentId: 'local-1',
          projectPath: onHost(remoteHostId, '/srv/a'),
        }),
      },
    ]
    const localUsage = makeUsage({ total: 8_000, cost: { amount: 0.2, currency: 'USD' } })
    const fetcher = vi.fn(
      async (
        hostId: string | null,
        sessionIds: string[],
      ): Promise<{ sessions: SessionUsageItem[] }> => {
        if (hostId === null) {
          return { sessions: sessionIds.map((sessionId) => ({ sessionId, usage: localUsage })) }
        }
        throw new Error('method_not_found')
      },
    )

    const fetched = await fetchFamilyUsages(members, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetched['local-1']).toEqual({ loadState: 'ready', usage: localUsage })
    expect(fetched['remote-1']).toEqual({ loadState: 'error', usage: null })

    // Live replica overrides host error when already loaded in memory.
    const liveUsage = makeUsage({ total: 2_000, cost: null })
    const merged = mergeFamilyUsageSources(members, { 'remote-1': liveUsage }, fetched, false)
    expect(merged['local-1']).toEqual({ loadState: 'ready', usage: localUsage })
    expect(merged['remote-1']).toEqual({ loadState: 'ready', usage: liveUsage })
  })
})

describe('SessionHeader & SessionFamilyPopoverContent rendering', () => {
  it('keeps standalone sessions completely unchanged with no family trigger', async () => {
    const { SessionHeader } = await import('./session-header')
    const solo = makeSession({ id: 'solo', title: 'Standalone chat' })
    storeState.sessionsById = { solo }

    const html = renderToStaticMarkup(
      createElement(SessionHeader, { summary: solo, session: undefined }),
    )
    expect(html).not.toContain('session-family-trigger')
  })

  it('renders the extended parent-session crumb trigger for child sessions and chip trigger for parent sessions', async () => {
    const { SessionHeader } = await import('./session-header')
    const parent = makeSession({ id: 'p1', title: 'Main plan', createdAt: 1 })
    const child = makeSession({
      id: 'c1',
      parentId: 'p1',
      title: 'Research worker',
      createdAt: 2,
      status: 'running',
    })
    storeState.sessionsById = { p1: parent, c1: child }

    const childHtml = renderToStaticMarkup(
      createElement(SessionHeader, { summary: child, session: undefined }),
    )
    expect(childHtml).toContain('data-testid="session-family-trigger"')
    expect(childHtml).toContain('Main plan')

    const parentHtml = renderToStaticMarkup(
      createElement(SessionHeader, { summary: parent, session: undefined }),
    )
    expect(parentHtml).toContain('data-testid="session-family-trigger"')
    expect(parentHtml).toContain('1 sub-session')
  })

  it('renders verifiable family usage, marks current session, and explicitly annotates missing cost', async () => {
    const { SessionFamilyPopoverContent } = await import('./session-family-menu')
    const parent = makeSession({ id: 'p1', title: 'Parent task', createdAt: 1, status: 'ready' })
    const child = makeSession({
      id: 'c1',
      parentId: 'p1',
      agentId: 'codex',
      title: 'Codex worker',
      createdAt: 2,
      status: 'running',
    })
    const byId = { p1: parent, c1: child }
    const family = resolveSessionFamily(byId, 'c1')!

    storeState.sessionsById = byId
    storeState.replicas = {
      p1: {
        status: 'ready',
        state: {
          session: {
            usage: makeUsage({ total: 100_000, cost: { amount: 0.65, currency: 'USD' } }),
          },
        },
      },
      c1: {
        status: 'ready',
        state: {
          session: {
            usage: makeUsage({ total: 50_000, cost: null }),
          },
        },
      },
    }

    const html = renderToStaticMarkup(
      createElement(SessionFamilyPopoverContent, { family, onClose: () => undefined }),
    )

    expect(html).toContain('Parent task')
    expect(html).toContain('Codex worker')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('Current')
    expect(html).toContain('Running')
    expect(html).toContain('150K')
    expect(html).toContain('$0.65')
    expect(html).toContain('Partial')
    expect(html).toContain('Cost total excludes 1 session without cost data.')
    expect(html).toContain('No cost')
  })

  it('displays Unavailable instead of 0 or $0.00 when no member has reported usage', async () => {
    const { SessionFamilyPopoverContent } = await import('./session-family-menu')
    const parent = makeSession({ id: 'p1', title: 'Fresh parent', createdAt: 1 })
    const child = makeSession({ id: 'c1', parentId: 'p1', title: 'Fresh child', createdAt: 2 })
    const byId = { p1: parent, c1: child }
    const family = resolveSessionFamily(byId, 'p1')!

    storeState.sessionsById = byId
    storeState.replicas = {
      p1: { status: 'ready', state: { session: { usage: null } } },
      c1: { status: 'ready', state: { session: { usage: null } } },
    }

    const html = renderToStaticMarkup(
      createElement(SessionFamilyPopoverContent, { family, onClose: () => undefined }),
    )
    expect(html).toContain('Unavailable')
    expect(html).toContain('No usage data reported for sessions in this group yet.')
    expect(html).not.toContain('$0.00')
  })

  it('switches to parent via backTo, to sibling/child via openSession, and only closes on current', () => {
    const parent = makeSession({ id: 'p1', projectPath: '/repo/a', createdAt: 1 })
    const childA = makeSession({ id: 'c1', parentId: 'p1', projectPath: '/repo/a', createdAt: 2 })
    const childB = makeSession({ id: 'c2', parentId: 'p1', projectPath: '/repo/a', createdAt: 3 })
    const family = resolveSessionFamily({ p1: parent, c1: childA, c2: childB }, 'c1')!

    const onClose = vi.fn()
    const actions = { onClose, backTo: mocks.backTo, openSession: mocks.openSession }
    const currentMember = family.members.find((m) => m.summary.id === 'c1')!
    const parentMember = family.members.find((m) => m.summary.id === 'p1')!
    const siblingMember = family.members.find((m) => m.summary.id === 'c2')!

    selectFamilyMember(currentMember, actions)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mocks.backTo).not.toHaveBeenCalled()
    expect(mocks.openSession).not.toHaveBeenCalled()

    selectFamilyMember(parentMember, actions)
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(mocks.backTo).toHaveBeenCalledWith(
      { kind: 'session', sessionId: 'p1' },
      expect.any(Function),
    )
    expect(mocks.openSession).toHaveBeenCalledWith('p1', '/repo/a')

    mocks.openSession.mockClear()
    mocks.backTo.mockClear()
    selectFamilyMember(siblingMember, actions)
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(mocks.backTo).not.toHaveBeenCalled()
    expect(mocks.openSession).toHaveBeenCalledWith('c2', '/repo/a')
  })

  it('keeps en and zh-CN sessionFamily locale keys synchronized', () => {
    const enKeys = flattenBaseKeys(enSession.sessionFamily as Record<string, unknown>)
    const zhKeys = flattenBaseKeys(zhSession.sessionFamily as Record<string, unknown>)
    expect([...zhKeys].sort()).toEqual([...enKeys].sort())
  })
})
