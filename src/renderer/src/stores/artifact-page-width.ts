import { create } from 'zustand'
import { readJson, writeJson } from '@renderer/lib/storage'

// The width a web page artifact is laid out at, chosen per artifact and kept on this device in
// localStorage. Fill, the default, is not stored.

/** Fill takes the room there is; a number lays the page out that many pixels wide. */
export type PageWidth = 'fill' | 1280 | 768 | 390

export const PAGE_WIDTHS: readonly Exclude<PageWidth, 'fill'>[] = [1280, 768, 390]

const KEY = 'artifact-page-widths'
/** The artifacts whose width is kept; the least recently chosen goes first. */
const KEPT = 200

function load(): Record<string, PageWidth> {
  const stored = readJson<unknown>(KEY, null)
  if (!stored || typeof stored !== 'object') return {}
  const widths: Record<string, PageWidth> = {}
  for (const [id, width] of Object.entries(stored)) {
    if (PAGE_WIDTHS.includes(width as Exclude<PageWidth, 'fill'>)) widths[id] = width as PageWidth
  }
  return widths
}

export const usePageWidths = create<{ byId: Record<string, PageWidth> }>(() => ({ byId: load() }))

export function usePageWidth(id: string): PageWidth {
  return usePageWidths((s) => s.byId[id] ?? 'fill')
}

export function setPageWidth(id: string, width: PageWidth): void {
  usePageWidths.setState((s) => {
    if ((s.byId[id] ?? 'fill') === width) return s
    // Chosen again, it moves to the end, the most recent.
    const next: Record<string, PageWidth> = { ...s.byId }
    delete next[id]
    if (width !== 'fill') next[id] = width
    const ids = Object.keys(next)
    for (const old of ids.slice(0, Math.max(0, ids.length - KEPT))) delete next[old]
    return { byId: next }
  })
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
usePageWidths.subscribe(({ byId }) => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => writeJson(KEY, byId), 300)
})
