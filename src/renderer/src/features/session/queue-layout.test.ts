import { describe, expect, it } from 'vitest'
import {
  BEHIND,
  CARD,
  STEP,
  clampOffset,
  foldedPose,
  openPose,
  reserveHeight,
  shownRange,
  snapOffset,
  stackHeight,
} from './queue-layout'

describe('foldedPose', () => {
  it('shows the next message with two edges above it', () => {
    expect(foldedPose(0).y).toBeCloseTo(0)
    expect(foldedPose(0)).toMatchObject({ scale: 1, opacity: 1, content: 1, depth: 0 })
    expect(foldedPose(1)).toMatchObject({ y: -6, opacity: 1, content: 0 })
    expect(foldedPose(2)).toMatchObject({ y: -12, opacity: 1, content: 0, depth: 1 })
    expect(foldedPose(3)).toMatchObject({ y: -12, opacity: 0, interactive: false })
  })

  it('keeps the front card on top', () => {
    expect(foldedPose(0).z).toBeGreaterThan(foldedPose(1).z)
  })
})

describe('openPose', () => {
  it('fans three cards out a step apart, narrower and faded toward the back', () => {
    const [a, b, c] = [0, 1, 2].map((i) => openPose(i, 0))
    expect(a!.y).toBeCloseTo(0)
    expect([b!.y, c!.y]).toEqual([-STEP, -2 * STEP])
    expect(a!.scale).toBeGreaterThan(b!.scale)
    expect(b!.scale).toBeGreaterThan(c!.scale)
    expect(a!.depth).toBe(0)
    expect(c!.depth).toBeGreaterThan(b!.depth)
    expect([a, b, c].every((p) => p!.opacity === 1 && p!.interactive)).toBe(true)
  })

  it('shows an edge of the fourth card and hides the rest', () => {
    const fourth = openPose(3, 0)
    expect(fourth.y).toBeLessThan(-2 * STEP)
    expect(fourth.opacity).toBe(1)
    expect(fourth.content).toBe(0)
    expect(fourth.interactive).toBe(false)
    expect(openPose(4, 0).opacity).toBe(0)
  })

  it('slides a card the offset has passed down behind the composer', () => {
    expect(openPose(0, 1)).toMatchObject({ y: BEHIND, opacity: 0, interactive: false })
    expect(openPose(1, 1).y).toBeCloseTo(0)
    expect(openPose(1, 1)).toMatchObject({ opacity: 1, content: 1 })
    const half = openPose(0, 0.5)
    expect(half.y).toBeCloseTo(BEHIND / 2)
    expect(half.opacity).toBeCloseTo(0.5)
  })

  it('moves continuously between whole offsets', () => {
    for (const i of [0, 1, 2, 3, 4]) {
      const before = openPose(i, 0.999)
      const after = openPose(i, 1.001)
      expect(Math.abs(before.y - after.y)).toBeLessThan(0.1)
      expect(Math.abs(before.opacity - after.opacity)).toBeLessThan(0.01)
    }
  })
})

describe('heights', () => {
  it('reserves the folded stack above the composer', () => {
    expect(reserveHeight(1)).toBe(STEP)
    expect(reserveHeight(2)).toBe(STEP + 6)
    expect(reserveHeight(5)).toBe(STEP + 12)
  })

  it('grows to three cards and an edge when fanned out', () => {
    expect(stackHeight(1, true)).toBe(CARD)
    expect(stackHeight(3, true)).toBe(CARD + 2 * STEP)
    expect(stackHeight(9, true)).toBe(CARD + 2 * STEP + 6)
    expect(stackHeight(9, false)).toBe(CARD + 12)
  })
})

describe('offsets', () => {
  it('give a quarter card past either end while the wheel turns', () => {
    expect(clampOffset(-3, 4)).toBe(-0.25)
    expect(clampOffset(9, 4)).toBe(3.25)
    expect(clampOffset(1.4, 4)).toBe(1.4)
  })

  it('settle on a whole card inside the queue', () => {
    expect(snapOffset(-0.25, 4)).toBe(0)
    expect(snapOffset(3.25, 4)).toBe(3)
    expect(snapOffset(1.6, 4)).toBe(2)
  })

  it('render only the cards that can show, and one beyond', () => {
    expect(shownRange(10, false, 0)).toEqual([0, 3])
    expect(shownRange(2, false, 0)).toEqual([0, 2])
    expect(shownRange(10, true, 0)).toEqual([0, 5])
    expect(shownRange(10, true, 3.5)).toEqual([2, 9])
    expect(shownRange(4, true, 3)).toEqual([2, 4])
  })
})
