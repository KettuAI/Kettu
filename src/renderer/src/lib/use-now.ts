import { useSyncExternalStore } from 'react'
import { isPageHidden, subscribePageVisibility } from './page-visibility'

/**
 * A clock that ticks only while something listens and the page is visible; the first listener and
 * any visibility restore read the time afresh immediately.
 */
function makeClock(period: number) {
  let now = Date.now()
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  let stopVisibility: (() => void) | undefined

  const emit = (): void => {
    now = Date.now()
    for (const l of listeners) l()
  }

  const startTimer = (): void => {
    if (timer || listeners.size === 0 || isPageHidden()) return
    timer = setInterval(emit, period)
  }

  const stopTimer = (): void => {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  return {
    subscribe(listener: () => void): () => void {
      const first = listeners.size === 0
      listeners.add(listener)
      if (first) {
        // Nothing ticked while nobody listened; React reads the time again after subscribing.
        now = Date.now()
        stopVisibility = subscribePageVisibility((hidden) => {
          if (hidden) {
            stopTimer()
          } else {
            emit()
            startTimer()
          }
        })
        startTimer()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          stopTimer()
          stopVisibility?.()
          stopVisibility = undefined
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
  return useSyncExternalStore(subscribeClock, clockTime, clockTime)
}

/** The current time, refreshed every second: re-renders the component that uses it each second. */
export function useSeconds(): number {
  return useSyncExternalStore(subscribeSeconds, secondsTime, secondsTime)
}

/**
 * What `select` makes of the current time, such as its day; a component re-renders only when that
 * changes, so `select` returns a primitive.
 */
export function useClock<T>(select: (now: number) => T): T {
  const read = () => select(clockTime())
  return useSyncExternalStore(subscribeClock, read, read)
}
