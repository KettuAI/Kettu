// The artifacts with a change on screen that did not save, so the viewer's own ways out ask first.

import { useEffect } from 'react'
import { i18n } from '@renderer/lib/i18n'

const unsaved = new Map<string, number>()

/** Counts the artifact as holding an unsaved change while `failed`. */
export function useUnsaved(id: string, failed: boolean): void {
  useEffect(() => {
    if (!failed) return
    unsaved.set(id, (unsaved.get(id) ?? 0) + 1)
    return () => {
      const left = (unsaved.get(id) ?? 1) - 1
      if (left > 0) unsaved.set(id, left)
      else unsaved.delete(id)
    }
  }, [id, failed])
}

/** Whether to leave the artifact: at once, or once the user agrees to drop what did not save. */
export function mayLeave(id: string): boolean {
  if (!unsaved.has(id)) return true
  return window.confirm(i18n.t('artifacts:viewer.leaveUnsaved'))
}
