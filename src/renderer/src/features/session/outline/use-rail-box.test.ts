import { act, createElement, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasRailRoom, LEFT_GRIP_INSET_PX, RAIL_WIDTH_PX, ROOM_PX } from './rail'
import { useRailBox, type RailBox } from './use-rail-box'

const { outlineRowsMock } = vi.hoisted(() => ({
  outlineRowsMock: [
    { entryId: 'u1', pos: 0, label: 'First prompt', titled: true },
    { entryId: 'u2', pos: 1, label: 'Second prompt', titled: true },
    { entryId: 'u3', pos: 2, label: 'Third prompt', titled: true },
  ],
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuTrigger: ({ className }: { className?: string }) =>
    createElement('button', { className }),
}))

vi.mock('@renderer/components/ui/hover-card', () => ({
  HoverCard: () => null,
  HoverCardContent: () => null,
}))

vi.mock('@renderer/components/glide-highlight', () => ({
  GlideHighlight: () => null,
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => null,
}))

vi.mock('@renderer/stores/find', () => ({
  askFindMatch: vi.fn(),
  useFindStore: (selector: (state: { shown: Record<string, undefined> }) => unknown) =>
    selector({ shown: {} }),
}))

vi.mock('./use-jump', () => ({
  useJumpToMessage: () => ({ jumpTo: vi.fn(), waiting: null }),
}))

vi.mock('./use-outline', () => ({
  useOutline: () => ({ rows: outlineRowsMock, opened: vi.fn() }),
}))

import { MessageOutline } from './message-outline'

interface FakeElement {
  nodeType: number
  nodeName: string
  tagName: string
  className: string
  id: string
  dataset: Record<string, string>
  attributes: Map<string, string>
  childNodes: FakeElement[]
  children: FakeElement[]
  parentNode: FakeElement | null
  ownerDocument: FakeDocument | null
  style: Record<string, string>
  clientHeight: number
  rect: { left: number; top: number; width: number; height: number }
  paddingLeft: string
  addEventListener(): void
  removeEventListener(): void
  appendChild(child: FakeElement): FakeElement
  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement
  removeChild(child: FakeElement): FakeElement
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
  querySelector(selector: string): FakeElement | null
}

interface FakeDocument {
  nodeType: number
  nodeName: string
  body: FakeElement
  defaultView: unknown
  createElement(tag: string): FakeElement
  createTextNode(text: string): FakeElement
  createComment(text: string): FakeElement
  addEventListener(): void
  removeEventListener(): void
}

class FakeElementStub {}

function findByClass(root: FakeElement, classToken: string): FakeElement | null {
  for (const child of root.childNodes) {
    if (child.className.split(/\s+/).includes(classToken)) return child
    const nested = findByClass(child, classToken)
    if (nested) return nested
  }
  return null
}

function makeFakeDom() {
  const makeEl = (tag: string, ownerDocument: FakeDocument | null): FakeElement => {
    const el: FakeElement = {
      nodeType: tag === '#text' ? 3 : tag === '#comment' ? 8 : 1,
      nodeName: tag.startsWith('#') ? tag : tag.toUpperCase(),
      tagName: tag.startsWith('#') ? '' : tag.toUpperCase(),
      className: '',
      id: '',
      dataset: {},
      attributes: new Map(),
      childNodes: [],
      children: [],
      parentNode: null,
      ownerDocument,
      style: {},
      clientHeight: 0,
      rect: { left: 0, top: 0, width: 0, height: 0 },
      paddingLeft: '32px',
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) {
        child.parentNode = this
        this.childNodes.push(child)
        if (child.nodeType === 1) this.children.push(child)
        return child
      },
      insertBefore(child, ref) {
        child.parentNode = this
        if (!ref) {
          this.childNodes.push(child)
        } else {
          const idx = this.childNodes.indexOf(ref)
          if (idx < 0) this.childNodes.push(child)
          else this.childNodes.splice(idx, 0, child)
        }
        if (child.nodeType === 1) {
          this.children = this.childNodes.filter((n) => n.nodeType === 1)
        }
        return child
      },
      removeChild(child) {
        const idx = this.childNodes.indexOf(child)
        if (idx >= 0) this.childNodes.splice(idx, 1)
        if (child.nodeType === 1) {
          this.children = this.childNodes.filter((n) => n.nodeType === 1)
        }
        child.parentNode = null
        return child
      },
      setAttribute(name, value) {
        this.attributes.set(name, value)
        if (name === 'class') this.className = value
        if (name === 'id') this.id = value
      },
      removeAttribute(name) {
        this.attributes.delete(name)
        if (name === 'class') this.className = ''
        if (name === 'id') this.id = ''
      },
      getAttribute(name) {
        return this.attributes.get(name) ?? null
      },
      getBoundingClientRect() {
        return this.rect
      },
      querySelector(selector: string) {
        if (selector.startsWith('.')) return findByClass(this, selector.slice(1))
        return null
      },
    }
    return el
  }

  const doc: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    body: null as unknown as FakeElement,
    defaultView: null,
    createElement(tag: string) {
      return makeEl(tag, doc)
    },
    createTextNode() {
      return makeEl('#text', doc)
    },
    createComment() {
      return makeEl('#comment', doc)
    },
    addEventListener() {},
    removeEventListener() {},
  }
  doc.body = makeEl('body', doc)

  const win = {
    document: doc,
    navigator: { userAgent: 'vitest-node' },
    HTMLElement: FakeElementStub,
    Element: FakeElementStub,
    Node: FakeElementStub,
    Document: FakeElementStub,
    HTMLIFrameElement: FakeElementStub,
    getComputedStyle: (el: FakeElement) => ({ paddingLeft: el.paddingLeft ?? '0px' }),
    addEventListener() {},
    removeEventListener() {},
  }
  doc.defaultView = win
  return { doc, win, makeEl }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly callback: ResizeObserverCallback
  readonly observed = new Set<Element>()
  disconnected = false

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    if (!this.disconnected) this.observed.add(target)
  }

  unobserve(target: Element): void {
    this.observed.delete(target)
  }

  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }

  static trigger(target: Element): void {
    for (const instance of [...FakeResizeObserver.instances]) {
      if (!instance.disconnected && instance.observed.has(target)) {
        instance.callback([], instance as unknown as ResizeObserver)
      }
    }
  }

  static reset(): void {
    FakeResizeObserver.instances = []
  }
}

class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class FakeMutationObserver {
  observe(): void {}
  disconnect(): void {}
}

const GLOBAL_KEYS = [
  'IS_REACT_ACT_ENVIRONMENT',
  'window',
  'document',
  'getComputedStyle',
  'HTMLElement',
  'Element',
  'Node',
  'Document',
  'HTMLIFrameElement',
  'ResizeObserver',
  'IntersectionObserver',
  'MutationObserver',
] as const

const savedGlobals: Record<string, unknown> = {}
const roots: Root[] = []

function installDom(doc: FakeDocument, win: Record<string, unknown>): void {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: win,
    document: doc,
    getComputedStyle: win.getComputedStyle,
    HTMLElement: FakeElementStub,
    Element: FakeElementStub,
    Node: FakeElementStub,
    Document: FakeElementStub,
    HTMLIFrameElement: FakeElementStub,
    ResizeObserver: FakeResizeObserver,
    IntersectionObserver: FakeIntersectionObserver,
    MutationObserver: FakeMutationObserver,
  })
}

beforeEach(() => {
  FakeResizeObserver.reset()
  for (const key of GLOBAL_KEYS) {
    savedGlobals[key] = (globalThis as Record<string, unknown>)[key]
  }
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  for (const key of GLOBAL_KEYS) {
    const prev = savedGlobals[key]
    if (prev === undefined) delete (globalThis as Record<string, unknown>)[key]
    else (globalThis as Record<string, unknown>)[key] = prev
  }
})

describe('hasRailRoom', () => {
  it('clears the left width grip hit zone cleanly at the standard px-8 column inset', () => {
    const inset = 32
    // Old threshold (text = 40 -> columnLeft = 8) placed the grip hit zone [17..31] under .ks-outline [0..36].
    expect(hasRailRoom(0, inset)).toBe(false)
    expect(hasRailRoom(8, inset)).toBe(false)
    // At columnLeft = 26 (text = 58), grip hit zone [35..49] still overlaps .ks-outline [0..36].
    expect(hasRailRoom(26, inset)).toBe(false)
    // At columnLeft = 27..30, grip hit zone [36..39] touches or crowds .ks-outline without the 4px clearance.
    expect(hasRailRoom(27, inset)).toBe(false)
    expect(hasRailRoom(30, inset)).toBe(false)

    // First safe columnLeft is ROOM_PX - LEFT_GRIP_INSET_PX = 31 (text = 63):
    // grip hit zone starts at 31 + 9 = 40px, leaving 4px clear past .ks-outline's 36px width.
    const minColumnLeft = ROOM_PX - LEFT_GRIP_INSET_PX
    expect(minColumnLeft).toBe(31)
    expect(minColumnLeft + LEFT_GRIP_INSET_PX).toBeGreaterThan(RAIL_WIDTH_PX)
    expect(hasRailRoom(minColumnLeft, inset)).toBe(true)
    expect(hasRailRoom(104, inset)).toBe(true)
  })

  it('respects both the text inset and the left grip hit zone across varying column insets', () => {
    // Small inset: text edge is nearer than the grip's 9px offset.
    expect(hasRailRoom(39, 0)).toBe(false)
    expect(hasRailRoom(40, 0)).toBe(true)
    expect(hasRailRoom(35, 4)).toBe(false)
    expect(hasRailRoom(36, 4)).toBe(true)

    // Large inset: left grip remains anchored at column.left + 9px, so columnLeft >= 31 still applies.
    expect(hasRailRoom(30, 48)).toBe(false)
    expect(hasRailRoom(31, 48)).toBe(true)

    // Invalid or negative values never falsely enable the rail.
    expect(hasRailRoom(-10, 32)).toBe(false)
    expect(hasRailRoom(31, Number.NaN)).toBe(false)
    expect(hasRailRoom(40, -12)).toBe(true)
  })
})

describe('useRailBox', () => {
  function mountRailBox(
    doc: FakeDocument,
    viewport: RefObject<HTMLElement | null>,
    content: RefObject<HTMLElement | null>,
  ) {
    let latest: RailBox = { height: 0, room: false }
    function Harness({
      v,
      c,
    }: {
      v: RefObject<HTMLElement | null>
      c: RefObject<HTMLElement | null>
    }) {
      latest = useRailBox(v, c)
      return null
    }
    const container = doc.createElement('div')
    const root = createRoot(container as unknown as Element)
    roots.push(root)
    act(() => root.render(createElement(Harness, { v: viewport, c: content })))
    return {
      get current(): RailBox {
        return latest
      },
      rerender(
        nextViewport: RefObject<HTMLElement | null>,
        nextContent: RefObject<HTMLElement | null>,
      ) {
        act(() => root.render(createElement(Harness, { v: nextViewport, c: nextContent })))
      },
      unmount() {
        act(() => root.unmount())
      },
    }
  }

  it('observes both viewport and content column and updates immediately when only the column resizes', () => {
    const { doc, win, makeEl } = makeFakeDom()
    installDom(doc, win)

    const viewEl = makeEl('div', doc)
    viewEl.clientHeight = 820
    viewEl.rect = { left: 272, top: 0, width: 1000, height: 820 }

    const colEl = makeEl('div', doc)
    colEl.paddingLeft = '32px'
    // Standard desktop width (792px column centered inside 1000px viewport -> columnLeft = 104px).
    colEl.rect = { left: 272 + 104, top: 0, width: 792, height: 1400 }

    const viewport = { current: viewEl as unknown as HTMLElement }
    const content = { current: colEl as unknown as HTMLElement }
    const hook = mountRailBox(doc, viewport, content)

    expect(FakeResizeObserver.instances).toHaveLength(1)
    const observer = FakeResizeObserver.instances[0]!
    expect(observer.observed.has(viewEl as unknown as Element)).toBe(true)
    expect(observer.observed.has(colEl as unknown as Element)).toBe(true)
    expect(hook.current).toEqual({ height: 820, room: true })

    // Widen the column via drag/settings without changing viewport dimensions.
    colEl.rect = { left: 272 + 20, top: 0, width: 960, height: 1200 }
    act(() => FakeResizeObserver.trigger(colEl as unknown as Element))
    expect(hook.current).toEqual({ height: 820, room: false })

    // Threshold check: columnLeft = 30px (grip hit zone 39..53px) stays hidden; 31px (40..54px) shows.
    colEl.rect = { left: 272 + 30, top: 0, width: 940, height: 1200 }
    act(() => FakeResizeObserver.trigger(colEl as unknown as Element))
    expect(hook.current).toEqual({ height: 820, room: false })

    colEl.rect = { left: 272 + 31, top: 0, width: 938, height: 1200 }
    act(() => FakeResizeObserver.trigger(colEl as unknown as Element))
    expect(hook.current).toEqual({ height: 820, room: true })

    // Reset back to full preset margin -> stays visible, and viewport resize still updates height.
    colEl.rect = { left: 272 + 104, top: 0, width: 792, height: 1400 }
    viewEl.clientHeight = 640
    act(() => FakeResizeObserver.trigger(viewEl as unknown as Element))
    expect(hook.current).toEqual({ height: 640, room: true })
  })

  it('disconnects the observer on ref changes and unmount', () => {
    const { doc, win, makeEl } = makeFakeDom()
    installDom(doc, win)

    const view1 = makeEl('div', doc)
    view1.clientHeight = 700
    view1.rect = { left: 0, top: 0, width: 1000, height: 700 }
    const col1 = makeEl('div', doc)
    col1.rect = { left: 100, top: 0, width: 800, height: 1000 }

    const view2 = makeEl('div', doc)
    view2.clientHeight = 900
    view2.rect = { left: 0, top: 0, width: 1000, height: 900 }
    const col2 = makeEl('div', doc)
    col2.rect = { left: 10, top: 0, width: 980, height: 1000 }

    const hook = mountRailBox(
      doc,
      { current: view1 as unknown as HTMLElement },
      { current: col1 as unknown as HTMLElement },
    )
    expect(FakeResizeObserver.instances).toHaveLength(1)
    const firstObserver = FakeResizeObserver.instances[0]!
    expect(firstObserver.disconnected).toBe(false)
    expect(hook.current).toEqual({ height: 700, room: true })

    // Swapping refs disconnects the old observer and attaches a new one to the new elements.
    hook.rerender(
      { current: view2 as unknown as HTMLElement },
      { current: col2 as unknown as HTMLElement },
    )
    expect(firstObserver.disconnected).toBe(true)
    expect(FakeResizeObserver.instances).toHaveLength(2)
    const secondObserver = FakeResizeObserver.instances[1]!
    expect(secondObserver.disconnected).toBe(false)
    expect(secondObserver.observed.has(view2 as unknown as Element)).toBe(true)
    expect(secondObserver.observed.has(col2 as unknown as Element)).toBe(true)
    expect(hook.current).toEqual({ height: 900, room: false })

    // Unmounting disconnects the active observer cleanly.
    hook.unmount()
    expect(secondObserver.disconnected).toBe(true)
  })

  it('skips observing when either ref is null', () => {
    const { doc, win, makeEl } = makeFakeDom()
    installDom(doc, win)

    const viewEl = makeEl('div', doc)
    const hook = mountRailBox(doc, { current: viewEl as unknown as HTMLElement }, { current: null })
    expect(FakeResizeObserver.instances).toHaveLength(0)
    expect(hook.current).toEqual({ height: 0, room: false })
  })
})

describe('MessageOutline column resize visibility', () => {
  it('hides the rail when widening the column and restores it when narrowing without viewport resize', () => {
    const { doc, win, makeEl } = makeFakeDom()
    installDom(doc, win)

    const viewEl = makeEl('div', doc)
    viewEl.clientHeight = 820
    viewEl.rect = { left: 200, top: 0, width: 1000, height: 820 }

    const colEl = makeEl('div', doc)
    colEl.paddingLeft = '32px'
    colEl.rect = { left: 200 + 104, top: 0, width: 792, height: 1400 }

    const viewport = { current: viewEl as unknown as HTMLDivElement }
    const content = { current: colEl as unknown as HTMLDivElement }
    const container = doc.createElement('div')
    const root = createRoot(container as unknown as Element)
    roots.push(root)

    act(() => {
      root.render(
        createElement(MessageOutline, {
          sessionId: 's-1',
          viewport,
          content,
          jumps: { reveal: vi.fn().mockResolvedValue(undefined), hold: vi.fn() },
        }),
      )
    })

    // Initially rendered because columnLeft = 104px clears both the rail and left width grip.
    expect(container.querySelector('.ks-outline')).not.toBeNull()

    // Widen column into the grip overlap zone (columnLeft = 20px) while viewport stays unchanged.
    colEl.rect = { left: 200 + 20, top: 0, width: 960, height: 1200 }
    act(() => FakeResizeObserver.trigger(colEl as unknown as Element))
    expect(container.querySelector('.ks-outline')).toBeNull()

    // Narrow / reset column back to standard width -> rail reappears immediately.
    colEl.rect = { left: 200 + 104, top: 0, width: 792, height: 1400 }
    act(() => FakeResizeObserver.trigger(colEl as unknown as Element))
    expect(container.querySelector('.ks-outline')).not.toBeNull()
  })
})
