import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadEntry, ThreadState } from '@shared/thread'
import { i18n } from '@renderer/lib/i18n'

const { hostMock } = vi.hoisted(() => {
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
    hostMock: vi.fn<(...args: unknown[]) => Promise<{ itemId: string | null }>>(),
  }
})

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => hostMock(...args),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

import { useThreadsStore } from '@renderer/stores/threads'
import { canManualResumeUpdate } from './update-resume'
import { UpdateResumeBlockedNotice } from './update-resume-notice'

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
  listeners: Map<string, ((event: unknown) => void)[]>
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  addEventListener(type: string, fn: (event: unknown) => void): void
  removeEventListener(type: string, fn: (event: unknown) => void): void
  dispatchEvent(event: { type: string; target?: unknown }): boolean
  readonly firstChild: FakeNode | null
  readonly lastChild: FakeNode | null
  textContent: string
  disabled: boolean
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
  listeners = new Map<string, ((event: unknown) => void)[]>()
  disabled = false

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument | null) {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = ownerDocument
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
    if (name === 'disabled') this.disabled = true
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
    if (name === 'disabled') this.disabled = false
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
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const index = ref ? this.childNodes.indexOf(ref) : -1
    if (index === -1) this.childNodes.push(child)
    else this.childNodes.splice(index, 0, child)
    return child
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child)
    if (index !== -1) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((item) => item !== fn),
    )
  }

  dispatchEvent(event: { type: string; target?: unknown }): boolean {
    const evt = { ...event, target: event.target ?? this, currentTarget: this }
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(evt)
    if (this.parentNode) this.parentNode.dispatchEvent(evt)
    return true
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? ''
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.childNodes = []
    if (value !== '') {
      const text = new FakeNodeBase(3, '#text', this.ownerDocument)
      text.nodeValue = value
      text.parentNode = this
      this.childNodes.push(text)
    }
  }
}

class FakeElementBase extends FakeNodeBase {
  tagName: string
  namespaceURI: string

  constructor(
    tag: string,
    ownerDocument: FakeDocument,
    namespaceURI = 'http://www.w3.org/1999/xhtml',
  ) {
    super(1, tag.toUpperCase(), ownerDocument)
    this.tagName = tag.toUpperCase()
    this.namespaceURI = namespaceURI
  }
}

class FakeDocumentBase implements FakeDocument {
  nodeType = 9
  nodeName = '#document'
  documentElement: FakeNode
  head: FakeNode
  body: FakeNode
  defaultView!: FakeWindow

  constructor() {
    this.documentElement = new FakeElementBase('html', this)
    this.head = new FakeElementBase('head', this)
    this.body = new FakeElementBase('body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }

  createElement(tag: string): FakeNode {
    return new FakeElementBase(tag, this)
  }

  createElementNS(ns: string, tag: string): FakeNode {
    return new FakeElementBase(tag, this, ns)
  }

  createTextNode(text: string): FakeNode {
    const node = new FakeNodeBase(3, '#text', this)
    node.nodeValue = text
    return node
  }

  createComment(text: string): FakeNode {
    const node = new FakeNodeBase(8, '#comment', this)
    node.nodeValue = text
    return node
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

function findElements(root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (node.nodeType === 1 && predicate(node)) out.push(node)
    for (const child of node.childNodes) walk(child)
  }
  walk(root)
  return out
}

function invokeReactClick(button: FakeNode): void {
  const record = button as unknown as Record<string, unknown>
  const propsKey = Object.keys(record).find((key) => key.startsWith('__reactProps$'))
  const props = propsKey ? (record[propsKey] as { onClick?: (event: unknown) => void }) : undefined
  if (!props?.onClick) throw new Error('Expected React onClick handler on button')
  props.onClick({ preventDefault() {}, stopPropagation() {} })
}

function makeThreadState(
  overrides: {
    status?: ThreadState['session']['status']
    origin?: ThreadState['session']['origin']
    entries?: ThreadEntry[]
  } = {},
): ThreadState {
  const entries: ThreadEntry[] = overrides.entries ?? [
    { kind: 'user', id: 'u1', content: [{ type: 'text', text: 'Work on task' }] },
    {
      kind: 'notice',
      id: 'n1',
      severity: 'warning',
      title: 'Could not resume automatically after update',
      description: 'Project folder missing.',
      cause: 'update_resume_blocked',
      after: 'u1',
    },
  ]
  return {
    session: {
      id: 's1',
      agentId: 'fake-agent',
      projectPath: '/tmp/project',
      acpSessionId: 'acp-1',
      status: overrides.status ?? 'closed',
      title: 'Task',
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 1,
      updatedAt: 2,
      parentId: null,
      origin: overrides.origin ?? 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
    order: entries.map((entry) => entry.id),
    byId: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
  }
}

describe('canManualResumeUpdate', () => {
  it('returns true only for idle top-level user sessions when notice is in the latest turn', () => {
    expect(canManualResumeUpdate(makeThreadState({ status: 'closed' }), 'n1')).toBe(true)
    expect(canManualResumeUpdate(makeThreadState({ status: 'ready' }), 'n1')).toBe(true)
    expect(canManualResumeUpdate(makeThreadState({ status: 'running' }), 'n1')).toBe(false)
    expect(canManualResumeUpdate(makeThreadState({ status: 'awaiting_permission' }), 'n1')).toBe(
      false,
    )
    expect(canManualResumeUpdate(makeThreadState({ origin: 'subagent' }), 'n1')).toBe(false)

    // Once the user sends another turn, the notice is no longer in the latest turn.
    const withNewTurn = makeThreadState({
      status: 'ready',
      entries: [
        { kind: 'user', id: 'u1', content: [{ type: 'text', text: 'First' }] },
        {
          kind: 'notice',
          id: 'n1',
          severity: 'warning',
          title: 'Could not resume',
          cause: 'update_resume_blocked',
          after: 'u1',
        },
        { kind: 'user', id: 'u2', content: [{ type: 'text', text: 'Continue' }] },
      ],
    })
    expect(canManualResumeUpdate(withNewTurn, 'n1')).toBe(false)
  })
})

describe('UpdateResumeBlockedNotice', () => {
  let root: Root | null = null
  let container: FakeNode | null = null

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    hostMock.mockReset()
    const doc = new FakeDocumentBase()
    const win: FakeWindow = {
      document: doc,
      navigator: { userAgent: 'vitest' },
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
    Object.assign(globalThis, {
      window: win,
      document: doc,
      HTMLElement: FakeElementBase,
      SVGElement: FakeElementBase,
      Element: FakeElementBase,
      Node: FakeNodeBase,
    })
    container = doc.createElement('div')
    doc.body.appendChild(container)
    useThreadsStore.setState({ replicas: {} })
  })

  afterEach(() => {
    if (root) {
      flushSync(() => root!.unmount())
      root = null
    }
    useThreadsStore.setState({ replicas: {} })
  })

  function seedThread(thread: ThreadState): void {
    useThreadsStore.setState({
      replicas: {
        s1: {
          state: thread,
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

  it('sends the manual continue prompt when Resume is clicked and displays inline errors on failure', async () => {
    seedThread(makeThreadState({ status: 'closed' }))
    hostMock.mockRejectedValueOnce(new Error('This session is archived'))

    root = createRoot(container as unknown as Element)
    flushSync(() => {
      root!.render(
        createElement(UpdateResumeBlockedNotice, {
          sessionId: 's1',
          entryId: 'n1',
          title: 'Could not resume automatically after update',
          description: 'This session is archived.',
        }),
      )
    })

    const buttons = findElements(container!, (node) => node.tagName === 'BUTTON')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toBe('Resume')

    // First click fails: inline error is rendered and button recovers.
    flushSync(() => invokeReactClick(buttons[0]!))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hostMock).toHaveBeenCalledWith('sessions.queue', {
      sessionId: 's1',
      content: [{ type: 'text', text: 'Continue' }],
    })
    expect(container!.textContent).toContain('This session is archived')

    // Second click succeeds after issue is resolved.
    hostMock.mockResolvedValueOnce({ itemId: null })
    const retryButtons = findElements(container!, (node) => node.tagName === 'BUTTON')
    expect(retryButtons).toHaveLength(1)
    expect(retryButtons[0]!.getAttribute('disabled')).toBeNull()
    flushSync(() => invokeReactClick(retryButtons[0]!))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hostMock).toHaveBeenCalledTimes(2)
  })

  it('hides the manual Resume button while the session is already running', () => {
    seedThread(makeThreadState({ status: 'running' }))
    root = createRoot(container as unknown as Element)
    flushSync(() => {
      root!.render(
        createElement(UpdateResumeBlockedNotice, {
          sessionId: 's1',
          entryId: 'n1',
          title: 'Could not resume automatically after update',
          description: 'Waiting for user.',
        }),
      )
    })
    expect(findElements(container!, (node) => node.tagName === 'BUTTON')).toHaveLength(0)
  })
})
