// Where a popover opens beside what it is about, and the key that sends from it.

import { useLayoutEffect, type RefObject } from 'react'
import { isMod } from '@renderer/lib/platform'
import { useShell } from './viewer-shell-context'

type Box = { left: number; top: number; right: number; bottom: number }

const GAP = 12
const EDGE = 8

/**
 * Places `popover` beside `at`, a box or a point in the window, or in the area's middle without one: on its right where there is room,
 * else its left, top aligned with it; narrow, under it or else over it, across the area. Measured
 * against the area it lies in after it rendered, and written to it directly; it is marked
 * `data-placed` once placed, and stays hidden until then.
 */
export function usePopPlace(
  popover: RefObject<HTMLElement | null>,
  at: Box | null,
  width: number,
  /** Off where the popover is laid out by what holds it. */
  enabled = true,
): void {
  const { tier, targets } = useShell()
  const key = at ? `${at.left},${at.top},${at.right},${at.bottom}` : ''
  useLayoutEffect(() => {
    if (!enabled) return
    const el = popover.current
    const area = el?.offsetParent?.getBoundingClientRect()
    if (!el || !area) return
    const height = el.offsetHeight
    // The cards may lie over the area, as over a canvas, or beside it, as beside a page.
    const leftCard = targets.left?.getBoundingClientRect()
    const rightCard = targets.right?.getBoundingClientRect()
    const lo = EDGE + (leftCard && leftCard.width > 0 ? Math.max(0, leftCard.right - area.left) : 0)
    const hi =
      area.width -
      EDGE -
      (rightCard && rightCard.width > 0 ? Math.max(0, area.right - rightCard.left) : 0)
    if (!at) {
      const w = Math.min(width, hi - lo)
      place(el, lo + (hi - lo - w) / 2, Math.min(80, Math.max(EDGE, area.height - height - 64)), w)
      return
    }
    const box = {
      left: at.left - area.left,
      right: at.right - area.left,
      top: at.top - area.top,
      bottom: at.bottom - area.top,
    }
    const aboveOrBelow = () => {
      const below = box.bottom + GAP
      return below + height <= area.height - EDGE ? below : Math.max(EDGE, box.top - GAP - height)
    }
    let left: number
    let top: number
    let w = width
    if (tier === 'narrow' || hi - lo < width + 2 * GAP) {
      w = Math.min(width, hi - lo)
      left = Math.min(Math.max(lo, box.left), hi - w)
      top = aboveOrBelow()
    } else {
      top = Math.min(Math.max(EDGE + 44, box.top), Math.max(EDGE, area.height - height - 64))
      if (box.right + GAP + width <= hi) left = box.right + GAP
      else if (box.left - GAP - width >= lo) left = box.left - GAP - width
      else {
        left = Math.min(Math.max(lo, box.left), hi - width)
        top = aboveOrBelow()
      }
    }
    place(el, left, top, w)
    // `key` names the box; the cards and the tier move it too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tier, targets.left, targets.right, width, enabled])
}

function place(el: HTMLElement, left: number, top: number, width: number): void {
  el.style.setProperty('left', `${left}px`)
  el.style.setProperty('top', `${top}px`)
  el.style.setProperty('width', `${width}px`)
  el.setAttribute('data-placed', '')
}

/** A box around a point, for a popover beside where a click landed. */
export function pointBox(point: { x: number; y: number }, size = 12): Box {
  return {
    left: point.x - size,
    top: point.y - size,
    right: point.x + size,
    bottom: point.y + size,
  }
}

/** Mod+Enter, outside an IME's composition. */
export function sendKey(event: React.KeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    isMod(event.nativeEvent) &&
    !event.nativeEvent.isComposing &&
    event.keyCode !== 229
  )
}
