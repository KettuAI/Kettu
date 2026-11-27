// Vertical and horizontal placement math for affectUI popovers and dropdown menus.
// Keeps popovers strictly inside their clipping container (scroll area / modal / viewport),
// chooses the side with the most vertical room when content exceeds both sides, and reports
// the maximum available height so menus scroll smoothly instead of overflowing.

export interface PopoverRect {
  top: number
  right: number
  bottom: number
  left: number
}

export type AffectPopoverSide = 'bottom' | 'top' | 'right'
export type AffectPopoverAlign = 'start' | 'end'

/** Gap between the anchor edge and a top/bottom popover matching `.ui-as-popover` CSS (`6px`). */
export const POPOVER_GAP = 6

/** Horizontal gap when `side="right"` matching `.ui-as-popover[data-side="right"]` (`12px`). */
export const POPOVER_RIGHT_GAP = 12

/** Minimum padding kept between a popover and its clipping container edges (`8px`). */
export const POPOVER_MARGIN = 8

const CLIP_OVERFLOW = /(auto|scroll|hidden|clip)/

/**
 * Walks up from `el.parentElement` to find the nearest box-generating ancestor for layout
 * measurement, skipping `display: contents` wrappers whose `getBoundingClientRect()` returns an
 * all-zero rect.
 */
export function resolvePopoverAnchor(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).display !== 'contents') return node
  }
  return null
}

/**
 * Collects every box-generating ancestor that clips or bounds `el` along either axis.
 * Ancestors with `display: contents` generate no box and are skipped.
 */
export function resolvePopoverClipAncestors(el: HTMLElement): HTMLElement[] {
  const ancestors: HTMLElement[] = []
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) continue
    const style = getComputedStyle(node)
    if (style.display === 'contents') continue
    const isShell = node.classList.contains('ui-as')
    const clipX = isShell || CLIP_OVERFLOW.test(style.overflowX || style.overflow)
    const clipY = isShell || CLIP_OVERFLOW.test(style.overflowY || style.overflow)
    if (clipX || clipY) ancestors.push(node)
  }
  return ancestors
}

/**
 * Computes the intersection of the viewport and every box-generating ancestor that clips or bounds
 * `el`. Ancestors with `display: contents` generate no box and are skipped so an `overflow` style
 * on them never collapses the clip box to 0×0.
 */
export function resolvePopoverClipBox(el: HTMLElement): PopoverRect {
  let box: PopoverRect = { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 }
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) continue
    const style = getComputedStyle(node)
    if (style.display === 'contents') continue
    const isShell = node.classList.contains('ui-as')
    const clipX = isShell || CLIP_OVERFLOW.test(style.overflowX || style.overflow)
    const clipY = isShell || CLIP_OVERFLOW.test(style.overflowY || style.overflow)
    if (clipX || clipY) {
      box = intersectClipAxes(box, node.getBoundingClientRect(), clipX, clipY)
    }
  }
  return box
}

/**
 * Computes the maximum popover width in CSS pixels that fits inside `clip` with `margin` padding
 * on both sides, or `null` if `clip` has zero width.
 */
export function resolvePopoverMaxWidth(
  clip: PopoverRect,
  scaleX = 1,
  margin = POPOVER_MARGIN,
): number | null {
  const clipW = clip.right - clip.left
  if (clipW <= 0) return null
  const sx = scaleX > 0 && Number.isFinite(scaleX) ? scaleX : 1
  const marginPx = Math.min(margin * sx, clipW / 2)
  return Math.max(0, Math.floor((clipW - marginPx * 2) / sx))
}

export interface PopoverLayoutInput {
  preferredSide: AffectPopoverSide
  preferredAlign: AffectPopoverAlign
  anchor: PopoverRect
  clip: PopoverRect
  /** Natural unconstrained width in the popover's CSS pixel space. */
  contentWidth: number
  /** Natural unconstrained height in the popover's CSS pixel space. */
  contentHeight: number
  /** Viewport-to-CSS-pixel horizontal scale factor (defaults to 1). */
  scaleX?: number
  /** Viewport-to-CSS-pixel vertical scale factor (defaults to 1). */
  scaleY?: number
  gap?: number
  rightGap?: number
  margin?: number
}

export interface PopoverLayout {
  side: AffectPopoverSide
  align: AffectPopoverAlign
  /** Available vertical height in CSS pixels for the chosen side, or null if clip is empty. */
  maxHeight: number | null
  /** Whether the natural content height exceeds `maxHeight` and requires scrolling. */
  overflow: boolean
  /** Horizontal translation in CSS pixels to keep the popover inside `clip`. */
  dx: number
  /** Vertical translation in CSS pixels (non-zero only for edge clamping or `side="right"`). */
  dy: number
}

function cleanOffset(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) < 0.01) return 0
  return Math.round(value * 100) / 100
}

/**
 * Intersects `current` with `candidate` independently along the horizontal and vertical axes,
 * matching ancestors that clip only X, only Y, or both.
 */
export function intersectClipAxes(
  current: PopoverRect,
  candidate: PopoverRect,
  clipX: boolean,
  clipY: boolean,
): PopoverRect {
  const left = clipX ? Math.max(current.left, candidate.left) : current.left
  const right = clipX ? Math.max(left, Math.min(current.right, candidate.right)) : current.right
  const top = clipY ? Math.max(current.top, candidate.top) : current.top
  const bottom = clipY ? Math.max(top, Math.min(current.bottom, candidate.bottom)) : current.bottom
  return { top, right, bottom, left }
}

/**
 * Resolves horizontal alignment (`start` vs `end`) and any residual `dx` shift (in CSS pixels)
 * required to keep a popover of `contentWidth` inside `clip`.
 */
export function resolveHorizontalPlacement({
  preferredAlign,
  side,
  anchor,
  clip,
  contentWidth,
  scaleX = 1,
  rightGap = POPOVER_RIGHT_GAP,
  margin = POPOVER_MARGIN,
}: {
  preferredAlign: AffectPopoverAlign
  side: AffectPopoverSide
  anchor: PopoverRect
  clip: PopoverRect
  contentWidth: number
  scaleX?: number
  rightGap?: number
  margin?: number
}): { align: AffectPopoverAlign; dx: number } {
  const clipW = clip.right - clip.left
  if (clipW <= 0) return { align: preferredAlign, dx: 0 }

  const sx = scaleX > 0 && Number.isFinite(scaleX) ? scaleX : 1
  const marginPx = Math.min(margin * sx, clipW / 2)
  const usableLeft = clip.left + marginPx
  const usableRight = clip.right - marginPx
  const widthPx = Math.max(0, contentWidth) * sx

  if (side === 'right') {
    const left = anchor.right + rightGap * sx
    const right = left + widthPx
    let dxPx = 0
    if (right > usableRight) dxPx = usableRight - right
    if (left + dxPx < usableLeft) dxPx = usableLeft - left
    return { align: preferredAlign, dx: cleanOffset(dxPx / sx) }
  }

  const startLeft = anchor.left
  const startRight = anchor.left + widthPx
  const endRight = anchor.right
  const endLeft = anchor.right - widthPx

  const startOverflow = Math.max(0, startRight - usableRight) + Math.max(0, usableLeft - startLeft)
  const endOverflow = Math.max(0, endRight - usableRight) + Math.max(0, usableLeft - endLeft)

  let align: AffectPopoverAlign = preferredAlign
  if (preferredAlign === 'start' && startRight > usableRight && endOverflow < startOverflow) {
    align = 'end'
  } else if (preferredAlign === 'end' && endLeft < usableLeft && startOverflow < endOverflow) {
    align = 'start'
  }

  const left = align === 'start' ? startLeft : endLeft
  const right = align === 'start' ? startRight : endRight
  let dxPx = 0
  if (right > usableRight) dxPx = usableRight - right
  if (left + dxPx < usableLeft) dxPx = usableLeft - left
  return { align, dx: cleanOffset(dxPx / sx) }
}

/**
 * Computes side, alignment, vertical max-height constraint, overflow flag, and translation offsets
 * for an `affectUI` `Popover` inside its clipping box.
 */
export function resolvePopoverLayout({
  preferredSide,
  preferredAlign,
  anchor,
  clip,
  contentWidth,
  contentHeight,
  scaleX = 1,
  scaleY = 1,
  gap = POPOVER_GAP,
  rightGap = POPOVER_RIGHT_GAP,
  margin = POPOVER_MARGIN,
}: PopoverLayoutInput): PopoverLayout {
  const clipW = clip.right - clip.left
  const clipH = clip.bottom - clip.top
  if (clipW <= 0 || clipH <= 0) {
    return {
      side: preferredSide,
      align: preferredAlign,
      maxHeight: null,
      overflow: false,
      dx: 0,
      dy: 0,
    }
  }

  const sx = scaleX > 0 && Number.isFinite(scaleX) ? scaleX : 1
  const sy = scaleY > 0 && Number.isFinite(scaleY) ? scaleY : 1
  const marginY = Math.min(margin * sy, clipH / 2)
  const usableTop = clip.top + marginY
  const usableBottom = clip.bottom - marginY
  const needH = Math.ceil(Math.max(0, contentHeight))

  let side: AffectPopoverSide = preferredSide
  let maxHeight: number
  let overflow: boolean
  let dy = 0

  if (preferredSide === 'right') {
    const usableHeight = Math.max(0, (usableBottom - usableTop) / sy)
    const clampedBottom = Math.min(anchor.bottom, usableBottom)
    const naturalAbove = Math.max(0, (clampedBottom - usableTop) / sy)
    if (needH <= Math.floor(naturalAbove)) {
      maxHeight = Math.floor(naturalAbove)
      overflow = false
      dy = clampedBottom < anchor.bottom ? cleanOffset((clampedBottom - anchor.bottom) / sy) : 0
    } else {
      const targetBottom = Math.min(usableBottom, usableTop + needH * sy)
      dy = cleanOffset((targetBottom - anchor.bottom) / sy)
      maxHeight = Math.floor(usableHeight)
      overflow = needH > maxHeight
    }
  } else {
    const gapPx = gap * sy
    const belowTop = Math.max(anchor.bottom + gapPx, usableTop)
    const spaceBelow = Math.max(0, (usableBottom - belowTop) / sy)
    const aboveBottom = Math.min(anchor.top - gapPx, usableBottom)
    const spaceAbove = Math.max(0, (aboveBottom - usableTop) / sy)

    const prefSpace = preferredSide === 'bottom' ? spaceBelow : spaceAbove
    const oppSide: AffectPopoverSide = preferredSide === 'bottom' ? 'top' : 'bottom'
    const oppSpace = preferredSide === 'bottom' ? spaceAbove : spaceBelow

    if (needH <= Math.floor(prefSpace)) {
      side = preferredSide
    } else if (needH <= Math.floor(oppSpace)) {
      side = oppSide
    } else if (oppSpace > prefSpace) {
      side = oppSide
    } else {
      side = preferredSide
    }

    const chosenSpace = side === 'bottom' ? spaceBelow : spaceAbove
    maxHeight = Math.floor(chosenSpace)
    overflow = needH > maxHeight

    if (side === 'bottom') {
      const naturalTop = anchor.bottom + gapPx
      if (naturalTop < usableTop) dy = cleanOffset((usableTop - naturalTop) / sy)
    } else {
      const naturalBottom = anchor.top - gapPx
      if (naturalBottom > usableBottom) dy = cleanOffset((usableBottom - naturalBottom) / sy)
    }
  }

  const { align, dx } = resolveHorizontalPlacement({
    preferredAlign,
    side,
    anchor,
    clip,
    contentWidth,
    scaleX: sx,
    rightGap,
    margin,
  })

  return { side, align, maxHeight, overflow, dx, dy }
}

/**
 * Measures an `affectUI` `Popover` element against its box-generating positioning anchor and clip
 * box, applies placement attributes/styles (`data-side`, `data-align`, `--as-popover-max-h`,
 * `data-overflow`, `translate`), and preserves inner scroll positions across re-measurements.
 */
export function applyPopoverLayout(
  el: HTMLElement,
  preferredSide: AffectPopoverSide,
  preferredAlign: AffectPopoverAlign,
): PopoverLayout | null {
  const anchor = resolvePopoverAnchor(el)
  if (!anchor) return null

  const list = el.querySelector<HTMLElement>(':scope > .ui-as-menu__list')
  const card = el.querySelector<HTMLElement>('.ui-pmc__card')
  const savedListScroll = list?.scrollTop ?? 0
  const savedCardScroll = card?.scrollTop ?? 0
  const savedElScroll = el.scrollTop

  el.dataset.side = preferredSide
  el.dataset.align = preferredAlign
  el.style.translate = ''
  el.style.removeProperty('--as-popover-max-h')
  el.removeAttribute('data-overflow')

  const box = resolvePopoverClipBox(el)
  const anchorRect = anchor.getBoundingClientRect()
  const scaleX = anchor.offsetWidth > 0 ? anchorRect.width / anchor.offsetWidth : 1
  const scaleY = anchor.offsetHeight > 0 ? anchorRect.height / anchor.offsetHeight : 1
  const elRect = el.getBoundingClientRect()
  const contentWidth = el.offsetWidth || (scaleX > 0 ? elRect.width / scaleX : elRect.width)
  const contentHeight = el.offsetHeight || (scaleY > 0 ? elRect.height / scaleY : elRect.height)

  const layout = resolvePopoverLayout({
    preferredSide,
    preferredAlign,
    anchor: anchorRect,
    clip: box,
    contentWidth,
    contentHeight,
    scaleX,
    scaleY,
  })

  el.dataset.side = layout.side
  el.dataset.align = layout.align
  if (layout.maxHeight !== null) {
    el.style.setProperty('--as-popover-max-h', `${layout.maxHeight}px`)
  }
  el.toggleAttribute('data-overflow', layout.overflow)

  // Classic scrollbars can slightly widen a constrained menu; re-check horizontal offset after clamping.
  let dx = layout.dx
  if (layout.overflow) {
    const constrainedWidth = el.offsetWidth || contentWidth
    if (Math.abs(constrainedWidth - contentWidth) > 0.5) {
      dx = resolveHorizontalPlacement({
        preferredAlign: layout.align,
        side: layout.side,
        anchor: anchorRect,
        clip: box,
        contentWidth: constrainedWidth,
        scaleX,
      }).dx
    }
  }

  if (dx || layout.dy) {
    el.style.translate = `${dx}px ${layout.dy}px`
  }

  if (list && savedListScroll > 0) list.scrollTop = savedListScroll
  if (card && savedCardScroll > 0) card.scrollTop = savedCardScroll
  if (savedElScroll > 0) el.scrollTop = savedElScroll

  return layout
}

/**
 * Measures a `DateRangePicker` dialog panel (`.ui-drpc__panel`) against its anchor and clipping
 * container, constrains its width via `--ui-drpc-panel-max-w` so narrow panes drop cleanly to the
 * single-month layout before overflowing, and applies horizontal/vertical flip, edge clamping, and
 * max-height constraints.
 */
export function applyDateRangePanelLayout(
  el: HTMLElement,
  preferredAlign: AffectPopoverAlign,
): PopoverLayout | null {
  const anchor = resolvePopoverAnchor(el)
  if (!anchor) return null

  const clipEl = el.querySelector<HTMLElement>(':scope > .ui-drpc__clip')
  const savedScroll = clipEl?.scrollTop ?? 0

  el.dataset.side = 'bottom'
  el.dataset.align = preferredAlign
  el.style.left = ''
  el.style.right = ''
  el.style.translate = ''
  el.style.removeProperty('--ui-drpc-panel-max-w')
  el.style.removeProperty('--ui-drpc-panel-max-h')
  el.removeAttribute('data-overflow')

  const box = resolvePopoverClipBox(el)
  const anchorRect = anchor.getBoundingClientRect()
  const scaleX = anchor.offsetWidth > 0 ? anchorRect.width / anchor.offsetWidth : 1
  const scaleY = anchor.offsetHeight > 0 ? anchorRect.height / anchor.offsetHeight : 1

  // Cap panel width to the clipping container before reading natural dimensions so the panel's
  // narrow single-month container query resolves before horizontal and vertical placement.
  const maxWidth = resolvePopoverMaxWidth(box, scaleX)
  if (maxWidth !== null && maxWidth > 0) {
    el.style.setProperty('--ui-drpc-panel-max-w', `${maxWidth}px`)
  }

  const elRect = el.getBoundingClientRect()
  const contentWidth = el.offsetWidth || (scaleX > 0 ? elRect.width / scaleX : elRect.width)
  const contentHeight = el.offsetHeight || (scaleY > 0 ? elRect.height / scaleY : elRect.height)

  const layout = resolvePopoverLayout({
    preferredSide: 'bottom',
    preferredAlign,
    anchor: anchorRect,
    clip: box,
    contentWidth,
    contentHeight,
    scaleX,
    scaleY,
  })

  el.dataset.side = layout.side
  el.dataset.align = layout.align
  if (layout.maxHeight !== null) {
    el.style.setProperty('--ui-drpc-panel-max-h', `${layout.maxHeight}px`)
  }
  el.toggleAttribute('data-overflow', layout.overflow)

  if (layout.dx || layout.dy) {
    el.style.translate = `${layout.dx}px ${layout.dy}px`
  }

  if (clipEl && savedScroll > 0) clipEl.scrollTop = savedScroll

  return layout
}
