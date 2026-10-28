import type { Input } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  shell: {},
  View: class {},
  WebContentsView: class {},
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const { framePage, isUserMouse, leastRecentlyUsed, MAX_LIVE_PAGES, pageKey } =
  await import('./views')

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

describe('pageKey', () => {
  const key = (key: string, code: string, modifiers: Partial<Input> = {}): Input =>
    ({
      type: 'keyDown',
      key,
      code,
      isAutoRepeat: false,
      isComposing: false,
      shift: false,
      control: false,
      alt: false,
      meta: false,
      location: 0,
      modifiers: [],
      ...modifiers,
    }) as Input

  it('goes back, forward and reloads with the platform’s modifier', () => {
    for (const [platform, modifier] of [
      ['darwin', { meta: true }],
      ['win32', { control: true }],
      ['linux', { control: true }],
    ] as const) {
      expect(pageKey(key('[', 'BracketLeft', modifier), platform)).toBe('back')
      expect(pageKey(key(']', 'BracketRight', modifier), platform)).toBe('forward')
      expect(pageKey(key('r', 'KeyR', modifier), platform)).toBe('reload')
      expect(pageKey(key('[', 'BracketLeft'), platform)).toBeNull()
    }
  })

  it('goes back and forward with Alt and an arrow outside macOS', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(pageKey(key('ArrowLeft', 'ArrowLeft', { alt: true }), platform)).toBe('back')
      expect(pageKey(key('ArrowRight', 'ArrowRight', { alt: true }), platform)).toBe('forward')
      expect(
        pageKey(key('ArrowLeft', 'ArrowLeft', { alt: true, shift: true }), platform),
      ).toBeNull()
      expect(
        pageKey(key('ArrowLeft', 'ArrowLeft', { alt: true, control: true }), platform),
      ).toBeNull()
      expect(pageKey(key('[', 'BracketLeft', { alt: true, control: true }), platform)).toBeNull()
    }
    expect(pageKey(key('ArrowLeft', 'ArrowLeft', { alt: true }), 'darwin')).toBeNull()
  })

  it('takes neither a key going up nor one held down', () => {
    expect(pageKey(key('[', 'BracketLeft', { meta: true, type: 'keyUp' }), 'darwin')).toBeNull()
    expect(
      pageKey(key('[', 'BracketLeft', { meta: true, isAutoRepeat: true }), 'darwin'),
    ).toBeNull()
  })
})
