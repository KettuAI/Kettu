// Where focus goes when a git dialog closes. Dialogs are mounted once for the window, and the
// button that opened one, in the branch popover or a toast, is often gone by then.

import { useEffect, type RefObject } from 'react'
import { gitDialogOpener } from '@renderer/stores/git'

const chips = new Map<string, RefObject<HTMLElement | null>>()

/** Offers a project's branch chip as the place to return to once a dialog's opener is gone. */
export function useDialogReturn(projectPath: string, chip: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    chips.set(projectPath, chip)
    return () => {
      if (chips.get(projectPath) === chip) chips.delete(projectPath)
    }
  }, [projectPath, chip])
}

/** The opener while it is still on the page, else the branch chip, else the dialog's default. */
export function dialogReturn(projectPath: string): HTMLElement | true {
  const opener = gitDialogOpener(projectPath)
  if (opener instanceof HTMLElement && opener.isConnected) return opener
  return chips.get(projectPath)?.current ?? true
}
