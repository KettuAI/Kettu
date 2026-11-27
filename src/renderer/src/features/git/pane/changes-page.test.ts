import { createElement, createRef, type ReactElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangedFile, FileDiff, GitStatus } from '@shared/git'
import { onHost } from '@renderer/lib/host-paths'

const { hostMock, openChangeDiffMock, openFileMock, openGitDialogMock } = vi.hoisted(() => {
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
    openFileMock: vi.fn(),
    openGitDialogMock: vi.fn(),
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
  }
})

vi.mock('../open-change-diff', () => ({
  openChangeDiff: (...args: unknown[]) => openChangeDiffMock(...args),
}))

vi.mock('@renderer/stores/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/files')>()
  return {
    ...actual,
    openFile: (...args: unknown[]) => openFileMock(...args),
  }
})

vi.mock('@renderer/stores/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/git')>()
  return {
    ...actual,
    openGitDialog: (...args: unknown[]) => openGitDialogMock(...args),
  }
})

vi.mock('@renderer/features/session/markdown', () => ({
  Diff: ({
    path,
    oldText,
    newText,
    overflow,
    layout,
    className,
  }: {
    path: string
    oldText: string | null
    newText: string
    overflow?: string
    layout?: string
    className?: string
  }) =>
    createElement('div', {
      'data-testid': 'mock-diff',
      'data-path': path,
      'data-old': oldText ?? '<null>',
      'data-new': newText,
      'data-overflow': overflow ?? '',
      'data-layout': layout ?? '',
      className,
    }),
}))

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    disabled,
    onCheckedChange,
    'aria-label': ariaLabel,
  }: {
    checked?: boolean
    indeterminate?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
    'aria-label'?: string
  }) =>
    createElement('button', {
      type: 'button',
      role: 'checkbox',
      'aria-checked': String(!!checked),
      'aria-label': ariaLabel,
      disabled,
      onClick: () => !disabled && onCheckedChange?.(!checked),
    }),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    className,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode
    disabled?: boolean
    onClick?: (event: { stopPropagation: () => void }) => void
    className?: string
    'aria-label'?: string
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        disabled,
        className,
        'aria-label': ariaLabel,
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

vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-context-menu': 'true' }, children),
  ContextMenuTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) =>
    render
      ? createElement(
          render.type as string,
          { ...(render.props as Record<string, unknown>) },
          children,
        )
      : createElement('div', null, children),
  ContextMenuContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', { role: 'menu', 'data-context-menu-content': 'true' }, children),
  ContextMenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode
    disabled?: boolean
    onClick?: () => void
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        disabled,
        onClick: () => !disabled && onClick?.(),
      },
      children,
    ),
  ContextMenuSeparator: () => createElement('hr'),
}))

vi.mock('@renderer/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) =>
    createElement('div', { 'data-skeleton': 'true', className }),
}))

import { useFilesStore } from '@renderer/stores/files'
import { receiveGitStatus, setLeftOut, useGitStore } from '@renderer/stores/git'
import { clearFileDiffCache } from '../use-git-data'
import { ChangesPage } from './changes-page'
import { INLINE_DIFF_MAX_LINES } from './inline-diff-model'

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
  const walk = (node: FakeNode) => {
    if (predicate(node)) out.push(node)
    for (const child of node.childNodes) walk(child)
  }
  walk(root)
  return out
}

function clickNode(node: FakeNode): void {
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

async function flushReact(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function makeStatus(projectPath: string, updatedAt = 1_000): GitStatus {
  return {
    projectPath,
    repo: { root: projectPath, gitDir: `${projectPath}/.git` },
    head: { branch: 'feat/inline-diff', oid: '1234567', detached: false },
    defaultBranch: 'main',
    upstream: null,
    base: null,
    remote: null,
    push: null,
    changes: {
      staged: 1,
      unstaged: 1,
      untracked: 1,
      conflicted: 0,
      insertions: 10,
      deletions: 2,
    },
    commits: [],
    operation: null,
    lastFetchedAt: null,
    updatedAt,
    stale: false,
  }
}

function makeFile(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    insertions: 3,
    deletions: 1,
    ...overrides,
  }
}

function rowOf(container: FakeNode, path: string): FakeNode {
  const row = findAll(container, (node) => node.getAttribute('data-file-entry') === path)[0]
  if (!row) throw new Error(`Row not found for ${path}`)
  return row
}

function toggleButtonOf(container: FakeNode, path: string): FakeNode {
  const row = rowOf(container, path)
  const button = findAll(
    row,
    (node) => node.tagName === 'BUTTON' && node.getAttribute('aria-expanded') !== null,
  )[0]
  if (!button) throw new Error(`Toggle button not found for ${path}`)
  return button
}

function checkboxOf(container: FakeNode, path: string): FakeNode {
  const row = rowOf(container, path)
  const box = findAll(row, (node) => node.getAttribute('role') === 'checkbox')[0]
  if (!box) throw new Error(`Checkbox not found for ${path}`)
  return box
}

function rowActionOf(container: FakeNode, path: string, label: string): FakeNode {
  const row = rowOf(container, path)
  const button = findAll(
    row,
    (node) =>
      node.tagName === 'BUTTON' &&
      node.getAttribute('role') !== 'menuitem' &&
      node.getAttribute('aria-label') === label,
  )[0]
  if (!button) throw new Error(`Action "${label}" not found for ${path}`)
  return button
}

function contextMenuItemOf(container: FakeNode, path: string, label: string): FakeNode {
  const row = rowOf(container, path)
  const item = findAll(
    row,
    (node) => node.getAttribute('role') === 'menuitem' && node.textContent.includes(label),
  )[0]
  if (!item) throw new Error(`Context menu item "${label}" not found for ${path}`)
  return item
}

function inlineDiffOf(container: FakeNode, path: string): FakeNode | undefined {
  return findAll(container, (node) => node.getAttribute('data-inline-diff') === path)[0]
}

describe('ChangesPage inline diff expansion (#2722)', () => {
  let root: Root | null = null
  let container: FakeNode
  const projectPath = '/work/kettu'

  beforeEach(() => {
    const dom = createFakeDom()
    container = dom.container
    vi.stubGlobal(
      'window',
      Object.assign(dom.window, { kettu: { platform: 'darwin', client: 'desktop' } }),
    )
    vi.stubGlobal('document', dom.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('SVGElement', dom.window.SVGElement)
    vi.stubGlobal('Element', dom.window.Element)
    vi.stubGlobal('Node', dom.window.Node)
    hostMock.mockReset()
    openChangeDiffMock.mockReset()
    openFileMock.mockReset()
    openGitDialogMock.mockReset()
    clearFileDiffCache()
    useGitStore.setState({ status: {}, leftOut: {}, commitAsk: {} })
    useFilesStore.setState({ diffs: {} })
  })

  afterEach(() => {
    if (root) {
      const mounted = root
      flushSync(() => mounted.unmount())
      root = null
    }
    clearFileDiffCache()
    vi.unstubAllGlobals()
  })

  function mount(status: GitStatus, files: ChangedFile[]): void {
    receiveGitStatus(status)
    if (!root) root = createRoot(container as unknown as Element)
    flushSync(() => {
      root!.render(
        createElement(ChangesPage, {
          panel: 'panel-1',
          status,
          changes: { data: files, error: null },
          textarea: createRef<HTMLTextAreaElement>(),
        }),
      )
    })
  }

  it('fetches diffs lazily only on row click, toggles inline preview in place, and keeps multiple files open independently', async () => {
    const status = makeStatus(projectPath, 1_000)
    const fileA = makeFile('src/a.ts')
    const fileB = makeFile('src/b.ts', { status: 'untracked', insertions: null, deletions: null })
    hostMock.mockImplementation(
      async (_method: string, params: { path: string }): Promise<FileDiff> => ({
        path: params.path,
        oldText: params.path === 'src/a.ts' ? 'const a = 1\n' : null,
        newText: params.path === 'src/a.ts' ? 'const a = 2\n' : 'export const b = true\n',
        binary: false,
        tooLarge: false,
      }),
    )

    mount(status, [fileA, fileB])
    await flushReact()

    // Nothing expanded -> no eager diff requests.
    expect(hostMock).not.toHaveBeenCalled()
    expect(toggleButtonOf(container, 'src/a.ts').getAttribute('aria-expanded')).toBe('false')
    expect(toggleButtonOf(container, 'src/b.ts').getAttribute('aria-expanded')).toBe('false')

    // Click first row -> expands inline diff without switching to a diff tab.
    clickNode(toggleButtonOf(container, 'src/a.ts'))
    await flushReact()

    expect(openChangeDiffMock).not.toHaveBeenCalled()
    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('git.fileDiff', {
      projectPath,
      path: 'src/a.ts',
      oldPath: null,
      ref: null,
    })
    expect(toggleButtonOf(container, 'src/a.ts').getAttribute('aria-expanded')).toBe('true')
    const regionA = inlineDiffOf(container, 'src/a.ts')
    expect(regionA).toBeDefined()
    const scrollA = findAll(regionA!, (n) => n.getAttribute('data-inline-diff-scroll') !== null)[0]
    expect(scrollA?.getAttribute('class')).toContain('max-h-88')
    expect(scrollA?.getAttribute('class')).toContain('overflow-auto')
    const mockDiffA = findAll(regionA!, (n) => n.getAttribute('data-testid') === 'mock-diff')[0]
    expect(mockDiffA?.getAttribute('data-overflow')).toBe('scroll')
    expect(mockDiffA?.getAttribute('data-layout')).toBe('unified')
    expect(mockDiffA?.getAttribute('data-new')).toBe('const a = 2\n')

    // Click second row -> both stay expanded independently.
    clickNode(toggleButtonOf(container, 'src/b.ts'))
    await flushReact()

    expect(hostMock).toHaveBeenCalledTimes(2)
    expect(inlineDiffOf(container, 'src/a.ts')).toBeDefined()
    expect(inlineDiffOf(container, 'src/b.ts')).toBeDefined()

    // Click first row again -> collapses only the first row.
    clickNode(toggleButtonOf(container, 'src/a.ts'))
    await flushReact()

    expect(toggleButtonOf(container, 'src/a.ts').getAttribute('aria-expanded')).toBe('false')
    expect(inlineDiffOf(container, 'src/a.ts')).toBeUndefined()
    expect(inlineDiffOf(container, 'src/b.ts')).toBeDefined()
  })

  it('does not toggle inline expansion when clicking checkbox, trailing action buttons, or context menu items', async () => {
    const status = makeStatus(projectPath, 1_000)
    const file = makeFile('src/main.ts')
    mount(status, [file])
    await flushReact()

    // Checkbox toggles commit selection without expanding or fetching diff.
    clickNode(checkboxOf(container, 'src/main.ts'))
    await flushReact()
    expect(useGitStore.getState().leftOut[projectPath]).toEqual(['src/main.ts'])
    expect(toggleButtonOf(container, 'src/main.ts').getAttribute('aria-expanded')).toBe('false')
    expect(hostMock).not.toHaveBeenCalled()

    // Trailing button opens the dedicated full diff tab without expanding inline.
    clickNode(rowActionOf(container, 'src/main.ts', 'pane.changes.openDiffTab'))
    await flushReact()
    expect(openChangeDiffMock).toHaveBeenCalledTimes(1)
    expect(openChangeDiffMock).toHaveBeenCalledWith(status, file, null, { fromPanel: true })
    expect(toggleButtonOf(container, 'src/main.ts').getAttribute('aria-expanded')).toBe('false')
    expect(hostMock).not.toHaveBeenCalled()

    // Trailing Open file and Discard actions do not toggle expansion either.
    clickNode(rowActionOf(container, 'src/main.ts', 'pane.changes.openInFiles'))
    clickNode(rowActionOf(container, 'src/main.ts', 'pane.changes.discardFile'))
    await flushReact()
    expect(openFileMock).toHaveBeenCalledWith(projectPath, 'src/main.ts', null, { fromPanel: true })
    expect(openGitDialogMock).toHaveBeenCalledWith(projectPath, {
      kind: 'discard',
      paths: ['src/main.ts'],
    })
    expect(toggleButtonOf(container, 'src/main.ts').getAttribute('aria-expanded')).toBe('false')

    // Context menu Open diff / Open file actions keep the row collapsed.
    clickNode(contextMenuItemOf(container, 'src/main.ts', 'pane.changes.openDiffTab'))
    clickNode(contextMenuItemOf(container, 'src/main.ts', 'pane.changes.openInFiles'))
    await flushReact()
    expect(openChangeDiffMock).toHaveBeenCalledTimes(2)
    expect(openFileMock).toHaveBeenCalledTimes(2)
    expect(toggleButtonOf(container, 'src/main.ts').getAttribute('aria-expanded')).toBe('false')
    expect(hostMock).not.toHaveBeenCalled()

    // Restoring tick leaves expansion untouched.
    setLeftOut(projectPath, [])
  })

  it('reuses cached diffs across collapse/expand and refreshes open previews when repository status updates', async () => {
    const file = makeFile('src/live.ts')
    let version = 1
    hostMock.mockImplementation(async (): Promise<FileDiff> => ({
      path: 'src/live.ts',
      oldText: 'export const v = 0\n',
      newText: `export const v = ${version}\n`,
      binary: false,
      tooLarge: false,
    }))

    mount(makeStatus(projectPath, 1_000), [file])
    clickNode(toggleButtonOf(container, 'src/live.ts'))
    await flushReact()

    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(
      findAll(
        inlineDiffOf(container, 'src/live.ts')!,
        (n) => n.getAttribute('data-testid') === 'mock-diff',
      )[0]?.getAttribute('data-new'),
    ).toBe('export const v = 1\n')

    // Collapse and re-expand at the same status.updatedAt -> cache hit, no extra request.
    clickNode(toggleButtonOf(container, 'src/live.ts'))
    clickNode(toggleButtonOf(container, 'src/live.ts'))
    await flushReact()
    expect(hostMock).toHaveBeenCalledTimes(1)

    // Repository status refreshes -> re-fetches and updates the expanded inline preview.
    version = 2
    mount(makeStatus(projectPath, 2_000), [
      makeFile('src/live.ts', { insertions: 4, deletions: 1 }),
    ])
    await flushReact()

    expect(hostMock).toHaveBeenCalledTimes(2)
    expect(
      findAll(
        inlineDiffOf(container, 'src/live.ts')!,
        (n) => n.getAttribute('data-testid') === 'mock-diff',
      )[0]?.getAttribute('data-new'),
    ).toBe('export const v = 2\n')
  })

  it('renders loading, binary, empty, renamed, truncated, and remote error states with retry and full-diff shortcuts', async () => {
    const remotePath = onHost('a'.repeat(32), '/srv/repo')
    const status = makeStatus(remotePath, 1_000)
    const pendingFile = makeFile('src/pending.ts')
    const binaryFile = makeFile('assets/logo.png', { insertions: null, deletions: null })
    const emptyFile = makeFile('src/empty.ts', { insertions: 0, deletions: 0 })
    const renamedFile = makeFile('src/new-name.ts', {
      oldPath: 'src/old-name.ts',
      status: 'renamed',
    })
    const longFile = makeFile('src/huge.ts', { status: 'added', insertions: 300, deletions: 0 })
    const failingFile = makeFile('src/remote-fail.ts')

    let failOnce = true
    const never = new Promise<FileDiff>(() => {})
    hostMock.mockImplementation((_method: string, params: { path: string }) => {
      if (params.path === 'src/pending.ts') return never
      if (params.path === 'assets/logo.png') {
        return Promise.resolve<FileDiff>({
          path: params.path,
          oldText: null,
          newText: null,
          binary: true,
          tooLarge: false,
        })
      }
      if (params.path === 'src/empty.ts') {
        return Promise.resolve<FileDiff>({
          path: params.path,
          oldText: 'same\n',
          newText: 'same\n',
          binary: false,
          tooLarge: false,
        })
      }
      if (params.path === 'src/new-name.ts') {
        return Promise.resolve<FileDiff>({
          path: params.path,
          oldText: 'const x = 1\n',
          newText: 'const x = 2\n',
          binary: false,
          tooLarge: false,
        })
      }
      if (params.path === 'src/huge.ts') {
        const text =
          Array.from({ length: INLINE_DIFF_MAX_LINES + 25 }, (_, i) => `line ${i + 1}`).join('\n') +
          '\n'
        return Promise.resolve<FileDiff>({
          path: params.path,
          oldText: null,
          newText: text,
          binary: false,
          tooLarge: false,
        })
      }
      if (params.path === 'src/remote-fail.ts') {
        if (failOnce) {
          failOnce = false
          return Promise.reject(new Error('Remote host disconnected'))
        }
        return Promise.resolve<FileDiff>({
          path: params.path,
          oldText: 'a\n',
          newText: 'b\n',
          binary: false,
          tooLarge: false,
        })
      }
      return never
    })

    mount(status, [pendingFile, binaryFile, emptyFile, renamedFile, longFile, failingFile])

    // Loading state
    clickNode(toggleButtonOf(container, 'src/pending.ts'))
    await flushReact()
    expect(
      findAll(
        inlineDiffOf(container, 'src/pending.ts')!,
        (n) => n.getAttribute('aria-busy') === 'true',
      ),
    ).toHaveLength(1)

    // Binary state + Open full diff button
    clickNode(toggleButtonOf(container, 'assets/logo.png'))
    await flushReact()
    const binaryRegion = inlineDiffOf(container, 'assets/logo.png')!
    expect(binaryRegion.textContent).toContain('pane.changes.binary')
    const openFromBinary = findAll(
      binaryRegion,
      (n) => n.tagName === 'BUTTON' && n.textContent === 'pane.changes.openFullDiff',
    )[0]!
    clickNode(openFromBinary)
    expect(openChangeDiffMock).toHaveBeenCalledWith(status, binaryFile, null, { fromPanel: true })

    // Empty diff state
    clickNode(toggleButtonOf(container, 'src/empty.ts'))
    await flushReact()
    expect(inlineDiffOf(container, 'src/empty.ts')?.textContent).toContain('pane.changes.same')

    // Renamed file shows oldPath -> path header alongside the diff
    clickNode(toggleButtonOf(container, 'src/new-name.ts'))
    await flushReact()
    expect(inlineDiffOf(container, 'src/new-name.ts')?.textContent).toContain(
      'src/old-name.ts → src/new-name.ts',
    )

    // Oversized diff shows truncation footer with Open full diff action
    clickNode(toggleButtonOf(container, 'src/huge.ts'))
    await flushReact()
    const longRegion = inlineDiffOf(container, 'src/huge.ts')!
    expect(longRegion.textContent).toContain('pane.changes.truncated')
    const openFromTruncated = findAll(
      longRegion,
      (n) => n.tagName === 'BUTTON' && n.textContent === 'pane.changes.openFullDiff',
    )[0]!
    clickNode(openFromTruncated)
    expect(openChangeDiffMock).toHaveBeenCalledWith(status, longFile, null, { fromPanel: true })

    // Remote host error shows message and recovers via Retry
    clickNode(toggleButtonOf(container, 'src/remote-fail.ts'))
    await flushReact()
    const failRegion = inlineDiffOf(container, 'src/remote-fail.ts')!
    expect(failRegion.textContent).toContain('Remote host disconnected')
    const retryButton = findAll(
      failRegion,
      (n) => n.tagName === 'BUTTON' && n.textContent === 'pane.changes.retry',
    )[0]!
    clickNode(retryButton)
    await flushReact()
    expect(
      findAll(
        inlineDiffOf(container, 'src/remote-fail.ts')!,
        (n) => n.getAttribute('data-testid') === 'mock-diff',
      ),
    ).toHaveLength(1)
  })

  it('reuses diff tab cache, keeps previous diff visible on refresh failure, and handles conflicted rows', async () => {
    const status = makeStatus(projectPath, 1_000)
    const normalFile = makeFile('src/cached.ts')
    const conflictFile = makeFile('src/conflict.ts', {
      status: 'conflicted',
      insertions: null,
      deletions: null,
    })

    // Seed the files store diff cache as if the diff tab already loaded this file.
    useFilesStore.setState({
      diffs: {
        [`${projectPath}\0:src/cached.ts`]: {
          result: {
            path: 'src/cached.ts',
            oldText: 'before\n',
            newText: 'from-tab-cache\n',
            binary: false,
            tooLarge: false,
          },
          error: null,
        },
      },
    })

    let resolveRefresh!: (diff: FileDiff) => void
    let call = 0
    hostMock.mockImplementation((_method: string, params: { path: string }) => {
      if (params.path === 'src/conflict.ts') {
        return Promise.resolve<FileDiff>({
          path: 'src/conflict.ts',
          oldText: 'ours\n',
          newText: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n',
          binary: false,
          tooLarge: false,
        })
      }
      call += 1
      if (call === 1) {
        return new Promise<FileDiff>((resolve) => {
          resolveRefresh = resolve
        })
      }
      return Promise.reject(new Error('Refresh timeout'))
    })

    mount(status, [conflictFile, normalFile])

    // Expand normalFile: immediately shows cached tab diff while background fetch is pending.
    clickNode(toggleButtonOf(container, 'src/cached.ts'))
    expect(
      findAll(
        inlineDiffOf(container, 'src/cached.ts')!,
        (n) => n.getAttribute('data-testid') === 'mock-diff',
      )[0]?.getAttribute('data-new'),
    ).toBe('from-tab-cache\n')

    resolveRefresh({
      path: 'src/cached.ts',
      oldText: 'before\n',
      newText: 'fresh-inline\n',
      binary: false,
      tooLarge: false,
    })
    await flushReact()
    expect(
      findAll(
        inlineDiffOf(container, 'src/cached.ts')!,
        (n) => n.getAttribute('data-testid') === 'mock-diff',
      )[0]?.getAttribute('data-new'),
    ).toBe('fresh-inline\n')

    // When a subsequent status refresh fails, keep the previous diff rendered with an inline error banner.
    mount(makeStatus(projectPath, 2_000), [conflictFile, normalFile])
    await flushReact()
    const cachedRegion = inlineDiffOf(container, 'src/cached.ts')!
    expect(cachedRegion.textContent).toContain('Refresh timeout')
    expect(
      findAll(cachedRegion, (n) => n.getAttribute('data-testid') === 'mock-diff')[0]?.getAttribute(
        'data-new',
      ),
    ).toBe('fresh-inline\n')

    // Conflicted row keeps its checkbox disabled, expands inline on click, and opens full diff tab on trailing button.
    expect(checkboxOf(container, 'src/conflict.ts').getAttribute('disabled')).toBe('')
    clickNode(rowActionOf(container, 'src/conflict.ts', 'pane.changes.openDiffTab'))
    expect(openChangeDiffMock).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: 2_000 }),
      conflictFile,
      null,
      { fromPanel: true },
    )
    expect(toggleButtonOf(container, 'src/conflict.ts').getAttribute('aria-expanded')).toBe('false')

    clickNode(toggleButtonOf(container, 'src/conflict.ts'))
    await flushReact()
    expect(toggleButtonOf(container, 'src/conflict.ts').getAttribute('aria-expanded')).toBe('true')
    expect(
      findAll(
        inlineDiffOf(container, 'src/conflict.ts')!,
        (n) => n.getAttribute('data-testid') === 'mock-diff',
      )[0]?.getAttribute('data-new'),
    ).toContain('<<<<<<< HEAD')
  })
})
