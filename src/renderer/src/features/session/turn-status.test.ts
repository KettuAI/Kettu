import { createElement, Fragment } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { threadFromSnapshot, type ThreadEntry, type ThreadState } from '@shared/thread'
import enSession from '@shared/locales/en/session.json'
import zhSession from '@shared/locales/zh-CN/session.json'

type LocaleId = 'en' | 'zh-CN'

const { localeRef } = vi.hoisted(() => {
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        kettu: { platform: 'darwin' },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
  return { localeRef: { current: 'zh-CN' as LocaleId } }
})

function lookupKey(dict: Record<string, unknown>, path: string): string | undefined {
  let cur: unknown = dict
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'string' ? cur : undefined
}

function translate(locale: LocaleId, key: string, params?: Record<string, unknown>): string {
  if (key.startsWith('control:')) return key
  const dict = (locale === 'zh-CN' ? zhSession : enSession) as Record<string, unknown>
  const count = typeof params?.count === 'number' ? params.count : undefined
  const resolved =
    (count === 1 ? lookupKey(dict, `${key}_one`) : undefined) ??
    (count !== undefined ? lookupKey(dict, `${key}_other`) : undefined) ??
    lookupKey(dict, key) ??
    key
  if (!params) return resolved
  return resolved.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? ''))
}

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        translate(localeRef.current, key, params),
    }),
  }
})

vi.mock('./markdown', () => ({
  Markdown: ({ markdown }: { markdown: string }) =>
    createElement('div', { className: 'markdown' }, markdown),
}))

import { useBrowserStore } from '@renderer/stores/browser'
import { useDevicesStore } from '@renderer/stores/devices'
import { useTerminalsStore } from '@renderer/stores/terminals'
import { useThreadsStore } from '@renderer/stores/threads'
import { AgentEntry } from './entries/basic'
import { TurnStatus } from './turn-status'

// Minimal DOM implementation so React 19's real client reconciler (including hoisted <style> tags
// and cross-render useState transitions) runs under Vitest's node environment.
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
  listeners: Map<string, Set<(event: unknown) => void>>
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  addEventListener(type: string, fn: (event: unknown) => void): void
  removeEventListener(type: string, fn: (event: unknown) => void): void
  readonly firstChild: FakeNode | null
  readonly lastChild: FakeNode | null
  textContent: string
  [key: string]: unknown
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
  querySelector(selector: string): FakeNode | null
  querySelectorAll(selector: string): FakeNode[]
  addEventListener(type: string, fn: (event: unknown) => void): void
  removeEventListener(type: string, fn: (event: unknown) => void): void
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
  addEventListener(type: string, fn: (event: unknown) => void): void
  removeEventListener(type: string, fn: (event: unknown) => void): void
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
  listeners = new Map<string, Set<(event: unknown) => void>>();
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

  addEventListener(type: string, fn: (event: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(fn)
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(fn)
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

function classListOf(node: FakeNode): string[] {
  const raw =
    (typeof node.className === 'string' ? node.className : null) ?? node.getAttribute('class') ?? ''
  return raw.split(/\s+/).filter(Boolean)
}

function hasClass(node: FakeNode, name: string): boolean {
  return classListOf(node).includes(name)
}

function makeThread(
  entries: ThreadEntry[],
  sessionOverrides: Partial<ThreadState['session']> = {},
): ThreadState {
  return threadFromSnapshot({
    session: {
      id: 'sess-1',
      agentId: 'antigravity',
      projectPath: '/repo',
      acpSessionId: 'acp-1',
      status: 'running',
      title: null,
      config: [],
      commands: [],
      usage: { used: 1_500, size: 100_000, cost: null, tokens: null },
      error: null,
      turnStartedAt: Date.now() - 5_000,
      turnStartUsed: 1_000,
      createdAt: 0,
      updatedAt: 0,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
      ...sessionOverrides,
    },
    entries,
    seq: 1,
  })
}

function setThreadState(
  entries: ThreadEntry[],
  sessionOverrides: Partial<ThreadState['session']> = {},
): void {
  useThreadsStore.setState({
    replicas: {
      'sess-1': {
        state: makeThread(entries, sessionOverrides),
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

const STREAMING_AGENT: ThreadEntry = {
  kind: 'agent',
  id: 'a:1',
  markdown: 'Working through the implementation.',
  attachments: [],
  streaming: true,
}

const ARTIFACT_CARD: ThreadEntry = {
  kind: 'artifact',
  id: 'art:1',
  artifactId: 'art_1',
  title: 'Architecture diagram',
  action: 'create',
  version: 1,
  writes: 1,
  after: 'a:1',
}

const SESSION_STARTED_CARD: ThreadEntry = {
  kind: 'session_started',
  id: 'ss:1',
  sessionId: 'child-session',
  after: 'a:1',
}

const SUBAGENT_CARD: ThreadEntry = {
  kind: 'subagent',
  id: 's:child',
  sessionId: 'child-1',
}

const GIT_CARD: ThreadEntry = {
  kind: 'git',
  id: 'g:1',
  event: 'branch',
  branch: 'fix/turn-status',
  after: 'a:1',
}

const MEMORY_CARD: ThreadEntry = {
  kind: 'memory',
  id: 'm:1',
  layer: 'project',
  action: 'remember',
  memoryId: 'mem-1',
  title: 'Use shared turn-phase rules',
  status: 'written',
  undo: null,
  draft: null,
  after: 'a:1',
}

describe('AgentEntry and TurnStatus unified streaming indicator', () => {
  let root: Root | null = null
  let container: FakeNode
  let prevGlobals: Record<string, unknown>

  beforeEach(() => {
    localeRef.current = 'zh-CN'
    useThreadsStore.setState({ replicas: {} })
    useBrowserStore.setState({ bySession: {} })
    useDevicesStore.setState({ devices: [] })
    useTerminalsStore.setState({ byId: {}, order: {} })

    const { window: win, document: doc } = createFakeDom()
    prevGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      SVGElement: globalThis.SVGElement,
      Element: globalThis.Element,
      Node: globalThis.Node,
      Document: globalThis.Document,
      HTMLIFrameElement: globalThis.HTMLIFrameElement,
    }
    Object.assign(globalThis, {
      window: win,
      document: doc,
      HTMLElement: win.HTMLElement,
      SVGElement: win.SVGElement,
      Element: win.Element,
      Node: win.Node,
      Document: win.Document,
      HTMLIFrameElement: win.HTMLIFrameElement,
    })
    container = doc.createElement('div')
    doc.body.appendChild(container)
    root = createRoot(container as unknown as HTMLElement)
  })

  afterEach(() => {
    if (root) {
      flushSync(() => root!.unmount())
      root = null
    }
    for (const [key, value] of Object.entries(prevGlobals)) {
      if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
      else (globalThis as Record<string, unknown>)[key] = value
    }
  })

  function renderTurn(showStatus = true): void {
    flushSync(() => {
      root!.render(
        createElement(
          Fragment,
          null,
          createElement(AgentEntry, { sessionId: 'sess-1', entryId: 'a:1' }),
          showStatus ? createElement(TurnStatus, { sessionId: 'sess-1', afterSent: false }) : null,
        ),
      )
    })
  }

  function answerRoot(): FakeNode | undefined {
    return findAll(container, (n) => hasClass(n, 'ui-ansc'))[0]
  }

  function answerLabelNode(): FakeNode | undefined {
    return findAll(container, (n) => hasClass(n, 'ui-ansc__label-text'))[0]
  }

  function answerLabelText(): string {
    return answerLabelNode()?.textContent ?? ''
  }

  function statusRoot(): FakeNode | undefined {
    return findAll(container, (n) => hasClass(n, 'ks-status'))[0]
  }

  function statusLabel(): FakeNode | undefined {
    return findAll(container, (n) => hasClass(n, 'ks-status__label'))[0]
  }

  it('keeps AIAnswer streaming and suppresses TurnStatus when artifact, session_started, git, or memory cards follow', () => {
    setThreadState([STREAMING_AGENT])
    renderTurn()

    expect(answerRoot()?.getAttribute('data-phase')).toBe('writing')
    expect(answerLabelText()).toBe('正在回复')
    expect(answerLabelNode()?.getAttribute('data-text')).toBe('正在回复')
    expect(statusRoot()).toBeUndefined()

    for (const card of [ARTIFACT_CARD, SESSION_STARTED_CARD, GIT_CARD, MEMORY_CARD]) {
      flushSync(() => {
        setThreadState([STREAMING_AGENT, card])
      })
      expect(answerRoot()?.getAttribute('data-phase')).toBe('writing')
      expect(answerLabelText()).toBe('正在回复')
      expect(answerLabelNode()?.getAttribute('data-text')).toBe('正在回复')
      expect(statusRoot()).toBeUndefined()
    }
  })

  it('hands off cleanly to shimmer TurnStatus without flashing English "Answer" on subagent, tool, thinking, and turn completion', () => {
    setThreadState([STREAMING_AGENT])
    renderTurn()
    expect(answerRoot()?.getAttribute('data-phase')).toBe('writing')
    expect(answerLabelText()).toBe('正在回复')

    // Subagent card follows: AIAnswer fades out keeping localized label, TurnStatus takes over with Working + shimmer.
    flushSync(() => {
      setThreadState([STREAMING_AGENT, SUBAGENT_CARD])
    })
    expect(answerRoot()?.getAttribute('data-phase')).toBe('done')
    expect(answerLabelText()).toBe('正在回复')
    expect(answerLabelNode()?.getAttribute('data-text')).toBe('正在回复')
    expect(answerLabelText()).not.toContain('Answer')
    expect(statusRoot()).toBeDefined()
    expect(statusLabel()?.textContent).toBe('处理中')
    expect(statusLabel()?.getAttribute('data-text')).toBe('处理中')
    expect(hasClass(statusLabel()!, 'ks-status__label--shimmer')).toBe(true)

    // Tool running: TurnStatus reports the tool phase with shimmer, never falling back to writing.
    const readTool: ThreadEntry = {
      kind: 'tool',
      id: 't:1',
      title: 'Read file',
      toolKind: 'read',
      status: 'in_progress',
      content: [],
      locations: [],
      permission: null,
      permissionResult: null,
    }
    flushSync(() => {
      setThreadState([STREAMING_AGENT, readTool])
    })
    expect(answerRoot()?.getAttribute('data-phase')).toBe('done')
    expect(statusLabel()?.textContent).toBe('正在读取 1 个文件')
    expect(hasClass(statusLabel()!, 'ks-status__label--shimmer')).toBe(true)

    // Thinking: TurnStatus shows Thinking with shimmer.
    const thought: ThreadEntry = {
      kind: 'thought',
      id: 'th:1',
      markdown: 'Checking edge cases',
      streaming: true,
    }
    flushSync(() => {
      setThreadState([STREAMING_AGENT, thought])
    })
    expect(statusLabel()?.textContent).toBe('正在思考')
    expect(hasClass(statusLabel()!, 'ks-status__label--shimmer')).toBe(true)

    // Waiting for permission: TurnStatus shows the attention dot without shimmer.
    const askTool: ThreadEntry = {
      ...readTool,
      id: 't:ask',
      status: 'pending',
      permission: {
        requestId: 'req-1',
        options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }],
        risky: false,
      },
    }
    flushSync(() => {
      setThreadState([STREAMING_AGENT, askTool], { status: 'awaiting_permission' })
    })
    expect(findAll(container, (n) => hasClass(n, 'ks-status__attn')).length).toBe(1)
    expect(statusLabel()?.textContent).toBe('等待你的授权')
    expect(hasClass(statusLabel()!, 'ks-status__label--shimmer')).toBe(false)

    // Turn ends: no TurnStatus mounted, AgentEntry stays localized and never flashes "Answer".
    flushSync(() => {
      setThreadState([{ ...STREAMING_AGENT, streaming: false }], { status: 'ready' })
    })
    renderTurn(false)
    expect(answerRoot()?.getAttribute('data-phase')).toBe('done')
    expect(answerLabelText()).toBe('正在回复')
    expect(answerLabelNode()?.getAttribute('data-text')).toBe('正在回复')
    expect(statusRoot()).toBeUndefined()
  })

  it('never renders unlocalized "Answer" in English or Chinese locales for streaming transitions or settled history', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      localeRef.current = locale
      const expectedWriting = locale === 'zh-CN' ? '正在回复' : 'Writing'

      // 1. Settled entry loaded from history renders an empty label, never "Answer".
      setThreadState([{ ...STREAMING_AGENT, streaming: false }], { status: 'ready' })
      renderTurn(false)
      expect(answerRoot()?.getAttribute('data-phase')).toBe('done')
      expect(answerLabelText()).toBe('')
      expect(answerLabelNode()?.getAttribute('data-text')).toBe('')

      // Unmount and start a fresh streaming reply in the same locale.
      flushSync(() => root!.unmount())
      root = createRoot(container as unknown as HTMLElement)

      setThreadState([STREAMING_AGENT])
      renderTurn(true)
      expect(answerRoot()?.getAttribute('data-phase')).toBe('writing')
      expect(answerLabelText()).toBe(expectedWriting)
      expect(answerLabelNode()?.getAttribute('data-text')).toBe(expectedWriting)

      // Transition to settled: label keeps localized writing text during fade-out, never "Answer".
      flushSync(() => {
        setThreadState([{ ...STREAMING_AGENT, streaming: false }], { status: 'ready' })
      })
      renderTurn(false)
      expect(answerRoot()?.getAttribute('data-phase')).toBe('done')
      expect(answerLabelText()).toBe(expectedWriting)
      expect(answerLabelNode()?.getAttribute('data-text')).toBe(expectedWriting)

      flushSync(() => root!.unmount())
      root = createRoot(container as unknown as HTMLElement)
    }
  })

  it('shows TurnStatus attention prompt when a pending control_ask follows a streaming reply', () => {
    const pendingAsk: ThreadEntry = {
      kind: 'control_ask',
      id: 'ca:1',
      surface: 'browser',
      step: 'sign_in',
      target: 'Tab 1',
      reason: 'Sign in',
      outcome: null,
      after: 'a:1',
    }
    setThreadState([STREAMING_AGENT, pendingAsk])
    renderTurn(true)

    expect(answerRoot()?.getAttribute('data-phase')).toBe('done')
    expect(statusRoot()).toBeDefined()
    expect(findAll(container, (n) => hasClass(n, 'ks-status__attn')).length).toBe(1)
    expect(statusLabel()?.textContent).toBe('control:status.asks.sign_in')
    expect(hasClass(statusLabel()!, 'ks-status__label--shimmer')).toBe(false)
  })
})
