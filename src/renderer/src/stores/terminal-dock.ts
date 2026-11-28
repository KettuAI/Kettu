import { create } from 'zustand'
import { readJson, removeKey, writeJson } from '@renderer/lib/storage'

// The bottom terminal dock height as the user dragged it, kept on this device in localStorage
// and shared across sessions.

const KEY = 'terminal-bottom-height'

/** Default dock height in px when no custom height is stored. */
export const DEFAULT_BOTTOM_HEIGHT = 260

/** Minimum dock height in px while the viewport has room for both thread and terminal. */
export const MIN_BOTTOM_HEIGHT = 140

/** Minimum height in px reserved for the session main area above the bottom dock. */
export const MIN_MAIN_HEIGHT = 200

/** Maximum share of the main column height the bottom dock may occupy. */
export const MAX_BOTTOM_HEIGHT_SHARE = 0.7

/** Single keyboard Arrow step in px; Shift moves four times as far. */
export const BOTTOM_HEIGHT_KEY_STEP = 32

/** Computes safe [min, max] pixel bounds for the bottom dock within `available` px. */
export function bottomHeightBounds(available: number): { min: number; max: number } {
  if (!Number.isFinite(available) || available <= 0) return { min: 0, max: 0 }
  const max = Math.max(
    0,
    Math.min(
      Math.round(available * MAX_BOTTOM_HEIGHT_SHARE),
      Math.floor(available - MIN_MAIN_HEIGHT),
    ),
  )
  const min = Math.min(MIN_BOTTOM_HEIGHT, max)
  return { min, max }
}

/** Clamps a desired bottom dock height to safe bounds so the thread and composer stay usable. */
export function clampBottomTerminalHeight(wanted: number, available: number): number {
  const { min, max } = bottomHeightBounds(available)
  if (max <= 0) return 0
  const target = Number.isFinite(wanted) ? wanted : DEFAULT_BOTTOM_HEIGHT
  return Math.round(Math.min(max, Math.max(min, target)))
}

/** Resolves a vertical drag delta (negative moves the handle upward, growing the dock). */
export function dragBottomTerminalHeight(
  startHeight: number,
  available: number,
  deltaY: number,
): number {
  return clampBottomTerminalHeight(startHeight - deltaY, available)
}

/**
 * Resolves a separator key press: null resets to the default height, a number sets a new
 * clamped height, and undefined ignores the key.
 */
export function stepBottomTerminalHeight(
  currentHeight: number,
  available: number,
  key: string,
  shiftKey = false,
): number | null | undefined {
  if (key === 'Home') return null
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return undefined
  const step = (shiftKey ? 4 : 1) * BOTTOM_HEIGHT_KEY_STEP
  const delta = key === 'ArrowUp' ? step : -step
  return clampBottomTerminalHeight(currentHeight + delta, available)
}

/** Reads and validates the persisted bottom dock height from localStorage. */
export function readStoredBottomTerminalHeight(): number {
  const stored = readJson<unknown>(KEY, null)
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= MIN_BOTTOM_HEIGHT
    ? Math.round(stored)
    : DEFAULT_BOTTOM_HEIGHT
}

export const useBottomTerminalHeight = create<{ height: number }>(() => ({
  height: readStoredBottomTerminalHeight(),
}))

/** Sets the preferred bottom dock height in px, sanitizing invalid values to the default. */
export function setBottomTerminalHeight(height: number): void {
  const next =
    typeof height === 'number' && Number.isFinite(height) && height >= MIN_BOTTOM_HEIGHT
      ? Math.round(height)
      : DEFAULT_BOTTOM_HEIGHT
  useBottomTerminalHeight.setState({ height: next })
}

/** Resets the bottom dock height to the default and clears any custom stored override. */
export function resetBottomTerminalHeight(): void {
  clearTimeout(saveTimer)
  removeKey(KEY)
  useBottomTerminalHeight.setState({ height: DEFAULT_BOTTOM_HEIGHT })
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
useBottomTerminalHeight.subscribe(({ height }) => {
  clearTimeout(saveTimer)
  if (height === DEFAULT_BOTTOM_HEIGHT) {
    removeKey(KEY)
    return
  }
  saveTimer = setTimeout(() => writeJson(KEY, height), 300)
})
