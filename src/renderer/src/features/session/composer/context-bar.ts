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
// The small fixed costs take the grays, `--context-5` on.
const FIRST_GRAY = KINDS.length + 1

/**
 * The report's categories as rows: messages, memory files, system tools and MCP tools in their own
 * colors and that order, then the other sources in the report's order in grays (one past the
 * third reuses the last), then the autocompact buffer, then free space.
 */
export function contextRows(categories: ContextBreakdown['categories']): ContextRow[] {
  const kinds: ContextRow[][] = KINDS.map(() => [])
  const others: ContextRow[] = []
  const free: ContextRow[] = []
  const buffer: ContextRow[] = []
  for (const category of categories) {
    const kind = KINDS.findIndex((name) => name.test(category.name))
    if (FREE.test(category.name)) free.push({ ...category, part: { kind: 'free' } })
    else if (BUFFER.test(category.name)) buffer.push({ ...category, part: { kind: 'buffer' } })
    else if (kind >= 0)
      kinds[kind]!.push({ ...category, part: { kind: 'source', color: kind + 1 } })
    else {
      const color = Math.min(FIRST_GRAY + others.length, CONTEXT_COLORS)
      others.push({ ...category, part: { kind: 'source', color } })
    }
  }
  return [...kinds.flat(), ...others, ...buffer, ...free]
}

export interface ContextSegment {
  key: string
  part: ContextPart | { kind: 'used' }
  /** Its weight in the bar, in tokens. */
  tokens: number
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
  return { kind: 'loading' }
}

/** The share of the context at which the agent compacts on its own: all but its buffer. */
export function compactsAt(rows: readonly ContextRow[] | null, size: number): number | null {
  const buffer = rows?.find((row) => row.part.kind === 'buffer')
  if (!buffer || size <= 0) return null
  return Math.floor(((size - buffer.tokens) / size) * 100)
}
