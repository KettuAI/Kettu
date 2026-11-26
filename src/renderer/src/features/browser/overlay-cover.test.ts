import { describe, expect, it, vi } from 'vitest'
import { OVERLAY_LAYER } from '@renderer/stores/overlays'
import { covers, observeOverlayGeometry, rectOverlaps, type RectLike } from './overlay-cover'

function makeRect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

class FakeElement {
  readonly nodeType = 1
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  attrs = new Map<string, string>()
  rect: RectLike
  isConnected = true
  ownerDocument: { body: FakeElement | null; documentElement: FakeElement | null }

  constructor(
    rect: RectLike = makeRect(0, 0, 0, 0),
    ownerDocument: { body: FakeElement | null; documentElement: FakeElement | null } = {
      body: null,
      documentElement: null,
    },
  ) {
    this.rect = rect
    this.ownerDocument = ownerDocument
  }

  append(child: FakeElement): FakeElement {
    child.parentElement = this
    child.ownerDocument = this.ownerDocument
    child.setConnected(this.isConnected)
    this.children.push(child)
    return child
  }

  removeChild(child: FakeElement): void {
    const idx = this.children.indexOf(child)
    if (idx >= 0) this.children.splice(idx, 1)
    child.parentElement = null
    child.setConnected(false)
  }

  private setConnected(connected: boolean): void {
    this.isConnected = connected
    for (const child of this.children) child.setConnected(connected)
  }

  setAttribute(name: string, value = ''): void {
    this.attrs.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  getBoundingClientRect(): RectLike {
    return this.rect
  }

  closest(selector: string): FakeElement | null {
    const attr = selector.match(/^\[([^\]]+)\]$/)?.[1]
    if (!attr) return null
    if (this.hasAttribute(attr)) return this
    let cur = this.parentElement
    while (cur) {
      if (cur.hasAttribute(attr)) return cur
      cur = cur.parentElement
    }
    return null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const attr = selector.match(/^\[([^\]]+)\]$/)?.[1]
    if (!attr) return []
    const hits: FakeElement[] = []
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.hasAttribute(attr)) hits.push(child)
        walk(child)
      }
    }
    walk(this)
    return hits
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = []
  readonly callback: MutationCallback
  observed: Array<{ target: Node; options?: MutationObserverInit }> = []
  disconnected = false

  constructor(callback: MutationCallback) {
    this.callback = callback
    FakeMutationObserver.instances.push(this)
  }

  observe(target: Node, options?: MutationObserverInit): void {
    this.disconnected = false
    this.observed.push({ target, options })
  }

  disconnect(): void {
    this.disconnected = true
    this.observed = []
  }

  takeRecords(): MutationRecord[] {
    return []
  }

  emit(records: Array<Partial<MutationRecord>>): void {
    if (this.disconnected) return
    this.callback(records as MutationRecord[], this as unknown as MutationObserver)
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly callback: ResizeObserverCallback
  observed = new Set<Element>()
  disconnected = false

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.disconnected = false
    this.observed.add(target)
  }

  unobserve(target: Element): void {
    this.observed.delete(target)
  }

  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }

  emit(target: Element): void {
    if (this.disconnected || !this.observed.has(target)) return
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

function createFakeDom() {
  const owner = {
    body: null as FakeElement | null,
    documentElement: null as FakeElement | null,
  }
  const html = new FakeElement(makeRect(0, 0, 1280, 800), owner)
  const body = new FakeElement(makeRect(0, 0, 1280, 800), owner)
  owner.documentElement = html
  owner.body = body
  html.append(body)
  return { html, body, owner }
}

describe('rectOverlaps', () => {
  it('detects overlapping rectangles and rejects touching or empty ones', () => {
    const pane = makeRect(640, 80, 600, 700)

    expect(rectOverlaps(makeRect(500, 300, 200, 180), pane)).toBe(true)
    expect(rectOverlaps(makeRect(640, 300, 100, 100), pane)).toBe(true)
    // Touching edges do not overlap.
    expect(rectOverlaps(makeRect(440, 300, 200, 180), pane)).toBe(false)
    expect(rectOverlaps(makeRect(640, 780, 100, 100), pane)).toBe(false)
    // Zero-sized overlays or browser panes never count as overlapping.
    expect(rectOverlaps(makeRect(700, 200, 0, 100), pane)).toBe(false)
    expect(rectOverlaps(makeRect(700, 200, 100, 0), pane)).toBe(false)
    expect(rectOverlaps(makeRect(700, 200, 100, 100), makeRect(640, 80, 0, 700))).toBe(false)
  })
})

describe('covers', () => {
  it('checks data-overlay-layer overlap and skips elements inside data-closed', () => {
    const { body } = createFakeDom()
    const browserArea = new FakeElement(makeRect(640, 80, 600, 700))
    body.append(browserArea)

    const positioner = new FakeElement(makeRect(400, 300, 340, 220))
    const popup = new FakeElement(makeRect(400, 300, 340, 220))
    popup.setAttribute(OVERLAY_LAYER, '')
    positioner.append(popup)
    body.append(positioner)

    expect(covers(browserArea as unknown as Element, body as unknown as ParentNode)).toBe(true)

    // Closing animation marks data-closed on the popup or positioner so the pane can thaw.
    popup.setAttribute('data-closed', '')
    expect(covers(browserArea as unknown as Element, body as unknown as ParentNode)).toBe(false)

    popup.removeAttribute('data-closed')
    positioner.setAttribute('data-closed', '')
    expect(covers(browserArea as unknown as Element, body as unknown as ParentNode)).toBe(false)
  })
})

describe('observeOverlayGeometry', () => {
  it('re-checks coverage when an open overlay repositions into and back out of the browser pane', () => {
    FakeMutationObserver.instances = []
    FakeResizeObserver.instances = []

    const { body } = createFakeDom()
    const browserArea = new FakeElement(makeRect(640, 80, 600, 700))
    body.append(browserArea)

    const portal = new FakeElement()
    const positioner = new FakeElement(makeRect(200, 320, 340, 220))
    const popup = new FakeElement(makeRect(200, 320, 340, 220))
    popup.setAttribute(OVERLAY_LAYER, '')
    positioner.append(popup)
    portal.append(positioner)
    body.append(portal)

    const observedCover: boolean[] = []
    const onChange = vi.fn(() => {
      observedCover.push(covers(browserArea as unknown as Element, body as unknown as ParentNode))
    })

    const stop = observeOverlayGeometry(onChange, {
      root: body as unknown as ParentNode,
      MutationObserver: FakeMutationObserver as unknown as typeof MutationObserver,
      ResizeObserver: FakeResizeObserver as unknown as typeof ResizeObserver,
    })

    // Initially the popup sits left of the browser pane.
    expect(covers(browserArea as unknown as Element, body as unknown as ParentNode)).toBe(false)
    expect(onChange).not.toHaveBeenCalled()

    const [positionObserver, treeObserver] = FakeMutationObserver.instances
    expect(positionObserver?.observed.map((entry) => entry.target)).toEqual(
      expect.arrayContaining([popup, positioner, portal]),
    )
    expect(positionObserver?.observed.map((entry) => entry.target)).not.toContain(body)
    expect(treeObserver?.observed[0]?.target).toBe(body)

    // Typing shifts the positioner right so the popup crosses into the browser pane.
    popup.rect = makeRect(500, 320, 340, 220)
    positionObserver?.emit([{ type: 'attributes', attributeName: 'style' }])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(observedCover).toEqual([true])

    // Moving or narrowing brings the popup back clear of the browser pane.
    popup.rect = makeRect(200, 320, 340, 220)
    positionObserver?.emit([{ type: 'attributes', attributeName: 'style' }])
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(observedCover).toEqual([true, false])

    stop()
    expect(positionObserver?.disconnected).toBe(true)
    expect(treeObserver?.disconnected).toBe(true)
    expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true)
  })

  it('re-checks coverage when an open overlay resizes into and out of the browser pane', () => {
    FakeMutationObserver.instances = []
    FakeResizeObserver.instances = []

    const { body } = createFakeDom()
    const browserArea = new FakeElement(makeRect(640, 80, 600, 700))
    body.append(browserArea)

    const popup = new FakeElement(makeRect(440, 320, 180, 120))
    popup.setAttribute(OVERLAY_LAYER, '')
    body.append(popup)

    const states: boolean[] = []
    const onChange = vi.fn(() => {
      states.push(covers(browserArea as unknown as Element, body as unknown as ParentNode))
    })

    const stop = observeOverlayGeometry(onChange, {
      root: body as unknown as ParentNode,
      MutationObserver: FakeMutationObserver as unknown as typeof MutationObserver,
      ResizeObserver: FakeResizeObserver as unknown as typeof ResizeObserver,
    })

    const resizeObserver = FakeResizeObserver.instances[0]!
    expect(resizeObserver.observed.has(popup as unknown as Element)).toBe(true)
    expect(covers(browserArea as unknown as Element, body as unknown as ParentNode)).toBe(false)

    // Content widens past the pane boundary while staying open.
    popup.rect = makeRect(440, 320, 340, 240)
    resizeObserver.emit(popup as unknown as Element)
    expect(states).toEqual([true])

    // Content shrinks back out of the browser pane.
    popup.rect = makeRect(440, 320, 180, 120)
    resizeObserver.emit(popup as unknown as Element)
    expect(states).toEqual([true, false])

    stop()
  })

  it('tracks dynamically mounted nested overlays and ignores unrelated DOM mutations', () => {
    FakeMutationObserver.instances = []
    FakeResizeObserver.instances = []

    const { body } = createFakeDom()
    const browserArea = new FakeElement(makeRect(640, 80, 600, 700))
    body.append(browserArea)

    const onChange = vi.fn()
    const stop = observeOverlayGeometry(onChange, {
      root: body as unknown as ParentNode,
      MutationObserver: FakeMutationObserver as unknown as typeof MutationObserver,
      ResizeObserver: FakeResizeObserver as unknown as typeof ResizeObserver,
    })

    const [positionObserver, treeObserver] = FakeMutationObserver.instances
    const resizeObserver = FakeResizeObserver.instances[0]!

    // Unrelated edits (such as typing characters inside the editor) must not wake coverage checks.
    const editorSpan = new FakeElement(makeRect(100, 600, 40, 20))
    body.append(editorSpan)
    treeObserver?.emit([
      {
        type: 'childList',
        addedNodes: [editorSpan] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      },
    ])
    expect(onChange).not.toHaveBeenCalled()

    // Mounting a new overlay portal (or secondary flyout card) triggers checkCover and attaches observers.
    const portal = new FakeElement()
    const flyout = new FakeElement(makeRect(680, 400, 260, 240))
    flyout.setAttribute(OVERLAY_LAYER, '')
    portal.append(flyout)
    body.append(portal)

    treeObserver?.emit([
      {
        type: 'childList',
        addedNodes: [portal] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      },
    ])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(covers(browserArea as unknown as Element, body as unknown as ParentNode)).toBe(true)
    expect(resizeObserver.observed.has(flyout as unknown as Element)).toBe(true)
    expect(positionObserver?.observed.map((entry) => entry.target)).toContain(flyout)

    // Removing the overlay portal cleans up its ResizeObserver entry and re-checks coverage.
    body.removeChild(portal)
    treeObserver?.emit([
      {
        type: 'childList',
        addedNodes: [] as unknown as NodeList,
        removedNodes: [portal] as unknown as NodeList,
      },
    ])
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(covers(browserArea as unknown as Element, body as unknown as ParentNode)).toBe(false)
    expect(resizeObserver.observed.has(flyout as unknown as Element)).toBe(false)

    stop()
  })
})
