import { useSyncExternalStore } from 'react'

/** The primary pointer cannot hover, as on a phone or a tablet: the query the stylesheets use. */
const NO_HOVER = '(hover: none)'

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(NO_HOVER)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

const noHover = (): boolean => window.matchMedia(NO_HOVER).matches

/** Whether nothing can hover, so what shows on hover elsewhere needs another way to be seen. */
export function useNoHover(): boolean {
  return useSyncExternalStore(subscribe, noHover)
}
