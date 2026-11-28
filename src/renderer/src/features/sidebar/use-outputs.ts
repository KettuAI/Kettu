import { useEffect, useState } from 'react'
import type { SessionOutputs, SessionSummary } from '@shared/agent-host'
import { host } from '@renderer/lib/host'

const NONE: SessionOutputs = { artifacts: [], references: [], reply: null, turnMs: null }

// The last answer per session, read again only once the session has changed, so hovering a row
// twice shows its card at once.
const kept = new Map<string, { updatedAt: number; outputs: SessionOutputs }>()

/** Clears cached session output summaries (e.g. after switching accounts). */
export function clearSessionOutputsCache(): void {
  kept.clear()
}

/** What the session made, from its host; null while it is read. */
export function useOutputs(summary: SessionSummary): SessionOutputs | null {
  const { id, updatedAt } = summary
  const [read, setRead] = useState<{ key: string; outputs: SessionOutputs } | null>(null)
  const key = `${id}:${updatedAt}`
  useEffect(() => {
    if (kept.get(id)?.updatedAt === updatedAt) return
    let live = true
    host('sessions.outputs', { sessionId: id }).then(
      (outputs) => {
        kept.set(id, { updatedAt, outputs })
        if (live) setRead({ key: `${id}:${updatedAt}`, outputs })
      },
      // A host that did not answer leaves the card its title and state.
      () => {
        if (live) setRead({ key: `${id}:${updatedAt}`, outputs: NONE })
      },
    )
    return () => {
      live = false
    }
  }, [id, updatedAt])
  const stored = kept.get(id)
  if (stored?.updatedAt === updatedAt) return stored.outputs
  return read?.key === key ? read.outputs : null
}
