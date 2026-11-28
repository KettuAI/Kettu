// Pointer drag threshold and rectangle normalization helpers for marquee selection on PickLayer.

import type { PageBox } from '@shared/artifact-runtime/page-messages'

/** Minimum screen-pixel pointer travel before a press becomes a marquee drag rather than a click. */
export const MARQUEE_THRESHOLD = 6

/** Returns true once pointer movement reaches the marquee drag threshold. */
export function exceededMarqueeThreshold(
  start: { x: number; y: number },
  current: { x: number; y: number },
  threshold = MARQUEE_THRESHOLD,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold
}

function clampCoord(value: number, limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return value
  return Math.max(0, Math.min(limit, value))
}

/**
 * Normalizes two drag endpoints in page-local CSS pixels into a non-negative `PageBox`, optionally
 * clamped to the page frame dimensions so drags outside the edge still enclose boundary elements.
 */
export function normalizeMarqueeRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
  bounds?: { width: number; height: number },
): PageBox {
  const x1 = clampCoord(start.x, bounds?.width)
  const y1 = clampCoord(start.y, bounds?.height)
  const x2 = clampCoord(end.x, bounds?.width)
  const y2 = clampCoord(end.y, bounds?.height)
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  return {
    x,
    y,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}
