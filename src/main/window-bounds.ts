// Pure placement of the main window from window-state.json and the current displays.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindowState {
  bounds: Rect
  maximized: boolean
}

export interface WindowPlacement {
  bounds: { x?: number; y?: number; width: number; height: number }
  maximized: boolean
}

interface Size {
  width: number
  height: number
}

// How much of the title bar strip must stay on a display for a saved position to be reused.
const VISIBLE_STRIP = { width: 100, height: 20, depth: 40 }

function overlap(a: Rect, b: Rect): Size {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

function clampSize(size: Size, area: Rect, min: Size): Size {
  return {
    width: Math.max(min.width, Math.min(size.width, area.width)),
    height: Math.max(min.height, Math.min(size.height, area.height)),
  }
}

/**
 * Where to open the window. A saved position is kept only while its title bar strip is on a
 * display, so the window never opens out of reach after a monitor is unplugged; the size always
 * fits the display it opens on.
 */
export function placeWindow(
  saved: SavedWindowState | null,
  workAreas: Rect[],
  primary: Rect,
  defaults: Size,
  min: Size,
): WindowPlacement {
  if (!saved) return { bounds: clampSize(defaults, primary, min), maximized: false }
  const { bounds } = saved
  const strip = { x: bounds.x, y: bounds.y, width: bounds.width, height: VISIBLE_STRIP.depth }
  const home = workAreas.find((area) => {
    const visible = overlap(strip, area)
    return (
      visible.width >= Math.min(VISIBLE_STRIP.width, bounds.width) &&
      visible.height >= VISIBLE_STRIP.height
    )
  })
  if (!home) return { bounds: clampSize(bounds, primary, min), maximized: saved.maximized }
  return {
    bounds: { x: bounds.x, y: bounds.y, ...clampSize(bounds, home, min) },
    maximized: saved.maximized,
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/** Reads a parsed window-state.json, or null when it does not hold a usable state. */
export function parseWindowState(raw: unknown): SavedWindowState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { version, bounds, maximized } = raw as Record<string, unknown>
  if (version !== 1 || typeof bounds !== 'object' || bounds === null) return null
  const { x, y, width, height } = bounds as Record<string, unknown>
  if (!isInteger(x) || !isInteger(y) || !isInteger(width) || !isInteger(height)) return null
  if (width <= 0 || height <= 0 || typeof maximized !== 'boolean') return null
  return { bounds: { x, y, width, height }, maximized }
}
