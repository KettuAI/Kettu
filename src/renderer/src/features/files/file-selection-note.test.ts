import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enCommon from '@shared/locales/en/common.json'
import enFiles from '@shared/locales/en/files.json'
import zhCommon from '@shared/locales/zh-CN/common.json'
import zhFiles from '@shared/locales/zh-CN/files.json'
import { markNoteRange, noteRange } from './code-note-mark'
import { fileNoteMessage, fileQuote } from './file-quote'
import type { NoteSendAvailability } from './file-note-send'

type LocaleId = 'en' | 'zh-CN'

const { localeRef, hostMock, showSendingMock, unshowMock, quoteInComposerMock } = vi.hoisted(() => {
  if (typeof globalThis.document === 'undefined') {
    Object.assign(globalThis, {
      document: {
        oninput: null,
        createElement: () => ({ oninput: () => {}, setAttribute() {}, style: {} }),
        documentElement: { style: {} },
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
  const unshow = vi.fn()
  return {
    localeRef: { current: 'en' as LocaleId },
    hostMock: vi.fn<() => Promise<{ itemId: string | null }>>(async () => ({ itemId: null })),
    unshowMock: unshow,
    showSendingMock: vi.fn(() => unshow),
    quoteInComposerMock: vi.fn<() => 'no-composer' | 'full' | null>(() => null),
  }
})

const DICTIONARIES = {
  en: { files: enFiles, common: enCommon },
  'zh-CN': { files: zhFiles, common: zhCommon },
} as const

function lookup(dict: Record<string, unknown>, path: string): string | undefined {
  let cur: unknown = dict
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'string' ? cur : undefined
}

function interpolate(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
    vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`,
  )
}

function translate(key: string, vars?: Record<string, unknown>): string {
  const [ns, rest] = key.includes(':') ? key.split(':', 2) : ['files', key]
  const bundle = DICTIONARIES[localeRef.current][ns === 'common' ? 'common' : 'files'] as Record<
    string,
    unknown
  >
  const raw = lookup(bundle, rest!) ?? key
  return interpolate(raw, vars)
}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: translate }),
}))

vi.mock('@renderer/lib/host', () => ({
  host: hostMock,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('@renderer/stores/threads', () => ({
  showSending: showSendingMock,
  useThreadsStore: (selector: (s: { replicas: Record<string, never> }) => unknown) =>
    selector({ replicas: {} }),
}))

vi.mock('@renderer/stores/sessions', () => ({
  useSessionsStore: (selector: (s: { byId: Record<string, never> }) => unknown) =>
    selector({ byId: {} }),
}))

vi.mock('./mention-lines', () => ({
  quoteInComposer: quoteInComposerMock,
}))

vi.mock('./file-type-icon', () => ({
  FileTypeIcon: ({ path }: { path: string }) =>
    createElement('span', { 'data-file-type-icon': path }),
}))

vi.mock('@renderer/features/shell/panel-button', () => ({
  PaneIcon: () => createElement('span', { 'data-pane-icon': '' }),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: (props: Record<string, unknown> & { children?: ReactNode }) => {
    const rest: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
      if (k !== 'children' && k !== 'variant' && k !== 'size') rest[k] = v
    }
    return createElement('button', rest, props.children)
  },
}))

vi.mock('@renderer/components/ui/textarea', () => ({
  Textarea: (props: Record<string, unknown>) => createElement('textarea', props),
}))

// Minimal DOM harness matching Kettu's node-environment UI tests (e.g. marquee-ui.test.ts).
class FakeStyle {
  private readonly props = new Map<string, string>()
  setProperty(name: string, value: string): void {
    this.props.set(name, value)
  }
  removeProperty(name: string): void {
    this.props.delete(name)
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
  key?: string
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  isComposing?: boolean
  keyCode?: number
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
  get disabled(): boolean {
    return this.attributes.has('disabled')
  }
  set disabled(v: boolean) {
    if (v) this.attributes.set('disabled', '')
    else this.attributes.delete('disabled')
  }
  get textContent(): string {
    if (this.nodeType === FakeNodeBase.TEXT_NODE) return this.nodeValue ?? ''
    return this.childNodes.map((c) => c.textContent).join('')
  }
  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (value) {
      this.appendChild(new FakeDomNode(FakeNodeBase.TEXT_NODE, '#text', this.ownerDocument, value))
    }
  }
  appendChild(child: FakeDomNode): FakeDomNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }
  insertBefore(child: FakeDomNode, ref: FakeDomNode | null): FakeDomNode {
    if (!ref) return this.appendChild(child)
    if (child.parentNode) child.parentNode.removeChild(child)
    const idx = this.childNodes.indexOf(ref)
    child.parentNode = this
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
  focus(): void {}
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
    return dispatchOnNode(this, event)
  }
  getListeners(capture: boolean, type: string): Set<(event: FakeEvent) => void> | undefined {
    return (capture ? this.captureListeners : this.listeners).get(type)
  }
  find(predicate: (node: FakeDomNode) => boolean): FakeDomNode | null {
    if (predicate(this)) return this
    for (const child of this.childNodes) {
      const hit = child.find(predicate)
      if (hit) return hit
    }
    return null
  }
}

function dispatchOnNode(target: FakeDomNode, event: FakeEvent): boolean {
  event.target = target
  const path: FakeDomNode[] = []
  let cur: FakeDomNode | null = target
  while (cur) {
    path.push(cur)
    cur = cur.parentNode
  }
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i]!
    event.currentTarget = node
    for (const fn of [...(node.getListeners(true, event.type) ?? [])]) fn(event)
    if (event.propagationStopped) return !event.defaultPrevented
  }
  for (let i = 0; i < path.length; i++) {
    const node = path[i]!
    if (i > 0 && !event.bubbles) break
    event.currentTarget = node
    for (const fn of [...(node.getListeners(false, event.type) ?? [])]) fn(event)
    if (event.propagationStopped) break
  }
  return !event.defaultPrevented
}

class FakeDocument extends FakeDocumentBase {
  nodeType = FakeNodeBase.DOCUMENT_NODE
  nodeName = '#document'
  documentElement: FakeDomNode
  body: FakeDomNode
  head: FakeDomNode
  defaultView: unknown
  activeElement: FakeDomNode | null = null

  constructor() {
    super()
    this.documentElement = new FakeDomNode(FakeNodeBase.ELEMENT_NODE, 'html', this)
    this.head = new FakeDomNode(FakeNodeBase.ELEMENT_NODE, 'head', this)
    this.body = new FakeDomNode(FakeNodeBase.ELEMENT_NODE, 'body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }

  createElement(tag: string): FakeDomNode {
    return new FakeDomNode(FakeNodeBase.ELEMENT_NODE, tag, this)
  }
  createTextNode(text: string): FakeDomNode {
    return new FakeDomNode(FakeNodeBase.TEXT_NODE, '#text', this, text)
  }
  createComment(text: string): FakeDomNode {
    return new FakeDomNode(FakeNodeBase.COMMENT_NODE, '#comment', this, text)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

function makeEvent(type: string, extra: Partial<FakeEvent> = {}): FakeEvent {
  const event: FakeEvent = {
    type,
    target: null,
    currentTarget: null,
    bubbles: true,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {
      event.propagationStopped = true
    },
    ...extra,
  }
  return event
}

function setTextareaValue(node: FakeDomNode, next: string): void {
  const propsKey = Object.keys(node).find((k) => k.startsWith('__reactProps$'))
  const reactProps = propsKey
    ? (node as unknown as Record<string, { onChange?: (e: unknown) => void }>)[propsKey]
    : undefined
  node.value = next
  flushSync(() => {
    reactProps?.onChange?.({ target: node, currentTarget: node })
  })
}

function fireKeyDown(node: FakeDomNode, extra: Partial<FakeEvent>): FakeEvent {
  const propsKey = Object.keys(node).find((k) => k.startsWith('__reactProps$'))
  const reactProps = propsKey
    ? (node as unknown as Record<string, { onKeyDown?: (e: unknown) => void }>)[propsKey]
    : undefined
  const native = makeEvent('keydown', extra)
  flushSync(() => {
    reactProps?.onKeyDown?.({
      ...native,
      nativeEvent: native,
      preventDefault: native.preventDefault,
      stopPropagation: native.stopPropagation,
    })
  })
  return native
}

function clickNode(node: FakeDomNode): void {
  if (node.disabled) return
  flushSync(() => {
    node.dispatchEvent(makeEvent('click'))
  })
}

describe('noteSendAvailability', () => {
  it('handles idle, busy/queued, waitingBackground, and all disabled session states', async () => {
    const { noteSendAvailability } = await import('./file-note-send')

    expect(noteSendAvailability({ sessionId: null })).toEqual({
      canSend: false,
      mode: 'disabled',
      reason: 'no-session',
    })
    expect(noteSendAvailability({ sessionId: 's1', summary: null })).toEqual({
      canSend: false,
      mode: 'disabled',
      reason: 'no-session',
    })
    expect(
      noteSendAvailability({
        sessionId: 's1',
        summary: { status: 'ready', archivedAt: 1234, origin: 'user' },
      }),
    ).toEqual({
      canSend: false,
      mode: 'disabled',
      reason: 'no-session',
    })
    expect(
      noteSendAvailability({
        sessionId: 's1',
        summary: { status: 'ready', archivedAt: null, origin: 'subagent' },
      }),
    ).toEqual({
      canSend: false,
      mode: 'disabled',
      reason: 'subagent',
    })
    expect(
      noteSendAvailability({
        sessionId: 's1',
        summary: { status: 'ready', archivedAt: null, origin: 'user' },
        threadSession: { status: 'ready', heldOutside: true, origin: 'user' },
      }),
    ).toEqual({
      canSend: false,
      mode: 'disabled',
      reason: 'held-outside',
    })
    expect(
      noteSendAvailability({
        sessionId: 's1',
        summary: { status: 'starting', archivedAt: null, origin: 'user' },
      }),
    ).toEqual({
      canSend: false,
      mode: 'disabled',
      reason: 'starting',
    })
    expect(
      noteSendAvailability({
        sessionId: 's1',
        summary: { status: 'failed', archivedAt: null, origin: 'user' },
      }),
    ).toEqual({
      canSend: false,
      mode: 'disabled',
      reason: 'unavailable',
    })
    expect(
      noteSendAvailability({
        sessionId: 's1',
        summary: { status: 'ready', archivedAt: null, origin: 'user' },
      }),
    ).toEqual({
      canSend: true,
      mode: 'send',
    })
    expect(
      noteSendAvailability({
        sessionId: 's1',
        summary: { status: 'closed', archivedAt: null, origin: 'user' },
      }),
    ).toEqual({
      canSend: true,
      mode: 'send',
    })
    expect(
      noteSendAvailability({
        sessionId: 's1',
        summary: { status: 'running', archivedAt: null, origin: 'user' },
      }),
    ).toEqual({
      canSend: true,
      mode: 'queue',
    })
    expect(
      noteSendAvailability({
        sessionId: 's1',
        summary: { status: 'awaiting_permission', archivedAt: null, origin: 'user' },
      }),
    ).toEqual({
      canSend: true,
      mode: 'queue',
    })
    expect(
      noteSendAvailability({
        sessionId: 's1',
        summary: { status: 'running', archivedAt: null, origin: 'user' },
        threadSession: { status: 'running', waitingBackground: true, origin: 'user' },
      }),
    ).toEqual({
      canSend: true,
      mode: 'send',
    })
  })
})

describe('sendFileSelectionNote and insertFileNoteInComposer', () => {
  beforeEach(() => {
    hostMock.mockReset()
    showSendingMock.mockClear()
    unshowMock.mockClear()
    quoteInComposerMock.mockReset()
    quoteInComposerMock.mockReturnValue(null)
  })

  it('sends only the quoted passage and note via sessions.queue with optimistic echo when free', async () => {
    const { sendFileSelectionNote } = await import('./file-note-send')
    hostMock.mockResolvedValueOnce({ itemId: null })

    const passage = { lines: [12, 14] as [number, number], text: 'if (!ok) return\nretry()' }
    const res = await sendFileSelectionNote({
      sessionId: 's1',
      path: 'src/retry.ts',
      passage,
      note: '  Add jitter here  ',
      optimistic: true,
    })

    const expected = fileNoteMessage('src/retry.ts', passage, 'Add jitter here')
    expect(res).toEqual({ outcome: 'sent', itemId: null, text: expected })
    expect(showSendingMock).toHaveBeenCalledWith('s1', [{ type: 'text', text: expected }])
    expect(hostMock).toHaveBeenCalledWith('sessions.queue', {
      sessionId: 's1',
      content: [{ type: 'text', text: expected }],
    })
    expect(unshowMock).not.toHaveBeenCalled()
  })

  it('removes optimistic entry when the host queues the note while the session is busy', async () => {
    const { sendFileSelectionNote } = await import('./file-note-send')
    hostMock.mockResolvedValueOnce({ itemId: 'q-42' })

    const res = await sendFileSelectionNote({
      sessionId: 's1',
      path: 'src/retry.ts',
      passage: { lines: [5, 5], text: 'const max = 3' },
      note: 'Bump to 5',
      optimistic: true,
    })

    expect(res.outcome).toBe('queued')
    expect(res.itemId).toBe('q-42')
    expect(unshowMock).toHaveBeenCalledWith()
  })

  it('rolls back optimistic echo and restores suggestion when sending fails', async () => {
    const { sendFileSelectionNote } = await import('./file-note-send')
    hostMock.mockRejectedValueOnce(new Error('Host disconnected'))

    await expect(
      sendFileSelectionNote({
        sessionId: 's1',
        path: 'src/retry.ts',
        passage: { lines: [5, 5], text: 'const max = 3' },
        note: 'Bump to 5',
        optimistic: true,
      }),
    ).rejects.toThrow('Host disconnected')

    expect(unshowMock).toHaveBeenCalledWith({ restoreSuggestion: true })
  })

  it('rejects empty or whitespace-only notes without calling the host', async () => {
    const { sendFileSelectionNote } = await import('./file-note-send')

    await expect(
      sendFileSelectionNote({
        sessionId: 's1',
        path: 'src/retry.ts',
        passage: { lines: [5, 5], text: 'const max = 3' },
        note: '   \n  ',
      }),
    ).rejects.toThrow('Cannot send an empty note')
    expect(hostMock).not.toHaveBeenCalled()
  })

  it('reuses quoteInComposer when sending the selection and optional note to the composer', async () => {
    const { insertFileNoteInComposer } = await import('./file-note-send')
    const passage = { lines: [2, 3] as [number, number], text: 'a()\nb()' }

    expect(
      insertFileNoteInComposer({
        sessionId: 's1',
        path: 'src/run.ts',
        passage,
        note: 'Extract helper',
      }),
    ).toBeNull()
    expect(quoteInComposerMock).toHaveBeenLastCalledWith(
      's1',
      fileNoteMessage('src/run.ts', passage, 'Extract helper'),
    )

    expect(
      insertFileNoteInComposer({
        sessionId: 's1',
        path: 'src/run.ts',
        passage,
        note: '   ',
      }),
    ).toBeNull()
    expect(quoteInComposerMock).toHaveBeenLastCalledWith('s1', fileQuote('src/run.ts', passage))
  })
})

describe('noteKeyAction, geometry clamping, and CodeMirror anchor range', () => {
  it('handles Enter, Mod+Enter, Shift+Enter, Escape, and IME composition safely', async () => {
    const { noteKeyAction } = await import('./file-note-model')
    const base = {
      key: 'Enter',
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
    }

    // IME guards must suppress both Enter and Escape.
    expect(noteKeyAction({ ...base, isComposing: true }, 'enter')).toBe('ignore')
    expect(noteKeyAction({ ...base, keyCode: 229 }, 'enter')).toBe('ignore')
    expect(noteKeyAction({ ...base, key: 'Escape', isComposing: true }, 'mod-enter')).toBe('ignore')
    expect(noteKeyAction({ ...base, key: 'Escape', keyCode: 229 }, 'mod-enter')).toBe('ignore')

    // Escape closes outside composition.
    expect(noteKeyAction({ ...base, key: 'Escape' }, 'enter')).toBe('close')
    expect(noteKeyAction({ ...base, key: 'Escape' }, 'mod-enter')).toBe('close')

    // sendKey === 'enter'
    expect(noteKeyAction(base, 'enter')).toBe('send')
    expect(noteKeyAction({ ...base, metaKey: true }, 'enter')).toBe('send')
    expect(noteKeyAction({ ...base, shiftKey: true }, 'enter')).toBe('ignore')
    expect(noteKeyAction({ ...base, altKey: true }, 'enter')).toBe('ignore')

    // sendKey === 'mod-enter' (darwin window.kettu.platform => metaKey)
    expect(noteKeyAction(base, 'mod-enter')).toBe('ignore')
    expect(noteKeyAction({ ...base, metaKey: true }, 'mod-enter')).toBe('send')
    expect(noteKeyAction({ ...base, metaKey: true, altKey: true }, 'mod-enter')).toBe('ignore')
  })

  it('clamps selection rects within pane bounds and checks visibility', async () => {
    const { clampRectToBounds, isRectVisibleInBounds } = await import('./file-note-model')
    const bounds = { left: 100, top: 50, right: 500, bottom: 450 }

    expect(clampRectToBounds({ left: 60, top: 10, right: 620, bottom: 520 }, bounds)).toEqual(
      bounds,
    )
    expect(clampRectToBounds({ left: 150, top: 120, right: 320, bottom: 140 }, bounds)).toEqual({
      left: 150,
      top: 120,
      right: 320,
      bottom: 140,
    })

    expect(isRectVisibleInBounds({ left: 150, top: 100, right: 200, bottom: 120 }, bounds)).toBe(
      true,
    )
    expect(isRectVisibleInBounds({ left: 150, top: 10, right: 200, bottom: 50 }, bounds)).toBe(
      false,
    )
    expect(isRectVisibleInBounds({ left: 150, top: 450, right: 200, bottom: 480 }, bounds)).toBe(
      false,
    )
  })

  it('tracks and maps anchored editor highlight range across document edits', () => {
    let state = EditorState.create({
      doc: 'alpha\nbeta\ngamma',
      extensions: [noteRange],
    })
    expect(state.field(noteRange)).toBeNull()

    state = state.update({ effects: markNoteRange.of({ from: 6, to: 10 }) }).state
    expect(state.field(noteRange)).toEqual({ from: 6, to: 10 })

    // Inserting before the anchored range shifts it forward cleanly.
    state = state.update({ changes: { from: 0, insert: '// ' } }).state
    expect(state.field(noteRange)).toEqual({ from: 9, to: 13 })

    // Deleting the anchored range clears the highlight automatically.
    state = state.update({ changes: { from: 9, to: 13, insert: '' } }).state
    expect(state.field(noteRange)).toBeNull()

    // Explicit clear removes any active range.
    state = state.update({ effects: markNoteRange.of({ from: 0, to: 4 }) }).state
    state = state.update({ effects: markNoteRange.of(null) }).state
    expect(state.field(noteRange)).toBeNull()
  })
})

describe('FileSelectionNoteCard UI behavior', () => {
  let doc: FakeDocument
  let container: FakeDomNode
  let root: Root
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
  }

  beforeEach(() => {
    localeRef.current = 'en'
    doc = new FakeDocument()
    const FakeIFrameElement = class {}
    const win = {
      document: doc,
      HTMLIFrameElement: FakeIFrameElement,
      kettu: { platform: 'darwin', client: 'desktop' },
      addEventListener() {},
      removeEventListener() {},
    }
    doc.defaultView = win
    Object.assign(globalThis, {
      document: doc,
      window: win,
      HTMLElement: FakeDomNode,
      HTMLIFrameElement: FakeIFrameElement,
      Element: FakeElementBase,
      Node: FakeNodeBase,
    })
    container = doc.createElement('div')
    doc.body.appendChild(container)
    root = createRoot(container as unknown as Element)
  })

  afterEach(() => {
    flushSync(() => root.unmount())
    Object.assign(globalThis, saved)
  })

  it('previews file path, line range, and selected text, blocks empty notes, and sends on submit', async () => {
    const { FileSelectionNoteCard } = await import('./file-selection-note')
    const onSend = vi.fn(async () => ({ outcome: 'sent' as const }))
    const onClose = vi.fn()
    const availability: NoteSendAvailability = { canSend: true, mode: 'send' }

    flushSync(() => {
      root.render(
        createElement(FileSelectionNoteCard, {
          path: 'src/features/auth.ts',
          passage: {
            lines: [12, 18],
            text: 'function verify(token: string) {\n  return !!token\n}',
          },
          availability,
          sessionId: 's1',
          sendKey: 'mod-enter',
          onSend,
          onClose,
        }),
      )
    })

    expect(container.find((n) => n.hasAttribute('data-file-note-path'))?.textContent).toBe(
      'src/features/auth.ts',
    )
    expect(container.find((n) => n.hasAttribute('data-file-note-lines'))?.textContent).toBe(
      'L12\u2013L18',
    )
    expect(container.find((n) => n.hasAttribute('data-file-note-excerpt'))?.textContent).toContain(
      'function verify(token: string)',
    )

    const sendBtn = container.find((n) => n.hasAttribute('data-file-note-send'))!
    const textarea = container.find((n) => n.hasAttribute('data-file-note-input'))!
    expect(sendBtn.disabled).toBe(true)

    // Whitespace-only note stays disabled and ignores send shortcut.
    setTextareaValue(textarea, '   ')
    expect(sendBtn.disabled).toBe(true)
    fireKeyDown(textarea, { key: 'Enter', metaKey: true })
    expect(onSend).not.toHaveBeenCalled()

    // IME composition ignores Enter and Escape.
    setTextareaValue(textarea, 'Check token expiry')
    expect(sendBtn.disabled).toBe(false)
    fireKeyDown(textarea, { key: 'Enter', metaKey: true, isComposing: true })
    fireKeyDown(textarea, { key: 'Escape', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    // Real Mod+Enter sends the trimmed note and closes on resolution.
    fireKeyDown(textarea, { key: 'Enter', metaKey: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(onSend).toHaveBeenCalledWith('Check token expiry')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('retains draft and shows alert when sending fails, and supports Escape / Cancel', async () => {
    const { FileSelectionNoteCard } = await import('./file-selection-note')
    const onSend = vi.fn(async () => {
      throw new Error('Network offline')
    })
    const onClose = vi.fn()

    flushSync(() => {
      root.render(
        createElement(FileSelectionNoteCard, {
          path: 'src/app.ts',
          passage: { lines: [7, 7], text: 'const port = 3000' },
          availability: { canSend: true, mode: 'send' },
          sessionId: 's1',
          sendKey: 'enter',
          onSend,
          onClose,
        }),
      )
    })

    expect(container.find((n) => n.hasAttribute('data-file-note-lines'))?.textContent).toBe('L7')
    const textarea = container.find((n) => n.hasAttribute('data-file-note-input'))!
    setTextareaValue(textarea, 'Read port from env')

    // Shift+Enter does not submit even when sendKey === 'enter'.
    fireKeyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()

    // Plain Enter submits and surfaces error while keeping the draft.
    fireKeyDown(textarea, { key: 'Enter' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onSend).toHaveBeenCalledWith('Read port from env')
    expect(onClose).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Read port from env')
    expect(container.find((n) => n.hasAttribute('data-file-note-error'))?.textContent).toContain(
      'Network offline',
    )

    // Cancel button and Escape both dismiss cleanly.
    const cancelBtn = container.find((n) => n.hasAttribute('data-file-note-cancel'))!
    clickNode(cancelBtn)
    expect(onClose).toHaveBeenCalledTimes(1)

    fireKeyDown(textarea, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('disables Send with a clear hint when no active session exists, and supports To composer and zh-CN copy', async () => {
    const { FileSelectionNoteCard } = await import('./file-selection-note')
    const onSend = vi.fn(async () => ({ outcome: 'sent' as const }))
    const onClose = vi.fn()
    const onToComposer = vi.fn(() => null)

    // No active session in zh-CN
    localeRef.current = 'zh-CN'
    flushSync(() => {
      root.render(
        createElement(FileSelectionNoteCard, {
          path: 'docs/guide.md',
          passage: { lines: null, text: 'Rendered markdown excerpt' },
          availability: { canSend: false, mode: 'disabled', reason: 'no-session' },
          sessionId: null,
          onSend,
          onToComposer,
          onClose,
        }),
      )
    })

    expect(container.find((n) => n.hasAttribute('data-file-note-lines'))?.textContent).toBe(
      zhFiles.note.selection,
    )
    expect(container.find((n) => n.hasAttribute('data-file-note-disabled'))?.textContent).toBe(
      zhFiles.note.disabled.noSession,
    )
    expect(container.find((n) => n.hasAttribute('data-file-note-composer'))).toBeNull()

    const textarea = container.find((n) => n.hasAttribute('data-file-note-input'))!
    setTextareaValue(textarea, '补充示例')
    const sendBtn = container.find((n) => n.hasAttribute('data-file-note-send'))!
    expect(sendBtn.disabled).toBe(true)

    // Busy session in queue mode with To composer action
    flushSync(() => {
      root.render(
        createElement(FileSelectionNoteCard, {
          path: 'docs/guide.md',
          passage: { lines: [3, 4], text: 'line 3\nline 4' },
          availability: { canSend: true, mode: 'queue' },
          sessionId: 's1',
          onSend,
          onToComposer,
          onClose,
        }),
      )
    })

    expect(container.find((n) => n.hasAttribute('data-file-note-queued-hint'))?.textContent).toBe(
      zhFiles.note.queuedHint,
    )
    const composerBtn = container.find((n) => n.hasAttribute('data-file-note-composer'))!
    expect(composerBtn.textContent).toBe(zhFiles.note.toComposer)
    clickNode(composerBtn)
    expect(onToComposer).toHaveBeenCalledWith('补充示例')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
