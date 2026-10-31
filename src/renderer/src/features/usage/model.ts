// The usage page's arithmetic: local days, the chosen range, and the figures, trend, heatmap and
// breakdowns summed from the host's per-day rows. Pure, so it is tested without a window.

import type { AgentId } from '@shared/thread'
import { partsTotal, type TokenParts, type UsageScope, type UsageSummary } from '@shared/usage'

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
export const BREAKDOWN_ROWS = 6

const HOUR_MS = 3_600_000

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

/** Whole local days from `from` to `to`. */
export function daysBetween(from: number, to: number): number {
  return Math.round((to - from) / 86_400_000)
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

/** What the legend hides, and the generations of the filters the trend was drawn under then. */
export interface LegendChoice extends Generations {
  hidden: readonly AgentId[]
}

export const NO_SERIES: readonly AgentId[] = []

/** What the legend hides in a trend drawn under `drawn`: nothing once any filter has changed. */
export function legendHides(legend: LegendChoice, drawn: Generations): readonly AgentId[] {
  return legend.agent === drawn.agent && legend.figures === drawn.figures
    ? legend.hidden
    : NO_SERIES
}

/** Each bar's tokens from the series shown, which the trend's scale follows. */
export function shownTotals(bars: readonly TrendBar[], series: readonly AgentId[]): number[] {
  return bars.map((bar) => series.reduce((sum, id) => sum + (bar.byAgent[id] ?? 0), 0))
}

/** The bar with the most tokens, the first of equals; null when none has any. */
export function busiest(totals: readonly number[]): number | null {
  let best: number | null = null
  totals.forEach((total, i) => {
    if (total > 0 && (best === null || total > totals[best]!)) best = i
  })
  return best
}

/** The widest of `texts` by `measure`, the first of equals; '' for none. */
export function widest(texts: readonly string[], measure: (text: string) => number): string {
  let best = ''
  let size = -1
  for (const text of texts) {
    const width = measure(text)
    if (width > size) [best, size] = [text, width]
  }
  return best
}

/** The trend's bars are at most this wide, in px; the chart draws them so. */
export const BAR_WIDTH = 48
/** Up to this many bars stand 3 px apart, more of them 1 px, so they stay wider than the gaps. */
const SPACED_BARS = 45

/** The room between two of `count` bars, in px. */
export function barGap(count: number): number {
  return count <= SPACED_BARS ? 3 : 1
}

/** The middle of each bar in a row `width` px wide, where the bars sit centred. */
export function barCenters(count: number, width: number): number[] {
  const gap = barGap(count)
  const bar = Math.max(0, Math.min(BAR_WIDTH, (width - (count - 1) * gap) / count))
  const offset = (width - count * bar - (count - 1) * gap) / 2
  return Array.from({ length: count }, (_, i) => offset + i * (bar + gap) + bar / 2)
}

export interface AxisLabel {
  /** The bar it names. */
  index: number
  text: string
  /** Its left edge, in px from the row's. */
  left: number
}

/**
 * The bars that name their date under the trend: every `step`th one, counted from the first or
 * the last bar, or those `pick` gives for a step, with the smallest step (one of `steps`, when
 * given) whose labels, centred under their bars and kept inside the row, leave `gap` px between
 * them; one label, at the anchor, when none does. `text` gets the bar and the one labelled before
 * it, so a label can add what changed since.
 */
export function axisLabels({
  count,
  width,
  anchor,
  steps,
  pick,
  gap,
  text,
  measure,
}: {
  count: number
  width: number
  anchor: 'start' | 'end'
  steps?: readonly number[]
  pick?: (step: number) => number[]
  gap: number
  text: (index: number, previous: number | null) => string
  measure: (text: string) => number
}): AxisLabel[] {
  if (count <= 0 || width <= 0) return []
  const centers = barCenters(count, width)
  const every = (step: number) => {
    const indices: number[] = []
    for (let i = 0; i < count; i += step) indices.push(anchor === 'start' ? i : count - 1 - i)
    return anchor === 'end' ? indices.reverse() : indices
  }
  const layout = (indices: readonly number[]) => {
    let right = -Infinity
    const labels: AxisLabel[] = []
    for (const [k, index] of indices.entries()) {
      const label = text(index, k > 0 ? indices[k - 1]! : null)
      const size = measure(label)
      const left = Math.max(0, Math.min(centers[index]! - size / 2, width - size))
      if (left < right + gap) return null
      labels.push({ index, text: label, left })
      right = left + size
    }
    return labels
  }
  const tried = steps ?? Array.from({ length: count }, (_, i) => i + 1)
  for (const step of tried) {
    if (step >= count) break
    const labels = layout(pick ? pick(step) : every(step))
    if (labels && labels.length > 0) return labels
  }
  return layout([anchor === 'start' ? 0 : count - 1])!
}

/**
 * The hour bars to label for a step of `step` hours: those starting on a local hour that is a
 * multiple of it, by the clock rather than by count, so a day of 23 or 25 hours keeps the times
 * of any other. An hour the clocks repeat is labelled once, and one that starts on the half hour
 * after a change of 30 minutes not at all.
 */
export function hourLabels(starts: readonly number[], step: number): number[] {
  const picked: number[] = []
  let last: number | null = null
  starts.forEach((start, i) => {
    const date = new Date(start)
    const hour = date.getHours()
    if (date.getMinutes() === 0 && hour % step === 0 && hour !== last) picked.push(i)
    last = hour
  })
  return picked
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

/** Whether a day outside the range has usage, which the heatmap then draws in gray. */
export function usedOutside(
  days: readonly number[],
  values: readonly number[],
  range: DayRange,
): boolean {
  return days.some((day, i) => (day < range.from || day >= range.to) && (values[i] ?? 0) > 0)
}

/**
 * Where the `index`th figure sits when the figures' card holds two to a row. A cell draws the
 * hairline on its top when a row is above it, and on its left when a cell is beside it.
 */
export function ledgerCell(index: number): { top: boolean; left: boolean } {
  return { top: index >= 2, left: index % 2 === 1 }
}

export interface BreakdownRow {
  key: string
  /** The model, or the project folder; null for a scratch or unknown project. */
  name: string | null
  /** The folder, for a project's tooltip. */
  path: string | null
  /** The row's tokens, which rank rows a metric cannot price. */
  total: number
  /** The row's value in the metric; null for a row no price covers. */
  value: number | null
}

function top(rows: Map<string, BreakdownRow>): BreakdownRow[] {
  return [...rows.values()]
    .filter((row) => row.total > 0)
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.total - a.total)
    .slice(0, BREAKDOWN_ROWS)
}

function addRow(
  rows: Map<string, BreakdownRow>,
  key: string,
  name: string | null,
  path: string | null,
  row: TokenParts,
  metric: Metric,
  scope: UsageScope,
): void {
  const sum = rows.get(key) ?? {
    key,
    name,
    path,
    total: 0,
    value: metricKind(metric, scope) === 'cost' ? null : 0,
  }
  sum.total += partsTotal(row)
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
  const rows = new Map<string, BreakdownRow>()
  for (const row of summary.models) {
    if (agent !== 'all' && row.agentId !== agent) continue
    addRow(rows, row.model, row.model || null, null, row, metric, scope)
  }
  return top(rows)
}

/** Projects by folder; No project folders and unknown ones are one row with no name. */
export function projectRows(
  summary: Pick<UsageSummary, 'projects'>,
  agent: AgentFilter,
  basename: (path: string) => string,
  metric: Metric = 'tokens',
  scope: UsageScope = 'computer',
): BreakdownRow[] {
  const rows = new Map<string, BreakdownRow>()
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
  return top(rows)
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

/**
 * Why typed dates make no range: not a date, after today, before the calendar's first day, or a
 * start after the end.
 */
export type DateError = 'format' | 'future' | 'early' | 'order'

/** A range being chosen: the start, then the end once a second day is picked. */
export interface RangeDraft {
  from: number | null
  to: number | null
}

const TYPED_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A date typed as YYYY-MM-DD as a local day, why it is none, or null while it may still be
 * incomplete: a field validates once it holds ten characters or is left. `earliest` is the first
 * day the calendar offers.
 */
export function typedDay(
  text: string,
  today: number,
  complete: boolean,
  earliest: number,
): number | Exclude<DateError, 'order'> | null {
  const value = text.trim()
  const match = TYPED_DAY.exec(value)
  if (!match) return complete || value.length >= 10 ? 'format' : null
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  const day = new Date(year, month, date)
  if (day.getFullYear() !== year || day.getMonth() !== month || day.getDate() !== date) {
    return 'format'
  }
  const time = day.getTime()
  if (time > today) return 'future'
  return time < earliest ? 'early' : time
}

/**
 * The range the picker's fields make: a typed end stands in for the draft's, and an end alone is
 * that one day. Null while a typed end is unfinished or wrong, with the reason once it is known.
 */
export function typedRange(
  draft: RangeDraft,
  typed: { from: string | null; to: string | null },
  complete: { from: boolean; to: boolean },
  today: number,
  earliest: number,
): { range: RangeDraft | null; error: DateError | null } {
  let error: DateError | null = null
  let pending = false
  const end = (which: 'from' | 'to'): number | null => {
    const text = typed[which]
    if (text === null) return draft[which]
    if (text.trim() === '') return null
    const day = typedDay(text, today, complete[which], earliest)
    if (typeof day === 'number') return day
    if (day === null) pending = true
    else error ??= day
    return null
  }
  const from = end('from')
  const to = end('to')
  if (error === null && from !== null && to !== null && from > to) error = 'order'
  if (error !== null || pending) return { range: null, error }
  return { range: from === null ? { from: to, to } : { from, to }, error: null }
}

/** The agents whose plans the page lists: each with plan limits, and each other with usage. */
export function planAgents<T extends { id: AgentId; limits: readonly unknown[] }>(
  agents: readonly T[],
  used: readonly AgentId[],
): T[] {
  return agents.filter((agent) => agent.limits.length > 0 || used.includes(agent.id))
}

/**
 * The plan limits' rows: an account that reports limits, or will once read, has a row; the agents
 * that report none join one line.
 */
export function splitPlans<
  T extends { limits: readonly unknown[]; capabilities: { reports: boolean } },
>(agents: readonly T[]): { rows: T[]; unreported: T[] } {
  const reports = (agent: T) => agent.limits.length > 0 || agent.capabilities.reports
  return { rows: agents.filter(reports), unreported: agents.filter((agent) => !reports(agent)) }
}

/** How a plan window's reset reads: the time left when it is within a day, else when it is. */
export function resetForm(resetsAt: number, now: number): 'in' | 'at' {
  const left = resetsAt - now
  return left > 0 && left < 86_400_000 ? 'in' : 'at'
}

/** The agents whose series color is their own, from their mark. */
const AGENT_FILLS: Partial<Record<AgentId, string>> = {
  'claude-code': 'bg-agent-claude-code',
  codex: 'bg-agent-codex',
  opencode: 'bg-agent-opencode',
  pi: 'bg-agent-pi',
  omp: 'bg-agent-omp',
  muse: 'bg-agent-muse',
  codewhale: 'bg-agent-codewhale',
}

/** An agent's series color; one without a color of its own shares the neutral one. */
export function agentFill(agentId: AgentId): string {
  return AGENT_FILLS[agentId] ?? 'bg-agent-other'
}
