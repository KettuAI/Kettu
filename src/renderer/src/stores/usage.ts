import { create } from 'zustand'
import { CONTEXT_REFRESH_MS, type ContextReport } from '@shared/context'
export type { ContextReport } from '@shared/context'
import type { AgentId } from '@shared/thread'
import type { UsageScope, UsageStatus, UsageSummary, UsageTotal } from '@shared/usage'
import {
  addDays,
  clockZones,
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
import { addCost, mergeSummaries } from '@renderer/features/usage/merge'
import { errorMessage, host, hostAt } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { otherHosts, shownHosts, useHostsStore } from './hosts'
import { useViewStore } from './view'

/** What the usage page shows; kept while the app runs, back to the defaults on launch. */
export interface UsageFilters {
  /** What the figures count: tokens, requests (turns under Kettu only), or cost. */
  metric: Metric
  agent: AgentFilter
  range: RangeChoice
  scope: UsageScope
}

/** The page's figures, with the days they were read for. */
export interface UsagePage {
  /** The hosts they were read for, as `usageKey` names them. */
  key: string
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
  /** The days the summary's hours of the day cover: the range, or the last 30 days for one day. */
  clock: DayRange
}

/** Days the hours of the day cover when the range is one day, whose trend is by hour already. */
export const CLOCK_DAYS = 30

interface UsageStore {
  /** Each session's last context breakdown. */
  context: Record<string, ContextReport>
  status: UsageStatus | null
  /** Today's tokens on the window's hosts, for the sidebar; null until read. */
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
  range: { kind: '1' },
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

/** Reads a report on demand for hosts without a pushed snapshot, or retries a stale snapshot. */
export function loadContext(sessionId: string, key: string, force = false): void {
  const current = useUsageStore.getState().context[sessionId]
  const fresh = current?.breakdown && Date.now() - current.breakdown.observedAt < CONTEXT_REFRESH_MS
  if (current && (current.loading || (!force && fresh && current.key === key && !current.error)))
    return
  setReport(sessionId, {
    key,
    breakdown: current?.breakdown ?? null,
    loading: true,
    error: null,
  })
  host('sessions.context', { sessionId })
    .then((breakdown) =>
      setReport(sessionId, {
        key: breakdown ? `${breakdown.used}/${breakdown.size}` : key,
        breakdown,
        loading: false,
        error: null,
      }),
    )
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
export function refreshLimits(agentId: AgentId, hostId: string | null = null): Promise<void> {
  return hostAt(hostId, 'agents.refreshLimits', { agentId })
}

/** The hosts the window's usage covers, this computer (null) first: the one chosen, or each. */
export function usageHosts(): (string | null)[] {
  return shownHosts(otherHosts(useHostsStore.getState()), useViewStore.getState().hostFilter)
}

const ALL_HOSTS = '*'

/** One host's id, '' for this computer, or every host. */
function usageKey(hosts: readonly (string | null)[]): string {
  return hosts.length === 1 ? (hosts[0] ?? '') : ALL_HOSTS
}

/** Whether a host answers now: this computer always, another while it is online. */
function reachable(hostId: string | null): boolean {
  if (hostId === null) return true
  const other = otherHosts(useHostsStore.getState()).find((h) => h.id === hostId)
  return other?.connection.state === 'online'
}

/** The last page read for each choice of hosts, shown while a chosen host is away. */
const keptPages = new Map<string, UsagePage>()

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
  for (const hostId of usageHosts().filter(reachable)) {
    void hostAt(hostId, 'usage.sync', undefined).catch(() => {})
  }
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

/**
 * Asks each host and adds up those that answer; only when none does is it a failure, so a host
 * that drops mid-read leaves the rest of All hosts.
 */
async function readEach<T>(
  hosts: readonly (string | null)[],
  read: (hostId: string | null) => Promise<T>,
): Promise<T[]> {
  const settled = await Promise.allSettled(hosts.map(read))
  const answers = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  if (answers.length === 0) {
    throw (settled.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
  }
  return answers
}

/**
 * Reads the page's figures for its filters, from the window's hosts added up; a slower answer to an
 * older request is dropped. A chosen host that is away keeps what was last read from it.
 */
export async function loadUsagePage(): Promise<void> {
  const id = ++request
  const hosts = usageHosts()
  const key = usageKey(hosts)
  const targets = hosts.filter(reachable)
  if (targets.length === 0) {
    useUsageStore.setState({ page: keptPages.get(key) ?? null, loading: false, error: null })
    return
  }
  const { filters, generations, page } = useUsageStore.getState()
  const today = dayOf(Date.now())
  const firstDay = firstDayOfWeek(currentLocale())
  useUsageStore.setState({ loading: true })
  try {
    let first = page?.key === key ? page.summary.first : null
    for (let pass = 0; pass < 2; pass++) {
      const range = rangeOf(filters.range, today, first)
      const heat = heatmapRange(today, firstDay)
      // The heatmap always shows the last 53 weeks, whatever the range.
      const starts = dayStarts({
        from: Math.min(range.from, heat.from),
        to: Math.max(range.to, heat.to),
      })
      const hourly = oneDay(range) ? hourStarts(range) : null
      const clock = hourly ? { from: addDays(range.to, -CLOCK_DAYS), to: range.to } : range
      const read = async (boundaries: number[], byHour = false) =>
        mergeSummaries(
          await readEach(targets, (hostId) =>
            hostAt(hostId, 'usage.summary', {
              dayStarts: boundaries,
              from: range.from,
              to: range.to,
              scope: filters.scope,
              ...(byHour && { clock: { ...clock, zones: clockZones(clock.from, clock.to) } }),
            }),
          ),
        )
      // All time starts at the first day with usage of this scope, known only from the answer, so
      // its hours are read after it; any other range's along with it.
      const settled = filters.range.kind !== 'all'
      const [summary, early] = await Promise.all([
        read(starts, true),
        settled && hourly ? read(hourly) : null,
      ])
      if (id !== request) return
      if (pass === 0 && rangeOf(filters.range, today, summary.first).from !== range.from) {
        first = summary.first
        continue
      }
      const hours = hourly && (early ?? (await read(hourly)))
      if (id !== request) return
      const next: UsagePage = {
        key,
        filters: { range: filters.range, scope: filters.scope },
        generation: generations.figures,
        today,
        firstDay,
        starts,
        range,
        summary,
        hours: hourly && hours ? { starts: hourly, summary: hours } : null,
        clock,
      }
      keptPages.set(key, next)
      useUsageStore.setState({ page: next, loading: false, error: null })
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

/** Each host's figures for the sidebar as last read, by the host's id, '' for this computer. */
const keptToday = new Map<string, { day: number; total: UsageTotal }>()
let todayRequest = 0

/**
 * Today's tokens and estimated cost across the agents of the window's hosts, as the sidebar shows
 * them: every host that answers added up, or the one chosen as it was last read while it is away.
 */
export async function loadToday(): Promise<void> {
  const id = ++todayRequest
  const today = dayOf(Date.now())
  const hosts = usageHosts()
  const totals = await Promise.all(
    hosts.map(async (hostId) => {
      const key = hostId ?? ''
      const reached = reachable(hostId)
      if (reached) {
        try {
          const total = await hostAt(hostId, 'usage.total', { from: today, to: addDays(today, 1) })
          keptToday.set(key, { day: today, total })
          return total
        } catch {
          // What was last read today stands in until the host answers.
        }
      }
      const kept = keptToday.get(key)
      return (reached || hosts.length === 1) && kept?.day === today ? kept.total : null
    }),
  )
  if (id !== todayRequest) return
  const read = totals.filter((total): total is UsageTotal => total !== null)
  useUsageStore.setState({
    today: read.length > 0 ? read.reduce((sum, total) => sum + total.total, 0) : null,
    todayCost: read.length > 0 ? read.map((total) => total.cost).reduce(addCost) : null,
  })
}

/** A host's usage changed, null being this computer: read again if the window shows it. */
export function usageChanged(hostId: string | null = null): void {
  if (!usageHosts().includes(hostId)) return
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

let followedKey: string | null = null
let followedReach = ''

/**
 * Follows the window's host as the account menu chooses it, and which of its hosts answer: the
 * sidebar's figure and the page are read again for them, the page showing what was last read for
 * the new choice meanwhile.
 */
export function followUsageHosts(): void {
  const follow = (): void => {
    const hosts = usageHosts()
    const key = usageKey(hosts)
    const reach = hosts
      .filter(reachable)
      .map((hostId) => hostId ?? '')
      .join('\n')
    if (key === followedKey && reach === followedReach) return
    const first = followedKey === null
    const moved = key !== followedKey
    followedKey = key
    followedReach = reach
    if (first) return
    if (moved) {
      // An answer still coming is for the hosts shown before.
      request++
      useUsageStore.setState({ page: keptPages.get(key) ?? null, loading: false, error: null })
    }
    void loadToday()
    if (pageOpen) readPage()
  }
  useViewStore.subscribe((state, previous) => {
    if (state.hostFilter !== previous.hostFilter) follow()
  })
  useHostsStore.subscribe((state, previous) => {
    if (state.status !== previous.status || state.kept !== previous.kept) follow()
  })
  follow()
}

export function receiveUsageStatus(status: UsageStatus): void {
  useUsageStore.setState({ status })
}

/** Reads a host's logs again, null being this computer. */
export function syncUsage(hostId: string | null = null): Promise<void> {
  return hostAt(hostId, 'usage.sync', undefined)
}

export function reimportUsage(agentId: AgentId): Promise<void> {
  return host('usage.reimport', { agentId })
}

export function clearUsageRecord(): Promise<void> {
  return host('usage.clearRecord', undefined)
}
