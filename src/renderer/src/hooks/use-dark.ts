import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

const isDark = (): boolean => document.documentElement.dataset.theme === 'dark'

/** Whether the app shows its dark theme now, for libraries that take the theme as a value. */
export function useDark(): boolean {
  return useSyncExternalStore(subscribe, isDark)
}
