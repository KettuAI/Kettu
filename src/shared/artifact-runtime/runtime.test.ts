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
      selection: { path: 'index.html', src: 10, tag: 'div' },
    })
    expect(sent.at(-1)).not.toHaveProperty('pin')
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
  parentElement: FakeElement | null
  isConnected: boolean
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
  getBoundingClientRect: () => FakeRect
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
