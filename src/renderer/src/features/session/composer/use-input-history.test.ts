import { createElement, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { threadFromSnapshot, type ThreadEntry } from '@shared/thread'
import type { ComposerEditorHandle } from './editor'
import { popoverKey } from './mentions'

const { loadOlderMock } = vi.hoisted(() => {
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        kettu: { platform: 'darwin' },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
  return {
    loadOlderMock: vi.fn<(sessionId: string) => Promise<boolean> | null>(),
  }
})

vi.mock('@renderer/stores/threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/threads')>()
  return {
    ...actual,
    loadOlder: (sessionId: string) => loadOlderMock(sessionId),
  }
})

import { useThreadsStore } from '@renderer/stores/threads'
import {
  canMoveInputHistory,
  useInputHistory,
  type InputHistoryPosition,
} from './use-input-history'

// Minimal DOM stub so React 19's client reconciler runs hooks cleanly under Vitest's node env.
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
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()

  constructor(name: string, nodeType: number, owner: FakeDocument | null) {
    super()
    this.nodeType = nodeType
    this.nodeName = nodeType === 1 ? name.toUpperCase() : name
    this.tagName = nodeType === 1 ? name.toUpperCase() : undefined
    this.namespaceURI = nodeType === 1 ? 'http://www.w3.org/1999/xhtml' : undefined
    this.nodeValue = nodeType === 3 || nodeType === 8 ? '' : undefined
    this.ownerDocument = owner
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

  appendChild(child: FakeDomNode): FakeDomNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child: FakeDomNode, ref: FakeDomNode | null): FakeDomNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const index = ref ? this.childNodes.indexOf(ref) : -1
    if (index >= 0) this.childNodes.splice(index, 0, child)
    else this.childNodes.push(child)
    return child
  }

  removeChild(child: FakeDomNode): FakeDomNode {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  getRootNode(): FakeDocument | FakeDomNode {
    return this.ownerDocument ?? this
  }

  get firstChild(): FakeDomNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): FakeDomNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? ''
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

interface FakeDocument {
  nodeType: number
  nodeName: string
  defaultView: FakeWindow
  activeElement: FakeDomNode | null
  documentElement: FakeDomNode
  head: FakeDomNode
  body: FakeDomNode
  createElement(tag: string): FakeDomNode
  createElementNS(ns: string, tag: string): FakeDomNode
  createTextNode(text: string): FakeDomNode
  createComment(text: string): FakeDomNode
  addEventListener(): void
  removeEventListener(): void
}

interface FakeWindow {
  kettu: { platform: string }
  document: FakeDocument
  navigator: { userAgent: string }
  HTMLElement: typeof FakeElementBase
  SVGElement: typeof FakeElementBase
  Element: typeof FakeElementBase
  Node: typeof FakeNodeBase
  Document: typeof FakeDocumentBase
  HTMLIFrameElement: typeof FakeElementBase
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  addEventListener(): void
  removeEventListener(): void
}

function createFakeDom(): { window: FakeWindow; document: FakeDocument } {
  const doc: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    defaultView: null as unknown as FakeWindow,
    activeElement: null,
    documentElement: null as unknown as FakeDomNode,
    head: null as unknown as FakeDomNode,
    body: null as unknown as FakeDomNode,
    createElement(tag: string) {
      return new FakeDomNode(tag, 1, doc)
    },
    createElementNS(ns: string, tag: string) {
      const node = new FakeDomNode(tag, 1, doc)
      node.namespaceURI = ns
      return node
    },
    createTextNode(text: string) {
      const node = new FakeDomNode('#text', 3, doc)
      node.nodeValue = String(text)
      return node
    },
    createComment(text: string) {
      const node = new FakeDomNode('#comment', 8, doc)
      node.nodeValue = String(text)
      return node
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const html = new FakeDomNode('html', 1, doc)
  const head = new FakeDomNode('head', 1, doc)
  const body = new FakeDomNode('body', 1, doc)
  html.appendChild(head)
  html.appendChild(body)
  doc.documentElement = html
  doc.head = head
  doc.body = body
  doc.activeElement = body

  const win: FakeWindow = {
    kettu: { platform: 'darwin' },
    document: doc,
    navigator: { userAgent: 'vitest' },
    HTMLElement: FakeElementBase,
    SVGElement: FakeElementBase,
    Element: FakeElementBase,
    Node: FakeNodeBase,
    Document: FakeDocumentBase,
    HTMLIFrameElement: FakeElementBase,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  }
  doc.defaultView = win
  return { window: win, document: doc }
}

function userEntry(id: string, text: string): ThreadEntry {
  return {
    id,
    kind: 'user',
    at: 1,
    content: [{ type: 'text', text }],
  }
}

function seedThread(sessionId: string, entries: ThreadEntry[], older: number | null = null): void {
  const state = threadFromSnapshot({
    session: {
      id: sessionId,
      agentId: 'claude-code',
      projectPath: '/tmp/project',
      acpSessionId: null,
      title: 'Test session',
      status: 'ready',
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 1,
      updatedAt: 1,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
    entries,
    seq: 1,
  })
  useThreadsStore.setState({
    replicas: {
      [sessionId]: {
        state,
        seq: 1,
        status: 'ready',
        error: null,
        older,
        loadingOlder: false,
        olderFailure: null,
        plan: null,
      },
    },
  })
}

interface FakeEditor {
  handle: ComposerEditorHandle
  setDoc(text: string, from?: number, to?: number, multiCaret?: boolean): void
  getDoc(): { text: string; from: number; to: number }
}

function createFakeEditor(initialText = ''): FakeEditor {
  let text = initialText
  let from = initialText.length
  let to = initialText.length
  let multiCaret = false

  const atBoundary = (forward: boolean): boolean => {
    if (multiCaret || from !== to) return false
    const pos = from
    if (forward) {
      if (pos === text.length) return true
      return text.indexOf('\n', pos) === -1
    }
    if (pos === 0) return true
    return text.lastIndexOf('\n', pos - 1) === -1
  }

  const handle: ComposerEditorHandle = {
    focus() {},
    text: () => text,
    selection: () => ({ from, to }),
    atBoundary,
    insert() {},
    setText(next, caret = next.length) {
      text = next
      from = caret
      to = caret
      multiCaret = false
    },
    keepAsText() {},
    chipElement: () => null,
    rectOf: () => null,
    scrollElement: () => null,
    measure: () => ({ height: 0, least: 0 }),
  }

  return {
    handle,
    setDoc(nextText, nextFrom = nextText.length, nextTo = nextFrom, nextMulti = false) {
      text = nextText
      from = nextFrom
      to = nextTo
      multiCaret = nextMulti
    },
    getDoc: () => ({ text, from, to }),
  }
}

describe('canMoveInputHistory (#2921)', () => {
  it('allows Up from an empty box or offset 0 when not browsing', () => {
    expect(
      canMoveInputHistory({
        forward: false,
        browsing: false,
        selection: { from: 0, to: 0 },
        atBoundary: true,
      }),
    ).toBe(true)
  })

  it('defers Up to the editor when not browsing and the caret is not at offset 0', () => {
    expect(
      canMoveInputHistory({
        forward: false,
        browsing: false,
        selection: { from: 4, to: 4 },
        atBoundary: true,
      }),
    ).toBe(false)
    expect(
      canMoveInputHistory({
        forward: false,
        browsing: false,
        selection: { from: 12, to: 12 },
        atBoundary: false,
      }),
    ).toBe(false)
  })

  it('never intercepts Down when not browsing history', () => {
    expect(
      canMoveInputHistory({
        forward: true,
        browsing: false,
        selection: { from: 0, to: 0 },
        atBoundary: true,
      }),
    ).toBe(false)
    expect(
      canMoveInputHistory({
        forward: true,
        browsing: false,
        selection: { from: 5, to: 5 },
        atBoundary: true,
      }),
    ).toBe(false)
  })

  it('never intercepts when a non-empty selection is active or caret is not at boundary', () => {
    expect(
      canMoveInputHistory({
        forward: false,
        browsing: false,
        selection: { from: 0, to: 5 },
        atBoundary: true,
      }),
    ).toBe(false)
    expect(
      canMoveInputHistory({
        forward: false,
        browsing: true,
        selection: { from: 1, to: 4 },
        atBoundary: true,
      }),
    ).toBe(false)
    expect(
      canMoveInputHistory({
        forward: false,
        browsing: false,
        selection: { from: 0, to: 0 },
        atBoundary: false,
      }),
    ).toBe(false)
  })

  it('allows Up on the first line and Down on the last line while browsing, even at non-zero offsets', () => {
    expect(
      canMoveInputHistory({
        forward: false,
        browsing: true,
        selection: { from: 9, to: 9 },
        atBoundary: true,
      }),
    ).toBe(true)
    expect(
      canMoveInputHistory({
        forward: true,
        browsing: true,
        selection: { from: 3, to: 3 },
        atBoundary: true,
      }),
    ).toBe(true)
    expect(
      canMoveInputHistory({
        forward: false,
        browsing: true,
        selection: { from: 9, to: 9 },
        atBoundary: false,
      }),
    ).toBe(false)
    expect(
      canMoveInputHistory({
        forward: true,
        browsing: true,
        selection: { from: 3, to: 3 },
        atBoundary: false,
      }),
    ).toBe(false)
  })
})

describe('useInputHistory (#2921)', () => {
  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    SVGElement: globalThis.SVGElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Document: globalThis.Document,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
  }
  let fakeDoc: FakeDocument
  let root: Root | null = null

  beforeEach(() => {
    loadOlderMock.mockReset()
    loadOlderMock.mockReturnValue(null)
    const dom = createFakeDom()
    fakeDoc = dom.document
    Object.assign(globalThis, {
      document: dom.document,
      window: dom.window,
      HTMLElement: dom.window.HTMLElement,
      SVGElement: dom.window.SVGElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      Document: dom.window.Document,
      HTMLIFrameElement: dom.window.HTMLIFrameElement,
    })
  })

  afterEach(() => {
    if (root) {
      flushSync(() => root!.unmount())
      root = null
    }
    useThreadsStore.setState({ replicas: {} })
    Object.assign(globalThis, prevGlobals)
  })

  function mountHistory(fakeEditor: FakeEditor, sessionId: string | null = 'sess-1') {
    const recalledTexts: string[] = []
    const onError = vi.fn()
    const onRecall = vi.fn((text: string) => {
      recalledTexts.push(text)
      fakeEditor.handle.setText(text)
    })

    let latest!: {
      position: InputHistoryPosition | null
      move: (forward: boolean) => boolean
      close: () => void
      leave: () => void
    }

    function Harness() {
      const ref = useRef<ComposerEditorHandle | null>(
        fakeEditor.handle,
      ) as RefObject<ComposerEditorHandle | null>
      latest = useInputHistory({
        sessionId,
        disabled: false,
        editor: ref,
        onRecall,
        onError,
      })
      return null
    }

    const container = fakeDoc.createElement('div')
    fakeDoc.body.appendChild(container)
    root = createRoot(container as unknown as HTMLElement)
    flushSync(() => {
      root!.render(createElement(Harness))
    })

    return {
      move: (forward: boolean) => {
        let handled = false
        flushSync(() => {
          handled = latest.move(forward)
        })
        return handled
      },
      close: () => flushSync(() => latest.close()),
      leave: () => flushSync(() => latest.leave()),
      position: () => latest.position,
      recalledTexts,
      onRecall,
      onError,
    }
  }

  it('recalls immediately on Up from an empty box', () => {
    seedThread('sess-1', [userEntry('u1', 'first prompt'), userEntry('u2', 'second prompt')])
    const fakeEditor = createFakeEditor('')
    const h = mountHistory(fakeEditor)

    expect(h.move(false)).toBe(true)
    expect(fakeEditor.getDoc()).toEqual({ text: 'second prompt', from: 13, to: 13 })
    expect(h.position()).toEqual({ index: 2, count: 2 })
  })

  it('does not intercept Up on the first line when caret is mid-line or at line end, then recalls once caret reaches offset 0', () => {
    seedThread('sess-1', [userEntry('u1', 'older prompt'), userEntry('u2', 'latest prompt')])
    const fakeEditor = createFakeEditor('draft line')
    const h = mountHistory(fakeEditor)

    // Caret at end of first line (pos 10): leave to editor so Up moves caret to 0.
    expect(h.move(false)).toBe(false)
    expect(h.onRecall).not.toHaveBeenCalled()
    expect(h.position()).toBeNull()

    // Caret in middle of first line (pos 5): still leave to editor.
    fakeEditor.setDoc('draft line', 5, 5)
    expect(h.move(false)).toBe(false)
    expect(h.onRecall).not.toHaveBeenCalled()
    expect(h.position()).toBeNull()

    // Caret has now reached offset 0: next Up enters history and preserves draft.
    fakeEditor.setDoc('draft line', 0, 0)
    expect(h.move(false)).toBe(true)
    expect(fakeEditor.getDoc().text).toBe('latest prompt')
    expect(h.position()).toEqual({ index: 2, count: 2 })

    // Stepping Down past the newest entry restores the original draft.
    expect(h.move(true)).toBe(true)
    expect(fakeEditor.getDoc().text).toBe('draft line')
    expect(h.position()).toBeNull()

    // After restoring the draft (caret at end), Up again defers to the editor first.
    expect(h.move(false)).toBe(false)
    expect(h.position()).toBeNull()
  })

  it('does not intercept Up with an active selection or multiple carets, even when selection touches offset 0', () => {
    seedThread('sess-1', [userEntry('u1', 'latest prompt')])
    const fakeEditor = createFakeEditor('draft line')
    const h = mountHistory(fakeEditor)

    fakeEditor.setDoc('draft line', 0, 5)
    expect(h.move(false)).toBe(false)

    fakeEditor.setDoc('draft line', 0, 0, true)
    expect(h.move(false)).toBe(false)
    expect(h.onRecall).not.toHaveBeenCalled()
  })

  it('does not intercept Down on the last line when not browsing history', () => {
    seedThread('sess-1', [userEntry('u1', 'latest prompt')])
    const fakeEditor = createFakeEditor('line one\nline two')
    const h = mountHistory(fakeEditor)

    // Mid-way through the last line: leave Down to the editor so it moves to the line end.
    fakeEditor.setDoc('line one\nline two', 12, 12)
    expect(h.move(true)).toBe(false)

    // At the end of the last line: still do not intercept.
    fakeEditor.setDoc('line one\nline two', 17, 17)
    expect(h.move(true)).toBe(false)

    // Empty box: still do not intercept Down.
    fakeEditor.setDoc('', 0, 0)
    expect(h.move(true)).toBe(false)
    expect(h.onRecall).not.toHaveBeenCalled()
  })

  it('keeps consecutive Up/Down browsing smooth across single-line and multiline history entries', () => {
    seedThread('sess-1', [
      userEntry('u1', 'oldest single'),
      userEntry('u2', 'multi line 1\nmulti line 2'),
      userEntry('u3', 'newest single'),
    ])
    const fakeEditor = createFakeEditor('')
    const h = mountHistory(fakeEditor)

    // 1st Up from empty box -> newest single (caret placed at end, pos 13).
    expect(h.move(false)).toBe(true)
    expect(fakeEditor.getDoc()).toEqual({ text: 'newest single', from: 13, to: 13 })
    expect(h.position()).toEqual({ index: 3, count: 3 })

    // 2nd Up immediately steps to multiline entry even though caret is at end of single line.
    expect(h.move(false)).toBe(true)
    expect(fakeEditor.getDoc().text).toBe('multi line 1\nmulti line 2')
    expect(h.position()).toEqual({ index: 2, count: 3 })

    // Caret is on line 2 of the multiline entry: Up lets the editor move to line 1 first.
    expect(h.move(false)).toBe(false)
    expect(h.position()).toEqual({ index: 2, count: 3 })

    // Once on line 1 (even mid-line, pos 5), Up steps smoothly to the oldest entry.
    fakeEditor.setDoc('multi line 1\nmulti line 2', 5, 5)
    expect(h.move(false)).toBe(true)
    expect(fakeEditor.getDoc().text).toBe('oldest single')
    expect(h.position()).toEqual({ index: 1, count: 3 })

    // Down back to the multiline entry (caret placed at end, on its last line).
    expect(h.move(true)).toBe(true)
    expect(fakeEditor.getDoc().text).toBe('multi line 1\nmulti line 2')
    expect(h.position()).toEqual({ index: 2, count: 3 })

    // If caret moves to line 1 of the multiline entry, Down lets the editor move to line 2 first.
    fakeEditor.setDoc('multi line 1\nmulti line 2', 0, 0)
    expect(h.move(true)).toBe(false)

    // Back on the last line (even mid-line, pos 16), Down steps to newest single.
    fakeEditor.setDoc('multi line 1\nmulti line 2', 16, 16)
    expect(h.move(true)).toBe(true)
    expect(fakeEditor.getDoc().text).toBe('newest single')
    expect(h.position()).toEqual({ index: 3, count: 3 })

    // Down once more leaves history and restores the empty draft.
    expect(h.move(true)).toBe(true)
    expect(fakeEditor.getDoc().text).toBe('')
    expect(h.position()).toBeNull()
  })

  it('requires caret at offset 0 again after editing a recalled history message', () => {
    seedThread('sess-1', [userEntry('u1', 'older'), userEntry('u2', 'latest')])
    const fakeEditor = createFakeEditor('')
    const h = mountHistory(fakeEditor)

    expect(h.move(false)).toBe(true)
    expect(fakeEditor.getDoc().text).toBe('latest')

    // User edits the recalled text -> PromptBox calls close() via changed().
    fakeEditor.setDoc('latest edited', 13, 13)
    h.close()

    // Now it is an ordinary draft: Up at end moves caret to 0 instead of overwriting edits.
    expect(h.move(false)).toBe(false)
    expect(fakeEditor.getDoc().text).toBe('latest edited')
  })

  it('cancels a pending loadOlder request when Down is pressed before leaving offset 0', async () => {
    seedThread('sess-1', [], 1)
    let resolveLoad!: (loaded: boolean) => void
    loadOlderMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLoad = resolve
        }),
    )

    const fakeEditor = createFakeEditor('')
    const h = mountHistory(fakeEditor)

    // Up on empty box triggers loadOlder.
    expect(h.move(false)).toBe(true)
    expect(loadOlderMock).toHaveBeenCalledTimes(1)

    // Down while not browsing cancels the pending recall and does not intercept the key.
    expect(h.move(true)).toBe(false)

    // Even if older messages arrive afterward while caret is still at 0, do not overwrite.
    seedThread('sess-1', [userEntry('u1', 'loaded older')], null)
    resolveLoad(true)
    await Promise.resolve()
    expect(h.onRecall).not.toHaveBeenCalled()
    expect(fakeEditor.getDoc().text).toBe('')
  })

  it('blocks composer keys while IME composition is active', () => {
    expect(
      popoverKey('ArrowUp', {
        composing: true,
        modified: false,
        slashOpen: false,
        mentionOpen: false,
        mentionRows: false,
      }),
    ).toBe('block')
    expect(
      popoverKey('ArrowDown', {
        composing: true,
        modified: false,
        slashOpen: false,
        mentionOpen: false,
        mentionRows: false,
      }),
    ).toBe('block')
  })
})
