import { useSyncExternalStore } from 'react'

/** The primary pointer cannot hover or is coarse, as on phones and touch browsers that also advertise hover. */
const NO_HOVER = '(hover: none), (pointer: coarse)'

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const list = window.matchMedia(NO_HOVER)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

const noHover = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(NO_HOVER).matches
    : false

/** Whether nothing can hover, so what shows on hover elsewhere needs another way to be seen. */
export function useNoHover(): boolean {
  return useSyncExternalStore(subscribe, noHover, noHover)
}
