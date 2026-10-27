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
  hourStarts,
  oneDay,
  rangeOf,
  type AgentFilter,
  type DayRange,
  type Generations,
  type Metric,
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
  /** What the figures count: tokens, requests (turns under OverBench only), or cost. */
  metric: Metric
  agent: AgentFilter
  range: RangeChoice
  scope: UsageScope
}

/** The page's figures, with the days they were read for. */
export interface UsagePage {
  /** The range and source they were read for; others are chosen while newer figures load. */
  filters: Pick<UsageFilters, 'range' | 'scope'>
  /** The `figures` generation of the range and source they were read for. */
  generation: number
  today: number
  firstDay: number
  /** The day starts the summary's `day` indexes into, plus the end of the last day. */
  starts: number[]
  range: DayRange
  summary: UsageSummary
  /** A one-day range's sums per hour, for its trend; null for a longer range. */
  hours: { starts: number[]; summary: UsageSummary } | null
}

interface UsageStore {
  /** Each session's last context breakdown. */
  context: Record<string, ContextReport>
  status: UsageStatus | null
  /** Today's tokens, for the sidebar; null until read. */
  today: number | null
  /** Today's estimated cost in dollars; null until read, or while no model had a price. */
  todayCost: number | null
  filters: UsageFilters
  /** How many times the filters have changed; the page carries `figures` once its figures arrive. */
  generations: Generations
  page: UsagePage | null
  loading: boolean
  error: string | null
}

export const DEFAULT_FILTERS: UsageFilters = {
  metric: 'tokens',
  agent: 'all',
  range: { kind: 'all' },
  scope: 'computer',
}

export const useUsageStore = create<UsageStore>()(() => ({
  context: {},
  status: null,
  today: null,
  todayCost: null,
  filters: DEFAULT_FILTERS,
  generations: { agent: 0, figures: 0 },
  page: null,
  loading: false,
  error: null,
}))

function setReport(sessionId: string, report: ContextReport): void {
  useUsageStore.setState((s) => ({ context: { ...s.context, [sessionId]: report } }))
}

/**
 * Reads what fills the session's context unless it was read for the same context already. Each
 * read forks the session in the agent, so a breakdown holds until the context changes. A read
 * that fails drops the older breakdown, which described another context.
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
        breakdown: null,
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
  const { filters: before, generations } = useUsageStore.getState()
  const filters = { ...before, ...patch }
  // The agent filter is applied to the figures already read.
  const read = filters.range !== before.range || filters.scope !== before.scope
  useUsageStore.setState({
    filters,
    generations: {
      agent: generations.agent + (filters.agent !== before.agent ? 1 : 0),
      figures: generations.figures + (read ? 1 : 0),
    },
  })
  if (read) void loadUsagePage()
}

/** Reads the page's figures for its filters; a slower answer to an older request is dropped. */
export async function loadUsagePage(): Promise<void> {
  const id = ++request
  const { filters, generations, page } = useUsageStore.getState()
  const today = dayOf(Date.now())
  const firstDay = firstDayOfWeek(currentLocale())
  useUsageStore.setState({ loading: true })
  try {
    let first = page?.summary.first ?? null
    for (let pass = 0; pass < 2; pass++) {
      const range = rangeOf(filters.range, today, first)
      const heat = heatmapRange(today, firstDay)
      // The heatmap always shows the last 53 weeks, whatever the range.
      const starts = dayStarts({
        from: Math.min(range.from, heat.from),
        to: Math.max(range.to, heat.to),
      })
      const hourly = oneDay(range) ? hourStarts(range) : null
      const read = (boundaries: number[]) =>
        host('usage.summary', {
          dayStarts: boundaries,
          from: range.from,
          to: range.to,
          scope: filters.scope,
        })
      // All time starts at the first day with usage of this scope, known only from the answer, so
      // its hours are read after it; any other range's along with it.
      const settled = filters.range.kind !== 'all'
      const [summary, early] = await Promise.all([
        read(starts),
        settled && hourly ? read(hourly) : null,
      ])
      if (id !== request) return
      if (pass === 0 && rangeOf(filters.range, today, summary.first).from !== range.from) {
        first = summary.first
        continue
      }
      const hours = hourly && (early ?? (await read(hourly)))
      if (id !== request) return
      useUsageStore.setState({
        page: {
          filters: { range: filters.range, scope: filters.scope },
          generation: generations.figures,
          today,
          firstDay,
          starts,
          range,
          summary,
          hours: hourly && hours ? { starts: hourly, summary: hours } : null,
        },
        loading: false,
        error: null,
      })
      return
    }
  } catch (error) {
    if (id === request) useUsageStore.setState({ loading: false, error: errorMessage(error) })
  }
}

/** The day turned while the page shows: the heatmap ends today, so the figures are read again. */
export function usageDayTurned(day: number): void {
  const { page } = useUsageStore.getState()
  if (pageOpen && page && page.today !== day) readPage()
}

export async function loadUsageStatus(): Promise<void> {
  try {
    useUsageStore.setState({ status: await host('usage.status', undefined) })
  } catch {
    // The host is not connected; its status arrives with the next event.
  }
}

/** Today's tokens and estimated cost across the agents, as the sidebar shows them. */
export async function loadToday(): Promise<void> {
  const today = dayOf(Date.now())
  try {
    const total = await host('usage.total', { from: today, to: addDays(today, 1) })
    useUsageStore.setState({ today: total.total, todayCost: total.cost })
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
