import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, ImportableSession, Project, SessionSummary } from '@shared/agent-host'
import { onHost } from '@renderer/lib/host-paths'
import { useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { sameFolder } from './import-sessions-model'

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

vi.mock('@hugeicons/react', () => ({
  HugeiconsIcon: () => null,
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: () => null,
}))

vi.mock('@renderer/components/segmented-control', () => ({
  SegmentedControl: ({
    value,
    onChange,
    segments,
  }: {
    value: string
    onChange: (value: string) => void
    segments: { value: string; label: string }[]
  }) =>
    createElement(
      'div',
      { 'data-scope-control': value },
      segments.map((segment) =>
        createElement(
          'button',
          {
            key: segment.value,
            type: 'button',
            'data-scope-option': segment.value,
            onClick: () => onChange(segment.value),
          },
          segment.label,
        ),
      ),
    ),
}))

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    createElement('div', { 'data-dialog': open ? 'open' : 'closed' }, open ? children : null),
  DialogContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => createElement('h2', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
}))

vi.mock('@renderer/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-target-select': 'true' }, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    createElement('button', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  SelectGroup: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  SelectItem: ({
    value,
    title,
    children,
  }: {
    value: string
    title?: string
    children?: ReactNode
  }) => createElement('div', { 'data-select-item': value, title }, children),
}))

vi.mock('@renderer/components/ui/tabs', () => ({
  Tabs: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TabsList: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TabsTrigger: ({ value, children }: { value: string; children?: ReactNode }) =>
    createElement('button', { type: 'button', 'data-agent-tab': value }, children),
  TabsContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    disabled,
    onCheckedChange,
  }: {
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (on: boolean) => void
  }) =>
    createElement('button', {
      type: 'button',
      'data-checkbox': checked ? 'checked' : 'unchecked',
      disabled,
      onClick: () => onCheckedChange?.(!checked),
    }),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode
    disabled?: boolean
    onClick?: () => void
  }) => createElement('button', { type: 'button', disabled, onClick }, children),
}))

import { ImportSessionsDialog } from './import-sessions'

// Minimal DOM implementation so React 19's client reconciler runs under Vitest's node environment.
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
  dispatchEvent(event: {
    type: string
    target?: FakeNode | null
    currentTarget?: FakeNode | null
  }): boolean
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
  Event: typeof FakeEvent
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
class FakeEvent {
  type: string
  bubbles = true
  cancelable = true
  defaultPrevented = false
  target: FakeNode | null = null
  currentTarget: FakeNode | null = null
  constructor(type: string) {
    this.type = type
  }
  preventDefault() {
    this.defaultPrevented = true
  }
  stopPropagation() {}
  stopImmediatePropagation() {}
}

function createFakeDom(): { window: FakeWindow; document: FakeDocument; container: FakeNode } {
  const docListeners = new Map<string, Set<(event: unknown) => void>>()
  const winListeners = new Map<string, Set<(event: unknown) => void>>()

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
      addEventListener(type, fn) {
        let set = listeners.get(type)
        if (!set) listeners.set(type, (set = new Set()))
        set.add(fn)
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn)
      },
      dispatchEvent(event) {
        event.target ??= node
        const path: FakeNode[] = []
        let cur: FakeNode | null = node
        while (cur) {
          path.push(cur)
          cur = cur.parentNode
        }
        for (const el of path) {
          event.currentTarget = el
          for (const fn of el.listeners.get(event.type) ?? []) fn(event)
        }
        for (const fn of docListeners.get(event.type) ?? []) fn(event)
        return true
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
    addEventListener(type, fn) {
      let set = docListeners.get(type)
      if (!set) docListeners.set(type, (set = new Set()))
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
    Event: FakeEvent,
    addEventListener(type, fn) {
      let set = winListeners.get(type)
      if (!set) winListeners.set(type, (set = new Set()))
      set.add(fn)
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn)
    },
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
const HOST_B = 'b'.repeat(32)

function makeAgent(
  id: AgentStatus['id'],
  name: string,
  capabilities: Partial<AgentStatus['capabilities']> = {},
): AgentStatus {
  return {
    id,
    harnessId: id,
    name,
    isDefault: true,
    state: 'ready',
    version: '1.0.0',
    capabilities: {
      listSessions: true,
      ...capabilities,
    },
  } as unknown as AgentStatus
}

function makeProject(overrides: Partial<Project> & { path: string; name: string }): Project {
  return {
    missing: false,
    lastOpenedAt: 100,
    pinnedAt: null,
    archivedAt: null,
    order: null,
    ...overrides,
  }
}

describe('sameFolder across local and remote hosts', () => {
  it('matches host-qualified POSIX and Windows paths on the same host and separates different hosts', () => {
    expect(sameFolder('/work/app/', '/work/app')).toBe(true)
    expect(sameFolder(onHost(HOST_A, '/srv/app/'), onHost(HOST_A, '/srv/app'))).toBe(true)
    expect(sameFolder(onHost(HOST_A, 'C:\\Work\\App\\'), onHost(HOST_A, 'c:/work/app'))).toBe(true)
    expect(sameFolder(onHost(HOST_A, '/srv/app'), onHost(HOST_B, '/srv/app'))).toBe(false)
    expect(sameFolder('/srv/app', onHost(HOST_A, '/srv/app'))).toBe(false)
  })
})

describe('ImportSessionsDialog host scoping for remote projects', () => {
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
    vi.stubGlobal('Event', dom.window.Event)
    hostMock.mockReset()
    useAgentsStore.setState({ byId: {}, order: [], hosts: {}, loaded: true })
    useProjectsStore.setState({ projects: [], noProjects: {}, loaded: true, error: null })
    useSessionsStore.setState({ byId: {}, loaded: true, error: null })
  })

  afterEach(() => {
    if (root) {
      const mounted = root
      flushSync(() => mounted.unmount())
      root = null
    }
    vi.unstubAllGlobals()
  })

  it('lists and imports sessions using the remote host agents and projects without mixing local or archived projects', async () => {
    const localProject = makeProject({ path: '/work/local', name: 'Local Repo' })
    const remoteProject = makeProject({
      path: onHost(HOST_A, '/srv/api'),
      name: 'Remote API',
    })
    const remotePeer = makeProject({
      path: onHost(HOST_A, '/srv/web'),
      name: 'Remote Web',
    })
    const remoteArchived = makeProject({
      path: onHost(HOST_A, '/srv/old'),
      name: 'Old Archived',
      archivedAt: 50,
    })
    const otherHostProject = makeProject({
      path: onHost(HOST_B, '/srv/other'),
      name: 'Other Host App',
    })

    useProjectsStore.setState({
      projects: [localProject, remoteProject, remotePeer, remoteArchived, otherHostProject],
    })
    useAgentsStore.setState({
      byId: { 'claude-code': makeAgent('claude-code', 'Local Claude') },
      order: ['claude-code'],
      hosts: {
        [HOST_A]: {
          byId: {
            codex: makeAgent('codex', 'Remote Codex', { listSessions: true }),
          },
          order: ['codex'],
        },
      },
    })

    const listedSessions: ImportableSession[] = [
      {
        acpSessionId: 'remote-1',
        title: 'Remote task one',
        updatedAt: '2026-11-27T00:00:00Z',
        imported: false,
        cwd: '/srv/api',
      },
      {
        acpSessionId: 'remote-2',
        title: 'Already in peer project',
        updatedAt: '2026-11-27T00:00:00Z',
        imported: true,
        cwd: '/srv/web',
        importedProjectPath: onHost(HOST_A, '/srv/web'),
      },
    ]

    hostMock.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'agents.listSessions') {
        return Promise.resolve({ sessions: listedSessions, nextCursor: null })
      }
      if (method === 'sessions.import') {
        const req = params as {
          agentId: SessionSummary['agentId']
          projectPath: string
          acpSessionId: string
        }
        return Promise.resolve({
          id: 'session-remote-imported',
          agentId: req.agentId,
          projectPath: req.projectPath,
          acpSessionId: req.acpSessionId,
          title: 'Remote task one',
          status: 'ready',
          createdAt: 1,
          updatedAt: 2,
          parentId: null,
          origin: 'user',
          scratch: false,
          attention: 'none',
          permissionCount: 0,
          archivedAt: null,
          pinnedAt: null,
          missing: false,
          pr: null,
          cache: null,
          model: null,
          routine: null,
          task: null,
          description: null,
          branch: null,
        } satisfies SessionSummary)
      }
      return Promise.reject(new Error(`Unexpected method ${method}`))
    })

    const onOpenChange = vi.fn()
    root = createRoot(container as unknown as Element)
    flushSync(() => {
      root!.render(
        createElement(ImportSessionsDialog, {
          project: remoteProject,
          open: true,
          onOpenChange,
        }),
      )
    })
    await flushReact()

    // Only the remote host's agent was queried, routed by the remote project path, without allFolders.
    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('agents.listSessions', {
      agentId: 'codex',
      projectPath: remoteProject.path,
    })

    // Agent rail shows only the remote host's agent, never the local Claude agent.
    const tabs = findAll(container, (node) => node.getAttribute('data-agent-tab') !== null)
    expect(tabs.map((node) => node.getAttribute('data-agent-tab'))).toEqual(['codex'])

    // Target selector lists only active, non-missing projects on HOST_A, with raw hostPath tooltips.
    const selectItems = findAll(container, (node) => node.getAttribute('data-select-item') !== null)
    expect(
      selectItems.map((node) => ({
        value: node.getAttribute('data-select-item'),
        title: node.getAttribute('title'),
      })),
    ).toEqual([
      { value: remoteProject.path, title: '/srv/api' },
      { value: remotePeer.path, title: '/srv/web' },
    ])

    // Same-folder cwd is hidden for remote-1, while peer project's custom name resolves for remote-2.
    expect(container.textContent).not.toContain('/srv/api')
    expect(container.textContent).toContain('import.importedIn:{"project":"Remote Web"}')

    // Selecting the importable session and clicking Import calls sessions.import with remote path.
    const checkboxes = findAll(container, (node) => node.getAttribute('data-checkbox') !== null)
    expect(checkboxes.length).toBeGreaterThanOrEqual(2)
    flushSync(() => {
      checkboxes[1]!.dispatchEvent(new FakeEvent('click'))
    })

    const importButton = findAll(
      container,
      (node) => node.tagName === 'BUTTON' && node.textContent.startsWith('import.importCount'),
    )[0]
    expect(importButton).toBeDefined()
    flushSync(() => {
      importButton!.dispatchEvent(new FakeEvent('click'))
    })
    await flushReact()

    expect(hostMock).toHaveBeenCalledWith('sessions.import', {
      agentId: 'codex',
      projectPath: remoteProject.path,
      acpSessionId: 'remote-1',
    })
    expect(useSessionsStore.getState().byId['session-remote-imported']?.projectPath).toBe(
      remoteProject.path,
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
