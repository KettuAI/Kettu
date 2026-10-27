import type { ContextBreakdown } from '@shared/agent-host'
import type { ContextReport } from '@renderer/stores/usage'

/** The context colors, `--context-1` to `--context-7`. */
export const CONTEXT_COLORS = 7

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

/**
 * The report's categories as rows: the sources in the report's order, each in the next context
 * color (a source past the seventh reuses the last), then free space, then the autocompact buffer.
 */
export function contextRows(categories: ContextBreakdown['categories']): ContextRow[] {
  const sources: ContextRow[] = []
  const free: ContextRow[] = []
  const buffer: ContextRow[] = []
  for (const category of categories) {
    if (FREE.test(category.name)) free.push({ ...category, part: { kind: 'free' } })
    else if (BUFFER.test(category.name)) buffer.push({ ...category, part: { kind: 'buffer' } })
    else {
      const color = Math.min(sources.length + 1, CONTEXT_COLORS)
      sources.push({ ...category, part: { kind: 'source', color } })
    }
  }
  return [...sources, ...free, ...buffer]
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
      // The neutral fill a plan's bar takes below 80%.
      return 'bg-current text-tertiary'
    case 'free':
      return ''
  }
}

/** What the context part shows under its bar, for the report the store keeps for a session. */
export type BreakdownView =
  | { kind: 'rows'; rows: ContextRow[]; dimmed: boolean }
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | { kind: 'betweenTurns' }
  | { kind: 'none' }

/**
 * The rows, skeleton rows, error or between-turns line to show. The rows show only while no turn
 * runs, and only for the context in use; a read that fails drops the older rows, so nothing read
 * for an earlier context passes for the current one.
 */
export function breakdownView(
  report: ContextReport | undefined,
  key: string,
  { reports, idle }: { reports: boolean; idle: boolean },
): BreakdownView {
  if (!reports) return { kind: 'none' }
  if (!idle) return { kind: 'betweenTurns' }
  if (report?.error) return { kind: 'error', error: report.error }
  // A newer read dims the rows it replaces until its own arrive.
  if (report?.breakdown && (report.loading || report.key === key)) {
    return {
      kind: 'rows',
      rows: contextRows(report.breakdown.categories),
      dimmed: report.loading,
    }
  }
  return { kind: 'loading' }
}
