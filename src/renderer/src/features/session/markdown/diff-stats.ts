import { parseDiffFromFile } from '@pierre/diffs'

export interface DiffStats {
  insertions: number
  deletions: number
}

/** Line counts of a change, from the same diff algorithm the diff view draws. */
export function diffStats(path: string, oldText: string | null, newText: string): DiffStats {
  const diff = parseDiffFromFile(oldText === null ? null : { name: path, contents: oldText }, {
    name: path,
    contents: newText,
  })
  let insertions = 0
  let deletions = 0
  for (const hunk of diff.hunks) {
    insertions += hunk.additionLines
    deletions += hunk.deletionLines
  }
  return { insertions, deletions }
}
