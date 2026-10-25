import type { ContextBreakdown } from '@shared/agent-host'

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
