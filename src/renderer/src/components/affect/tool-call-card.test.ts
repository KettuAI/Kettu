import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolCallCard, ToolCallGroup } from './tool-call-card'

class FakeNodeBase {}
class FakeElementBase extends FakeNodeBase {}
class FakeDocumentBase extends FakeNodeBase {}

interface FakeNode {
  nodeType: number
  nodeName: string
  tagName?: string
  namespaceURI?: string
  nodeValue?: string
  className?: string
  ownerDocument: FakeDocument | null
  parentNode: FakeNode | null
  childNodes: FakeNode[]
  attributes: Map<string, string>
  style: Record<string, string>
  setAttribute(attr: string, value: string): void
  removeAttribute(attr: string): void
  getAttribute(attr: string): string | null
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  addEventListener(type: string, fn: (event: unknown) => void): void
  removeEventListener(type: string, fn: (event: unknown) => void): void
  getRootNode(): FakeDocument | FakeNode
  querySelector(): FakeNode | null
  querySelectorAll(): FakeNode[]
  readonly firstChild: FakeNode | null
  readonly lastChild: FakeNode | null
  textContent: string
}

interface FakeDocument {
  nodeType: 9
  nodeName: '#document'
  documentElement: FakeNode
  head: FakeNode
  body: FakeNode
  activeElement: FakeNode | null
  defaultView: unknown
  hidden: boolean
  visibilityState: 'visible' | 'hidden'
  createElement(tag: string): FakeNode
  createElementNS(ns: string, tag: string): FakeNode
  createTextNode(text: string): FakeNode
  createComment(text: string): FakeNode
  querySelector(): FakeNode | null
  querySelectorAll(): FakeNode[]
  addEventListener(type: string, fn: () => void): void
  removeEventListener(type: string, fn: () => void): void
  setHidden(hidden: boolean): void
}

class FakeDomNode extends FakeElementBase implements FakeNode {
  nodeType: number
  nodeName: string
  tagName?: string
  namespaceURI?: string
  nodeValue?: string
  className?: string
  ownerDocument: FakeDocument | null
  parentNode: FakeNode | null = null
  childNodes: FakeNode[] = []
  attributes = new Map<string, string>()
  style: Record<string, string> = {}

  constructor(name: string, nodeType: number, owner: FakeDocument | null) {
    super()
    this.nodeName = name
    this.nodeType = nodeType
    this.tagName = nodeType === 1 ? name.toUpperCase() : undefined
    this.namespaceURI = nodeType === 1 ? 'http://www.w3.org/1999/xhtml' : undefined
    this.nodeValue = nodeType === 3 || nodeType === 8 ? '' : undefined
    this.ownerDocument = owner
  }

  setAttribute(attr: string, value: string): void {
    this.attributes.set(attr, String(value))
  }

  removeAttribute(attr: string): void {
    this.attributes.delete(attr)
  }

  getAttribute(attr: string): string | null {
    return this.attributes.get(attr) ?? null
  }

  appendChild(child: FakeNode): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const idx = ref ? this.childNodes.indexOf(ref) : -1
    if (idx < 0) this.childNodes.push(child)
    else this.childNodes.splice(idx, 0, child)
    return child
  }

  removeChild(child: FakeNode): FakeNode {
    const idx = this.childNodes.indexOf(child)
    if (idx >= 0) this.childNodes.splice(idx, 1)
    child.parentNode = null
    return child
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  getRootNode(): FakeDocument | FakeNode {
    return this.ownerDocument ?? this
  }

  querySelector(): FakeNode | null {
    return null
  }

  querySelectorAll(): FakeNode[] {
    return []
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? ''
    if (this.tagName === 'STYLE') return ''
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (value !== '' && this.ownerDocument) {
      const text = this.ownerDocument.createTextNode(String(value))
      text.parentNode = this
      this.childNodes.push(text)
    }
  }
}

function createFakeDom(): { doc: FakeDocument; container: FakeNode } {
  const listeners = new Map<string, Set<() => void>>()
  let hidden = false
  const makeNode = (name: string, nodeType: number, owner: FakeDocument | null): FakeNode =>
    new FakeDomNode(name, nodeType, owner)
  const doc: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as FakeNode,
    head: null as unknown as FakeNode,
    body: null as unknown as FakeNode,
    activeElement: null,
    defaultView: null,
    get hidden() {
      return hidden
    },
    get visibilityState() {
      return hidden ? 'hidden' : 'visible'
    },
    createElement(tag: string) {
      return makeNode(tag, 1, doc)
    },
    createElementNS(ns: string, tag: string) {
      const node = makeNode(tag, 1, doc)
      node.namespaceURI = ns
      return node
    },
    createTextNode(text: string) {
      const node = makeNode('#text', 3, doc)
      node.nodeValue = String(text)
      return node
    },
    createComment(text: string) {
      const node = makeNode('#comment', 8, doc)
      node.nodeValue = String(text)
      return node
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    addEventListener(type: string, fn: () => void) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(fn)
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn)
    },
    setHidden(next: boolean) {
      hidden = next
      for (const fn of [...(listeners.get('visibilitychange') ?? [])]) fn()
    },
  }
  const html = doc.createElement('html')
  const head = doc.createElement('head')
  const body = doc.createElement('body')
  html.appendChild(head)
  html.appendChild(body)
  doc.documentElement = html
  doc.head = head
  doc.body = body
  const container = doc.createElement('div')
  body.appendChild(container)
  return { doc, container }
}

function findByClass(root: FakeNode, name: string): FakeNode[] {
  const out: FakeNode[] = []
  const walk = (node: FakeNode) => {
    const raw =
      (typeof node.className === 'string' ? node.className : null) ??
      node.getAttribute('class') ??
      ''
    if (raw.split(/\s+/).includes(name)) out.push(node)
    for (const child of node.childNodes) walk(child)
  }
  walk(root)
  return out
}

describe('ToolCallCard and ToolCallGroup isolated adaptive stopwatches', () => {
  let doc: FakeDocument
  let container: FakeNode
  let root: Root | null = null

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    vi.setSystemTime(new Date('2026-11-28T00:00:00.000Z'))
    const dom = createFakeDom()
    doc = dom.doc
    container = dom.container
    const win = {
      document: doc,
      navigator: { userAgent: 'node' },
      HTMLElement: FakeElementBase,
      SVGElement: FakeElementBase,
      Element: FakeElementBase,
      Node: FakeNodeBase,
      Document: FakeDocumentBase,
      HTMLIFrameElement: FakeElementBase,
      setTimeout: (fn: TimerHandler, delay?: number) => globalThis.setTimeout(fn as () => void, delay),
      clearTimeout: (id?: number) => globalThis.clearTimeout(id),
      setInterval: (fn: TimerHandler, delay?: number) => globalThis.setInterval(fn as () => void, delay),
      clearInterval: (id?: number) => globalThis.clearInterval(id),
      addEventListener() {},
      removeEventListener() {},
    }
    doc.defaultView = win
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    vi.stubGlobal('HTMLElement', FakeElementBase)
    vi.stubGlobal('SVGElement', FakeElementBase)
    vi.stubGlobal('Element', FakeElementBase)
    vi.stubGlobal('Node', FakeNodeBase)
    vi.stubGlobal('Document', FakeDocumentBase)
    root = createRoot(container as unknown as HTMLElement)
  })

  afterEach(() => {
    if (root) {
      act(() => root!.unmount())
      root = null
    }
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  })

  it('starts no timer when time={false} on running ToolCallCard and ToolCallGroup', () => {
    let childRenders = 0
    function Probe() {
      childRenders++
      return createElement('span', null, 'body')
    }

    act(() => {
      root!.render(
        createElement(ToolCallGroup, {
          time: false,
          label: 'Work',
          children: createElement(
            ToolCallCard,
            { name: 'Bash', status: 'running', time: false },
            createElement(Probe),
          ),
        }),
      )
    })

    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(childRenders).toBe(1)
  })

  it('ticks ToolCallCard elapsed leaf without re-rendering card children, throttles past 60s, and pauses while hidden', () => {
    let childRenders = 0
    function Probe() {
      childRenders++
      return createElement('span', null, 'details')
    }

    const startedAt = Date.now()
    act(() => {
      root!.render(
        createElement(
          ToolCallCard,
          { name: 'Bash', status: 'running', startedAt, time: true },
          createElement(Probe),
        ),
      )
    })

    const timeText = () => findByClass(container, 'ui-tcc__time')[0]?.textContent ?? ''
    expect(timeText()).toBe('0.0s')
    expect(childRenders).toBe(1)

    // Advance 1.5s: leaf timer updates cleanly, card body does not re-render.
    act(() => {
      vi.advanceTimersByTime(1_550)
    })
    expect(timeText()).toBe('1.5s')
    expect(childRenders).toBe(1)

    // Cross 60s: format switches to whole seconds and timer steps down to 1s intervals.
    act(() => {
      vi.advanceTimersByTime(58_550)
    })
    expect(timeText()).toBe('1m 00s')
    expect(childRenders).toBe(1)

    // Mid-second advance past 60s should not tick or re-render anything.
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(timeText()).toBe('1m 00s')

    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(timeText()).toBe('1m 01s')
    expect(childRenders).toBe(1)

    // Hide the page: timer is cleared completely; reveal immediately catches up.
    act(() => {
      doc.setHidden(true)
    })
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(timeText()).toBe('1m 01s')

    act(() => {
      doc.setHidden(false)
    })
    expect(timeText()).toBe('1m 06s')
    expect(childRenders).toBe(1)
  })

  it('ticks ToolCallGroup elapsed leaf without re-rendering child cards', () => {
    let cardChildRenders = 0
    function Probe() {
      cardChildRenders++
      return createElement('span', null, 'step')
    }
    const startedAt = Date.now()
    act(() => {
      root!.render(
        createElement(ToolCallGroup, {
          time: true,
          label: 'Tools',
          children: createElement(
            ToolCallCard,
            { name: 'Read', status: 'running', startedAt, time: false },
            createElement(Probe),
          ),
        }),
      )
    })

    const groupTime = () => findByClass(container, 'ui-tcc-group__time')[0]?.textContent ?? ''
    expect(groupTime()).toBe('· 0.0s')
    expect(cardChildRenders).toBe(1)

    act(() => {
      vi.advanceTimersByTime(1_250)
    })
    expect(groupTime()).toBe('· 1.2s')
    expect(cardChildRenders).toBe(1)
  })
})
