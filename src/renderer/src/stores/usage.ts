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
import { limitWays, type LimitWay } from '@renderer/lib/plan-readings'
import { agentsOn, listedAgents, useAgentsStore } from './agents'
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
  /** Each host's agents with usage in the range, by host id, '' for this computer. */
  used: Record<string, AgentId[]>
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

/** What reads every plan limit this window knows of, by card key, each account once. */
export function planLimitWays(): Map<string, LimitWay[]> {
  const state = useAgentsStore.getState()
  const hosts = [null, ...otherHosts(useHostsStore.getState()).map((h) => h.id)]
  return limitWays(
    hosts.map((hostId) => ({ hostId, agents: listedAgents(agentsOn(state, hostId)) })),
    reachable,
  )
}

/** Reads a card's limits through the first of `ways` that answers; rejects as the last one did. */
export async function readLimitsThrough(ways: readonly LimitWay[]): Promise<void> {
  let error: unknown = new Error('No host to read the plan limits through')
  for (const way of ways) {
    try {
      await refreshLimits(way.agentId, way.hostId)
      return
    } catch (failed) {
      error = failed
    }
  }
  throw error
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
export function reachable(hostId: string | null): boolean {
  if (hostId === null) return true
  const other = otherHosts(useHostsStore.getState()).find((h) => h.id === hostId)
  return other?.connection.state === 'online'
}

/** The last page read for each choice of hosts, shown while a chosen host is away. */
const keptPages = new Map<string, UsagePage>()

/** Each host's answers behind the page, so a change on one host reads only that host again. */
interface PageParts {
  /** The read they came from, as `request` numbers it. */
  request: number
  page: UsagePage
  /** By host; a host that did not answer is absent. */
  summaries: Map<string | null, UsageSummary>
  /** A one-day range's sums per hour, by host. */
  hours: Map<string | null, UsageSummary>
}

let pageOpen = false
let request = 0
let parts: PageParts | null = null
let reading: Promise<void> | null = null
let readAgain = false
/** Hosts whose usage changed while the whole page was read, read again once it is. */
const changedMeanwhile = new Set<string | null>()

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
        new Map(
          await readEach(
            targets,
            async (hostId) =>
              [
                hostId,
                await hostAt(
                  hostId,
                  'usage.summary',
                  summaryParams(range, filters.scope, boundaries, byHour ? clock : null),
                ),
              ] as const,
          ),
        )
      // All time starts at the first day with usage of this scope, known only from the answer, so
      // its hours are read after it; any other range's along with it.
      const settled = filters.range.kind !== 'all'
      const [summaries, early] = await Promise.all([
        read(starts, true),
        settled && hourly ? read(hourly) : null,
      ])
      if (id !== request) return
      const summary = mergeSummaries([...summaries.values()])
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
        used: usedBy(summaries),
        hours:
          hourly && hours ? { starts: hourly, summary: mergeSummaries([...hours.values()]) } : null,
        clock,
      }
      parts = { request: id, page: next, summaries, hours: hours ?? new Map() }
      keptPages.set(key, next)
      useUsageStore.setState({ page: next, loading: false, error: null })
      return
    }
  } catch (error) {
    if (id === request) useUsageStore.setState({ loading: false, error: errorMessage(error) })
  }
}

/** Each answering host's agents with usage in the range, as `UsagePage.used` holds them. */
function usedBy(summaries: ReadonlyMap<string | null, UsageSummary>): Record<string, AgentId[]> {
  return Object.fromEntries(
    [...summaries].map(([hostId, summary]) => [hostId ?? '', summary.agents]),
  )
}

/** What the page asks a host: its range by day, with the hours of the day over `clock`. */
function summaryParams(
  range: DayRange,
  scope: UsageScope,
  dayStarts: number[],
  clock: DayRange | null,
) {
  return {
    dayStarts,
    from: range.from,
    to: range.to,
    scope,
    ...(clock && { clock: { ...clock, zones: clockZones(clock.from, clock.to) } }),
  }
}

/**
 * Reads one host's part of the page again and adds it to the others' as last read. The whole page
 * is read instead when its parts are not the page shown, or when the change moves where All time
 * starts.
 */
async function readHostPart(hostId: string | null): Promise<void> {
  const base = parts
  const { page } = useUsageStore.getState()
  if (!pageOpen || !reachable(hostId)) return
  if (!base || !page || base.request !== request || base.page !== page) return readPage()
  if (page.today !== dayOf(Date.now())) return readPage()
  const ask = (dayStarts: number[], clock: DayRange | null) =>
    hostAt(hostId, 'usage.summary', summaryParams(page.range, page.filters.scope, dayStarts, clock))
  let summary: UsageSummary | null = null
  let hours: UsageSummary | null = null
  let failed: unknown = null
  try {
    ;[summary, hours] = await Promise.all([
      ask(page.starts, page.clock),
      page.hours ? ask(page.hours.starts, null) : null,
    ])
  } catch (error) {
    failed = error
  }
  if (parts !== base || base.request !== request || useUsageStore.getState().page !== base.page) {
    return
  }
  // As in a whole read, a host that does not answer is left out, and fails the page only when no
  // other host answered.
  const summaries = new Map(base.summaries)
  const byHour = new Map(base.hours)
  if (summary) summaries.set(hostId, summary)
  else summaries.delete(hostId)
  if (hours) byHour.set(hostId, hours)
  else byHour.delete(hostId)
  if (summaries.size === 0) {
    useUsageStore.setState({ error: errorMessage(failed) })
    return
  }
  const merged = mergeSummaries([...summaries.values()])
  const shown = base.page
  const moved = rangeOf(shown.filters.range, shown.today, merged.first).from !== shown.range.from
  if (moved || (shown.hours && byHour.size === 0)) return readPage()
  base.summaries = summaries
  base.hours = byHour
  const next: UsagePage = {
    ...shown,
    summary: merged,
    used: usedBy(summaries),
    hours: shown.hours && {
      starts: shown.hours.starts,
      summary: mergeSummaries([...byHour.values()]),
    },
  }
  base.page = next
  keptPages.set(next.key, next)
  useUsageStore.setState({ page: next, error: null })
}

/** Runs a host's read one at a time; asked again while it runs, it runs once more after. */
function oneAtATime(
  reads: Map<string | null, { again: boolean }>,
  hostId: string | null,
  run: () => Promise<void>,
): void {
  const under = reads.get(hostId)
  if (under) {
    under.again = true
    return
  }
  const entry = { again: false }
  reads.set(hostId, entry)
  const go = (): void => {
    void run().finally(() => {
      if (!entry.again) return void reads.delete(hostId)
      entry.again = false
      go()
    })
  }
  go()
}

const partReads = new Map<string | null, { again: boolean }>()
const todayReads = new Map<string | null, { again: boolean }>()

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
  const reached = hosts.filter(reachable)
  await Promise.all(reached.map((hostId) => readToday(hostId, today)))
  if (id === todayRequest) showToday(hosts, reached, today)
}

/** Reads a host's figure for today; on failure what was last read today stands in. */
async function readToday(hostId: string | null, today: number): Promise<void> {
  try {
    const total = await hostAt(hostId, 'usage.total', { from: today, to: addDays(today, 1) })
    keptToday.set(hostId ?? '', { day: today, total })
  } catch {
    // What was last read today stands in until the host answers.
  }
}

function showToday(
  hosts: readonly (string | null)[],
  reached: readonly (string | null)[],
  today: number,
): void {
  const read = hosts.flatMap((hostId) => {
    const kept = keptToday.get(hostId ?? '')
    const counts = reached.includes(hostId) || hosts.length === 1
    return counts && kept?.day === today ? [kept.total] : []
  })
  useUsageStore.setState({
    today: read.length > 0 ? read.reduce((sum, total) => sum + total.total, 0) : null,
    todayCost: read.length > 0 ? read.map((total) => total.cost).reduce(addCost) : null,
  })
}

/**
 * A host's usage changed, null being this computer: if the window shows it, that host alone is
 * read again, one read at a time, and added to the others as last read.
 */
export function usageChanged(hostId: string | null = null): void {
  if (!usageHosts().includes(hostId)) return
  oneAtATime(todayReads, hostId, async () => {
    const today = dayOf(Date.now())
    if (!reachable(hostId)) return
    await readToday(hostId, today)
    const hosts = usageHosts()
    showToday(hosts, hosts.filter(reachable), today)
  })
  if (!pageOpen) return
  if (reading) changedMeanwhile.add(hostId)
  else oneAtATime(partReads, hostId, () => readHostPart(hostId))
}

/** Reads the page, or once more after the read under way, so a scan's notices never pile up. */
function readPage(): void {
  if (reading) {
    readAgain = true
    return
  }
  reading = loadUsagePage().finally(() => {
    reading = null
    const changed = [...changedMeanwhile]
    changedMeanwhile.clear()
    if (!pageOpen) return
    if (readAgain) {
      readAgain = false
      readPage()
    } else {
      for (const hostId of changed) oneAtATime(partReads, hostId, () => readHostPart(hostId))
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
