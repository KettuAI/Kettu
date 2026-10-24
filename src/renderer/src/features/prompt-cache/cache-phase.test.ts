import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachePhase } from '@shared/prompt-cache'
import { subscribeCachePhase, subscribeCacheTime } from './cache-phase'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** The phases the subscriber reads each time it is told to look. */
function watch(expiresAt: number, ending = MINUTE) {
  const seen: string[] = []
  const stop = subscribeCachePhase(expiresAt, ending, () =>
    seen.push(cachePhase(expiresAt, ending, Date.now())),
  )
  return { seen, stop }
}

/** The time left as "52 min" or "4:07". */
function shown(left: number): string {
  if (left > 5 * MINUTE) return `${Math.floor(left / MINUTE)} min`
  const s = Math.ceil(left / SECOND)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The times left the subscriber shows, from the first, without repeats, as a component renders. */
function watchTime(expiresAt: number) {
  const seen = [shown(expiresAt - Date.now())]
  const stop = subscribeCacheTime(expiresAt, () => {
    const left = shown(Math.max(0, expiresAt - Date.now()))
    if (seen.at(-1) !== left) seen.push(left)
  })
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

  it('starts the last five minutes of an hour-long cache', () => {
    vi.useFakeTimers({ now: 0 })
    const expiresAt = HOUR + 10 * SECOND
    const { seen, stop } = watch(expiresAt, 5 * MINUTE)
    vi.advanceTimersByTime(55 * MINUTE + 10 * SECOND - 1)
    expect(seen.at(-1)).toBe('warm')
    vi.advanceTimersByTime(1)
    expect(seen.at(-1)).toBe('ending')
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

describe("the prompt cache's time left", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('changes as each minute passes, then each second in the last five', () => {
    vi.useFakeTimers({ now: 0 })
    // Off the shared clock's 30 s ticks, so only its own timers can be on time.
    const expiresAt = 7 * MINUTE + 10 * SECOND
    const { seen, stop } = watchTime(expiresAt)
    vi.advanceTimersByTime(10 * SECOND)
    expect(seen).toEqual(['7 min'])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['7 min', '6 min'])
    vi.advanceTimersByTime(MINUTE)
    expect(seen).toEqual(['7 min', '6 min', '5 min'])
    vi.advanceTimersByTime(MINUTE - 1)
    expect(seen.at(-1)).toBe('5:00')
    vi.advanceTimersByTime(SECOND)
    expect(seen.at(-1)).toBe('4:59')
    vi.advanceTimersByTime(5 * MINUTE)
    expect(seen.at(-1)).toBe('0:00')
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops counting seconds once the cache has expired', () => {
    vi.useFakeTimers({ now: 0 })
    const { stop } = watchTime(2 * SECOND)
    vi.advanceTimersByTime(3 * SECOND)
    // Only the shared clock is left.
    expect(vi.getTimerCount()).toBe(1)
    stop()
  })
})
