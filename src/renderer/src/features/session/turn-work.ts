import {
  isDiffContentItem,
  toolContentItems,
  type DiffContentItem,
  type ThreadEntry,
  type ToolEntry,
} from '@shared/thread'

const finished = (entry: ThreadEntry | undefined): entry is ToolEntry =>
  entry?.kind === 'tool' && entry.status === 'completed'

const diffsOf = (entry: ToolEntry): DiffContentItem[] =>
  toolContentItems(entry).filter(isDiffContentItem)

export interface TurnChange {
  path: string
  diffs: DiffContentItem[]
  /** True when the turn's latest completed tool for this path deleted it. */
  deleted: boolean
  /** Tool entry ids that produced these diffs, used to fetch full bodies on demand when digested. */
  entryIds: string[]
}

/** A turn's changed files in the order it first changed them, each with its diffs in order. */
export function turnChanges(entries: (ThreadEntry | undefined)[]): TurnChange[] {
  const byPath = new Map<
    string,
    { diffs: DiffContentItem[]; deleted: boolean; entryIds: Set<string> }
  >()
  for (const entry of entries) {
    if (!finished(entry)) continue
    const deleting = entry.toolKind === 'delete'
    const diffs = diffsOf(entry)
    for (const diff of diffs) {
      const existing = byPath.get(diff.path)
      if (existing) {
        existing.diffs.push(diff)
        existing.deleted = deleting
        existing.entryIds.add(entry.id)
      } else {
        byPath.set(diff.path, { diffs: [diff], deleted: deleting, entryIds: new Set([entry.id]) })
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
  return [...byPath].map(([path, { diffs, deleted, entryIds }]) => ({
    path,
    diffs,
    deleted,
    entryIds: [...entryIds],
  }))
}
