import type { ContextBreakdown, ContextReport } from '@shared/context'
import type { SessionUsage } from '@shared/thread'

/** The context colors, `--context-1` to `--context-7`. */
export const CONTEXT_COLORS = 7

/**
 * The session's usage, or what the agent's own read counted while the session has none: some
 * providers report no context at all and leave the count at zero.
 */
export function shownUsage(
  usage: SessionUsage | null,
  breakdown: ContextBreakdown | null,
): SessionUsage | null {
  if (!usage || usage.used > 0 || !breakdown || breakdown.size <= 0) return usage
  return { ...usage, used: breakdown.used, size: breakdown.size }
}

/** What a part of the context is: a source with its color (1 to 7), the buffer, or what is left. */
export type ContextPart = { kind: 'source'; color: number } | { kind: 'buffer' } | { kind: 'free' }

export interface ContextRow {
  name: string
  tokens: number
  share: number | null
  part: ContextPart
}

const FREE = /^free space$/i
const BUFFER = /^autocompact buffer$/i
// The kinds that take the four colors, in the order every context breakdown shows them.
const KINDS = [/^messages$/i, /^memory files$/i, /^system tools$/i, /^mcp tools$/i]
// The small fixed costs that come next, in this order, before any other the report names.
const SMALL = [/^system prompt$/i, /^skills$/i, /^mcp server instructions$/i]
// The small fixed costs take the grays, `--context-5` on.
const FIRST_GRAY = KINDS.length + 1

type Category = ContextBreakdown['categories'][number]

/**
 * The report's categories as rows: messages, memory files, system tools and MCP tools in their own
 * colors and that order; then the system prompt, skills, MCP server instructions and any other
 * source in the report's order, in grays (one past the third reuses the last); then the
 * autocompact buffer, then free space.
 */
export function contextRows(categories: ContextBreakdown['categories']): ContextRow[] {
  const kinds: Category[][] = KINDS.map(() => [])
  const small: Category[][] = SMALL.map(() => [])
  const others: Category[] = []
  const free: ContextRow[] = []
  const buffer: ContextRow[] = []
  for (const category of categories) {
    if (FREE.test(category.name)) free.push({ ...category, part: { kind: 'free' } })
    else if (BUFFER.test(category.name)) buffer.push({ ...category, part: { kind: 'buffer' } })
    else {
      const kind = KINDS.findIndex((name) => name.test(category.name))
      const fixed = SMALL.findIndex((name) => name.test(category.name))
      if (kind >= 0) kinds[kind]!.push(category)
      else if (fixed >= 0) small[fixed]!.push(category)
      else others.push(category)
    }
  }
  const colored = kinds.flatMap((list, index) =>
    list.map((category): ContextRow => ({
      ...category,
      part: { kind: 'source', color: index + 1 },
    })),
  )
  const grays = [...small.flat(), ...others].map((category, index): ContextRow => ({
    ...category,
    part: { kind: 'source', color: Math.min(FIRST_GRAY + index, CONTEXT_COLORS) },
  }))
  return [...colored, ...grays, ...buffer, ...free]
}

export interface ContextSegment {
  key: string
  part: ContextPart | { kind: 'used' }
  /** Its weight in the bar, in tokens. */
  tokens: number
}

/** Compact summary metrics derived from session usage and any context breakdown rows. */
export interface ContextSummary {
  used: number
  reserved: number
  cap: number
  free: number
  over: number
  share: number
  percent: number
  level: 'ok' | 'warn' | 'full'
}

/**
 * Computes the displayed context totals, free/overflow room, percentage, and warning level.
 * Reserved parts (such as the autocompact buffer) occupy space in the bar and reduce free space,
 * without being counted as actively used context.
 */
export function contextSummary(
  usage: Pick<SessionUsage, 'used' | 'size'>,
  rows: readonly ContextRow[] | null,
): ContextSummary {
  const cap = Number.isFinite(usage.size) ? Math.max(0, usage.size) : 0
  let used: number
  let reserved = 0
  if (rows) {
    let sourceSum = 0
    for (const row of rows) {
      const value = Number.isFinite(row.tokens) ? Math.max(0, row.tokens) : 0
      if (row.part.kind === 'source') sourceSum += value
      else if (row.part.kind === 'buffer') reserved += value
    }
    used = sourceSum
  } else {
    used = Number.isFinite(usage.used) ? Math.max(0, usage.used) : 0
  }
  const share = cap > 0 ? used / cap : 0
  const percent = Math.round(share * 100)
  const free = Math.max(0, cap - used - reserved)
  const over = Math.max(0, used - cap)
  const level = percent >= 95 ? 'full' : percent >= 80 ? 'warn' : 'ok'
  return { used, reserved, cap, free, over, share, percent, level }
}

export interface ContextBarSegment {
  key: string
  part: ContextPart | { kind: 'used' }
  tokens: number
  /** Percentage of the horizontal bar width (0 to 100). */
  widthPercent: number
}

/**
 * Visible filled segments for the horizontal context progress bar (excluding free space, which is
 * represented by the bar track itself). When total occupied tokens exceed the window cap, segments
 * scale proportionally so they stay within 100%.
 */
export function barSegments(
  rows: readonly ContextRow[] | null,
  used: number,
  cap: number,
): ContextBarSegment[] {
  if (cap <= 0) return []
  if (!rows) {
    const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0
    if (safeUsed <= 0) return []
    return [
      {
        key: 'used',
        part: { kind: 'used' },
        tokens: safeUsed,
        widthPercent: Math.min(100, (safeUsed / cap) * 100),
      },
    ]
  }
  const active = rows.filter((row) => row.part.kind !== 'free' && row.tokens > 0)
  if (active.length === 0) return []
  const occupied = active.reduce((sum, row) => sum + row.tokens, 0)
  const scale = Math.max(cap, occupied)
  return active.map((row) => ({
    key: row.name,
    part: row.part,
    tokens: row.tokens,
    widthPercent: (row.tokens / scale) * 100,
  }))
}

/** Formats a single breakdown row's share of the context window compactly (e.g. "37%", "<1%"). */
export function formatPartShare(partTokens: number, cap: number): string {
  if (cap <= 0 || !Number.isFinite(partTokens) || partTokens <= 0) return '0%'
  const pct = (partTokens / cap) * 100
  if (pct < 1) return '<1%'
  return `${Math.round(pct)}%`
}

/** The bar's segments in order. Without a breakdown, one neutral segment of what is used. */
export function contextSegments(
  rows: readonly ContextRow[] | null,
  used: number,
  size: number,
): ContextSegment[] {
  if (!rows) {
    const segments: ContextSegment[] = [
      { key: 'used', part: { kind: 'used' }, tokens: Math.min(used, size) },
      { key: 'free', part: { kind: 'free' }, tokens: Math.max(0, size - used) },
    ]
    return segments.filter((segment) => segment.tokens > 0)
  }
  return rows
    .filter((row) => row.tokens > 0)
    .map((row, index) => ({ key: `${index}-${row.name}`, part: row.part, tokens: row.tokens }))
}

const SOURCE_COLOR = [
  'bg-context-1',
  'bg-context-2',
  'bg-context-3',
  'bg-context-4',
  'bg-context-5',
  'bg-context-6',
  'bg-context-7',
] as const

/** A part's fill in the bar, and in its row's swatch (where the buffer and free space are outlined). */
export function partFill(part: ContextPart | { kind: 'used' }): string {
  switch (part.kind) {
    case 'source':
      return SOURCE_COLOR[part.color - 1]!
    case 'buffer':
      return 'bg-(image:--context-hatch)'
    case 'used':
      // Neutral, since without a breakdown nothing says what the tokens are.
      return 'bg-current text-tertiary'
    case 'free':
      return ''
  }
}

/** What the context part shows under its bar, for the report the store keeps for a session. */
export type BreakdownView =
  | {
      kind: 'rows'
      rows: ContextRow[]
      dimmed: boolean
      /** The snapshot predates the current context, or its refresh failed. */
      stale: boolean
    }
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | { kind: 'betweenTurns' }
  | { kind: 'none' }

/** Keeps the last successful rows visible while a newer snapshot loads or retries. */
export function breakdownView(
  report: ContextReport | undefined,
  key: string,
  { reports, idle, live }: { reports: boolean; idle: boolean; live: boolean },
): BreakdownView {
  if (!reports) return { kind: 'none' }
  const breakdown = report?.breakdown
  const rows = breakdown ? contextRows(breakdown.categories) : null
  if (report?.error && rows) return { kind: 'rows', rows, dimmed: false, stale: true }
  if (live) {
    if (report && rows) return { kind: 'rows', rows, dimmed: false, stale: report.key !== key }
    if (report?.error) return { kind: 'error', error: report.error }
    if (report && !report.loading) return { kind: 'none' }
    return { kind: 'loading' }
  }
  if (!idle) {
    if (rows) return { kind: 'rows', rows, dimmed: false, stale: true }
    return { kind: 'betweenTurns' }
  }
  if (report?.error) return { kind: 'error', error: report.error }
  // A newer read dims the rows it replaces until its own arrive.
  if (report && rows && (report.loading || report.key === key)) {
    return { kind: 'rows', rows, dimmed: report.loading, stale: false }
  }
  // 对应当前 key 的一次读取已结束且无精确构成（如 Antigravity 新会话尚无 .db）时，不再停留在加载骨架屏。
  if (report && !report.loading && report.key === key) {
    return { kind: 'none' }
  }
  return { kind: 'loading' }
}

/**
 * 判断上下文弹层是否应显示「可加载的定义（估算）」区块：
 * 仅当智能体支持估算且当前没有精确上下文明细、也没有正在读取精确明细时才展示，
 * 避免与官方精确构成重复或加载瞬间闪烁，同时在暂无精确构成时平滑回退。
 */
export function showContextEstimates(estimates: boolean | undefined, view: BreakdownView): boolean {
  if (!estimates) return false
  return view.kind === 'none' || view.kind === 'error'
}
