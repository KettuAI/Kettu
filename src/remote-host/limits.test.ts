import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HandshakeLimits,
  MAX_IN_FLIGHT,
  SOURCE_BURST,
  SOURCE_REFILL_MS,
  sourceOf,
  TOTAL_BURST,
  TOTAL_REFILL_MS,
} from './limits'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Admits `count` handshakes from `address`, settling each at once; returns how many got in. */
function admitMany(limits: HandshakeLimits, address: string, count: number): number {
  let admitted = 0
  for (let i = 0; i < count; i++) {
    const settle = limits.admit(address)
    if (!settle) continue
    admitted++
    settle()
  }
  return admitted
}

describe('HandshakeLimits', () => {
  it('holds one source back after its burst, then lets one in per refill', () => {
    const limits = new HandshakeLimits()
    expect(admitMany(limits, '192.168.1.20', SOURCE_BURST + 5)).toBe(SOURCE_BURST)
    // Another source, as a second device on the network, is not held back by the first.
    expect(admitMany(limits, '192.168.1.21', 1)).toBe(1)
    vi.advanceTimersByTime(SOURCE_REFILL_MS - 1)
    expect(admitMany(limits, '192.168.1.20', 1)).toBe(0)
    vi.advanceTimersByTime(1)
    expect(admitMany(limits, '192.168.1.20', 2)).toBe(1)
    vi.advanceTimersByTime(SOURCE_REFILL_MS * SOURCE_BURST)
    expect(admitMany(limits, '192.168.1.20', SOURCE_BURST + 1)).toBe(SOURCE_BURST)
  })

  it('holds every source back once the total is spent', () => {
    const limits = new HandshakeLimits()
    let admitted = 0
    for (let i = 0; i < TOTAL_BURST + 10; i++) admitted += admitMany(limits, `10.0.0.${i}`, 1)
    expect(admitted).toBe(TOTAL_BURST)
    expect(admitMany(limits, '10.1.0.1', 1)).toBe(0)
    vi.advanceTimersByTime(TOTAL_REFILL_MS)
    expect(admitMany(limits, '10.1.0.1', 1)).toBe(1)
    expect(admitMany(limits, '10.1.0.2', 1)).toBe(0)
  })

  it('caps the handshakes waiting at once until they settle', () => {
    const limits = new HandshakeLimits()
    const settles = Array.from({ length: MAX_IN_FLIGHT }, (_, i) => limits.admit(`10.0.0.${i}`)!)
    expect(limits.inFlight).toBe(MAX_IN_FLIGHT)
    expect(limits.admit('10.0.1.1')).toBeNull()
    settles[0]!()
    settles[0]!()
    expect(limits.inFlight).toBe(MAX_IN_FLIGHT - 1)
    expect(limits.admit('10.0.1.1')).not.toBeNull()
    expect(limits.admit('10.0.1.2')).toBeNull()
  })

  it('counts connections forwarded from one address as one source', () => {
    const limits = new HandshakeLimits()
    expect(admitMany(limits, '::ffff:203.0.113.7', SOURCE_BURST)).toBe(SOURCE_BURST)
    expect(admitMany(limits, '203.0.113.7', 1)).toBe(0)
    expect(admitMany(limits, '2001:db8:1:2::1', SOURCE_BURST)).toBe(SOURCE_BURST)
    expect(admitMany(limits, '2001:db8:1:2:abcd::9', 1)).toBe(0)
    expect(admitMany(limits, '2001:db8:1:3::1', 1)).toBe(1)
  })
})

describe('sourceOf', () => {
  it.each([
    ['192.168.1.20', '192.168.1.20'],
    ['::ffff:192.168.1.20', '192.168.1.20'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002::6', '2001:db8:1:2::/64'],
    ['fd00::1', 'fd00:0:0:0::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('%s is %s', (address, source) => {
    expect(sourceOf(address)).toBe(source)
  })
})
