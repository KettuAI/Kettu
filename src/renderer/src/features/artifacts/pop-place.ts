// Where a popover opens beside what it is about, how it repositions during scroll, and the key
// that sends from it.

import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { isMod } from '@renderer/lib/platform'
import {
  computePopPlacement,
  POP_EDGE,
  pointBox,
  unionRects,
  intersectRect,
  offscreenEdge,
  type Box,
  type OffscreenEdge,
  type PlacementSide,
  type PopPlacementInput,
  type PopPlacementResult,
  type Rect,
} from './pop-place-layout'
import { useShell } from './viewer-shell-context'

export {
  computePopPlacement,
  intersectRect,
  offscreenEdge,
  pointBox,
  unionRects,
  type Box,
  type OffscreenEdge,
  type PlacementSide,
  type PopPlacementInput,
  type PopPlacementResult,
  type Rect,
}

/** Live anchor source that pushes scroll/resize updates without forcing parent re-renders. */
export interface LiveAnchor {
  get: () => { box: Rect | null; clip: Rect | null } | null
  subscribe: (listener: () => void) => () => void
  onHostLayout?: () => void
}

/**
 * Places `popover` beside `at` (or dynamically beside `live` when tracking scroll inside an iframe),
 * or in the area's middle without one. Writes geometry directly to the DOM element and marks it
 * `data-placed`; returns the current `offscreen` edge only when it transitions so scrolling stays
 * free of React re-renders.
 */
export function usePopPlace(
  popover: RefObject<HTMLElement | null>,
  at: Rect | null,
  width: number,
  /** Off where the popover is laid out by what holds it. */
  enabled = true,
  options?: {
    clip?: Rect | null
    live?: LiveAnchor | null
  },
): OffscreenEdge | null {
  const { tier, targets } = useShell()
  const clip = options?.clip ?? null
  const live = options?.live ?? null
  const [offscreen, setOffscreen] = useState<OffscreenEdge | null>(null)
  const offscreenRef = useRef<OffscreenEdge | null>(null)
  const key = at ? `${at.left},${at.top},${at.right},${at.bottom}` : ''
  const clipKey = clip ? `${clip.left},${clip.top},${clip.right},${clip.bottom}` : ''

  useLayoutEffect(() => {
    if (!enabled) {
      if (offscreenRef.current !== null) {
        offscreenRef.current = null
        setOffscreen(null)
      }
      return
    }
    const el = popover.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return

    const update = (): void => {
      const area = parent.getBoundingClientRect()
      if (area.width <= 0 || area.height <= 0) return
      const height = el.offsetHeight
      // The cards may lie over the area, as over a canvas, or beside it, as beside a page.
      const leftCard = targets.left?.getBoundingClientRect()
      const rightCard = targets.right?.getBoundingClientRect()
      const lo =
        POP_EDGE + (leftCard && leftCard.width > 0 ? Math.max(0, leftCard.right - area.left) : 0)
      const hi =
        area.width -
        POP_EDGE -
        (rightCard && rightCard.width > 0 ? Math.max(0, area.right - rightCard.left) : 0)

      const liveState = live?.get() ?? null
      const activeBox = liveState?.box ?? at
      const activeClip = liveState?.clip ?? clip

      const localAnchor = activeBox
        ? {
            left: activeBox.left - area.left,
            right: activeBox.right - area.left,
            top: activeBox.top - area.top,
            bottom: activeBox.bottom - area.top,
          }
        : null
      const localClip = activeClip
        ? {
            left: activeClip.left - area.left,
            right: activeClip.right - area.left,
            top: activeClip.top - area.top,
            bottom: activeClip.bottom - area.top,
          }
        : null

      const placed = computePopPlacement({
        anchor: localAnchor,
        clip: localClip,
        area: { width: area.width, height: area.height },
        popover: { width, height },
        safeX: { lo, hi },
        narrow: tier === 'narrow',
      })
      place(el, placed.left, placed.top, placed.width)
      if (placed.offscreen !== offscreenRef.current) {
        offscreenRef.current = placed.offscreen
        setOffscreen(placed.offscreen)
      }
    }

    update()

    let raf = 0
    const schedule = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        live?.onHostLayout?.()
        update()
      })
    }

    const unsubscribe = live ? live.subscribe(update) : null
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => schedule()) : null
    resizeObserver?.observe(el)
    resizeObserver?.observe(parent)
    window.addEventListener('resize', schedule, { passive: true })
    window.addEventListener('scroll', schedule, { capture: true, passive: true })

    return () => {
      if (raf) cancelAnimationFrame(raf)
      unsubscribe?.()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
    // `key` and `clipKey` capture static box coordinates; `live` drives dynamic updates directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, clipKey, live, tier, targets.left, targets.right, width, enabled])

  return enabled ? offscreen : null
}

function place(el: HTMLElement, left: number, top: number, width: number): void {
  el.style.setProperty('left', `${left}px`)
  el.style.setProperty('top', `${top}px`)
  el.style.setProperty('width', `${width}px`)
  el.setAttribute('data-placed', '')
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
