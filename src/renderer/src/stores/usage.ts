import { create } from 'zustand'
import type { ContextBreakdown } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import type { UsageScope, UsageStatus, UsageSummary } from '@shared/usage'
import {
  addDays,
  dayOf,
  dayStarts,
  firstDayOfWeek,
  heatmapRange,
  rangeOf,
  type AgentFilter,
  type DayRange,
  type RangeChoice,
} from '@renderer/features/usage/model'
import { errorMessage, host } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'

export interface ContextReport {
  /** The context it was read for, as `used/size`; another one means it is out of date. */
  key: string
  breakdown: ContextBreakdown | null
  loading: boolean
  error: string | null
}

/** What the usage page shows; kept while the app runs, back to the defaults on launch. */
export interface UsageFilters {
  agent: AgentFilter
  range: RangeChoice
  scope: UsageScope
}

/** The page's figures, with the days they were read for. */
export interface UsagePage {
  today: number
  firstDay: number
  /** The day starts the summary's `day` indexes into, plus the end of the last day. */
  starts: number[]
  range: DayRange
  summary: UsageSummary
}

interface UsageStore {
  /** Each session's last context breakdown. */
  context: Record<string, ContextReport>
  status: UsageStatus | null
  /** Today's tokens, for the sidebar; null until read. */
  today: number | null
  filters: UsageFilters
  page: UsagePage | null
  loading: boolean
  error: string | null
}

export const DEFAULT_FILTERS: UsageFilters = {
  agent: 'all',
  range: { kind: 'all' },
  scope: 'computer',
}

export const useUsageStore = create<UsageStore>()(() => ({
  context: {},
  status: null,
  today: null,
  filters: DEFAULT_FILTERS,
  page: null,
  loading: false,
  error: null,
}))

function setReport(sessionId: string, report: ContextReport): void {
  useUsageStore.setState((s) => ({ context: { ...s.context, [sessionId]: report } }))
}

/**
 * Reads what fills the session's context unless it was read for the same context already. Each
 * read forks the session in the agent, so a breakdown holds until the context changes.
 */
export function loadContext(sessionId: string, key: string): void {
  const current = useUsageStore.getState().context[sessionId]
  if (current && (current.loading || (current.key === key && !current.error))) return
  setReport(sessionId, {
    key,
    breakdown: current?.breakdown ?? null,
    loading: true,
    error: null,
  })
  host('sessions.context', { sessionId })
    .then((breakdown) => setReport(sessionId, { key, breakdown, loading: false, error: null }))
    .catch((error: unknown) =>
      setReport(sessionId, {
        key,
        breakdown: current?.breakdown ?? null,
        loading: false,
        error: errorMessage(error),
      }),
    )
}

/** Asks the agent for the current use of its plan limits; they arrive in its status. */
export function refreshLimits(agentId: AgentId): Promise<void> {
  return host('agents.refreshLimits', { agentId })
}

let pageOpen = false
let request = 0
let reading: Promise<void> | null = null
let readAgain = false

/** The page came into view or left it; while it shows, a change in the figures reads them again. */
export function usagePageShown(shown: boolean): void {
  pageOpen = shown
  if (!shown) return
  readPage()
  // The page asks for a scan when it opens, so it shows what the logs hold now.
  void host('usage.sync', undefined).catch(() => {})
}

export function setUsageFilters(patch: Partial<UsageFilters>): void {
  const before = useUsageStore.getState().filters
  const filters = { ...before, ...patch }
  useUsageStore.setState({ filters })
  // The agent filter is applied to the figures already read.
  if (filters.range !== before.range || filters.scope !== before.scope) void loadUsagePage()
}

/** Reads the page's figures for its filters; a slower answer to an older request is dropped. */
export async function loadUsagePage(): Promise<void> {
  const id = ++request
  const { filters, page } = useUsageStore.getState()
  const today = dayOf(Date.now())
  const firstDay = firstDayOfWeek(currentLocale())
  useUsageStore.setState({ loading: true })
  try {
    let first = page?.summary.first ?? null
    for (let pass = 0; pass < 2; pass++) {
      const range = rangeOf(filters.range, today, first)
      const heat = heatmapRange(today, firstDay)
      const starts = dayStarts({ from: Math.min(range.from, heat.from), to: range.to })
      const summary = await host('usage.summary', {
        dayStarts: starts,
        from: range.from,
        to: range.to,
        scope: filters.scope,
      })
      if (id !== request) return
      // All time starts at the first day with usage, known for certain only from the answer.
      if (
        filters.range.kind === 'all' &&
        summary.first !== null &&
        dayOf(summary.first) < starts[0]!
      ) {
        first = summary.first
        continue
      }
      useUsageStore.setState({
        page: { today, firstDay, starts, range, summary },
        loading: false,
        error: null,
      })
      return
    }
  } catch (error) {
    if (id === request) useUsageStore.setState({ loading: false, error: errorMessage(error) })
  }
}

export async function loadUsageStatus(): Promise<void> {
  try {
    useUsageStore.setState({ status: await host('usage.status', undefined) })
  } catch {
    // The host is not connected; its status arrives with the next event.
  }
}

/** Today's tokens across the agents, as the sidebar shows them. */
export async function loadToday(): Promise<void> {
  const today = dayOf(Date.now())
  try {
    const total = await host('usage.total', { from: today, to: addDays(today, 1) })
    useUsageStore.setState({ today: total.total })
  } catch {
    // Shown as nothing until the host answers.
  }
}

export function usageChanged(): void {
  void loadToday()
  if (pageOpen) readPage()
}

/** Reads the page, or once more after the read under way, so a scan's notices never pile up. */
function readPage(): void {
  if (reading) {
    readAgain = true
    return
  }
  reading = loadUsagePage().finally(() => {
    reading = null
    if (readAgain && pageOpen) {
      readAgain = false
      readPage()
    }
  })
}

export function receiveUsageStatus(status: UsageStatus): void {
  useUsageStore.setState({ status })
}

export function syncUsage(): Promise<void> {
  return host('usage.sync', undefined)
}

export function reimportUsage(agentId: AgentId): Promise<void> {
  return host('usage.reimport', { agentId })
}

export function clearUsageRecord(): Promise<void> {
  return host('usage.clearRecord', undefined)
}
