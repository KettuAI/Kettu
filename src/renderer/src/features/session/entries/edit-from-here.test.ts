import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentId } from '@shared/agents'
import type { AgentStatus } from '@shared/agent-host'
import type { ThreadEntry, ThreadState } from '@shared/thread'
import { i18n } from '@renderer/lib/i18n'

const { setupGlobals } = vi.hoisted(() => {
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        kettu: { platform: 'darwin' },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
  return { setupGlobals: true }
})
void setupGlobals

vi.mock('@renderer/app/actions', () => ({
  editFromMessage: vi.fn().mockResolvedValue(undefined),
}))

import { useAgentsStore } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { EditConfirm } from './edit-confirm'
import { editFacts, useEditable } from './edit-from-here'

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
  focus(): void
  blur(): void
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
  focus(): void {}
  blur(): void {}

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
    createElement: (tag: string) => makeNode(tag, 1, doc),
    createElementNS: (ns: string, tag: string) => {
      const node = makeNode(tag, 1, doc)
      node.namespaceURI = ns
      return node
    },
    createTextNode: (text: string) => {
      const node = makeNode('#text', 3, doc)
      node.nodeValue = String(text)
      return node
    },
    createComment: (text: string) => {
      const node = makeNode('#comment', 8, doc)
      node.nodeValue = String(text)
      return node
    },
    querySelector: () => null,
    querySelectorAll: () => [],
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

function agent(id: AgentId, capabilities: Partial<AgentStatus['capabilities']>): AgentStatus {
  return {
    id,
    name: id,
    capabilities: {
      loadSession: false,
      listSessions: false,
      resumeSession: true,
      closeSession: true,
      deleteSession: false,
      forkSession: false,
      forkAtMessage: false,
      steering: false,
      reports: false,
      context: false,
      liveContext: false,
      account: false,
      mcpHttp: null,
      prompt: null,
      ...capabilities,
    },
  } as AgentStatus
}

function threadWith(
  agentId: AgentId,
  entries: ThreadEntry[],
  options: { noRewind?: true } = {},
): ThreadState {
  const state: ThreadState = {
    session: {
      id: 's1',
      agentId,
      projectPath: '/repo',
      acpSessionId: 'native-1',
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
      ...(options.noRewind ? { noRewind: true } : {}),
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
  return state
}

function EditableProbe({ sessionId, entryId }: { sessionId: string; entryId: string }) {
  const editable = useEditable(sessionId, entryId)
  return createElement('span', { 'data-editable': String(editable) }, String(editable))
}

describe('Edit from here eligibility and file-revert confirmation', () => {
  let root: Root | null = null
  let container: FakeNode
  let prevGlobals: Record<string, unknown>

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    useThreadsStore.setState({ replicas: {} })
    useSessionsStore.setState({ byId: {} })
    useAgentsStore.setState({
      byId: {
        'claude-code': agent('claude-code', { rewind: true }),
        pi: agent('pi', { rewind: true }),
        cline: agent('cline', { rewind: true }),
        opencode: agent('opencode', { rewind: true, rewindFiles: true }),
        codex: agent('codex', { rewind: true }),
        antigravity: agent('antigravity', {}),
        deepseek: agent('deepseek', {}),
      },
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

  const renderEditable = (agentId: AgentId, options: { noRewind?: true } = {}): string => {
    threadWith(
      agentId,
      [{ kind: 'user', id: 'u1', content: [{ type: 'text', text: 'hi' }] }],
      options,
    )
    flushSync(() => {
      root!.render(createElement(EditableProbe, { sessionId: 's1', entryId: 'u1' }))
    })
    return container.textContent
  }

  it('shows Edit from here only for drivers declaring native rewind and hides it otherwise', () => {
    expect(renderEditable('claude-code')).toBe('true')
    expect(renderEditable('pi')).toBe('true')
    expect(renderEditable('cline')).toBe('true')
    expect(renderEditable('opencode')).toBe('true')
    expect(renderEditable('codex')).toBe('true')
    // Legacy Codex thread without rewind support stays hidden.
    expect(renderEditable('codex', { noRewind: true })).toBe('false')
    // Drivers without native rewind stay hidden.
    expect(renderEditable('antigravity')).toBe('false')
    expect(renderEditable('deepseek')).toBe('false')
  })

  it('distinguishes conversation-only rewind (Pi/Cline) from file-reverting rewind (OpenCode)', async () => {
    const entries: ThreadEntry[] = [
      { kind: 'user', id: 'u1', content: [{ type: 'text', text: 'edit file' }] },
      {
        kind: 'tool',
        id: 't1',
        title: "Edit file 'a.ts'",
        toolKind: 'edit',
        status: 'completed',
        locations: [{ path: '/repo/a.ts' }],
        content: [],
        permission: null,
        permissionResult: null,
      },
    ]

    const piFacts = editFacts(threadWith('pi', entries), 'u1')!
    expect(piFacts.filesBack).toBe(false)
    expect(piFacts.files).toBe(1)
    flushSync(() => {
      root!.render(
        createElement(EditConfirm, {
          sessionId: 's1',
          facts: piFacts,
          onCancel: () => {},
          onEdit: () => {},
        }),
      )
    })
    expect(container.textContent).toContain('1 file changed since stays as it is')
    expect(container.textContent).not.toContain('Put back restores them')

    // Command-only turn on a conversation-only driver still states file changes stay untouched.
    const cmdEntries: ThreadEntry[] = [
      { kind: 'user', id: 'u1', content: [{ type: 'text', text: 'run script' }] },
      {
        kind: 'tool',
        id: 't1',
        title: 'npm test',
        toolKind: 'execute',
        status: 'completed',
        locations: [],
        content: [],
        permission: null,
        permissionResult: null,
      },
    ]
    const clineCmdFacts = editFacts(threadWith('cline', cmdEntries), 'u1')!
    expect(clineCmdFacts.filesBack).toBe(false)
    expect(clineCmdFacts.commands).toBe(true)
    flushSync(() => {
      root!.render(
        createElement(EditConfirm, {
          sessionId: 's1',
          facts: clineCmdFacts,
          onCancel: () => {},
          onEdit: () => {},
        }),
      )
    })
    expect(container.textContent).toContain('File changes since stay as they are')

    // OpenCode advertises rewindFiles: true, so the confirmation states files go back too.
    const openCodeFacts = editFacts(threadWith('opencode', entries), 'u1')!
    expect(openCodeFacts.filesBack).toBe(true)
    flushSync(() => {
      root!.render(
        createElement(EditConfirm, {
          sessionId: 's1',
          facts: openCodeFacts,
          onCancel: () => {},
          onEdit: () => {},
        }),
      )
    })
    expect(container.textContent).toContain('Files changed since go back as they were')

    // Verify Simplified Chinese copy distinguishes both behaviors clearly.
    await i18n.changeLanguage('zh-CN')
    flushSync(() => {
      root!.render(
        createElement(EditConfirm, {
          sessionId: 's1',
          facts: piFacts,
          onCancel: () => {},
          onEdit: () => {},
        }),
      )
    })
    expect(container.textContent).toContain('之后改过的 1 个文件保持原样')

    flushSync(() => {
      root!.render(
        createElement(EditConfirm, {
          sessionId: 's1',
          facts: clineCmdFacts,
          onCancel: () => {},
          onEdit: () => {},
        }),
      )
    })
    expect(container.textContent).toContain('之后的文件改动保持原样')

    flushSync(() => {
      root!.render(
        createElement(EditConfirm, {
          sessionId: 's1',
          facts: openCodeFacts,
          onCancel: () => {},
          onEdit: () => {},
        }),
      )
    })
    expect(container.textContent).toContain('之后改过的文件会退回原样，放回原处可以恢复')
  })
})
