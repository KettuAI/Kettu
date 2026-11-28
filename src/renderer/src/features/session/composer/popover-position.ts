// Placement of the prompt box's `@` mention and `/` slash popovers. Keeps the popover docked
// above the box when there is comfortable room there, and falls back to the trigger line (above
// it first, or below it when above is too cramped and below has more room) when a tall composer
// or short viewport leaves too little space above the box.

export interface BoxRect {
  top: number
  bottom: number
  left: number
  right: number
}

export interface ViewportBounds {
  /** Top edge of the usable viewport, clear of window controls and collision padding. */
  top: number
  /** Bottom edge of the usable viewport, clear of collision padding. */
  bottom: number
}

export type PopoverKind = 'mention' | 'slash' | 'hash'
export type PopoverSide = 'top' | 'bottom'

export interface PopoverPlacement {
  side: PopoverSide
  /** Virtual anchor rectangle passed to Floating UI (`x, y, width, height`). */
  anchor: { x: number; y: number; width: number; height: number }
}

/** Maximum popup height matching `max-h-[min(var(--available-height),320px)]`. */
export const POPOVER_MAX_HEIGHT = 320

/** Gap between the anchor edge and the popup (`sideOffset`). */
export const POPOVER_SIDE_OFFSET = 6

/**
 * Minimum room above the box's top edge at which the popover stays docked above the box rather
 * than moving down to the trigger line (~6.5 mention rows or ~7 slash commands).
 */
export const POPOVER_COMFORTABLE_ABOVE = 260

/**
 * Minimum usable room above the trigger line before flipping below it when below has more room.
 * Keeps normal New Session placements above the box (clear of Send) while rescuing tall composers
 * with the caret near the top line and very short viewports.
 */
export const POPOVER_MIN_ABOVE = 200

/** Room a single-line slash status note needs above the box before needing a fallback. */
const COMPACT_MIN_ABOVE = 64

/** Base UI's default collision padding when no platform inset is passed. */
export const DEFAULT_COLLISION_PADDING = 5

/** Usable vertical viewport range given the window height and Base UI collision padding. */
export function viewportBounds(
  innerHeight: number,
  padding?: number | { top?: number; bottom?: number },
): ViewportBounds {
  const top = typeof padding === 'number' ? padding : (padding?.top ?? DEFAULT_COLLISION_PADDING)
  const bottom =
    typeof padding === 'number' ? padding : (padding?.bottom ?? DEFAULT_COLLISION_PADDING)
  return { top, bottom: Math.max(top, innerHeight - bottom) }
}

/**
 * Clamps a trigger character's viewport rect into the editor's visible scroll area so scrolling
 * inside a tall composer never anchors the popover outside the box.
 */
export function clampTriggerRect(
  trigger: BoxRect | null,
  scroller: BoxRect | null,
): BoxRect | null {
  if (!trigger) return null
  if (!scroller || (scroller.bottom <= scroller.top && scroller.right <= scroller.left)) {
    return trigger
  }
  const lineHeight = Math.max(1, trigger.bottom - trigger.top)
  const visibleHeight = Math.max(0, scroller.bottom - scroller.top)
  const clampedHeight = Math.min(lineHeight, visibleHeight)
  let top = trigger.top
  let bottom = trigger.bottom
  if (bottom <= scroller.top) {
    top = scroller.top
    bottom = scroller.top + clampedHeight
  } else if (top >= scroller.bottom) {
    bottom = scroller.bottom
    top = scroller.bottom - clampedHeight
  } else {
    top = Math.max(scroller.top, top)
    bottom = Math.min(scroller.bottom, bottom)
  }
  return {
    top,
    bottom: Math.max(top, bottom),
    left: Math.min(Math.max(trigger.left, scroller.left), scroller.right),
    right: Math.min(Math.max(trigger.right, scroller.left), scroller.right),
  }
}

/**
 * Computes the side and virtual anchor rectangle for the composer's mention or slash popover.
 */
export function resolvePopoverPlacement({
  kind,
  box,
  trigger,
  viewport,
  sideOffset = POPOVER_SIDE_OFFSET,
  compact = false,
}: {
  kind: PopoverKind
  box: BoxRect
  trigger: BoxRect | null
  viewport: ViewportBounds
  sideOffset?: number
  /** Single-line notes (such as slash loading/choose-project) stay above the box when they fit. */
  compact?: boolean
}): PopoverPlacement {
  const boxHeight = Math.max(0, box.bottom - box.top)
  // Slash aligns to the box's left edge and sizes from `--anchor-width`; mentions start at `@`.
  const x =
    kind === 'slash'
      ? box.left
      : Math.min(Math.max(trigger ? trigger.left : box.left, box.left), box.right)
  const width = Math.max(0, box.right - x)

  const spaceAboveBox = Math.max(0, box.top - viewport.top - sideOffset)
  const aboveTarget = compact ? COMPACT_MIN_ABOVE : POPOVER_COMFORTABLE_ABOVE
  if (spaceAboveBox >= aboveTarget) {
    return { side: 'top', anchor: { x, y: box.top, width, height: boxHeight } }
  }

  if (trigger) {
    const triggerTop = Math.min(Math.max(trigger.top, box.top), box.bottom)
    const triggerBottom = Math.min(Math.max(trigger.bottom, triggerTop), box.bottom)
    const triggerHeight = Math.max(1, triggerBottom - triggerTop)
    const spaceAboveTrigger = Math.max(0, triggerTop - viewport.top - sideOffset)
    const spaceBelowTrigger = Math.max(0, viewport.bottom - triggerBottom - sideOffset)
    const minAbove = compact ? COMPACT_MIN_ABOVE : POPOVER_MIN_ABOVE
    const side: PopoverSide =
      spaceAboveTrigger < minAbove && spaceBelowTrigger > spaceAboveTrigger ? 'bottom' : 'top'
    return { side, anchor: { x, y: triggerTop, width, height: triggerHeight } }
  }

  const spaceBelowBox = Math.max(0, viewport.bottom - box.bottom - sideOffset)
  const minAbove = compact ? COMPACT_MIN_ABOVE : POPOVER_MIN_ABOVE
  const side: PopoverSide =
    spaceAboveBox < minAbove && spaceBelowBox > spaceAboveBox ? 'bottom' : 'top'
  return { side, anchor: { x, y: box.top, width, height: boxHeight } }
}
