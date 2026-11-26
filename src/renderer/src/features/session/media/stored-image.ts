// Images the host keeps in its thread store, which a thread names by hash: their bytes are read
// once one comes near the view, and kept, by hash, while something shows them.

import { useEffect, useState } from 'react'
import { errorMessage, host } from '@renderer/lib/host'

const isWebClient = (): boolean =>
  typeof window !== 'undefined' &&
  (window as { kettu?: { client?: string } }).kettu?.client === 'web'

/** How long bytes no picture shows are kept, for one scrolled back to. */
const KEEP_MS_DESKTOP = 60_000
const KEEP_MS_WEB = 15_000
/** Upper bounds on unreferenced cached blobs before immediate LRU eviction. */
const MAX_IDLE_DESKTOP = 64
const MAX_IDLE_WEB = 24
const MAX_IDLE_BYTES_DESKTOP = 96 * 1024 * 1024
const MAX_IDLE_BYTES_WEB = 32 * 1024 * 1024

interface Held {
  url: Promise<string>
  users: number
  bytes: number
  timer: ReturnType<typeof setTimeout> | null
}

const held = new Map<string, Held>()
const idleOrder = new Set<string>()
let idleBytes = 0

function dropHeld(hash: string, entry: Held): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = null
  if (idleOrder.delete(hash)) idleBytes -= entry.bytes
  if (held.get(hash) === entry) held.delete(hash)
  entry.url.then(URL.revokeObjectURL, () => {})
}

function trimIdle(): void {
  const maxEntries = isWebClient() ? MAX_IDLE_WEB : MAX_IDLE_DESKTOP
  const maxBytes = isWebClient() ? MAX_IDLE_BYTES_WEB : MAX_IDLE_BYTES_DESKTOP
  while (idleOrder.size > maxEntries || idleBytes > maxBytes) {
    const oldest = idleOrder.values().next().value
    if (oldest === undefined) break
    const entry = held.get(oldest)
    if (!entry) {
      idleOrder.delete(oldest)
      continue
    }
    dropHeld(oldest, entry)
  }
}

function acquire(sessionId: string, hash: string): Promise<string> {
  let entry = held.get(hash)
  if (!entry) {
    const added: Held = { url: Promise.resolve(''), users: 0, bytes: 0, timer: null }
    const url = host('sessions.blob', { sessionId, hash }).then(({ mimeType, bytes }) => {
      const blob = new Blob([bytes], { type: mimeType })
      added.bytes = blob.size
      if (idleOrder.has(hash)) {
        idleBytes += blob.size
        trimIdle()
      }
      return URL.createObjectURL(blob)
    })
    added.url = url
    // A read that failed is asked again the next time.
    url.catch(() => {
      if (held.get(hash) === added) {
        if (idleOrder.delete(hash)) idleBytes -= added.bytes
        held.delete(hash)
      }
    })
    held.set(hash, added)
    entry = added
  }
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = null
  if (idleOrder.delete(hash)) idleBytes -= entry.bytes
  entry.users++
  return entry.url
}

function release(hash: string): void {
  const entry = held.get(hash)
  if (!entry || --entry.users > 0) return
  if (!idleOrder.has(hash)) {
    idleOrder.add(hash)
    idleBytes += entry.bytes
  }
  const keepMs = isWebClient() ? KEEP_MS_WEB : KEEP_MS_DESKTOP
  entry.timer = setTimeout(() => dropHeld(hash, entry), keepMs)
  trimIdle()
}

export type StoredImage =
  { state: 'loading' } | { state: 'ready'; url: string } | { state: 'failed'; message: string }

/**
 * A stored image's object URL, read once `near` and kept while the caller shows it; `attempt`
 * reads it again after a failure.
 */
export function useStoredImage(
  sessionId: string,
  hash: string | null,
  near: boolean,
  attempt = 0,
): StoredImage {
  const [shown, setShown] = useState<{ key: string; image: StoredImage } | null>(null)
  const key = `${hash}:${attempt}`
  useEffect(() => {
    if (!hash || !near) return
    let current = true
    acquire(sessionId, hash).then(
      (url) => current && setShown({ key, image: { state: 'ready', url } }),
      (error: unknown) =>
        current && setShown({ key, image: { state: 'failed', message: errorMessage(error) } }),
    )
    return () => {
      current = false
      release(hash)
    }
  }, [sessionId, hash, near, key])
  return shown?.key === key ? shown.image : { state: 'loading' }
}
