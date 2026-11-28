import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { followPageVisibility } from './page-visibility'
import { clockTime, secondsTime, subscribeClock, subscribeSeconds } from './use-now'

function installFakeVisibilityDocument(initialHidden = false) {
  let hidden = initialHidden
  const listeners = new Set<() => void>()
  const dataset: Record<string, string | undefined> = {}
  vi.stubGlobal('document', {
    get hidden() {
      return hidden
    },
    get visibilityState() {
      return hidden ? 'hidden' : 'visible'
    },
    documentElement: { dataset },
    addEventListener(type: string, listener: () => void) {
      if (type === 'visibilitychange') listeners.add(listener)
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === 'visibilitychange') listeners.delete(listener)
    },
  })
  return {
    dataset,
    setHidden(next: boolean) {
      hidden = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('page visibility and shared clocks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-28T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('mirrors document.hidden onto <html data-page-hidden> via followPageVisibility', () => {
    const doc = installFakeVisibilityDocument(false)
    const stop = followPageVisibility()
    expect('pageHidden' in doc.dataset).toBe(false)

    doc.setHidden(true)
    expect(doc.dataset.pageHidden).toBe('')

    doc.setHidden(false)
    expect('pageHidden' in doc.dataset).toBe(false)

    stop()
  })

  it('pauses shared 1s and 30s clocks while hidden and catches up immediately on reveal', () => {
    const doc = installFakeVisibilityDocument(false)
    const secondTicks: number[] = []
    const slowTicks: number[] = []
    const unsubSec = subscribeSeconds(() => secondTicks.push(secondsTime()))
    const unsubSlow = subscribeClock(() => slowTicks.push(clockTime()))

    vi.advanceTimersByTime(3_000)
    expect(secondTicks).toHaveLength(3)
    expect(slowTicks).toHaveLength(0)

    // Hide the page: neither clock wakes up even across a full minute.
    doc.setHidden(true)
    vi.advanceTimersByTime(60_000)
    expect(secondTicks).toHaveLength(3)
    expect(slowTicks).toHaveLength(0)

    // Reveal the page: both clocks immediately refresh and resume ticking.
    doc.setHidden(false)
    expect(secondTicks).toHaveLength(4)
    expect(slowTicks).toHaveLength(1)
    expect(secondsTime()).toBe(Date.parse('2026-11-28T00:01:03.000Z'))
    expect(clockTime()).toBe(Date.parse('2026-11-28T00:01:03.000Z'))

    vi.advanceTimersByTime(2_000)
    expect(secondTicks).toHaveLength(6)

    unsubSec()
    unsubSlow()
  })
})
