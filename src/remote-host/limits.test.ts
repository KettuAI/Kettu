import { describe, expect, it } from 'vitest'
import {
  HandshakeLimits,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_PER_SOURCE,
  SOURCE_BURST,
  SOURCE_REFILL_MS,
  sourceOf,
  TOTAL_BURST,
  TOTAL_REFILL_MS,
} from './limits'

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
  it('caps in-flight handshakes per source without blocking other sources', () => {
    const limits = new HandshakeLimits({ now: () => 0 })
    const settles: (() => void)[] = []

    for (let i = 0; i < MAX_IN_FLIGHT_PER_SOURCE; i++) {
      const settle = limits.admit('192.168.1.20')
      expect(settle).not.toBeNull()
      settles.push(settle!)
    }

    // Same IPv4 and its IPv4-mapped IPv6 form share the per-source in-flight cap.
    expect(limits.admit('192.168.1.20')).toBeNull()
    expect(limits.admit('::ffff:192.168.1.20')).toBeNull()
    expect(limits.inFlight).toBe(MAX_IN_FLIGHT_PER_SOURCE)

    // Another source can still admit handshakes up to its own per-source cap.
    const otherSettles: (() => void)[] = []
    for (let i = 0; i < MAX_IN_FLIGHT_PER_SOURCE; i++) {
      const settle = limits.admit('192.168.1.21')
      expect(settle).not.toBeNull()
      otherSettles.push(settle!)
    }
    expect(limits.admit('192.168.1.21')).toBeNull()
    expect(limits.inFlight).toBe(MAX_IN_FLIGHT_PER_SOURCE * 2)

    for (const settle of [...settles, ...otherSettles]) settle()
    expect(limits.inFlight).toBe(0)
  })

  it('groups IPv6 addresses in the same /64 under one per-source in-flight cap', () => {
    const limits = new HandshakeLimits({ now: () => 0 })
    const settles: (() => void)[] = []

    for (let i = 0; i < MAX_IN_FLIGHT_PER_SOURCE; i++) {
      const settle = limits.admit(`2001:db8:1:2::${i + 1}`)
      expect(settle).not.toBeNull()
      settles.push(settle!)
    }

    expect(limits.admit('2001:db8:1:2:abcd::9')).toBeNull()
    const otherSubnet = limits.admit('2001:db8:1:3::1')
    expect(otherSubnet).not.toBeNull()

    for (const settle of settles) settle()
    otherSubnet!()
    expect(limits.inFlight).toBe(0)
  })

  it('does not spend source or total tokens when rejected by in-flight caps', () => {
    const limits = new HandshakeLimits({ now: () => 0 })
    const settles: (() => void)[] = []

    for (let i = 0; i < MAX_IN_FLIGHT_PER_SOURCE; i++) {
      settles.push(limits.admit('192.168.1.20')!)
    }

    // Repeated rejections while at the per-source in-flight cap must not drain tokens.
    for (let i = 0; i < SOURCE_BURST * 2; i++) {
      expect(limits.admit('192.168.1.20')).toBeNull()
    }

    for (const settle of settles) settle()

    // Remaining source burst is still intact after settling.
    expect(admitMany(limits, '192.168.1.20', SOURCE_BURST)).toBe(
      SOURCE_BURST - MAX_IN_FLIGHT_PER_SOURCE,
    )

    // Remaining total burst is also intact (only SOURCE_BURST handshakes were ever admitted).
    let otherAdmitted = 0
    for (let i = 0; i < TOTAL_BURST; i++) {
      otherAdmitted += admitMany(limits, `10.0.0.${i}`, 1)
    }
    expect(otherAdmitted).toBe(TOTAL_BURST - SOURCE_BURST)
  })

  it('releases per-source in-flight count idempotently on double settle', () => {
    const limits = new HandshakeLimits({ now: () => 0 })
    const settles = Array.from({ length: MAX_IN_FLIGHT_PER_SOURCE }, () =>
      limits.admit('192.168.1.30')!,
    )

    expect(limits.admit('192.168.1.30')).toBeNull()

    // Double-settling one handle frees only one slot, never two.
    settles[0]!()
    settles[0]!()
    expect(limits.inFlight).toBe(MAX_IN_FLIGHT_PER_SOURCE - 1)

    const replacement = limits.admit('192.168.1.30')
    expect(replacement).not.toBeNull()
    expect(limits.admit('192.168.1.30')).toBeNull()

    for (const settle of settles.slice(1)) settle()
    replacement!()
    replacement!()
    expect(limits.inFlight).toBe(0)

    // After all settle, the source can use its full per-source cap again (within token burst).
    const next = Array.from({ length: MAX_IN_FLIGHT_PER_SOURCE }, () =>
      limits.admit('192.168.1.30'),
    )
    expect(next.every((s) => s !== null)).toBe(true)
    for (const settle of next) settle!()
  })

  it('still enforces the global in-flight cap across distinct sources', () => {
    const limits = new HandshakeLimits({ now: () => 0 })
    const settles = Array.from({ length: MAX_IN_FLIGHT }, (_, i) => limits.admit(`10.0.0.${i}`)!)
    expect(limits.inFlight).toBe(MAX_IN_FLIGHT)
    expect(limits.admit('10.0.1.1')).toBeNull()

    settles[0]!()
    settles[0]!()
    expect(limits.inFlight).toBe(MAX_IN_FLIGHT - 1)
    const admitted = limits.admit('10.0.1.1')
    expect(admitted).not.toBeNull()
    expect(limits.admit('10.0.1.2')).toBeNull()

    for (const settle of settles.slice(1)) settle()
    admitted!()
    expect(limits.inFlight).toBe(0)
  })

  it('supports configuring maxInFlightPerSource', () => {
    const limits = new HandshakeLimits({ now: () => 0, maxInFlightPerSource: 2 })
    const a = limits.admit('192.168.1.40')
    const b = limits.admit('192.168.1.40')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(limits.admit('192.168.1.40')).toBeNull()
    a!()
    b!()
  })

  it('refills source and total token buckets over time', () => {
    let clock = 0
    const limits = new HandshakeLimits({ now: () => clock })
    expect(admitMany(limits, '192.168.1.20', SOURCE_BURST + 2)).toBe(SOURCE_BURST)
    clock += SOURCE_REFILL_MS - 1
    expect(admitMany(limits, '192.168.1.20', 1)).toBe(0)
    clock += 1
    expect(admitMany(limits, '192.168.1.20', 2)).toBe(1)

    clock += TOTAL_REFILL_MS * TOTAL_BURST
    let admitted = 0
    for (let i = 0; i < TOTAL_BURST + 5; i++) admitted += admitMany(limits, `10.1.0.${i}`, 1)
    expect(admitted).toBe(TOTAL_BURST)
    expect(admitMany(limits, '10.2.0.1', 1)).toBe(0)
    clock += TOTAL_REFILL_MS
    expect(admitMany(limits, '10.2.0.1', 1)).toBe(1)
  })
})

describe('sourceOf', () => {
  it.each([
    ['192.168.1.20', '192.168.1.20'],
    ['::ffff:192.168.1.20', '192.168.1.20'],
    ['::FFFF:192.168.1.20', '192.168.1.20'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002::6', '2001:db8:1:2::/64'],
    ['fd00::1', 'fd00:0:0:0::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('%s normalizes to %s', (address, source) => {
    expect(sourceOf(address)).toBe(source)
  })
})
