import { useEffect, useState } from 'react'
import {
  isDiffContentItem,
  type AnyToolContent,
  type DiffContentItem,
  type ToolContent,
} from '@shared/thread'
import type { DiffStats } from '../markdown/diff-stats'
import DiffStatsWorker from '../markdown/diff-stats-worker?worker'

type DiffContent = Extract<ToolContent, { type: 'diff' }>

const statsCache = new WeakMap<object, DiffStats>()
// Diffs whose count failed: they show no count, but no card waits for them.
const uncountable = new WeakSet<object>()

function digestStats(diff: DiffContentItem): DiffStats | null | undefined {
  if (diff.type !== 'digest') return undefined
  if (diff.added === null || diff.removed === null) return null
  return { insertions: diff.added, deletions: diff.removed }
}

const settled = (diff: DiffContentItem): boolean =>
  diff.type === 'digest' || statsCache.has(diff) || uncountable.has(diff)

function statsOf(diff: DiffContentItem): DiffStats | null {
  const digested = digestStats(diff)
  if (digested !== undefined) return digested
  return statsCache.get(diff) ?? null
}

/** Diffs a worker counts, sent in one message. */
export interface DiffJob {
  id: number
  diffs: { path: string; oldText: string | null; newText: string }[]
}

export interface DiffJobResult {
  id: number
  stats: (DiffStats | { error: string })[]
}

// Diffs are counted in a worker, a batch at a time, since diffing a large file takes long enough
// to drop frames; opening a thread full of edits spends no frame on them.
const waiting = new Set<DiffContent>()
const listeners = new Set<() => void>()
const jobs = new Map<number, DiffContent[]>()
let batch: DiffContent[] = []
let worker: Worker | null = null
// Set once the worker failed to start: the rest are counted here.
let workerFailed = false
let nextJob = 1

function startWorker(): Worker {
  const started = new DiffStatsWorker()
  started.onmessage = (event: MessageEvent<DiffJobResult>) => settle(event.data)
  started.onerror = (event) => {
    console.warn(`The diff counting worker failed: ${event.message}`)
    workerFailed = true
    worker = null
    started.terminate()
    for (const id of [...jobs.keys()]) void countHere(id)
  }
  return started
}

function send(): void {
  const diffs = batch
  batch = []
  const id = nextJob++
  jobs.set(id, diffs)
  if (workerFailed) {
    void countHere(id)
    return
  }
  worker ??= startWorker()
  const job: DiffJob = {
    id,
    diffs: diffs.map((d) => ({ path: d.path, oldText: d.oldText, newText: d.newText })),
  }
  worker.postMessage(job)
}

async function countHere(id: number): Promise<void> {
  const { diffStats } = await import('../markdown/diff-stats')
  const diffs = jobs.get(id) ?? []
  settle({
    id,
    stats: diffs.map((d) => {
      try {
        return diffStats(d.path, d.oldText, d.newText)
      } catch (error) {
        return { error: String((error as Error)?.message ?? error) }
      }
    }),
  })
}

function settle({ id, stats }: DiffJobResult): void {
  const diffs = jobs.get(id)
  if (!diffs) return
  jobs.delete(id)
  diffs.forEach((diff, i) => {
    const counted = stats[i]
    waiting.delete(diff)
    if (!counted || 'error' in counted) {
      console.error(`Could not count the lines of a diff of ${diff.path}: ${counted?.error}`)
      uncountable.add(diff)
    } else statsCache.set(diff, counted)
  })
  for (const listener of [...listeners]) listener()
}

function count(diffs: DiffContent[]): void {
  const first = batch.length === 0
  for (const diff of diffs) {
    if (settled(diff) || waiting.has(diff)) continue
    waiting.add(diff)
    batch.push(diff)
  }
  // The diffs a render asks for go in one message.
  if (first && batch.length > 0) queueMicrotask(send)
}

/** Counts the diffs later and calls `done` once all of them are; returns a function to stop. */
function countLater(diffs: DiffContent[], done: () => void): () => void {
  const listener = () => {
    if (!diffs.every(settled)) return
    listeners.delete(listener)
    done()
  }
  listeners.add(listener)
  count(diffs)
  return () => listeners.delete(listener)
}

/** Insertions and deletions over the diffs, or null until all of them are counted. */
export function useDiffStats(content: readonly AnyToolContent[]): DiffStats | null {
  const diffs = content.filter(isDiffContentItem)
  const fullDiffs = diffs.filter((d): d is DiffContent => d.type === 'diff')
  const done = diffs.length > 0 && diffs.every(settled)
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (done || fullDiffs.length === 0) return
    return countLater(fullDiffs, () => setVersion((v) => v + 1))
    // Re-subscribe only when the input list changes or its diffs are still waiting to be counted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, done])
  if (!done) return null
  let insertions = 0
  let deletions = 0
  for (const d of diffs) {
    const s = statsOf(d)
    if (!s) return null
    insertions += s.insertions
    deletions += s.deletions
  }
  return { insertions, deletions }
}

/** Whether every diff `useDiffStats` was given is counted or failed to count. */
export function diffsSettled(content: readonly AnyToolContent[]): boolean {
  return content.every((c) => !isDiffContentItem(c) || settled(c))
}

/** The counts over diffs `useDiffStats` has loaded, or null while any is still to count. */
export function cachedStats(diffs: readonly AnyToolContent[]): DiffStats | null {
  let insertions = 0
  let deletions = 0
  for (const d of diffs) {
    if (!isDiffContentItem(d)) return null
    const s = statsOf(d)
    if (!s) return null
    insertions += s.insertions
    deletions += s.deletions
  }
  return { insertions, deletions }
}
