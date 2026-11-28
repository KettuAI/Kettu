import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import type { ContextReport } from '@shared/context'
import enCommon from '@shared/locales/en/common.json'
import enComposer from '@shared/locales/en/composer.json'
import type { SessionUsage } from '@shared/thread'

let mockMcpChanged: string[] | undefined = undefined
let mockContextReports: Record<string, ContextReport | undefined> = {}
let capturedPopoverOnOpenChange: ((open: boolean) => void) | undefined
let capturedPopoverContentProps: Record<string, unknown> | null = null

const { mockCollisionPadding, mockHost, mockLoadContext, mockRefreshLimits } = vi.hoisted(() => ({
  mockCollisionPadding: { top: 40, right: 5, bottom: 5, left: 5 },
  mockHost: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  mockRefreshLimits: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  mockLoadContext: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}))

function lookup(catalog: Record<string, unknown>, key: string): string {
  const value = key.split('.').reduce<unknown>((cur, part) => {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[part]
    }
    return undefined
  }, catalog)
  return typeof value === 'string' ? value : key
}

function translate(key: string, values?: Record<string, unknown>): string {
  const [ns, keyPath] = key.includes(':') ? key.split(':', 2) : ['composer', key]
  const catalog = (ns === 'common' ? enCommon : enComposer) as Record<string, unknown>
  let resolved = keyPath!
  if (values && typeof values.count === 'number') {
    const suffix = values.count === 1 ? '_one' : '_other'
    const plural = lookup(catalog, `${resolved}${suffix}`)
    if (plural !== `${resolved}${suffix}`) resolved = `${resolved}${suffix}`
  }
  let text = lookup(catalog, resolved)
  if (values) {
    for (const [name, val] of Object.entries(values)) {
      text = text.replaceAll(`{{${name}}}`, String(val))
    }
  }
  return text
}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: translate }),
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, unknown> }) =>
    createElement('span', null, translate(i18nKey, values)),
}))

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    capturedPopoverOnOpenChange = onOpenChange
    return createElement('div', { 'data-mock': 'popover' }, children)
  },
  PopoverTrigger: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-mock': 'popover-trigger' }, children),
  PopoverContent: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    capturedPopoverContentProps = props
    return createElement(
      'div',
      { 'data-mock': 'popover-content', className: props.className },
      children,
    )
  },
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  TooltipTrigger: ({ children, render }: { children?: ReactNode; render?: ReactNode }) =>
    createElement('span', null, render ?? children),
  TooltipContent: () => null,
}))

vi.mock('@renderer/components/ui/collapsible', () => ({
  Collapsible: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  CollapsibleTrigger: ({
    children,
    ...props
  }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement('button', { type: 'button', ...props }, children),
  CollapsibleContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement('button', { type: 'button', ...props }, children),
}))

vi.mock('@renderer/components/ui/skeleton', () => ({
  Skeleton: () => createElement('span', null),
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => createElement('span', { 'data-mock': 'spinner' }),
}))

vi.mock('@renderer/components/ui/toast', () => ({
  toast: vi.fn(),
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: () => createElement('span', { 'data-mock': 'agent-mark' }),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: () => null,
}))

vi.mock('@renderer/features/requests/icon', () => ({
  REQUESTS_ICON: 'requests',
}))

vi.mock('@renderer/features/requests/support', () => ({
  readsModelRequests: () => true,
}))

vi.mock('@renderer/features/prompt-cache/cache-phase', () => ({
  useCacheLeft: () => null,
  useCachePhase: () => null,
}))

vi.mock('@renderer/features/session/use-thread', () => ({
  useSessionView: () => undefined,
}))

vi.mock('@renderer/hooks/use-limit-view', () => ({
  useLimitView: () => 'used',
}))

vi.mock('@renderer/lib/use-now', () => ({
  useNow: () => 1_700_000_000_000,
}))

vi.mock('@renderer/lib/platform', () => ({
  menuCollisionPadding: mockCollisionPadding,
}))

vi.mock('@renderer/lib/host', () => ({
  errorMessage: (error: unknown) => String(error),
  host: (...args: unknown[]) => mockHost(...args),
  sessionHost: () => 'local',
}))

vi.mock('@renderer/stores/settings', () => ({
  useSettingsStore: {
    getState: () => ({ update: vi.fn() }),
  },
}))

vi.mock('@renderer/stores/threads', () => ({
  useThreadsStore: <T>(
    selector: (state: {
      replicas: Record<string, { state?: { session: { mcpChanged?: string[] } } }>
    }) => T,
  ) =>
    selector({
      replicas: {
        s1: {
          state: {
            session: {
              mcpChanged: mockMcpChanged,
            },
          },
        },
      },
    }),
}))

vi.mock('@renderer/stores/usage', () => ({
  loadContext: (...args: unknown[]) => mockLoadContext(...args),
  refreshLimits: (...args: unknown[]) => mockRefreshLimits(...args),
  useUsageStore: <T>(selector: (state: { context: typeof mockContextReports }) => T) =>
    selector({ context: mockContextReports }),
}))

vi.mock('@renderer/stores/view', () => ({
  toggleSidePane: vi.fn(),
}))

import { ContextButton } from './usage'

const BASE_USAGE: SessionUsage = {
  used: 120_000,
  size: 512_000,
  tokens: {
    total: 125_000,
    input: 20_000,
    output: 5_000,
    thought: null,
    cacheRead: 100_000,
    cacheWrite: null,
  },
  cost: null,
}

const ACCOUNT_WITH_PLAN: AgentAccount = {
  kind: 'account',
  label: 'Antigravity',
  email: null,
  tier: 'Pro',
}

const SAMPLE_LIMIT: PlanLimit = {
  window: 'five_hour',
  label: '5-hour',
  usedPercent: 42,
  resetsAt: 1_700_010_000_000,
  state: 'ok',
  observedAt: 1_700_000_000_000,
}

function renderContextButton(overrides: Partial<Parameters<typeof ContextButton>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ContextButton, {
      sessionId: 's1',
      agentId: 'antigravity',
      idle: true,
      closed: false,
      reports: true,
      direct: true,
      live: true,
      usage: BASE_USAGE,
      limits: [],
      holding: [],
      account: ACCOUNT_WITH_PLAN,
      model: 'Gemini 4 Neon',
      ...overrides,
    }),
  )
}

describe('ContextButton popover', () => {
  beforeEach(() => {
    mockMcpChanged = undefined
    mockContextReports = {}
    capturedPopoverOnOpenChange = undefined
    capturedPopoverContentProps = null
    mockHost.mockClear()
    mockRefreshLimits.mockClear()
    mockLoadContext.mockClear()
  })

  it('omits the MCP section and makes zero sessions.mcpServers RPC calls when mcpChanged is empty', () => {
    mockMcpChanged = []
    const html = renderContextButton()

    expect(html).not.toContain('kettu-ctx__mcp')
    expect(html).not.toContain('MCP servers')
    expect(html).not.toContain('Manage')
    expect(html).not.toContain('Use now')

    capturedPopoverOnOpenChange?.(true)
    expect(mockHost).not.toHaveBeenCalledWith('sessions.mcpServers', expect.anything())
    expect(mockHost).not.toHaveBeenCalledWith('sessions.mcpServer', expect.anything())
  })

  it('renders only the minimal Use now notice banner when mcpChanged is non-empty', () => {
    mockMcpChanged = ['github', 'linear']
    const idleHtml = renderContextButton({ idle: true })

    expect(idleHtml).toContain('kettu-ctx__mcp-notice')
    expect(idleHtml).toContain('github, linear were added or changed since this session started.')
    expect(idleHtml).toContain('Use now')
    expect(idleHtml).not.toContain('kettu-ctx__mcp-head')
    expect(idleHtml).not.toContain('kettu-ctx__mcp-list')
    expect(idleHtml).not.toContain('Manage')
    expect(mockHost).not.toHaveBeenCalledWith('sessions.mcpServers', expect.anything())

    const busyHtml = renderContextButton({ idle: false })
    expect(busyHtml).toContain('disabled=""')
    expect(busyHtml).toContain('Available once the turn ends')
  })

  it('hides PlanLimits when limits is empty even if account.kind is account', () => {
    const emptyLimitsHtml = renderContextButton({
      account: ACCOUNT_WITH_PLAN,
      limits: [],
    })
    expect(emptyLimitsHtml).not.toContain('kettu-ctx__plan')
    expect(emptyLimitsHtml).not.toContain('Plan limits')

    const withLimitsHtml = renderContextButton({
      account: ACCOUNT_WITH_PLAN,
      limits: [SAMPLE_LIMIT],
    })
    expect(withLimitsHtml).toContain('kettu-ctx__plan')
    expect(withLimitsHtml).toContain('Plan limits')

    const apiKeyHtml = renderContextButton({
      account: { kind: 'api_key', label: 'API key', email: null },
      limits: [SAMPLE_LIMIT],
    })
    expect(apiKeyHtml).not.toContain('kettu-ctx__plan')
  })

  it('configures outer popover scrolling cleanly without clipping top-level breakdown parts', () => {
    renderContextButton()
    expect(capturedPopoverContentProps?.collisionPadding).toEqual(mockCollisionPadding)
    expect(String(capturedPopoverContentProps?.className)).toContain(
      'max-h-[calc(var(--available-height)-8px)]',
    )
    expect(String(capturedPopoverContentProps?.className)).toContain('overflow-y-auto')
    expect(String(capturedPopoverContentProps?.className)).toContain('overscroll-contain')

    const css = readFileSync(
      path.resolve(import.meta.dirname, '../../../styles/affect.css'),
      'utf8',
    )
    const ctxBlock = /\.kettu-ctx\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(ctxBlock).toContain('flex: none;')

    const partsBlock = /\.kettu-ctx__parts\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(partsBlock).not.toContain('max-height:')
    expect(partsBlock).not.toContain('overflow-y:')

    const partItemsBlock = /\.kettu-ctx__part-items\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(partItemsBlock).toContain('max-height: calc(6 * 20px + 4px);')
    expect(partItemsBlock).toContain('overflow-y: auto;')
    expect(partItemsBlock).toContain('overscroll-behavior: contain;')

    const partItemRowBlock = /\.kettu-ctx__part-items\s*>\s*li\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(partItemRowBlock).toContain('flex: none;')

    expect(css).not.toContain('.kettu-ctx__mcp-head')
    expect(css).not.toContain('.kettu-ctx__mcp-list')
    expect(css).not.toContain('.kettu-ctx__mcp-row')
  })
})
