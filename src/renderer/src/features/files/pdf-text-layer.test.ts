import { afterEach, describe, expect, it, vi } from 'vitest'

type ListenerEntry = {
  listener: (event: MockEvent) => void
  signal?: AbortSignal
}

interface MockEvent {
  type: string
  target?: unknown
  clipboardData?: { setData: (type: string, value: string) => void }
  preventDefault?: () => void
  stopPropagation?: () => void
}

class MockEventTarget {
  private readonly listeners = new Map<string, Set<ListenerEntry>>()

  addEventListener(
    type: string,
    listener: (event: MockEvent) => void,
    options?: { signal?: AbortSignal } | null,
  ): void {
    const signal = options?.signal
    if (signal?.aborted) return
    let bucket = this.listeners.get(type)
    if (!bucket) {
      bucket = new Set()
      this.listeners.set(type, bucket)
    }
    const entry: ListenerEntry = { listener, signal }
    bucket.add(entry)
    signal?.addEventListener(
      'abort',
      () => {
        bucket?.delete(entry)
      },
      { once: true },
    )
  }

  dispatchEvent(event: MockEvent): void {
    const bucket = this.listeners.get(event.type)
    if (!bucket) return
    for (const entry of [...bucket]) {
      if (entry.signal?.aborted) continue
      entry.listener(event)
    }
  }
}

class MockClassList {
  private readonly tokens = new Set<string>()
  writes = 0

  constructor(initial = '') {
    this.setFromString(initial)
  }

  setFromString(value: string): void {
    this.tokens.clear()
    for (const token of value.split(/\s+/)) {
      if (token) this.tokens.add(token)
    }
  }

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.writes++
      this.tokens.add(token)
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.writes++
      this.tokens.delete(token)
    }
  }

  contains(token: string): boolean {
    return this.tokens.has(token)
  }

  toString(): string {
    return [...this.tokens].join(' ')
  }
}

class MockStyle {
  private _width = ''
  private _height = ''
  private _userSelect = ''
  writes = 0

  get width(): string {
    return this._width
  }
  set width(value: string) {
    this.writes++
    this._width = value
  }

  get height(): string {
    return this._height
  }
  set height(value: string) {
    this.writes++
    this._height = value
  }

  get userSelect(): string {
    return this._userSelect
  }
  set userSelect(value: string) {
    this.writes++
    this._userSelect = value
  }
}

const NODE_ELEMENT = 1
const NODE_TEXT = 3

class MockNode extends MockEventTarget {
  readonly nodeType: number
  parentNode: MockElement | null = null
  childNodes: MockNode[] = []

  constructor(nodeType: number) {
    super()
    this.nodeType = nodeType
  }

  get parentElement(): MockElement | null {
    return this.parentNode
  }

  get previousSibling(): MockNode | null {
    if (!this.parentNode) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return index > 0 ? this.parentNode.childNodes[index - 1] : null
  }

  get nextSibling(): MockNode | null {
    if (!this.parentNode) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return index >= 0 && index + 1 < this.parentNode.childNodes.length
      ? this.parentNode.childNodes[index + 1]
      : null
  }

  contains(other: MockNode | null): boolean {
    let cur: MockNode | null = other
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }
}

class MockText extends MockNode {
  textContent: string

  constructor(text: string) {
    super(NODE_TEXT)
    this.textContent = text
  }
}

class MockElement extends MockNode {
  readonly tagName: string
  readonly classList = new MockClassList()
  readonly style = new MockStyle()
  tabIndex = -1
  hidden = false
  childListMutations = 0

  constructor(tagName: string) {
    super(NODE_ELEMENT)
    this.tagName = tagName.toUpperCase()
  }

  get className(): string {
    return this.classList.toString()
  }
  set className(value: string) {
    this.classList.setFromString(value)
  }

  get lastElementChild(): MockElement | null {
    for (let i = this.childNodes.length - 1; i >= 0; i--) {
      const child = this.childNodes[i]
      if (child instanceof MockElement) return child
    }
    return null
  }

  private detach(node: MockNode): void {
    const parent = node.parentNode
    if (!parent) return
    const index = parent.childNodes.indexOf(node)
    if (index >= 0) {
      parent.childNodes.splice(index, 1)
      parent.childListMutations++
    }
    node.parentNode = null
  }

  // Matches DOM spec: append always removes and re-inserts the node, triggering childList
  // mutations even when the node is already the last child.
  append(...nodes: MockNode[]): void {
    for (const node of nodes) {
      this.detach(node)
      node.parentNode = this
      this.childNodes.push(node)
      this.childListMutations++
    }
  }

  insertBefore(node: MockNode, reference: MockNode | null): MockNode {
    if (reference === node) return node
    this.detach(node)
    node.parentNode = this
    if (reference === null) {
      this.childNodes.push(node)
    } else {
      const index = this.childNodes.indexOf(reference)
      if (index === -1) this.childNodes.push(node)
      else this.childNodes.splice(index, 0, node)
    }
    this.childListMutations++
    return node
  }

  replaceChildren(...nodes: MockNode[]): void {
    for (const existing of [...this.childNodes]) {
      existing.parentNode = null
    }
    if (this.childNodes.length > 0 || nodes.length > 0) {
      this.childListMutations++
    }
    this.childNodes = []
    if (nodes.length > 0) this.append(...nodes)
  }

  closest(selector: string): MockElement | null {
    const className = selector.startsWith('.') ? selector.slice(1) : null
    if (!className) return null
    if (this.classList.contains(className)) return this
    let cur = this.parentNode
    while (cur) {
      if (cur.classList.contains(className)) return cur
      cur = cur.parentNode
    }
    return null
  }
}

function commonAncestor(a: MockNode, b: MockNode): MockNode {
  const ancestors = new Set<MockNode>()
  let cur: MockNode | null = a
  while (cur) {
    ancestors.add(cur)
    cur = cur.parentNode
  }
  cur = b
  while (cur) {
    if (ancestors.has(cur)) return cur
    cur = cur.parentNode
  }
  return a
}

function treeOrder(root: MockNode, out: MockNode[] = []): MockNode[] {
  out.push(root)
  for (const child of root.childNodes) {
    treeOrder(child, out)
  }
  return out
}

function rootOf(node: MockNode): MockNode {
  let cur: MockNode = node
  while (cur.parentNode) cur = cur.parentNode
  return cur
}

class MockRange {
  static readonly START_TO_START = 0
  static readonly START_TO_END = 1
  static readonly END_TO_END = 2
  static readonly END_TO_START = 3

  readonly startContainer: MockNode
  readonly startOffset: number
  readonly endContainer: MockNode
  readonly endOffset: number
  cloneCount = 0
  compareCount = 0

  constructor(
    startContainer: MockNode,
    startOffset: number,
    endContainer: MockNode,
    endOffset: number,
  ) {
    this.startContainer = startContainer
    this.startOffset = startOffset
    this.endContainer = endContainer
    this.endOffset = endOffset
  }

  get collapsed(): boolean {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset
  }

  get commonAncestorContainer(): MockNode {
    return commonAncestor(this.startContainer, this.endContainer)
  }

  intersectsNode(node: MockNode): boolean {
    if (this.collapsed) {
      return node.contains(this.startContainer)
    }
    if (node.contains(this.startContainer) || node.contains(this.endContainer)) {
      return true
    }
    const order = treeOrder(rootOf(node))
    const startIdx = order.indexOf(this.startContainer)
    const endIdx = order.indexOf(this.endContainer)
    const nodeIdx = order.indexOf(node)
    if (startIdx < 0 || endIdx < 0 || nodeIdx < 0) return false
    const lo = Math.min(startIdx, endIdx)
    const hi = Math.max(startIdx, endIdx)
    return nodeIdx >= lo && nodeIdx <= hi
  }

  compareBoundaryPoints(how: number, sourceRange: MockRange): number {
    this.compareCount++
    if (how === MockRange.END_TO_END) {
      return this.endContainer === sourceRange.endContainer &&
        this.endOffset === sourceRange.endOffset
        ? 0
        : 1
    }
    if (how === MockRange.START_TO_END) {
      return this.startContainer === sourceRange.endContainer &&
        this.startOffset === sourceRange.endOffset
        ? 0
        : 1
    }
    return 1
  }

  cloneRange(): MockRange {
    this.cloneCount++
    return new MockRange(this.startContainer, this.startOffset, this.endContainer, this.endOffset)
  }
}

class MockSelection {
  private ranges: MockRange[] = []
  private text = ''

  setRanges(ranges: MockRange[], text = ''): void {
    this.ranges = ranges
    this.text = text
  }

  clear(): void {
    this.ranges = []
    this.text = ''
  }

  get rangeCount(): number {
    return this.ranges.length
  }

  getRangeAt(index: number): MockRange {
    return this.ranges[index]
  }

  toString(): string {
    return this.text
  }
}

class MockDocument extends MockEventTarget {
  readonly documentElement = new MockElement('html')
  readonly body = new MockElement('body')
  readonly selection = new MockSelection()
  activeElement: MockElement | null = null

  constructor() {
    super()
    this.documentElement.append(this.body)
  }

  createElement(tagName: string): MockElement {
    return new MockElement(tagName)
  }

  getSelection(): MockSelection {
    return this.selection
  }
}

class MockWindow extends MockEventTarget {
  requestAnimationFrame(callback: () => void): number {
    callback()
    return 1
  }
}

interface TextLayerBuilderInstance {
  div: MockElement
  render: (params: { viewport: object }) => Promise<void>
  cancel: () => void
}

type TextLayerBuilderCtor = new (params: {
  pdfPage: { streamTextContent: () => object }
  abortSignal?: AbortSignal
}) => TextLayerBuilderInstance

async function setupHarness() {
  const doc = new MockDocument()
  const win = new MockWindow()

  // Simulate Electron 44 (Chromium 144 < 148) so the pre-Chromium-148 path runs too.
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', win)
  vi.stubGlobal('Node', { ELEMENT_NODE: NODE_ELEMENT, TEXT_NODE: NODE_TEXT })
  vi.stubGlobal('Range', MockRange)
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36',
  })
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: () => '',
  }))

  class FakeTextLayer {
    textDivs: MockElement[] = []
    textContentItemsStr: string[] = []
    private readonly container: MockElement
    private readonly label: string

    constructor(params: { container: MockElement; textContentSource: { label: string } }) {
      this.container = params.container
      this.label = params.textContentSource.label
    }

    async render(): Promise<void> {
      const span = new MockElement('span')
      span.append(new MockText(this.label))
      this.container.append(span)
      this.textDivs.push(span)
      this.textContentItemsStr.push(this.label)
    }

    cancel(): void {}
  }

  vi.stubGlobal('pdfjsLib', {
    TextLayer: FakeTextLayer,
    normalizeUnicode: (value: string) => value,
    stopEvent: (event: MockEvent) => {
      event.preventDefault?.()
      event.stopPropagation?.()
    },
    AnnotationEditorType: {},
    AnnotationMode: {},
    VerbosityLevel: {},
    PixelsPerInch: { PDF_TO_CSS_UNITS: 96 / 72 },
  })

  vi.resetModules()
  const viewer = (await import('pdfjs-dist/web/pdf_viewer.mjs')) as unknown as {
    TextLayerBuilder: TextLayerBuilderCtor
  }

  const pdfViewer = new MockElement('div')
  pdfViewer.className = 'pdfViewer'
  doc.body.append(pdfViewer)

  const composer = new MockElement('div')
  composer.className = 'cm-content'
  const line = new MockElement('div')
  line.className = 'cm-line'
  const inputText = new MockText('hello world')
  line.append(inputText)
  composer.append(line)
  doc.body.append(composer)

  const builders: TextLayerBuilderInstance[] = []
  const mountPage = async (label: string) => {
    const page = new MockElement('div')
    page.className = 'page'
    const builder = new viewer.TextLayerBuilder({
      pdfPage: { streamTextContent: () => ({ label }) },
    })
    builder.div.style.width = '600px'
    builder.div.style.height = '800px'
    page.append(builder.div)
    pdfViewer.append(page)
    await builder.render({ viewport: {} })
    builders.push(builder)
    const span = builder.div.childNodes[0] as MockElement
    const text = span.childNodes[0] as MockText
    const endOfContent = builder.div.lastElementChild!
    // Reset counters after initial render so assertions measure only post-render events.
    builder.div.childListMutations = 0
    builder.div.classList.writes = 0
    endOfContent.style.writes = 0
    return { builder, page, span, text, endOfContent }
  }

  const page1 = await mountPage('Page one text')
  const page2 = await mountPage('Page two text')

  const cleanup = () => {
    for (const builder of builders) {
      builder.cancel()
    }
    vi.unstubAllGlobals()
  }

  return { doc, win, pdfViewer, composer, line, inputText, page1, page2, cleanup }
}

describe('pdfjs-dist TextLayerBuilder global selection patch (mozilla/pdf.js#22466)', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  it('does not mutate textLayer DOM or clone ranges when typing in composer outside the PDF', async () => {
    const h = await setupHarness()
    cleanup = h.cleanup

    h.doc.activeElement = h.composer
    const caretInText = new MockRange(h.inputText, 5, h.inputText, 5)
    const caretInEmptyLine = new MockRange(h.line, 0, h.line, 0)

    for (let i = 0; i < 10; i++) {
      const range = i % 2 === 0 ? caretInText : caretInEmptyLine
      h.doc.selection.setRanges([range])
      h.doc.dispatchEvent({ type: 'selectionchange' })
      h.doc.dispatchEvent({ type: 'keyup' })
    }

    expect(h.page1.builder.div.childListMutations).toBe(0)
    expect(h.page2.builder.div.childListMutations).toBe(0)
    expect(h.page1.builder.div.classList.writes).toBe(0)
    expect(h.page2.builder.div.classList.writes).toBe(0)
    expect(h.page1.endOfContent.style.writes).toBe(0)
    expect(h.page2.endOfContent.style.writes).toBe(0)
    expect(caretInText.cloneCount).toBe(0)
    expect(caretInText.compareCount).toBe(0)
    expect(caretInEmptyLine.cloneCount).toBe(0)
    expect(caretInEmptyLine.compareCount).toBe(0)
  })

  it('does not mutate textLayer DOM when selecting text inside composer outside the PDF', async () => {
    const h = await setupHarness()
    cleanup = h.cleanup

    h.doc.activeElement = h.composer
    const range = new MockRange(h.inputText, 0, h.inputText, 5)
    h.doc.selection.setRanges([range], 'hello')

    h.doc.dispatchEvent({ type: 'pointerdown' })
    h.doc.dispatchEvent({ type: 'selectionchange' })
    h.doc.dispatchEvent({ type: 'pointerup' })
    h.doc.dispatchEvent({ type: 'keyup' })

    expect(h.page1.builder.div.childListMutations).toBe(0)
    expect(h.page2.builder.div.childListMutations).toBe(0)
    expect(h.page1.endOfContent.style.writes).toBe(0)
    expect(h.page2.endOfContent.style.writes).toBe(0)
    expect(range.cloneCount).toBe(0)
  })

  it('preserves single-page PDF selection, copy, and cleanup while leaving untouched pages alone', async () => {
    const h = await setupHarness()
    cleanup = h.cleanup

    h.doc.dispatchEvent({ type: 'pointerdown' })
    h.page1.builder.div.dispatchEvent({ type: 'mousedown' })
    expect(h.page1.builder.div.classList.contains('selecting')).toBe(true)

    const pdfRange = new MockRange(h.page1.text, 0, h.page1.text, 8)
    h.doc.selection.setRanges([pdfRange], 'Page one')
    h.doc.dispatchEvent({ type: 'selectionchange' })

    expect(h.page1.builder.div.classList.contains('selecting')).toBe(true)
    expect(h.page1.endOfContent.style.width).toBe('600px')
    expect(h.page1.endOfContent.style.height).toBe('800px')
    // Untouched page 2 must stay completely clean without any DOM writes.
    expect(h.page2.builder.div.childListMutations).toBe(0)
    expect(h.page2.endOfContent.style.writes).toBe(0)

    const copied = new Map<string, string>()
    let stopped = false
    h.page1.builder.div.dispatchEvent({
      type: 'copy',
      clipboardData: { setData: (type, value) => copied.set(type, value) },
      preventDefault: () => {
        stopped = true
      },
      stopPropagation: () => {},
    })
    expect(copied.get('text/plain')).toBe('Page one')
    expect(stopped).toBe(true)

    h.doc.dispatchEvent({ type: 'pointerup' })
    expect(h.page1.builder.div.classList.contains('selecting')).toBe(false)
    expect(h.page1.builder.div.lastElementChild).toBe(h.page1.endOfContent)
    expect(h.page1.endOfContent.style.width).toBe('')
    expect(h.page1.endOfContent.style.height).toBe('')
    expect(h.page2.builder.div.childListMutations).toBe(0)
  })

  it('preserves cross-page PDF selection and resets pages that leave the selection', async () => {
    const h = await setupHarness()
    cleanup = h.cleanup

    const crossPage = new MockRange(h.page1.text, 0, h.page2.text, 4)
    h.doc.selection.setRanges([crossPage], 'Page one text\nPage')
    h.doc.dispatchEvent({ type: 'pointerdown' })
    h.doc.dispatchEvent({ type: 'selectionchange' })

    expect(h.page1.builder.div.classList.contains('selecting')).toBe(true)
    expect(h.page2.builder.div.classList.contains('selecting')).toBe(true)

    // Shrink selection back to page 1 only.
    const page1Only = new MockRange(h.page1.text, 0, h.page1.text, 4)
    h.doc.selection.setRanges([page1Only], 'Page')
    h.doc.dispatchEvent({ type: 'selectionchange' })

    expect(h.page1.builder.div.classList.contains('selecting')).toBe(true)
    expect(h.page2.builder.div.classList.contains('selecting')).toBe(false)
    expect(h.page2.builder.div.lastElementChild).toBe(h.page2.endOfContent)
  })

  it('clears selecting state on keyup after keyboard selection and when moving selection to composer', async () => {
    const h = await setupHarness()
    cleanup = h.cleanup

    // Keyboard selection inside page 1, followed by keyup reset.
    const pdfRange = new MockRange(h.page1.text, 0, h.page1.text, 4)
    h.doc.selection.setRanges([pdfRange], 'Page')
    h.doc.dispatchEvent({ type: 'selectionchange' })
    expect(h.page1.builder.div.classList.contains('selecting')).toBe(true)

    h.doc.dispatchEvent({ type: 'keyup' })
    expect(h.page1.builder.div.classList.contains('selecting')).toBe(false)
    expect(h.page1.builder.div.lastElementChild).toBe(h.page1.endOfContent)
    expect(h.page1.endOfContent.style.width).toBe('')
    expect(h.page1.endOfContent.style.height).toBe('')

    // Enter selecting state in PDF, then click out to composer.
    h.doc.dispatchEvent({ type: 'selectionchange' })
    expect(h.page1.builder.div.classList.contains('selecting')).toBe(true)

    const composerRange = new MockRange(h.inputText, 2, h.inputText, 2)
    h.doc.activeElement = h.composer
    h.doc.selection.setRanges([composerRange])
    h.doc.dispatchEvent({ type: 'selectionchange' })

    expect(h.page1.builder.div.classList.contains('selecting')).toBe(false)
    expect(h.page1.builder.div.lastElementChild).toBe(h.page1.endOfContent)
    expect(h.page1.endOfContent.style.width).toBe('')
    expect(h.page1.endOfContent.style.height).toBe('')
    expect(composerRange.cloneCount).toBe(0)

    // Subsequent typing in composer causes zero further mutations.
    const mutationsAfterReset = h.page1.builder.div.childListMutations
    const styleWritesAfterReset = h.page1.endOfContent.style.writes
    h.doc.dispatchEvent({ type: 'selectionchange' })
    h.doc.dispatchEvent({ type: 'keyup' })

    expect(h.page1.builder.div.childListMutations).toBe(mutationsAfterReset)
    expect(h.page1.endOfContent.style.writes).toBe(styleWritesAfterReset)
    expect(composerRange.cloneCount).toBe(0)
  })

  it('clears selecting state when selection becomes empty and stays idle afterwards', async () => {
    const h = await setupHarness()
    cleanup = h.cleanup

    h.page1.builder.div.dispatchEvent({ type: 'mousedown' })
    expect(h.page1.builder.div.classList.contains('selecting')).toBe(true)

    h.doc.selection.clear()
    h.doc.dispatchEvent({ type: 'selectionchange' })
    expect(h.page1.builder.div.classList.contains('selecting')).toBe(false)

    const mutationsAfterClear = h.page1.builder.div.childListMutations
    const classWritesAfterClear = h.page1.builder.div.classList.writes
    h.doc.dispatchEvent({ type: 'selectionchange' })
    h.doc.dispatchEvent({ type: 'keyup' })

    expect(h.page1.builder.div.childListMutations).toBe(mutationsAfterClear)
    expect(h.page1.builder.div.classList.writes).toBe(classWritesAfterClear)
  })

  it('skips cloning and DOM writes when an external multi-container selection shares body as common ancestor', async () => {
    const h = await setupHarness()
    cleanup = h.cleanup

    const sidebarNote = new MockElement('div')
    const noteText = new MockText('header text')
    sidebarNote.append(noteText)
    // Placed after composer so the range spans two external elements under document.body without
    // intersecting pdfViewer.
    h.doc.body.append(sidebarNote)

    const externalSpan = new MockRange(h.inputText, 0, noteText, 6)
    expect(externalSpan.commonAncestorContainer).toBe(h.doc.body)
    expect(externalSpan.intersectsNode(h.page1.builder.div)).toBe(false)
    expect(externalSpan.intersectsNode(h.page2.builder.div)).toBe(false)

    h.doc.selection.setRanges([externalSpan], 'hello worldheader')
    h.doc.dispatchEvent({ type: 'selectionchange' })

    expect(h.page1.builder.div.childListMutations).toBe(0)
    expect(h.page2.builder.div.childListMutations).toBe(0)
    expect(externalSpan.cloneCount).toBe(0)
  })

  it('supports backward drag selection inside a PDF page and resets cleanly on pointerup', async () => {
    const h = await setupHarness()
    cleanup = h.cleanup

    h.doc.dispatchEvent({ type: 'pointerdown' })
    h.page1.builder.div.dispatchEvent({ type: 'mousedown' })

    // Initial range ends at offset 8; extending backwards keeps the same end boundary.
    const initialRange = new MockRange(h.page1.text, 4, h.page1.text, 8)
    h.doc.selection.setRanges([initialRange], ' one')
    h.doc.dispatchEvent({ type: 'selectionchange' })
    expect(initialRange.cloneCount).toBe(1)

    const extendedBack = new MockRange(h.page1.text, 0, h.page1.text, 8)
    h.doc.selection.setRanges([extendedBack], 'Page one')
    h.doc.dispatchEvent({ type: 'selectionchange' })
    expect(extendedBack.compareCount).toBeGreaterThan(0)
    // Backward selection inserts endOfContent before the anchor span.
    expect(h.page1.builder.div.childNodes[0]).toBe(h.page1.endOfContent)

    h.doc.dispatchEvent({ type: 'pointerup' })
    expect(h.page1.builder.div.classList.contains('selecting')).toBe(false)
    expect(h.page1.builder.div.lastElementChild).toBe(h.page1.endOfContent)
    expect(h.page1.endOfContent.style.width).toBe('')
    expect(h.page1.endOfContent.style.height).toBe('')
  })
})
