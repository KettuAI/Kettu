import { useCallback, useEffect, useId, useState } from 'react'
import { create } from 'zustand'

// App menus, popovers, dialogs and tooltips float above the page. Their content is a native layer
// in the side panel's browser, so the pane shows a still of the page while one would cover it; these
// are the roots that report when one opens and closes. Click-outside overlays also mark the document
// root while open so Electron window drag regions suspend and outside clicks reach the DOM.

export interface OverlayOptions {
  /**
   * Suspends window drag regions while open so clicking empty title or tab-bar space reaches the
   * DOM and dismisses the overlay instead of starting a native window drag.
   */
  dismissible?: boolean
}

interface OverlayStore {
  open: Record<string, true>
  /** Open overlays that dismiss on outside clicks and suspend window drag regions. */
  dismissible: Record<string, true>
  set(id: string, open: boolean, options?: OverlayOptions): void
}

/** Set on `document.documentElement` while at least one dismissible overlay is open. */
export const OVERLAY_OPEN_ATTR = 'data-overlay-open'

function syncDocumentOverlayOpen(active: boolean): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (active) root.setAttribute(OVERLAY_OPEN_ATTR, '')
  else root.removeAttribute(OVERLAY_OPEN_ATTR)
}

export const useOverlayStore = create<OverlayStore>()((set) => ({
  open: {},
  dismissible: {},
  set(id, open, options) {
    const wantDismissible = open && Boolean(options?.dismissible)
    set((s) => {
      const hadOpen = Boolean(s.open[id])
      const hadDismissible = Boolean(s.dismissible[id])
      if (hadOpen === open && hadDismissible === wantDismissible) return s

      const nextOpen = hadOpen === open ? s.open : { ...s.open }
      if (open) nextOpen[id] = true
      else delete nextOpen[id]

      const nextDismissible =
        hadDismissible === wantDismissible ? s.dismissible : { ...s.dismissible }
      if (wantDismissible) nextDismissible[id] = true
      else delete nextDismissible[id]

      const wasActive = Object.keys(s.dismissible).length > 0
      const isActive = Object.keys(nextDismissible).length > 0
      if (wasActive !== isActive) syncDocumentOverlayOpen(isActive)

      return { open: nextOpen, dismissible: nextDismissible }
    })
  },
}))

/** The open menus, popovers, dialogs and tooltips by id; a new object whenever one opens or closes. */
export function useOpenOverlays(): Readonly<Record<string, true>> {
  return useOverlayStore((s) => s.open)
}

/** An overlay's content carries this, so the pane can tell whether one covers it. */
export const OVERLAY_LAYER = 'data-overlay-layer'

/** Reports an overlay's open state directly when it does not wrap a Base UI Root handler. */
export function useOverlayPresence(shown: boolean, options?: OverlayOptions): void {
  const id = useId()
  const dismissible = Boolean(options?.dismissible)
  useEffect(() => {
    useOverlayStore.getState().set(id, shown, { dismissible })
    return () => useOverlayStore.getState().set(id, false)
  }, [id, shown, dismissible])
}

/** Reports a root's open state to the store, and hands Base UI a change handler of its own. */
export function useOverlayRoot<Details>(
  open: boolean | undefined,
  defaultOpen: boolean | undefined,
  onOpenChange?: (open: boolean, details: Details) => void,
  options?: OverlayOptions,
): (open: boolean, details: Details) => void {
  const [self, setSelf] = useState(open ?? defaultOpen ?? false)
  const shown = open ?? self
  useOverlayPresence(shown, options)
  return useCallback(
    (next: boolean, details: Details) => {
      onOpenChange?.(next, details)
      if (!(details as { isCanceled?: boolean } | undefined)?.isCanceled) {
        setSelf(next)
      }
    },
    [onOpenChange],
  )
}
