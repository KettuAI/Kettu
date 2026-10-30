import { describe, expect, it } from 'vitest'
import { lockupGeometry, WORDMARK } from './brand'

describe('lockupGeometry', () => {
  it('keeps the horizontal proportions', () => {
    const g = lockupGeometry('horizontal')
    expect(g.icon.size).toBeCloseTo(160)
    expect(g.text.x - g.icon.size).toBeCloseTo(40)
    expect(g.width).toBe(g.text.x + WORDMARK.advance)
    // The icon and the wordmark's line box share a centre.
    expect(g.icon.y + g.icon.size / 2).toBeCloseTo(g.height / 2)
  })

  it('keeps the vertical proportions', () => {
    const g = lockupGeometry('vertical')
    expect(g.icon.size).toBeCloseTo(300)
    expect(g.height - 100 - g.icon.size).toBeCloseTo(50)
    expect(g.icon.x + g.icon.size / 2).toBeCloseTo(g.width / 2)
    expect(g.text.x + WORDMARK.advance / 2).toBeCloseTo(g.width / 2)
  })
})
