import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompareTimer, SLOW_COMPARE_GAP_MS } from './paths'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** A timer whose comparisons open their handshakes as soon as they run, as a device's do. */
function timer(): { compares: CompareTimer; runs: () => number } {
  let runs = 0
  const compares: CompareTimer = new CompareTimer(() => {
    runs++
    compares.started()
  })
  return { compares, runs: () => runs }
}

describe('when a device compares its paths', () => {
  it('compares once per gap however many pings in a row come back slow', () => {
    const { compares, runs } = timer()
    compares.slow()
    vi.advanceTimersByTime(0)
    expect(runs()).toBe(1)

    // An idle connection pings about every 10 s; each of these is slow.
    for (let ping = 0; ping < 11; ping++) {
      vi.advanceTimersByTime(10_000)
      compares.slow()
    }
    expect(runs()).toBe(1)

    // The slow pings are not dropped: one comparison follows once the gap is over.
    vi.advanceTimersByTime(SLOW_COMPARE_GAP_MS - 110_000)
    expect(runs()).toBe(2)
    vi.advanceTimersByTime(SLOW_COMPARE_GAP_MS)
    expect(runs()).toBe(2)
  })

  it('compares at once for a slow ping long after the last comparison', () => {
    const { compares, runs } = timer()
    compares.started()
    vi.advanceTimersByTime(SLOW_COMPARE_GAP_MS)
    compares.slow()
    vi.advanceTimersByTime(0)
    expect(runs()).toBe(1)
  })

  it('compares at once for a network change or coming to the front, inside the gap', () => {
    const { compares, runs } = timer()
    compares.slow()
    vi.advanceTimersByTime(0)
    vi.advanceTimersByTime(10_000)
    compares.slow()

    compares.soon(0)
    vi.advanceTimersByTime(0)
    expect(runs()).toBe(2)
    // That comparison took the slow ping's place, and the gap starts again from it.
    vi.advanceTimersByTime(SLOW_COMPARE_GAP_MS / 2)
    expect(runs()).toBe(2)
    compares.slow()
    vi.advanceTimersByTime(SLOW_COMPARE_GAP_MS / 2 - 1)
    expect(runs()).toBe(2)
    vi.advanceTimersByTime(1)
    expect(runs()).toBe(3)
  })

  it('counts a comparison off a failing path toward the gap', () => {
    const { compares, runs } = timer()
    // A draining region compares at once without the timer, and says so.
    compares.started()
    compares.slow()
    vi.advanceTimersByTime(SLOW_COMPARE_GAP_MS - 1)
    expect(runs()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(runs()).toBe(1)
  })

  it('compares no more once stopped', () => {
    const { compares, runs } = timer()
    compares.soon(1_000)
    compares.stop()
    vi.advanceTimersByTime(SLOW_COMPARE_GAP_MS)
    expect(runs()).toBe(0)
  })
})
