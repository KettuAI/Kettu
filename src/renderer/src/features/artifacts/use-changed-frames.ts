import { useEffect, useState } from 'react'
import { host } from '@renderer/lib/host'

const NONE: ReadonlySet<string> = new Set()

/**
 * The frames of a canvas that count as changed, by id: those `version` changed against `since`,
 * by default the version before it. A host without the comparison, or a version that changed no
 * frame, gives none.
 */
export function useChangedFrames(
  id: string,
  version: number | null,
  since: number | null = null,
): ReadonlySet<string> {
  const from = since ?? (version !== null ? version - 1 : null)
  const [changed, setChanged] = useState<{ key: string; ids: ReadonlySet<string> } | null>(null)
  const key = `${id}:${from}:${version}`
  useEffect(() => {
    if (version === null || from === null || from < 1 || from === version) return
    let live = true
    host('artifacts.changes', { id, from, to: version }).then(
      ({ changes }) => {
        if (!live) return
        const ids = changes?.kind === 'frames' ? new Set(changes.frames.map((f) => f.id)) : NONE
        setChanged({ key, ids })
      },
      () => {
        if (live) setChanged({ key, ids: NONE })
      },
    )
    return () => {
      live = false
    }
  }, [id, from, version, key])
  return changed?.key === key ? changed.ids : NONE
}
