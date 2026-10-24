import { useCallback, useSyncExternalStore } from 'react'
import {
  cachePhase,
  endingWindow,
  nextPhaseIn,
  type CachePhase,
  type KnownExpiry,
} from '@shared/prompt-cache'
import { SECONDS_LEFT } from '@renderer/lib/format'
import { subscribeClock, subscribeSeconds } from '@renderer/lib/use-now'

/** The longest delay `setTimeout` takes; a longer one fires at once. */
const MAX_DELAY = 2 ** 31 - 1
const MINUTE = 60_000

/**
 * Calls `changed` when the cache's phase may have changed: as each phase starts, and on each tick
 * of the shared clock, since timers stand still while the computer sleeps and do not follow a
 * change of its clock.
 */
export function subscribeCachePhase(
  expiresAt: number,
  ending: number,
  changed: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    const wait = nextPhaseIn(expiresAt, ending, Date.now())
    timer = wait === null ? undefined : setTimeout(check, Math.min(wait, MAX_DELAY))
  }
  const check = () => {
    changed()
    arm()
  }
  arm()
  const stopClock = subscribeClock(check)
  return () => {
    clearTimeout(timer)
    stopClock()
  }
}

/**
 * The cache's phase, or null without an expiry. The snapshot is a primitive, so a check that finds
 * the phase unchanged renders nothing: the component re-renders as the last minutes start and as
 * the cache expires.
 */
export function useCachePhase(expiry: KnownExpiry | null): CachePhase | null {
  const expiresAt = expiry?.expiresAt ?? null
  const ending = expiry ? endingWindow(expiry.ttl) : 0
  const subscribe = useCallback(
    (changed: () => void) =>
      expiresAt === null ? () => {} : subscribeCachePhase(expiresAt, ending, changed),
    [expiresAt, ending],
  )
  return useSyncExternalStore(subscribe, () =>
    expiresAt === null ? null : cachePhase(expiresAt, ending, Date.now()),
  )
}

/**
 * Calls `changed` when the time left as a countdown shows it may have changed: as each whole minute
 * passes, then each second in the last five minutes, and on each tick of the shared clock.
 */
export function subscribeCacheTime(expiresAt: number, changed: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopSeconds: (() => void) | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = undefined
    const left = expiresAt - Date.now()
    if (left <= 0) {
      stopSeconds?.()
      stopSeconds = undefined
    } else if (left <= SECONDS_LEFT) {
      stopSeconds ??= subscribeSeconds(check)
    } else {
      // The next whole minute, or the start of the last five, whichever comes first.
      const wait = Math.min((left % MINUTE) + 1, left - SECONDS_LEFT)
      timer = setTimeout(check, Math.min(wait, MAX_DELAY))
    }
  }
  const check = () => {
    changed()
    arm()
  }
  arm()
  const stopClock = subscribeClock(check)
  return () => {
    clearTimeout(timer)
    stopSeconds?.()
    stopClock()
  }
}

/**
 * What `select` makes of the time left, or null without an expiry; `select` returns a primitive,
 * so the component re-renders only when that changes, such as each minute for "52 min".
 */
export function useCacheLeft<T>(expiresAt: number | null, select: (left: number) => T): T | null {
  const subscribe = useCallback(
    (changed: () => void) =>
      expiresAt === null ? () => {} : subscribeCacheTime(expiresAt, changed),
    [expiresAt],
  )
  return useSyncExternalStore(subscribe, () =>
    expiresAt === null ? null : select(Math.max(0, expiresAt - Date.now())),
  )
}
