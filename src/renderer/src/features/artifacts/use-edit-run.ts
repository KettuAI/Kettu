import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, host } from '@renderer/lib/host'
import type { SaveState } from './tool-parts'
import { useUnsaved } from './unsaved'

/**
 * A run of the user's own saves from one card: what the chip says, and Undo, which writes the
 * version before the run again as the newest one, so nothing in between is lost.
 */
export function useEditRun(
  id: string,
  /** What the chip says from the start: a change kept from before that did not save. */
  initial: SaveState | null = null,
): {
  save: SaveState | null
  /** A change waits to be written, or is on its way. */
  pending: () => void
  /** A save wrote `version` over `base`. */
  wrote: (version: number, base: number) => void
  failed: (reason: unknown) => void
  /** Clears what the chip says, as nothing waits any more. */
  settle: () => void
  /** Clears a failure, as its change is no longer there to save. */
  dismiss: () => void
  /** Undo, while the run has a save to take back. */
  undo: (() => Promise<number | null>) | null
} {
  const [save, setSave] = useState<SaveState | null>(initial)
  useUnsaved(id, save?.state === 'failed')
  const run = useRef<{ base: number; head: number; edits: number } | null>(null)
  const [undoable, setUndoable] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const pending = useCallback(() => setSave({ state: 'pending' }), [])
  const wrote = useCallback((version: number, base: number) => {
    const now = run.current
    run.current = now
      ? { ...now, head: version, edits: now.edits + 1 }
      : { base, head: version, edits: 1 }
    if (!live.current) return
    setUndoable(true)
    setSave({ state: 'saved', version, edits: run.current.edits })
  }, [])
  const failed = useCallback((reason: unknown) => {
    if (live.current) setSave({ state: 'failed', error: errorMessage(reason) })
  }, [])
  const settle = useCallback(() => setSave((was) => (was?.state === 'pending' ? null : was)), [])
  const dismiss = useCallback(() => setSave((was) => (was?.state === 'failed' ? null : was)), [])
  const undo = useCallback(async (): Promise<number | null> => {
    const now = run.current
    if (!now) return null
    const { version } = await host('artifacts.restoreVersion', {
      id,
      version: now.base,
      baseVersion: now.head,
    })
    run.current = null
    if (live.current) {
      setUndoable(false)
      setSave({ state: 'undone', version })
    }
    return version
  }, [id])

  return { save, pending, wrote, failed, settle, dismiss, undo: undoable ? undo : null }
}
