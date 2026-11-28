import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { FromSession, FromSessionEnded } from '@shared/thread'
import { clockTime, fullTime, monthDayTime } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'

const { mockNowRef, openSessionMock, revealMessageMock } = vi.hoisted(() => {
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
    mockNowRef: { current: new Date(2026, 10, 27, 15, 0, 0).getTime() },
    openSessionMock: vi.fn<(sessionId: string, projectPath: string) => void>(),
    revealMessageMock:
      vi.fn<(target: { sessionId: string; entryId: string; pos: number | null }) => void>(),
  }
})

vi.mock('@renderer/lib/use-now', () => ({
  useClock: <T>(select: (now: number) => T) => select(mockNowRef.current),
  useNow: () => mockNowRef.current,
}))

vi.mock('@renderer/stores/view', () => ({
  openSession: (sessionId: string, projectPath: string) => openSessionMock(sessionId, projectPath),
}))

vi.mock('@renderer/stores/reveal', () => ({
  revealMessage: (target: { sessionId: string; entryId: string; pos: number | null }) =>
    revealMessageMock(target),
}))

import { useSessionsStore } from '@renderer/stores/sessions'
import { QueueReportRow } from '../queue-stack'
import { ReportLine } from './session-origin'
import {
  openSessionReport,
  reportRoundLabel,
  reportTarget,
  reportTime,
  sessionReportDisplay,
} from './session-report'

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
  listeners: Map<string, ((event: FakeEvent) => void)[]>
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  addEventListener(type: string, fn: (event: FakeEvent) => void): void
  removeEventListener(type: string, fn: (event: FakeEvent) => void): void
  dispatchEvent(event: FakeEvent): boolean
  readonly firstChild: FakeNode | null
  readonly lastChild: FakeNode | null
  textContent: string
}

interface FakeEvent {
  type: string
  target?: FakeNode
  bubbles?: boolean
  stopPropagation(): void
  preventDefault(): void
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
  addEventListener(type: string, fn: (event: FakeEvent) => void): void
  removeEventListener(type: string, fn: (event: FakeEvent) => void): void
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
  kettu: { platform: 'darwin' }
}

class FakeNodeBase implements FakeNode {
  nodeType: number
  nodeName: string
  nodeValue?: string
  childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  ownerDocument: FakeDocument | null
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  listeners = new Map<string, ((event: FakeEvent) => void)[]>()

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument | null) {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = ownerDocument
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? ''
    if (this.nodeType === 8) return ''
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (value !== '' && this.ownerDocument) {
      this.appendChild(this.ownerDocument.createTextNode(value))
    }
  }

  setAttribute(name: string, value: string): void {
    const str = String(value)
    this.attributes.set(name, str)
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
      this.dataset[key] = str
    }
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
      delete this.dataset[key]
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  appendChild(child: FakeNode): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (!ref) return this.appendChild(child)
    if (child.parentNode) child.parentNode.removeChild(child)
    const index = this.childNodes.indexOf(ref)
    child.parentNode = this
    if (index < 0) this.childNodes.push(child)
    else this.childNodes.splice(index, 0, child)
    return child
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) {
      this.childNodes.splice(index, 1)
      child.parentNode = null
    }
    return child
  }

  addEventListener(type: string, fn: (event: FakeEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, fn: (event: FakeEvent) => void): void {
    const list = this.listeners.get(type)
    if (!list) return
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }

  dispatchEvent(event: FakeEvent): boolean {
    let stopped = false
    const wrapped: FakeEvent = {
      ...event,
      target: event.target ?? this,
      stopPropagation() {
        stopped = true
        event.stopPropagation()
      },
      preventDefault() {
        event.preventDefault()
      },
    }
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener(wrapped)
    }
    if (!stopped && event.bubbles !== false) {
      let current = this.parentNode
      while (current) {
        for (const listener of [...(current.listeners.get(event.type) ?? [])]) {
          listener(wrapped)
        }
        if (stopped) break
        current = current.parentNode
      }
    }
    return true
  }
}

class FakeElementBase extends FakeNodeBase {
  tagName: string
  namespaceURI: string

  constructor(tag: string, ownerDocument: FakeDocument | null, namespaceURI: string) {
    super(1, tag.toUpperCase(), ownerDocument)
    this.tagName = tag.toUpperCase()
    this.namespaceURI = namespaceURI
  }

  get className(): string {
    return this.getAttribute('class') ?? ''
  }

  set className(value: string) {
    this.setAttribute('class', value)
  }
}

class FakeTextNode extends FakeNodeBase {
  constructor(text: string, ownerDocument: FakeDocument | null) {
    super(3, '#text', ownerDocument)
    this.nodeValue = text
  }
}

class FakeCommentNode extends FakeNodeBase {
  constructor(text: string, ownerDocument: FakeDocument | null) {
    super(8, '#comment', ownerDocument)
    this.nodeValue = text
  }
}

class FakeDocumentBase extends FakeNodeBase implements FakeDocument {
  documentElement: FakeNode
  head: FakeNode
  body: FakeNode
  defaultView!: FakeWindow

  constructor() {
    super(9, '#document', null)
    this.documentElement = this.createElement('html')
    this.head = this.createElement('head')
    this.body = this.createElement('body')
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
  }

  createElement(tag: string): FakeNode {
    return new FakeElementBase(tag, this, 'http://www.w3.org/1999/xhtml')
  }

  createElementNS(ns: string, tag: string): FakeNode {
    return new FakeElementBase(tag, this, ns)
  }

  createTextNode(text: string): FakeNode {
    return new FakeTextNode(text, this)
  }

  createComment(text: string): FakeNode {
    return new FakeCommentNode(text, this)
  }
}

function createFakeDom(): { doc: FakeDocument; win: FakeWindow } {
  const doc = new FakeDocumentBase()
  const win: FakeWindow = {
    document: doc,
    navigator: { userAgent: 'vitest-node' },
    HTMLElement: FakeElementBase,
    SVGElement: FakeElementBase,
    Element: FakeElementBase,
    Node: FakeNodeBase,
    Document: FakeDocumentBase,
    HTMLIFrameElement: FakeElementBase,
    matchMedia: () => ({ matches: false }),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    kettu: { platform: 'darwin' },
  }
  doc.defaultView = win
  return { doc, win }
}

function findAll(root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = []
  const visit = (node: FakeNode): void => {
    if (predicate(node)) out.push(node)
    for (const child of node.childNodes) visit(child)
  }
  visit(root)
  return out
}

function clickNode(node: FakeNode): void {
  const event: FakeEvent = {
    type: 'click',
    target: node,
    bubbles: true,
    stopPropagation() {},
    preventDefault() {},
  }
  node.dispatchEvent(event)
}

function makeSessionSummary(id: string, title: string): SessionSummary {
  return {
    id,
    agentId: 'codex',
    projectPath: '/repo',
    title,
    status: 'ready',
    attention: null,
    origin: 'user',
    parentId: 'parent-1',
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    acpSessionId: null,
    turnStartedAt: null,
    lastTurn: null,
    error: null,
    plan: null,
    routine: null,
    subagent: null,
    worktree: null,
  } as unknown as SessionSummary
}

const savedGlobals: Record<string, unknown> = {}
const GLOBAL_KEYS = [
  'window',
  'document',
  'HTMLElement',
  'SVGElement',
  'Element',
  'Node',
  'Document',
  'HTMLIFrameElement',
] as const

let fakeDoc: FakeDocument
const roots: Root[] = []

function mount(element: ReturnType<typeof createElement>): FakeNode {
  const container = fakeDoc.createElement('div')
  fakeDoc.body.appendChild(container)
  const root = createRoot(container as unknown as Element)
  roots.push(root)
  flushSync(() => {
    root.render(element)
  })
  return container
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  openSessionMock.mockReset()
  revealMessageMock.mockReset()
  mockNowRef.current = new Date(2026, 10, 27, 15, 0, 0).getTime()
  const { doc, win } = createFakeDom()
  fakeDoc = doc
  for (const key of GLOBAL_KEYS) {
    savedGlobals[key] = (globalThis as Record<string, unknown>)[key]
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
  useSessionsStore.setState({
    byId: { 'child-1': makeSessionSummary('child-1', 'Audit auth flow') },
  })
})

afterEach(async () => {
  for (const root of roots.splice(0)) {
    flushSync(() => root.unmount())
  }
  for (const key of GLOBAL_KEYS) {
    const prev = savedGlobals[key]
    if (prev === undefined) delete (globalThis as Record<string, unknown>)[key]
    else (globalThis as Record<string, unknown>)[key] = prev
  }
  await i18n.changeLanguage('en')
})

describe('sessionReportDisplay helpers', () => {
  it('formats round label and local completion time in English and Simplified Chinese', async () => {
    const now = new Date(2026, 10, 27, 15, 0, 0).getTime()
    const sameDay = new Date(2026, 10, 27, 14, 32, 0).getTime()
    const earlierDay = new Date(2026, 10, 26, 9, 15, 0).getTime()

    const endedSameDay: FromSessionEnded = {
      agent: 'Codex',
      stopReason: 'end_turn',
      round: 2,
      completedAt: sameDay,
      entryId: 'e5',
      pos: 4,
    }
    const endedEarlier: FromSessionEnded = {
      agent: 'Codex',
      stopReason: 'end_turn',
      round: 1,
      completedAt: earlierDay,
      entryId: 'e1',
      pos: 0,
    }

    await i18n.changeLanguage('en')
    expect(sessionReportDisplay(endedSameDay, 'Audit auth flow', now)).toEqual({
      sentence: 'Codex finished',
      roundLabel: 'Round 2',
      time: {
        label: clockTime(sameDay),
        title: fullTime(sameDay),
        iso: new Date(sameDay).toISOString(),
      },
      metaLabel: `Round 2 · ${clockTime(sameDay)}`,
      openLabel: 'Open Round 2 in Audit auth flow',
      target: { entryId: 'e5', pos: 4 },
    })
    expect(reportTime(earlierDay, now)?.label).toBe(monthDayTime(earlierDay))

    await i18n.changeLanguage('zh-CN')
    expect(sessionReportDisplay(endedSameDay, '检查鉴权流程', now)).toEqual({
      sentence: 'Codex 做完了',
      roundLabel: '第 2 轮',
      time: {
        label: clockTime(sameDay),
        title: fullTime(sameDay),
        iso: new Date(sameDay).toISOString(),
      },
      metaLabel: `第 2 轮 · ${clockTime(sameDay)}`,
      openLabel: '打开 检查鉴权流程 的第 2 轮',
      target: { entryId: 'e5', pos: 4 },
    })
    expect(reportTime(earlierDay, now)?.label).toBe(monthDayTime(earlierDay))
    expect(sessionReportDisplay(endedEarlier, '检查鉴权流程', now).roundLabel).toBe('第 1 轮')
  })

  it('handles legacy and invalid round/timestamp/anchor fields without bogus text', () => {
    const legacy: FromSessionEnded = { agent: 'Claude Code', stopReason: 'end_turn' }
    const display = sessionReportDisplay(legacy, 'Old task')
    expect(display.roundLabel).toBeNull()
    expect(display.time).toBeNull()
    expect(display.metaLabel).toBeNull()
    expect(display.target).toBeNull()
    expect(display.openLabel).toBe('Open Old task')

    expect(reportRoundLabel(0)).toBeNull()
    expect(reportRoundLabel(-1)).toBeNull()
    expect(reportRoundLabel(1.5)).toBeNull()
    expect(reportRoundLabel(Number.NaN)).toBeNull()

    expect(reportTime(0)).toBeNull()
    expect(reportTime(-100)).toBeNull()
    expect(reportTime(Number.NaN)).toBeNull()
    expect(reportTime(Number.POSITIVE_INFINITY)).toBeNull()

    expect(reportTarget({ agent: 'Codex', stopReason: 'end_turn', entryId: '' })).toBeNull()
    expect(
      reportTarget({ agent: 'Codex', stopReason: 'end_turn', entryId: 'e9', pos: -1 }),
    ).toEqual({ entryId: 'e9', pos: null })
  })

  it('queues reveal before opening the child session only when a target anchor exists', () => {
    const callOrder: string[] = []
    revealMessageMock.mockImplementation(() => callOrder.push('reveal'))
    openSessionMock.mockImplementation(() => callOrder.push('open'))

    openSessionReport(
      { id: 'child-1', projectPath: '/repo' },
      { agent: 'Codex', stopReason: 'end_turn', round: 2, entryId: 'e5', pos: 4 },
    )
    expect(callOrder).toEqual(['reveal', 'open'])
    expect(revealMessageMock).toHaveBeenCalledWith({
      sessionId: 'child-1',
      entryId: 'e5',
      pos: 4,
    })
    expect(openSessionMock).toHaveBeenCalledWith('child-1', '/repo')

    callOrder.length = 0
    revealMessageMock.mockReset()
    openSessionMock.mockReset()
    openSessionReport(
      { id: 'child-1', projectPath: '/repo' },
      { agent: 'Codex', stopReason: 'end_turn' },
    )
    expect(revealMessageMock).not.toHaveBeenCalled()
    expect(openSessionMock).toHaveBeenCalledWith('child-1', '/repo')
  })
})

describe('ReportLine and QueueReportRow consistency', () => {
  const completedAt = new Date(2026, 10, 27, 14, 32, 0).getTime()
  const from: FromSession = {
    sessionId: 'child-1',
    title: 'Fallback title',
    ended: {
      agent: 'Codex',
      stopReason: 'end_turn',
      round: 2,
      completedAt,
      entryId: 'e5',
      pos: 4,
    },
  }

  for (const locale of ['en', 'zh-CN'] as const) {
    it(`renders identical round, timestamp, and jump behavior in thread and queue (${locale})`, async () => {
      await i18n.changeLanguage(locale)
      const threadRoot = mount(createElement(ReportLine, { from, ended: from.ended! }))
      const queueRoot = mount(createElement(QueueReportRow, { from, ended: from.ended! }))

      const expected = sessionReportDisplay(from.ended!, 'Audit auth flow', mockNowRef.current)
      const threadButton = findAll(threadRoot, (node) => node.tagName === 'BUTTON')[0]!
      const queueButton = findAll(queueRoot, (node) => node.tagName === 'BUTTON')[0]!
      const threadTime = findAll(threadRoot, (node) => node.tagName === 'TIME')[0]!
      const queueTime = findAll(queueRoot, (node) => node.tagName === 'TIME')[0]!

      expect(threadRoot.textContent).toContain(expected.sentence)
      expect(queueRoot.textContent).toContain(expected.sentence)
      expect(threadRoot.textContent).toContain(expected.roundLabel!)
      expect(queueRoot.textContent).toContain(expected.roundLabel!)
      expect(threadTime.textContent).toBe(expected.time!.label)
      expect(queueTime.textContent).toBe(expected.time!.label)
      expect(threadTime.getAttribute('dateTime')).toBe(expected.time!.iso)
      expect(queueTime.getAttribute('dateTime')).toBe(expected.time!.iso)
      expect(threadTime.getAttribute('title')).toBe(expected.time!.title)
      expect(queueTime.getAttribute('title')).toBe(expected.time!.title)
      expect(threadButton.getAttribute('aria-label')).toBe(expected.openLabel)
      expect(queueButton.getAttribute('aria-label')).toBe(expected.openLabel)

      clickNode(threadButton)
      expect(revealMessageMock).toHaveBeenLastCalledWith({
        sessionId: 'child-1',
        entryId: 'e5',
        pos: 4,
      })
      expect(openSessionMock).toHaveBeenLastCalledWith('child-1', '/repo')

      revealMessageMock.mockClear()
      openSessionMock.mockClear()

      clickNode(queueButton)
      expect(revealMessageMock).toHaveBeenLastCalledWith({
        sessionId: 'child-1',
        entryId: 'e5',
        pos: 4,
      })
      expect(openSessionMock).toHaveBeenLastCalledWith('child-1', '/repo')
    })
  }

  it('renders legacy reports cleanly without round or time and opens the child session directly', () => {
    const legacyEnded: FromSessionEnded = { agent: 'Claude Code', stopReason: 'end_turn' }
    const legacyFrom: FromSession = {
      sessionId: 'child-1',
      title: 'Fallback title',
      ended: legacyEnded,
    }
    const threadRoot = mount(createElement(ReportLine, { from: legacyFrom, ended: legacyEnded }))
    const queueRoot = mount(createElement(QueueReportRow, { from: legacyFrom, ended: legacyEnded }))

    for (const root of [threadRoot, queueRoot]) {
      expect(root.textContent).toContain('Claude Code finished')
      expect(root.textContent).toContain('Audit auth flow')
      expect(root.textContent).not.toContain('Round')
      expect(root.textContent).not.toContain('Invalid Date')
      expect(findAll(root, (node) => node.tagName === 'TIME')).toEqual([])

      const button = findAll(root, (node) => node.tagName === 'BUTTON')[0]!
      clickNode(button)
    }

    expect(revealMessageMock).not.toHaveBeenCalled()
    expect(openSessionMock).toHaveBeenCalledTimes(2)
    expect(openSessionMock).toHaveBeenCalledWith('child-1', '/repo')
  })

  it('renders static fallback text when the reporting child session is no longer in the store', () => {
    useSessionsStore.setState({ byId: {} })
    const threadRoot = mount(createElement(ReportLine, { from, ended: from.ended! }))
    const queueRoot = mount(createElement(QueueReportRow, { from, ended: from.ended! }))

    for (const root of [threadRoot, queueRoot]) {
      expect(findAll(root, (node) => node.tagName === 'BUTTON')).toEqual([])
      expect(root.textContent).toContain('Fallback title')
      expect(root.textContent).toContain('Round 2')
    }
  })
})
