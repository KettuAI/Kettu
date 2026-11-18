import { create } from 'zustand'
import { readJson, removeKey, writeJson } from '@renderer/lib/storage'

// The prompt box's height as the user dragged it, kept on this device in localStorage and shared
// by the session composer and New session. Null leaves it automatic: two lines, growing with the
// text up to a cap.

const KEY = 'composer-height'

/** The most a dragged box takes of the window's height. */
export const MAX_HEIGHT_SHARE = 0.5

function load(): number | null {
  const stored = readJson<unknown>(KEY, null)
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0
    ? Math.round(stored)
    : null
}

export const useComposerHeight = create<{ height: number | null }>(() => ({ height: load() }))

/** Sets the box's height in pixels, or null to make it automatic again. */
export function setComposerHeight(height: number | null): void {
  useComposerHeight.setState({ height })
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
useComposerHeight.subscribe(({ height }) => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => (height === null ? removeKey(KEY) : writeJson(KEY, height)), 300)
})
