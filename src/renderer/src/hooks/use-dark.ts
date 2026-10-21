import { useSyncExternalStore } from 'react'

const root = document.documentElement

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(root, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

const isDark = (): boolean => root.classList.contains('dark')

/** Whether the app shows its dark theme now, for libraries that take the theme as a value. */
export function useDark(): boolean {
  return useSyncExternalStore(subscribe, isDark)
}
