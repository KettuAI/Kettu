import { describe, expect, it } from 'vitest'
import {
  canonicalBrowserUrl,
  desktopViewportFor,
  fitPageViewport,
  fitViewport,
  isFixedFrameViewport,
  PAGE_SIZES,
  pageSizeOf,
  sameBrowserUrl,
  samePageSize,
  SIZE_LINE_ROOM,
  type BrowserBounds,
  type PageSize,
} from './browser'

const frameOf = (width: number, height: number, x = 0, y = 0, radius = 8): BrowserBounds => ({
  x,
  y,
  width,
  height,
  radius,
})

describe('desktopViewportFor', () => {
  it('expands desktop logical height to fill a tall narrow side panel', () => {
    const viewport = desktopViewportFor(frameOf(780, 920))
    expect(viewport).toEqual({
      name: 'desktop',
      width: 1280,
      height: Math.round(920 / (780 / 1280)),
      mobile: false,
    })
    expect(viewport.height).toBe(1510)
  })

  it('fills a wide pane natively at 1:1', () => {
    expect(desktopViewportFor(frameOf(1440, 900))).toEqual({
      name: 'desktop',
      width: 1440,
      height: 900,
      mobile: false,
    })
    expect(desktopViewportFor(frameOf(1280, 800))).toEqual({
      name: 'desktop',
      width: 1280,
      height: 800,
      mobile: false,
    })
  })

  it('avoids clipping in a short narrow pane by matching aspect ratio', () => {
    const viewport = desktopViewportFor(frameOf(780, 300))
    expect(viewport).toEqual({
      name: 'desktop',
      width: 1280,
      height: Math.round(300 / (780 / 1280)),
      mobile: false,
    })
  })
})

describe('fitPageViewport', () => {
  it('fills the entire frame with zero bottom gap for desktop viewports', () => {
    const frames = [
      frameOf(780, 920, 420, 64),
      frameOf(474, 644, 681, 93),
      frameOf(520, 901),
      frameOf(1200, 740),
      frameOf(1280, 800),
      frameOf(1440, 900),
      frameOf(780, 300),
    ]
    for (const frame of frames) {
      const viewport = desktopViewportFor(frame)
      const fitted = fitPageViewport(frame, viewport, SIZE_LINE_ROOM)
      expect(fitted.showSizeLine).toBe(false)
      expect(fitted.bounds).toEqual(frame)
      expect(fitted.scale).toBeCloseTo(Math.min(1, frame.width / viewport.width), 6)
    }
  })

  it('scales a frozen desktop viewport without reserving a bottom caption strip when the pane shrinks', () => {
    const initial = frameOf(780, 920, 400, 60)
    const frozen = desktopViewportFor(initial)

    // Narrowing the pane keeps the frozen logical size and scales down cleanly.
    const narrowed = fitPageViewport(frameOf(600, 920, 400, 60), frozen, SIZE_LINE_ROOM)
    expect(narrowed.showSizeLine).toBe(false)
    expect(narrowed.scale).toBeCloseTo(600 / 1280, 6)
    expect(narrowed.bounds).toEqual({
      x: 400,
      y: 60,
      width: 600,
      height: Math.round(1510 * (600 / 1280)),
      radius: 8,
    })

    // Widening the pane centers the frozen desktop viewport vertically without clipping.
    const widened = fitPageViewport(frameOf(1000, 920, 400, 60), frozen, SIZE_LINE_ROOM)
    expect(widened.showSizeLine).toBe(false)
    expect(widened.bounds.height).toBeGreaterThanOrEqual(919)
    expect(widened.bounds.height).toBeLessThanOrEqual(920)
    expect(widened.bounds.width).toBeLessThan(1000)
    expect(widened.bounds.x).toBeGreaterThan(400)
  })

  it('preserves centered framing and bottom size caption room for tablet, phone, and custom presets', () => {
    const frame = frameOf(780, 920, 100, 40)

    const tablet = fitPageViewport(frame, PAGE_SIZES.tablet, SIZE_LINE_ROOM)
    expect(tablet.showSizeLine).toBe(true)
    expect(tablet.bounds.height).toBe(920 - SIZE_LINE_ROOM)
    expect(tablet.bounds.x).toBeGreaterThan(frame.x)
    expect(tablet.scale).toBeLessThan(1)

    const phone = fitPageViewport(frame, PAGE_SIZES.phone, SIZE_LINE_ROOM)
    expect(phone.showSizeLine).toBe(true)
    expect(phone.scale).toBe(1)
    expect(phone.bounds).toEqual({
      x: 100 + Math.floor((780 - 390) / 2),
      y: 40,
      width: 390,
      height: 844,
      radius: 8,
    })

    const custom: PageSize = { name: 'custom', width: 1024, height: 768, mobile: false }
    const fittedCustom = fitPageViewport(frame, custom, SIZE_LINE_ROOM)
    expect(fittedCustom.showSizeLine).toBe(true)
    expect(fittedCustom.bounds.width).toBe(780)
    expect(fittedCustom.bounds.height).toBe(Math.round(768 * (780 / 1024)))
    expect(fittedCustom.scale).toBeCloseTo(780 / 1024, 6)
  })

  it('returns native unscaled full-frame bounds for null (Fill pane)', () => {
    const frame = frameOf(780, 920, 100, 40)
    expect(fitPageViewport(frame, null, SIZE_LINE_ROOM)).toEqual({
      bounds: frame,
      scale: 1,
      showSizeLine: false,
    })
  })
})

describe('fitViewport & page size helpers', () => {
  it('never enlarges a viewport beyond 100% scale', () => {
    const { bounds, scale } = fitViewport(frameOf(1400, 1000), PAGE_SIZES.phone, SIZE_LINE_ROOM)
    expect(scale).toBe(1)
    expect(bounds.width).toBe(390)
    expect(bounds.height).toBe(844)
  })

  it('distinguishes fixed-frame viewports from desktop and native fill', () => {
    expect(isFixedFrameViewport(null)).toBe(false)
    expect(isFixedFrameViewport(PAGE_SIZES.desktop)).toBe(false)
    expect(isFixedFrameViewport(PAGE_SIZES.tablet)).toBe(true)
    expect(isFixedFrameViewport(PAGE_SIZES.phone)).toBe(true)
    expect(isFixedFrameViewport({ name: 'custom', width: 800, height: 600, mobile: false })).toBe(
      true,
    )
  })

  it('keeps browser_resize pageSizeOf validation backward-compatible', () => {
    expect(pageSizeOf({ size: 'desktop' })).toEqual(PAGE_SIZES.desktop)
    expect(pageSizeOf({ size: 'tablet' })).toEqual(PAGE_SIZES.tablet)
    expect(pageSizeOf({ size: 'phone' })).toEqual(PAGE_SIZES.phone)
    expect(pageSizeOf({ width: 1024, height: 768 })).toEqual({
      name: 'custom',
      width: 1024,
      height: 768,
      mobile: false,
    })
    expect('error' in pageSizeOf({ size: 'fit' })).toBe(true)
    expect(samePageSize(PAGE_SIZES.desktop, { ...PAGE_SIZES.desktop })).toBe(true)
    expect(samePageSize(PAGE_SIZES.desktop, null)).toBe(false)
  })
})

describe('canonicalBrowserUrl & sameBrowserUrl (#2858)', () => {
  it('normalizes scheme/host casing, default ports, trailing slashes, and empty fragments', () => {
    expect(canonicalBrowserUrl('HTTPS://Example.COM:443')).toBe('https://example.com/')
    expect(canonicalBrowserUrl('http://EXAMPLE.com:80/docs/')).toBe('http://example.com/docs')
    expect(canonicalBrowserUrl('https://example.com/docs///#')).toBe('https://example.com/docs')
    expect(sameBrowserUrl('https://example.com', 'https://example.com/')).toBe(true)
    expect(sameBrowserUrl('https://example.com:443/guide', 'https://example.com/guide/')).toBe(true)
    expect(sameBrowserUrl('http://localhost:80/app#', 'http://localhost/app')).toBe(true)
    expect(
      sameBrowserUrl('https://example.com/guide/#install', 'https://example.com/guide#install'),
    ).toBe(true)
  })

  it('keeps distinct queries, non-empty hashes, ports, and paths separate', () => {
    expect(sameBrowserUrl('https://example.com/search?q=a', 'https://example.com/search?q=b')).toBe(
      false,
    )
    expect(sameBrowserUrl('https://example.com/docs#a', 'https://example.com/docs#b')).toBe(false)
    expect(sameBrowserUrl('https://example.com/docs', 'https://example.com/docs#a')).toBe(false)
    expect(sameBrowserUrl('http://localhost:5173/#/a', 'http://localhost:5173/#/b')).toBe(false)
    expect(sameBrowserUrl('http://localhost:3000/', 'http://localhost:5173/')).toBe(false)
    expect(sameBrowserUrl('https://a@example.com/', 'https://b@example.com/')).toBe(false)
  })

  it('returns null / false for empty, blank, or non-http(s) URLs', () => {
    expect(canonicalBrowserUrl(null)).toBeNull()
    expect(canonicalBrowserUrl(undefined)).toBeNull()
    expect(canonicalBrowserUrl('')).toBeNull()
    expect(canonicalBrowserUrl('about:blank')).toBeNull()
    expect(canonicalBrowserUrl('file:///tmp/index.html')).toBeNull()
    expect(sameBrowserUrl('about:blank', 'about:blank')).toBe(false)
    expect(sameBrowserUrl(null, 'https://example.com')).toBe(false)
  })
})
