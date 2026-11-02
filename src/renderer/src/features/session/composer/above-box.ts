import { useCallback, useState } from 'react'

/**
 * A control-row popup's trigger ref and side offset that clear the whole composer box, `gap` px
 * above it, rather than the trigger under the box. The offset is read on each placement, so a box
 * that grew is cleared too, and it stays one function, since a new one places the popup again.
 */
export function useAboveBox(
  gap = 6,
): [setTrigger: (element: HTMLElement | null) => void, sideOffset: () => number] {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null)
  const sideOffset = useCallback(() => {
    const box = trigger?.closest('[data-composer]')?.querySelector('[data-slot=input-group]')
    if (!trigger || !box) return gap
    return trigger.getBoundingClientRect().top - box.getBoundingClientRect().top + gap
  }, [trigger, gap])
  return [setTrigger, sideOffset]
}
