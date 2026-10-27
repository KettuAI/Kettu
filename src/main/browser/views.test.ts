import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  shell: {},
  View: class {},
  WebContentsView: class {},
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const { framePage, isUserMouse, leastRecentlyUsed, MAX_LIVE_PAGES } = await import('./views')

describe('framePage', () => {
  it('reaches the radius above the page, which sits that far inside it', () => {
    expect(framePage({ x: 600, y: 56, width: 400, height: 500, radius: 12 })).toEqual({
      frame: { x: 600, y: 44, width: 400, height: 512 },
      page: { x: 0, y: 12, width: 400, height: 500 },
    })
  })

  it('stops at the top of the window', () => {
    expect(framePage({ x: 0, y: 5, width: 400, height: 500, radius: 12 })).toEqual({
      frame: { x: 0, y: 0, width: 400, height: 505 },
      page: { x: 0, y: 5, width: 400, height: 500 },
    })
  })

  it('is the page itself when the corners are square', () => {
    expect(framePage({ x: 10, y: 56, width: 400, height: 500, radius: 0 })).toEqual({
      frame: { x: 10, y: 56, width: 400, height: 500 },
      page: { x: 0, y: 0, width: 400, height: 500 },
    })
  })
})

describe('leastRecentlyUsed', () => {
  it('names the oldest live page, never the one being made', () => {
    const pages = [
      { sessionId: 'a', lastUsed: 10, live: true },
      { sessionId: 'b', lastUsed: 30, live: true },
      { sessionId: 'c', lastUsed: 20, live: true },
    ]
    expect(leastRecentlyUsed(pages, 'd')).toBe('a')
    expect(leastRecentlyUsed(pages, 'b')).toBe('a')
    expect(leastRecentlyUsed(pages, 'a')).toBe('c')
  })

  it('leaves pages with no live view out', () => {
    const pages = [
      { sessionId: 'a', lastUsed: 10, live: false },
      { sessionId: 'b', lastUsed: 30, live: true },
    ]
    expect(leastRecentlyUsed(pages, 'c')).toBe('b')
  })

  it('has nothing to close when every live page is the one kept', () => {
    expect(leastRecentlyUsed([{ sessionId: 'a', lastUsed: 1, live: true }], 'a')).toBeNull()
  })

  it('keeps four pages at once', () => {
    expect(MAX_LIVE_PAGES).toBe(4)
  })
})

describe('isUserMouse', () => {
  it('is a click, a wheel or a touch, never the pointer passing over the page', () => {
    for (const type of ['mouseDown', 'mouseUp', 'mouseWheel', 'contextMenu']) {
      expect(isUserMouse(type)).toBe(true)
    }
    for (const type of ['mouseMove', 'mouseEnter', 'mouseLeave']) {
      expect(isUserMouse(type)).toBe(false)
    }
  })
})
