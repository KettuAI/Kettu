// The heights the prompt box's resize handle may set.

export interface HeightBounds {
  /** The box's automatic height at rest. */
  least: number
  most: number
}

// A press on the handle moves the pointer a pixel or two; a drag starts past this.
const DRAG_SLOP = 3

/**
 * The fixed height for a wanted one, or null for automatic. A box fixed at its resting height
 * would look automatic but never grow with the text, so that height is automatic.
 */
export function fixedHeight(wanted: number, { least, most }: HeightBounds): number | null {
  return wanted <= least ? null : Math.round(Math.min(most, wanted))
}

/** The height after the pointer moved `up` pixels from where it pressed, or undefined for a press. */
export function draggedHeight(
  start: HeightBounds & { height: number },
  up: number,
): number | null | undefined {
  return Math.abs(up) < DRAG_SLOP ? undefined : fixedHeight(start.height + up, start)
}
