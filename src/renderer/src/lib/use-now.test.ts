import { afterEach, describe, expect, it, vi } from 'vitest'
import { clockTime, subscribeClock } from './use-now'

describe('the shared clock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks every 30 s while something listens', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const listener = vi.fn()
    const stop = subscribeClock(listener)
    expect(clockTime()).toBe(1_000_000)
    vi.advanceTimersByTime(30_000)
    expect(listener).toHaveBeenCalledOnce()
    expect(clockTime()).toBe(1_030_000)
    stop()
  })

  it('reads the time afresh when it starts again after nobody listened', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    subscribeClock(() => {})()
    vi.setSystemTime(1_000_000 + 3_600_000)
    expect(clockTime()).toBe(1_000_000)
    const stop = subscribeClock(() => {})
    expect(clockTime()).toBe(1_000_000 + 3_600_000)
    stop()
  })
})
