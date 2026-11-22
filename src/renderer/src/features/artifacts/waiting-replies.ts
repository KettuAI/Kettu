// How many of an artifact's comment threads wait for the user's reply: open, with an agent's
// answer last. Read for the cards in view, or for every artifact while the page filters by it, a
// few at a time, and read again when the host says its comments changed.

import { useEffect, useSyncExternalStore } from 'react'
import type { CommentThread } from '@shared/artifact-comments'
import { host } from '@renderer/lib/host'
import { onArtifactEvent } from '@renderer/stores/artifacts'

const AT_ONCE = 3

const counts = new Map<string, number>()
const waiting: string[] = []
const listeners = new Set<() => void>()
let reading = 0
let watching = false
let version = 0
let shot: ReadonlyMap<string, number> = new Map()
let shotVersion = 0

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  version++
  for (const listener of listeners) listener()
}

export function waitsForReply(thread: CommentThread): boolean {
  const last = thread.comments.at(-1)
  return thread.resolvedAt === null && thread.comments.length > 1 && last?.author.session != null
}

function watch(): void {
  if (watching) return
  watching = true
  onArtifactEvent((event) => {
    if (event.type !== 'artifacts.comments' || !counts.has(event.id)) return
    counts.delete(event.id)
    notify()
  })
}

function pump(): void {
  if (reading >= AT_ONCE) return
  const id = waiting.shift()
  if (!id) return
  reading++
  host('artifacts.comments', { id })
    .then((threads) => threads.filter(waitsForReply).length)
    .catch(() => 0)
    .then((count) => {
      counts.set(id, count)
      notify()
    })
    .finally(() => {
      reading--
      pump()
    })
  pump()
}

/** Queues the ids not read yet; the ones already waiting keep their turn. */
export function readWaitingReplies(ids: readonly string[]): void {
  watch()
  for (const id of ids) {
    if (!counts.has(id) && !waiting.includes(id)) waiting.push(id)
  }
  pump()
}

/** The threads waiting for a reply on `id`, read once `enabled`; undefined until read. */
export function useWaitingReplies(id: string, enabled: boolean): number | undefined {
  const count = useSyncExternalStore(subscribe, () => counts.get(id))
  useEffect(() => {
    if (enabled) readWaitingReplies([id])
  }, [id, enabled, count])
  return count
}

/** Every count read so far, for the page's filter; changes as more are read. */
export function useWaitingCounts(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, () => snapshot())
}

function snapshot(): ReadonlyMap<string, number> {
  if (shotVersion !== version) {
    shot = new Map(counts)
    shotVersion = version
  }
  return shot
}
