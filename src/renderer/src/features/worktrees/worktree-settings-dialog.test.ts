import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onHost } from '@renderer/lib/host-paths'
import { openWorktreeSettings, useWorktreeSettings } from './worktree-settings-model'

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
  return { hostMock: vi.fn() }
})

let terminalAllowed = true

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

vi.mock('@renderer/stores/hosts', () => ({
  useTerminalAllowed: () => terminalAllowed,
}))

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    createElement('div', { 'data-dialog': open ? 'open' : 'closed' }, open ? children : null),
  DialogContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => createElement('h2', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
  DialogClose: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    disabled,
    type,
    onClick,
  }: {
    children?: ReactNode
    disabled?: boolean
    type?: string
    onClick?: () => void
  }) => createElement('button', { type: type ?? 'button', disabled, onClick }, children),
}))

vi.mock('@renderer/components/ui/input', () => ({
  Input: ({ value, disabled }: { value?: string; disabled?: boolean }) =>
    createElement('input', { value, disabled }),
}))

vi.mock('@renderer/components/ui/textarea', () => ({
  Textarea: ({ value, disabled }: { value?: string; disabled?: boolean }) =>
    createElement('textarea', { value, disabled }),
}))

vi.mock('@renderer/components/ui/switch', () => ({
  Switch: ({ checked, disabled }: { checked?: boolean; disabled?: boolean }) =>
    createElement('button', { type: 'button', 'data-switch': String(!!checked), disabled }),
}))

vi.mock('@renderer/components/ui/skeleton', () => ({
  Skeleton: () => createElement('div', { 'data-skeleton': 'true' }),
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => createElement('span', null, 'spinner'),
}))

import { WorktreeSettingsDialog } from './worktree-settings-dialog'

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
  body: FakeNode
  defaultView: FakeWindow
  createElement(tag: string): FakeNode
  createElementNS(ns: string, tag: string): FakeNode
  createTextNode(text: string): FakeNode
  createComment(text: string): FakeNode
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
    const listeners = new Map<string, Set<(event: unknown) => void>>()
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
      addEventListener() {},
      removeEventListener() {},
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

  const fakeDoc: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as FakeNode,
    body: null as unknown as FakeNode,
    defaultView: null as unknown as FakeWindow,
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
    addEventListener() {},
    removeEventListener() {},
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

async function flushReact(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const HOST_A = 'a'.repeat(32)

describe('WorktreeSettingsDialog remote compatibility', () => {
  let root: Root | null = null
  let container: FakeNode

  beforeEach(() => {
    const dom = createFakeDom()
    container = dom.container
    vi.stubGlobal('window', Object.assign(dom.window, { kettu: { platform: 'darwin' } }))
    vi.stubGlobal('document', dom.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('SVGElement', dom.window.SVGElement)
    vi.stubGlobal('Element', dom.window.Element)
    vi.stubGlobal('Node', dom.window.Node)
    hostMock.mockReset()
    terminalAllowed = true
    useWorktreeSettings.setState({ shown: null })
  })

  afterEach(() => {
    if (root) {
      const mounted = root
      flushSync(() => mounted.unmount())
      root = null
    }
    useWorktreeSettings.setState({ shown: null })
    vi.unstubAllGlobals()
  })

  it('loads remote project worktree settings in read-only mode when remote terminal access is disallowed', async () => {
    terminalAllowed = false
    const remotePath = onHost(HOST_A, '/srv/app')
    hostMock.mockResolvedValueOnce({
      branchTemplate: 'kettu/{slug}',
      copy: ['.env'],
      setup: 'pnpm install',
      waitForSetup: true,
    })

    openWorktreeSettings({ path: remotePath, name: 'Remote App' })
    root = createRoot(container as unknown as Element)
    flushSync(() => {
      root!.render(createElement(WorktreeSettingsDialog))
    })
    await flushReact()

    expect(hostMock).toHaveBeenCalledWith('projects.worktreeSettings', { path: remotePath })
    expect(container.textContent).toContain('worktreeSettings.forbidden')
    const saveButton = findAll(
      container,
      (node) => node.tagName === 'BUTTON' && node.getAttribute('type') === 'submit',
    )[0]
    expect(saveButton?.getAttribute('disabled')).toBe('')
  })

  it('shows a clear unsupported message without Retry when an older remote host returns unknown_method', async () => {
    const remotePath = onHost(HOST_A, '/srv/legacy')
    hostMock.mockRejectedValueOnce(
      Object.assign(new Error('Unknown method: projects.worktreeSettings'), {
        code: 'unknown_method',
      }),
    )

    openWorktreeSettings({ path: remotePath, name: 'Legacy App' })
    root = createRoot(container as unknown as Element)
    flushSync(() => {
      root!.render(createElement(WorktreeSettingsDialog))
    })
    await flushReact()

    expect(container.textContent).toContain('worktreeSettings.unsupported')
    expect(container.textContent).not.toContain('common:actions.retry')
  })
})
