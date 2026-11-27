import { describe, expect, it } from 'vitest'
import {
  computePopPlacement,
  intersectRect,
  offscreenEdge,
  unionRects,
  type PopPlacementInput,
  type Rect,
} from './pop-place-layout'

const BASE: Omit<PopPlacementInput, 'anchor'> = {
  area: { width: 1000, height: 800 },
  popover: { width: 320, height: 180 },
  safeX: { lo: 8, hi: 992 },
  narrow: false,
}

describe('rect geometry helpers', () => {
  it('computes rect intersections and returns null for disjoint rects', () => {
    const vp: Rect = { left: 0, top: 0, right: 800, bottom: 600 }
    expect(intersectRect({ left: 100, top: -200, right: 400, bottom: 900 }, vp)).toEqual({
      left: 100,
      top: 0,
      right: 400,
      bottom: 600,
    })
    expect(intersectRect({ left: 100, top: -200, right: 400, bottom: 0 }, vp)).toBeNull()
    expect(intersectRect({ left: 820, top: 100, right: 920, bottom: 200 }, vp)).toBeNull()
  })

  it('computes union bounding boxes for multi-element selections', () => {
    expect(unionRects([])).toBeNull()
    expect(
      unionRects([
        { left: 100, top: 120, right: 260, bottom: 200 },
        { left: 180, top: 90, right: 420, bottom: 340 },
      ]),
    ).toEqual({ left: 100, top: 90, right: 420, bottom: 340 })
  })

  it('classifies offscreen edges across all four sides', () => {
    const vp: Rect = { left: 20, top: 40, right: 820, bottom: 640 }
    expect(offscreenEdge({ left: 100, top: 100, right: 200, bottom: 200 }, vp)).toBeNull()
    expect(offscreenEdge({ left: 100, top: -180, right: 200, bottom: 40 }, vp)).toBe('top')
    expect(offscreenEdge({ left: 100, top: 640, right: 200, bottom: 800 }, vp)).toBe('bottom')
    expect(offscreenEdge({ left: -200, top: 100, right: 20, bottom: 200 }, vp)).toBe('left')
    expect(offscreenEdge({ left: 820, top: 100, right: 980, bottom: 200 }, vp)).toBe('right')
  })
})

describe('computePopPlacement', () => {
  it('centers in the safe area when anchor is null', () => {
    const result = computePopPlacement({ ...BASE, anchor: null })
    expect(result.side).toBe('center')
    expect(result.offscreen).toBeNull()
    expect(result.width).toBe(320)
    expect(result.left).toBe(8 + (984 - 320) / 2)
    expect(result.top).toBe(80)
  })

  it('places outside the right edge of a short highlight box first, then left when right overflows', () => {
    const rightPlace = computePopPlacement({
      ...BASE,
      anchor: { left: 140, top: 200, right: 400, bottom: 280 },
    })
    expect(rightPlace).toEqual({
      left: 412,
      top: 200,
      width: 320,
      side: 'right',
      offscreen: null,
    })

    const leftPlace = computePopPlacement({
      ...BASE,
      anchor: { left: 680, top: 200, right: 960, bottom: 280 },
    })
    expect(leftPlace).toEqual({
      left: 348,
      top: 200,
      width: 320,
      side: 'left',
      offscreen: null,
    })
  })

  it('uses the visible intersection of a tall scrolling block so the popover stays outside and unobstructed', () => {
    const clip: Rect = { left: 10, top: 10, right: 990, bottom: 740 }
    // A tall narrow column whose top has scrolled 400 px above the iframe viewport.
    const tallColumn = computePopPlacement({
      ...BASE,
      clip,
      anchor: { left: 80, top: -400, right: 440, bottom: 1100 },
    })
    expect(tallColumn.side).toBe('right')
    expect(tallColumn.offscreen).toBeNull()
    expect(tallColumn.left).toBe(452)
    expect(tallColumn.top).toBe(52)

    // A full-width tall block spanning the whole viewport height: avoids sitting in the middle
    // and hugs the clear edge; once scrolled so its bottom enters view, moves cleanly below it.
    const fullWidthSpanning = computePopPlacement({
      ...BASE,
      clip,
      anchor: { left: 20, top: -300, right: 980, bottom: 1200 },
    })
    expect(fullWidthSpanning.offscreen).toBeNull()
    // Hugs the right safe edge instead of covering the middle of the reading column.
    expect(fullWidthSpanning.left).toBe(992 - 320)

    const bottomRevealed = computePopPlacement({
      ...BASE,
      clip,
      anchor: { left: 20, top: -800, right: 980, bottom: 420 },
    })
    expect(bottomRevealed.side).toBe('bottom')
    expect(bottomRevealed.offscreen).toBeNull()
    expect(bottomRevealed.top).toBe(432)

    const topRevealed = computePopPlacement({
      ...BASE,
      clip,
      anchor: { left: 20, top: 360, right: 980, bottom: 1600 },
    })
    expect(topRevealed.side).toBe('top')
    expect(topRevealed.offscreen).toBeNull()
    expect(topRevealed.top).toBe(360 - 12 - 180)
  })

  it('clamps inside side-card safe bounds and narrow viewports without overflowing', () => {
    const withRightCard = computePopPlacement({
      ...BASE,
      safeX: { lo: 8, hi: 660 },
      anchor: { left: 320, top: 200, right: 560, bottom: 260 },
    })
    // Right of anchor (572 + 320) exceeds right card bound 660, and left (320 - 12 - 320) < 8,
    // so it falls back cleanly below the anchor inside [8, 660].
    expect(withRightCard.side).toBe('bottom')
    expect(withRightCard.left).toBeGreaterThanOrEqual(8)
    expect(withRightCard.left + withRightCard.width).toBeLessThanOrEqual(660)
    expect(withRightCard.top).toBe(272)

    const narrow = computePopPlacement({
      area: { width: 340, height: 600 },
      popover: { width: 320, height: 180 },
      safeX: { lo: 8, hi: 332 },
      narrow: true,
      anchor: { left: 20, top: 450, right: 300, bottom: 520 },
    })
    expect(narrow.side).toBe('top')
    expect(narrow.left).toBeGreaterThanOrEqual(8)
    expect(narrow.left + narrow.width).toBeLessThanOrEqual(332)
    expect(narrow.top).toBe(450 - 12 - 180)
  })

  it('docks cleanly at top, bottom, left, and right edges with offscreen indicator when anchor leaves view', () => {
    const clip: Rect = { left: 20, top: 20, right: 980, bottom: 720 }

    const topOff = computePopPlacement({
      ...BASE,
      clip,
      anchor: { left: 100, top: -400, right: 400, bottom: -20 },
    })
    expect(topOff.side).toBe('dock')
    expect(topOff.offscreen).toBe('top')
    // Preserves its exterior horizontal alignment when scrolling past the top edge.
    expect(topOff.left).toBe(412)
    expect(topOff.top).toBe(52)

    const bottomOff = computePopPlacement({
      ...BASE,
      clip,
      anchor: { left: 100, top: 760, right: 400, bottom: 920 },
    })
    expect(bottomOff.side).toBe('dock')
    expect(bottomOff.offscreen).toBe('bottom')
    expect(bottomOff.left).toBe(412)
    expect(bottomOff.top + 180).toBeLessThanOrEqual(720 - 8)

    const leftOff = computePopPlacement({
      ...BASE,
      clip,
      anchor: { left: -300, top: 220, right: -40, bottom: 320 },
    })
    expect(leftOff.side).toBe('dock')
    expect(leftOff.offscreen).toBe('left')
    expect(leftOff.left).toBe(28)
    expect(leftOff.top).toBe(220)

    const rightOff = computePopPlacement({
      ...BASE,
      clip,
      anchor: { left: 1040, top: 220, right: 1260, bottom: 320 },
    })
    expect(rightOff.side).toBe('dock')
    expect(rightOff.offscreen).toBe('right')
    expect(rightOff.left + rightOff.width).toBe(972)
    expect(rightOff.top).toBe(220)
  })

  it('supports placing beside a multi-selection union rect cleanly', () => {
    const group = unionRects([
      { left: 100, top: 120, right: 260, bottom: 220 },
      { left: 280, top: 160, right: 440, bottom: 340 },
    ])
    const placed = computePopPlacement({ ...BASE, anchor: group })
    expect(placed).toEqual({
      left: 452,
      top: 120,
      width: 320,
      side: 'right',
      offscreen: null,
    })
  })
})
