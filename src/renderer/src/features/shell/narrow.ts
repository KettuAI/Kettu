import { useSyncExternalStore } from 'react'

// App Shell turns the sidebar into a drawer at this window width and below.
const QUERY = '(max-width: 900px)'

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(QUERY)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

/** Whether the window is narrow enough that the sidebar is a drawer over the main area. */
export function useNarrowWindow(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches)
}
