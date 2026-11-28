import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadEntry, ThreadState } from '@shared/thread'
import { i18n } from '@renderer/lib/i18n'

const { mockHost } = vi.hoisted(() => {
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        kettu: { platform: 'darwin' },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
  return { mockHost: vi.fn() }
})

vi.mock('@renderer/lib/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/host')>()
  return {
    ...actual,
    host: (...args: unknown[]) => mockHost(...args),
  }
})

vi.mock('../clamp', () => ({
  Clamp: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-clamp': '' }, children),
}))

vi.mock('../markdown', () => ({
  Markdown: ({ markdown, streaming }: { markdown: string; streaming?: boolean }) =>
    createElement(
      'div',
      { 'data-markdown': '', 'data-streaming': streaming ? 'true' : 'false' },
      markdown,
    ),
}))

vi.mock('../use-thread', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../use-thread')>()
  return {
    ...actual,
    useEntryAnimation: () => '',
  }
})

import {
  MAX_CACHED_THOUGHT_TRANSLATIONS,
  thoughtTranslationKey,
  useThoughtTranslationsStore,
  type ThoughtTranslateRequester,
} from '@renderer/stores/thought-translations'
import { useThreadsStore } from '@renderer/stores/threads'
import { ThoughtEntry } from './basic'
import { ThoughtSummaryView } from './thought-translation'
import { StepCard } from './tool-call'
import { ThoughtBody } from './tool-call-parts'

interface FakeNode {
  nodeType: number
  nodeName: string
  tagName?: string
  namespaceURI?: string
  nodeValue?: string
  childNodes: FakeNode[]
  parentNode: FakeNode | null
  ownerDocument: FakeDocument | null
  style: Record<string, string>
  dataset: Record<string, string>
  attributes: Map<string, string>
  listeners: Map<string, Set<(event: FakeEvent) => void>>
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  addEventListener(type: string, listener: (event: FakeEvent) => void): void
  removeEventListener(type: string, listener: (event: FakeEvent) => void): void
  dispatchEvent(event: FakeEvent): boolean
  readonly firstChild: FakeNode | null
  readonly lastChild: FakeNode | null
  textContent: string
  [key: string]: unknown
}

interface FakeEvent {
  type: string
  bubbles?: boolean
  target?: FakeNode | null
  currentTarget?: FakeNode | null
  defaultPrevented?: boolean
  preventDefault(): void
  stopPropagation(): void
}

interface FakeDocument {
  nodeType: number
  nodeName: string
  documentElement: FakeNode
  head: FakeNode
  body: FakeNode
  defaultView: FakeWindow
  createElement(tag: string): FakeNode
  createElementNS(ns: string, tag: string): FakeNode
  createTextNode(text: string): FakeNode
  createComment(text: string): FakeNode
  querySelector(): FakeNode | null
  querySelectorAll(): FakeNode[]
  addEventListener(): void
  removeEventListener(): void
}

interface FakeWindow {
  document: FakeDocument
  navigator: { userAgent: string }
  HTMLElement: typeof FakeElementBase
  SVGElement: typeof FakeElementBase
  Element: typeof FakeElementBase
  Node: typeof FakeNodeBase
  Document: typeof FakeDocumentBase
  HTMLIFrameElement: typeof FakeElementBase
  matchMedia(query: string): { matches: boolean }
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  addEventListener(): void
  removeEventListener(): void
}

class FakeNodeBase {
  static ELEMENT_NODE = 1
  static TEXT_NODE = 3
  static COMMENT_NODE = 8
  static DOCUMENT_NODE = 9
}

class FakeElementBase extends FakeNodeBase {}
class FakeDocumentBase extends FakeNodeBase {}

class FakeDomNode extends FakeElementBase implements FakeNode {
  nodeType: number
  nodeName: string
  tagName?: string
  namespaceURI?: string
  nodeValue?: string
  childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  ownerDocument: FakeDocument | null
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  listeners = new Map<string, Set<(event: FakeEvent) => void>>();
  [key: string]: unknown

  constructor(name: string, nodeType: number, owner: FakeDocument | null) {
    super()
    this.nodeType = nodeType
    this.nodeName = nodeType === 1 ? name.toUpperCase() : name
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

  hasAttribute(attr: string): boolean {
    return this.attributes.has(attr)
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

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target = this
    event.currentTarget = this
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event)
    }
    if (event.bubbles) {
      let parent = this.parentNode
      while (parent) {
        event.currentTarget = parent
        for (const listener of parent.listeners.get(event.type) ?? []) {
          listener(event)
        }
        parent = parent.parentNode
      }
    }
    return !event.defaultPrevented
  }

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

function createFakeDom(): { window: FakeWindow; document: FakeDocument } {
  const makeNode = (name: string, nodeType: number, owner: FakeDocument | null): FakeNode =>
    new FakeDomNode(name, nodeType, owner)
  const doc: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as FakeNode,
    head: null as unknown as FakeNode,
    body: null as unknown as FakeNode,
    defaultView: null as unknown as FakeWindow,
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
    addEventListener() {},
    removeEventListener() {},
  }
  const html = makeNode('html', 1, doc)
  const head = makeNode('head', 1, doc)
  const body = makeNode('body', 1, doc)
  html.appendChild(head)
  html.appendChild(body)
  doc.documentElement = html
  doc.head = head
  doc.body = body
  const win: FakeWindow = {
    document: doc,
    navigator: { userAgent: 'node' },
    HTMLElement: FakeElementBase,
    SVGElement: FakeElementBase,
    Element: FakeElementBase,
    Node: FakeNodeBase,
    Document: FakeDocumentBase,
    HTMLIFrameElement: FakeElementBase,
    matchMedia: () => ({ matches: false }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener() {},
    removeEventListener() {},
  }
  doc.defaultView = win
  return { window: win, document: doc }
}

function findAll(root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode[] {
  const matches: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (predicate(node)) matches.push(node)
    for (const child of node.childNodes) walk(child)
  }
  walk(root)
  return matches
}

function findByAttr(root: FakeNode, attr: string, value?: string): FakeNode | undefined {
  return findAll(
    root,
    (node) => node.hasAttribute(attr) && (value === undefined || node.getAttribute(attr) === value),
  )[0]
}

function clickNode(node: FakeNode): void {
  const propsKey = Object.keys(node).find((key) => key.startsWith('__reactProps$'))
  const reactProps = propsKey ? (node[propsKey] as { onClick?: (event: FakeEvent) => void }) : null
  if (typeof reactProps?.onClick === 'function') {
    flushSync(() => {
      reactProps.onClick!({
        type: 'click',
        bubbles: true,
        preventDefault() {},
        stopPropagation() {},
      })
    })
    return
  }
  throw new Error(`Node ${node.nodeName} has no React onClick handler`)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setThoughtThread(entry: Extract<ThreadEntry, { kind: 'thought' }>): void {
  const state: ThreadState = {
    session: {
      id: 's1',
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: null,
      status: 'ready',
      title: 'Test',
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
    order: [entry.id],
    byId: { [entry.id]: entry },
  }
  useThreadsStore.setState({
    replicas: {
      s1: {
        state,
        seq: 1,
        status: 'ready',
        error: null,
        older: null,
        loadingOlder: false,
        olderFailure: null,
        plan: null,
      },
    },
  })
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('ThoughtSummaryView and thought translation store', () => {
  const savedWindow = globalThis.window
  const savedDocument = globalThis.document
  const savedGlobals = {
    HTMLElement: globalThis.HTMLElement,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    SVGElement: globalThis.SVGElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Document: globalThis.Document,
  }
  let container: FakeNode
  let root: Root | null = null

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    mockHost.mockReset()
    useThoughtTranslationsStore.getState().reset()
    useThreadsStore.setState({ replicas: {} })
    const dom = createFakeDom()
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.document,
      HTMLElement: FakeElementBase,
      HTMLButtonElement: FakeElementBase,
      SVGElement: FakeElementBase,
      Element: FakeElementBase,
      Node: FakeNodeBase,
      Document: FakeDocumentBase,
    })
    container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    root = createRoot(container as unknown as Element)
  })

  afterEach(async () => {
    if (root) {
      flushSync(() => root!.unmount())
      root = null
    }
    useThoughtTranslationsStore.getState().reset()
    useThreadsStore.setState({ replicas: {} })
    await i18n.changeLanguage('en')
    Object.assign(globalThis, {
      window: savedWindow,
      document: savedDocument,
      ...savedGlobals,
    })
  })

  it('defaults to the original thinking summary with zero automatic translation requests', () => {
    const requester = vi.fn<ThoughtTranslateRequester>()
    flushSync(() => {
      root!.render(
        createElement(ThoughtSummaryView, {
          sessionId: 's1',
          entryId: 't1',
          markdown: '**Plan**\n\nInspect `src/main/ipc.ts` first.',
          streaming: false,
          maxHeight: 180,
          requester,
        }),
      )
    })

    expect(requester).not.toHaveBeenCalled()
    expect(mockHost).not.toHaveBeenCalled()
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe(
      '**Plan**\n\nInspect `src/main/ipc.ts` first.',
    )
    expect(findByAttr(container, 'data-thought-translate')?.textContent).toContain('Translate')
    expect(findByAttr(container, 'data-thought-translated-badge')).toBeUndefined()
    expect(findByAttr(container, 'data-thought-toggle')).toBeUndefined()
  })

  it('hides translation controls while streaming or when the summary text is blank', () => {
    const requester = vi.fn<ThoughtTranslateRequester>()
    flushSync(() => {
      root!.render(
        createElement(ThoughtSummaryView, {
          sessionId: 's1',
          entryId: 't1',
          markdown: 'Still thinking...',
          streaming: true,
          maxHeight: 180,
          requester,
        }),
      )
    })
    expect(findByAttr(container, 'data-thought-translate')).toBeUndefined()
    expect(requester).not.toHaveBeenCalled()

    flushSync(() => {
      root!.render(
        createElement(ThoughtSummaryView, {
          sessionId: 's1',
          entryId: 't1',
          markdown: '   \n  ',
          streaming: false,
          maxHeight: 180,
          requester,
        }),
      )
    })
    expect(findByAttr(container, 'data-thought-translate')).toBeUndefined()
    expect(requester).not.toHaveBeenCalled()
  })

  it('translates on click, prevents duplicate concurrent requests, labels translation, and toggles instantaneously from cache', async () => {
    await i18n.changeLanguage('zh-CN')
    const pending = deferred<{ translation: string; agent: string }>()
    const requester = vi.fn<ThoughtTranslateRequester>(() => pending.promise)
    const original = '**Inspect cache**\n\nCheck `src/shared/thread.ts` for entry types.'
    setThoughtThread({ kind: 'thought', id: 't1', markdown: original, streaming: false })

    flushSync(() => {
      root!.render(
        createElement(ThoughtSummaryView, {
          sessionId: 's1',
          entryId: 't1',
          markdown: original,
          streaming: false,
          maxHeight: 180,
          requester,
        }),
      )
    })

    const translateBtn = findByAttr(container, 'data-thought-translate')!
    expect(translateBtn.textContent).toContain('翻译')

    clickNode(translateBtn)

    // Loading state keeps original text readable and blocks concurrent duplicate calls.
    expect(requester).toHaveBeenCalledTimes(1)
    expect(requester).toHaveBeenCalledWith({
      sessionId: 's1',
      entryId: 't1',
      text: original,
      language: 'zh-CN',
    })
    expect(findByAttr(container, 'data-thought-translating')?.textContent).toContain('翻译中…')
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe(original)

    // Triggering translate again while in flight must deduplicate.
    void useThoughtTranslationsStore.getState().translate('s1', 't1', original, 'zh-CN', requester)
    expect(requester).toHaveBeenCalledTimes(1)

    const translated = '**检查缓存**\n\n查看 `src/shared/thread.ts` 中的条目类型。'
    pending.resolve({ translation: translated, agent: 'Claude Code' })
    await flushMicrotasks()

    // Translation renders with explicit "译文" label and Original / Translation toggle.
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe(translated)
    expect(findByAttr(container, 'data-thought-translated-badge')?.textContent).toBe('译文')
    const originalBtn = findByAttr(container, 'data-thought-view', 'original')!
    const translationBtn = findByAttr(container, 'data-thought-view', 'translation')!
    expect(originalBtn.textContent).toBe('原文')
    expect(translationBtn.textContent).toBe('译文')
    expect(originalBtn.getAttribute('aria-pressed')).toBe('false')
    expect(translationBtn.getAttribute('aria-pressed')).toBe('true')

    // Stored original thread entry must remain untouched.
    expect(useThreadsStore.getState().replicas.s1?.state?.byId.t1).toEqual({
      kind: 'thought',
      id: 't1',
      markdown: original,
      streaming: false,
    })

    // Instant toggle to Original and back to Translation uses cache with zero extra requests.
    clickNode(originalBtn)
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe(original)
    expect(findByAttr(container, 'data-thought-translated-badge')).toBeUndefined()
    expect(originalBtn.getAttribute('aria-pressed')).toBe('true')
    expect(requester).toHaveBeenCalledTimes(1)

    clickNode(translationBtn)
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe(translated)
    expect(findByAttr(container, 'data-thought-translated-badge')?.textContent).toBe('译文')
    expect(requester).toHaveBeenCalledTimes(1)
  })

  it('invalidates cached translation when the underlying text or target language changes', async () => {
    const requester = vi.fn<ThoughtTranslateRequester>(async ({ text, language }) => ({
      translation: `[${language}] ${text}`,
      agent: 'Claude Code',
    }))

    flushSync(() => {
      root!.render(
        createElement(ThoughtSummaryView, {
          sessionId: 's1',
          entryId: 't1',
          markdown: 'First version',
          streaming: false,
          maxHeight: 180,
          requester,
        }),
      )
    })

    clickNode(findByAttr(container, 'data-thought-translate')!)
    await flushMicrotasks()
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe('[en] First version')

    // Underlying text changes -> falls back cleanly to original and offers Translate again.
    flushSync(() => {
      root!.render(
        createElement(ThoughtSummaryView, {
          sessionId: 's1',
          entryId: 't1',
          markdown: 'First version\n\nSecond paragraph',
          streaming: false,
          maxHeight: 180,
          requester,
        }),
      )
    })
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe(
      'First version\n\nSecond paragraph',
    )
    expect(findByAttr(container, 'data-thought-translated-badge')).toBeUndefined()
    expect(findByAttr(container, 'data-thought-translate')).toBeDefined()

    // Target language changes -> falls back cleanly to original for the new target language.
    flushSync(() => {
      root!.render(
        createElement(ThoughtSummaryView, {
          sessionId: 's1',
          entryId: 't1',
          markdown: 'First version',
          streaming: false,
          maxHeight: 180,
          requester,
        }),
      )
    })
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe('[en] First version')

    await i18n.changeLanguage('zh-CN')
    flushSync(() => {
      root!.render(
        createElement(ThoughtSummaryView, {
          sessionId: 's1',
          entryId: 't1',
          markdown: 'First version',
          streaming: false,
          maxHeight: 180,
          requester,
        }),
      )
    })
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe('First version')
    expect(findByAttr(container, 'data-thought-translated-badge')).toBeUndefined()
    clickNode(findByAttr(container, 'data-thought-translate')!)
    await flushMicrotasks()
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe('[zh-CN] First version')
    expect(requester).toHaveBeenCalledTimes(2)
  })

  it('preserves the original text on failure and supports retry', async () => {
    const requester = vi
      .fn<ThoughtTranslateRequester>()
      .mockRejectedValueOnce(new Error('No agent is available'))
      .mockResolvedValueOnce({ translation: '重试后的译文。', agent: 'Claude Code' })

    const original = 'Checking failure recovery.'
    flushSync(() => {
      root!.render(
        createElement(ThoughtSummaryView, {
          sessionId: 's1',
          entryId: 't1',
          markdown: original,
          streaming: false,
          maxHeight: 180,
          requester,
        }),
      )
    })

    clickNode(findByAttr(container, 'data-thought-translate')!)
    await flushMicrotasks()

    expect(findByAttr(container, 'data-markdown')?.textContent).toBe(original)
    expect(findByAttr(container, 'data-thought-error')?.textContent).toContain(
      'No agent is available',
    )
    const retryBtn = findByAttr(container, 'data-thought-retry')!
    expect(retryBtn.textContent).toBe('Retry')

    clickNode(retryBtn)
    await flushMicrotasks()

    expect(requester).toHaveBeenCalledTimes(2)
    expect(findByAttr(container, 'data-thought-error')).toBeUndefined()
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe('重试后的译文。')
    expect(findByAttr(container, 'data-thought-translated-badge')?.textContent).toBe('Translated')
  })

  it('wires ThoughtBody, ThoughtEntry and StepCard to the shared translation store via host RPC', async () => {
    await i18n.changeLanguage('zh-CN')
    const original = '**Inspect settings**\n\nRead the config file carefully.'
    const translated = '**检查设置**\n\n仔细读取配置文件。'
    mockHost.mockResolvedValue({ translation: translated, agent: 'Claude Code' })
    setThoughtThread({ kind: 'thought', id: 't1', markdown: original, streaming: false })

    // ThoughtBody triggers the real `sessions.translateThought` RPC through `host()`.
    flushSync(() => {
      root!.render(createElement(ThoughtBody, { sessionId: 's1', entryId: 't1' }))
    })
    clickNode(findByAttr(container, 'data-thought-translate')!)
    await flushMicrotasks()

    expect(mockHost).toHaveBeenCalledTimes(1)
    expect(mockHost).toHaveBeenCalledWith('sessions.translateThought', {
      sessionId: 's1',
      entryId: 't1',
      text: original,
      language: 'zh-CN',
    })
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe(translated)

    // Mounting ThoughtEntry or StepCard reuses the cached translation without re-requesting.
    flushSync(() => {
      root!.render(createElement(ThoughtEntry, { sessionId: 's1', entryId: 't1' }))
    })
    expect(findByAttr(container, 'data-markdown')?.textContent).toBe(translated)
    expect(mockHost).toHaveBeenCalledTimes(1)

    flushSync(() => {
      root!.render(
        createElement(StepCard, {
          sessionId: 's1',
          entry: { kind: 'thought', id: 't1', markdown: original, streaming: false },
          projectPath: '/repo',
          labels: {},
          status: 'success',
          time: false,
          icon: null,
        }),
      )
    })
    expect(container.textContent).toContain('检查设置')
    expect(mockHost).toHaveBeenCalledTimes(1)
  })

  it('bounds in-memory cache size and clears session entries cleanly', async () => {
    const requester = vi.fn<ThoughtTranslateRequester>(async ({ text }) => ({
      translation: `T:${text}`,
      agent: 'Claude Code',
    }))
    const store = useThoughtTranslationsStore.getState()
    for (let i = 0; i < MAX_CACHED_THOUGHT_TRANSLATIONS + 10; i++) {
      await store.translate('s1', `e-${i}`, `Thought ${i}`, 'en', requester)
    }
    expect(Object.keys(useThoughtTranslationsStore.getState().records).length).toBeLessThanOrEqual(
      MAX_CACHED_THOUGHT_TRANSLATIONS,
    )
    expect(
      useThoughtTranslationsStore.getState().records[
        thoughtTranslationKey('s1', 'e-0', 'Thought 0', 'en')
      ],
    ).toBeUndefined()

    await store.translate('s2', 'e-keep', 'Keep me', 'en', requester)
    useThoughtTranslationsStore.getState().clearSession('s1')
    expect(Object.keys(useThoughtTranslationsStore.getState().records)).toEqual([
      thoughtTranslationKey('s2', 'e-keep', 'Keep me', 'en'),
    ])
  })
})
