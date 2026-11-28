import {
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StopReason, ThreadEntry, ThreadState, TurnUsage } from '@shared/thread'
import { fullTime } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'

const { mockNowRef } = vi.hoisted(() => {
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        kettu: { platform: 'darwin' },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
  return { mockNowRef: { current: Date.UTC(2026, 10, 26, 14, 6, 0) } }
})

vi.mock('@renderer/lib/use-now', () => ({
  useNow: () => mockNowRef.current,
}))

vi.mock('@renderer/app/actions', () => ({
  forkSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./changes-card', () => ({
  ChangesCard: () => null,
}))

vi.mock('../use-thread', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../use-thread')>()
  return {
    ...actual,
    useEntryAnimation: () => '',
  }
})

const PopoverCtx = createContext<{ open: boolean; onOpenChange?: (open: boolean) => void }>({
  open: false,
})

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({
    open = false,
    onOpenChange,
    children,
  }: {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    children?: ReactNode
  }) => createElement(PopoverCtx.Provider, { value: { open, onOpenChange } }, children),
  PopoverTrigger: ({ render }: { render?: ReactNode }) => {
    const { open, onOpenChange } = useContext(PopoverCtx)
    if (!isValidElement(render)) return render ?? null
    const element = render as ReactElement<{ onClick?: () => void }>
    return cloneElement(element, {
      onClick: () => {
        element.props.onClick?.()
        onOpenChange?.(!open)
      },
    })
  },
  PopoverContent: ({ children }: { children?: ReactNode }) => {
    const { open } = useContext(PopoverCtx)
    return open ? createElement('div', { 'data-slot': 'popover-content' }, children) : null
  },
}))

import { useAgentsStore } from '@renderer/stores/agents'
import { useThreadsStore } from '@renderer/stores/threads'
import { hoverReply } from '../reply-hover'
import { ReplyFooter } from './message-actions'

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
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  addEventListener(): void
  removeEventListener(): void
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
  attributes = new Map<string, string>();
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

function setReplyThread(options: {
  at?: number
  agentId?: 'claude-code' | 'codex' | 'deepseek' | 'opencode'
  end?: { stopReason: StopReason; durationMs: number; usage?: TurnUsage } | null
}): void {
  const entries: ThreadEntry[] = [
    {
      kind: 'agent',
      id: 'a1',
      markdown: 'All done.',
      attachments: [],
      streaming: false,
      ...(options.at !== undefined ? { at: options.at } : {}),
    },
  ]
  if (options.end) {
    entries.push({
      kind: 'turn_end',
      id: 'e1',
      stopReason: options.end.stopReason,
      durationMs: options.end.durationMs,
      ...(options.end.usage ? { usage: options.end.usage } : {}),
    })
  }
  const state: ThreadState = {
    session: {
      id: 's1',
      agentId: options.agentId ?? 'claude-code',
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

function clickNode(node: FakeNode): void {
  const propsKey = Object.keys(node).find((k) => k.startsWith('__reactProps$'))
  if (!propsKey) throw new Error('Expected React props on clicked node')
  const props = node[propsKey] as { onClick?: () => void }
  if (typeof props.onClick !== 'function') throw new Error('Expected onClick handler on node')
  flushSync(() => {
    props.onClick!()
  })
}

describe('ReplyFooter Option 1 hover merged metadata (#2951)', () => {
  const completedAt = Date.UTC(2026, 10, 26, 14, 3, 0)
  let root: Root | null = null
  let container: FakeNode
  let prevGlobals: Record<string, unknown>

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    hoverReply(null)
    mockNowRef.current = completedAt + 3 * 60_000
    useThreadsStore.setState({ replicas: {} })
    useAgentsStore.setState({
      byId: {
        'claude-code': {
          id: 'claude-code',
          name: 'Claude',
          capabilities: { fork: true, forkAtMessage: true },
        },
      } as never,
    })

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

  afterEach(async () => {
    hoverReply(null)
    if (root) {
      flushSync(() => root!.unmount())
      root = null
    }
    for (const [key, value] of Object.entries(prevGlobals)) {
      if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
      else (globalThis as Record<string, unknown>)[key] = value
    }
    await i18n.changeLanguage('en')
  })

  function renderFooter(endId: string | null = 'e1'): void {
    flushSync(() => {
      root!.render(
        createElement(ReplyFooter, {
          replyKey: 'reply:u1',
          sessionId: 's1',
          projectPath: '/repo',
          agentIds: ['a1'],
          toolIds: [],
          endId,
          latest: true,
        }),
      )
    })
  }

  it('keeps the footer quiet at rest and merges timestamp + duration inline on hover in English and Chinese', async () => {
    setReplyThread({ at: completedAt, end: { stopReason: 'end_turn', durationMs: 33_000 } })
    renderFooter('e1')

    const foot = findAll(container, (n) => hasClass(n, 'ks-reply-foot'))[0]!
    // No persistent duration sibling outside the hover-revealed actions container.
    expect(findAll(container, (n) => hasClass(n, 'ks-reply-foot__duration'))).toHaveLength(0)
    expect(foot.getAttribute('data-has-duration')).toBeNull()
    expect(foot.getAttribute('data-shown')).toBeNull()

    // Hovering the reply reveals actions and merged metadata on the same row.
    flushSync(() => hoverReply('reply:u1'))
    expect(foot.getAttribute('data-shown')).toBe('')

    const actionsWrap = findAll(foot, (n) => hasClass(n, 'ks-reply-foot__actions'))[0]!
    const meta = findAll(actionsWrap, (n) => hasClass(n, 'ks-reply-foot__meta'))[0]!
    expect(meta.textContent).toBe('3 min ago · Worked for 33s')
    expect(meta.getAttribute('title')).toBe(`Worked for 33s · Completed ${fullTime(completedAt)}`)

    // Verify Simplified Chinese localization too.
    await i18n.changeLanguage('zh-CN')
    renderFooter('e1')
    const zhMeta = findAll(container, (n) => hasClass(n, 'ks-reply-foot__meta'))[0]!
    expect(zhMeta.textContent).toBe('3 分钟前 · 用时 33 秒')
    expect(zhMeta.getAttribute('title')).toBe(`用时 33 秒 · 完成于 ${fullTime(completedAt)}`)
  })

  it('shows only relative time for legacy replies without duration, and only duration when timestamp is absent', () => {
    setReplyThread({ at: completedAt, end: null })
    renderFooter(null)
    const timeOnly = findAll(container, (n) => hasClass(n, 'ks-reply-foot__meta'))[0]!
    expect(timeOnly.textContent).toBe('3 min ago')
    expect(timeOnly.textContent).not.toContain('·')
    expect(timeOnly.getAttribute('title')).toBe(fullTime(completedAt))

    setReplyThread({ at: undefined, end: { stopReason: 'end_turn', durationMs: 33_000 } })
    renderFooter('e1')
    const durationOnly = findAll(container, (n) => hasClass(n, 'ks-reply-foot__meta'))[0]!
    expect(durationOnly.textContent).toBe('Worked for 33s')
    expect(durationOnly.textContent).not.toContain('·')
    expect(durationOnly.getAttribute('title')).toBe('Worked for 33s')
  })

  it('keeps abnormal TurnEndTag persistently visible without duplicating duration in the hover metadata', () => {
    setReplyThread({ at: completedAt, end: { stopReason: 'cancelled', durationMs: 12_000 } })
    renderFooter('e1')

    const foot = findAll(container, (n) => hasClass(n, 'ks-reply-foot'))[0]!
    expect(foot.getAttribute('data-shown')).toBeNull()
    // TurnEndTag stays persistently rendered outside ks-reply-foot.
    expect(container.textContent).toContain('Cancelled · 12s')
    const meta = findAll(foot, (n) => hasClass(n, 'ks-reply-foot__meta'))[0]!
    expect(meta.textContent).toBe('3 min ago')
  })

  it('omits cost trigger when a turn has no usage data', () => {
    setReplyThread({ at: completedAt, end: { stopReason: 'end_turn', durationMs: 33_000 } })
    renderFooter('e1')
    expect(findAll(container, (n) => hasClass(n, 'ks-reply-foot__cost'))).toHaveLength(0)
  })

  it('renders cost beside time, keeps footer shown while popover is open, and displays multi-model breakdown + subscription notice in en and zh-CN', async () => {
    const usage: TurnUsage = {
      models: [
        {
          model: 'claude-sonnet-4-6',
          input: 1000,
          output: 500,
          cacheRead: 8000,
          cacheWrite: 1000,
          costUsd: 0.038,
        },
        {
          model: 'claude-haiku-4-5',
          input: 400,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0.004,
        },
      ],
      costUsd: 0.042,
      subscription: true,
      pricesAsOf: '2026-11-25',
    }
    setReplyThread({
      at: completedAt,
      end: { stopReason: 'end_turn', durationMs: 33_000, usage },
    })
    renderFooter('e1')

    const foot = findAll(container, (n) => hasClass(n, 'ks-reply-foot'))[0]!
    const trigger = findAll(foot, (n) => hasClass(n, 'ks-reply-foot__cost'))[0]!
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.textContent).toBe('~$0.042')
    expect(foot.getAttribute('data-shown')).toBeNull()
    expect(
      findAll(container, (n) => n.getAttribute('data-testid') === 'turn-usage-popover'),
    ).toHaveLength(0)

    // Hover and click cost trigger to open the popover.
    flushSync(() => hoverReply('reply:u1'))
    clickNode(trigger)

    // Leaving hover must keep the footer visible while the popover stays open.
    flushSync(() => hoverReply(null))
    expect(foot.getAttribute('data-shown')).toBe('')
    expect(trigger.getAttribute('data-open')).toBe('')

    const popover = findAll(
      container,
      (n) => n.getAttribute('data-testid') === 'turn-usage-popover',
    )[0]!
    const models = findAll(popover, (n) => n.getAttribute('data-testid') === 'turn-usage-model')
    expect(models).toHaveLength(2)
    expect(popover.textContent).toContain('Turn usage')
    expect(popover.textContent).toContain('2 models')
    expect(popover.textContent).toContain('~$0.042')
    expect(popover.textContent).toContain('claude-sonnet-4-6')
    expect(popover.textContent).toContain('claude-haiku-4-5')
    expect(popover.textContent).toContain('Input')
    expect(popover.textContent).toContain('Output')
    expect(popover.textContent).toContain('Cache read')
    expect(popover.textContent).toContain('Cache write')
    expect(popover.textContent).toContain('Cache hit rate')
    expect(popover.textContent).toContain('80%')
    expect(popover.textContent).toContain('0%')
    expect(
      findAll(popover, (n) => n.getAttribute('data-testid') === 'turn-usage-subscription-note')[0]!
        .textContent,
    ).toBe('Estimate at API prices, not a charge on your subscription.')

    // Verify Simplified Chinese localization inside the open popover.
    await i18n.changeLanguage('zh-CN')
    renderFooter('e1')
    const zhPopover = findAll(
      container,
      (n) => n.getAttribute('data-testid') === 'turn-usage-popover',
    )[0]!
    expect(zhPopover.textContent).toContain('本轮用量')
    expect(zhPopover.textContent).toContain('2 个模型')
    expect(zhPopover.textContent).toContain('输入')
    expect(zhPopover.textContent).toContain('输出')
    expect(zhPopover.textContent).toContain('缓存读取')
    expect(zhPopover.textContent).toContain('缓存写入')
    expect(zhPopover.textContent).toContain('缓存命中率')
    expect(
      findAll(
        zhPopover,
        (n) => n.getAttribute('data-testid') === 'turn-usage-subscription-note',
      )[0]!.textContent,
    ).toBe('按 API 价格估算，非实际扣费。')

    // Clicking again closes the popover and returns the footer to quiet state.
    const latestTrigger = findAll(container, (n) => hasClass(n, 'ks-reply-foot__cost'))[0]!
    clickNode(latestTrigger)
    expect(
      findAll(container, (n) => n.getAttribute('data-testid') === 'turn-usage-popover'),
    ).toHaveLength(0)
    expect(
      findAll(container, (n) => hasClass(n, 'ks-reply-foot'))[0]!.getAttribute('data-shown'),
    ).toBeNull()
  })

  it('shows exact API cost without subscription notice for API-billed turns and handles zero-input cache hit rate', () => {
    const usage: TurnUsage = {
      models: [
        {
          model: 'gpt-5.4',
          input: 0,
          output: 250,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0.0025,
        },
      ],
      costUsd: 0.0025,
      subscription: false,
    }
    setReplyThread({
      at: completedAt,
      agentId: 'codex',
      end: { stopReason: 'end_turn', durationMs: 5_000, usage },
    })
    renderFooter('e1')

    const trigger = findAll(container, (n) => hasClass(n, 'ks-reply-foot__cost'))[0]!
    expect(trigger.textContent).toBe('$0.0025')
    expect(trigger.textContent).not.toContain('~')

    clickNode(trigger)
    const popover = findAll(
      container,
      (n) => n.getAttribute('data-testid') === 'turn-usage-popover',
    )[0]!
    expect(
      findAll(popover, (n) => n.getAttribute('data-testid') === 'turn-usage-subscription-note'),
    ).toHaveLength(0)
    expect(popover.textContent).toContain('—')
    expect(popover.textContent).not.toContain('NaN')
  })

  it('never fabricates $0.00 when model pricing is unavailable and shows token summary trigger instead', () => {
    const usage: TurnUsage = {
      models: [
        {
          model: 'local-unpriced-model',
          input: 2000,
          output: 500,
          cacheRead: 1000,
          cacheWrite: 0,
          costUsd: null,
        },
      ],
      costUsd: null,
    }
    setReplyThread({
      at: completedAt,
      end: { stopReason: 'end_turn', durationMs: 8_000, usage },
    })
    renderFooter('e1')

    const trigger = findAll(container, (n) => hasClass(n, 'ks-reply-foot__cost'))[0]!
    expect(trigger.textContent).toBe('3.5K tokens')
    expect(trigger.textContent).not.toContain('$0.00')

    clickNode(trigger)
    const popover = findAll(
      container,
      (n) => n.getAttribute('data-testid') === 'turn-usage-popover',
    )[0]!
    expect(popover.textContent).toContain('No price')
    expect(popover.textContent).toContain(
      'No API pricing is available for the model used in this turn.',
    )
    expect(popover.textContent).not.toContain('$0.00')
  })

  it('infers subscription status from current agent account for legacy hydrated turns lacking subscription flag', () => {
    useAgentsStore.setState({
      byId: {
        'claude-code': {
          id: 'claude-code',
          name: 'Claude',
          account: { kind: 'account', label: 'Claude Max', email: 'dev@example.com' },
          limits: [],
          capabilities: { fork: true, forkAtMessage: true },
        },
      } as never,
    })
    const legacyUsage: TurnUsage = {
      models: [
        {
          model: 'claude-sonnet-4-6',
          input: 1000,
          output: 200,
          cacheRead: 3000,
          cacheWrite: 0,
          costUsd: 0.015,
        },
      ],
      costUsd: 0.015,
    }
    setReplyThread({
      at: completedAt,
      end: { stopReason: 'end_turn', durationMs: 12_000, usage: legacyUsage },
    })
    renderFooter('e1')

    const trigger = findAll(container, (n) => hasClass(n, 'ks-reply-foot__cost'))[0]!
    expect(trigger.textContent).toBe('~$0.015')
    clickNode(trigger)
    const note = findAll(
      container,
      (n) => n.getAttribute('data-testid') === 'turn-usage-subscription-note',
    )[0]!
    expect(note.textContent).toBe('Estimate at API prices, not a charge on your subscription.')
  })

  it('shows partial cost notice when a multi-model turn mixes priced and unpriced models', () => {
    const usage: TurnUsage = {
      models: [
        {
          model: 'claude-sonnet-4-6',
          input: 1000,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0.012,
        },
        {
          model: 'custom-unpriced',
          input: 500,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: null,
        },
      ],
      costUsd: 0.012,
      partialCost: true,
      subscription: false,
    }
    setReplyThread({
      at: completedAt,
      end: { stopReason: 'end_turn', durationMs: 10_000, usage },
    })
    renderFooter('e1')

    const trigger = findAll(container, (n) => hasClass(n, 'ks-reply-foot__cost'))[0]!
    expect(trigger.textContent).toBe('$0.012')
    clickNode(trigger)
    const popover = findAll(
      container,
      (n) => n.getAttribute('data-testid') === 'turn-usage-popover',
    )[0]!
    expect(popover.textContent).toContain('Excludes models without API pricing.')
    expect(popover.textContent).toContain('No price')
  })
})
