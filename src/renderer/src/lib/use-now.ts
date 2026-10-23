import { useSyncExternalStore } from 'react'

// One shared clock for relative times, so a long session list runs one timer, not one per row.
let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

/** Listens to the clock; the first listener after a quiet spell reads the time afresh. */
export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    // Nothing ticked while nobody listened; React reads the time again after subscribing.
    now = Date.now()
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

/** The time the clock last read. */
export function clockTime(): number {
  return now
}

/** The current time, refreshed every 30 s. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, clockTime)
}

/**
 * What `select` makes of the current time, such as its day; a component re-renders only when that
 * changes, so `select` returns a primitive.
 */
export function useClock<T>(select: (now: number) => T): T {
  return useSyncExternalStore(subscribeClock, () => select(now))
}
