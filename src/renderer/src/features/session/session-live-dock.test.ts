import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { BrowserState } from '@shared/browser'
import type { DeviceInfo } from '@shared/device-host'
import type { ComputerUseView, ThreadEntry, ThreadState } from '@shared/thread'
import enControl from '@shared/locales/en/control.json'
import enSession from '@shared/locales/en/session.json'
import enTerminal from '@shared/locales/en/terminal.json'
import zhControl from '@shared/locales/zh-CN/control.json'
import zhSession from '@shared/locales/zh-CN/session.json'
import zhTerminal from '@shared/locales/zh-CN/terminal.json'

type LocaleId = 'en' | 'zh-CN'

const { localeRef, mocks } = vi.hoisted(() => {
  const mocks = {
    toggleBoard: vi.fn(),
    focusPane: vi.fn(),
    takeOverTerminal: vi.fn(),
    handBackTerminal: vi.fn(),
    revealTerminal: vi.fn(),
    controlDevice: vi.fn(),
    host: vi.fn().mockResolvedValue(undefined),
    browserTakeOver: vi.fn().mockResolvedValue(undefined),
    browserHandBack: vi.fn().mockResolvedValue(undefined),
    browserAnswerAsk: vi.fn().mockResolvedValue(undefined),
  }
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        kettu: {
          platform: 'darwin',
          browser: {
            takeOver: mocks.browserTakeOver,
            handBack: mocks.browserHandBack,
            answerAsk: mocks.browserAnswerAsk,
          },
        },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
  return { localeRef: { current: 'en' as LocaleId }, mocks }
})

const DICTIONARIES = {
  en: { control: enControl, session: enSession, terminal: enTerminal },
  'zh-CN': { control: zhControl, session: zhSession, terminal: zhTerminal },
} as const

function lookupKey(dict: Record<string, unknown>, path: string): string | undefined {
  let cur: unknown = dict
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'string' ? cur : undefined
}

function translate(
  locale: LocaleId,
  defaultNs: 'control' | 'session' | 'terminal',
  rawKey: string,
  params?: Record<string, unknown>,
): string {
  let ns = defaultNs
  let key = rawKey
  const colon = rawKey.indexOf(':')
  if (colon > 0) {
    const prefix = rawKey.slice(0, colon)
    if (prefix === 'control' || prefix === 'session' || prefix === 'terminal') {
      ns = prefix
      key = rawKey.slice(colon + 1)
    }
  }
  const dict = DICTIONARIES[locale][ns] as Record<string, unknown>
  const count = typeof params?.count === 'number' ? params.count : undefined
  const resolved =
    (count === 1 ? lookupKey(dict, `${key}_one`) : undefined) ??
    (count !== undefined ? lookupKey(dict, `${key}_other`) : undefined) ??
    lookupKey(dict, key) ??
    rawKey
  if (!params) return resolved
  return resolved.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? ''))
}

function renderRichTemplate(template: string): ReactNode {
  const parts: ReactNode[] = []
  const re = /<(b|app|i)(?:\s+[^>]*)?>(.*?)<\/\1>/g
  let cursor = 0
  let index = 0
  for (const match of template.matchAll(re)) {
    const start = match.index ?? 0
    if (start > cursor) parts.push(template.slice(cursor, start))
    const tag = match[1] === 'i' ? 'i' : 'b'
    parts.push(createElement(tag, { key: index++ }, match[2]))
    cursor = start + match[0].length
  }
  if (cursor < template.length) parts.push(template.slice(cursor))
  return parts
}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  Trans: ({
    t,
    ns,
    i18nKey,
    values,
  }: {
    t?: (key: string, params?: Record<string, unknown>) => string
    ns?: 'control' | 'session' | 'terminal'
    i18nKey: string
    values?: Record<string, unknown>
  }) => {
    const rendered = t
      ? t(i18nKey, values)
      : translate(localeRef.current, ns ?? 'control', i18nKey, values)
    return createElement('span', null, renderRichTemplate(rendered))
  },
  useTranslation: (ns?: string | string[]) => {
    const first = Array.isArray(ns) ? ns[0] : ns
    const fallback: 'control' | 'session' | 'terminal' =
      first === 'session' || first === 'terminal' ? first : 'control'
    return {
      t: (key: string, params?: Record<string, unknown>) =>
        translate(localeRef.current, fallback, key, params),
    }
  },
}))

vi.mock('@renderer/components/control/use-control-agent', () => ({
  useControlAgent: () => ({ id: 'claude-code', name: 'Claude', dot: null }),
}))

vi.mock('./app-icon', () => ({
  useAppIcon: () => null,
}))

vi.mock('@renderer/features/split/pane-context', () => ({
  usePane: () => null,
}))

vi.mock('@renderer/lib/host', () => ({
  errorMessage: (error: unknown) => String(error),
  host: mocks.host,
}))

vi.mock('@renderer/stores/view', () => ({
  focusPane: mocks.focusPane,
  toggleBoard: mocks.toggleBoard,
}))

vi.mock('@renderer/stores/devices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/devices')>()
  return {
    ...actual,
    controlDevice: mocks.controlDevice,
  }
})

vi.mock('@renderer/stores/terminals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/terminals')>()
  return {
    ...actual,
    takeOverTerminal: mocks.takeOverTerminal,
    handBackTerminal: mocks.handBackTerminal,
    revealTerminal: mocks.revealTerminal,
  }
})

import { useBrowserStore } from '@renderer/stores/browser'
import { useDevicesStore } from '@renderer/stores/devices'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useTerminalsStore, type TerminalState } from '@renderer/stores/terminals'
import { useThreadsStore } from '@renderer/stores/threads'
import { buildDockEntries, reconcilePopoverState } from './live-dock-model'
import { SessionLiveDock } from './session-live-dock'

interface FakeEvent {
  type: string
  target: FakeNode | null
  currentTarget: FakeNode | FakeDocument | null
  bubbles: boolean
  cancelable: boolean
  defaultPrevented: boolean
  propagationStopped: boolean
  key?: string
  repeat?: boolean
  button?: number
  preventDefault(): void
  stopPropagation(): void
}

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
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  addEventListener(type: string, fn: (event: FakeEvent) => void, capture?: boolean): void
  removeEventListener(type: string, fn: (event: FakeEvent) => void, capture?: boolean): void
  contains(other: unknown): boolean
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
  captureListeners: Map<string, Set<(event: FakeEvent) => void>>
  bubbleListeners: Map<string, Set<(event: FakeEvent) => void>>
  createElement(tag: string): FakeNode
  createElementNS(ns: string, tag: string): FakeNode
  createTextNode(text: string): FakeNode
  createComment(text: string): FakeNode
  querySelector(): FakeNode | null
  querySelectorAll(): FakeNode[]
  addEventListener(type: string, fn: (event: FakeEvent) => void, capture?: boolean): void
  removeEventListener(type: string, fn: (event: FakeEvent) => void, capture?: boolean): void
  dispatch(type: string, init?: Partial<FakeEvent>): FakeEvent
}

interface FakeWindow {
  document: FakeDocument
  navigator: { userAgent: string }
  kettu: {
    platform: string
    browser: {
      takeOver: typeof mocks.browserTakeOver
      handBack: typeof mocks.browserHandBack
      answerAsk: typeof mocks.browserAnswerAsk
    }
  }
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
  listeners = new Map<string, Set<(event: FakeEvent) => void>>()
  captureListeners = new Map<string, Set<(event: FakeEvent) => void>>();
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

  addEventListener(type: string, fn: (event: FakeEvent) => void, capture = false): void {
    const map = capture ? this.captureListeners : this.listeners
    let set = map.get(type)
    if (!set) {
      set = new Set()
      map.set(type, set)
    }
    set.add(fn)
  }

  removeEventListener(type: string, fn: (event: FakeEvent) => void, capture = false): void {
    const map = capture ? this.captureListeners : this.listeners
    map.get(type)?.delete(fn)
  }

  contains(other: unknown): boolean {
    let cur = other as FakeNode | null
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
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

function makeFakeEvent(
  type: string,
  target: FakeNode | null,
  init: Partial<FakeEvent> = {},
): FakeEvent {
  const event: FakeEvent = {
    type,
    target,
    currentTarget: target,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    propagationStopped: false,
    button: 0,
    ...init,
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {
      event.propagationStopped = true
    },
  }
  return event
}

function dispatchDomEvent(node: FakeNode, type: string, init: Partial<FakeEvent> = {}): FakeEvent {
  const event = makeFakeEvent(type, node, init)
  const doc = node.ownerDocument
  const path: FakeNode[] = []
  for (let cur: FakeNode | null = node; cur; cur = cur.parentNode) path.push(cur)

  if (doc) {
    for (const fn of [...(doc.captureListeners.get(type) ?? [])]) {
      event.currentTarget = doc
      fn(event)
      if (event.propagationStopped) return event
    }
  }
  for (let i = path.length - 1; i >= 0; i--) {
    const cur = path[i] as FakeDomNode
    for (const fn of [...(cur.captureListeners.get(type) ?? [])]) {
      event.currentTarget = cur
      fn(event)
      if (event.propagationStopped) return event
    }
  }
  for (let i = 0; i < path.length; i++) {
    const cur = path[i] as FakeDomNode
    for (const fn of [...(cur.listeners.get(type) ?? [])]) {
      event.currentTarget = cur
      fn(event)
      if (event.propagationStopped) return event
    }
  }
  if (doc) {
    for (const fn of [...(doc.bubbleListeners.get(type) ?? [])]) {
      event.currentTarget = doc
      fn(event)
      if (event.propagationStopped) return event
    }
  }
  return event
}

function clickNode(node: FakeNode | undefined): void {
  if (!node) throw new Error('Expected node to click')
  flushSync(() => {
    dispatchDomEvent(node, 'pointerdown')
    dispatchDomEvent(node, 'click')
  })
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
    captureListeners: new Map(),
    bubbleListeners: new Map(),
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
    addEventListener(type: string, fn: (event: FakeEvent) => void, capture = false) {
      const map = capture ? doc.captureListeners : doc.bubbleListeners
      let set = map.get(type)
      if (!set) {
        set = new Set()
        map.set(type, set)
      }
      set.add(fn)
    },
    removeEventListener(type: string, fn: (event: FakeEvent) => void, capture = false) {
      const map = capture ? doc.captureListeners : doc.bubbleListeners
      map.get(type)?.delete(fn)
    },
    dispatch(type: string, init: Partial<FakeEvent> = {}) {
      const target = init.target ?? doc.body
      return dispatchDomEvent(target, type, init)
    },
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
    kettu: {
      platform: 'darwin',
      browser: {
        takeOver: mocks.browserTakeOver,
        handBack: mocks.browserHandBack,
        answerAsk: mocks.browserAnswerAsk,
      },
    },
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

function makeTerminal(
  id: string,
  name: string,
  overrides: Partial<TerminalState> = {},
): TerminalState {
  return {
    id,
    projectPath: '/repo',
    sessionId: 's1',
    shell: 'zsh',
    title: name,
    name,
    namedBy: 'agent',
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    busy: true,
    exitCode: null,
    owner: { sessionId: 's1', agentId: 'claude-code' },
    agentAllowed: true,
    control: { kind: 'agent', acting: false },
    waiting: null,
    activity: false,
    stale: false,
    localUrl: null,
    ...overrides,
  }
}

function makeBrowser(control: BrowserState['control']): BrowserState {
  return {
    sessionId: 's1',
    tabs: [
      {
        id: 'tab-1',
        url: 'http://localhost:3000',
        title: 'App',
        loading: false,
        released: false,
        opener: null,
        by: 'agent',
        allowed: true,
      },
    ],
    selected: 'tab-1',
    agentTab: 'tab-1',
    url: 'http://localhost:3000',
    page: true,
    viewport: null,
    agentUsed: true,
    title: 'App',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    notice: null,
    control,
    originRequest: null,
  }
}

function makeSessionSummary(stillRunning: SessionSummary['stillRunning']): SessionSummary {
  return {
    id: 's1',
    agentId: 'claude-code',
    projectPath: '/repo',
    scratch: false,
    title: 'Session',
    status: 'ready',
    phase: 'waiting_background',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    origin: 'user',
    routine: null,
    description: null,
    missing: false,
    branch: null,
    pr: null,
    cache: null,
    model: null,
    pinnedAt: null,
    archivedAt: null,
    acpSessionId: null,
    stillRunning,
  }
}

function makeThreadReplica(entries: ThreadEntry[] = []): {
  state: ThreadState
  seq: number
  status: 'ready'
  error: null
  older: null
  loadingOlder: false
  olderFailure: null
  plan: null
} {
  return {
    state: {
      session: {
        id: 's1',
        agentId: 'claude-code',
        projectPath: '/repo',
        acpSessionId: null,
        status: 'ready',
        title: 'Session',
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
      order: entries.map((entry) => entry.id),
      byId: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
    },
    seq: 1,
    status: 'ready',
    error: null,
    older: null,
    loadingOlder: false,
    olderFailure: null,
    plan: null,
  }
}

describe('live-dock-model priority, folding, and reconciliation (#2951)', () => {
  it('orders P1 -> P5 strictly, keeps P1 ungrouped, and folds >= 2 same-state P4 terminals and devices', () => {
    const entries = buildDockEntries({
      computer: {
        app: 'Figma',
        appPath: '/Applications/Figma.app',
        control: 'agent',
        action: 'act',
      },
      computerWaitingApp: null,
      computerStopping: false,
      browser: { kind: 'you', since: 10 },
      devices: [
        { id: 'd1', name: 'iPhone 16', control: { kind: 'agent', acting: true } },
        { id: 'd2', name: 'Pixel 9', control: { kind: 'agent', acting: false } },
      ],
      terminals: [
        {
          id: 't-pw',
          name: 'deploy-prod',
          control: { kind: 'agent', acting: false },
          waiting: 'password',
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `t${i + 1}`,
          name: i === 0 ? 'dev-server' : i === 1 ? 'vitest' : `worker-${i + 1}`,
          control: { kind: 'agent' as const, acting: i === 0 },
          waiting: null,
        })),
      ],
      background: {
        commands: 0,
        subagents: 2,
        monitors: 0,
        scheduled: 0,
        reportsBack: true,
        unnamed: false,
      },
      hasAgent: true,
    })

    expect(entries.map((entry) => `${entry.priority}:${entry.kind}`)).toEqual([
      '1:terminal-password',
      '2:computer-agent',
      '3:browser-you',
      '4:device-group',
      '4:terminal-group',
      '5:background',
    ])

    const terminalGroup = entries.find((entry) => entry.kind === 'terminal-group')
    expect(terminalGroup?.kind).toBe('terminal-group')
    if (terminalGroup?.kind === 'terminal-group') {
      expect(terminalGroup.items).toHaveLength(10)
      expect(terminalGroup.items.some((item) => item.id === 't-pw')).toBe(false)
    }
  })

  it('keeps a single P4 terminal or device ungrouped and prioritizes computer waitingApp into P1', () => {
    const entries = buildDockEntries({
      computer: { app: 'Xcode', appPath: null, control: 'agent', action: 'act' },
      computerWaitingApp: 'Xcode',
      computerStopping: false,
      browser: {
        kind: 'asks',
        ask: { id: 1, step: 'sign_in', target: 'github.com', reason: 'Sign in' },
      },
      devices: [{ id: 'd1', name: 'iPhone 16', control: { kind: 'agent', acting: false } }],
      terminals: [
        { id: 't1', name: 'dev-server', control: { kind: 'agent', acting: true }, waiting: null },
      ],
      background: null,
      hasAgent: true,
    })

    expect(entries.map((entry) => `${entry.priority}:${entry.kind}`)).toEqual([
      '1:computer-waiting',
      '1:browser-asks',
      '4:device-agent',
      '4:terminal-agent',
    ])
  })

  it('auto-closes the popover when entries shrink to 1 or the primary group leaves', () => {
    const soloBg = buildDockEntries({
      computer: null,
      computerWaitingApp: null,
      computerStopping: false,
      browser: null,
      devices: [],
      terminals: [],
      background: {
        commands: 0,
        subagents: 1,
        monitors: 0,
        scheduled: 0,
        reportsBack: true,
        unnamed: false,
      },
      hasAgent: true,
    })
    expect(reconcilePopoverState('rest', new Set(['terminals']), soloBg)).toEqual({
      mode: null,
      expandedGroups: new Set(),
    })
    expect(reconcilePopoverState('primary-group', new Set(), soloBg)).toEqual({
      mode: null,
      expandedGroups: new Set(),
    })
  })
})

describe('SessionLiveDock UI interactions (#2951)', () => {
  let root: Root | null = null
  let container: FakeNode
  let doc: FakeDocument
  let prevGlobals: Record<string, unknown>

  beforeEach(() => {
    localeRef.current = 'en'
    vi.clearAllMocks()
    useBrowserStore.setState({ bySession: {} })
    useDevicesStore.setState({ devices: [] })
    useTerminalsStore.setState({ byId: {}, order: {}, controls: {} })
    useSessionsStore.setState({ byId: {} })
    useThreadsStore.setState({ replicas: {} })

    const dom = createFakeDom()
    doc = dom.document
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
      window: dom.window,
      document: dom.document,
      HTMLElement: dom.window.HTMLElement,
      SVGElement: dom.window.SVGElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      Document: dom.window.Document,
      HTMLIFrameElement: dom.window.HTMLIFrameElement,
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

  function renderDock(
    props: {
      computerView?: ComputerUseView | null
      showSurfaces?: boolean
      showBackground?: boolean
    } = {},
  ): void {
    flushSync(() => {
      root!.render(
        createElement(SessionLiveDock, {
          sessionId: 's1',
          agentId: 'claude-code',
          hostId: null,
          computerView: props.computerView ?? null,
          showSurfaces: props.showSurfaces ?? true,
          showBackground: props.showBackground ?? true,
          onError: () => undefined,
        }),
      )
    })
  }

  it('renders nothing when no controls or background work are active', () => {
    renderDock()
    expect(container.childNodes).toHaveLength(0)
  })

  it('renders a solo B1 row for a single active item and opens primary-group popover for 10 solo terminals', () => {
    const terms: Record<string, TerminalState> = {}
    const names = ['dev-server', 'vitest', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10']
    names.forEach((name, idx) => {
      const id = `term-${idx + 1}`
      terms[id] = makeTerminal(id, name, {
        createdAt: idx + 1,
        control: { kind: 'agent', acting: idx === 0 },
      })
    })
    useTerminalsStore.setState({ byId: terms, order: { s1: Object.keys(terms) } })
    renderDock()

    const dock = findAll(container, (n) => hasClass(n, 'ks-dock'))[0]
    expect(dock?.getAttribute('data-tier')).toBe('solo')
    expect(findAll(container, (n) => hasClass(n, 'ks-dock__summary'))).toHaveLength(0)

    const primaryBtn = findAll(container, (n) => n.getAttribute('data-group') === 'terminals')[0]
    expect(primaryBtn?.textContent).toContain('10 terminals')
    expect(primaryBtn?.textContent).toContain('dev-server, vitest +8')
    expect(findAll(container, (n) => hasClass(n, 'ks-dock__popover'))).toHaveLength(0)

    // Clicking the solo grouped row opens the upward bounded-scroll list directly.
    clickNode(primaryBtn)
    const popover = findAll(container, (n) => hasClass(n, 'ks-dock__popover'))[0]
    expect(popover?.getAttribute('data-popover-mode')).toBe('primary-group')
    const subItems = findAll(popover!, (n) => hasClass(n, 'ks-dock__subitem'))
    expect(subItems).toHaveLength(10)

    // Taking over a specific terminal from the sub-list dispatches takeOverTerminal with its id.
    const vitestItem = subItems.find((n) => n.getAttribute('data-item-id') === 'term-2')
    const takeOverBtn = findAll(vitestItem!, (n) => hasClass(n, 'ks-dock__subaction'))[0]
    clickNode(takeOverBtn)
    expect(mocks.takeOverTerminal).toHaveBeenCalledWith('term-2')
  })

  it('caps concurrent entries at two tiers, enforces zero duplication in popover, supports direct segment shortcuts, Esc/outside close, and priority promotion', () => {
    const terms: Record<string, TerminalState> = {
      'term-pw': makeTerminal('term-pw', 'deploy-prod', {
        createdAt: 0,
        waiting: 'password',
        control: { kind: 'agent', acting: false },
      }),
    }
    for (let i = 1; i <= 10; i++) {
      const id = `term-${i}`
      terms[id] = makeTerminal(id, i === 1 ? 'dev-server' : i === 2 ? 'vitest' : `worker-${i}`, {
        createdAt: i,
        control: { kind: 'agent', acting: i === 1 },
      })
    }
    useTerminalsStore.setState({ byId: terms, order: { s1: Object.keys(terms) } })
    useBrowserStore.setState({ bySession: { s1: makeBrowser({ kind: 'you', since: 100 }) } })
    useSessionsStore.setState({
      byId: {
        s1: makeSessionSummary({
          commands: 0,
          subagents: 2,
          reportsBack: true,
        }),
      },
    })

    const computerView: ComputerUseView = {
      app: 'Figma',
      appPath: '/Applications/Figma.app',
      control: 'agent',
      action: 'act',
    }
    renderDock({ computerView })

    const dock = findAll(container, (n) => hasClass(n, 'ks-dock'))[0]
    expect(dock?.getAttribute('data-tier')).toBe('capped')

    // Tier 1 holds only P1 terminal password (never folded into the 10-terminal group).
    const primary = findAll(container, (n) => hasClass(n, 'ks-dock__primary'))[0]!
    const primaryRow = findAll(primary, (n) => hasClass(n, 'ks-dock__row'))[0]!
    expect(primaryRow.getAttribute('data-entry-key')).toBe('terminal:password:term-pw')
    expect(primaryRow.getAttribute('data-tone')).toBe('amber')
    expect(primaryRow.textContent).toContain('deploy-prod')

    // Tier 2 shows all remaining categories and exact counts.
    const summary = findAll(container, (n) => hasClass(n, 'ks-dock__summary'))[0]!
    expect(summary.textContent).toContain('Computer · Figma')
    expect(summary.textContent).toContain('Browser held')
    expect(summary.textContent).toContain('10 terminals')
    expect(summary.textContent).toContain('2 sub-agents')

    // Clicking the background segment opens the Board directly without opening the popover.
    const bgSeg = findAll(summary, (n) => n.getAttribute('data-segment') === 'background')[0]
    clickNode(bgSeg)
    expect(mocks.toggleBoard).toHaveBeenCalledWith('s1', true)
    expect(findAll(container, (n) => hasClass(n, 'ks-dock__popover'))).toHaveLength(0)

    // Clicking the 10-terminals segment opens the popover with the terminal group auto-expanded.
    const termSeg = findAll(summary, (n) => n.getAttribute('data-segment') === 'terminals')[0]
    clickNode(termSeg)
    const popover = findAll(container, (n) => hasClass(n, 'ks-dock__popover'))[0]!
    expect(popover.getAttribute('data-popover-mode')).toBe('rest')
    // Zero duplication: Tier 1 password entry must NOT appear inside the popover.
    expect(
      findAll(popover, (n) => n.getAttribute('data-entry-key') === 'terminal:password:term-pw'),
    ).toHaveLength(0)
    // Terminal group is auto-expanded with all 10 terminals listed inside the bounded sublist.
    const termGroupHead = findAll(popover, (n) => n.getAttribute('data-group') === 'terminals')[0]!
    expect(termGroupHead.getAttribute('aria-expanded')).toBe('true')
    expect(findAll(popover, (n) => hasClass(n, 'ks-dock__subitem'))).toHaveLength(10)

    // Pressing Escape closes the popover and stops propagation so session cancel does not fire.
    let escEvent!: FakeEvent
    flushSync(() => {
      escEvent = doc.dispatch('keydown', { key: 'Escape', repeat: false })
    })
    expect(escEvent.defaultPrevented).toBe(true)
    expect(escEvent.propagationStopped).toBe(true)
    expect(findAll(container, (n) => hasClass(n, 'ks-dock__popover'))).toHaveLength(0)

    // Clicking Manage opens the popover with groups collapsed by default.
    const toggleBtn = findAll(summary, (n) => hasClass(n, 'ks-dock__toggle'))[0]!
    clickNode(toggleBtn)
    const reopened = findAll(container, (n) => hasClass(n, 'ks-dock__popover'))[0]!
    const collapsedHead = findAll(reopened, (n) => n.getAttribute('data-group') === 'terminals')[0]!
    expect(collapsedHead.getAttribute('aria-expanded')).toBe('false')
    expect(findAll(reopened, (n) => hasClass(n, 'ks-dock__subitem'))).toHaveLength(0)

    // Clicking inside the popover keeps it open; clicking outside closes it.
    flushSync(() => {
      dispatchDomEvent(collapsedHead, 'pointerdown')
    })
    expect(findAll(container, (n) => hasClass(n, 'ks-dock__popover'))).toHaveLength(1)
    const outside = doc.createElement('div')
    doc.body.appendChild(outside)
    flushSync(() => {
      dispatchDomEvent(outside, 'pointerdown')
    })
    expect(findAll(container, (n) => hasClass(n, 'ks-dock__popover'))).toHaveLength(0)

    // Clicking Type password on Tier 1 reveals the password terminal.
    const pwBtn = findAll(primaryRow, (n) => hasClass(n, 'ks-dock__btn--amber'))[0]!
    clickNode(pwBtn)
    expect(mocks.revealTerminal).toHaveBeenCalledWith('term-pw')

    // Once the P1 password request clears, P2 Computer Use automatically promotes to Tier 1.
    const withoutPw = { ...terms }
    delete withoutPw['term-pw']
    flushSync(() => {
      useTerminalsStore.setState({ byId: withoutPw, order: { s1: Object.keys(withoutPw) } })
    })
    const promotedRow = findAll(
      findAll(container, (n) => hasClass(n, 'ks-dock__primary'))[0]!,
      (n) => hasClass(n, 'ks-dock__row'),
    )[0]!
    expect(promotedRow.getAttribute('data-entry-key')).toBe('computer:agent')
    expect(promotedRow.getAttribute('data-tone')).toBe('computer')

    // Reopen popover, then clear everything except background: dock collapses back to solo and closes popover.
    clickNode(findAll(container, (n) => hasClass(n, 'ks-dock__toggle'))[0]!)
    expect(findAll(container, (n) => hasClass(n, 'ks-dock__popover'))).toHaveLength(1)

    flushSync(() => {
      useTerminalsStore.setState({ byId: {}, order: {} })
      useBrowserStore.setState({ bySession: {} })
    })
    renderDock({ computerView: null })
    expect(findAll(container, (n) => hasClass(n, 'ks-dock'))[0]?.getAttribute('data-tier')).toBe(
      'solo',
    )
    expect(findAll(container, (n) => hasClass(n, 'ks-dock__popover'))).toHaveLength(0)
    expect(findAll(container, (n) => hasClass(n, 'ks-dock__summary'))).toHaveLength(0)
    const soloBgRow = findAll(container, (n) => hasClass(n, 'ks-dock__row'))[0]!
    expect(soloBgRow.getAttribute('data-entry-key')).toBe('background')
    expect(soloBgRow.textContent).toContain('2 sub-agents running')
    expect(soloBgRow.textContent).toContain('Reports back when done')
    expect(soloBgRow.textContent).toContain('Open board')
  })

  it('renders localized Chinese copy and respects showSurfaces / showBackground guards and waitingApp P1', () => {
    localeRef.current = 'zh-CN'
    useThreadsStore.setState({
      replicas: {
        s1: makeThreadReplica([
          {
            kind: 'computer_app',
            id: 'ca:1',
            requestId: 1,
            appId: 'com.apple.Safari',
            appName: 'Safari',
            decision: null,
            after: null,
          },
        ]),
      },
    })
    useDevicesStore.setState({
      devices: [
        {
          id: 'dev-1',
          name: 'iPhone 16',
          platform: 'ios',
          kind: 'simulator',
          state: 'booted',
          sessionId: 's1',
          operator: { sessionId: 's1', control: { kind: 'agent', acting: false } },
        } as unknown as DeviceInfo,
      ],
    })
    useSessionsStore.setState({
      byId: { s1: makeSessionSummary({ commands: 0, subagents: 2, reportsBack: true }) },
    })

    // Subagent/archived guard: showSurfaces=false and showBackground=false still preserves computerView when passed.
    renderDock({
      computerView: { app: 'Safari', appPath: null, control: 'agent', action: 'act' },
      showSurfaces: false,
      showBackground: false,
    })
    expect(findAll(container, (n) => hasClass(n, 'ks-dock'))[0]?.getAttribute('data-tier')).toBe(
      'solo',
    )
    const waitingRow = findAll(container, (n) => hasClass(n, 'ks-dock__row'))[0]!
    expect(waitingRow.getAttribute('data-entry-key')).toBe('computer:waiting')
    expect(waitingRow.getAttribute('data-priority')).toBe('1')
    expect(waitingRow.getAttribute('data-tone')).toBe('amber')
    expect(waitingRow.textContent).toContain('Safari')

    // With all surfaces enabled in zh-CN, Tier 2 displays Chinese summary and 展开 trigger.
    renderDock({
      computerView: { app: 'Safari', appPath: null, control: 'agent', action: 'act' },
      showSurfaces: true,
      showBackground: true,
    })
    const summary = findAll(container, (n) => hasClass(n, 'ks-dock__summary'))[0]!
    expect(summary.textContent).toContain('1 台设备')
    expect(summary.textContent).toContain('2 个子智能体')
    expect(summary.textContent).toContain('展开')
  })
})
