import { useState } from 'react'
import type { ArtifactChanges } from '@shared/artifact-changes'
import { useChanges } from '@renderer/features/session/entries/artifact-changes'
import { changeCount } from './change-words'

/**
 * A version that arrived while the viewer was open: what it changed from the one before, for the
 * pill over a web page, until dismissed or another arrives.
 */
export function useArrivedChange(
  id: string,
  head: number | null,
  enabled: boolean,
): {
  from: number
  to: number
  changes: ArtifactChanges
  dismiss: () => void
} | null {
  const [seen, setSeen] = useState({ id, head })
  const [arrived, setArrived] = useState<{ from: number; to: number } | null>(null)
  if (seen.id !== id || seen.head !== head) {
    const grew = seen.id === id && seen.head !== null && head !== null && head > seen.head
    setArrived(grew ? { from: head - 1, to: head } : seen.id !== id ? null : arrived)
    setSeen({ id, head })
  }
  const changes = useChanges(id, arrived?.from ?? null, arrived?.to ?? null, enabled && !!arrived)
  if (!enabled || !arrived || !changes || changeCount(changes).count === 0) return null
  return { ...arrived, changes, dismiss: () => setArrived(null) }
}
