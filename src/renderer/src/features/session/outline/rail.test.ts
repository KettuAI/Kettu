import { describe, expect, it } from 'vitest'
import { dashCount, dashOf, readingAt } from './rail'

describe('the outline rail', () => {
  it('draws a dash per message while they fit in half the viewport', () => {
    // 6 px a dash with its gap, the last without one: 50 dashes take 296 px.
    expect(dashCount(24, 800)).toBe(24)
    expect(dashCount(300, 600)).toBe(50)
    expect(dashCount(300, 10)).toBe(1)
    expect(dashCount(0, 800)).toBe(0)
  })

  it('spreads the messages evenly over the dashes', () => {
    expect(dashOf(7, 24, 24)).toBe(7)
    const counts = new Array<number>(50).fill(0)
    for (let i = 0; i < 300; i++) counts[dashOf(i, 300, 50)]!++
    expect(counts.every((count) => count === 6)).toBe(true)
    expect(dashOf(0, 301, 50)).toBe(0)
    expect(dashOf(300, 301, 50)).toBe(49)
  })

  it('reads at the last message past the line, counting those not rendered as past', () => {
    const ids = ['a', 'b', 'c', 'd']
    const all = new Set(ids)
    expect(readingAt(ids, all, new Set())).toBe('a')
    expect(readingAt(ids, all, new Set(['a', 'b']))).toBe('b')
    expect(readingAt(ids, new Set(['c', 'd']), new Set())).toBe('b')
    expect(readingAt([], all, new Set())).toBeNull()
  })
})
