import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  shell: {},
  WebContentsView: class {},
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const { leastRecentlyUsed, MAX_LIVE_PAGES } = await import('./views')

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
