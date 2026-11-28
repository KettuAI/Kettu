import { create } from 'zustand'
import type { ConversationWidth, SettingsFile } from '@shared/settings'
import { readJson, removeKey, writeJson } from '@renderer/lib/storage'

// The width of the thread's column as the user dragged it, kept on this device in localStorage and
// shared by every session. Null leaves it at the selected Appearance preset's width.

const KEY = 'thread-width'

/** The least the column is dragged to, in px. */
export const MIN_WIDTH = 480

/** A single keyboard Arrow step in px; Shift moves four times as far. */
export const WIDTH_KEY_STEP = 48

/** Base prose font size in px for each text size setting (the composer's size). */
export const PROSE_SIZES: Record<SettingsFile['appearance']['textSize'], number> = {
  small: 14,
  default: 15,
  large: 16,
}

/** Column measure multiplier (in prose-size units) for each conversation width preset. */
export const PRESET_MULTIPLIERS: Record<ConversationWidth, number> = {
  standard: 48,
  wide: 72,
}

/** The default column width in px for a conversation width preset and text size. */
export function presetThreadWidth(
  preset: ConversationWidth,
  textSize: SettingsFile['appearance']['textSize'] = 'default',
): number {
  return PRESET_MULTIPLIERS[preset] * PROSE_SIZES[textSize] + 8
}

/** Clamps a desired column width to the room available, shrinking cleanly on narrow viewports. */
export function clampThreadWidth(wanted: number, available: number): number {
  if (!Number.isFinite(available) || available <= 0) return 0
  return Math.round(Math.min(available, Math.max(Math.min(MIN_WIDTH, available), wanted)))
}

/** Resolves a drag gesture from one centered edge into the clamped column width. */
export function dragThreadWidth(
  startWidth: number,
  available: number,
  side: 'left' | 'right',
  deltaX: number,
): number {
  const sign = side === 'right' ? 1 : -1
  return clampThreadWidth(startWidth + 2 * sign * deltaX, available)
}

/**
 * Resolves a handle key press: null resets to the selected Appearance preset, a number sets a new
 * clamped width, and undefined ignores the key.
 */
export function stepThreadWidth(
  currentWidth: number,
  available: number,
  side: 'left' | 'right',
  key: string,
  shiftKey = false,
): number | null | undefined {
  if (key === 'Home') return null
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined
  const step = (shiftKey ? 4 : 1) * WIDTH_KEY_STEP
  const outward = key === (side === 'right' ? 'ArrowRight' : 'ArrowLeft')
  return clampThreadWidth(currentWidth + (outward ? step : -step), available)
}

/** Resolves the rendered column width for a preset, optional drag override, and available width. */
export function effectiveThreadWidth(
  preset: ConversationWidth,
  draggedWidth: number | null,
  available: number,
  textSize: SettingsFile['appearance']['textSize'] = 'default',
): number {
  if (!Number.isFinite(available) || available <= 0) return 0
  const target = draggedWidth ?? presetThreadWidth(preset, textSize)
  return Math.round(Math.min(available, target))
}

/** Reads and validates the persisted custom column width from localStorage. */
export function readStoredThreadWidth(): number | null {
  const stored = readJson<unknown>(KEY, null)
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= MIN_WIDTH
    ? Math.round(stored)
    : null
}

/** Applies or clears the CSS custom property override for the dragged column width. */
export function applyThreadWidth(root: HTMLElement | null | undefined, width: number | null): void {
  const style = root?.style
  if (!style) return
  if (width === null) {
    if (typeof style.removeProperty === 'function') style.removeProperty('--thread-column-set')
  } else if (typeof style.setProperty === 'function') {
    style.setProperty('--thread-column-set', `${width}px`)
  }
}

export const useThreadWidth = create<{ width: number | null }>(() => ({
  width: readStoredThreadWidth(),
}))

/** Sets the column's width in px, or null to reset to the selected Appearance preset's width. */
export function setThreadWidth(width: number | null): void {
  const next =
    typeof width === 'number' && Number.isFinite(width) && width >= MIN_WIDTH
      ? Math.round(width)
      : null
  useThreadWidth.setState({ width: next })
}

/** Clears any custom drag override so the column returns to the selected Appearance preset. */
export function resetThreadWidth(): void {
  setThreadWidth(null)
}

// session.css reads this where it sets the column's width, so every view of the column follows.
function apply(width: number | null): void {
  if (typeof document === 'undefined') return
  applyThreadWidth(document.documentElement, width)
}

if (typeof useThreadWidth.getState === 'function') {
  apply(useThreadWidth.getState().width)
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
if (typeof useThreadWidth.subscribe === 'function') {
  useThreadWidth.subscribe(({ width }) => {
    apply(width)
    clearTimeout(saveTimer)
    if (width === null) {
      removeKey(KEY)
      return
    }
    saveTimer = setTimeout(() => writeJson(KEY, width), 300)
  })
}
