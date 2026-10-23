// The usage page's arithmetic: local days, the chosen range, and the figures, trend, heatmap and
// breakdowns summed from the host's per-day rows. Pure, so it is tested without a window.

import type { AgentId } from '@shared/thread'
import { partsTotal, type TokenParts, type UsageSummary } from '@shared/usage'

export type RangeKind = '1' | '7' | '30' | '90' | '365' | 'all'
/** A custom range holds local day starts, both ends included. */
export type RangeChoice = { kind: RangeKind } | { kind: 'custom'; from: number; to: number }
export type AgentFilter = AgentId | 'all'

/** Local days as [from, to): day starts, `to` the day after the last. */
export interface DayRange {
  from: number
  to: number
}

export const RANGE_KINDS: readonly RangeKind[] = ['1', '7', '30', '90', '365', 'all']
export const HEATMAP_WEEKS = 53
/** Up to this many days the trend has a bar per day, beyond it one per week. */
export const DAILY_BARS = 92
export const BREAKDOWN_ROWS = 6

const HOUR_MS = 3_600_000

const ZERO: TokenParts = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

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
 * The hour starts of [from, to), and `to` itself. It steps real hours, since local ones repeat or
 * vanish when the clocks change: such a day has 25 or 23 hours, and the starts always ascend.
 */
export function hourStarts(range: DayRange): number[] {
  const starts: number[] = []
  for (let hour = range.from; hour < range.to; hour += HOUR_MS) starts.push(hour)
  starts.push(range.to)
  return starts
}

/** The hours of a one-day range begun by `now`, as the range its figures cover. */
export function hoursSoFar(starts: readonly number[], now: number): DayRange {
  const end = starts.find((start, i) => i > 0 && start > now) ?? starts[starts.length - 1]!
  return { from: starts[0]!, to: end }
}

export interface DayTotal {
  /** The day's start, or the hour's when summed over `hourStarts`. */
  day: number
  total: number
  parts: TokenParts
  byAgent: Partial<Record<AgentId, number>>
}

/** Each requested day's totals for the agents the filter keeps; days with nothing are zero. */
export function dayTotals(
  summary: Pick<UsageSummary, 'days'>,
  starts: readonly number[],
  agent: AgentFilter,
): DayTotal[] {
  const days: DayTotal[] = starts
    .slice(0, -1)
    .map((day) => ({ day, total: 0, parts: { ...ZERO }, byAgent: {} }))
  for (const row of summary.days) {
    if (agent !== 'all' && row.agentId !== agent) continue
    const day = days[row.day]
    if (!day) continue
    const total = partsTotal(row)
    day.total += total
    day.byAgent[row.agentId] = (day.byAgent[row.agentId] ?? 0) + total
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
}

export interface Figures {
  total: number
  parts: TokenParts
  days: number
  activeDays: number
  /** Over the active days; null with none. */
  average: number | null
  peak: { day: number; total: number } | null
  /** Cache reads over the whole input side; null with no input. */
  cacheShare: number | null
}

export function figures(days: readonly DayTotal[], range: DayRange): Figures {
  const parts = { ...ZERO }
  let total = 0
  let activeDays = 0
  let peak: Figures['peak'] = null
  let count = 0
  for (const day of days) {
    if (day.day < range.from || day.day >= range.to) continue
    count++
    if (day.total <= 0) continue
    activeDays++
    total += day.total
    addInto(parts, day.parts)
    if (!peak || day.total > peak.total) peak = { day: day.day, total: day.total }
  }
  const inputSide = parts.input + parts.cacheRead + parts.cacheWrite
  return {
    total,
    parts,
    days: count,
    activeDays,
    average: activeDays > 0 ? total / activeDays : null,
    peak,
    cacheShare: inputSide > 0 ? parts.cacheRead / inputSide : null,
  }
}

export interface TrendBar {
  /** The bar's first day and the day after its last. */
  from: number
  to: number
  total: number
  byAgent: Partial<Record<AgentId, number>>
}

/** A bar per day for a range up to `DAILY_BARS` days, else per week, clipped to the range. */
export function trend(
  days: readonly DayTotal[],
  range: DayRange,
  firstDay: number,
): { weekly: boolean; bars: TrendBar[] } {
  const inRange = days.filter((d) => d.day >= range.from && d.day < range.to)
  const weekly = inRange.length > DAILY_BARS
  const bars: TrendBar[] = []
  for (const day of inRange) {
    const start = weekly ? Math.max(weekStartOf(day.day, firstDay), range.from) : day.day
    let bar = bars[bars.length - 1]
    if (!bar || bar.from !== start) {
      bar = { from: start, to: start, total: 0, byAgent: {} }
      bars.push(bar)
    }
    bar.to = addDays(day.day, 1)
    bar.total += day.total
    for (const [agentId, total] of Object.entries(day.byAgent) as [AgentId, number][]) {
      bar.byAgent[agentId] = (bar.byAgent[agentId] ?? 0) + total
    }
  }
  return { weekly, bars }
}

/** A bar per hour, from the totals `dayTotals` sums over `hourStarts`. */
export function hourBars(hours: readonly DayTotal[], starts: readonly number[]): TrendBar[] {
  return hours.map((hour, i) => ({
    from: hour.day,
    to: starts[i + 1]!,
    total: hour.total,
    byAgent: hour.byAgent,
  }))
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
  /** The model, or the project folder; null for a scratch or unknown project. */
  name: string | null
  /** The folder, for a project's tooltip. */
  path: string | null
  total: number
}

function top(rows: Map<string, BreakdownRow>): BreakdownRow[] {
  return [...rows.values()]
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, BREAKDOWN_ROWS)
}

export function modelRows(
  summary: Pick<UsageSummary, 'models'>,
  agent: AgentFilter,
): BreakdownRow[] {
  const rows = new Map<string, BreakdownRow>()
  for (const row of summary.models) {
    if (agent !== 'all' && row.agentId !== agent) continue
    const sum = rows.get(row.model) ?? {
      key: row.model,
      name: row.model || null,
      path: null,
      total: 0,
    }
    sum.total += partsTotal(row)
    rows.set(row.model, sum)
  }
  return top(rows)
}

/** Projects by folder; No project folders and unknown ones are one row with no name. */
export function projectRows(
  summary: Pick<UsageSummary, 'projects'>,
  agent: AgentFilter,
  basename: (path: string) => string,
): BreakdownRow[] {
  const rows = new Map<string, BreakdownRow>()
  for (const row of summary.projects) {
    if (agent !== 'all' && row.agentId !== agent) continue
    const named = row.project !== null && !row.scratch
    const key = named ? row.project! : ''
    const sum = rows.get(key) ?? {
      key,
      name: named ? basename(row.project!) : null,
      path: named ? row.project : null,
      total: 0,
    }
    sum.total += partsTotal(row)
    rows.set(key, sum)
  }
  return top(rows)
}

/** The agents with any usage in the rows, in the given order. */
export function agentsWithUsage(
  summary: Pick<UsageSummary, 'days'>,
  order: readonly AgentId[],
): AgentId[] {
  const seen = new Set(summary.days.filter((d) => partsTotal(d) > 0).map((d) => d.agentId))
  return order.filter((id) => seen.has(id))
}

export interface Preset {
  id:
    | 'today'
    | 'yesterday'
    | 'thisWeek'
    | 'lastWeek'
    | 'thisMonth'
    | 'lastMonth'
    | 'last7'
    | 'last30'
    | 'last90'
    | 'thisYear'
    | 'allTime'
  /** Local day starts, both ends included. */
  from: number
  to: number
}

/** The picker's presets for `today`; `first` is the first day with usage, if any. */
export function presets(today: number, firstDay: number, first: number | null): Preset[] {
  const date = new Date(today)
  const week = weekStartOf(today, firstDay)
  const month = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
  const lastMonth = new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime()
  const year = new Date(date.getFullYear(), 0, 1).getTime()
  return [
    { id: 'today', from: today, to: today },
    { id: 'yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    { id: 'thisWeek', from: week, to: today },
    { id: 'lastWeek', from: addDays(week, -7), to: addDays(week, -1) },
    { id: 'thisMonth', from: month, to: today },
    { id: 'lastMonth', from: lastMonth, to: addDays(month, -1) },
    { id: 'last7', from: addDays(today, -6), to: today },
    { id: 'last30', from: addDays(today, -29), to: today },
    { id: 'last90', from: addDays(today, -89), to: today },
    { id: 'thisYear', from: year, to: today },
    { id: 'allTime', from: first === null ? today : Math.min(dayOf(first), today), to: today },
  ]
}

/** Why typed dates make no range: not a date, after today, or a start after the end. */
export type DateError = 'format' | 'future' | 'order'

/** A range being chosen: the start, then the end once a second day is picked. */
export interface RangeDraft {
  from: number | null
  to: number | null
}

const TYPED_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A date typed as YYYY-MM-DD as a local day, why it is none, or null while it may still be
 * incomplete: a field validates once it holds ten characters or is left.
 */
export function typedDay(
  text: string,
  today: number,
  complete: boolean,
): number | Exclude<DateError, 'order'> | null {
  const value = text.trim()
  const match = TYPED_DAY.exec(value)
  if (!match) return complete || value.length >= 10 ? 'format' : null
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  const day = new Date(year, month, date)
  if (day.getFullYear() !== year || day.getMonth() !== month || day.getDate() !== date) {
    return 'format'
  }
  return day.getTime() > today ? 'future' : day.getTime()
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
): { range: RangeDraft | null; error: DateError | null } {
  let error: DateError | null = null
  let pending = false
  const end = (which: 'from' | 'to'): number | null => {
    const text = typed[which]
    if (text === null) return draft[which]
    if (text.trim() === '') return null
    const day = typedDay(text, today, complete[which])
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

/** Each agent's series color, from its mark. */
export const AGENT_FILL: Record<AgentId, string> = {
  'claude-code': 'bg-agent-claude-code',
  codex: 'bg-agent-codex',
  opencode: 'bg-agent-opencode',
  'fake-agent': 'bg-agent-other',
}
