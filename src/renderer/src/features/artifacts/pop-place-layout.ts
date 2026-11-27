// Pure geometry for artifact popover placement beside a highlight rectangle (single element or
// multi-selection union box), clamping to safe bounds, and docking cleanly when scrolled offscreen.

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Alias kept for callers that name a window-space rectangle `Box`. */
export type Box = Rect

export type OffscreenEdge = 'top' | 'bottom' | 'left' | 'right'

export type PlacementSide = 'right' | 'left' | 'bottom' | 'top' | 'center' | 'dock'

export interface PopPlacementInput {
  /** Anchor bounding rect in container-local coordinates, or null to center in the safe area. */
  anchor: Rect | null
  /**
   * Visible viewport rect of the anchor's scroll container in container-local coordinates (for
   * example the visible iframe bounds). Defaults to the full container `[0, 0, area.width, area.height]`.
   */
  clip?: Rect | null
  /** Container (`offsetParent`) dimensions in CSS pixels. */
  area: { width: number; height: number }
  /** Popover target width and measured height in CSS pixels. */
  popover: { width: number; height: number }
  /** Horizontal safe bounds avoiding side cards, in container-local coordinates. */
  safeX: { lo: number; hi: number }
  /** Narrow layout tier prefers above/below placement. */
  narrow: boolean
}

export interface PopPlacementResult {
  left: number
  top: number
  width: number
  side: PlacementSide
  /**
   * Non-null when the anchor has completely left the visible clip viewport; indicates the edge
   * where the popover is docked so the UI can offer a quick "Back to element" action.
   */
  offscreen: OffscreenEdge | null
}

export const POP_GAP = 12
export const POP_EDGE = 8
/** Vertical clearance kept below the top pill and above the bottom dock when room allows. */
const TOP_CLEAR = POP_EDGE + 44
const BOTTOM_CLEAR = 64
const MIN_POP_WIDTH = 120

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return Math.min(Math.max(value, lo), hi)
}

/** Returns the bounding rectangle enclosing every rect in `rects`, or null when empty. */
export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let left = rects[0]!.left
  let top = rects[0]!.top
  let right = rects[0]!.right
  let bottom = rects[0]!.bottom
  for (let i = 1; i < rects.length; i++) {
    const r = rects[i]!
    if (r.left < left) left = r.left
    if (r.top < top) top = r.top
    if (r.right > right) right = r.right
    if (r.bottom > bottom) bottom = r.bottom
  }
  return { left, top, right, bottom }
}

/** Returns the intersection of two rectangles, or null when they do not overlap. */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.right, b.right)
  const bottom = Math.min(a.bottom, b.bottom)
  const degenerateX = a.right === a.left && a.left >= b.left && a.left <= b.right
  const degenerateY = a.bottom === a.top && a.top >= b.top && a.top <= b.bottom
  if ((right <= left && !degenerateX) || (bottom <= top && !degenerateY)) return null
  return { left, top, right, bottom }
}

/**
 * Returns which edge of `viewport` the `anchor` has completely scrolled past, or null while any
 * part of `anchor` still intersects `viewport`.
 */
export function offscreenEdge(anchor: Rect, viewport: Rect): OffscreenEdge | null {
  const zeroW = anchor.right <= anchor.left
  const zeroH = anchor.bottom <= anchor.top
  const above = zeroH ? anchor.bottom < viewport.top : anchor.bottom <= viewport.top
  const below = zeroH ? anchor.top > viewport.bottom : anchor.top >= viewport.bottom
  const leftOf = zeroW ? anchor.right < viewport.left : anchor.right <= viewport.left
  const rightOf = zeroW ? anchor.left > viewport.right : anchor.left >= viewport.right
  if (!above && !below && !leftOf && !rightOf) return null

  const dy = above ? viewport.top - anchor.bottom : below ? anchor.top - viewport.bottom : 0
  const dx = leftOf ? viewport.left - anchor.right : rightOf ? anchor.left - viewport.right : 0
  // Vertical scrolling is primary on long pages; prefer top/bottom unless horizontal displacement dominates.
  if (above || below) {
    if ((!leftOf && !rightOf) || dy >= dx) return above ? 'top' : 'bottom'
  }
  return leftOf ? 'left' : 'right'
}

/**
 * Pure popover placement algorithm built around an anchor rectangle (single element highlight box
 * or a future multi-selection union box). Prefers placing outside the visible portion of the anchor
 * rectangle, avoids covering the middle of tall/wide blocks, and docks cleanly at the corresponding
 * visible edge when the anchor leaves the viewport completely.
 */
export function computePopPlacement(input: PopPlacementInput): PopPlacementResult {
  const { anchor, area, popover, safeX, narrow } = input
  const roomX = Math.max(0, safeX.hi - safeX.lo)
  const availWidth = Math.max(MIN_POP_WIDTH, roomX)
  const height = Math.max(0, popover.height)

  const maxTopWithDock = Math.max(POP_EDGE, area.height - height - BOTTOM_CLEAR)
  const maxTopEdge = Math.max(POP_EDGE, area.height - height - POP_EDGE)
  const minTop = Math.min(TOP_CLEAR, maxTopWithDock)

  if (!anchor) {
    const w = Math.min(popover.width, availWidth)
    return {
      left: safeX.lo + (roomX - w) / 2,
      top: Math.min(80, maxTopWithDock),
      width: w,
      side: 'center',
      offscreen: null,
    }
  }

  const areaRect: Rect = { left: 0, top: 0, right: area.width, bottom: area.height }
  const vp = input.clip ? (intersectRect(input.clip, areaRect) ?? areaRect) : areaRect
  const edge = offscreenEdge(anchor, vp)
  const isNarrow = narrow || roomX < popover.width + 2 * POP_GAP
  const w = Math.min(popover.width, availWidth)

  const clampSafeX = (x: number): number => clamp(x, safeX.lo, Math.max(safeX.lo, safeX.hi - w))

  if (edge !== null) {
    const vpFitsW = vp.right - vp.left >= w + 2 * POP_EDGE
    const centeredOnVp = clampSafeX((vp.left + vp.right - w) / 2)
    const dockMinX = vpFitsW ? clampSafeX(vp.left + POP_EDGE) : centeredOnVp
    const dockMaxX = vpFitsW
      ? Math.max(dockMinX, clampSafeX(vp.right - POP_EDGE - w))
      : centeredOnVp
    const dockMinY = Math.min(Math.max(minTop, vp.top + POP_EDGE), maxTopWithDock)
    const dockMaxY = Math.max(
      dockMinY,
      Math.min(maxTopWithDock, Math.max(POP_EDGE, vp.bottom - POP_EDGE - height)),
    )

    // Keep horizontal alignment continuous with the anchor's exterior preference when docking at top/bottom.
    const preferredHorizontal = (): number => {
      if (!isNarrow) {
        if (anchor.right + POP_GAP + w <= safeX.hi) return anchor.right + POP_GAP
        if (anchor.left - POP_GAP - w >= safeX.lo) return anchor.left - POP_GAP - w
      }
      return clamp(anchor.left, dockMinX, dockMaxX)
    }

    if (edge === 'top') {
      return {
        left: clampSafeX(preferredHorizontal()),
        top: dockMinY,
        width: w,
        side: 'dock',
        offscreen: 'top',
      }
    }
    if (edge === 'bottom') {
      return {
        left: clampSafeX(preferredHorizontal()),
        top: dockMaxY,
        width: w,
        side: 'dock',
        offscreen: 'bottom',
      }
    }
    if (edge === 'left') {
      return {
        left: clampSafeX(dockMinX),
        top: clamp(anchor.top, dockMinY, dockMaxY),
        width: w,
        side: 'dock',
        offscreen: 'left',
      }
    }
    return {
      left: clampSafeX(dockMaxX),
      top: clamp(anchor.top, dockMinY, dockMaxY),
      width: w,
      side: 'dock',
      offscreen: 'right',
    }
  }

  const visible = intersectRect(anchor, vp) ?? anchor
  const spaceBottom = Math.max(0, area.height - POP_EDGE - visible.bottom)
  const spaceTop = Math.max(0, visible.top - POP_EDGE)

  const placeAboveOrBelow = (): { top: number; side: 'bottom' | 'top' } | null => {
    const below = visible.bottom + POP_GAP
    if (below + height <= area.height - POP_EDGE) return { top: below, side: 'bottom' }
    const above = visible.top - POP_GAP - height
    if (above >= POP_EDGE) return { top: above, side: 'top' }
    return null
  }

  if (isNarrow) {
    const left = clampSafeX(visible.left)
    const vertical = placeAboveOrBelow()
    if (vertical) {
      return { left, top: vertical.top, width: w, side: vertical.side, offscreen: null }
    }
    const top = spaceTop > spaceBottom ? POP_EDGE : Math.min(maxTopWithDock, maxTopEdge)
    return { left, top, width: w, side: spaceTop > spaceBottom ? 'top' : 'bottom', offscreen: null }
  }

  const sideTop = clamp(visible.top, minTop, maxTopWithDock)
  // 1. Prefer right outside the visible highlight box.
  if (visible.right + POP_GAP + w <= safeX.hi) {
    return { left: visible.right + POP_GAP, top: sideTop, width: w, side: 'right', offscreen: null }
  }
  // 2. Next prefer left outside the visible highlight box.
  if (visible.left - POP_GAP - w >= safeX.lo) {
    return {
      left: visible.left - POP_GAP - w,
      top: sideTop,
      width: w,
      side: 'left',
      offscreen: null,
    }
  }
  // 3. Full-width element: prefer cleanly below or above its visible portion.
  const vertical = placeAboveOrBelow()
  if (vertical) {
    return {
      left: clampSafeX(visible.left),
      top: vertical.top,
      width: w,
      side: vertical.side,
      offscreen: null,
    }
  }
  // 4. Both full-width and taller than the viewport: hug the clearer edge away from reading center.
  const spaceLeft = visible.left - safeX.lo
  const spaceRight = safeX.hi - visible.right
  const left = spaceLeft > spaceRight + 24 ? safeX.lo : Math.max(safeX.lo, safeX.hi - w)
  const top =
    spaceBottom >= spaceTop ? clamp(visible.bottom - height, minTop, maxTopWithDock) : minTop
  return { left, top, width: w, side: spaceBottom >= spaceTop ? 'bottom' : 'top', offscreen: null }
}

/** A box around a point, for a popover beside where a click landed. */
export function pointBox(point: { x: number; y: number }, size = 12): Rect {
  return {
    left: point.x - size,
    top: point.y - size,
    right: point.x + size,
    bottom: point.y + size,
  }
}
