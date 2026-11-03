import { useCallback, useState } from 'react'

/**
 * How far above its trigger a control-row popup sits so its bottom edge lands on the input box's
 * bottom and the popup covers the box. A trigger that is not below the box keeps `gap`.
 */
export function coverBoxOffset(triggerTop: number, boxBottom: number, gap: number): number {
  const offset = triggerTop - boxBottom
  return offset >= 0 ? offset : gap
}

/**
 * A control-row popup's trigger ref and side offset that cover the composer box, the popup's
 * bottom edge on the box's bottom, rather than floating above the box and leaving it blank. The
 * offset is read on each placement, so a box that grew is covered too, and it stays one function,
 * since a new one places the popup again.
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
      return coverBoxOffset(
        trigger.getBoundingClientRect().top,
        box.getBoundingClientRect().bottom,
        gap,
      )
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
