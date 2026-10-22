import { useEffect, useEffectEvent, useRef, useState } from 'react'

/**
 * Renaming a session in place. Enter and Esc hand the focus to `returnFocus` once the field is
 * gone. Rename in a menu waits for the menu to close, and keeps the menu from taking the focus
 * back, which would blur the new field at once.
 */
export function useRenaming(returnFocus: () => HTMLElement | null | undefined) {
  const [renaming, setRenaming] = useState(false)
  const fromMenu = useRef(false)
  const refocus = useRef(false)
  const focusBack = useEffectEvent(() => returnFocus()?.focus())

  useEffect(() => {
    if (renaming || !refocus.current) return
    refocus.current = false
    focusBack()
  }, [renaming])

  return {
    renaming,
    start: () => setRenaming(true),
    /** Spread `onOpenChangeComplete` on the menu's root and `finalFocus` on its content. */
    menu: {
      onRename: () => {
        fromMenu.current = true
      },
      onOpenChangeComplete: (open: boolean) => {
        if (!open && fromMenu.current) setRenaming(true)
      },
      finalFocus: () => !fromMenu.current,
    },
    finish: (restoreFocus: boolean) => {
      fromMenu.current = false
      refocus.current = restoreFocus
      setRenaming(false)
    },
  }
}
