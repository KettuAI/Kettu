import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStatus, ThreadEntry, ThreadState } from '@shared/thread'
import type { TurnUndoPreview, TurnUndoResult } from '@shared/turn-undo'
import { i18n } from '@renderer/lib/i18n'

const { hostMock, toastMock, refreshGitMock, refreshFilesMock } = vi.hoisted(() => {
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
    hostMock: vi.fn(),
    toastMock: vi.fn(),
    refreshGitMock: vi.fn(),
    refreshFilesMock: vi.fn(),
  }
})

vi.mock('@renderer/lib/host', () => ({
  host: hostMock,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('@renderer/components/ui/toast', () => ({
  toast: toastMock,
}))

vi.mock('@renderer/stores/git', () => ({
  useGitStore: (selector: (s: { status: Record<string, unknown> }) => unknown) =>
    selector({ status: {} }),
  refreshGitProject: refreshGitMock,
}))

vi.mock('@renderer/stores/files', () => ({
  openDiff: vi.fn(),
  openFile: vi.fn(),
  refreshFiles: refreshFilesMock,
}))

vi.mock('@renderer/features/git/use-git-data', () => ({
  useDeletedGitPaths: () => new Set<string>(),
}))

vi.mock('@renderer/features/files/html-preview', () => ({
  isHtmlFile: () => false,
  previewHtml: vi.fn(),
  useHtmlPreview: () => false,
}))

vi.mock('@renderer/features/files/file-type-icon', () => ({
  FileTypeIcon: () => null,
}))

vi.mock('@renderer/features/files/open-in-editor-menu', () => ({
  OpenInEditorMenu: () => null,
}))

vi.mock('@renderer/features/session/markdown', () => ({
  Diff: ({ path, oldText, newText }: { path: string; oldText: string | null; newText: string }) =>
    createElement('div', {
      'data-mock-diff': path,
      'data-old': oldText ?? '<null>',
      'data-new': newText,
    }),
}))

vi.mock('../clamp', () => ({
  Clamp: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))

vi.mock('./use-diff-stats', () => ({
  cachedStats: () => ({ insertions: 1, deletions: 1 }),
  diffsSettled: () => true,
  useDiffStats: () => ({ insertions: 1, deletions: 1 }),
}))

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement('div', { 'data-dialog': 'open' }, children) : null,
  DialogContent: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-dialog-content': '' }, children),
  DialogHeader: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement('h2', null, children),
  DialogDescription: ({ children }: { children: ReactNode }) => createElement('p', null, children),
  DialogFooter: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/collapsible', () => ({
  Collapsible: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean
    onOpenChange?: (next: boolean) => void
    children: ReactNode
  }) =>
    createElement(
      'div',
      {
        'data-collapsible': open ? 'open' : 'closed',
        onClick: () => onOpenChange?.(!open),
      },
      children,
    ),
  CollapsibleTrigger: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) =>
    createElement('button', { type: 'button', ...rest }, children),
  CollapsibleContent: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-collapsible-content': '' }, children),
}))

vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  ContextMenuTrigger: ({ render }: { render: ReactNode }) => render,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
  ContextMenuSeparator: () => null,
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: ReactNode
    onClick?: () => void
    disabled?: boolean
    [key: string]: unknown
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        disabled,
        onClick: disabled ? undefined : onClick,
        ...rest,
      },
      children,
    ),
}))

import { useThreadsStore } from '@renderer/stores/threads'
import { ChangesCard } from './changes-card'

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
  disabled?: boolean
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  addEventListener(type: string, fn: (event: unknown) => void): void
  removeEventListener(type: string, fn: (event: unknown) => void): void
  dispatchEvent(event: {
    type: string
    target?: FakeNode
    currentTarget?: FakeNode
    bubbles?: boolean
    stopPropagation?: () => void
    preventDefault?: () => void
  }): void
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
  listeners: Map<string, Set<(event: unknown) => void>>
  createElement(tag: string): FakeNode
  createElementNS(ns: string, tag: string): FakeNode
  createTextNode(text: string): FakeNode
  createComment(text: string): FakeNode
  querySelector(): FakeNode | null
  querySelectorAll(): FakeNode[]
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
  listeners = new Map<string, Set<(event: unknown) => void>>()
  disabled?: boolean;
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
    if (attr === 'disabled') this.disabled = true
  }

  removeAttribute(attr: string): void {
    this.attributes.delete(attr)
    if (attr === 'disabled') this.disabled = false
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

  dispatchEvent(event: {
    type: string
    target?: FakeNode
    currentTarget?: FakeNode
    bubbles?: boolean
    stopPropagation?: () => void
    preventDefault?: () => void
  }): void {
    event.target ??= this
    let stopped = false
    event.stopPropagation = () => {
      stopped = true
    }
    event.preventDefault = () => {}
    const dispatchFrom = (start: FakeNode): void => {
      let node: FakeNode | null = start
      while (node && !stopped) {
        event.currentTarget = node
        for (const fn of [...(node.listeners.get(event.type) ?? [])]) fn(event)
        if (!event.bubbles) break
        node = node.parentNode
      }
    }
    dispatchFrom(this)
    if (!stopped && event.bubbles && this.ownerDocument) {
      for (const fn of [...(this.ownerDocument.listeners.get(event.type) ?? [])]) fn(event)
    }
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

  get children(): FakeNode[] {
    return this.childNodes.filter((child) => child.nodeType === 1)
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
    listeners: new Map(),
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
    addEventListener(type: string, fn: (event: unknown) => void) {
      let set = doc.listeners.get(type)
      if (!set) {
        set = new Set()
        doc.listeners.set(type, set)
      }
      set.add(fn)
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      doc.listeners.get(type)?.delete(fn)
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

function clickNode(node: FakeNode): void {
  const propsKey = Object.keys(node).find((k) => k.startsWith('__reactProps$'))
  const handler = propsKey
    ? (node[propsKey] as { onClick?: (event: unknown) => void } | undefined)?.onClick
    : undefined
  flushSync(() => {
    if (handler) {
      handler({ preventDefault() {}, stopPropagation() {} })
    } else {
      node.dispatchEvent({ type: 'click', bubbles: true })
    }
  })
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function setThread(status: SessionStatus, undone = false): void {
  const entries: ThreadEntry[] = [
    {
      kind: 'tool',
      id: 't1',
      title: 'Edit a.ts',
      toolKind: 'edit',
      status: 'completed',
      content: [
        { type: 'diff', path: '/repo/a.ts', oldText: 'const a = 1', newText: 'const a = 2' },
      ],
      locations: [{ path: '/repo/a.ts' }],
      permission: null,
      permissionResult: null,
      ...(undone ? { undone: true } : {}),
    },
  ]
  const state: ThreadState = {
    session: {
      id: 's1',
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: null,
      status,
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
    order: entries.map((e) => e.id),
    byId: Object.fromEntries(entries.map((e) => [e.id, e])),
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

describe('ChangesCard & TurnUndoDialog UI', () => {
  let root: Root | null = null
  let container: FakeNode
  let prevGlobals: Record<string, unknown>

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    hostMock.mockReset()
    toastMock.mockReset()
    refreshGitMock.mockReset()
    refreshFilesMock.mockReset()
    useThreadsStore.setState({ replicas: {} })

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

  function renderCard(): void {
    flushSync(() => {
      root!.render(
        createElement(ChangesCard, {
          sessionId: 's1',
          projectPath: '/repo',
          toolIds: ['t1'],
        }),
      )
    })
  }

  it('disables the Undo button while running or already undone, and shows the Undone badge', () => {
    setThread('running', false)
    renderCard()
    const runningBtn = findAll(container, (n) => n.getAttribute('data-changes-undo') !== null)[0]!
    expect(runningBtn.disabled).toBe(true)
    expect(runningBtn.getAttribute('title')).toContain('Wait until the session finishes')

    setThread('ready', true)
    renderCard()
    const undoneBtn = findAll(container, (n) => n.getAttribute('data-changes-undo') !== null)[0]!
    expect(undoneBtn.disabled).toBe(true)
    expect(container.textContent).toContain('Undone')
  })

  it('shows conflicts in preview, disables Confirm, and lets the user re-check', async () => {
    const conflictPreview: TurnUndoPreview = {
      fingerprint: 'fp1',
      fileDigests: [{ path: 'a.ts', exists: true, sha256: 'a'.repeat(64), size: 10 }],
      affectedFiles: [
        {
          path: 'a.ts',
          displayPath: '/repo/a.ts',
          action: 'revert',
          status: 'conflict',
          reason: 'content_mismatch',
          beforeText: 'const a = 999',
          afterText: null,
          editCount: 1,
        },
      ],
      conflicts: [{ path: 'a.ts', reason: 'content_mismatch' }],
      canApply: false,
      alreadyUndone: false,
    }
    const cleanPreview: TurnUndoPreview = {
      fingerprint: 'fp2',
      fileDigests: [{ path: 'a.ts', exists: true, sha256: 'b'.repeat(64), size: 11 }],
      affectedFiles: [
        {
          path: 'a.ts',
          displayPath: '/repo/a.ts',
          action: 'revert',
          status: 'ready',
          beforeText: 'const a = 2',
          afterText: 'const a = 1',
          editCount: 1,
        },
      ],
      conflicts: [],
      canApply: true,
      alreadyUndone: false,
    }
    hostMock.mockResolvedValueOnce(conflictPreview).mockResolvedValueOnce(cleanPreview)

    setThread('ready', false)
    renderCard()

    const trigger = findAll(container, (n) => n.getAttribute('data-changes-undo') !== null)[0]!
    clickNode(trigger)
    await flushMicrotasks()

    expect(hostMock).toHaveBeenCalledWith('sessions.previewUndoTurn', {
      sessionId: 's1',
      toolIds: ['t1'],
    })
    const conflictBanner = findAll(
      container,
      (n) => n.getAttribute('data-undo-conflicts') !== null,
    )[0]
    expect(conflictBanner).toBeDefined()
    expect(conflictBanner!.textContent).toContain('a.ts')
    expect(conflictBanner!.textContent).toContain('conflicts with later edits')

    const confirmBtn = findAll(container, (n) => n.getAttribute('data-undo-confirm') !== null)[0]!
    expect(confirmBtn.disabled).toBe(true)

    const recheckBtn = findAll(container, (n) => n.getAttribute('data-undo-recheck') !== null)[0]!
    clickNode(recheckBtn)
    await flushMicrotasks()

    expect(findAll(container, (n) => n.getAttribute('data-undo-conflicts') !== null)).toHaveLength(
      0,
    )
    const confirmAfter = findAll(container, (n) => n.getAttribute('data-undo-confirm') !== null)[0]!
    expect(confirmAfter.disabled).toBe(false)
  })

  it('handles stale re-verification on apply and then applies cleanly on second confirmation', async () => {
    const initialPreview: TurnUndoPreview = {
      fingerprint: 'fp-1',
      fileDigests: [{ path: 'a.ts', exists: true, sha256: '1'.repeat(64), size: 11 }],
      affectedFiles: [
        {
          path: 'a.ts',
          displayPath: '/repo/a.ts',
          action: 'revert',
          status: 'ready',
          beforeText: 'const a = 2',
          afterText: 'const a = 1',
          editCount: 1,
        },
      ],
      conflicts: [],
      canApply: true,
      alreadyUndone: false,
    }
    const freshPreview: TurnUndoPreview = {
      ...initialPreview,
      fingerprint: 'fp-2',
      fileDigests: [{ path: 'a.ts', exists: true, sha256: '2'.repeat(64), size: 20 }],
      affectedFiles: [
        {
          ...initialPreview.affectedFiles[0]!,
          beforeText: 'const a = 2\n// note',
          afterText: 'const a = 1\n// note',
        },
      ],
    }
    const staleResult: TurnUndoResult = {
      status: 'stale',
      changedPaths: ['a.ts'],
      preview: freshPreview,
    }
    const appliedResult: TurnUndoResult = {
      status: 'applied',
      revertedFiles: ['a.ts'],
      deletedFiles: [],
      restoredFiles: [],
    }

    hostMock
      .mockResolvedValueOnce(initialPreview)
      .mockResolvedValueOnce(staleResult)
      .mockResolvedValueOnce(appliedResult)

    setThread('ready', false)
    renderCard()

    clickNode(findAll(container, (n) => n.getAttribute('data-changes-undo') !== null)[0]!)
    await flushMicrotasks()

    // First confirm triggers stale detection -> dialog stays open with warning banner.
    clickNode(findAll(container, (n) => n.getAttribute('data-undo-confirm') !== null)[0]!)
    await flushMicrotasks()

    expect(hostMock).toHaveBeenNthCalledWith(2, 'sessions.undoTurn', {
      sessionId: 's1',
      toolIds: ['t1'],
      expectedDigests: initialPreview.fileDigests,
    })
    const staleBanner = findAll(container, (n) => n.getAttribute('data-undo-stale') !== null)[0]
    expect(staleBanner).toBeDefined()
    expect(staleBanner!.textContent).toContain('Files changed after this preview opened')
    expect(staleBanner!.textContent).toContain('a.ts')
    expect(toastMock).not.toHaveBeenCalled()

    // Second confirm sends the updated digests and completes cleanly.
    clickNode(findAll(container, (n) => n.getAttribute('data-undo-confirm') !== null)[0]!)
    await flushMicrotasks()

    expect(hostMock).toHaveBeenNthCalledWith(3, 'sessions.undoTurn', {
      sessionId: 's1',
      toolIds: ['t1'],
      expectedDigests: freshPreview.fileDigests,
    })
    expect(toastMock).toHaveBeenCalledWith('Undid changes in 1 file')
    expect(refreshGitMock).toHaveBeenCalledWith('/repo')
    expect(refreshFilesMock).toHaveBeenCalledWith('/repo')
    // Dialog closed and card now shows Undone state.
    expect(findAll(container, (n) => n.getAttribute('data-dialog') === 'open')).toHaveLength(0)
    const undoBtn = findAll(container, (n) => n.getAttribute('data-changes-undo') !== null)[0]!
    expect(undoBtn.disabled).toBe(true)
  })
})
