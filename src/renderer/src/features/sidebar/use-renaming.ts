import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { emitAppEvent } from '@renderer/app/events'

/**
 * Renaming a session in place. Enter and Esc hand the focus to `returnFocus` once the field is
 * gone. Rename in a menu waits for the menu to close, and keeps the menu from taking the focus
 * back, which would blur the new field at once. An item that opens New session (`onLeave`) hands
 * the focus to its composer instead.
 */
export function useRenaming(returnFocus: () => HTMLElement | null | undefined) {
  const [renaming, setRenaming] = useState(false)
  const fromMenu = useRef(false)
  const leaving = useRef(false)
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
      onLeave: () => {
        leaving.current = true
      },
      onOpenChangeComplete: (open: boolean) => {
        if (open) leaving.current = false
        else if (fromMenu.current) setRenaming(true)
        else if (leaving.current) emitAppEvent({ kind: 'focus-composer' })
      },
      finalFocus: () => !fromMenu.current && !leaving.current,
    },
    finish: (restoreFocus: boolean) => {
      fromMenu.current = false
      refocus.current = restoreFocus
      setRenaming(false)
    },
  }
}
