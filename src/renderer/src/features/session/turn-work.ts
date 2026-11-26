import type { ThreadEntry, ToolContent, ToolEntry } from '@shared/thread'

type Diff = Extract<ToolContent, { type: 'diff' }>

const finished = (entry: ThreadEntry | undefined): entry is ToolEntry =>
  entry?.kind === 'tool' && entry.status === 'completed'

const diffsOf = (entry: ToolEntry): Diff[] =>
  entry.content.filter((content): content is Diff => content.type === 'diff')

export interface TurnChange {
  path: string
  diffs: Diff[]
  /** True when the turn's latest completed tool for this path deleted it. */
  deleted: boolean
}

/** A turn's changed files in the order it first changed them, each with its diffs in order. */
export function turnChanges(entries: (ThreadEntry | undefined)[]): TurnChange[] {
  const byPath = new Map<string, { diffs: Diff[]; deleted: boolean }>()
  for (const entry of entries) {
    if (!finished(entry)) continue
    const deleting = entry.toolKind === 'delete'
    const diffs = diffsOf(entry)
    for (const diff of diffs) {
      const existing = byPath.get(diff.path)
      if (existing) {
        existing.diffs.push(diff)
        existing.deleted = deleting
      } else {
        byPath.set(diff.path, { diffs: [diff], deleted: deleting })
      }
    }
    // A delete tool may carry the path only in locations after an earlier edit in the same turn.
    if (deleting && diffs.length === 0) {
      for (const location of entry.locations) {
        const existing = byPath.get(location.path)
        if (existing) existing.deleted = true
      }
    }
  }
  return [...byPath].map(([path, { diffs, deleted }]) => ({ path, diffs, deleted }))
}
