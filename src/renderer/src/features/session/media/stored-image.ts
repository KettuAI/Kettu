// Images the host keeps in its thread store, which a thread names by hash: their bytes are read
// once one comes near the view, and kept, by hash, while something shows them.

import { useEffect, useState } from 'react'
import { errorMessage, host } from '@renderer/lib/host'

/** How long bytes no picture shows are kept, for one scrolled back to. */
const KEEP_MS = 60_000

interface Held {
  url: Promise<string>
  users: number
  timer: ReturnType<typeof setTimeout> | null
}

const held = new Map<string, Held>()

function acquire(sessionId: string, hash: string): Promise<string> {
  let entry = held.get(hash)
  if (!entry) {
    const url = host('sessions.blob', { sessionId, hash }).then(({ mimeType, bytes }) =>
      URL.createObjectURL(new Blob([bytes], { type: mimeType })),
    )
    const added: Held = { url, users: 0, timer: null }
    // A read that failed is asked again the next time.
    url.catch(() => {
      if (held.get(hash) === added) held.delete(hash)
    })
    held.set(hash, added)
    entry = added
  }
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = null
  entry.users++
  return entry.url
}

function release(hash: string): void {
  const entry = held.get(hash)
  if (!entry || --entry.users > 0) return
  entry.timer = setTimeout(() => {
    held.delete(hash)
    entry.url.then(URL.revokeObjectURL, () => {})
  }, KEEP_MS)
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
