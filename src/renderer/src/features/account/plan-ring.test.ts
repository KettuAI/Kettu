import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import enSidebar from '@shared/locales/en/sidebar.json'
import enUsage from '@shared/locales/en/usage.json'
import { DEFAULT_SETTINGS } from '@shared/settings'

const NOW = 1_764_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

const CATALOGS: Record<string, Record<string, unknown>> = {
  sidebar: enSidebar as unknown as Record<string, unknown>,
  usage: enUsage as unknown as Record<string, unknown>,
}

function lookup(namespace: string, key: string, params?: Record<string, unknown>): string {
  const catalog = CATALOGS[namespace]
  if (!catalog) return key
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

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: (ns?: string | readonly string[]) => {
    const defaultNs = Array.isArray(ns) ? (ns[0] ?? 'sidebar') : (ns ?? 'sidebar')
    return {
      t: (rawKey: string, params?: Record<string, unknown>) => {
        const colon = rawKey.indexOf(':')
        const namespace = colon >= 0 ? rawKey.slice(0, colon) : defaultNs
        const key = colon >= 0 ? rawKey.slice(colon + 1) : rawKey
        return lookup(namespace, key, params)
      },
    }
  },
}))

vi.mock('@hugeicons/react', () => ({
  HugeiconsIcon: () => createElement('svg'),
}))

vi.mock('@dnd-kit/react', () => ({
  DragDropProvider: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  PointerSensor: {},
}))

vi.mock('@dnd-kit/react/sortable', () => ({
  isSortable: () => false,
  useSortable: () => ({ ref: () => undefined, isDragging: false }),
}))

vi.mock('@renderer/components/affect/app-shell', () => ({
  Icon: () => createElement('span'),
  Popover: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? createElement('div', { 'data-popover': '' }, children) : null,
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: () => createElement('span'),
  AgentTile: () => createElement('span'),
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<Record<string, unknown>>
    children?: ReactNode
  }) =>
    isValidElement<Record<string, unknown>>(render)
      ? createElement(render.type, render.props, children)
      : createElement('div', null, children),
  TooltipContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-tooltip-content': '' }, children),
}))

vi.mock('@renderer/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  HoverCardTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<Record<string, unknown>>
    children?: ReactNode
  }) =>
    isValidElement<Record<string, unknown>>(render)
      ? createElement(render.type, render.props, children)
      : createElement('div', null, children),
  HoverCardContent: () => null,
}))

vi.mock('@renderer/features/session/composer/host-info', () => ({
  useHostInfo: () => ({ platform: 'darwin' }),
}))

vi.mock('@renderer/features/session/composer/usage', () => ({
  PlanPart: () => null,
}))

vi.mock('@renderer/features/settings/remote-parts', () => ({
  HostIcon: () => createElement('span'),
}))

vi.mock('@renderer/lib/host', () => ({
  errorMessage: (error: unknown) => String(error),
  host: vi.fn(),
  hostAt: vi.fn(),
}))

vi.mock('@renderer/lib/platform', () => ({
  isMac: true,
  isWeb: false,
  platform: 'darwin',
}))

vi.mock('@renderer/lib/storage', () => ({
  readJson: <T>(_key: string, fallback: T): T => fallback,
  writeJson: () => undefined,
}))

vi.mock('@renderer/lib/use-now', () => ({
  useNow: () => NOW,
}))

import { accountAgents, newestReadings } from '@renderer/lib/plan-readings'
import { useAgentsStore } from '@renderer/stores/agents'
import { useHostsStore } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { useViewStore } from '@renderer/stores/view'
import { PlanLimits } from '@renderer/features/usage/plan-limits'
import { planCards } from './model'
import { PlanLimitCard } from './plan-limit-card'
import { PlanRing } from './plan-ring'

interface RenderedRingArc {
  levelClass: string
  /** Rounded percentage filled on the arc (0 when no arc circle is drawn). */
  percent: number
  lineCap: string | null
}

/** Extracts the `<PlanRings />` SVG for the Usage page card (excluding the PassedKey legend). */
function extractUsageCardRingsSvg(html: string): string {
  const match = /<svg\b[^>]*class="[^"]*\bk-u-rings\b[^"]*"[^>]*>[\s\S]*?<\/svg>/.exec(html)
  expect(match).not.toBeNull()
  return match![0]
}

/** Extracts each rendered `<PlanRings />` group's color class and filled percentage from SVG HTML. */
function parseRenderedRings(html: string): RenderedRingArc[] {
  const results: RenderedRingArc[] = []
  const groupPattern = /<g class="(text-limit-(?:ok|warn|bad))">([\s\S]*?)<\/g>/g
  for (const match of html.matchAll(groupPattern)) {
    const levelClass = match[1]!
    const body = match[2]!
    // Skip the time-passed overlay circle; read the primary progress arc circle.
    const circles = [...body.matchAll(/<circle\b([^>]*)>/g)].map((m) => m[1]!)
    const arc = circles.find(
      (attrs) => attrs.includes('stroke-dasharray=') && !attrs.includes('opacity-(--ring-passed)'),
    )
    if (!arc) {
      results.push({ levelClass, percent: 0, lineCap: null })
      continue
    }
    const dashMatch = /stroke-dasharray="([^"]+)"/.exec(arc)
    const [dashRaw, lengthRaw] = (dashMatch?.[1] ?? '0 1').split(/\s+/)
    const dash = Number(dashRaw)
    const length = Number(lengthRaw)
    const lineCap = /stroke-linecap="([^"]+)"/.exec(arc)?.[1] ?? null
    results.push({
      levelClass,
      percent: length > 0 ? Math.round((dash / length) * 100) : 0,
      lineCap,
    })
  }
  return results
}

function makeLimit(overrides: Partial<PlanLimit> = {}): PlanLimit {
  return {
    window: 'five_hour',
    label: '5-hour',
    usedPercent: 14,
    resetsAt: NOW + 2 * HOUR,
    observedAt: NOW - 60_000,
    state: 'ok',
    ...overrides,
  }
}

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'antigravity',
    harnessId: 'antigravity',
    harnessName: 'Google Antigravity',
    name: 'Google Antigravity',
    isDefault: true,
    registered: true,
    disabled: false,
    hidden: false,
    apiKey: null,
    state: 'ready',
    version: '1.0.0',
    package: null,
    signIn: 'signed-in',
    authMethods: [],
    canLogout: true,
    account: { kind: 'account', label: 'Google AI Ultra', email: 'alex@example.com' },
    limits: [],
    balances: [],
    detail: null,
    installUrl: null,
    progress: [],
    launchCommand: 'agy',
    binaryOverride: null,
    binaryCommand: null,
    update: null,
    updateCheckedAt: null,
    updateSkipped: false,
    task: null,
    installMethods: [],
    cli: null,
    configDir: null,
    kettuServer: { runs: false, active: null },
    capabilities: {
      loadSession: true,
      listSessions: true,
      resumeSession: true,
      closeSession: true,
      deleteSession: true,
      forkSession: false,
      forkAtMessage: false,
      steering: false,
      reports: true,
      context: true,
      liveContext: false,
      account: true,
      mcpHttp: null,
      prompt: null,
    },
    ...overrides,
  }
}

function setLimitView(limits: 'used' | 'left'): void {
  useSettingsStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      usage: { ...DEFAULT_SETTINGS.usage, limits },
    },
    loaded: true,
  })
}

function seedAgent(agent: AgentStatus): void {
  useAgentsStore.setState({
    byId: { [agent.id]: agent },
    order: [agent.id],
    hosts: {},
    loaded: true,
  })
  useViewStore.setState({
    main: { kind: 'new', agentId: agent.id, noProject: true },
    projectPath: null,
    hostFilter: null,
    hostOrder: [],
  })
}

beforeEach(() => {
  setLimitView('used')
  useAgentsStore.setState({ byId: {}, order: [], hosts: {}, loaded: true })
  useHostsStore.setState({ status: null, kept: [] })
  useSessionsStore.setState({ byId: {}, loaded: true, error: null })
  useViewStore.setState({
    main: { kind: 'launch' },
    projectPath: null,
    hostFilter: null,
    hostOrder: [],
  })
})

describe('PlanRing limit view sync (#3017)', () => {
  it('draws outer sidebar rings with shownPercent matching tooltip, PlanLimitCard, and PlanLimits in both used and left views', () => {
    const agent = makeAgent({
      limits: [
        makeLimit({
          window: 'five_hour_gemini',
          label: '5-hour · Gemini',
          usedPercent: 14,
          resetsAt: NOW + 3 * HOUR,
          state: 'ok',
        }),
        makeLimit({
          window: 'five_hour_claude',
          label: '5-hour · Claude',
          usedPercent: 75,
          resetsAt: NOW + 3 * HOUR,
          state: 'ok',
        }),
        makeLimit({
          window: 'seven_day_gemini',
          label: 'Weekly · Gemini',
          usedPercent: 2,
          resetsAt: NOW + 5 * DAY,
          state: 'ok',
        }),
        makeLimit({
          window: 'seven_day_claude',
          label: 'Weekly · Claude',
          usedPercent: 92,
          resetsAt: NOW + 5 * DAY,
          state: 'warning',
        }),
      ],
    })
    seedAgent(agent)

    const hosts = [{ hostId: null, agents: [agent] }]
    const [card] = planCards(accountAgents(hosts, newestReadings(hosts)), NOW)
    expect(card).toBeDefined()

    // Used view: arcs and labels show share used; warn/bad levels stay on 75% and 92%.
    setLimitView('used')
    const usedOuterHtml = renderToStaticMarkup(createElement(PlanRing))
    const usedCardHtml = renderToStaticMarkup(
      createElement(PlanLimitCard, { card: card!, index: 0, dragging: false, onOpen: () => {} }),
    )
    const usedPageHtml = renderToStaticMarkup(createElement(PlanLimits, { used: {} }))

    const usedOuterRings = parseRenderedRings(usedOuterHtml)
    expect(usedOuterRings).toEqual([
      { levelClass: 'text-limit-ok', percent: 14, lineCap: 'round' },
      { levelClass: 'text-limit-warn', percent: 75, lineCap: 'round' },
      { levelClass: 'text-limit-ok', percent: 2, lineCap: 'round' },
      { levelClass: 'text-limit-bad', percent: 92, lineCap: 'round' },
    ])
    expect(parseRenderedRings(usedCardHtml)).toEqual(usedOuterRings)
    // Usage page orders rings from outermost down (longest window first) before reversing for PlanRings.
    expect(
      parseRenderedRings(extractUsageCardRingsSvg(usedPageHtml))
        .map((r) => `${r.levelClass}:${r.percent}`)
        .sort(),
    ).toEqual(usedOuterRings.map((r) => `${r.levelClass}:${r.percent}`).sort())
    expect(usedOuterHtml).toContain('14% used')
    expect(usedOuterHtml).toContain('75% used')
    expect(usedOuterHtml).toContain('2% used')
    expect(usedOuterHtml).toContain('92% used')

    // Left view: outer ring arcs invert to remaining share while preserving severity colors.
    setLimitView('left')
    const leftOuterHtml = renderToStaticMarkup(createElement(PlanRing))
    const leftCardHtml = renderToStaticMarkup(
      createElement(PlanLimitCard, { card: card!, index: 0, dragging: false, onOpen: () => {} }),
    )
    const leftPageHtml = renderToStaticMarkup(createElement(PlanLimits, { used: {} }))

    const leftOuterRings = parseRenderedRings(leftOuterHtml)
    expect(leftOuterRings).toEqual([
      { levelClass: 'text-limit-ok', percent: 86, lineCap: 'round' },
      { levelClass: 'text-limit-warn', percent: 25, lineCap: 'round' },
      { levelClass: 'text-limit-ok', percent: 98, lineCap: 'round' },
      { levelClass: 'text-limit-bad', percent: 8, lineCap: 'round' },
    ])
    expect(parseRenderedRings(leftCardHtml)).toEqual(leftOuterRings)
    expect(
      parseRenderedRings(extractUsageCardRingsSvg(leftPageHtml))
        .map((r) => `${r.levelClass}:${r.percent}`)
        .sort(),
    ).toEqual(leftOuterRings.map((r) => `${r.levelClass}:${r.percent}`).sort())
    expect(leftOuterHtml).toContain('86% left')
    expect(leftOuterHtml).toContain('25% left')
    expect(leftOuterHtml).toContain('98% left')
    expect(leftOuterHtml).toContain('8% left')
  })

  it('handles 0% and 100% reached boundaries accurately across used and left views', () => {
    const agent = makeAgent({
      id: 'codex',
      harnessId: 'codex',
      harnessName: 'Codex',
      name: 'Codex',
      account: { kind: 'account', label: 'ChatGPT Plus', email: 'alex@example.com' },
      limits: [
        makeLimit({
          window: 'five_hour',
          label: '5-hour',
          usedPercent: 0,
          resetsAt: NOW + 4 * HOUR,
          state: 'ok',
        }),
        makeLimit({
          window: 'seven_day',
          label: 'Weekly',
          usedPercent: 100,
          resetsAt: NOW + 4 * DAY,
          state: 'reached',
        }),
      ],
    })
    seedAgent(agent)

    setLimitView('used')
    expect(parseRenderedRings(renderToStaticMarkup(createElement(PlanRing)))).toEqual([
      { levelClass: 'text-limit-ok', percent: 0, lineCap: null },
      { levelClass: 'text-limit-bad', percent: 100, lineCap: 'butt' },
    ])

    setLimitView('left')
    const leftHtml = renderToStaticMarkup(createElement(PlanRing))
    expect(parseRenderedRings(leftHtml)).toEqual([
      { levelClass: 'text-limit-ok', percent: 100, lineCap: 'butt' },
      { levelClass: 'text-limit-bad', percent: 0, lineCap: null },
    ])
    expect(leftHtml).toContain('100% left')
    expect(leftHtml).toContain('0% left')
  })
})
