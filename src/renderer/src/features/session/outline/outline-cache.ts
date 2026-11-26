import type { OutlineEntry, OutlineTitle } from '@shared/agent-host'

/** Maximum number of sessions whose outline entries stay cached across session switches. */
export const MAX_CACHED_OUTLINES = 64

export interface OutlineFetchTicket {
  seq: number
  epoch: number
}

const cache = new Map<string, OutlineEntry[]>()
const listeners = new Map<string, Set<() => void>>()
const sessionEpochs = new Map<string, number>()
const lastCommittedSeq = new Map<string, number>()
let floorEpoch = 0
let nextEpoch = 0
let nextSeq = 0

function notify(sessionId: string): void {
  const set = listeners.get(sessionId)
  if (!set) return
  for (const listener of [...set]) listener()
}

function evictOverflow(): void {
  while (cache.size > MAX_CACHED_OUTLINES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
    lastCommittedSeq.delete(oldest)
  }
}

/** Monotonic invalidation token for `sessionId` so stale in-flight RPCs cannot repopulate cache. */
export function outlineCacheEpoch(sessionId: string): number {
  return Math.max(floorEpoch, sessionEpochs.get(sessionId) ?? 0)
}

/** Pure snapshot read for `useSyncExternalStore`. */
export function getCachedOutline(sessionId: string): OutlineEntry[] | null {
  return cache.get(sessionId) ?? null
}

/** Promotes `sessionId` to most-recently-used without notifying subscribers. */
export function touchCachedOutline(sessionId: string): void {
  const entries = cache.get(sessionId)
  if (!entries) return
  cache.delete(sessionId)
  cache.set(sessionId, entries)
}

/** Subscribes to cache updates and invalidations for a single session. */
export function subscribeOutline(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId)
  if (!set) listeners.set(sessionId, (set = new Set()))
  set.add(listener)
  return () => {
    const current = listeners.get(sessionId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(sessionId)
  }
}

/** Captures a monotonic ticket before issuing `sessions.outline` for `sessionId`. */
export function beginOutlineFetch(sessionId: string): OutlineFetchTicket {
  return { seq: ++nextSeq, epoch: outlineCacheEpoch(sessionId) }
}

/**
 * Stores fetched outline entries if `ticket` has neither been invalidated nor superseded by a
 * newer response. Preserves freshly patched titles for identical `(entryId, pos)` rows when a
 * concurrent `sessions.outline` resolves slightly after `sessions.outlineTitles`.
 */
export function commitCachedOutline(
  sessionId: string,
  entries: OutlineEntry[],
  ticket?: OutlineFetchTicket,
): boolean {
  if (ticket) {
    if (outlineCacheEpoch(sessionId) !== ticket.epoch) return false
    if (ticket.seq < (lastCommittedSeq.get(sessionId) ?? 0)) return false
    lastCommittedSeq.set(sessionId, ticket.seq)
  }
  const previous = cache.get(sessionId)
  let next = entries
  if (previous && previous.length > 0) {
    const existingTitles = new Map<string, { pos: number; title: string }>()
    for (const entry of previous) {
      if (entry.title !== null)
        existingTitles.set(entry.entryId, { pos: entry.pos, title: entry.title })
    }
    if (existingTitles.size > 0) {
      let merged = false
      const preserved = entries.map((entry) => {
        if (entry.title !== null) return entry
        const prev = existingTitles.get(entry.entryId)
        if (!prev || prev.pos !== entry.pos) return entry
        merged = true
        return { ...entry, title: prev.title }
      })
      if (merged) next = preserved
    }
  }
  cache.delete(sessionId)
  cache.set(sessionId, next)
  evictOverflow()
  notify(sessionId)
  return true
}

/**
 * Applies newly generated titles to the cached outline for `sessionId` when `expectedEpoch` still
 * matches. Returns whether the cached outline changed.
 */
export function patchCachedOutlineTitles(
  sessionId: string,
  titles: readonly OutlineTitle[],
  expectedEpoch?: number,
): boolean {
  if (titles.length === 0) return false
  if (expectedEpoch !== undefined && outlineCacheEpoch(sessionId) !== expectedEpoch) return false
  const current = cache.get(sessionId)
  if (!current) return false
  const byPos = new Map(titles.map(({ pos, title }) => [pos, title]))
  let changed = false
  const next = current.map((entry) => {
    const title = byPos.get(entry.pos)
    if (title === undefined || title === entry.title) return entry
    changed = true
    return { ...entry, title }
  })
  if (!changed) return false
  cache.delete(sessionId)
  cache.set(sessionId, next)
  evictOverflow()
  notify(sessionId)
  return true
}

/** Removes one session's cached outline (e.g., on archive/delete) and bumps its invalidation epoch. */
export function forgetOutline(sessionId: string): void {
  const had = cache.delete(sessionId)
  lastCommittedSeq.delete(sessionId)
  sessionEpochs.set(sessionId, ++nextEpoch)
  if (sessionEpochs.size > MAX_CACHED_OUTLINES * 4) {
    floorEpoch = ++nextEpoch
    sessionEpochs.clear()
  }
  if (had) notify(sessionId)
}

/**
 * Invalidates cached outlines across sessions: all sessions when `only` is omitted, or only
 * matching sessions (e.g., when a specific host reconnects via `rewatchAll`).
 */
export function invalidateOutlines(only?: (sessionId: string) => boolean): void {
  if (!only) {
    const active = new Set([...cache.keys(), ...listeners.keys()])
    cache.clear()
    lastCommittedSeq.clear()
    floorEpoch = ++nextEpoch
    sessionEpochs.clear()
    for (const sessionId of active) notify(sessionId)
    return
  }
  const targets = new Set<string>()
  for (const sessionId of cache.keys()) if (only(sessionId)) targets.add(sessionId)
  for (const sessionId of listeners.keys()) if (only(sessionId)) targets.add(sessionId)
  for (const sessionId of targets) forgetOutline(sessionId)
}
