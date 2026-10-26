import { useSyncExternalStore } from 'react'

// A hidden scroller with the column's scrollbar classes, so its gutter is the one every view of the
// column keeps. Made on first use; the observer catches the gutter changing, as when the platform's
// scrollbars switch between overlay and classic.
let probe: HTMLDivElement | null = null
let gutter = 0
const listeners = new Set<() => void>()

const measure = (el: HTMLDivElement): number => el.offsetWidth - el.clientWidth

function ensureProbe(): void {
  if (probe) return
  const el = document.createElement('div')
  el.className =
    'pointer-events-none invisible fixed top-0 left-0 size-24 overflow-y-auto scrollbar-thin scrollbar-gutter-stable'
  el.setAttribute('aria-hidden', 'true')
  document.body.append(el)
  probe = el
  gutter = measure(el)
  new ResizeObserver(() => {
    const next = measure(el)
    if (next === gutter) return
    gutter = next
    for (const listener of listeners) listener()
  }).observe(el)
}

function subscribe(onChange: () => void): () => void {
  ensureProbe()
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

function getGutter(): number {
  ensureProbe()
  return gutter
}

/**
 * The width the column's scrollbar takes on the right, 0 where scrollbars overlay the content. A
 * composer row leaves it, so its edges meet the column's in every view.
 */
export function useScrollbarGutter(): number {
  return useSyncExternalStore(subscribe, getGutter)
}
