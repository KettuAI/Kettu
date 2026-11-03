import type { ThreadEntry, ToolContent, ToolEntry } from '@shared/thread'

type Diff = Extract<ToolContent, { type: 'diff' }>

const finished = (entry: ThreadEntry | undefined): entry is ToolEntry =>
  entry?.kind === 'tool' && entry.status === 'completed'

const diffsOf = (entry: ToolEntry): Diff[] =>
  entry.content.filter((content): content is Diff => content.type === 'diff')

/**
 * How many files a turn's finished tool calls read and edited, each file once. A read names its
 * files in its locations, or counts once without any; an edit names its files in its diffs, or
 * in its locations when it brought none.
 */
export function workCounts(entries: (ThreadEntry | undefined)[]): {
  reads: number
  edits: number
} {
  const read = new Set<string>()
  const edited = new Set<string>()
  for (const entry of entries) {
    if (!finished(entry)) continue
    const diffs = diffsOf(entry)
    if (diffs.length > 0) {
      for (const diff of diffs) edited.add(diff.path)
    } else if (entry.toolKind === 'edit' || entry.toolKind === 'delete') {
      for (const { path } of entry.locations) edited.add(path)
    } else if (entry.toolKind === 'read') {
      if (entry.locations.length === 0) read.add(`call:${entry.id}`)
      for (const { path } of entry.locations) read.add(path)
    }
  }
  return { reads: read.size, edits: edited.size }
}

/** A turn's changed files in the order it first changed them, each with its diffs in order. */
export function turnChanges(
  entries: (ThreadEntry | undefined)[],
): { path: string; diffs: Diff[] }[] {
  const byPath = new Map<string, Diff[]>()
  for (const entry of entries) {
    if (!finished(entry)) continue
    for (const diff of diffsOf(entry)) {
      const diffs = byPath.get(diff.path)
      if (diffs) diffs.push(diff)
      else byPath.set(diff.path, [diff])
    }
  }
  return [...byPath].map(([path, diffs]) => ({ path, diffs }))
}
