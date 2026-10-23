import { useCallback, useSyncExternalStore } from 'react'
import { cachePhase, nextPhaseIn, type CachePhase } from '@shared/prompt-cache'
import { subscribeClock } from '@renderer/lib/use-now'

/** The longest delay `setTimeout` takes; a longer one fires at once. */
const MAX_DELAY = 2 ** 31 - 1

/**
 * Calls `changed` when the cache's phase may have changed: as each phase starts, and on each tick
 * of the shared clock, since timers stand still while the computer sleeps and do not follow a
 * change of its clock.
 */
export function subscribeCachePhase(expiresAt: number, changed: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    const wait = nextPhaseIn(expiresAt, Date.now())
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
 * The cache's phase. The snapshot is a primitive, so a check that finds the phase unchanged
 * renders nothing: the component re-renders as the last minute starts and as the cache expires.
 */
export function useCachePhase(expiresAt: number | null): CachePhase | null {
  const subscribe = useCallback(
    (changed: () => void) =>
      expiresAt === null ? () => {} : subscribeCachePhase(expiresAt, changed),
    [expiresAt],
  )
  return useSyncExternalStore(subscribe, () =>
    expiresAt === null ? null : cachePhase(expiresAt, Date.now()),
  )
}
