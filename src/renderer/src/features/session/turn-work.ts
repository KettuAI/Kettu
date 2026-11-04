import type { ThreadEntry, ToolContent, ToolEntry } from '@shared/thread'

type Diff = Extract<ToolContent, { type: 'diff' }>

const finished = (entry: ThreadEntry | undefined): entry is ToolEntry =>
  entry?.kind === 'tool' && entry.status === 'completed'

const diffsOf = (entry: ToolEntry): Diff[] =>
  entry.content.filter((content): content is Diff => content.type === 'diff')

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
