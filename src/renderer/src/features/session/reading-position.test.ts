import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachReturnAnchor,
  clearReadingPositions,
  distanceFromEnd,
  forgetReadingPosition,
  itemAtTop,
  leaveThread,
  MAX_REMEMBERED_POSITIONS,
  readingPosition,
  STICK_TO_BOTTOM_THRESHOLD,
} from './reading-position'

class FakeItemElement {
  dataset: Record<string, string>
  parentElement: unknown = null
  previousElementSibling: FakeItemElement | null = null
  hidden = false
  offsetHeight = 0
  styleProps = new Map<string, string>()
  style = {
    setProperty: (prop: string, value: string) => {
      this.styleProps.set(prop, value)
    },
    removeProperty: (prop: string) => {
      this.styleProps.delete(prop)
    },
  }
  private attrs = new Set<string>()
  private docTop: number
  private height: number
  private viewportRef: FakeViewportElement | null
  private onRectRead?: () => void

  constructor(
    id: string | null,
    docTop: number,
    height: number,
    options?: {
      viewport?: FakeViewportElement
      onRectRead?: () => void
      spacer?: boolean
      hidden?: boolean
    },
  ) {
    this.dataset = id ? { messageId: id } : {}
    this.docTop = docTop
    this.height = height
    this.viewportRef = options?.viewport ?? null
    this.onRectRead = options?.onRectRead
    if (options?.spacer) {
      this.attrs.add('data-message-scroller-spacer')
      this.offsetHeight = height
      this.hidden = options.hidden ?? true
    }
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  closest(selector: string): FakeItemElement | null {
    return selector === '[data-message-id]' && this.dataset.messageId ? this : null
  }

  setLayout(docTop: number, height = this.height): void {
    this.docTop = docTop
    this.height = height
  }

  getBoundingClientRect() {
    this.onRectRead?.()
    const scrollTop = this.viewportRef?.scrollTop ?? 0
    const viewportTop = this.viewportRef?.top ?? 0
    const top = viewportTop + this.docTop - scrollTop
    return {
      top,
      bottom: top + this.height,
      left: 0,
      right: 600,
      width: 600,
      height: this.height,
    }
  }
}

class FakeViewportElement {
  top: number
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  private scrollableAttr: string | null
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor({
    top = 0,
    clientHeight = 600,
    scrollHeight = 3000,
    scrollTop = 0,
    scrollable = 'start end',
  }: {
    top?: number
    clientHeight?: number
    scrollHeight?: number
    scrollTop?: number
    scrollable?: string | null
  } = {}) {
    this.top = top
    this.clientHeight = clientHeight
    this.scrollHeight = scrollHeight
    this.scrollTop = scrollTop
    this.scrollableAttr = scrollable
  }

  getAttribute(name: string): string | null {
    return name === 'data-scrollable' ? this.scrollableAttr : null
  }

  setScrollable(value: string | null): void {
    this.scrollableAttr = value
  }

  getBoundingClientRect() {
    return {
      top: this.top,
      bottom: this.top + this.clientHeight,
      left: 0,
      right: 800,
      width: 800,
      height: this.clientHeight,
    }
  }

  scrollTo(options: { top?: number; behavior?: ScrollBehavior }): void {
    if (typeof options.top === 'number') {
      const maxScroll = Math.max(0, this.scrollHeight - this.clientHeight)
      this.scrollTop = Math.min(maxScroll, Math.max(0, options.top))
    }
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event)
    }
  }
}

function createContent(items: FakeItemElement[]): HTMLElement {
  const content = {
    children: items,
    get lastElementChild() {
      return items.at(-1) ?? null
    },
    querySelector(selector: string) {
      const match = /\[data-message-id="(.+)"\]/.exec(selector)
      if (!match) return null
      const id = match[1]!.replace(/\\(.)/g, '$1')
      return items.find((item) => item.dataset.messageId === id) ?? null
    },
  }
  for (let i = 0; i < items.length; i++) {
    items[i]!.parentElement = content
    if (i > 0) items[i]!.previousElementSibling = items[i - 1]!
  }
  return content as unknown as HTMLElement
}

describe('reading-position storage and LRU eviction', () => {
  beforeEach(() => {
    clearReadingPositions()
  })

  afterEach(() => {
    clearReadingPositions()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('tracks independent reading positions per session and clears when left at bottom', () => {
    const posA = { item: 'm-12', entry: 'e-12', offset: -18, from: 'e-4', older: 50 }
    const posB = { item: 'm-40', entry: 'e-40', offset: 10, from: 'e-28', older: null }

    leaveThread('session-a', posA)
    leaveThread('session-b', posB)

    // Switching A -> B -> A preserves both sessions independently.
    expect(readingPosition('session-a')).toEqual(posA)
    expect(readingPosition('session-b')).toEqual(posB)

    // Leaving session A at the bottom clears its saved history position while leaving B intact.
    leaveThread('session-a', null)
    expect(readingPosition('session-a')).toBeNull()
    expect(readingPosition('session-b')).toEqual(posB)
  })

  it('enforces LRU capacity and refreshes recency on revisit and forget', () => {
    for (let i = 0; i < MAX_REMEMBERED_POSITIONS; i++) {
      leaveThread(`s-${i}`, { item: `m-${i}`, entry: `e-${i}`, offset: 0, from: null, older: null })
    }
    // Revisit the oldest session so s-0 stays warm while s-1 becomes the oldest.
    expect(readingPosition('s-0')?.item).toBe('m-0')

    // Adding one more session evicts s-1 rather than the revisited s-0.
    leaveThread('s-extra', {
      item: 'm-extra',
      entry: 'e-extra',
      offset: -4,
      from: null,
      older: null,
    })
    expect(readingPosition('s-0')?.item).toBe('m-0')
    expect(readingPosition('s-1')).toBeNull()
    expect(readingPosition('s-extra')?.item).toBe('m-extra')

    forgetReadingPosition('s-0')
    expect(readingPosition('s-0')).toBeNull()
  })
})

describe('itemAtTop', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses elementsFromPoint to find the top visible item without forcing layout on off-screen items', () => {
    const offscreenCalls = vi.fn()
    vi.stubGlobal('HTMLElement', FakeItemElement)

    const viewport = new FakeViewportElement({
      top: 100,
      clientHeight: 600,
      scrollHeight: 6000,
      scrollTop: 5000,
      scrollable: 'start end',
    })
    const children: FakeItemElement[] = []
    for (let i = 0; i < 150; i++) {
      // Items 0..147 are far above the viewport and skipped by content-visibility: auto.
      const el = new FakeItemElement(
        `item-${i}`,
        i === 148 ? 4988 : i === 149 ? 5030 : i * 20,
        i === 148 ? 42 : i === 149 ? 130 : 20,
        { viewport, onRectRead: i < 147 ? offscreenCalls : undefined },
      )
      children.push(el)
    }
    const content = createContent(children)

    // Sample lands on item-149 (slightly below top edge); walk-up discovers item-148 crossing top=100.
    vi.stubGlobal('document', {
      elementsFromPoint: () => [children[149]!],
    })

    const top = itemAtTop(viewport as unknown as HTMLElement, content)
    expect(top).toEqual({ item: 'item-148', offset: -12 })
    expect(offscreenCalls).not.toHaveBeenCalled()
  })

  it('returns null when the scroller is at or following the end', () => {
    vi.stubGlobal('HTMLElement', FakeItemElement)
    const viewport = new FakeViewportElement({
      clientHeight: 600,
      scrollHeight: 2000,
      scrollTop: 1400,
      scrollable: 'start',
    })
    expect(itemAtTop(viewport as unknown as HTMLElement, createContent([]))).toBeNull()
  })

  it('treats positions within edge threshold as at-bottom even if data-scrollable is stale', () => {
    vi.stubGlobal('HTMLElement', FakeItemElement)
    const viewport = new FakeViewportElement({
      clientHeight: 600,
      scrollHeight: 2000,
      scrollTop: 2000 - 600 - (STICK_TO_BOTTOM_THRESHOLD - 5),
      // Stale attribute from before scrolling down to the bottom in the same frame.
      scrollable: 'start end',
    })
    const item = new FakeItemElement('m-last', 1350, 650, { viewport })
    const content = createContent([item])

    expect(distanceFromEnd(viewport as unknown as HTMLElement, content)).toBe(
      STICK_TO_BOTTOM_THRESHOLD - 5,
    )
    expect(itemAtTop(viewport as unknown as HTMLElement, content, { detached: true })).toBeNull()
  })

  it('captures history position synchronously when detached before data-scrollable flushes', () => {
    vi.stubGlobal('HTMLElement', FakeItemElement)
    const viewport = new FakeViewportElement({
      top: 0,
      clientHeight: 600,
      scrollHeight: 3000,
      scrollTop: 900,
      // MessageScroller has not flushed its next rAF to add "end" yet.
      scrollable: 'start',
    })
    const items = [
      new FakeItemElement('m-0', 0, 400, { viewport }),
      new FakeItemElement('m-1', 400, 480, { viewport }),
      new FakeItemElement('m-2', 880, 320, { viewport }),
    ]
    const content = createContent(items)

    // Without detached, streaming auto-follow keeps stick-to-bottom behavior (returns null).
    expect(itemAtTop(viewport as unknown as HTMLElement, content)).toBeNull()
    // With detached, the user's synchronous upward scroll is still captured accurately.
    expect(itemAtTop(viewport as unknown as HTMLElement, content, { detached: true })).toEqual({
      item: 'm-2',
      offset: -20,
    })
  })

  it('subtracts a visible MessageScroller spacer when measuring distance from end', () => {
    vi.stubGlobal('HTMLElement', FakeItemElement)
    const viewport = new FakeViewportElement({
      clientHeight: 600,
      scrollHeight: 2400,
      scrollTop: 1400,
      scrollable: 'start end',
    })
    const msg = new FakeItemElement('m-1', 1400, 600, { viewport })
    const spacer = new FakeItemElement(null, 2000, 400, {
      viewport,
      spacer: true,
      hidden: false,
    })
    const content = createContent([msg, spacer])

    // Real content height is 2000, so scrollTop 1400 + clientHeight 600 sits right at the end.
    expect(distanceFromEnd(viewport as unknown as HTMLElement, content)).toBe(0)
    expect(itemAtTop(viewport as unknown as HTMLElement, content)).toBeNull()
  })
})

describe('attachReturnAnchor session-switch restoration and async stability', () => {
  let resizeCallbacks: Array<() => void>
  let mutationCallbacks: Array<() => void>
  let rafQueue: Array<() => void>

  beforeEach(() => {
    vi.useFakeTimers()
    clearReadingPositions()
    resizeCallbacks = []
    mutationCallbacks = []
    rafQueue = []

    vi.stubGlobal('HTMLElement', FakeItemElement)
    vi.stubGlobal('CSS', { escape: (value: string) => value })
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal(
      'ResizeObserver',
      class FakeResizeObserver {
        private cb: () => void
        constructor(cb: () => void) {
          this.cb = cb
          resizeCallbacks.push(cb)
        }
        observe() {}
        disconnect() {
          resizeCallbacks = resizeCallbacks.filter((fn) => fn !== this.cb)
        }
      },
    )
    vi.stubGlobal(
      'MutationObserver',
      class FakeMutationObserver {
        private cb: () => void
        constructor(cb: () => void) {
          this.cb = cb
          mutationCallbacks.push(cb)
        }
        observe() {}
        disconnect() {
          mutationCallbacks = mutationCallbacks.filter((fn) => fn !== this.cb)
        }
      },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    clearReadingPositions()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('restores session A reading position synchronously after A -> B -> A without flashing bottom', () => {
    // 1. User is in session A scrolled up to m-5 (top=-24 relative to viewport).
    const viewportA1 = new FakeViewportElement({
      top: 0,
      clientHeight: 600,
      scrollHeight: 4000,
      scrollTop: 1024,
      scrollable: 'start end',
    })
    const itemsA1 = Array.from(
      { length: 20 },
      (_, i) => new FakeItemElement(`m-${i}`, i * 200, 200, { viewport: viewportA1 }),
    )
    const contentA1 = createContent(itemsA1)

    const leftTop = itemAtTop(viewportA1 as unknown as HTMLElement, contentA1)
    expect(leftTop).toEqual({ item: 'm-5', offset: -24 })
    leaveThread('session-a', { ...leftTop!, entry: 'e-5', from: 'e-0', older: null })

    // 2. User switches to session B (at bottom) and leaves B at the bottom.
    const viewportB = new FakeViewportElement({
      top: 0,
      clientHeight: 600,
      scrollHeight: 1600,
      scrollTop: 1000,
      scrollable: 'start',
    })
    expect(itemAtTop(viewportB as unknown as HTMLElement, createContent([]))).toBeNull()
    leaveThread('session-b', null)
    expect(readingPosition('session-b')).toBeNull()

    // 3. User returns to session A: scroller opens at scrollTop=0 (never bottom), then anchor places synchronously.
    const saved = readingPosition('session-a')!
    expect(saved).not.toBeNull()

    const viewportA2 = new FakeViewportElement({
      top: 0,
      clientHeight: 600,
      scrollHeight: 4000,
      scrollTop: 0,
      scrollable: 'end',
    })
    const itemsA2 = Array.from(
      { length: 20 },
      (_, i) => new FakeItemElement(`m-${i}`, i * 200, 200, { viewport: viewportA2 }),
    )
    const contentA2 = createContent(itemsA2)

    const onPositioned = vi.fn()
    const onFallbackEnd = vi.fn()
    const onDone = vi.fn()

    const cleanup = attachReturnAnchor({
      viewport: viewportA2 as unknown as HTMLElement,
      content: contentA2,
      itemKey: saved.item,
      offset: saved.offset,
      onPositioned,
      onFallbackEnd,
      onDone,
    })

    // Placed synchronously before first paint at exact offset (-24) without jumping to bottom (3400).
    expect(onPositioned).toHaveBeenCalledTimes(1)
    expect(onFallbackEnd).not.toHaveBeenCalled()
    expect(viewportA2.scrollTop).toBe(1024)
    expect(itemsA2[5]!.getBoundingClientRect().top).toBe(-24)
    expect(itemsA2[5]!.styleProps.get('content-visibility')).toBe('visible')

    cleanup()
    expect(itemsA2[5]!.styleProps.has('content-visibility')).toBe(false)
  })

  it('compensates for async height growth and snapshot DOM replacement without jumping to bottom', () => {
    const viewport = new FakeViewportElement({
      top: 0,
      clientHeight: 600,
      scrollHeight: 4000,
      scrollTop: 0,
      scrollable: 'end',
    })
    const items = Array.from(
      { length: 20 },
      (_, i) => new FakeItemElement(`m-${i}`, i * 200, 200, { viewport }),
    )
    const content = createContent(items)

    let gapSettling = true
    const onPositioned = vi.fn()
    const onFallbackEnd = vi.fn()
    const onDone = vi.fn()

    attachReturnAnchor({
      viewport: viewport as unknown as HTMLElement,
      content,
      itemKey: 'm-5',
      offset: -16,
      isSettling: () => gapSettling,
      onPositioned,
      onFallbackEnd,
      onDone,
      quietMs: 300,
      maxSettleMs: 1500,
    })

    expect(viewport.scrollTop).toBe(1016)

    // Async code highlighting / image load above m-5 expands earlier items by +260px.
    viewport.scrollHeight = 4260
    for (let i = 3; i < items.length; i++) {
      items[i]!.setLayout(i * 200 + 260, 200)
    }
    for (const cb of [...resizeCallbacks]) cb()
    for (const cb of rafQueue.splice(0)) cb()

    // Anchor shifts scrollTop by +260 so m-5 stays pinned at -16px rather than drifting or hitting bottom.
    expect(viewport.scrollTop).toBe(1276)
    expect(items[5]!.getBoundingClientRect().top).toBe(-16)

    // Async snapshot refresh replaces m-5 node and appends 5 newer messages at the end (+1000px).
    const replaced = new FakeItemElement('m-5', 1320, 200, { viewport })
    items[5] = replaced
    viewport.scrollHeight = 5260
    for (let i = 20; i < 25; i++) {
      items.push(new FakeItemElement(`m-${i}`, 4260 + (i - 20) * 200, 200, { viewport }))
    }
    for (const cb of [...mutationCallbacks]) cb()
    for (const cb of rafQueue.splice(0)) cb()

    expect(viewport.scrollTop).toBe(1336)
    expect(replaced.getBoundingClientRect().top).toBe(-16)
    expect(onFallbackEnd).not.toHaveBeenCalled()

    // Stays active while placeholder gaps are still settling, then finishes after quiet period.
    vi.advanceTimersByTime(350)
    expect(onDone).not.toHaveBeenCalled()

    gapSettling = false
    vi.advanceTimersByTime(350)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(replaced.styleProps.has('content-visibility')).toBe(false)
  })

  it('yields immediately on user scroll intent while ignoring clicks inside messages', () => {
    const viewport = new FakeViewportElement({
      top: 0,
      clientHeight: 600,
      scrollHeight: 4000,
      scrollTop: 0,
      scrollable: 'end',
    })
    const items = Array.from(
      { length: 10 },
      (_, i) => new FakeItemElement(`m-${i}`, i * 200, 200, { viewport }),
    )
    const content = createContent(items)
    const onDone = vi.fn()

    attachReturnAnchor({
      viewport: viewport as unknown as HTMLElement,
      content,
      itemKey: 'm-4',
      offset: 0,
      onPositioned: vi.fn(),
      onFallbackEnd: vi.fn(),
      onDone,
    })

    expect(viewport.scrollTop).toBe(800)

    // Clicking inside a message (target !== viewport) does not cancel anchor protection.
    viewport.dispatch('pointerdown', { target: items[4] })
    expect(onDone).not.toHaveBeenCalled()

    // User wheeling cancels the anchor guard immediately so it never fights manual scrolling.
    viewport.dispatch('wheel', {})
    expect(onDone).toHaveBeenCalledTimes(1)

    // Subsequent layout shifts no longer override the user's scroll position.
    viewport.scrollTop = 300
    items[4]!.setLayout(1000, 200)
    for (const cb of [...resizeCallbacks]) cb()
    for (const cb of rafQueue.splice(0)) cb()
    expect(viewport.scrollTop).toBe(300)
  })

  it('falls back to the end cleanly when the saved item no longer exists', () => {
    const viewport = new FakeViewportElement()
    const content = createContent([])
    const onPositioned = vi.fn()
    const onFallbackEnd = vi.fn()
    const onDone = vi.fn()

    attachReturnAnchor({
      viewport: viewport as unknown as HTMLElement,
      content,
      itemKey: null,
      offset: 0,
      onPositioned,
      onFallbackEnd,
      onDone,
    })

    expect(onFallbackEnd).toHaveBeenCalledTimes(1)
    expect(onPositioned).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
