import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommentAnchor } from '@shared/artifact-comments'
import enArtifacts from '@shared/locales/en/artifacts.json'
import zhArtifacts from '@shared/locales/zh-CN/artifacts.json'
import type { LiveAnchor, Rect } from './pop-place'

type LocaleId = 'en' | 'zh-CN'

const { localeRef } = vi.hoisted(() => {
  if (typeof globalThis.document === 'undefined') {
    Object.assign(globalThis, {
      document: {
        oninput: null,
        createElement: () => ({ oninput: () => {}, setAttribute() {}, style: {} }),
        documentElement: {},
      },
    })
  }
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        document: globalThis.document,
        kettu: { platform: 'darwin', client: 'desktop' },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
  return { localeRef: { current: 'en' as LocaleId } }
})

const DICTIONARIES = { en: enArtifacts, 'zh-CN': zhArtifacts } as const

function lookupKey(dict: Record<string, unknown>, path: string): string | undefined {
  let cur: unknown = dict
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'string' ? cur : undefined
}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) =>
      lookupKey(DICTIONARIES[localeRef.current] as Record<string, unknown>, key) ?? key,
  }),
}))

vi.mock('motion/react', () => ({
  useReducedMotionConfig: () => true,
  motion: {
    div: (props: Record<string, unknown> & { children?: ReactNode }) => {
      const rest: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(props)) {
        if (k !== 'children' && k !== 'initial' && k !== 'animate') rest[k] = v
      }
      return createElement('div', rest, props.children)
    },
  },
}))

vi.mock('@renderer/components/affect/app-shell', () => ({
  Icon: () => createElement('span', { 'data-icon': '' }),
}))

vi.mock('@renderer/components/affect/button', () => ({
  Button: (props: Record<string, unknown> & { children?: ReactNode }) => {
    const rest: Record<string, unknown> = { type: 'button' }
    for (const [k, v] of Object.entries(props)) {
      if (k !== 'children' && k !== 'loading' && k !== 'variant' && k !== 'size' && k !== 'icon') {
        rest[k] = v
      }
    }
    return createElement('button', rest, props.children)
  },
}))

class FakeStyle {
  private readonly props = new Map<string, string>()

  setProperty(name: string, value: string): void {
    this.props.set(name, value)
  }

  getPropertyValue(name: string): string {
    return this.props.get(name) ?? ''
  }

  get left(): string {
    return this.props.get('left') ?? ''
  }

  set left(value: string) {
    this.props.set('left', value)
  }

  get top(): string {
    return this.props.get('top') ?? ''
  }

  set top(value: string) {
    this.props.set('top', value)
  }

  get width(): string {
    return this.props.get('width') ?? ''
  }

  set width(value: string) {
    this.props.set('width', value)
  }
}

interface FakeEvent {
  type: string
  target: FakeDomNode | null
  currentTarget: FakeDomNode | null
  bubbles: boolean
  defaultPrevented: boolean
  propagationStopped: boolean
  preventDefault(): void
  stopPropagation(): void
}

class FakeNodeBase {
  static ELEMENT_NODE = 1
  static TEXT_NODE = 3
  static COMMENT_NODE = 8
  static DOCUMENT_NODE = 9
}

class FakeElementBase extends FakeNodeBase {}
class FakeDocumentBase extends FakeNodeBase {}

class FakeDomNode extends FakeElementBase {
  nodeType: number
  nodeName: string
  tagName?: string
  namespaceURI?: string
  nodeValue?: string
  childNodes: FakeDomNode[] = []
  parentNode: FakeDomNode | null = null
  ownerDocument: FakeDocument | null
  style = new FakeStyle()
  attributes = new Map<string, string>()
  listeners = new Map<string, Set<(event: FakeEvent) => void>>()
  captureListeners = new Map<string, Set<(event: FakeEvent) => void>>()
  offsetParent: FakeDomNode | null = null
  offsetHeight = 160
  oninput: unknown = null
  onchange: unknown = null
  onclick: unknown = null
  onkeydown: unknown = null
  private _value = ''
  private _rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }

  constructor(name: string, nodeType: number, owner: FakeDocument | null) {
    super()
    this.nodeType = nodeType
    this.nodeName = nodeType === 1 ? name.toUpperCase() : name
    this.tagName = nodeType === 1 ? name.toUpperCase() : undefined
    this.namespaceURI = nodeType === 1 ? 'http://www.w3.org/1999/xhtml' : undefined
    this.nodeValue = nodeType === 3 || nodeType === 8 ? '' : undefined
    this.ownerDocument = owner
  }

  get type(): string {
    return this.tagName === 'TEXTAREA' ? 'textarea' : (this.attributes.get('type') ?? '')
  }

  set type(value: string) {
    this.attributes.set('type', value)
  }

  contains(other: unknown): boolean {
    let cur = other as FakeDomNode | null
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }

  get value(): string {
    return this._value
  }

  set value(next: string) {
    this._value = String(next)
  }

  /** Simulates native user typing without tripping React's instance-level value tracker. */
  setUserValue(next: string): void {
    this._value = String(next)
  }

  get defaultValue(): string {
    return this._value
  }

  set defaultValue(next: string) {
    this._value = String(next)
  }

  get disabled(): boolean {
    return this.attributes.has('disabled')
  }

  set disabled(value: boolean) {
    if (value) this.attributes.set('disabled', '')
    else this.attributes.delete('disabled')
  }

  get className(): string {
    return this.attributes.get('class') ?? ''
  }

  set className(value: string) {
    this.attributes.set('class', value)
  }

  setRect(rect: { left: number; top: number; width: number; height: number }): void {
    this._rect = {
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
    }
  }

  getBoundingClientRect() {
    return { ...this._rect, x: this._rect.left, y: this._rect.top, toJSON: () => ({}) }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  focus(): void {}

  appendChild(child: FakeDomNode): FakeDomNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    child.offsetParent = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child: FakeDomNode, ref: FakeDomNode | null): FakeDomNode {
    if (!ref) return this.appendChild(child)
    if (child.parentNode) child.parentNode.removeChild(child)
    const idx = this.childNodes.indexOf(ref)
    child.parentNode = this
    child.offsetParent = this
    if (idx >= 0) this.childNodes.splice(idx, 0, child)
    else this.childNodes.push(child)
    return child
  }

  removeChild(child: FakeDomNode): FakeDomNode {
    const idx = this.childNodes.indexOf(child)
    if (idx >= 0) this.childNodes.splice(idx, 1)
    child.parentNode = null
    return child
  }

  addEventListener(
    type: string,
    fn: (event: FakeEvent) => void,
    capture?: boolean | { capture?: boolean },
  ): void {
    const useCapture = typeof capture === 'boolean' ? capture : Boolean(capture?.capture)
    const map = useCapture ? this.captureListeners : this.listeners
    let set = map.get(type)
    if (!set) {
      set = new Set()
      map.set(type, set)
    }
    set.add(fn)
  }

  removeEventListener(
    type: string,
    fn: (event: FakeEvent) => void,
    capture?: boolean | { capture?: boolean },
  ): void {
    const useCapture = typeof capture === 'boolean' ? capture : Boolean(capture?.capture)
    const map = useCapture ? this.captureListeners : this.listeners
    map.get(type)?.delete(fn)
  }

  dispatchEvent(event: FakeEvent): boolean {
    const chain: FakeDomNode[] = [this]
    for (let cur = this.parentNode; cur; cur = cur.parentNode) chain.unshift(cur)
    const doc = this.ownerDocument
    for (const fn of doc?.captureListeners.get(event.type) ?? []) {
      if (event.propagationStopped) break
      fn(event)
    }
    for (const node of chain) {
      if (event.propagationStopped) break
      event.currentTarget = node
      for (const fn of node.captureListeners.get(event.type) ?? []) fn(event)
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      if (event.propagationStopped) break
      const node = chain[i]!
      event.currentTarget = node
      for (const fn of node.listeners.get(event.type) ?? []) fn(event)
      if (!event.bubbles) break
    }
    if (event.bubbles && !event.propagationStopped) {
      for (const fn of doc?.bubbleListeners.get(event.type) ?? []) fn(event)
    }
    return !event.defaultPrevented
  }

  get firstChild(): FakeDomNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): FakeDomNode | null {
    return this.childNodes.at(-1) ?? null
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? ''
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.childNodes = []
    if (value) {
      const text = new FakeDomNode('#text', 3, this.ownerDocument)
      text.nodeValue = value
      this.appendChild(text)
    }
  }

  findAll(predicate: (node: FakeDomNode) => boolean): FakeDomNode[] {
    const found: FakeDomNode[] = []
    const walk = (node: FakeDomNode): void => {
      if (predicate(node)) found.push(node)
      for (const child of node.childNodes) walk(child)
    }
    walk(this)
    return found
  }
}

class FakeDocument extends FakeDocumentBase {
  nodeType = 9
  nodeName = '#document'
  documentElement: FakeDomNode
  head: FakeDomNode
  body: FakeDomNode
  defaultView: unknown = null
  activeElement: FakeDomNode | null = null
  captureListeners = new Map<string, Set<(event: FakeEvent) => void>>()
  bubbleListeners = new Map<string, Set<(event: FakeEvent) => void>>()

  constructor() {
    super()
    this.documentElement = new FakeDomNode('html', 1, this)
    this.head = new FakeDomNode('head', 1, this)
    this.body = new FakeDomNode('body', 1, this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }

  createElement(tag: string): FakeDomNode {
    return new FakeDomNode(tag, 1, this)
  }

  createElementNS(_ns: string, tag: string): FakeDomNode {
    return new FakeDomNode(tag, 1, this)
  }

  createTextNode(text: string): FakeDomNode {
    const node = new FakeDomNode('#text', 3, this)
    node.nodeValue = text
    return node
  }

  createComment(text: string): FakeDomNode {
    const node = new FakeDomNode('#comment', 8, this)
    node.nodeValue = text
    return node
  }

  addEventListener(
    type: string,
    fn: (event: FakeEvent) => void,
    capture?: boolean | { capture?: boolean },
  ): void {
    const useCapture = typeof capture === 'boolean' ? capture : Boolean(capture?.capture)
    const map = useCapture ? this.captureListeners : this.bubbleListeners
    let set = map.get(type)
    if (!set) {
      set = new Set()
      map.set(type, set)
    }
    set.add(fn)
  }

  removeEventListener(
    type: string,
    fn: (event: FakeEvent) => void,
    capture?: boolean | { capture?: boolean },
  ): void {
    const useCapture = typeof capture === 'boolean' ? capture : Boolean(capture?.capture)
    const map = useCapture ? this.captureListeners : this.bubbleListeners
    map.get(type)?.delete(fn)
  }
}

function makeEvent(type: string, target: FakeDomNode, bubbles = true): FakeEvent {
  return {
    type,
    target,
    currentTarget: target,
    bubbles,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this.propagationStopped = true
    },
  }
}

describe('CommentDraft scroll docking, draft preservation, and back-to-anchor interaction', () => {
  let root: Root | null = null
  let stage: FakeDomNode

  beforeEach(() => {
    localeRef.current = 'en'
    const doc = new FakeDocument()
    const winListeners = new Map<string, Set<() => void>>()
    const fakeWindow = {
      document: doc,
      navigator: { userAgent: 'node' },
      kettu: { platform: 'darwin', client: 'desktop' },
      HTMLElement: FakeElementBase,
      HTMLIFrameElement: FakeElementBase,
      SVGElement: FakeElementBase,
      Element: FakeElementBase,
      Node: FakeNodeBase,
      Document: FakeDocumentBase,
      innerWidth: 1000,
      innerHeight: 800,
      addEventListener: (type: string, fn: () => void) => {
        let set = winListeners.get(type)
        if (!set) {
          set = new Set()
          winListeners.set(type, set)
        }
        set.add(fn)
      },
      removeEventListener: (type: string, fn: () => void) => {
        winListeners.get(type)?.delete(fn)
      },
      requestAnimationFrame: (cb: () => void) => {
        cb()
        return 1
      },
      cancelAnimationFrame: () => {},
    }
    doc.defaultView = fakeWindow
    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('document', doc)
    vi.stubGlobal('Node', FakeNodeBase)
    vi.stubGlobal('Element', FakeElementBase)
    vi.stubGlobal('HTMLElement', FakeElementBase)
    vi.stubGlobal('requestAnimationFrame', fakeWindow.requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', fakeWindow.cancelAnimationFrame)

    stage = doc.createElement('div')
    stage.setRect({ left: 0, top: 0, width: 1000, height: 800 })
    doc.body.appendChild(stage)
  })

  afterEach(() => {
    if (root) {
      flushSync(() => root!.unmount())
      root = null
    }
    vi.unstubAllGlobals()
  })

  it('repositions beside the visible highlight box, preserves typed draft when scrolled offscreen, and triggers return-to-anchor', async () => {
    const { CommentDraft } = await import('./comment-pop')
    const anchor: CommentAnchor = {
      version: 1,
      path: 'index.html',
      page: null,
      offset: 42,
      tag: 'div',
      text: 'Long section',
      missing: false,
    }

    const clip: Rect = { left: 10, top: 10, right: 990, bottom: 740 }
    let currentAnchor: { box: Rect | null; clip: Rect | null } = {
      box: { left: 80, top: 180, right: 420, bottom: 900 },
      clip,
    }
    const listeners = new Set<() => void>()
    const pushAnchor = (box: Rect | null): void => {
      currentAnchor = { box, clip }
      for (const fn of listeners) fn()
    }
    const liveAnchor: LiveAnchor = {
      get: () => currentAnchor,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const onReturnToAnchor = vi.fn()
    const onCancel = vi.fn()

    root = createRoot(stage as unknown as HTMLElement)
    flushSync(() => {
      root!.render(
        createElement(CommentDraft, {
          anchor,
          at: currentAnchor.box,
          liveAnchor,
          onReturnToAnchor,
          onCancel,
          onSave: async () => {},
        }),
      )
    })

    const dialog = stage.findAll((n) => n.getAttribute('role') === 'dialog')[0]!
    expect(dialog).toBeDefined()
    // Initially placed outside the right edge of the highlight box (420 + 12 = 432).
    expect(dialog.style.left).toBe('432px')
    expect(dialog.style.top).toBe('180px')
    expect(dialog.getAttribute('data-offscreen')).toBeNull()

    // User types a half-written draft comment; verify React state updated (Submit button enabled).
    const textarea = stage.findAll((n) => n.tagName === 'TEXTAREA')[0]!
    const submitButton = () =>
      stage
        .findAll((n) => n.tagName === 'BUTTON')
        .find((b) => b.textContent.includes(enArtifacts.comments.comment))!
    expect(submitButton().getAttribute('disabled')).not.toBeNull()
    textarea.setUserValue('Check spacing in the footer too')
    flushSync(() => {
      textarea.dispatchEvent(makeEvent('input', textarea))
    })
    expect(textarea.value).toBe('Check spacing in the footer too')
    expect(submitButton().getAttribute('disabled')).toBeNull()

    // Scroll so the element's top leaves the viewport while its lower half remains visible.
    flushSync(() => {
      pushAnchor({ left: 80, top: -320, right: 420, bottom: 400 })
    })
    expect(dialog.style.left).toBe('432px')
    expect(dialog.style.top).toBe('52px')
    expect(dialog.getAttribute('data-offscreen')).toBeNull()
    expect(textarea.value).toBe('Check spacing in the footer too')

    // Scroll further so the anchor completely leaves above the viewport.
    flushSync(() => {
      pushAnchor({ left: 80, top: -820, right: 420, bottom: -100 })
    })
    expect(dialog.getAttribute('data-offscreen')).toBe('top')
    expect(dialog.style.left).toBe('432px')
    expect(dialog.style.top).toBe('52px')
    expect(onCancel).not.toHaveBeenCalled()
    // The textarea instance and user draft remain completely intact.
    expect(stage.findAll((n) => n.tagName === 'TEXTAREA')[0]).toBe(textarea)
    expect(textarea.value).toBe('Check spacing in the footer too')

    // The offscreen dock bar shows the "Back to element" button and invokes onReturnToAnchor on click.
    const backButton = stage.findAll((n) => n.className.includes('k-vt-pop__dock-back'))[0]!
    expect(backButton).toBeDefined()
    expect(backButton.textContent).toContain(enArtifacts.comments.backToAnchor)
    flushSync(() => {
      backButton.dispatchEvent(makeEvent('click', backButton))
    })
    expect(onReturnToAnchor).toHaveBeenCalledTimes(1)

    // After smooth scrolling returns the anchor into view, the dock bar hides and draft is preserved.
    flushSync(() => {
      pushAnchor({ left: 80, top: 210, right: 420, bottom: 930 })
    })
    expect(dialog.getAttribute('data-offscreen')).toBeNull()
    expect(stage.findAll((n) => n.className.includes('k-vt-pop__dock-back'))).toHaveLength(0)
    expect(dialog.style.left).toBe('432px')
    expect(dialog.style.top).toBe('210px')
    expect(textarea.value).toBe('Check spacing in the footer too')

    // Locale parity check for zh-CN copy.
    expect(zhArtifacts.comments.anchorOffscreen).toBeTruthy()
    expect(zhArtifacts.comments.backToAnchor).toBeTruthy()
  })
})
