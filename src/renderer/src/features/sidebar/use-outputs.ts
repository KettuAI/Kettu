import { useEffect, useState } from 'react'
import type { SessionOutputs, SessionSummary } from '@shared/agent-host'
import { host } from '@renderer/lib/host'

const NONE: SessionOutputs = { artifacts: [], references: [], reply: null, turnMs: null }

// The last answer per session, read again only once the session has changed, so hovering a row
// twice shows its card at once.
const kept = new Map<string, { updatedAt: number; outputs: SessionOutputs }>()
const inFlight = new Map<string, Promise<SessionOutputs>>()
let cacheEpoch = 0

/** Clears cached session output summaries (e.g. after switching accounts). */
export function clearSessionOutputsCache(): void {
  cacheEpoch += 1
  kept.clear()
  inFlight.clear()
}

/**
 * Preloads a session's outputs before its hover card opens. Idempotent and deduplicates concurrent
 * requests for the same session version (`id:updatedAt`).
 */
export function prefetchOutputs(
  summary: Pick<SessionSummary, 'id' | 'updatedAt'>,
): Promise<SessionOutputs> {
  const { id, updatedAt } = summary
  if (!id) return Promise.resolve(NONE)

  const stored = kept.get(id)
  if (stored?.updatedAt === updatedAt) return Promise.resolve(stored.outputs)

  const key = `${id}:${updatedAt}`
  const existing = inFlight.get(key)
  if (existing) return existing

  const epoch = cacheEpoch
  const pending = host('sessions.outputs', { sessionId: id }).then(
    (outputs) => {
      if (inFlight.get(key) === pending) inFlight.delete(key)
      if (cacheEpoch === epoch) {
        const current = kept.get(id)
        if (!current || updatedAt >= current.updatedAt) {
          kept.set(id, { updatedAt, outputs })
        }
      }
      return outputs
    },
    // A host that did not answer leaves the card its title and state without caching the failure.
    () => {
      if (inFlight.get(key) === pending) inFlight.delete(key)
      return NONE
    },
  )
  inFlight.set(key, pending)
  return pending
}

/** What the session made, from its host; null while it is read. */
export function useOutputs(summary: SessionSummary): SessionOutputs | null {
  const { id, updatedAt } = summary
  const [read, setRead] = useState<{ key: string; outputs: SessionOutputs } | null>(null)
  const key = `${id}:${updatedAt}`
  const stored = kept.get(id)
  const cached = stored?.updatedAt === updatedAt ? stored.outputs : null

  useEffect(() => {
    if (!id || cached !== null) return
    let live = true
    void prefetchOutputs({ id, updatedAt }).then((outputs) => {
      if (live) {
        setRead((prev) => (prev?.key === key && prev.outputs === outputs ? prev : { key, outputs }))
      }
    })
    return () => {
      live = false
    }
  }, [id, updatedAt, key, cached])

  if (cached !== null) return cached
  return read?.key === key ? read.outputs : null
}
