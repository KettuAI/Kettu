// The usage page's arithmetic: local days, the chosen range, and the figures, trend, heatmap and
// breakdowns summed from the host's per-day rows. Pure, so it is tested without a window.

import type { AgentId } from '@shared/thread'
import {
  partsTotal,
  type ClockZone,
  type HourUsage,
  type TokenParts,
  type UsageScope,
  type UsageSummary,
} from '@shared/usage'

export type RangeKind = '1' | '7' | '30' | '90' | '365' | 'all'
/** A custom range holds local day starts, both ends included. */
export type RangeChoice = { kind: RangeKind } | { kind: 'custom'; from: number; to: number }
export type AgentFilter = AgentId | 'all'

/** What the figures, the trend and the breakdowns count. */
export type Metric = 'tokens' | 'requests' | 'cost'
/** What the metric counts under the chosen scope: Kettu's turns stand in for requests there. */
export type MetricKind = 'tokens' | 'requests' | 'turns' | 'cost'

export function metricKind(metric: Metric, scope: UsageScope): MetricKind {
  return metric === 'requests' && scope === 'kettu' ? 'turns' : metric
}

/** A sum in the metric; cost is null when nothing in it had a price. */
export function metricValue(parts: TokenParts, metric: Metric, scope: UsageScope): number | null {
  switch (metricKind(metric, scope)) {
    case 'cost':
      return parts.cost
    case 'requests':
      return parts.requests
    case 'turns':
      return parts.turns
    case 'tokens':
      return partsTotal(parts)
  }
}

/** Local days as [from, to): day starts, `to` the day after the last. */
export interface DayRange {
  from: number
  to: number
}

export const RANGE_KINDS: readonly RangeKind[] = ['1', '7', '30', '90', '365', 'all']
export const HEATMAP_WEEKS = 53
/** Up to this many days the trend has a bar per day, beyond it one per week. */
export const DAILY_BARS = 92
/** Up to this many days, two years, the trend has a bar per week, beyond it one per month. */
export const WEEKLY_DAYS = 731
/** The breakdown shows this many rows before the rest fold into one. */
export const BREAKDOWN_ROWS = 5

const HOUR_MS = 3_600_000
const QUARTER_MS = 900_000

const ZERO: TokenParts = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
  turns: 0,
  cost: null,
  unpricedTokens: 0,
  cacheSaved: 0,
}

/** The start of the local day `at` falls in. */
export function dayOf(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** `n` local days after `day`, through daylight saving changes. */
export function addDays(day: number, n: number): number {
  const date = new Date(day)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n).getTime()
}

/** The locale's first day of the week, 0 for Sunday as in `Date.getDay`. */
export function firstDayOfWeek(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay
    if (typeof firstDay === 'number') return firstDay % 7
  } catch {
    // An engine without week info; Monday, the ISO week.
  }
  return 1
}

export function weekStartOf(day: number, firstDay: number): number {
  return addDays(day, -((new Date(day).getDay() - firstDay + 7) % 7))
}

export function monthStartOf(day: number): number {
  const date = new Date(day)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

export function rangeOf(choice: RangeChoice, today: number, first: number | null): DayRange {
  const to = addDays(today, 1)
  switch (choice.kind) {
    case 'custom':
      return { from: choice.from, to: addDays(choice.to, 1) }
    case 'all':
      return { from: first === null ? today : Math.min(dayOf(first), today), to }
    default:
      return { from: addDays(today, 1 - Number(choice.kind)), to }
  }
}

/** The heatmap's days: 53 week columns, the last one this week's. */
export function heatmapRange(today: number, firstDay: number): DayRange {
  return {
    from: addDays(weekStartOf(today, firstDay), -(HEATMAP_WEEKS - 1) * 7),
    to: addDays(today, 1),
  }
}

/** The day starts of [from, to), and `to` itself: n days take n + 1 values. */
export function dayStarts(range: DayRange): number[] {
  const starts: number[] = []
  for (let day = range.from; day < range.to; day = addDays(day, 1)) starts.push(day)
  starts.push(range.to)
  return starts
}

/** Whether the range is one local day, which the trend shows by the hour. */
export function oneDay(range: DayRange): boolean {
  return addDays(range.from, 1) === range.to
}

/**
 * The local hour starts of [from, to), and `to` itself, always ascending. An hour the clocks skip
 * is left out and one they repeat is counted twice, so such a day has 23 or 25; after a change of
 * half an hour, the hours start on the local hour again.
 */
export function hourStarts(range: DayRange): number[] {
  const date = new Date(range.from)
  const starts = [range.from]
  let last = range.from
  for (let hour = 1; last < range.to; hour++) {
    const local = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour).getTime()
    const next = Math.min(local, range.to)
    // An hour the clocks repeat leaves a gap of more than one, filled with real hours.
    for (; next - last > HOUR_MS; last += HOUR_MS) starts.push(last + HOUR_MS)
    // One they skip lands on the next hour.
    if (next > last) {
      starts.push(next)
      last = next
    }
  }
  return starts
}

/** Whether the clocks change during the hours, which then name their time zones. */
export function clocksChange(starts: readonly number[]): boolean {
  const offset = (at: number) => new Date(at).getTimezoneOffset()
  return offset(starts[0]!) !== offset(starts[starts.length - 1]!)
}

/** The hours of a one-day range begun by `now`, as the range its figures cover. */
export function hoursSoFar(starts: readonly number[], now: number): DayRange {
  const end = starts.find((start, i) => i > 0 && start > now) ?? starts[starts.length - 1]!
  return { from: starts[0]!, to: end }
}

export interface DayTotal {
  /** The day's start, or the hour's when summed over `hourStarts`. */
  day: number
  /** The day's tokens. */
  total: number
  parts: TokenParts
  /** Each agent's tokens. */
  byAgent: Partial<Record<AgentId, number>>
  /** Each agent's own parts, for a metric other than tokens. */
  agentParts: Partial<Record<AgentId, TokenParts>>
}

/** Each requested day's totals for the agents the filter keeps; days with nothing are zero. */
export function dayTotals(
  summary: Pick<UsageSummary, 'days'>,
  starts: readonly number[],
  agent: AgentFilter,
): DayTotal[] {
  const days: DayTotal[] = starts
    .slice(0, -1)
    .map((day) => ({ day, total: 0, parts: { ...ZERO }, byAgent: {}, agentParts: {} }))
  for (const row of summary.days) {
    if (agent !== 'all' && row.agentId !== agent) continue
    const day = days[row.day]
    if (!day) continue
    const total = partsTotal(row)
    day.total += total
    day.byAgent[row.agentId] = (day.byAgent[row.agentId] ?? 0) + total
    let agentParts = day.agentParts[row.agentId]
    if (!agentParts) day.agentParts[row.agentId] = agentParts = { ...ZERO }
    addInto(agentParts, row)
    addInto(day.parts, row)
  }
  return days
}

function addInto(sum: TokenParts, add: TokenParts): void {
  sum.input += add.input
  sum.output += add.output
  sum.reasoning += add.reasoning
  sum.cacheRead += add.cacheRead
  sum.cacheWrite += add.cacheWrite
  sum.requests += add.requests
  sum.turns += add.turns
  sum.unpricedTokens += add.unpricedTokens
  sum.cacheSaved += add.cacheSaved
  if (add.cost !== null) sum.cost = (sum.cost ?? 0) + add.cost
}

export interface Figures {
  /** The range's total in the metric. */
  total: number
  /** The range's tokens, whatever the metric. */
  tokens: number
  parts: TokenParts
  days: number
  activeDays: number
  /** Over the active days; null with none. */
  average: number | null
  /** The day with the most of the metric, the first of equals; null when none has any. */
  peak: { day: number; total: number } | null
  /** Cache reads over the whole input side; null with no input. */
  cacheShare: number | null
  /** Some row in the range had a price, so a cost is known. */
  priced: boolean
}

export function figures(
  days: readonly DayTotal[],
  range: DayRange,
  metric: Metric = 'tokens',
  scope: UsageScope = 'computer',
): Figures {
  const parts = { ...ZERO }
  let total = 0
  let tokens = 0
  let activeDays = 0
  let peak: Figures['peak'] = null
  let count = 0
  let priced = false
  for (const day of days) {
    if (day.day < range.from || day.day >= range.to) continue
    count++
    if (day.total <= 0) continue
    activeDays++
    tokens += day.total
    addInto(parts, day.parts)
    if (day.parts.cost !== null) priced = true
    const value = metricValue(day.parts, metric, scope) ?? 0
    total += value
    if (value > 0 && (!peak || value > peak.total)) peak = { day: day.day, total: value }
  }
  const inputSide = parts.input + parts.cacheRead + parts.cacheWrite
  return {
    total,
    tokens,
    parts,
    days: count,
    activeDays,
    average: activeDays > 0 ? total / activeDays : null,
    peak,
    cacheShare: inputSide > 0 ? parts.cacheRead / inputSide : null,
    priced,
  }
}

/** The token types, in the order the composition lists them. */
const TOKEN_PARTS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'] as const
export type TokenPart = (typeof TOKEN_PARTS)[number]

/**
 * What the tokens are made of: each type's tokens and share of `total`, the share null without
 * tokens. Reasoning shows only where an agent reports it apart from the output.
 */
export function tokenParts(
  parts: Pick<TokenParts, TokenPart>,
  total: number,
): { part: TokenPart; tokens: number; share: number | null }[] {
  return TOKEN_PARTS.filter((part) => part !== 'reasoning' || parts.reasoning > 0).map((part) => ({
    part,
    tokens: parts[part],
    share: total > 0 ? parts[part] / total : null,
  }))
}

export interface FromCache {
  /** Tokens read from the prompt cache. */
  read: number
  /** Every other token. */
  other: number
  /** The cache reads' share of all tokens; null without tokens. */
  share: number | null
  /** How many of every 100 tokens came from the cache; null without tokens. */
  perHundred: number | null
}

/** How much of the tokens the prompt cache served. */
export function fromCache(parts: Pick<TokenParts, TokenPart>): FromCache {
  const total = TOKEN_PARTS.reduce((sum, part) => sum + parts[part], 0)
  if (total <= 0) return { read: 0, other: 0, share: null, perHundred: null }
  const share = parts.cacheRead / total
  // Never 0 while some tokens came from the cache, nor 100 while some did not.
  const perHundred = Math.min(
    parts.cacheRead < total ? 99 : 100,
    Math.max(parts.cacheRead > 0 ? 1 : 0, Math.round(share * 100)),
  )
  return { read: parts.cacheRead, other: total - parts.cacheRead, share, perHundred }
}

export interface Streaks {
  /** Days with usage in a row up to the range's last day, or the day before while today has none. */
  current: number
  /** The longest run of days with usage in the range, the first of equals; null with none. */
  longest: { days: number; from: number; to: number } | null
}

/** Runs of days with usage in the range; `days` are consecutive, as `dayTotals` gives them. */
export function streaks(days: readonly DayTotal[], range: DayRange, today: number): Streaks {
  const inRange = days.filter((d) => d.day >= range.from && d.day < range.to)
  let longest: Streaks['longest'] = null
  let run = 0
  let start = 0
  for (const day of inRange) {
    if (day.total <= 0) {
      run = 0
      continue
    }
    if (run === 0) start = day.day
    run++
    if (!longest || run > longest.days) longest = { days: run, from: start, to: day.day }
  }
  let last = inRange.length - 1
  // Today may still bring usage, so a streak through yesterday holds until it ends.
  if (last >= 0 && inRange[last]!.day === today && inRange[last]!.total <= 0) last--
  let current = 0
  while (last >= 0 && inRange[last]!.total > 0) {
    current++
    last--
  }
  return { current, longest }
}

/**
 * The weekday with the most of the metric in the range, as `Date.getDay` gives it, and its share;
 * among equals the first from `firstDay`. Null when no day has any.
 */
export function busiestWeekday(
  days: readonly DayTotal[],
  range: DayRange,
  firstDay: number,
  metric: Metric = 'tokens',
  scope: UsageScope = 'computer',
): { weekday: number; share: number } | null {
  const sums = [0, 0, 0, 0, 0, 0, 0]
  let total = 0
  for (const day of days) {
    if (day.day < range.from || day.day >= range.to) continue
    const value = metricValue(day.parts, metric, scope) ?? 0
    sums[new Date(day.day).getDay()]! += value
    total += value
  }
  if (total <= 0) return null
  let best = firstDay % 7
  for (let i = 1; i < 7; i++) {
    const weekday = (firstDay + i) % 7
    if (sums[weekday]! > sums[best]!) best = weekday
  }
  return { weekday: best, share: sums[best]! / total }
}

/** The range's tokens per request; null without requests. */
export function tokensPerRequest(facts: Pick<Figures, 'tokens' | 'total'>): number | null {
  return facts.total > 0 ? facts.tokens / facts.total : null
}

/** The tokens no cost counts, when there are any: the note under the Cost figures. */
export function unpricedTokens(facts: Pick<Figures, 'parts'>): number | null {
  return facts.parts.unpricedTokens > 0 ? facts.parts.unpricedTokens : null
}

export interface TrendBar {
  /** The bar's first day and the day after its last. */
  from: number
  to: number
  total: number
  byAgent: Partial<Record<AgentId, number>>
}

export type TrendUnit = 'hour' | 'day' | 'week' | 'month'

/**
 * A bar per day for a range up to `DAILY_BARS` days, per week up to `WEEKLY_DAYS`, else per
 * month, clipped to the range, in the chosen metric.
 */
export function trend(
  days: readonly DayTotal[],
  range: DayRange,
  firstDay: number,
  metric: Metric = 'tokens',
  scope: UsageScope = 'computer',
): { unit: Exclude<TrendUnit, 'hour'>; bars: TrendBar[] } {
  const inRange = days.filter((d) => d.day >= range.from && d.day < range.to)
  const unit = inRange.length > WEEKLY_DAYS ? 'month' : inRange.length > DAILY_BARS ? 'week' : 'day'
  const bars: TrendBar[] = []
  for (const day of inRange) {
    const start =
      unit === 'day'
        ? day.day
        : Math.max(
            unit === 'week' ? weekStartOf(day.day, firstDay) : monthStartOf(day.day),
            range.from,
          )
    let bar = bars[bars.length - 1]
    if (!bar || bar.from !== start) {
      bar = { from: start, to: start, total: 0, byAgent: {} }
      bars.push(bar)
    }
    bar.to = addDays(day.day, 1)
    bar.total += metricValue(day.parts, metric, scope) ?? 0
    for (const [agentId, parts] of Object.entries(day.agentParts) as [AgentId, TokenParts][]) {
      bar.byAgent[agentId] = (bar.byAgent[agentId] ?? 0) + (metricValue(parts, metric, scope) ?? 0)
    }
  }
  return { unit, bars }
}

/** A bar per hour, from the totals `dayTotals` sums over `hourStarts`. */
export function hourBars(
  hours: readonly DayTotal[],
  starts: readonly number[],
  metric: Metric = 'tokens',
  scope: UsageScope = 'computer',
): TrendBar[] {
  return hours.map((hour, i) => {
    const byAgent: Partial<Record<AgentId, number>> = {}
    for (const [agentId, parts] of Object.entries(hour.agentParts) as [AgentId, TokenParts][]) {
      byAgent[agentId] = metricValue(parts, metric, scope) ?? 0
    }
    return {
      from: hour.day,
      to: starts[i + 1]!,
      total: metricValue(hour.parts, metric, scope) ?? 0,
      byAgent,
    }
  })
}

/** The agents with usage in the bars, in the given order: the trend's series, bottom first. */
export function seriesOf(bars: readonly TrendBar[], order: readonly AgentId[]): AgentId[] {
  return order.filter((id) => bars.some((bar) => (bar.byAgent[id] ?? 0) > 0))
}

/** The series the legend leaves shown; all of them when it would leave none. */
export function shownSeries(series: readonly AgentId[], hidden: readonly AgentId[]): AgentId[] {
  const shown = series.filter((id) => !hidden.includes(id))
  return shown.length > 0 ? shown : [...series]
}

/**
 * What the legend hides once `chosen` are the series pressed: the others, unless that is all of
 * them, since the last one shown stays.
 */
export function legendHidden(
  series: readonly AgentId[],
  chosen: readonly AgentId[],
  hidden: readonly AgentId[],
): readonly AgentId[] {
  const next = series.filter((id) => !chosen.includes(id))
  return next.length < series.length ? next : hidden
}

/**
 * How many times the usage filters have changed, which tells them apart even after a return to
 * earlier values: the agent filter, applied to the figures already read, and the range or source,
 * which take figures of their own.
 */
export interface Generations {
  agent: number
  figures: number
}

/**
 * Whether the label of the bar starting at `froms[index]` names the year: across a new year, the
 * first label and the first of each year do; otherwise none does.
 */
export function namesYear(
  froms: readonly number[],
  index: number,
  previous: number | null,
): boolean {
  const year = (at: number) => new Date(at).getFullYear()
  if (froms.length === 0 || year(froms[0]!) === year(froms[froms.length - 1]!)) return false
  return previous === null || year(froms[previous]!) !== year(froms[index]!)
}

/** Whether a month's bar holds the whole month, so it reads as the month's name, not dates. */
export function wholeMonth(bar: { from: number; to: number }): boolean {
  return bar.from === monthStartOf(bar.from) && bar.to === monthStartOf(bar.to)
}

/**
 * A day's shade, 0 for none and 1 to 4 for its quartile among the days with usage, so a few
 * peak days do not wash out the rest.
 */
export function heatLevels(totals: readonly number[]): number[] {
  const used = totals.filter((t) => t > 0).sort((a, b) => a - b)
  if (used.length === 0) return totals.map(() => 0)
  const at = (p: number) => used[Math.min(used.length - 1, Math.floor(used.length * p))]!
  const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)]
  return totals.map((t) => (t <= 0 ? 0 : t <= q1 ? 1 : t <= q2 ? 2 : t <= q3 ? 3 : 4))
}

export interface BreakdownRow {
  key: string
  /** The model, or the project folder; null for an unknown model, a scratch or unknown project. */
  name: string | null
  /** The folder, for a project's tooltip. */
  path: string | null
  /** The agents with usage in the row, the most tokens first. */
  agents: AgentId[]
  /** The row's tokens, which rank rows a metric cannot price. */
  total: number
  /** The row's value in the metric; null for a row no price covers. */
  value: number | null
}

interface RowSum extends Omit<BreakdownRow, 'agents'> {
  byAgent: Map<AgentId, number>
}

/** The rows with usage, the most of the metric first, then the most tokens. */
function ranked(rows: Map<string, RowSum>): BreakdownRow[] {
  return [...rows.values()]
    .filter((row) => row.total > 0)
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.total - a.total)
    .map(({ byAgent, ...row }) => ({
      ...row,
      agents: [...byAgent.keys()].sort((a, b) => byAgent.get(b)! - byAgent.get(a)!),
    }))
}

function addRow(
  rows: Map<string, RowSum>,
  key: string,
  name: string | null,
  path: string | null,
  row: TokenParts & { agentId: AgentId },
  metric: Metric,
  scope: UsageScope,
): void {
  const sum = rows.get(key) ?? {
    key,
    name,
    path,
    byAgent: new Map(),
    total: 0,
    value: metricKind(metric, scope) === 'cost' ? null : 0,
  }
  const tokens = partsTotal(row)
  sum.total += tokens
  if (tokens > 0) sum.byAgent.set(row.agentId, (sum.byAgent.get(row.agentId) ?? 0) + tokens)
  if (metricKind(metric, scope) === 'cost') {
    if (row.cost !== null) sum.value = (sum.value ?? 0) + row.cost
  } else {
    sum.value = (sum.value ?? 0) + (metricValue(row, metric, scope) ?? 0)
  }
  rows.set(key, sum)
}

export function modelRows(
  summary: Pick<UsageSummary, 'models'>,
  agent: AgentFilter,
  metric: Metric = 'tokens',
  scope: UsageScope = 'computer',
): BreakdownRow[] {
  const rows = new Map<string, RowSum>()
  for (const row of summary.models) {
    if (agent !== 'all' && row.agentId !== agent) continue
    addRow(rows, row.model, row.model || null, null, row, metric, scope)
  }
  return ranked(rows)
}

/** A row per agent, keyed by its id, from the models' usage. */
export function agentRows(
  summary: Pick<UsageSummary, 'models'>,
  agent: AgentFilter,
  metric: Metric = 'tokens',
  scope: UsageScope = 'computer',
): BreakdownRow[] {
  const rows = new Map<string, RowSum>()
  for (const row of summary.models) {
    if (agent !== 'all' && row.agentId !== agent) continue
    addRow(rows, row.agentId, null, null, row, metric, scope)
  }
  return ranked(rows)
}

/** What the rows past the first few add up to, folded into one. */
export interface RestRow {
  count: number
  total: number
  /** Null when no price covers any of them. */
  value: number | null
}

/**
 * The first `shown` rows, and the rest folded into one row while it holds more than one: a single
 * row left over shows as itself.
 */
export function foldRows(
  rows: readonly BreakdownRow[],
  shown = BREAKDOWN_ROWS,
): { rows: BreakdownRow[]; rest: RestRow | null } {
  if (rows.length <= shown + 1) return { rows: [...rows], rest: null }
  const others = rows.slice(shown)
  const priced = others.filter((row) => row.value !== null)
  return {
    rows: rows.slice(0, shown),
    rest: {
      count: others.length,
      total: others.reduce((sum, row) => sum + row.total, 0),
      value: priced.length > 0 ? priced.reduce((sum, row) => sum + row.value!, 0) : null,
    },
  }
}

/** Projects by folder; No project folders and unknown ones are one row with no name. */
export function projectRows(
  summary: Pick<UsageSummary, 'projects'>,
  agent: AgentFilter,
  basename: (path: string) => string,
  metric: Metric = 'tokens',
  scope: UsageScope = 'computer',
): BreakdownRow[] {
  const rows = new Map<string, RowSum>()
  for (const row of summary.projects) {
    if (agent !== 'all' && row.agentId !== agent) continue
    const named = row.project !== null && !row.scratch
    const key = named ? row.project! : ''
    addRow(
      rows,
      key,
      named ? basename(row.project!) : null,
      named ? row.project : null,
      row,
      metric,
      scope,
    )
  }
  return ranked(rows)
}

export interface Preset {
  id: 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'thisYear'
  /** Local day starts, both ends included. */
  from: number
  to: number
}

/** The picker's presets for `today`: periods that start where the calendar's do. */
export function presets(today: number, firstDay: number): Preset[] {
  const date = new Date(today)
  const week = weekStartOf(today, firstDay)
  const month = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
  const lastMonth = new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime()
  const year = new Date(date.getFullYear(), 0, 1).getTime()
  return [
    { id: 'yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    { id: 'thisWeek', from: week, to: today },
    { id: 'lastWeek', from: addDays(week, -7), to: addDays(week, -1) },
    { id: 'thisMonth', from: month, to: today },
    { id: 'lastMonth', from: lastMonth, to: addDays(month, -1) },
    { id: 'thisYear', from: year, to: today },
  ]
}

/** The agents whose plan limits are worth asking for when the page opens. */
export function limitsToRead<
  T extends {
    state: string
    limits: readonly unknown[]
    providers?: unknown
  },
>(agents: readonly T[]): T[] {
  return agents.filter(
    (agent) =>
      agent.providers !== undefined || (agent.state === 'ready' && agent.limits.length > 0),
  )
}

/** The series colors, in the order the agents are listed. */
const SERIES = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
] as const

/**
 * An agent's series color, by its place in `order`, so a color follows the agent whatever a
 * filter leaves; one no longer in `order` takes the place after those that are.
 */
export function agentColor(agentId: AgentId, order: readonly AgentId[]): string {
  const index = order.indexOf(agentId)
  return SERIES[(index < 0 ? order.length : index) % SERIES.length]!
}

/**
 * The time zones over [from, to) by this computer's clocks, each from the quarter hour its offset
 * starts, for the host to sum the hours of the day by. A change is looked for a day at a time and
 * found to the quarter hour.
 */
export function clockZones(from: number, to: number): ClockZone[] {
  const offset = (at: number) => -new Date(at).getTimezoneOffset()
  const zones: ClockZone[] = [
    { from: Math.floor(from / QUARTER_MS) * QUARTER_MS, offset: offset(from) },
  ]
  let at = from
  while (at < to) {
    const next = Math.min(at + 86_400_000, to)
    const current = zones[zones.length - 1]!.offset
    if (offset(next) !== current) {
      let low = Math.floor(at / QUARTER_MS)
      let high = Math.ceil(next / QUARTER_MS)
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2)
        if (offset(middle * QUARTER_MS) === current) low = middle
        else high = middle
      }
      zones.push({ from: high * QUARTER_MS, offset: offset(high * QUARTER_MS) })
    }
    at = next
  }
  return zones
}

/** The range's amounts in the metric for each local hour of the day, 0 to 23. */
export function hourValues(
  clock: readonly HourUsage[],
  agent: AgentFilter,
  metric: Metric = 'tokens',
  scope: UsageScope = 'computer',
): number[] {
  const values = Array.from({ length: 24 }, () => 0)
  for (const row of clock) {
    if (agent !== 'all' && row.agentId !== agent) continue
    values[row.hour] = values[row.hour]! + (metricValue(row, metric, scope) ?? 0)
  }
  return values
}

/**
 * The `length` hours in a row, across midnight too, that hold the most, and their share of the
 * day; null when nothing was used. Ties go to the earliest start.
 */
export function busiestHours(
  values: readonly number[],
  length = 9,
): { from: number; share: number } | null {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null
  let best = { from: 0, sum: -1 }
  for (let from = 0; from < values.length; from++) {
    let sum = 0
    for (let k = 0; k < length; k++) sum += values[(from + k) % values.length]!
    if (sum > best.sum) best = { from, sum }
  }
  return { from: best.from, share: best.sum / total }
}
