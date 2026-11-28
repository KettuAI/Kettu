import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, SessionBranchesResult, SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import enHost from '@shared/locales/en/host.json'
import zhHost from '@shared/locales/zh-CN/host.json'
import enSession from '@shared/locales/en/session.json'
import zhSession from '@shared/locales/zh-CN/session.json'
import { hostOfPath } from '@renderer/lib/host-paths'
import {
  branchSwitchBlockReason,
  fetchSessionBranches,
  formatBranchTime,
  supportsNativeBranches,
  switchSessionBranch,
} from './branch-navigator-model'

const { mocks, storeState } = vi.hoisted(() => ({
  mocks: {
    hostAt: vi.fn(),
  },
  storeState: {
    agentsById: {} as Partial<Record<string, AgentStatus>>,
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
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('@renderer/stores/sessions', () => ({
  hostOfSession: (summary: Pick<SessionSummary, 'projectPath'>) => hostOfPath(summary.projectPath),
}))

vi.mock('@renderer/stores/agents', () => ({
  agentsOn: () => ({ byId: storeState.agentsById, order: Object.keys(storeState.agentsById) }),
  useAgentsStore: <T>(
    selector: (state: {
      byId: typeof storeState.agentsById
      order: string[]
      hosts: Record<string, never>
    }) => T,
  ) =>
    selector({ byId: storeState.agentsById, order: Object.keys(storeState.agentsById), hosts: {} }),
}))

vi.mock('@renderer/components/affect/app-shell', () => ({
  Icon: ({ icon }: { icon: unknown }) =>
    createElement('span', { 'data-icon': typeof icon === 'string' ? icon : 'icon' }),
}))

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  PopoverTrigger: ({ render }: { render: ReactNode }) => render,
  PopoverContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipContent: ({ children }: { children: ReactNode }) =>
    createElement('span', { 'data-tooltip': '' }, children),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement('button', props, children),
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => createElement('span', { 'data-spinner': '' }),
}))

import { BranchNavigator, BranchNavigatorPopoverContent } from './branch-navigator'

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    agentId: 'pi',
    projectPath: '/work/app',
    scratch: false,
    title: 'Pi session',
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1000,
    updatedAt: 2000,
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
    acpSessionId: 'pi-1',
    ...overrides,
  }
}

function makeAgent(branches: boolean): AgentStatus {
  return {
    id: 'pi',
    name: 'Pi',
    harnessId: 'pi',
    harnessName: 'Pi',
    isDefault: true,
    hidden: false,
    apiKey: null,
    state: 'ready',
    version: '1.5.2',
    package: null,
    signIn: 'signed-in',
    authMethods: [],
    canLogout: false,
    account: null,
    limits: [],
    detail: null,
    installUrl: null,
    progress: [],
    launchCommand: 'pi --mode rpc',
    binaryOverride: null,
    binaryCommand: 'pi',
    update: null,
    updateCheckedAt: null,
    updateSkipped: false,
    task: null,
    installMethods: [],
    cli: null,
    configDir: null,
    kettuServer: { runs: true, active: true },
    capabilities: {
      loadSession: true,
      listSessions: true,
      resumeSession: true,
      closeSession: true,
      deleteSession: true,
      forkSession: true,
      forkAtMessage: true,
      steering: true,
      rewind: true,
      ...(branches ? { branches: true } : {}),
      reports: false,
      context: false,
      liveContext: false,
      account: false,
      mcpHttp: true,
      prompt: { image: true, audio: false, embeddedContext: true },
    },
  }
}

const SAMPLE_BRANCHES: SessionBranchesResult = {
  activeLeafId: 'a2a',
  branchCount: 2,
  hasBranches: true,
  nodes: [
    {
      id: 'a1',
      parentId: null,
      label: null,
      preview: 'Shared start',
      previewRole: 'user',
      timestamp: Date.parse('2026-11-20T10:00:02.000Z'),
      turnCount: 1,
      depth: 0,
      isLeaf: false,
      isCurrent: false,
      onActivePath: true,
    },
    {
      id: 'a2a',
      parentId: 'a1',
      label: 'oauth',
      preview: 'Try OAuth approach',
      previewRole: 'user',
      timestamp: Date.parse('2026-11-20T10:01:02.000Z'),
      turnCount: 2,
      depth: 1,
      isLeaf: true,
      isCurrent: true,
      onActivePath: true,
    },
    {
      id: 'a2b',
      parentId: 'a1',
      label: null,
      preview: 'Use cookie sessions',
      previewRole: 'user',
      timestamp: Date.parse('2026-11-20T10:02:02.000Z'),
      turnCount: 1,
      depth: 1,
      isLeaf: true,
      isCurrent: false,
      onActivePath: false,
    },
  ],
}

beforeEach(() => {
  mocks.hostAt.mockReset()
  storeState.agentsById = {}
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('branch-navigator-model', () => {
  it('enables native branches only for non-subagent sessions whose agent declares branches', () => {
    const pi = makeAgent(true)
    const claude = makeAgent(false)
    expect(supportsNativeBranches(pi, makeSummary())).toBe(true)
    expect(supportsNativeBranches(pi, makeSummary({ origin: 'subagent' }))).toBe(false)
    expect(supportsNativeBranches(claude, makeSummary({ agentId: 'claude-code' }))).toBe(false)
    expect(supportsNativeBranches(undefined, makeSummary())).toBe(false)
  })

  it('blocks switching while running, awaiting permission, starting, rewound, or archived', () => {
    const ready = makeSummary({ status: 'ready' })
    expect(branchSwitchBlockReason(undefined, ready, false)).toBeNull()
    expect(branchSwitchBlockReason(undefined, ready, true)).toBe('archived')
    expect(
      branchSwitchBlockReason(
        { status: 'ready', rewound: { turns: 1 } } as Partial<SessionView> as SessionView,
        ready,
        false,
      ),
    ).toBe('rewound')
    expect(
      branchSwitchBlockReason(
        { status: 'running' } as Partial<SessionView> as SessionView,
        makeSummary({ status: 'running' }),
        false,
      ),
    ).toBe('running')
    expect(
      branchSwitchBlockReason(
        { status: 'awaiting_permission' } as Partial<SessionView> as SessionView,
        makeSummary({ status: 'awaiting_permission' }),
        false,
      ),
    ).toBe('running')
    expect(
      branchSwitchBlockReason(
        { status: 'starting' } as Partial<SessionView> as SessionView,
        makeSummary({ status: 'starting' }),
        false,
      ),
    ).toBe('starting')
    // Background-waiting sessions stay unblocked visually (host still verifies turn state).
    expect(
      branchSwitchBlockReason(
        { status: 'running', waitingBackground: true } as Partial<SessionView> as SessionView,
        makeSummary({ status: 'running', phase: 'waiting_background' }),
        false,
      ),
    ).toBeNull()
  })

  it('routes RPC requests to the owning host and formats timestamps cleanly', async () => {
    mocks.hostAt.mockResolvedValueOnce(SAMPLE_BRANCHES)
    const summary = makeSummary({ id: 's-pi', projectPath: '/work/app' })
    const listed = await fetchSessionBranches(summary)
    expect(listed).toEqual(SAMPLE_BRANCHES)
    expect(mocks.hostAt).toHaveBeenCalledWith(null, 'sessions.branches', { sessionId: 's-pi' })

    mocks.hostAt.mockResolvedValueOnce({ ...SAMPLE_BRANCHES, activeLeafId: 'a2b' })
    await switchSessionBranch(summary, 'a2b')
    expect(mocks.hostAt).toHaveBeenCalledWith(null, 'sessions.switchBranch', {
      sessionId: 's-pi',
      branchId: 'a2b',
    })

    expect(formatBranchTime(null, 'en')).toBeNull()
    expect(formatBranchTime(Date.parse('2026-11-20T10:01:02.000Z'), 'en')).toBeTruthy()
  })
})

describe('BranchNavigator UI rendering', () => {
  it('renders nothing for harnesses without native branches and shows trigger for Pi sessions', () => {
    storeState.agentsById = { 'claude-code': makeAgent(false), pi: makeAgent(true) }

    const hidden = renderToStaticMarkup(
      createElement(BranchNavigator, {
        summary: makeSummary({ agentId: 'claude-code' }),
        session: undefined,
        archived: false,
      }),
    )
    expect(hidden).toBe('')

    const shown = renderToStaticMarkup(
      createElement(BranchNavigator, {
        summary: makeSummary({ agentId: 'pi' }),
        session: { status: 'ready' } as Partial<SessionView> as SessionView,
        archived: false,
      }),
    )
    expect(shown).toContain('data-testid="session-branches-trigger"')
    expect(shown).not.toContain('data-locked')

    const locked = renderToStaticMarkup(
      createElement(BranchNavigator, {
        summary: makeSummary({ agentId: 'pi', status: 'running' }),
        session: { status: 'running' } as Partial<SessionView> as SessionView,
        archived: false,
      }),
    )
    expect(locked).toContain('data-locked=""')
    expect(locked).toContain('Switching branches is disabled while the agent is running.')
  })

  it('renders branch tree rows with current indicator, labels, fork point metadata, and running lock', () => {
    const html = renderToStaticMarkup(
      createElement(BranchNavigatorPopoverContent, {
        summary: makeSummary(),
        initialData: SAMPLE_BRANCHES,
        blocked: null,
        onUpdated: () => {},
        onClose: () => {},
      }),
    )
    expect(html).toContain('data-testid="session-branches-list"')
    expect(html).toContain('Shared start')
    expect(html).toContain('Branch point')
    expect(html).toContain('Try OAuth approach')
    expect(html).toContain('oauth')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('Current')
    expect(html).toContain('Use cookie sessions')
    expect(html).not.toContain('data-testid="session-branches-blocked"')

    const lockedHtml = renderToStaticMarkup(
      createElement(BranchNavigatorPopoverContent, {
        summary: makeSummary({ status: 'running' }),
        initialData: SAMPLE_BRANCHES,
        blocked: 'running',
        onUpdated: () => {},
        onClose: () => {},
      }),
    )
    expect(lockedHtml).toContain('data-testid="session-branches-blocked"')
    expect(lockedHtml).toContain('Switching branches is disabled while the agent is running.')
    expect(lockedHtml).toContain('disabled=""')
    expect(lockedHtml).toContain('aria-disabled="true"')
  })

  it('renders empty and loading states cleanly', () => {
    const emptyHtml = renderToStaticMarkup(
      createElement(BranchNavigatorPopoverContent, {
        summary: makeSummary(),
        initialData: { activeLeafId: null, branchCount: 0, hasBranches: false, nodes: [] },
        blocked: null,
        onUpdated: () => {},
        onClose: () => {},
      }),
    )
    expect(emptyHtml).toContain('data-testid="session-branches-empty"')

    const loadingHtml = renderToStaticMarkup(
      createElement(BranchNavigatorPopoverContent, {
        summary: makeSummary(),
        initialData: null,
        blocked: null,
        onUpdated: () => {},
        onClose: () => {},
      }),
    )
    expect(loadingHtml).toContain('data-testid="session-branches-loading"')
  })

  it('keeps en and zh-CN branch locale keys synchronized', () => {
    const baseKeys = (obj: Record<string, unknown>, prefix = ''): string[] => {
      const out = new Set<string>()
      for (const [k, v] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${k}` : k
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const nested of baseKeys(v as Record<string, unknown>, full)) out.add(nested)
        } else {
          out.add(full.replace(/_(zero|one|two|few|many|other)$/, ''))
        }
      }
      return [...out].sort()
    }
    expect(baseKeys(zhSession.branches as unknown as Record<string, unknown>)).toEqual(
      baseKeys(enSession.branches as unknown as Record<string, unknown>),
    )
    expect(baseKeys(zhHost.branch as unknown as Record<string, unknown>)).toEqual(
      baseKeys(enHost.branch as unknown as Record<string, unknown>),
    )
    expect(baseKeys(zhHost.pi.branch as unknown as Record<string, unknown>)).toEqual(
      baseKeys(enHost.pi.branch as unknown as Record<string, unknown>),
    )
  })
})
