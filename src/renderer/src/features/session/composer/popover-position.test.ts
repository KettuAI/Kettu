import { describe, expect, it } from 'vitest'
import {
  POPOVER_COMFORTABLE_ABOVE,
  POPOVER_MAX_HEIGHT,
  POPOVER_MIN_ABOVE,
  POPOVER_SIDE_OFFSET,
  clampTriggerRect,
  resolvePopoverPlacement,
  viewportBounds,
  type BoxRect,
} from './popover-position'

const desktopViewport = (height: number) => viewportBounds(height, { top: 40, bottom: 5 })
const webViewport = (height: number) => viewportBounds(height)

function availableHeight(
  placement: ReturnType<typeof resolvePopoverPlacement>,
  viewport: { top: number; bottom: number },
): number {
  return placement.side === 'top'
    ? Math.max(0, placement.anchor.y - viewport.top - POPOVER_SIDE_OFFSET)
    : Math.max(
        0,
        viewport.bottom - (placement.anchor.y + placement.anchor.height) - POPOVER_SIDE_OFFSET,
      )
}

describe('viewportBounds', () => {
  it('uses Base UI default 5 px insets when no padding is passed', () => {
    expect(webViewport(800)).toEqual({ top: 5, bottom: 795 })
  })

  it('respects desktop titlebar top padding', () => {
    expect(desktopViewport(800)).toEqual({ top: 40, bottom: 795 })
  })

  it('accepts uniform numeric padding and clamps bottom to top on tiny windows', () => {
    expect(viewportBounds(600, 12)).toEqual({ top: 12, bottom: 588 })
    expect(viewportBounds(20, { top: 40, bottom: 5 })).toEqual({ top: 40, bottom: 40 })
  })
})

describe('clampTriggerRect', () => {
  const scroller: BoxRect = { top: 120, bottom: 440, left: 100, right: 700 }

  it('returns null when no trigger rect is available', () => {
    expect(clampTriggerRect(null, scroller)).toBeNull()
  })

  it('preserves a trigger fully inside the scroller', () => {
    const trigger: BoxRect = { top: 400, bottom: 424, left: 260, right: 270 }
    expect(clampTriggerRect(trigger, scroller)).toEqual(trigger)
  })

  it('clamps a trigger scrolled above the top edge into the top line of the scroller', () => {
    const trigger: BoxRect = { top: 40, bottom: 64, left: 260, right: 270 }
    expect(clampTriggerRect(trigger, scroller)).toEqual({
      top: 120,
      bottom: 144,
      left: 260,
      right: 270,
    })
  })

  it('clamps a trigger scrolled below the bottom edge into the bottom line of the scroller', () => {
    const trigger: BoxRect = { top: 520, bottom: 544, left: 260, right: 270 }
    expect(clampTriggerRect(trigger, scroller)).toEqual({
      top: 416,
      bottom: 440,
      left: 260,
      right: 270,
    })
  })

  it('clips a partially visible trigger and clamps horizontal bounds', () => {
    const trigger: BoxRect = { top: 110, bottom: 134, left: 750, right: 760 }
    expect(clampTriggerRect(trigger, scroller)).toEqual({
      top: 120,
      bottom: 134,
      left: 700,
      right: 700,
    })
  })

  it('ignores an unmeasured zero-size scroller', () => {
    const trigger: BoxRect = { top: 200, bottom: 224, left: 150, right: 160 }
    expect(clampTriggerRect(trigger, { top: 0, bottom: 0, left: 0, right: 0 })).toEqual(trigger)
  })
})

describe('resolvePopoverPlacement', () => {
  it('docks mentions above the box top when plenty of room exists above the composer', () => {
    const viewport = desktopViewport(820)
    const box: BoxRect = { top: 620, bottom: 680, left: 120, right: 760 }
    const trigger: BoxRect = { top: 650, bottom: 674, left: 310, right: 320 }

    const placement = resolvePopoverPlacement({ kind: 'mention', box, trigger, viewport })

    expect(placement).toEqual({
      side: 'top',
      anchor: { x: 310, y: 620, width: 450, height: 60 },
    })
    expect(availableHeight(placement, viewport)).toBeGreaterThanOrEqual(POPOVER_MAX_HEIGHT)
  })

  it('anchors mentions above the caret line when a tall composer squeezes the space above the box', () => {
    const viewport = desktopViewport(760)
    // Tall composer leaving only 84 px above its top edge, with `@` typed on the bottom line.
    const box: BoxRect = { top: 130, bottom: 520, left: 120, right: 760 }
    const trigger: BoxRect = { top: 490, bottom: 514, left: 340, right: 350 }

    const placement = resolvePopoverPlacement({ kind: 'mention', box, trigger, viewport })

    expect(placement).toEqual({
      side: 'top',
      anchor: { x: 340, y: 490, width: 420, height: 24 },
    })
    expect(availableHeight(placement, viewport)).toBe(444)
    expect(Math.min(availableHeight(placement, viewport), POPOVER_MAX_HEIGHT)).toBe(
      POPOVER_MAX_HEIGHT,
    )
  })

  it('flips below the caret line when a tall composer is open with the caret near its top line', () => {
    const viewport = desktopViewport(760)
    // Tall composer near the top of the viewport, caret on line 1 (only 89 px above, 590 px below).
    const box: BoxRect = { top: 130, bottom: 520, left: 120, right: 760 }
    const trigger: BoxRect = { top: 135, bottom: 159, left: 200, right: 210 }

    const placement = resolvePopoverPlacement({ kind: 'mention', box, trigger, viewport })

    expect(placement).toEqual({
      side: 'bottom',
      anchor: { x: 200, y: 135, width: 560, height: 24 },
    })
    expect(availableHeight(placement, viewport)).toBe(590)
  })

  it('keeps New Session popovers above the box when room above is moderate (clear of Send)', () => {
    const viewport = desktopViewport(640)
    // Centered New Session composer with 224 px above (between MIN_ABOVE and COMFORTABLE_ABOVE).
    const box: BoxRect = { top: 270, bottom: 330, left: 120, right: 760 }
    const trigger: BoxRect = { top: 270, bottom: 294, left: 180, right: 190 }

    const placement = resolvePopoverPlacement({ kind: 'slash', box, trigger, viewport })

    expect(placement.side).toBe('top')
    expect(availableHeight(placement, viewport)).toBe(224)
    expect(availableHeight(placement, viewport)).toBeGreaterThanOrEqual(POPOVER_MIN_ABOVE)
    expect(availableHeight(placement, viewport)).toBeLessThan(POPOVER_COMFORTABLE_ABOVE)
    // Slash preserves full box width for `w-[min(var(--anchor-width),540px)]`.
    expect(placement.anchor.x).toBe(box.left)
    expect(placement.anchor.width).toBe(box.right - box.left)
  })

  it('anchors slash popovers at the trigger line while keeping the box width on tall composers', () => {
    const viewport = desktopViewport(760)
    const box: BoxRect = { top: 140, bottom: 520, left: 120, right: 760 }
    const trigger: BoxRect = { top: 480, bottom: 504, left: 290, right: 298 }

    const placement = resolvePopoverPlacement({ kind: 'slash', box, trigger, viewport })

    expect(placement).toEqual({
      side: 'top',
      anchor: { x: 120, y: 480, width: 640, height: 24 },
    })
    expect(availableHeight(placement, viewport)).toBe(434)
  })

  it('rescues a scrolled New Session box whose top edge is above the viewport', () => {
    const viewport = desktopViewport(760)
    const box: BoxRect = { top: -80, bottom: 360, left: 120, right: 760 }
    const trigger: BoxRect = { top: 320, bottom: 344, left: 260, right: 270 }

    const placement = resolvePopoverPlacement({ kind: 'mention', box, trigger, viewport })

    expect(placement).toEqual({
      side: 'top',
      anchor: { x: 260, y: 320, width: 500, height: 24 },
    })
    expect(availableHeight(placement, viewport)).toBe(274)
  })

  it('stays on top when both sides are tight and above still has at least as much room', () => {
    const viewport = webViewport(380)
    const box: BoxRect = { top: 200, bottom: 260, left: 16, right: 360 }
    const trigger: BoxRect = { top: 200, bottom: 224, left: 40, right: 50 }

    const placement = resolvePopoverPlacement({ kind: 'mention', box, trigger, viewport })

    // Above: 200 - 5 - 6 = 189 px; below: 375 - 224 - 6 = 145 px.
    expect(placement.side).toBe('top')
    expect(availableHeight(placement, viewport)).toBe(189)
  })

  it('keeps compact single-line slash notes above the box when they fit', () => {
    const viewport = desktopViewport(500)
    // Only 110 px above the box: too small for a multi-row list, plenty for a single-line note.
    const box: BoxRect = { top: 156, bottom: 216, left: 120, right: 760 }
    const trigger: BoxRect = { top: 156, bottom: 180, left: 120, right: 128 }

    const placement = resolvePopoverPlacement({
      kind: 'slash',
      box,
      trigger,
      viewport,
      compact: true,
    })

    expect(placement).toEqual({
      side: 'top',
      anchor: { x: 120, y: 156, width: 640, height: 60 },
    })
  })

  it('falls back gracefully when the trigger rect is unavailable', () => {
    const viewport = desktopViewport(760)
    const box: BoxRect = { top: 120, bottom: 220, left: 120, right: 760 }

    const placement = resolvePopoverPlacement({ kind: 'mention', box, trigger: null, viewport })

    // Above: 74 px; below: 755 - 220 - 6 = 529 px.
    expect(placement).toEqual({
      side: 'bottom',
      anchor: { x: 120, y: 120, width: 640, height: 100 },
    })
  })

  it('clamps mention horizontal anchor inside the box', () => {
    const viewport = desktopViewport(820)
    const box: BoxRect = { top: 620, bottom: 680, left: 120, right: 760 }
    const trigger: BoxRect = { top: 650, bottom: 674, left: 900, right: 910 }

    const placement = resolvePopoverPlacement({ kind: 'mention', box, trigger, viewport })

    expect(placement.anchor.x).toBe(760)
    expect(placement.anchor.width).toBe(0)
  })
})
