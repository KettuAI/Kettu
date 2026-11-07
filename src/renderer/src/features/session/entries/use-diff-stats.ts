import { useEffect, useState } from 'react'
import type { ToolContent } from '@shared/thread'
import type { DiffStats } from '../markdown/diff-stats'

type DiffContent = Extract<ToolContent, { type: 'diff' }>

const statsCache = new WeakMap<object, DiffStats>()

// Diffs still to count. They are counted in idle time, a few at a time, so opening a thread full
// of edits never spends a frame on them.
const pending = new Set<DiffContent>()
const listeners = new Set<() => void>()
let count: typeof import('../markdown/diff-stats').diffStats | null = null
let scheduled = false

// Safari, where the web client may run, has no idle callbacks.
const IDLE_FALLBACK = { didTimeout: true, timeRemaining: () => 0 }
const whenIdle: (run: (deadline: IdleDeadline) => void) => void =
  typeof requestIdleCallback === 'function'
    ? (run) => requestIdleCallback(run, { timeout: 1000 })
    : (run) => setTimeout(() => run(IDLE_FALLBACK), 1)

function schedule(): void {
  if (scheduled) return
  scheduled = true
  whenIdle(work)
}

function work(deadline: IdleDeadline): void {
  scheduled = false
  if (!count) {
    void import('../markdown/diff-stats').then((module) => {
      count = module.diffStats
      schedule()
    })
    return
  }
  // At least one per call, so a window that is never idle still gets through them.
  do {
    const diff = pending.values().next().value
    if (!diff) break
    pending.delete(diff)
    if (!statsCache.has(diff)) statsCache.set(diff, count(diff.path, diff.oldText, diff.newText))
  } while (deadline.timeRemaining() > 0)
  for (const listener of [...listeners]) listener()
  if (pending.size > 0) schedule()
}

/** Counts the diffs later and calls `done` once all of them are; returns a function to stop. */
function countLater(diffs: DiffContent[], done: () => void): () => void {
  for (const diff of diffs) if (!statsCache.has(diff)) pending.add(diff)
  const listener = () => {
    if (!diffs.every((d) => statsCache.has(d))) return
    listeners.delete(listener)
    done()
  }
  listeners.add(listener)
  schedule()
  return () => listeners.delete(listener)
}

/** Insertions and deletions over the diffs, or null until all of them are counted. */
export function useDiffStats(content: ToolContent[]): DiffStats | null {
  const diffs = content.filter((c) => c.type === 'diff')
  const cached = diffs.length > 0 && diffs.every((d) => statsCache.has(d))
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (cached || diffs.length === 0) return
    return countLater(diffs, () => setVersion((v) => v + 1))
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

/** The counts over diffs `useDiffStats` has loaded, or null while any is still to count. */
export function cachedStats(diffs: readonly ToolContent[]): DiffStats | null {
  let insertions = 0
  let deletions = 0
  for (const d of diffs) {
    const s = statsCache.get(d)
    if (!s) return null
    insertions += s.insertions
    deletions += s.deletions
  }
  return { insertions, deletions }
}
