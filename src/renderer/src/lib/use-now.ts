import { useSyncExternalStore } from 'react'

/** A clock that ticks only while something listens; the first listener reads the time afresh. */
function makeClock(period: number) {
  let now = Date.now()
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (!timer) {
        // Nothing ticked while nobody listened; React reads the time again after subscribing.
        now = Date.now()
        timer = setInterval(() => {
          now = Date.now()
          for (const l of listeners) l()
        }, period)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          clearInterval(timer)
          timer = undefined
        }
      }
    },
    time: (): number => now,
  }
}

// One shared clock for relative times, so a long session list runs one timer, not one per row.
const shared = makeClock(30_000)
// Only for a countdown on screen, such as the prompt cache's in the usage popover.
const seconds = makeClock(1_000)

export const subscribeClock = shared.subscribe

/** The time the clock last read. */
export const clockTime = shared.time

export const subscribeSeconds = seconds.subscribe

export const secondsTime = seconds.time

/** The current time, refreshed every 30 s. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, clockTime)
}

/** The current time, refreshed every second: re-renders the component that uses it each second. */
export function useSeconds(): number {
  return useSyncExternalStore(subscribeSeconds, secondsTime)
}

/**
 * What `select` makes of the current time, such as its day; a component re-renders only when that
 * changes, so `select` returns a primitive.
 */
export function useClock<T>(select: (now: number) => T): T {
  return useSyncExternalStore(subscribeClock, () => select(clockTime()))
}
