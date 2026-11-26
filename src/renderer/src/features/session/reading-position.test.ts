import { afterEach, describe, expect, it, vi } from 'vitest'
import { itemAtTop } from './reading-position'

describe('itemAtTop', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses elementsFromPoint to find the top visible item without forcing layout on off-screen items', () => {
    const offscreenCalls = vi.fn()
    class FakeEl {
      dataset: Record<string, string>
      parentElement: unknown = null
      previousElementSibling: FakeEl | null = null
      private rect: { top: number; bottom: number }
      private offscreen: boolean
      constructor(id: string, rect: { top: number; bottom: number }, offscreen = false) {
        this.dataset = { messageId: id }
        this.rect = rect
        this.offscreen = offscreen
      }
      closest(selector: string) {
        return selector === '[data-message-id]' ? this : null
      }
      getBoundingClientRect() {
        if (this.offscreen) offscreenCalls()
        return {
          ...this.rect,
          left: 0,
          right: 600,
          width: 600,
          height: this.rect.bottom - this.rect.top,
        }
      }
    }
    vi.stubGlobal('HTMLElement', FakeEl)

    const children: FakeEl[] = []
    for (let i = 0; i < 150; i++) {
      // Items 0..147 are far above the viewport and skipped by content-visibility: auto.
      const el = new FakeEl(
        `item-${i}`,
        i === 148
          ? { top: 88, bottom: 130 }
          : i === 149
            ? { top: 130, bottom: 260 }
            : { top: -5000 + i * 20, bottom: -4980 + i * 20 },
        i < 147,
      )
      if (i > 0) el.previousElementSibling = children[i - 1]!
      children.push(el)
    }
    const content = { children } as unknown as HTMLElement
    for (const c of children) c.parentElement = content

    // Sample lands on item-149 (slightly below top edge); walk-up discovers item-148 crossing top=100.
    vi.stubGlobal('document', {
      elementsFromPoint: () => [children[149]!],
    })
    const viewport = {
      getAttribute: (name: string) => (name === 'data-scrollable' ? 'start end' : null),
      getBoundingClientRect: () => ({
        top: 100,
        bottom: 700,
        left: 0,
        right: 800,
        width: 800,
        height: 600,
      }),
    } as unknown as HTMLElement

    const top = itemAtTop(viewport, content)
    expect(top).toEqual({ item: 'item-148', offset: -12 })
    expect(offscreenCalls).not.toHaveBeenCalled()
  })

  it('returns null when the scroller is at or following the end', () => {
    const viewport = {
      getAttribute: () => 'start',
      getBoundingClientRect: () => ({
        top: 0,
        bottom: 600,
        left: 0,
        right: 800,
        width: 800,
        height: 600,
      }),
    } as unknown as HTMLElement
    expect(itemAtTop(viewport, { children: [] } as unknown as HTMLElement)).toBeNull()
  })
})
