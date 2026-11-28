import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SessionSummary } from '@shared/agent-host'
import enSidebar from '@shared/locales/en/sidebar.json'
import zhSidebar from '@shared/locales/zh-CN/sidebar.json'

interface RecordedButton {
  attrs: Record<string, unknown>
  onClick?: () => void
}

interface RecordedSessionRow {
  sessionId: string
  projectPath: string
  context?: string
  tabStopId: string | null
  onOpen: () => void
}

let mockIsMac = true
let mockLocale: 'en' | 'zh-CN' = 'en'
const recordedButtons: RecordedButton[] = []
const recordedRows: RecordedSessionRow[] = []

function lookup(
  catalog: Record<string, unknown>,
  key: string,
  params?: Record<string, unknown>,
): string {
  const count = typeof params?.count === 'number' ? params.count : undefined
  const candidates =
    count !== undefined ? [count === 1 ? `${key}_one` : `${key}_other`, `${key}_other`, key] : [key]
  for (const candidate of candidates) {
    const value = candidate.split('.').reduce<unknown>((cur, part) => {
      if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
        return (cur as Record<string, unknown>)[part]
      }
      return undefined
    }, catalog)
    if (typeof value === 'string') {
      return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? ''))
    }
  }
  return key
}

vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand')>()
  return {
    ...actual,
    create: ((...args: unknown[]) => {
      const result = (actual.create as (...a: unknown[]) => unknown)(...args)
      if (typeof result === 'function') {
        const hook = result as ((...a: unknown[]) => unknown) & {
          getState?: () => unknown
          getInitialState?: () => unknown
        }
        if (hook.getState) {
          return (selector?: (s: unknown) => unknown) =>
            selector ? selector(hook.getState!()) : hook.getState!()
        }
        return (...innerArgs: unknown[]) => {
          const store = (result as (...a: unknown[]) => unknown)(...innerArgs) as ((
            selector?: (s: unknown) => unknown,
          ) => unknown) & {
            getState: () => unknown
            setState: (...a: unknown[]) => unknown
            subscribe: (...a: unknown[]) => unknown
            getInitialState: () => unknown
          }
          const bound = (selector?: (s: unknown) => unknown) =>
            selector ? selector(store.getState()) : store.getState()
          return Object.assign(bound, store)
        }
      }
      return result
    }) as typeof actual.create,
  }
})

vi.mock('@hugeicons/react', () => ({
  HugeiconsIcon: () => createElement('svg'),
}))

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      lookup(
        (mockLocale === 'zh-CN' ? zhSidebar : enSidebar) as unknown as Record<string, unknown>,
        key,
        params,
      ),
  }),
}))

vi.mock('@renderer/lib/platform', () => ({
  get isMac() {
    return mockIsMac
  },
  isWeb: false,
  hasBand: false,
  formatShortcut: (shortcut: string) =>
    mockIsMac ? shortcut.replace('Mod+', '⌘') : shortcut.replace('Mod+', 'Ctrl+'),
}))

vi.mock('@renderer/lib/storage', () => ({
  readJson: <T>(_key: string, fallback: T): T => fallback,
  writeJson: () => undefined,
}))

vi.mock('@renderer/lib/host', () => ({
  errorMessage: (error: unknown) => String(error),
  host: vi.fn(),
  hostAt: vi.fn(),
}))

vi.mock('@renderer/app/actions', () => ({
  newSession: vi.fn(),
}))

vi.mock('@renderer/app/bootstrap', () => ({
  retryHostState: vi.fn(),
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<Record<string, unknown>>
    children?: ReactNode
  }) => {
    if (isValidElement<Record<string, unknown>>(render)) {
      recordedButtons.push({
        attrs: render.props,
        onClick: render.props.onClick as (() => void) | undefined,
      })
      return createElement(render.type, render.props, children)
    }
    return createElement('div', null, children)
  },
  TooltipContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-tooltip-content': '' }, children),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: {
    children?: ReactNode
    onClick?: () => void
    [key: string]: unknown
  }) => {
    recordedButtons.push({ attrs: { ...rest, text: children }, onClick })
    return createElement('button', { type: 'button', ...rest }, children)
  },
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: ({ icon }: { icon: string }) => createElement('span', { 'data-glyph': icon }),
}))

vi.mock('@renderer/features/account/host-switch', () => ({
  HostSwitchBar: () => null,
}))

vi.mock('./session-row', () => ({
  SessionRow: ({
    node,
    tabStopId,
    context,
  }: {
    node: { summary: SessionSummary }
    tabStopId: string | null
    context?: string
  }) => {
    const onOpen = () => {
      openSession(node.summary.id, node.summary.projectPath)
    }
    recordedRows.push({
      sessionId: node.summary.id,
      projectPath: node.summary.projectPath,
      context,
      tabStopId,
      onOpen,
    })
    return createElement(
      'li',
      { 'data-session-row': node.summary.id, 'data-context': context },
      `${node.summary.title ?? node.summary.id} (${context ?? ''})`,
    )
  },
}))

vi.mock('./rename-hints', () => ({
  GroupRenameHints: () => null,
}))

vi.mock('./rename-scope', () => ({
  RenameScope: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('./host-label', () => ({
  useHostLabel: (hostId: string | null) =>
    hostId === null ? (mockLocale === 'zh-CN' ? '本机' : 'This computer') : hostId,
}))

import { AppShell } from '@renderer/components/affect/app-shell'
import { useHostsStore } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession, setSidebarView, showSearch, useViewStore } from '@renderer/stores/view'
import { SidebarList } from './app-sidebar'
import { SidebarHeadActions } from './sidebar-head-actions'

function fakeProject(path: string, name: string): Project {
  return { path, name, missing: false, lastOpenedAt: 1, pinnedAt: null, archivedAt: null }
}

function fakeSession(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'claude-code',
    projectPath: '/work/kettu',
    scratch: false,
    title: id,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1,
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

beforeEach(() => {
  mockIsMac = true
  mockLocale = 'en'
  recordedButtons.length = 0
  recordedRows.length = 0
  useSessionsStore.setState({ byId: {}, loaded: true, error: null })
  useProjectsStore.setState({ projects: [], noProjects: {}, loaded: true, error: null })
  useHostsStore.setState({ status: null, kept: [] })
  useViewStore.setState({
    main: { kind: 'launch' },
    searchOpen: false,
    searchInit: null,
    sidebarView: 'projects',
    hostFilter: null,
    hostOrder: [],
    settings: { open: false, section: null, item: null },
  })
})

describe('SidebarHeadActions and AppShell integration (#2563)', () => {
  it('replaces the full-width search bar with compact search + Activity buttons and opens global search', () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        chrome: 'mac',
        sidebarActions: createElement(SidebarHeadActions),
        children: createElement('div'),
      }),
    )

    expect(html).not.toContain('class="ui-as-side__search"')
    expect(html).toContain('data-has-actions=""')
    expect(html).toContain('data-sidebar-search=""')
    expect(html).toContain('data-sidebar-activity=""')
    expect(html).toContain('aria-label="Search ⌘K"')
    expect(html).toContain('aria-keyshortcuts="Meta+K"')
    expect(html).toContain('aria-label="Activity"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('Search <span class="opacity-60">⌘K</span>')

    const searchBtn = recordedButtons.find((b) => 'data-sidebar-search' in b.attrs)
    expect(searchBtn).toBeDefined()
    searchBtn!.onClick?.()
    expect(useViewStore.getState().searchOpen).toBe(true)
  })

  it('uses platform-specific shortcuts and Simplified Chinese accessible labels', () => {
    mockIsMac = false
    mockLocale = 'zh-CN'
    useSessionsStore.setState({
      byId: {
        s1: fakeSession('s1', {
          title: '待确认会话',
          status: 'awaiting_permission',
          permissionCount: 1,
        }),
      },
    })

    const html = renderToStaticMarkup(createElement(SidebarHeadActions))
    expect(html).toContain('aria-label="搜索 Ctrl+K"')
    expect(html).toContain('aria-keyshortcuts="Control+K"')
    expect(html).toContain('搜索 <span class="opacity-60">Ctrl+K</span>')
    expect(html).toContain('aria-label="活动"')
    expect(html).toContain('aria-description="1 个等你处理"')
    expect(html).toContain('data-activity-dot="waiting"')
  })

  it('toggles Activity view on and back to the project list via the Activity button', () => {
    renderToStaticMarkup(createElement(SidebarHeadActions))
    const activityBtn = recordedButtons.find((b) => 'data-sidebar-activity' in b.attrs)
    expect(activityBtn).toBeDefined()

    activityBtn!.onClick?.()
    expect(useViewStore.getState().sidebarView).toBe('activity')

    recordedButtons.length = 0
    const activeHtml = renderToStaticMarkup(createElement(SidebarHeadActions))
    expect(activeHtml).toContain('aria-pressed="true"')
    expect(activeHtml).toContain('Click again to return to projects')

    const activeBtn = recordedButtons.find((b) => 'data-sidebar-activity' in b.attrs)
    activeBtn!.onClick?.()
    expect(useViewStore.getState().sidebarView).toBe('projects')
  })
})

describe('SidebarList Activity view rendering and interactions (#2563)', () => {
  it('renders prioritized active sessions with project context and opens the clicked session', () => {
    useProjectsStore.setState({
      projects: [fakeProject('/work/kettu', 'Kettu'), fakeProject('/work/docs', 'Docs')],
      loaded: true,
    })
    useSessionsStore.setState({
      byId: {
        idle: fakeSession('idle', { title: 'Idle chat', status: 'ready', updatedAt: 900 }),
        run: fakeSession('run', {
          title: 'Build feature',
          projectPath: '/work/docs',
          status: 'running',
          phase: 'writing',
          updatedAt: 500,
        }),
        wait: fakeSession('wait', {
          title: 'Approve command',
          projectPath: '/work/kettu',
          status: 'awaiting_permission',
          permissionCount: 1,
          updatedAt: 400,
        }),
      },
      loaded: true,
    })
    setSidebarView('activity')

    const html = renderToStaticMarkup(createElement(SidebarList))
    expect(html).toContain('data-sidebar-activity-view=""')
    expect(html).toContain('Waiting for you')
    expect(html).toContain('Running')
    expect(html).not.toContain('Idle chat')

    expect(recordedRows.map((row) => [row.sessionId, row.context, row.tabStopId])).toEqual([
      ['wait', 'Kettu', 'wait'],
      ['run', 'Docs', 'wait'],
    ])

    recordedRows[1]!.onOpen()
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 'run' })
    // Activity view stays active until the user toggles back to projects.
    expect(useViewStore.getState().sidebarView).toBe('activity')
  })

  it('renders an empty state with a Back to projects action when no sessions are active', () => {
    useProjectsStore.setState({ projects: [fakeProject('/work/kettu', 'Kettu')], loaded: true })
    useSessionsStore.setState({
      byId: {
        idle: fakeSession('idle', { title: 'Idle chat', status: 'ready' }),
      },
      loaded: true,
    })
    setSidebarView('activity')

    const enHtml = renderToStaticMarkup(createElement(SidebarList))
    expect(enHtml).toContain('data-activity-empty=""')
    expect(enHtml).toContain(enSidebar.activity.emptyTitle)
    expect(enHtml).toContain(enSidebar.activity.backToProjects)

    const backBtn = recordedButtons.find((b) => b.attrs.text === enSidebar.activity.backToProjects)
    expect(backBtn).toBeDefined()
    backBtn!.onClick?.()
    expect(useViewStore.getState().sidebarView).toBe('projects')

    // Verify Simplified Chinese empty state copy as well.
    mockLocale = 'zh-CN'
    setSidebarView('activity')
    const zhHtml = renderToStaticMarkup(createElement(SidebarList))
    expect(zhHtml).toContain(zhSidebar.activity.emptyTitle)
    expect(zhHtml).toContain(zhSidebar.activity.backToProjects)
    showSearch(false)
  })
})
