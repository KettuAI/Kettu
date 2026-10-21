import { useSyncExternalStore } from 'react'

// One shared clock for relative times, so a long session list runs one timer, not one per row.
let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now()
      for (const l of listeners) l()
    }, 30_000)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** The current time, refreshed every 30 s. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now)
}
