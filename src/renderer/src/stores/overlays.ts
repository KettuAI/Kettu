import { useCallback, useEffect, useId, useState } from 'react'
import { create } from 'zustand'

// App menus, popovers, dialogs and tooltips float above the page. Their content is a native layer
// in the side panel's browser, so the pane shows a still of the page while one would cover it; these
// are the roots that report when one opens and closes.

interface OverlayStore {
  open: Record<string, true>
  set(id: string, open: boolean): void
}

export const useOverlayStore = create<OverlayStore>()((set) => ({
  open: {},
  set(id, open) {
    set((s) => {
      if (!!s.open[id] === open) return s
      const next = { ...s.open }
      if (open) next[id] = true
      else delete next[id]
      return { open: next }
    })
  },
}))

/** Whether any menu, popover, dialog or tooltip is open. */
export function useOverlayOpen(): boolean {
  return useOverlayStore((s) => Object.keys(s.open).length > 0)
}

/** An overlay's content carries this, so the pane can tell whether one covers it. */
export const OVERLAY_LAYER = 'data-overlay-layer'

/** Reports a root's open state to the store, and hands Base UI a change handler of its own. */
export function useOverlayRoot<Details>(
  open: boolean | undefined,
  defaultOpen: boolean | undefined,
  onOpenChange?: (open: boolean, details: Details) => void,
): (open: boolean, details: Details) => void {
  const id = useId()
  const [self, setSelf] = useState(open ?? defaultOpen ?? false)
  const shown = open ?? self
  useEffect(() => {
    useOverlayStore.getState().set(id, shown)
    return () => useOverlayStore.getState().set(id, false)
  }, [id, shown])
  return useCallback(
    (next: boolean, details: Details) => {
      setSelf(next)
      onOpenChange?.(next, details)
    },
    [onOpenChange],
  )
}
