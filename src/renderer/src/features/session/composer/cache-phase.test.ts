import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachePhase } from '@shared/prompt-cache'
import { subscribeCachePhase } from './cache-phase'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** The phases the subscriber reads each time it is told to look. */
function watch(expiresAt: number) {
  const seen: string[] = []
  const stop = subscribeCachePhase(expiresAt, () => seen.push(cachePhase(expiresAt, Date.now())))
  return { seen, stop }
}

describe("the prompt cache's phase", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('changes as the last minute starts and as the cache expires', () => {
    vi.useFakeTimers({ now: 0 })
    // Off the shared clock's 30 s ticks, so only the phase's own timer can be on time.
    const expiresAt = 10 * MINUTE + 10 * SECOND
    const { seen, stop } = watch(expiresAt)
    vi.advanceTimersByTime(9 * MINUTE + 10 * SECOND - 1)
    expect(seen.at(-1) ?? 'warm').toBe('warm')
    vi.advanceTimersByTime(1)
    expect(seen.at(-1)).toBe('ending')
    vi.advanceTimersByTime(MINUTE - 1)
    expect(seen.at(-1)).toBe('ending')
    vi.advanceTimersByTime(1)
    expect(seen.at(-1)).toBe('expired')
    stop()
  })

  it('notices the expiry within one tick of the shared clock after a sleep or a clock change', () => {
    vi.useFakeTimers({ now: 0 })
    const { seen, stop } = watch(HOUR)
    vi.advanceTimersByTime(10 * MINUTE)
    // Timers stand still while the computer sleeps; only the wall clock moves on.
    vi.setSystemTime(Date.now() + 3 * HOUR)
    vi.advanceTimersByTime(30 * SECOND)
    expect(seen.at(-1)).toBe('expired')
    stop()
  })

  it('waits for a far-off expiry instead of checking at once', () => {
    vi.useFakeTimers({ now: 0 })
    // Past the longest delay a timer takes, as after the clock was set back by over 24.8 days.
    const { seen, stop } = watch(40 * 24 * HOUR)
    vi.advanceTimersByTime(SECOND)
    expect(seen).toEqual([])
    stop()
  })

  it('stops listening when unsubscribed', () => {
    vi.useFakeTimers({ now: 0 })
    const { seen, stop } = watch(2 * MINUTE)
    stop()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5 * MINUTE)
    expect(seen).toEqual([])
  })
})
