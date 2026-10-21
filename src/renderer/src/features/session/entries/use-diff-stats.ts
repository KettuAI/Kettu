import { useEffect, useState } from 'react'
import type { ToolContent } from '@shared/thread'
import type { DiffStats } from '../markdown/diff-stats'

const statsCache = new WeakMap<object, DiffStats>()

/** Insertions and deletions over the diffs, counted once the diff module has loaded. */
export function useDiffStats(content: ToolContent[]): DiffStats | null {
  const diffs = content.filter((c) => c.type === 'diff')
  const cached = diffs.length > 0 && diffs.every((d) => statsCache.has(d))
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (cached || diffs.length === 0) return
    let live = true
    void import('../markdown/diff-stats').then(({ diffStats }) => {
      for (const d of diffs) {
        if (!statsCache.has(d)) statsCache.set(d, diffStats(d.path, d.oldText, d.newText))
      }
      if (live) setVersion((v) => v + 1)
    })
    return () => {
      live = false
    }
  })
  if (!cached) return null
  return diffs.reduce(
    (sum, d) => {
      const s = statsCache.get(d)!
      return { insertions: sum.insertions + s.insertions, deletions: sum.deletions + s.deletions }
    },
    { insertions: 0, deletions: 0 },
  )
}
