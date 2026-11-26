import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeIdleWindow,
  DESKTOP_WINDOW_CONFIG,
  expandWindowForScroll,
  findVisibleIndexRange,
  WEB_WINDOW_CONFIG,
} from './thread-window'

describe('thread-window idle virtualization policy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('never starts evicting during active scrolling', () => {
    const next = expandWindowForScroll(
      null,
      { start: 180, end: 190 },
      0,
      500,
      DESKTOP_WINDOW_CONFIG,
    )
    expect(next).toBeNull()
  })

  it('returns null when visible band plus lookahead is already inside the mounted window', () => {
    const current = { start: 60, end: 260 }
    const next = expandWindowForScroll(
      current,
      { start: 140, end: 152 },
      0,
      500,
      DESKTOP_WINDOW_CONFIG,
    )
    expect(next).toBeNull()
  })

  it('only expands without unmounting when scrolling into virtualized placeholders', () => {
    const current = { start: 120, end: 260 }
    // Scrolling upward into placeholders below index 120 expands `start` while keeping `end` intact.
    const expandedUp = expandWindowForScroll(
      current,
      { start: 100, end: 108 },
      0,
      500,
      DESKTOP_WINDOW_CONFIG,
    )
    expect(expandedUp).toEqual({
      start: 100 - DESKTOP_WINDOW_CONFIG.expandBufferItems,
      end: 260,
    })

    // Scrolling downward past `end` expands `end` while keeping `start` intact.
    const expandedDown = expandWindowForScroll(
      current,
      { start: 245, end: 265 },
      0,
      500,
      DESKTOP_WINDOW_CONFIG,
    )
    expect(expandedDown).toEqual({
      start: 120,
      end: 265 + DESKTOP_WINDOW_CONFIG.expandBufferItems,
    })
  })

  it('enforces the hard mounted cap on the far side during massive continuous scrubs', () => {
    const current = { start: 0, end: 130 }
    const next = expandWindowForScroll(current, { start: 240, end: 250 }, 0, 400, WEB_WINDOW_CONFIG)
    expect(next).not.toBeNull()
    expect(next!.end - next!.start + 1).toBeLessThanOrEqual(WEB_WINDOW_CONFIG.hardCapMounted)
    expect(next!.start).toBeLessThanOrEqual(240 - WEB_WINDOW_CONFIG.expandBufferItems)
    expect(next!.end).toBeGreaterThanOrEqual(250 + WEB_WINDOW_CONFIG.expandBufferItems)
  })

  it('computes bounded idle windows with larger overscan on desktop than web', () => {
    const desktop = computeIdleWindow(null, { start: 240, end: 250 }, 0, 500, DESKTOP_WINDOW_CONFIG)
    const web = computeIdleWindow(null, { start: 240, end: 250 }, 0, 500, WEB_WINDOW_CONFIG)
    expect(desktop).toEqual({
      start: 240 - DESKTOP_WINDOW_CONFIG.overscanItems,
      end: 250 + DESKTOP_WINDOW_CONFIG.overscanItems,
    })
    expect(web).toEqual({
      start: 240 - WEB_WINDOW_CONFIG.overscanItems,
      end: 250 + WEB_WINDOW_CONFIG.overscanItems,
    })
    expect(desktop!.end - desktop!.start).toBeGreaterThan(web!.end - web!.start)
  })

  it('respects hysteresis during idle eviction so small movements cause no churn', () => {
    const current = { start: 150, end: 340 }
    const unchanged = computeIdleWindow(
      current,
      { start: 242, end: 252 },
      0,
      500,
      DESKTOP_WINDOW_CONFIG,
    )
    expect(unchanged).toBeNull()
  })

  it('stays below virtualization threshold on desktop for medium-long threads', () => {
    expect(
      computeIdleWindow(null, { start: 120, end: 130 }, 0, 260, DESKTOP_WINDOW_CONFIG),
    ).toBeNull()
    expect(
      computeIdleWindow(null, { start: 120, end: 130 }, 0, 260, WEB_WINDOW_CONFIG),
    ).not.toBeNull()
  })

  it('avoids HitTest during active scrolling and uses elementsFromPoint only during idle eviction', () => {
    const offscreenLayoutSpy = vi.fn()
    const hitTestSpy = vi.fn()
    class FakeElement {
      dataset: Record<string, string>
      parentElement: unknown
      constructor(id: string, parent: unknown) {
        this.dataset = { messageId: id }
        this.parentElement = parent
      }
      closest(selector: string) {
        return selector === '[data-message-id]' ? this : null
      }
      getBoundingClientRect() {
        offscreenLayoutSpy()
        return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
      }
    }
    vi.stubGlobal('HTMLElement', FakeElement)
    const content = {} as HTMLElement
    const topItem = new FakeElement('item-50', content)
    const midItem = new FakeElement('item-53', content)
    const botItem = new FakeElement('item-56', content)
    const keyToIndex = new Map<string, number>()
    for (let i = 0; i < 200; i++) keyToIndex.set(`item-${i}`, i)

    vi.stubGlobal('document', {
      elementsFromPoint: (_x: number, y: number) => {
        hitTestSpy()
        if (y < 100) return [topItem]
        if (y < 350) return [midItem]
        return [botItem]
      },
    })
    const viewport = {
      scrollTop: 5000,
      scrollHeight: 20000,
      clientHeight: 500,
      getBoundingClientRect: () => ({
        top: 0,
        bottom: 500,
        left: 0,
        right: 800,
        width: 800,
        height: 500,
      }),
    } as unknown as HTMLElement

    // Active scrolling (default allowHitTest: false) never invokes elementsFromPoint.
    const activeRange = findVisibleIndexRange(viewport, content, keyToIndex, 0, 200)
    expect(activeRange).not.toBeNull()
    expect(hitTestSpy).not.toHaveBeenCalled()

    // Idle eviction (allowHitTest: true) pinpoints visible items via O(1) hit-test without off-screen layout.
    const idleRange = findVisibleIndexRange(viewport, content, keyToIndex, 0, 200, {
      allowHitTest: true,
    })
    expect(idleRange).toEqual({ start: 50, end: 56 })
    expect(hitTestSpy).toHaveBeenCalled()
    expect(offscreenLayoutSpy).not.toHaveBeenCalled()
  })

  it('falls back to proportional estimation when elementsFromPoint is unavailable', () => {
    vi.stubGlobal('document', {})
    const viewport = {
      scrollTop: 10000,
      scrollHeight: 20500,
      clientHeight: 500,
      getBoundingClientRect: () => ({
        top: 0,
        bottom: 500,
        left: 0,
        right: 800,
        width: 800,
        height: 500,
      }),
    } as unknown as HTMLElement
    const range = findVisibleIndexRange(viewport, {} as HTMLElement, new Map(), 0, 201)
    expect(range).toEqual({ start: 96, end: 104 })
  })
})
