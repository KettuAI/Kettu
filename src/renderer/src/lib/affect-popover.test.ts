import { describe, expect, it } from 'vitest'
import { css as appShellCss } from '@renderer/components/affect/app-shell'
import {
  POPOVER_GAP,
  POPOVER_MARGIN,
  intersectClipAxes,
  resolveHorizontalPlacement,
  resolvePopoverLayout,
  type PopoverRect,
} from './affect-popover'

/** Computes the rendered popover bounds inside the clip box for verification assertions. */
function renderedBounds(
  layout: ReturnType<typeof resolvePopoverLayout>,
  anchor: PopoverRect,
  contentWidth: number,
  contentHeight: number,
) {
  const height =
    layout.maxHeight === null ? contentHeight : Math.min(contentHeight, layout.maxHeight)
  const top =
    layout.side === 'bottom'
      ? anchor.bottom + POPOVER_GAP + layout.dy
      : layout.side === 'top'
        ? anchor.top - POPOVER_GAP - height + layout.dy
        : anchor.bottom - height + layout.dy
  const bottom = top + height
  const left =
    layout.side === 'right'
      ? anchor.right + 12 + layout.dx
      : layout.align === 'start'
        ? anchor.left + layout.dx
        : anchor.right - contentWidth + layout.dx
  const right = left + contentWidth
  return { top, right, bottom, left, height }
}

describe('intersectClipAxes', () => {
  const viewport: PopoverRect = { top: 0, right: 1280, bottom: 800, left: 0 }

  it('intersects both axes when both overflowX and overflowY clip', () => {
    const modal: PopoverRect = { top: 56, right: 1170, bottom: 744, left: 110 }
    expect(intersectClipAxes(viewport, modal, true, true)).toEqual(modal)
  })

  it('intersects only the clipping axis so horizontal-only clips do not constrain height', () => {
    const narrowTall: PopoverRect = { top: 200, right: 900, bottom: 260, left: 200 }
    expect(intersectClipAxes(viewport, narrowTall, true, false)).toEqual({
      top: 0,
      right: 900,
      bottom: 800,
      left: 200,
    })
  })

  it('clamps non-overlapping intersections to empty non-inverted rects', () => {
    const outside: PopoverRect = { top: 900, right: 2000, bottom: 1200, left: 1500 }
    const result = intersectClipAxes(viewport, outside, true, true)
    expect(result.right).toBe(result.left)
    expect(result.bottom).toBe(result.top)
  })
})

describe('resolvePopoverLayout', () => {
  // Typical Settings modal `.kettu-settings__page` bounds on a 1280x800 desktop window.
  const settingsClip: PopoverRect = { top: 56, right: 1170, bottom: 744, left: 346 }

  it('flips upward and clamps maxHeight inside the clip box when many projects overflow below', () => {
    // ProjectPicker sits in the lower half of Settings › Memory with ~15 rich items (44px each).
    const anchor: PopoverRect = { top: 520, right: 980, bottom: 552, left: 770 }
    const contentWidth = 220
    const contentHeight = 15 * 45 + 8 // 683px

    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'end',
      anchor,
      clip: settingsClip,
      contentWidth,
      contentHeight,
    })

    // Below room: 744 - 552 - 6 - 8 = 178px; above room: 520 - 56 - 6 - 8 = 450px.
    expect(layout.side).toBe('top')
    expect(layout.align).toBe('end')
    expect(layout.overflow).toBe(true)
    expect(layout.maxHeight).toBe(450)
    expect(layout.dy).toBe(0)

    const bounds = renderedBounds(layout, anchor, contentWidth, contentHeight)
    expect(bounds.top).toBeGreaterThanOrEqual(settingsClip.top + POPOVER_MARGIN)
    expect(bounds.bottom).toBeLessThanOrEqual(settingsClip.bottom - POPOVER_MARGIN)
    expect(bounds.height).toBe(450)
  })

  it('picks the larger side instead of flipping into a cramped space above when both sides overflow', () => {
    // Trigger near the top of the settings pane: 578px below vs only 50px above.
    const anchor: PopoverRect = { top: 120, right: 980, bottom: 152, left: 770 }
    const contentWidth = 220
    const contentHeight = 683

    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'end',
      anchor,
      clip: settingsClip,
      contentWidth,
      contentHeight,
    })

    expect(layout.side).toBe('bottom')
    expect(layout.overflow).toBe(true)
    expect(layout.maxHeight).toBe(578)
    expect(layout.dy).toBe(0)

    const bounds = renderedBounds(layout, anchor, contentWidth, contentHeight)
    expect(bounds.top).toBeGreaterThanOrEqual(settingsClip.top + POPOVER_MARGIN)
    expect(bounds.bottom).toBeLessThanOrEqual(settingsClip.bottom - POPOVER_MARGIN)
  })

  it('keeps the preferred side when both sides overflow equally', () => {
    const clip: PopoverRect = { top: 0, right: 800, bottom: 400, left: 0 }
    // Centered anchor: 184 - 6 - 8 = 170px above, 400 - 216 - 6 - 8 = 170px below.
    const anchor: PopoverRect = { top: 184, right: 300, bottom: 216, left: 100 }

    const bottomPreferred = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'start',
      anchor,
      clip,
      contentWidth: 200,
      contentHeight: 500,
    })
    expect(bottomPreferred.side).toBe('bottom')
    expect(bottomPreferred.maxHeight).toBe(170)
    expect(bottomPreferred.overflow).toBe(true)

    const topPreferred = resolvePopoverLayout({
      preferredSide: 'top',
      preferredAlign: 'start',
      anchor,
      clip,
      contentWidth: 200,
      contentHeight: 500,
    })
    expect(topPreferred.side).toBe('top')
    expect(topPreferred.maxHeight).toBe(170)
    expect(topPreferred.overflow).toBe(true)
  })

  it('keeps short menus at full natural height with overflow=false and no unnecessary scrollbar', () => {
    const anchor: PopoverRect = { top: 240, right: 980, bottom: 272, left: 770 }
    const contentHeight = 140

    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'end',
      anchor,
      clip: settingsClip,
      contentWidth: 210,
      contentHeight,
    })

    expect(layout.side).toBe('bottom')
    expect(layout.overflow).toBe(false)
    expect(layout.maxHeight).toBeGreaterThanOrEqual(contentHeight)
    expect(layout.dy).toBe(0)

    const bounds = renderedBounds(layout, anchor, 210, contentHeight)
    expect(bounds.height).toBe(contentHeight)
  })

  it('flips a short menu cleanly without overflow when it fits on the opposite side', () => {
    const anchor: PopoverRect = { top: 620, right: 980, bottom: 652, left: 770 }
    const contentHeight = 180

    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'end',
      anchor,
      clip: settingsClip,
      contentWidth: 210,
      contentHeight,
    })

    // Below has 78px (< 180px), above has 550px (>= 180px).
    expect(layout.side).toBe('top')
    expect(layout.overflow).toBe(false)
    expect(layout.maxHeight).toBe(550)
  })

  it('clamps top-preferred sidebar popovers when the window is very short', () => {
    const shortViewport: PopoverRect = { top: 0, right: 1024, bottom: 280, left: 0 }
    const anchor: PopoverRect = { top: 232, right: 260, bottom: 268, left: 12 }

    const layout = resolvePopoverLayout({
      preferredSide: 'top',
      preferredAlign: 'start',
      anchor,
      clip: shortViewport,
      contentWidth: 260,
      contentHeight: 360,
    })

    // Above: 232 - 0 - 6 - 8 = 218px; below: 0px.
    expect(layout.side).toBe('top')
    expect(layout.overflow).toBe(true)
    expect(layout.maxHeight).toBe(218)

    const bounds = renderedBounds(layout, anchor, 260, 360)
    expect(bounds.top).toBe(POPOVER_MARGIN)
    expect(bounds.bottom).toBe(anchor.top - POPOVER_GAP)
  })

  it('handles scaled ancestor containers accurately', () => {
    const clip: PopoverRect = { top: 0, right: 1000, bottom: 600, left: 0 }
    const anchor: PopoverRect = { top: 400, right: 500, bottom: 440, left: 300 }

    // 2x visual scale: 400px above in viewport pixels => 200px in CSS pixels minus 6 gap minus 8 margin = 186px.
    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'start',
      anchor,
      clip,
      contentWidth: 200,
      contentHeight: 300,
      scaleX: 2,
      scaleY: 2,
    })

    expect(layout.side).toBe('top')
    expect(layout.overflow).toBe(true)
    expect(layout.maxHeight).toBe(186)
  })

  it('keeps right-side popovers within vertical clip bounds and slides down when near the top', () => {
    const clip: PopoverRect = { top: 0, right: 1000, bottom: 400, left: 0 }
    const anchor: PopoverRect = { top: 40, right: 200, bottom: 72, left: 40 }

    const layout = resolvePopoverLayout({
      preferredSide: 'right',
      preferredAlign: 'start',
      anchor,
      clip,
      contentWidth: 240,
      contentHeight: 260,
    })

    expect(layout.side).toBe('right')
    expect(layout.overflow).toBe(false)
    expect(layout.maxHeight).toBe(384)
    const bounds = renderedBounds(layout, anchor, 240, 260)
    expect(bounds.top).toBeGreaterThanOrEqual(clip.top + POPOVER_MARGIN)
    expect(bounds.bottom).toBeLessThanOrEqual(clip.bottom - POPOVER_MARGIN)
  })

  it('shifts vertically inside clip bounds if the anchor is partially scrolled past the top edge', () => {
    const anchor: PopoverRect = { top: 20, right: 980, bottom: 52, left: 770 }
    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'end',
      anchor,
      clip: settingsClip,
      contentWidth: 220,
      contentHeight: 700,
    })

    expect(layout.side).toBe('bottom')
    expect(layout.overflow).toBe(true)
    const bounds = renderedBounds(layout, anchor, 220, 700)
    expect(bounds.top).toBeGreaterThanOrEqual(settingsClip.top + POPOVER_MARGIN)
    expect(bounds.bottom).toBeLessThanOrEqual(settingsClip.bottom - POPOVER_MARGIN)
  })

  it('returns unconstrained defaults when clip box has zero dimensions', () => {
    const empty: PopoverRect = { top: 0, right: 0, bottom: 0, left: 0 }
    const anchor: PopoverRect = { top: 100, right: 200, bottom: 132, left: 100 }
    expect(
      resolvePopoverLayout({
        preferredSide: 'bottom',
        preferredAlign: 'end',
        anchor,
        clip: empty,
        contentWidth: 200,
        contentHeight: 400,
      }),
    ).toEqual({
      side: 'bottom',
      align: 'end',
      maxHeight: null,
      overflow: false,
      dx: 0,
      dy: 0,
    })
  })
})

describe('resolveHorizontalPlacement', () => {
  it('flips alignment when preferred side overflows horizontally and shifts on narrow clips', () => {
    const clip: PopoverRect = { top: 0, right: 320, bottom: 600, left: 0 }
    const anchor: PopoverRect = { top: 100, right: 300, bottom: 132, left: 220 }

    const flipped = resolveHorizontalPlacement({
      preferredAlign: 'start',
      side: 'bottom',
      anchor,
      clip,
      contentWidth: 200,
    })
    expect(flipped).toEqual({ align: 'end', dx: 0 })

    // Too wide for either edge: clamps cleanly inside clip margins.
    const wide = resolveHorizontalPlacement({
      preferredAlign: 'start',
      side: 'bottom',
      anchor,
      clip,
      contentWidth: 300,
    })
    const left = wide.align === 'start' ? anchor.left + wide.dx : anchor.right - 300 + wide.dx
    expect(left).toBe(POPOVER_MARGIN)
  })
})

describe('app-shell popover and menu CSS contract', () => {
  it('bounds .ui-as-popover height via --as-popover-max-h and makes .ui-as-menu__list scrollable', () => {
    expect(appShellCss).toMatch(
      /\.ui-as-popover\s*\{[^}]*max-height:\s*var\(--as-popover-max-h,\s*none\)/,
    )
    expect(appShellCss).toMatch(
      /\.ui-as-menu\s*\{[^}]*display:\s*flex;\s*flex-direction:\s*column;/,
    )
    expect(appShellCss).toMatch(
      /\.ui-as-menu\s*>\s*:not\(\.ui-as-menu__list\)\s*\{\s*flex:\s*none;\s*\}/,
    )
    expect(appShellCss).toMatch(
      /\.ui-as-menu__list\s*\{[^}]*flex:\s*1\s+1\s+auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/,
    )
    // Unconstrained menus with submenus keep overflow visible so side subpanels are not clipped.
    expect(appShellCss).toMatch(
      /\.ui-as-popover:not\(\[data-overflow\]\)\s+\.ui-as-menu__list:has\(>\s*\.ui-as-menu__sub\)\s*\{\s*overflow:\s*visible;\s*\}/,
    )
  })
})
