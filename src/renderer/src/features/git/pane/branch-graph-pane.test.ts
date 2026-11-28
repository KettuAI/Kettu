import { createElement, type ReactElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BranchGraphPage, CommitDetails, FileDiff, GitStatus } from '@shared/git'

const { hostMock, openChangeDiffMock } = vi.hoisted(() => {
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        kettu: { platform: 'darwin', client: 'desktop' },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
  return {
    hostMock: vi.fn(),
    openChangeDiffMock: vi.fn(),
  }
})

vi.mock(
  '@hugeicons/core-free-icons',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => (prop === '__esModule' ? true : prop === 'then' ? undefined : prop),
        has: (_target, prop) => prop !== 'then',
      },
    ),
)
vi.mock('@hugeicons/react', () => ({ HugeiconsIcon: () => null }))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
    }),
  }
})

vi.mock('@renderer/lib/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/host')>()
  return {
    ...actual,
    host: (...args: unknown[]) => hostMock(...args),
    hostAt: (_hostId: string | null, ...args: unknown[]) => hostMock(...args),
  }
})

vi.mock('../open-change-diff', () => ({
  openChangeDiff: (...args: unknown[]) => openChangeDiffMock(...args),
}))

vi.mock('@renderer/features/session/markdown', () => ({
  Diff: ({ path, oldText, newText }: { path: string; oldText: string | null; newText: string }) =>
    createElement('div', {
      'data-testid': 'mock-diff',
      'data-path': path,
      'data-old': oldText ?? '<null>',
      'data-new': newText,
    }),
}))

vi.mock('@renderer/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-resizable-group': 'true' }, children),
  ResizablePanel: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-resizable-panel': 'true' }, children),
  ResizableHandle: () => createElement('div', { 'data-resizable-handle': 'true' }),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    className,
    'aria-label': ariaLabel,
    ...rest
  }: {
    children?: ReactNode
    disabled?: boolean
    onClick?: (event: { stopPropagation: () => void }) => void
    className?: string
    'aria-label'?: string
    [key: string]: unknown
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        disabled,
        className,
        'aria-label': ariaLabel,
        ...rest,
        onClick,
      },
      children,
    ),
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  TooltipTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) =>
    render
      ? createElement(
          render.type as string,
          { ...(render.props as Record<string, unknown>) },
          children,
        )
      : createElement('span', null, children),
  TooltipContent: () => null,
}))

vi.mock('@renderer/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) =>
    createElement('div', { 'data-skeleton': 'true', className }),
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => createElement('span', { 'data-spinner': 'true' }),
}))

import { receiveGitStatus, useGitStore } from '@renderer/stores/git'
import { noteSelectedTab, toggleSidePane, useViewStore } from '@renderer/stores/view'
import { clearCommitCaches } from '../use-git-data'
import BranchGraphPane from './branch-graph-pane'
import { openBranchGraph } from './open-pane'

interface FakeEvent {
  type: string
  target: FakeNode
  currentTarget: FakeNode | null
  bubbles: boolean
  cancelable: boolean
  defaultPrevented: boolean
  propagationStopped: boolean
  stopPropagation(): void
  preventDefault(): void
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
  attributes: Map<string, string>
  listeners: Map<string, Set<(event: FakeEvent) => void>>
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
  [key: string]: unknown
}

interface FakeDocument {
  nodeType: number
  nodeName: string
  documentElement: FakeNode
  body: FakeNode
  defaultView: FakeWindow
  listeners: Map<string, Set<(event: FakeEvent) => void>>
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
  addEventListener(type: string, fn: (event: FakeEvent) => void): void
  removeEventListener(type: string, fn: (event: FakeEvent) => void): void
}

class FakeNodeBase {
  static ELEMENT_NODE = 1
  static TEXT_NODE = 3
  static COMMENT_NODE = 8
  static DOCUMENT_NODE = 9
}
class FakeElementBase extends FakeNodeBase {}
class FakeDocumentBase extends FakeNodeBase {}

function createFakeDom(): { window: FakeWindow; document: FakeDocument; container: FakeNode } {
  const makeNode = (
    nodeType: number,
    nodeName: string,
    owner: FakeDocument | null,
    tagName?: string,
    namespaceURI?: string,
  ): FakeNode => {
    const childNodes: FakeNode[] = []
    const attributes = new Map<string, string>()
    const listeners = new Map<string, Set<(event: FakeEvent) => void>>()
    const node: FakeNode = {
      nodeType,
      nodeName,
      ...(tagName ? { tagName } : {}),
      ...(namespaceURI ? { namespaceURI } : {}),
      childNodes,
      parentNode: null,
      ownerDocument: owner,
      style: {},
      attributes,
      listeners,
      setAttribute(name, value) {
        attributes.set(name, String(value))
      },
      removeAttribute(name) {
        attributes.delete(name)
      },
      getAttribute(name) {
        return attributes.get(name) ?? null
      },
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child)
        child.parentNode = node
        childNodes.push(child)
        return child
      },
      insertBefore(child, ref) {
        if (child.parentNode) child.parentNode.removeChild(child)
        child.parentNode = node
        if (!ref) {
          childNodes.push(child)
          return child
        }
        const idx = childNodes.indexOf(ref)
        if (idx >= 0) childNodes.splice(idx, 0, child)
        else childNodes.push(child)
        return child
      },
      removeChild(child) {
        const idx = childNodes.indexOf(child)
        if (idx >= 0) {
          childNodes.splice(idx, 1)
          child.parentNode = null
        }
        return child
      },
      addEventListener(type, fn) {
        let set = listeners.get(type)
        if (!set) {
          set = new Set()
          listeners.set(type, set)
        }
        set.add(fn)
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn)
      },
      dispatchEvent(event) {
        let current: FakeNode | null = node
        while (current) {
          event.currentTarget = current
          const fns = current.listeners.get(event.type)
          if (fns) {
            for (const fn of [...fns]) fn(event)
          }
          if (event.propagationStopped || !event.bubbles) break
          current = current.parentNode
        }
        if (!event.propagationStopped && event.bubbles && owner) {
          const docFns = owner.listeners.get(event.type)
          if (docFns) {
            for (const fn of [...docFns]) fn(event)
          }
        }
        return !event.defaultPrevented
      },
      get firstChild() {
        return childNodes[0] ?? null
      },
      get lastChild() {
        return childNodes[childNodes.length - 1] ?? null
      },
      get textContent(): string {
        if (nodeType === 3) return node.nodeValue ?? ''
        return childNodes.map((c) => c.textContent).join('')
      },
      set textContent(value: string) {
        if (nodeType === 3) {
          node.nodeValue = value
          return
        }
        for (const c of childNodes) c.parentNode = null
        childNodes.length = 0
        if (value) {
          const text = owner!.createTextNode(value)
          text.parentNode = node
          childNodes.push(text)
        }
      },
    }
    return node
  }

  const docListeners = new Map<string, Set<(event: FakeEvent) => void>>()
  const fakeDoc: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as FakeNode,
    body: null as unknown as FakeNode,
    defaultView: null as unknown as FakeWindow,
    listeners: docListeners,
    createElement(tag) {
      return makeNode(
        1,
        tag.toUpperCase(),
        fakeDoc,
        tag.toUpperCase(),
        'http://www.w3.org/1999/xhtml',
      )
    },
    createElementNS(ns, tag) {
      return makeNode(1, tag, fakeDoc, tag, ns)
    },
    createTextNode(text) {
      const t = makeNode(3, '#text', fakeDoc)
      t.nodeValue = text
      return t
    },
    createComment(text) {
      const c = makeNode(8, '#comment', fakeDoc)
      c.nodeValue = text
      return c
    },
    addEventListener(type, fn) {
      let set = docListeners.get(type)
      if (!set) {
        set = new Set()
        docListeners.set(type, set)
      }
      set.add(fn)
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn)
    },
  }

  const fakeWin: FakeWindow = {
    document: fakeDoc,
    navigator: { userAgent: 'vitest-node' },
    HTMLElement: FakeElementBase,
    SVGElement: FakeElementBase,
    Element: FakeElementBase,
    Node: FakeNodeBase,
    Document: FakeDocumentBase,
    HTMLIFrameElement: FakeElementBase,
    addEventListener() {},
    removeEventListener() {},
  }
  fakeDoc.defaultView = fakeWin
  fakeDoc.documentElement = fakeDoc.createElement('html')
  fakeDoc.body = fakeDoc.createElement('body')
  fakeDoc.documentElement.appendChild(fakeDoc.body)
  const container = fakeDoc.createElement('div')
  fakeDoc.body.appendChild(container)
  return { window: fakeWin, document: fakeDoc, container }
}

function findAll(root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (predicate(node)) out.push(node)
    for (const child of node.childNodes) walk(child)
  }
  walk(root)
  return out
}

function findOne(root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode | null {
  return findAll(root, predicate)[0] ?? null
}

function click(node: FakeNode): void {
  const event: FakeEvent = {
    type: 'click',
    target: node,
    currentTarget: null,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    propagationStopped: false,
    stopPropagation() {
      event.propagationStopped = true
    },
    preventDefault() {
      event.defaultPrevented = true
    },
  }
  flushSync(() => {
    node.dispatchEvent(event)
  })
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const PROJECT = '/workspace/demo'
const PANEL = 'session-graph-1'
const OID_1 = '1'.repeat(40)
const OID_2 = '2'.repeat(40)
const OID_3 = '3'.repeat(40)

function makeStatus(repo = true): GitStatus {
  return {
    projectPath: PROJECT,
    repo: repo ? { root: PROJECT, gitDir: `${PROJECT}/.git` } : null,
    head: { branch: 'main', oid: OID_1, detached: false },
    upstream: null,
    base: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0 },
    operation: null,
    commits: [],
    remote: null,
    defaultBranch: 'main',
    push: null,
    lastFetchedAt: null,
    updatedAt: 1,
    stale: false,
  }
}

describe('openBranchGraph tab registration', () => {
  beforeEach(() => {
    useViewStore.setState({ sidePane: {}, sideTabs: {}, sideOrder: {}, sideDocs: {}, sideDoc: {} })
  })

  it('opens a dedicated gitGraph tab next to Git and deduplicates on repeated clicks', () => {
    toggleSidePane(PANEL, 'git', true)
    useViewStore.setState((s) => ({
      sideOrder: { ...s.sideOrder, [PANEL]: ['files:', 'git:', 'terminal:t1'] },
    }))
    noteSelectedTab(PANEL, 'git:')

    openBranchGraph(PANEL)
    let state = useViewStore.getState()
    expect(state.sidePane[PANEL]).toBe('gitGraph')
    expect(state.sideTabs[PANEL]).toEqual(['git', 'gitGraph'])
    expect(state.sideOrder[PANEL]).toEqual(['files:', 'git:', 'gitGraph:', 'terminal:t1'])

    // Switching back to Git and clicking Branch graph again refocuses the existing tab.
    toggleSidePane(PANEL, 'git', true)
    openBranchGraph(PANEL)
    state = useViewStore.getState()
    expect(state.sidePane[PANEL]).toBe('gitGraph')
    expect(state.sideTabs[PANEL]).toEqual(['git', 'gitGraph'])
  })
})

describe('BranchGraphPane UI', () => {
  let root: Root | null = null
  let container: FakeNode
  let prevGlobals: Record<string, unknown>

  beforeEach(() => {
    hostMock.mockReset()
    openChangeDiffMock.mockReset()
    clearCommitCaches()
    useGitStore.setState({ status: {}, currentPr: {} })
    receiveGitStatus(makeStatus(true))

    const dom = createFakeDom()
    container = dom.container
    const g = globalThis as unknown as Record<string, unknown>
    prevGlobals = {
      window: g.window,
      document: g.document,
      HTMLElement: g.HTMLElement,
      SVGElement: g.SVGElement,
      Element: g.Element,
      Node: g.Node,
      Document: g.Document,
    }
    Object.assign(g, {
      window: dom.window,
      document: dom.document,
      HTMLElement: dom.window.HTMLElement,
      SVGElement: dom.window.SVGElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      Document: dom.window.Document,
    })
  })

  afterEach(() => {
    if (root) {
      flushSync(() => root!.unmount())
      root = null
    }
    const g = globalThis as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(prevGlobals)) {
      if (v === undefined) delete g[k]
      else g[k] = v
    }
  })

  function mount(): void {
    root = createRoot(container as unknown as Element)
    flushSync(() => {
      root!.render(createElement(BranchGraphPane, { panel: PANEL, projectPath: PROJECT }))
    })
  }

  it('renders branch refs, loads commit details + diff on node click, and paginates on demand', async () => {
    const page1: BranchGraphPage = {
      commits: [
        {
          oid: OID_1,
          shortOid: OID_1.slice(0, 7),
          parents: [OID_2],
          subject: 'feat: render branch graph',
          authorName: 'Alice',
          authorEmail: 'alice@example.com',
          authoredAt: 1_700_000_200_000,
          refs: [
            { name: 'main', kind: 'local', current: true },
            { name: 'origin/main', kind: 'remote', current: false },
          ],
        },
        {
          oid: OID_2,
          shortOid: OID_2.slice(0, 7),
          parents: [OID_3],
          subject: 'chore: setup repo',
          authorName: 'Bob',
          authorEmail: 'bob@example.com',
          authoredAt: 1_700_000_100_000,
          refs: [{ name: 'v1.0.0', kind: 'tag', current: false }],
        },
      ],
      headOid: OID_1,
      currentBranch: 'main',
      detached: false,
      hasMore: true,
      nextSkip: 2,
    }

    const page2: BranchGraphPage = {
      commits: [
        {
          oid: OID_3,
          shortOid: OID_3.slice(0, 7),
          parents: [],
          subject: 'init: root commit',
          authorName: 'Bob',
          authorEmail: 'bob@example.com',
          authoredAt: 1_700_000_000_000,
          refs: [],
        },
      ],
      headOid: OID_1,
      currentBranch: 'main',
      detached: false,
      hasMore: false,
      nextSkip: 3,
    }

    const commit1Details: CommitDetails = {
      oid: OID_1,
      parents: [OID_2],
      subject: 'feat: render branch graph',
      body: 'Adds a read-only graph tab.',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authoredAt: 1_700_000_200_000,
      files: [
        { path: 'src/graph.ts', oldPath: null, status: 'added', insertions: 12, deletions: 0 },
      ],
    }

    const diff1: FileDiff = {
      path: 'src/graph.ts',
      oldText: null,
      newText: 'export const graph = true\n',
      binary: false,
      tooLarge: false,
    }

    hostMock.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'git.status') return Promise.resolve(makeStatus(true))
      if (method === 'git.tools') {
        return Promise.resolve({
          git: { found: true, version: '2.50.0' },
          gh: { state: 'not-installed', version: null, account: null },
        })
      }
      if (method === 'git.graph') {
        return Promise.resolve(params.skip === 2 ? page2 : page1)
      }
      if (method === 'git.commit' && params.oid === OID_1) {
        return Promise.resolve(commit1Details)
      }
      if (method === 'git.commit' && params.oid === OID_2) {
        return Promise.resolve({
          oid: OID_2,
          parents: [OID_3],
          subject: 'chore: setup repo',
          body: '',
          authorName: 'Bob',
          authorEmail: 'bob@example.com',
          authoredAt: 1_700_000_100_000,
          files: [],
        } satisfies CommitDetails)
      }
      if (method === 'git.fileDiff' && params.ref === OID_1 && params.path === 'src/graph.ts') {
        return Promise.resolve(diff1)
      }
      return Promise.reject(new Error(`Unexpected RPC: ${method}`))
    })

    mount()
    await flushMicrotasks()

    // Renders commits and highlights current branch badge.
    const rows = findAll(container, (n) => n.getAttribute('data-graph-commit') !== null)
    expect(rows.map((r) => r.getAttribute('data-graph-commit'))).toEqual([OID_1, OID_2])
    const currentBadge = findOne(container, (n) => n.getAttribute('data-ref-current') === 'true')
    expect(currentBadge?.getAttribute('data-graph-ref')).toBe('main')
    const tagBadge = findOne(container, (n) => n.getAttribute('data-ref-kind') === 'tag')
    expect(tagBadge?.getAttribute('data-graph-ref')).toBe('v1.0.0')

    // Click first commit node -> loads details and displays read-only inline diff for first changed file.
    click(rows[0]!)
    await flushMicrotasks()

    const detail = findOne(container, (n) => n.getAttribute('data-graph-detail') === OID_1)
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('Adds a read-only graph tab.')
    expect(
      findOne(detail!, (n) => n.getAttribute('data-graph-file') === 'src/graph.ts'),
    ).not.toBeNull()
    const diffNode = findOne(detail!, (n) => n.getAttribute('data-testid') === 'mock-diff')
    expect(diffNode?.getAttribute('data-path')).toBe('src/graph.ts')
    expect(diffNode?.getAttribute('data-new')).toBe('export const graph = true\n')

    // Clicking a loaded parent chip jumps selection to that parent commit.
    const parentBtn = findOne(detail!, (n) => n.getAttribute('data-graph-parent') === OID_2)
    expect(parentBtn).not.toBeNull()
    click(parentBtn!)
    await flushMicrotasks()
    expect(findOne(container, (n) => n.getAttribute('data-graph-detail') === OID_2)).not.toBeNull()

    // Load more commits on demand.
    const loadMoreBtn = findOne(container, (n) => n.getAttribute('data-graph-load-more') !== null)
    expect(loadMoreBtn).not.toBeNull()
    click(loadMoreBtn!)
    await flushMicrotasks()

    const rowsAfter = findAll(container, (n) => n.getAttribute('data-graph-commit') !== null)
    expect(rowsAfter.map((r) => r.getAttribute('data-graph-commit'))).toEqual([OID_1, OID_2, OID_3])
    expect(findOne(container, (n) => n.getAttribute('data-graph-load-more') !== null)).toBeNull()
  })

  it('shows empty state for a repository with zero commits', async () => {
    hostMock.mockImplementation((method: string) => {
      if (method === 'git.status') return Promise.resolve(makeStatus(true))
      if (method === 'git.tools') {
        return Promise.resolve({
          git: { found: true, version: '2.50.0' },
          gh: { state: 'not-installed', version: null, account: null },
        })
      }
      if (method === 'git.graph') {
        return Promise.resolve({
          commits: [],
          headOid: null,
          currentBranch: 'main',
          detached: false,
          hasMore: false,
          nextSkip: 0,
        } satisfies BranchGraphPage)
      }
      return Promise.reject(new Error(`Unexpected RPC: ${method}`))
    })

    mount()
    await flushMicrotasks()
    expect(container.textContent).toContain('graph.emptyTitle')
  })
})
