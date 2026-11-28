import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommentAnchor } from '@shared/artifact-comments'
import type { PageBox } from '@shared/artifact-runtime/page-messages'
import enArtifacts from '@shared/locales/en/artifacts.json'
import zhArtifacts from '@shared/locales/zh-CN/artifacts.json'
import type { EditorFrame, PickedGroup } from './editor'
import { exceededMarqueeThreshold, MARQUEE_THRESHOLD, normalizeMarqueeRect } from './marquee-drag'
import type { SendTargets } from './send-targets'

type LocaleId = 'en' | 'zh-CN'

const { localeRef, sendToSessionMock } = vi.hoisted(() => {
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
  return {
    localeRef: { current: 'en' as LocaleId },
    sendToSessionMock: vi.fn<() => Promise<'sent' | 'drafted'>>(async () => 'sent'),
  }
})

const DICTIONARIES = { en: enArtifacts, 'zh-CN': zhArtifacts } as const

function lookupKey(
  dict: Record<string, unknown>,
  path: string,
  count?: number,
): string | undefined {
  const tryLookup = (p: string): string | undefined => {
    let cur: unknown = dict
    for (const part of p.split('.')) {
      if (typeof cur !== 'object' || cur === null || !(part in cur)) return undefined
      cur = (cur as Record<string, unknown>)[part]
    }
    return typeof cur === 'string' ? cur : undefined
  }
  if (count !== undefined) {
    const suffix = count === 1 ? '_one' : '_other'
    const plural = tryLookup(`${path}${suffix}`) ?? tryLookup(`${path}_other`)
    if (plural !== undefined) return plural
  }
  return tryLookup(path)
}

function interpolate(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
    vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`,
  )
}

function translate(key: string, vars?: Record<string, unknown>): string {
  const clean = key.replace(/^artifacts:/, '')
  const count = typeof vars?.count === 'number' ? vars.count : undefined
  const raw =
    lookupKey(DICTIONARIES[localeRef.current] as Record<string, unknown>, clean, count) ?? clean
  return interpolate(raw, vars)
}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: translate }),
}))

vi.mock('@renderer/lib/i18n', () => ({
  i18n: { t: translate },
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

vi.mock('./send-to', () => ({
  ToMenu: ({ target }: { target: string }) => createElement('span', { 'data-to': target }, target),
}))

vi.mock('./send-targets', () => ({
  sendToSession: sendToSessionMock,
  useTargetName: () => (_targets: SendTargets, id: string) => id,
}))

vi.mock('./viewer-shell-context', () => ({
  useShell: () => ({
    tier: 'wide',
    targets: { left: null, right: null },
  }),
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
  set left(v: string) {
    this.props.set('left', v)
  }
  get top(): string {
    return this.props.get('top') ?? ''
  }
  set top(v: string) {
    this.props.set('top', v)
  }
  get width(): string {
    return this.props.get('width') ?? ''
  }
  set width(v: string) {
    this.props.set('width', v)
  }
}

class FakeNodeBase {
  static ELEMENT_NODE = 1
  static TEXT_NODE = 3
  static COMMENT_NODE = 8
  static DOCUMENT_NODE = 9
}

class FakeElementBase extends FakeNodeBase {}
class FakeDocumentBase extends FakeNodeBase {}

interface FakeEvent {
  type: string
  target: FakeDomNode | null
  currentTarget: FakeDomNode | null
  bubbles: boolean
  defaultPrevented: boolean
  propagationStopped: boolean
  clientX?: number
  clientY?: number
  button?: number
  pointerId?: number
  preventDefault(): void
  stopPropagation(): void
}

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
  private readonly listeners = new Map<string, Set<(event: FakeEvent) => void>>()
  private readonly captureListeners = new Map<string, Set<(event: FakeEvent) => void>>()
  private _value = ''
  private _captured = new Set<number>()
  offsetParent: FakeDomNode | null = null
  offsetHeight = 160
  bounds = { left: 0, top: 0, width: 1000, height: 800 }

  constructor(
    nodeType: number,
    nodeName: string,
    ownerDocument: FakeDocument | null,
    nodeValue?: string,
  ) {
    super()
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = ownerDocument
    if (nodeType === FakeNodeBase.ELEMENT_NODE) {
      this.tagName = nodeName.toUpperCase()
      this.namespaceURI = 'http://www.w3.org/1999/xhtml'
    }
    if (nodeValue !== undefined) this.nodeValue = nodeValue
  }

  get firstChild(): FakeDomNode | null {
    return this.childNodes[0] ?? null
  }
  get lastChild(): FakeDomNode | null {
    return this.childNodes.at(-1) ?? null
  }
  get nextSibling(): FakeDomNode | null {
    if (!this.parentNode) return null
    const i = this.parentNode.childNodes.indexOf(this)
    return i >= 0 ? (this.parentNode.childNodes[i + 1] ?? null) : null
  }
  get value(): string {
    return this._value
  }
  set value(v: string) {
    this._value = String(v)
  }
  get textContent(): string {
    if (this.nodeType === FakeNodeBase.TEXT_NODE) return this.nodeValue ?? ''
    return this.childNodes.map((c) => c.textContent).join('')
  }
  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (value)
      this.appendChild(new FakeDomNode(FakeNodeBase.TEXT_NODE, '#text', this.ownerDocument, value))
  }
  setPointerCapture(id: number): void {
    this._captured.add(id)
  }
  hasPointerCapture(id: number): boolean {
    return this._captured.has(id)
  }
  releasePointerCapture(id: number): void {
    this._captured.delete(id)
  }
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
    if (idx < 0) this.childNodes.push(child)
    else this.childNodes.splice(idx, 0, child)
    return child
  }
  removeChild(child: FakeDomNode): FakeDomNode {
    const idx = this.childNodes.indexOf(child)
    if (idx >= 0) {
      this.childNodes.splice(idx, 1)
      child.parentNode = null
    }
    return child
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
  get className(): string {
    return this.attributes.get('class') ?? ''
  }
  set className(v: string) {
    this.attributes.set('class', v)
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
    event.target = this
    const chain: FakeDomNode[] = [this]
    for (let cur = this.parentNode; cur; cur = cur.parentNode) chain.unshift(cur)
    const doc = this.ownerDocument
    for (const fn of [...(doc?.captureListeners.get(event.type) ?? [])]) {
      if (event.propagationStopped) break
      fn(event)
    }
    for (const node of chain) {
      if (event.propagationStopped) break
      event.currentTarget = node
      for (const fn of [...(node.captureListeners.get(event.type) ?? [])]) fn(event)
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      if (event.propagationStopped) break
      const node = chain[i]!
      event.currentTarget = node
      for (const fn of [...(node.listeners.get(event.type) ?? [])]) fn(event)
      if (!event.bubbles) break
    }
    if (event.bubbles && !event.propagationStopped) {
      for (const fn of [...(doc?.bubbleListeners.get(event.type) ?? [])]) fn(event)
    }
    return !event.defaultPrevented
  }
  focus(): void {}
  getBoundingClientRect() {
    const { left, top, width, height } = this.bounds
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
  }
  find(predicate: (node: FakeDomNode) => boolean): FakeDomNode | null {
    if (predicate(this)) return this
    for (const child of this.childNodes) {
      const hit = child.find(predicate)
      if (hit) return hit
    }
    return null
  }
  findAll(predicate: (node: FakeDomNode) => boolean, out: FakeDomNode[] = []): FakeDomNode[] {
    if (predicate(this)) out.push(this)
    for (const child of this.childNodes) child.findAll(predicate, out)
    return out
  }
}

class FakeDocument extends FakeDocumentBase {
  nodeType = FakeNodeBase.DOCUMENT_NODE
  nodeName = '#document'
  defaultView: FakeWindow
  documentElement: FakeDomNode
  head: FakeDomNode
  body: FakeDomNode
  activeElement: FakeDomNode | null = null
  captureListeners = new Map<string, Set<(event: FakeEvent) => void>>()
  bubbleListeners = new Map<string, Set<(event: FakeEvent) => void>>()

  constructor(view: FakeWindow) {
    super()
    this.defaultView = view
    this.documentElement = new FakeDomNode(FakeNodeBase.ELEMENT_NODE, 'html', this)
    this.head = new FakeDomNode(FakeNodeBase.ELEMENT_NODE, 'head', this)
    this.body = new FakeDomNode(FakeNodeBase.ELEMENT_NODE, 'body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }
  createElement(tag: string): FakeDomNode {
    return new FakeDomNode(FakeNodeBase.ELEMENT_NODE, tag, this)
  }
  createElementNS(_ns: string, tag: string): FakeDomNode {
    return new FakeDomNode(FakeNodeBase.ELEMENT_NODE, tag, this)
  }
  createTextNode(text: string): FakeDomNode {
    return new FakeDomNode(FakeNodeBase.TEXT_NODE, '#text', this, text)
  }
  createComment(text: string): FakeDomNode {
    return new FakeDomNode(FakeNodeBase.COMMENT_NODE, '#comment', this, text)
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

class FakeWindow {
  document!: FakeDocument
  navigator = { userAgent: 'node' }
  kettu = { platform: 'darwin', client: 'desktop' }
  innerWidth = 1000
  innerHeight = 800
  HTMLElement = FakeElementBase
  HTMLIFrameElement = FakeElementBase
  SVGElement = FakeElementBase
  Element = FakeElementBase
  Node = FakeNodeBase
  Document = FakeDocumentBase
  addEventListener(): void {}
  removeEventListener(): void {}
}

function makeEvent(
  type: string,
  extra: Partial<Pick<FakeEvent, 'clientX' | 'clientY' | 'button' | 'pointerId'>> = {},
): FakeEvent {
  return {
    type,
    target: null,
    currentTarget: null,
    bubbles: true,
    defaultPrevented: false,
    propagationStopped: false,
    ...extra,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this.propagationStopped = true
    },
  }
}

describe('marquee drag helpers', () => {
  it('distinguishes short clicks (< 6px) from marquee drags (>= 6px) and normalizes inverted drags', () => {
    expect(MARQUEE_THRESHOLD).toBe(6)
    expect(exceededMarqueeThreshold({ x: 100, y: 100 }, { x: 104, y: 103 })).toBe(false)
    expect(exceededMarqueeThreshold({ x: 100, y: 100 }, { x: 106, y: 100 })).toBe(true)
    expect(exceededMarqueeThreshold({ x: 100, y: 100 }, { x: 96, y: 95 })).toBe(true)

    // Dragging up-left outside the viewport clamps cleanly to [0, bounds].
    expect(
      normalizeMarqueeRect({ x: 240, y: 180 }, { x: -20, y: 40 }, { width: 800, height: 600 }),
    ).toEqual({ x: 0, y: 40, width: 240, height: 140 })
  })
})

describe('anchorsOfGroup and selectionPrompt multi-element formatting', () => {
  it('formats multi-element groups as numbered structured context while preserving single-element format', async () => {
    localeRef.current = 'en'
    const { anchorsOfGroup, selectionPrompt } = await import('./anchors')

    const group: PickedGroup = {
      id: 1,
      page: 0,
      box: null,
      selections: [
        {
          path: 'frame-1.html',
          src: 120,
          tag: 'article',
          text: 'Starter plan',
          textOnly: false,
          style: {
            color: null,
            background: null,
            fontSize: null,
            fontWeight: null,
            textAlign: null,
            padding: null,
            radius: null,
          },
        },
        {
          path: 'frame-1.html',
          src: 340,
          tag: 'article',
          text: 'Pro plan',
          textOnly: false,
          style: {
            color: null,
            background: null,
            fontSize: null,
            fontWeight: null,
            textAlign: null,
            padding: null,
            radius: null,
          },
        },
      ],
    }

    const anchors = anchorsOfGroup(group, {
      version: 3,
      title: 'Landing',
      files: 1,
      canvas: {
        width: 800,
        height: 600,
        pages: [
          {
            id: 'p1',
            group: 0,
            index: 1,
            number: 1,
            name: 'Pricing',
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            file: 'frame-1.html',
          },
        ],
        titles: [],
      },
      doc: null,
      paths: new Set(['frame-1.html']),
      sums: null,
      loadFrom: new Map(),
    })

    expect(anchors).toHaveLength(2)
    expect(anchors[0]).toMatchObject({
      version: 3,
      path: 'frame-1.html',
      page: { number: 1, name: 'Pricing' },
      offset: 120,
      tag: 'article',
      text: 'Starter plan',
    })

    const multiPrompt = selectionPrompt('Align these pricing cards', {
      artifactId: 'art_1',
      title: 'Landing',
      anchor: anchors[0]!,
      others: anchors.slice(1),
    })
    expect(multiPrompt).toContain('Align these pricing cards')
    expect(multiPrompt).toContain('I selected 2 items in the artifact art_1, version 3')
    expect(multiPrompt).toContain(
      '1. frame-1.html, page 1 "Pricing", <article> at offset 120: "Starter plan"',
    )
    expect(multiPrompt).toContain(
      '2. frame-1.html, page 1 "Pricing", <article> at offset 340: "Pro plan"',
    )

    const singlePrompt = selectionPrompt('Update title', {
      artifactId: 'art_1',
      title: 'Landing',
      anchor: anchors[0]!,
    })
    expect(singlePrompt).toContain('I selected this in the artifact art_1, version 3')
    expect(singlePrompt).not.toContain('1. frame-1.html')
  })
})

describe('PickLayer marquee vs click and AskPop multi-selection UI', () => {
  let fakeWindow: FakeWindow
  let fakeDocument: FakeDocument
  let hostContainer: FakeDomNode
  let root: Root | null = null

  beforeEach(() => {
    localeRef.current = 'en'
    sendToSessionMock.mockClear()
    fakeWindow = new FakeWindow()
    fakeDocument = new FakeDocument(fakeWindow)
    fakeWindow.document = fakeDocument
    hostContainer = fakeDocument.createElement('div')
    hostContainer.bounds = { left: 0, top: 0, width: 1000, height: 800 }
    fakeDocument.body.appendChild(hostContainer)

    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('HTMLElement', FakeElementBase)
    vi.stubGlobal('HTMLIFrameElement', FakeElementBase)
    vi.stubGlobal('SVGElement', FakeElementBase)
    vi.stubGlobal('Element', FakeElementBase)
    vi.stubGlobal('Node', FakeNodeBase)
    vi.stubGlobal('Document', FakeDocumentBase)
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb()
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    if (root) {
      flushSync(() => root!.unmount())
      root = null
    }
    vi.unstubAllGlobals()
  })

  function mount(node: ReactNode): FakeDomNode {
    root = createRoot(hostContainer as unknown as HTMLElement)
    flushSync(() => root!.render(node))
    return hostContainer
  }

  function makeFakeFrame() {
    return {
      point: vi.fn(),
      leave: vi.fn(),
      pick: vi.fn(),
      marquee: vi.fn<(rect: PageBox | null) => void>(),
      marqueeCommit: vi.fn<(rect: PageBox) => void>(),
      scroll: vi.fn(),
      typeIn: vi.fn(),
    } as unknown as EditorFrame & {
      point: ReturnType<typeof vi.fn>
      leave: ReturnType<typeof vi.fn>
      pick: ReturnType<typeof vi.fn>
      marquee: ReturnType<typeof vi.fn>
      marqueeCommit: ReturnType<typeof vi.fn>
    }
  }

  it('keeps short press as single pick, runs marquee on drag >= 6px in select mode, and disables marquee in comment mode', async () => {
    const { PickLayer } = await import('./canvas-view')
    const frame = makeFakeFrame()
    const onDone = vi.fn()

    const container = mount(createElement(PickLayer, { frame, scale: 0.5, mode: 'select', onDone }))
    const layer = container.firstChild!
    layer.bounds = { left: 100, top: 50, width: 500, height: 400 }

    // 1. Short click (< 6px): pointerdown -> tiny move -> pointerup -> click => single pick only.
    layer.dispatchEvent(
      makeEvent('pointerdown', { button: 0, pointerId: 1, clientX: 150, clientY: 100 }),
    )
    layer.dispatchEvent(makeEvent('pointermove', { pointerId: 1, clientX: 153, clientY: 102 }))
    layer.dispatchEvent(
      makeEvent('pointerup', { button: 0, pointerId: 1, clientX: 153, clientY: 102 }),
    )
    layer.dispatchEvent(makeEvent('click', { clientX: 153, clientY: 102 }))

    expect(frame.marquee).not.toHaveBeenCalled()
    expect(frame.marqueeCommit).not.toHaveBeenCalled()
    expect(frame.pick).toHaveBeenCalledTimes(1)
    expect(frame.pick).toHaveBeenCalledWith(106, 104, { x: 153, y: 102 })

    frame.pick.mockClear()
    frame.leave.mockClear()

    // 2. Drag >= 6px in select mode => marquee preview + commit, and trailing click is suppressed.
    layer.dispatchEvent(
      makeEvent('pointerdown', { button: 0, pointerId: 2, clientX: 150, clientY: 100 }),
    )
    layer.dispatchEvent(makeEvent('pointermove', { pointerId: 2, clientX: 250, clientY: 200 }))
    layer.dispatchEvent(
      makeEvent('pointerup', { button: 0, pointerId: 2, clientX: 250, clientY: 200 }),
    )
    layer.dispatchEvent(makeEvent('click', { clientX: 250, clientY: 200 }))

    expect(frame.leave).toHaveBeenCalledTimes(1)
    expect(frame.marquee).toHaveBeenCalledWith({ x: 100, y: 100, width: 200, height: 200 })
    expect(frame.marqueeCommit).toHaveBeenCalledWith({ x: 100, y: 100, width: 200, height: 200 })
    expect(frame.pick).not.toHaveBeenCalled()

    // 3. Pointer cancel clears marquee rectangle cleanly.
    frame.marquee.mockClear()
    layer.dispatchEvent(
      makeEvent('pointerdown', { button: 0, pointerId: 3, clientX: 150, clientY: 100 }),
    )
    layer.dispatchEvent(makeEvent('pointermove', { pointerId: 3, clientX: 200, clientY: 160 }))
    layer.dispatchEvent(makeEvent('pointercancel', { pointerId: 3 }))
    expect(frame.marquee).toHaveBeenLastCalledWith(null)

    // 4. Comment mode never enters marquee selection even on large drags.
    frame.marquee.mockClear()
    frame.marqueeCommit.mockClear()
    frame.pick.mockClear()
    flushSync(() =>
      root!.render(createElement(PickLayer, { frame, scale: 1, mode: 'comment', onDone })),
    )
    const commentLayer = container.firstChild!
    commentLayer.bounds = { left: 0, top: 0, width: 800, height: 600 }
    commentLayer.dispatchEvent(
      makeEvent('pointerdown', { button: 0, pointerId: 4, clientX: 50, clientY: 50 }),
    )
    commentLayer.dispatchEvent(
      makeEvent('pointermove', { pointerId: 4, clientX: 300, clientY: 240 }),
    )
    commentLayer.dispatchEvent(
      makeEvent('pointerup', { button: 0, pointerId: 4, clientX: 300, clientY: 240 }),
    )
    commentLayer.dispatchEvent(makeEvent('click', { clientX: 300, clientY: 240 }))
    expect(frame.marquee).not.toHaveBeenCalled()
    expect(frame.marqueeCommit).not.toHaveBeenCalled()
    expect(frame.pick).toHaveBeenCalledWith(300, 240, { x: 300, y: 240 })
  })

  it('renders AskPop multi-element summary, chip expansion/removal, clear, attach-to-composer, and zh-CN copy', async () => {
    const { AskPop } = await import('./ask-pop')
    const { anchorChip } = await import('./ask-subject')
    const anchors: CommentAnchor[] = Array.from({ length: 5 }, (_, i) => ({
      version: 1,
      path: 'index.html',
      page: null,
      offset: (i + 1) * 10,
      tag: 'article',
      text: `Card ${i + 1}`,
      missing: false,
    }))
    const chips = anchors.map((a, i) => anchorChip(a, i))
    const onRemoveChip = vi.fn()
    const onAttachToComposer = vi.fn()
    const onClose = vi.fn()
    const message = vi.fn(async (ask: string) => ({ text: `prompt:${ask}`, images: [] }))
    const targets: SendTargets = { sessions: [], writing: new Set(), beside: null }

    const container = mount(
      createElement(AskPop, {
        at: { left: 100, top: 120, right: 420, bottom: 260 },
        selectionCount: chips.length,
        chips,
        onRemoveChip,
        onAttachToComposer,
        targets,
        target: 'sess-1',
        onTarget: () => {},
        project: '/tmp/project',
        message,
        onOpenSession: () => {},
        onClose,
      }),
    )

    // Summary shows count + Clear; chips collapse after 3 with interactive +2 button.
    expect(container.textContent).toContain('5 elements selected')
    const moreBtn = container.find((n) => n.className.includes('k-vt-chip--more-btn'))!
    expect(moreBtn).not.toBeNull()
    expect(moreBtn.textContent).toBe('+2')

    // Clicking +2 expands all 5 chips so any hidden element can be removed individually.
    flushSync(() => {
      moreBtn.dispatchEvent(makeEvent('click'))
    })
    const removeButtons = container.findAll((n) => n.className.includes('k-vt-chip__x'))
    expect(removeButtons).toHaveLength(5)
    removeButtons[4]!.dispatchEvent(makeEvent('click'))
    expect(onRemoveChip).toHaveBeenCalledWith(chips[4]!.key)

    // Clicking "To composer" forwards to onAttachToComposer.
    const toComposerBtn = container.find(
      (n) => n.tagName === 'BUTTON' && n.textContent.includes('To composer'),
    )!
    expect(toComposerBtn).not.toBeNull()
    toComposerBtn.dispatchEvent(makeEvent('click'))
    expect(onAttachToComposer).toHaveBeenCalledWith('')

    // Clicking Clear invokes onClose to dismiss and clear highlights.
    const clearBtn = container.find((n) => n.className.includes('k-vt-ask__clear'))!
    clearBtn.dispatchEvent(makeEvent('click'))
    expect(onClose).toHaveBeenCalledTimes(1)

    // Verify offscreen docking with multi-selection copy and back-to-selection callback.
    const onReturnToAnchor = vi.fn()
    const anchorBox = {
      box: { left: 100, top: -240, right: 420, bottom: -40 },
      clip: { left: 0, top: 0, right: 1000, bottom: 800 },
    }
    flushSync(() =>
      root!.render(
        createElement(AskPop, {
          at: { left: 100, top: 120, right: 420, bottom: 260 },
          liveAnchor: {
            get: () => anchorBox,
            subscribe: () => () => {},
          },
          onReturnToAnchor,
          offscreenNote: translate('ask.selectionOffscreen'),
          backLabel: translate('ask.backToSelection'),
          selectionCount: 3,
          chips: chips.slice(0, 3),
          onRemoveChip,
          onAttachToComposer,
          targets,
          target: 'sess-1',
          onTarget: () => {},
          project: '/tmp/project',
          message,
          onOpenSession: () => {},
          onClose,
        }),
      ),
    )
    expect(container.textContent).toContain('Selection out of view')
    const backBtn = container.find((n) => n.className.includes('k-vt-pop__dock-back'))!
    expect(backBtn.textContent).toContain('Back to selection')
    backBtn.dispatchEvent(makeEvent('click'))
    expect(onReturnToAnchor).toHaveBeenCalledTimes(1)

    // Verify zh-CN translations render cleanly.
    localeRef.current = 'zh-CN'
    flushSync(() =>
      root!.render(
        createElement(AskPop, {
          at: { left: 100, top: 120, right: 420, bottom: 260 },
          liveAnchor: {
            get: () => anchorBox,
            subscribe: () => () => {},
          },
          onReturnToAnchor,
          offscreenNote: translate('ask.selectionOffscreen'),
          backLabel: translate('ask.backToSelection'),
          selectionCount: 3,
          chips: chips.slice(0, 3),
          onRemoveChip,
          onAttachToComposer,
          targets,
          target: 'sess-1',
          onTarget: () => {},
          project: '/tmp/project',
          message,
          onOpenSession: () => {},
          onClose,
        }),
      ),
    )
    expect(container.textContent).toContain(
      zhArtifacts.ask.selectedCount_other.replace('{{count}}', '3'),
    )
    expect(container.textContent).toContain(zhArtifacts.ask.clear)
    expect(container.textContent).toContain(zhArtifacts.ask.toComposer)
    expect(container.textContent).toContain(zhArtifacts.ask.selectionOffscreen)
    expect(container.textContent).toContain(zhArtifacts.ask.backToSelection)
  })
})
