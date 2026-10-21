import { describe, expect, it } from 'vitest'
import type { PlanLimit } from '@shared/agent-host'
import { countdown, tightestLimit } from './plan-usage'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 21, 12)

const limit = (window: string, usedPercent: number | null, over: Partial<PlanLimit> = {}) =>
  ({
    window,
    label: window,
    usedPercent,
    resetsAt: NOW + HOUR,
    state: 'ok',
    observedAt: NOW - MINUTE,
    ...over,
  }) satisfies PlanLimit

describe('tightestLimit', () => {
  it('picks the fullest window', () => {
    const limits = [limit('five_hour', 40), limit('seven_day', 72), limit('seven_day_opus', 10)]
    expect(tightestLimit(limits, NOW)?.window).toBe('seven_day')
  })

  it('lets a reached window win over a fuller one', () => {
    const limits = [limit('seven_day', 99), limit('five_hour', 80, { state: 'reached' })]
    expect(tightestLimit(limits, NOW)?.window).toBe('five_hour')
  })

  it('skips windows that have reset since they were reported', () => {
    const limits = [limit('five_hour', 95, { resetsAt: NOW - MINUTE }), limit('seven_day', 30)]
    expect(tightestLimit(limits, NOW)?.window).toBe('seven_day')
  })

  it('keeps a window without a reset time', () => {
    expect(tightestLimit([limit('seven_day', 20, { resetsAt: null })], NOW)?.window).toBe(
      'seven_day',
    )
  })

  it('falls back to a window without a percentage', () => {
    expect(tightestLimit([limit('five_hour', null)], NOW)?.window).toBe('five_hour')
  })

  it('has none when every window has reset or there are none', () => {
    expect(tightestLimit([limit('five_hour', 95, { resetsAt: NOW })], NOW)).toBeNull()
    expect(tightestLimit([], NOW)).toBeNull()
  })
})

describe('countdown', () => {
  it('counts minutes under an hour, never below one', () => {
    expect(countdown(42 * MINUTE)).toBe('42m')
    expect(countdown(20_000)).toBe('1m')
  })

  it('counts hours and minutes under a day', () => {
    expect(countdown(5 * HOUR + 12 * MINUTE)).toBe('5h 12m')
    expect(countdown(3 * HOUR)).toBe('3h')
  })

  it('counts days and hours from a day on', () => {
    expect(countdown(DAY + 5 * HOUR + 30 * MINUTE)).toBe('1d 5h')
    expect(countdown(28 * DAY)).toBe('28d')
  })

  it('has nothing to count once the time has passed', () => {
    expect(countdown(0)).toBeNull()
    expect(countdown(-MINUTE)).toBeNull()
  })
})
