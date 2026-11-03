import { useCallback, useState } from 'react'

/**
 * A control-row popup's trigger ref and side offset that clear the whole composer box, `gap` px
 * above it, rather than the trigger under the box. The offset is read on each placement, so a box
 * that grew is cleared too, and it stays one function, since a new one places the popup again.
 */
export function useAboveBox(
  gap = 6,
): [
  setTrigger: (element: HTMLElement | null) => void,
  sideOffset: (data: { side: string }) => number,
] {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null)
  const sideOffset = useCallback(
    // A popup that flipped below or beside its trigger, short of room above, sits by it instead.
    ({ side }: { side: string }) => {
      const box = trigger?.closest('[data-composer]')?.querySelector('[data-slot=input-group]')
      if (side !== 'top' || !trigger || !box) return gap
      return trigger.getBoundingClientRect().top - box.getBoundingClientRect().top + gap
    },
    [trigger, gap],
  )
  return [setTrigger, sideOffset]
}

/**
 * For a popup from inside a composer box that has the page below it, as New session's: its
 * trigger ref, and offsets that drop it `gap` px under the box with its start at the box's start,
 * so it covers neither the text nor the pickers.
 */
export function useBelowBox(
  gap = 6,
): [
  setTrigger: (element: HTMLElement | null) => void,
  sideOffset: (data: { side: string }) => number,
  alignOffset: (data: { side: string }) => number,
] {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null)
  const sideOffset = useCallback(
    ({ side }: { side: string }) => {
      const box = trigger?.closest('[data-slot=input-group]')
      if (side !== 'bottom' || !trigger || !box) return gap
      return box.getBoundingClientRect().bottom - trigger.getBoundingClientRect().bottom + gap
    },
    [trigger, gap],
  )
  const alignOffset = useCallback(
    ({ side }: { side: string }) => {
      const box = trigger?.closest('[data-slot=input-group]')
      if (side !== 'bottom' || !trigger || !box) return 0
      return box.getBoundingClientRect().left - trigger.getBoundingClientRect().left
    },
    [trigger],
  )
  return [setTrigger, sideOffset, alignOffset]
}
