import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_VERSION, type DriveMessage, type Pin } from './page-messages'
import { openPinForSource, start } from './runtime'

describe('openPinForSource', () => {
  it('matches an open pin anchored to the clicked source element', () => {
    const pins: Pin[] = [
      { n: 1, src: 10, answered: false },
      { n: 2, src: 24, answered: false },
    ]
    expect(openPinForSource(pins, 10)).toBe(1)
    expect(openPinForSource(pins, 24)).toBe(2)
    expect(openPinForSource(pins, 99)).toBeNull()
    expect(openPinForSource(pins, null)).toBeNull()
  })

  it('prefers the active open pin when an element has multiple open threads, else the latest', () => {
    const stacked: Pin[] = [
      { n: 1, src: 10, answered: false },
      { n: 2, src: 10, answered: false },
    ]
    expect(openPinForSource(stacked, 10)).toBe(2)

    const withActive: Pin[] = [
      { n: 1, src: 10, answered: false, active: true },
      { n: 2, src: 10, answered: false },
    ]
    expect(openPinForSource(withActive, 10)).toBe(1)
  })

  it('ignores resolved and lost pins so clicking the element still creates a new draft', () => {
    const pins: Pin[] = [
      { n: 1, src: 10, answered: false, kind: 'done' },
      { n: 2, src: 10, answered: false, kind: 'lost' },
    ]
    expect(openPinForSource(pins, 10)).toBeNull()
  })
})

describe('artifact runtime select-pick behavior', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mountRuntime(elements: {
    parent: FakeElement
    child: FakeElement
    hitAt: (x: number, y: number) => FakeElement | null
  }) {
    const sent: Record<string, unknown>[] = []
    const listeners = new Map<string, Set<(event: unknown) => void>>()
    const rafQueue: (() => void)[] = []

    const fakeDocument = {
      documentElement: { append: () => {} },
      body: {},
      createElement: () => makeOverlayNode(),
      querySelector: (selector: string) => {
        if (selector.includes('"m:10"')) return elements.parent
        if (selector.includes('"m:25"')) return elements.child
        return null
      },
      elementFromPoint: (x: number, y: number) => elements.hitAt(x, y),
    }

    const fakeWindow = {
      innerWidth: 800,
      innerHeight: 600,
      scrollX: 0,
      scrollY: 0,
      fetch: vi.fn(),
      parent: { postMessage: () => {} },
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        let set = listeners.get(type)
        if (!set) {
          set = new Set()
          listeners.set(type, set)
        }
        set.add(fn)
      },
      removeEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners.get(type)?.delete(fn)
      },
      scrollBy: () => {},
      scrollTo: () => {},
      getSelection: () => null,
      sessionStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    }

    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('location', {
      href: 'http://127.0.0.1/index.html',
      origin: 'http://127.0.0.1',
      pathname: '/index.html',
    })
    vi.stubGlobal('CSS', { supports: () => true })
    vi.stubGlobal('getComputedStyle', () => ({
      color: 'rgb(0, 0, 0)',
      backgroundColor: 'rgb(255, 255, 255)',
      fontSize: '14px',
      fontWeight: '400',
      textAlign: 'left',
      paddingTop: '0px',
      paddingRight: '0px',
      paddingBottom: '0px',
      paddingLeft: '0px',
      borderTopLeftRadius: '0px',
    }))
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
    vi.stubGlobal('ErrorEvent', class {})

    start({ v: RUNTIME_VERSION, transport: 'port', path: 'index.html', mark: 'm' })

    const port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: Record<string, unknown>) => sent.push(message),
      close: () => {},
    }

    const postDrive = (data: DriveMessage, ports: unknown[] = []) => {
      for (const fn of listeners.get('message') ?? []) {
        fn({ source: fakeWindow.parent, data, ports })
      }
    }

    postDrive({ v: RUNTIME_VERSION, kind: 'transport' }, [port])

    return {
      sent,
      postDrive,
      listeners,
      fakeWindow,
      dispatchWindow: (type: string) => {
        for (const fn of listeners.get(type) ?? []) fn({})
      },
      flushRaf: () => {
        const batch = rafQueue.splice(0)
        for (const cb of batch) cb()
      },
    }
  }

  it('opens an existing open thread when clicking the element body in comment mode, while keeping child elements and edit mode distinct', () => {
    const parent = makeFakeElement('div', 'm:10', 'Card container', {
      left: 100,
      top: 100,
      right: 300,
      bottom: 220,
      width: 200,
      height: 120,
    })
    const child = makeFakeElement(
      'p',
      'm:25',
      'Inner paragraph',
      { left: 120, top: 140, right: 260, bottom: 180, width: 140, height: 40 },
      parent,
    )
    parent.childElementCount = 1

    const { sent, postDrive, flushRaf } = mountRuntime({
      parent,
      child,
      hitAt: (x, y) => {
        if (x >= 120 && x <= 260 && y >= 140 && y <= 180) return child
        if (x >= 100 && x <= 300 && y >= 100 && y <= 220) return parent
        return null
      },
    })

    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-mode',
      mode: 'comment',
      channel: 'channel-0001',
      accent: '#0060e2',
    })
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-pins',
      pins: [
        { n: 1, src: 10, answered: false },
        { n: 2, src: 10, answered: false },
      ],
    })
    flushRaf()

    // Clicking the parent element's body (away from the 20x20 pins at top-right) opens its latest open thread.
    postDrive({ v: RUNTIME_VERSION, kind: 'select-pick', x: 110, y: 200 })
    expect(sent.at(-1)).toMatchObject({ kind: 'select', selection: null, pin: 2 })

    // Clicking pin #1's exact corner box (stacked at right-10 = 290, top-10 = 90) still opens pin #1 specifically.
    postDrive({ v: RUNTIME_VERSION, kind: 'select-pick', x: 295, y: 95 })
    expect(sent.at(-1)).toMatchObject({ kind: 'select', selection: null, pin: 1 })

    // Clicking a distinct child element reports a selection so the user can create a new thread on that child.
    postDrive({ v: RUNTIME_VERSION, kind: 'select-pick', x: 150, y: 160 })
    expect(sent.at(-1)).toMatchObject({
      kind: 'select',
      selection: { path: 'index.html', src: 25, tag: 'p', text: 'Inner paragraph' },
    })
    expect(sent.at(-1)).not.toHaveProperty('pin')

    // In Edit (select) mode, clicking the parent element body selects it for editing instead of opening the pin.
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-mode',
      mode: 'select',
      channel: 'channel-0001',
      accent: '#0060e2',
    })
    postDrive({ v: RUNTIME_VERSION, kind: 'select-pick', x: 110, y: 200 })
    expect(sent.at(-1)).toMatchObject({
      kind: 'select',
      selection: { path: 'index.html', src: 10, tag: 'div' },
    })
    expect(sent.at(-1)).not.toHaveProperty('pin')
  })

  it('creates a new selection when the element only has resolved pins', () => {
    const parent = makeFakeElement('div', 'm:10', 'Card container', {
      left: 100,
      top: 100,
      right: 300,
      bottom: 220,
      width: 200,
      height: 120,
    })
    const child = makeFakeElement('p', 'm:25', 'Unused', {
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
      width: 10,
      height: 10,
    })
    const { sent, postDrive, flushRaf } = mountRuntime({
      parent,
      child,
      hitAt: () => parent,
    })

    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-mode',
      mode: 'comment',
      channel: 'channel-0001',
      accent: '#0060e2',
    })
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-pins',
      pins: [{ n: 1, src: 10, answered: false, kind: 'done' }],
    })
    flushRaf()

    postDrive({ v: RUNTIME_VERSION, kind: 'select-pick', x: 150, y: 150 })
    expect(sent.at(-1)).toMatchObject({
      kind: 'select',
      selection: {
        path: 'index.html',
        src: 10,
        tag: 'div',
        box: { x: 100, y: 100, width: 200, height: 120 },
      },
    })
    expect(sent.at(-1)).not.toHaveProperty('pin')
  })

  it('tracks live anchor bounds across rAF-throttled scroll and resize, scrolls back smoothly, and cleans up listeners', () => {
    let parentRect: FakeRect = {
      left: 100,
      top: 120,
      right: 420,
      bottom: 720,
      width: 320,
      height: 600,
    }
    const parent = makeFakeElement('div', 'm:10', 'Long container', parentRect)
    parent.getBoundingClientRect = () => parentRect
    const child = makeFakeElement('p', 'm:25', 'Inner paragraph', {
      left: 120,
      top: 160,
      right: 300,
      bottom: 200,
      width: 180,
      height: 40,
    })

    const { sent, postDrive, listeners, fakeWindow, dispatchWindow, flushRaf } = mountRuntime({
      parent,
      child,
      hitAt: () => parent,
    })

    // Reveal returns the full highlight box of the element, not a fixed 20x20 pin stub.
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-reveal',
      src: 10,
      channel: 'channel-0001',
    })
    expect(sent.at(-1)).toMatchObject({
      kind: 'select',
      selection: null,
      located: { src: 10, box: { x: 100, y: 120, width: 320, height: 600 } },
    })

    // No scroll/resize listeners before anchor tracking starts.
    expect(listeners.get('scroll')?.size ?? 0).toBe(0)
    expect(listeners.get('resize')?.size ?? 0).toBe(0)

    // Start tracking by source offset: emits immediate initial snapshot and installs listeners.
    sent.length = 0
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-anchor',
      channel: 'channel-0001',
      target: 10,
    })
    expect(listeners.get('scroll')?.size).toBe(1)
    expect(listeners.get('resize')?.size).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      kind: 'select',
      channel: 'channel-0001',
      selection: null,
      anchor: {
        box: { x: 100, y: 120, width: 320, height: 600 },
        viewport: { width: 800, height: 600 },
      },
    })

    // Multiple scroll events within a single frame coalesce into one rAF-throttled update.
    sent.length = 0
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100)
    parentRect = { left: 100, top: -640, right: 420, bottom: -40, width: 320, height: 600 }
    dispatchWindow('scroll')
    dispatchWindow('scroll')
    dispatchWindow('scroll')
    expect(sent).toHaveLength(0)
    flushRaf()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      kind: 'select',
      anchor: {
        box: { x: 100, y: -640, width: 320, height: 600 },
        viewport: { width: 800, height: 600 },
      },
    })

    // Unchanged geometry does not emit duplicate reports.
    sent.length = 0
    nowSpy.mockReturnValue(Date.now() + 200)
    dispatchWindow('scroll')
    flushRaf()
    expect(sent).toHaveLength(0)

    // Viewport resize updates the anchor report.
    fakeWindow.innerWidth = 640
    fakeWindow.innerHeight = 480
    nowSpy.mockReturnValue(Date.now() + 300)
    dispatchWindow('resize')
    flushRaf()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      anchor: { viewport: { width: 640, height: 480 } },
    })

    // Back-to-anchor command smoothly scrolls the element back into the center of the viewport.
    postDrive({ v: RUNTIME_VERSION, kind: 'select-scroll-anchor' })
    expect(parent.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'smooth',
    })

    // Stopping anchor tracking removes listeners so subsequent scrolls send nothing.
    sent.length = 0
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-anchor',
      channel: 'channel-0001',
      target: null,
    })
    expect(listeners.get('scroll')?.size ?? 0).toBe(0)
    expect(listeners.get('resize')?.size ?? 0).toBe(0)
    parentRect = { left: 100, top: 80, right: 420, bottom: 680, width: 320, height: 600 }
    dispatchWindow('scroll')
    flushRaf()
    expect(sent).toHaveLength(0)
    nowSpy.mockRestore()
  })

  it('tracks and scrolls back to a script-generated picked element with src = null', () => {
    let dynamicRect: FakeRect = {
      left: 50,
      top: 80,
      right: 250,
      bottom: 200,
      width: 200,
      height: 120,
    }
    const dynamicEl = makeFakeElement('section', '', 'Dynamic card', dynamicRect)
    dynamicEl.removeAttribute('data-kettu-src')
    dynamicEl.getBoundingClientRect = () => dynamicRect
    const unused = makeFakeElement('p', 'm:25', 'Unused', {
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
      width: 10,
      height: 10,
    })

    const { sent, postDrive, dispatchWindow, flushRaf } = mountRuntime({
      parent: dynamicEl,
      child: unused,
      hitAt: () => dynamicEl,
    })

    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-mode',
      mode: 'comment',
      channel: 'channel-0001',
      accent: '#0060e2',
    })
    postDrive({ v: RUNTIME_VERSION, kind: 'select-pick', x: 100, y: 120 })
    expect(sent.at(-1)).toMatchObject({
      selection: { src: null, tag: 'section', box: { x: 50, y: 80, width: 200, height: 120 } },
    })

    sent.length = 0
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-anchor',
      channel: 'channel-0001',
      target: 'picked',
    })
    expect(sent.at(-1)).toMatchObject({
      anchor: { box: { x: 50, y: 80, width: 200, height: 120 } },
    })

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100)
    dynamicRect = { left: 50, top: 750, right: 250, bottom: 870, width: 200, height: 120 }
    dispatchWindow('scroll')
    flushRaf()
    expect(sent.at(-1)).toMatchObject({
      anchor: { box: { x: 50, y: 750, width: 200, height: 120 } },
    })

    postDrive({ v: RUNTIME_VERSION, kind: 'select-scroll-anchor', target: 'picked' })
    expect(dynamicEl.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'smooth',
    })
    nowSpy.mockRestore()
  })

  it('supports marquee preview, commit, union anchor tracking on scroll, item removal, and ignores marquee in comment mode', () => {
    let card1Rect: FakeRect = {
      left: 40,
      top: 60,
      right: 240,
      bottom: 180,
      width: 200,
      height: 120,
    }
    let card2Rect: FakeRect = {
      left: 260,
      top: 100,
      right: 460,
      bottom: 260,
      width: 200,
      height: 160,
    }
    const card3Rect: FakeRect = {
      left: 500,
      top: 100,
      right: 700,
      bottom: 260,
      width: 200,
      height: 160,
    }

    const section = makeFakeElement('section', 'm:5', '', {
      left: 20,
      top: 40,
      right: 720,
      bottom: 300,
      width: 700,
      height: 260,
    })
    const card1 = makeFakeElement('article', 'm:10', 'Card 1', card1Rect, section)
    const card2 = makeFakeElement('article', 'm:25', 'Card 2', card2Rect, section)
    const card3 = makeFakeElement('article', 'm:40', 'Card 3', card3Rect, section)
    card1.getBoundingClientRect = () => card1Rect
    card2.getBoundingClientRect = () => card2Rect
    section.children.push(card1, card2, card3)
    section.childElementCount = 3

    const { sent, postDrive, dispatchWindow, flushRaf } = mountRuntime({
      parent: card1,
      child: card2,
      hitAt: () => card1,
    })

    // Attach section to fake document.body so findMarqueeElements discovers it.
    ;(document.body as unknown as { children: FakeElement[] }).children = [section]
    vi.stubGlobal('getComputedStyle', (el?: unknown) => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      pointerEvents: 'auto',
      color: 'rgb(0, 0, 0)',
      backgroundColor:
        el === card1 || el === card2 || el === card3 ? 'rgb(240, 240, 240)' : 'rgba(0, 0, 0, 0)',
      boxShadow: 'none',
      borderTopWidth: '0px',
      borderTopStyle: 'none',
      fontSize: '14px',
      fontWeight: '400',
      textAlign: 'left',
      paddingTop: '0px',
      paddingRight: '0px',
      paddingBottom: '0px',
      paddingLeft: '0px',
      borderTopLeftRadius: '0px',
    }))

    // In comment mode, marquee commands are ignored completely.
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-mode',
      mode: 'comment',
      channel: 'channel-0001',
      accent: '#0060e2',
    })
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-marquee',
      rect: { x: 30, y: 50, width: 450, height: 220 },
      commit: true,
    })
    expect(sent).toHaveLength(0)

    // Switch to select mode and preview a marquee sweep (no message sent during preview).
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-mode',
      mode: 'select',
      channel: 'channel-0001',
      accent: '#0060e2',
    })
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-marquee',
      rect: { x: 30, y: 50, width: 450, height: 220 },
      commit: false,
    })
    flushRaf()
    expect(sent).toHaveLength(0)

    // Commit marquee: reports card1 and card2 without the outer section container.
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-marquee',
      rect: { x: 30, y: 50, width: 450, height: 220 },
      commit: true,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      kind: 'select',
      selection: null,
      selections: [
        { src: 10, tag: 'article', text: 'Card 1', box: { x: 40, y: 60, width: 200, height: 120 } },
        {
          src: 25,
          tag: 'article',
          text: 'Card 2',
          box: { x: 260, y: 100, width: 200, height: 160 },
        },
      ],
    })

    // Start anchor tracking with target: 'picked' -> reports the union box of card1 + card2.
    sent.length = 0
    postDrive({
      v: RUNTIME_VERSION,
      kind: 'select-anchor',
      channel: 'channel-0001',
      target: 'picked',
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      anchor: {
        box: { x: 40, y: 60, width: 420, height: 200 },
        viewport: { width: 800, height: 600 },
      },
    })

    // Scrolling updates the live union anchor bounds dynamically.
    sent.length = 0
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100)
    card1Rect = { left: 40, top: -240, right: 240, bottom: -120, width: 200, height: 120 }
    card2Rect = { left: 260, top: -200, right: 460, bottom: -40, width: 200, height: 160 }
    dispatchWindow('scroll')
    flushRaf()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      anchor: { box: { x: 40, y: -240, width: 420, height: 200 } },
    })

    // Removing index 0 shrinks the tracked union box to card2 alone immediately.
    sent.length = 0
    nowSpy.mockReturnValue(Date.now() + 200)
    postDrive({ v: RUNTIME_VERSION, kind: 'select-remove', index: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      anchor: { box: { x: 260, y: -200, width: 200, height: 160 } },
    })

    // Back-to-selection scrolls the remaining element into view smoothly.
    postDrive({ v: RUNTIME_VERSION, kind: 'select-scroll-anchor', target: 'picked' })
    expect(card2.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'smooth',
    })

    nowSpy.mockRestore()
  })
})

interface FakeRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

interface FakeElement {
  localName: string
  innerText: string
  textContent: string
  childElementCount: number
  children: FakeElement[]
  childNodes: Array<{ nodeType: number; nodeValue?: string }>
  parentElement: FakeElement | null
  isConnected: boolean
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
  getBoundingClientRect: () => FakeRect
  scrollIntoView: ReturnType<typeof vi.fn>
  contains: (node: unknown) => boolean
}

function makeFakeElement(
  tag: string,
  srcAttr: string,
  text: string,
  rect: FakeRect,
  parent: FakeElement | null = null,
): FakeElement {
  const attrs = new Map<string, string>([['data-kettu-src', srcAttr]])
  const el: FakeElement = {
    localName: tag,
    innerText: text,
    textContent: text,
    childElementCount: 0,
    children: [],
    childNodes: text ? [{ nodeType: 3, nodeValue: text }] : [],
    parentElement: parent,
    isConnected: true,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => {
      attrs.set(name, value)
    },
    removeAttribute: (name) => {
      attrs.delete(name)
    },
    getBoundingClientRect: () => rect,
    scrollIntoView: vi.fn(),
    contains: (node) => node === el,
  }
  return el
}

interface FakeOverlayNode {
  className: string
  textContent: string
  isConnected: boolean
  children: FakeOverlayNode[]
  style: {
    display: string
    left: string
    top: string
    width: string
    height: string
    setProperty: () => void
  }
  readonly lastChild: FakeOverlayNode | null
  append: (...items: FakeOverlayNode[]) => void
  remove: () => void
  attachShadow: () => { append: (...items: FakeOverlayNode[]) => void }
}

function makeOverlayNode(): FakeOverlayNode {
  const children: FakeOverlayNode[] = []
  const node: FakeOverlayNode = {
    className: '',
    textContent: '',
    isConnected: true,
    children,
    style: {
      display: '',
      left: '',
      top: '',
      width: '',
      height: '',
      setProperty: () => {},
    },
    get lastChild() {
      return children.at(-1) ?? null
    },
    append: (...items) => {
      children.push(...items)
    },
    remove: () => {},
    attachShadow: () => ({
      append: (...items) => {
        children.push(...items)
      },
    }),
  }
  return node
}
