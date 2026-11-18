import { create } from 'zustand'
import { readJson, removeKey, writeJson } from '@renderer/lib/storage'

// The width of the thread's column as the user dragged it, kept on this device in localStorage and
// shared by every session. Null leaves it at the width the text size gives.

const KEY = 'thread-width'

/** The least the column is dragged to, in px. */
export const MIN_WIDTH = 480

function load(): number | null {
  const stored = readJson<unknown>(KEY, null)
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= MIN_WIDTH
    ? Math.round(stored)
    : null
}

export const useThreadWidth = create<{ width: number | null }>(() => ({ width: load() }))

/** Sets the column's width in px, or null to give it the text size's width again. */
export function setThreadWidth(width: number | null): void {
  useThreadWidth.setState({ width })
}

// session.css reads this where it sets the column's width, so every view of the column follows.
function apply(width: number | null): void {
  const root = document.documentElement
  if (width === null) root.style.removeProperty('--thread-column-set')
  else root.style.setProperty('--thread-column-set', `${width}px`)
}

apply(useThreadWidth.getState().width)

let saveTimer: ReturnType<typeof setTimeout> | undefined
useThreadWidth.subscribe(({ width }) => {
  apply(width)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => (width === null ? removeKey(KEY) : writeJson(KEY, width)), 300)
})
