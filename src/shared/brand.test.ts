import { describe, expect, it } from 'vitest'
import { lockupGeometry, MARK_BOX, markVersionFor, WORDMARK } from './brand'

describe('markVersionFor', () => {
  it('takes the small version below 48 px', () => {
    expect(markVersionFor(16)).toBe('small')
    expect(markVersionFor(47.9)).toBe('small')
    expect(markVersionFor(48)).toBe('standard')
  })
})

describe('lockupGeometry', () => {
  it('keeps the horizontal proportions', () => {
    const g = lockupGeometry('horizontal')
    expect(g.mark.width).toBe(195)
    expect(g.text.x - g.mark.width).toBe(45)
    expect(g.width).toBe(g.text.x + WORDMARK.advance)
    // The mark and the wordmark's line box share a centre.
    expect(g.mark.y + g.mark.height / 2).toBeCloseTo(g.height / 2)
  })

  it('keeps the vertical proportions', () => {
    const g = lockupGeometry('vertical')
    expect(g.mark.width).toBe(330)
    expect(g.mark.height).toBeCloseTo((330 * MARK_BOX.height) / MARK_BOX.width)
    expect(g.height - 100 - g.mark.height).toBeCloseTo(60)
    expect(g.mark.x + g.mark.width / 2).toBeCloseTo(g.width / 2)
    expect(g.text.x + WORDMARK.advance / 2).toBeCloseTo(g.width / 2)
  })
})
