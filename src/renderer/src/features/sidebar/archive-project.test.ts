import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SessionSummary } from '@shared/agent-host'
import { createLayout, openBeside } from '@renderer/features/split/layout'
import { newSessionProject } from '@renderer/features/split/new-session-project'
import { activeProjects, useProjectsStore } from '@renderer/stores/projects'
import { sidebarTabStop, useSessionsStore, visibleOrder } from '@renderer/stores/sessions'
import { openSession, useViewStore } from '@renderer/stores/view'
import type { WorkItem } from './running-work'

const { hostMock, toastMock, workAtStakeMock } = vi.hoisted(() => {
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
    workAtStakeMock: vi.fn<(ids: readonly string[]) => Promise<WorkItem[]>>(),
  }
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

vi.mock('@renderer/components/ui/toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}))

vi.mock('./running-work', () => ({
  workAtStake: (ids: readonly string[]) => workAtStakeMock(ids),
}))

vi.mock('./running-work-list', () => ({
  RunningWorkList: ({ items }: { items: WorkItem[] }) =>
    createElement('ul', { 'data-work-count': String(items.length) }),
}))

vi.mock('@renderer/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    createElement('div', { 'data-alert-dialog': open ? 'open' : 'closed' }, open ? children : null),
  AlertDialogContent: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  AlertDialogHeader: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  AlertDialogTitle: ({ children }: { children: ReactNode }) => createElement('h2', null, children),
  AlertDialogDescription: ({ children }: { children: ReactNode }) =>
    createElement('p', null, children),
  AlertDialogFooter: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  AlertDialogCancel: ({ children }: { children: ReactNode }) =>
    createElement('button', { type: 'button', 'data-action': 'cancel' }, children),
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) =>
    createElement('button', { type: 'button', 'data-action': 'confirm', onClick }, children),
}))

import { archiveProject, unarchiveProject } from '@renderer/app/actions'
import { ArchiveProjectDialog } from './archive-project'

// Minimal DOM implementation so React 19's real client reconciler (createRoot +
// useSyncExternalStore snapshot stability checks) runs under Vitest's node environment.
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
  dispatchEvent(event: { type: string; target?: FakeNode; currentTarget?: FakeNode }): boolean
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
  preventDefault(): void {
    this.defaultPrevented = true
  }
  stopPropagation(): void {}
}

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
  attributes = new Map<string, string>()
  listeners = new Map<string, Set<(event: unknown) => void>>();
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

  dispatchEvent(event: { type: string; target?: FakeNode; currentTarget?: FakeNode }): boolean {
    event.target = this
    for (let cur: FakeNode | null = event.target; cur; cur = cur.parentNode) {
      event.currentTarget = cur
      for (const fn of [...(cur.listeners.get(event.type) ?? [])]) fn(event)
    }
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

  const docListeners = new Map<string, Set<(event: unknown) => void>>()
  const doc: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as FakeNode,
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
    addEventListener(type: string, fn: (event: unknown) => void) {
      let set = docListeners.get(type)
      if (!set) {
        set = new Set()
        docListeners.set(type, set)
      }
      set.add(fn)
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      docListeners.get(type)?.delete(fn)
    },
  }
  doc.documentElement = makeNode('html', 1, doc)
  doc.body = makeNode('body', 1, doc)
  doc.documentElement.appendChild(doc.body)

  const win: FakeWindow = {
    document: doc,
    navigator: { userAgent: '' },
    HTMLElement: FakeElementBase,
    SVGElement: FakeElementBase,
    Element: FakeElementBase,
    Node: FakeNodeBase,
    Document: FakeDocumentBase,
    HTMLIFrameElement: FakeElementBase,
    Event: FakeEvent,
    addEventListener() {},
    removeEventListener() {},
  }
  Object.assign(win, { kettu: { platform: 'darwin' } })
  doc.defaultView = win
  return { window: win, document: doc }
}

function findNode(root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode | null {
  if (predicate(root)) return root
  for (const child of root.childNodes) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

function clickReactButton(node: FakeNode): void {
  const propsKey = Object.keys(node).find((key) => key.startsWith('__reactProps$'))
  const props = propsKey ? (node[propsKey] as { onClick?: () => void } | undefined) : undefined
  expect(props?.onClick).toBeTypeOf('function')
  props!.onClick!()
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

function makeSession(
  overrides: Partial<SessionSummary> & { id: string; projectPath: string },
): SessionSummary {
  return {
    agentId: 'claude-code',
    scratch: false,
    title: overrides.id,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 10,
    updatedAt: 20,
    parentId: null,
    origin: 'user',
    routine: null,
    task: null,
    description: null,
    branch: null,
    missing: false,
    pr: null,
    cache: null,
    model: null,
    pinnedAt: null,
    archivedAt: null,
    acpSessionId: null,
    ...overrides,
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('ArchiveProjectDialog and archiveProject (#2938)', () => {
  let root: Root | null = null
  let container: FakeNode
  let uncaughtErrors: unknown[] = []
  let prevWindow: unknown
  let prevDocument: unknown
  let prevNode: unknown
  let prevHTMLElement: unknown
  let prevSVGElement: unknown
  let prevElement: unknown
  let prevEvent: unknown
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    const dom = createFakeDom()
    prevWindow = globalThis.window
    prevDocument = globalThis.document
    prevNode = globalThis.Node
    prevHTMLElement = globalThis.HTMLElement
    prevSVGElement = globalThis.SVGElement
    prevElement = globalThis.Element
    prevEvent = globalThis.Event

    Object.assign(globalThis, {
      window: dom.window,
      document: dom.document,
      Node: dom.window.Node,
      HTMLElement: dom.window.HTMLElement,
      SVGElement: dom.window.SVGElement,
      Element: dom.window.Element,
      Event: dom.window.Event,
    })

    uncaughtErrors = []
    container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    root = createRoot(container as unknown as Element, {
      onUncaughtError(error) {
        uncaughtErrors.push(error)
      },
    })

    hostMock.mockReset()
    toastMock.mockReset()
    workAtStakeMock.mockReset()
    workAtStakeMock.mockResolvedValue([])
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    useProjectsStore.setState({
      projects: [],
      noProjects: {},
      loaded: true,
      error: null,
    })
    useSessionsStore.setState({
      byId: {},
      loaded: true,
      error: null,
    })
    useViewStore.setState({
      newSessionDraft: null,
      projectPath: null,
      main: { kind: 'new', agentId: null, noProject: false },
      layout: createLayout(),
      visiblePanes: [],
      settings: { open: false, section: null, item: null },
      collapsedProjects: {},
      expandedParents: {},
    })

    hostMock.mockImplementation(async (method: string, params: { path: string }) => {
      const current = useProjectsStore.getState().projects.find((p) => p.path === params.path)
      if (!current) throw new Error(`Unknown project ${params.path}`)
      if (method === 'projects.archive') {
        return { ...current, pinnedAt: null, archivedAt: 1000 }
      }
      if (method === 'projects.unarchive') {
        return { ...current, archivedAt: null, lastOpenedAt: 2000 }
      }
      throw new Error(`Unexpected host call ${method}`)
    })
  })

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root!.unmount()
      })
      root = null
    }
    expect(uncaughtErrors).toEqual([])
    consoleErrorSpy.mockRestore()
    Object.assign(globalThis, {
      window: prevWindow,
      document: prevDocument,
      Node: prevNode,
      HTMLElement: prevHTMLElement,
      SVGElement: prevSVGElement,
      Element: prevElement,
      Event: prevEvent,
    })
  })

  it('mounts ArchiveProjectDialog without triggering React error #185 (infinite getSnapshot loop)', async () => {
    const alpha = makeProject({ path: '/work/alpha', name: 'Alpha' })
    const beta = makeProject({ path: '/work/beta', name: 'Beta' })
    const s1 = makeSession({ id: 's-1', projectPath: '/work/alpha', status: 'running' })
    const s2 = makeSession({ id: 's-2', projectPath: '/work/alpha', status: 'ready' })
    const sBeta = makeSession({ id: 's-beta', projectPath: '/work/beta', status: 'ready' })

    useProjectsStore.setState({ projects: [alpha, beta] })
    useSessionsStore.setState({ byId: { [s1.id]: s1, [s2.id]: s2, [sBeta.id]: sBeta } })

    const onOpenChange = vi.fn()
    expect(() => {
      flushSync(() => {
        root!.render(
          createElement(ArchiveProjectDialog, {
            project: alpha,
            open: true,
            onOpenChange,
          }),
        )
      })
    }).not.toThrow()

    await flushMicrotasks()

    expect(workAtStakeMock).toHaveBeenCalledTimes(1)
    expect(workAtStakeMock).toHaveBeenCalledWith(['s-1', 's-2'])
    expect(container.textContent).toContain('project.archive.title:{"name":"Alpha"}')
    expect(container.textContent).toContain('project.archive.sessions:{"count":2}')

    // An unrelated session change in another project must not re-query running work or loop.
    flushSync(() => {
      useSessionsStore.setState((state) => ({
        byId: {
          ...state.byId,
          's-beta-2': makeSession({ id: 's-beta-2', projectPath: '/work/beta' }),
        },
      }))
    })
    await flushMicrotasks()
    expect(workAtStakeMock).toHaveBeenCalledTimes(1)

    // No React getSnapshot or Maximum update depth warnings/errors.
    const reactErrors = consoleErrorSpy.mock.calls.map((args: unknown[]) =>
      args.map(String).join(' '),
    )
    expect(
      reactErrors.some(
        (msg: string) => msg.includes('getSnapshot') || msg.includes('Maximum update depth'),
      ),
    ).toBe(false)
  })

  it('archives the active session project cleanly and transitions to New session on the next active project', async () => {
    const alpha = makeProject({ path: '/work/alpha', name: 'Alpha' })
    const beta = makeProject({ path: '/work/beta', name: 'Beta' })
    const sAlpha = makeSession({ id: 's-alpha', projectPath: '/work/alpha' })
    const sBeta = makeSession({ id: 's-beta', projectPath: '/work/beta' })

    useProjectsStore.setState({ projects: [alpha, beta] })
    useSessionsStore.setState({ byId: { [sAlpha.id]: sAlpha, [sBeta.id]: sBeta } })
    openSession(sAlpha.id, alpha.path)

    let dialogOpen = true
    const renderDialog = () => {
      flushSync(() => {
        root!.render(
          createElement(ArchiveProjectDialog, {
            project: alpha,
            open: dialogOpen,
            onOpenChange: (next) => {
              dialogOpen = next
              renderDialog()
            },
          }),
        )
      })
    }

    renderDialog()
    const confirm = findNode(container, (node) => node.getAttribute('data-action') === 'confirm')
    expect(confirm).not.toBeNull()

    clickReactButton(confirm!)
    await flushMicrotasks()

    expect(dialogOpen).toBe(false)
    expect(hostMock).toHaveBeenCalledWith('projects.archive', { path: '/work/alpha' })
    expect(activeProjects(useProjectsStore.getState().projects).map((p) => p.path)).toEqual([
      '/work/beta',
    ])

    const view = useViewStore.getState()
    expect(view.projectPath).toBe('/work/beta')
    expect(view.main.kind).toBe('new')
    expect(
      visibleOrder(
        { main: view.main, collapsedProjects: {}, expandedParents: {} },
        useSessionsStore.getState().byId,
        useProjectsStore.getState().projects,
      ),
    ).toEqual(['s-beta'])
  })

  it('archives the last remaining active project without leaving stale selection or crashing', async () => {
    const only = makeProject({ path: '/work/only', name: 'Only' })
    const sOnly = makeSession({ id: 's-only', projectPath: '/work/only' })

    useProjectsStore.setState({ projects: [only] })
    useSessionsStore.setState({ byId: { [sOnly.id]: sOnly } })
    useViewStore.setState({
      projectPath: only.path,
      newSessionDraft: {
        kind: 'new',
        agentId: null,
        noProject: false,
        projectPath: only.path,
      },
    })
    openSession(sOnly.id, only.path)

    flushSync(() => {
      root!.render(
        createElement(ArchiveProjectDialog, {
          project: only,
          open: true,
          onOpenChange: () => {},
        }),
      )
    })

    await archiveProject(only.path)

    const projects = useProjectsStore.getState().projects
    const view = useViewStore.getState()
    expect(activeProjects(projects)).toEqual([])
    expect(view.projectPath).toBeNull()
    expect(view.newSessionDraft?.projectPath ?? null).toBeNull()
    expect(view.main.kind).toBe('new')
    expect(
      newSessionProject(
        { kind: 'new', agentId: null, noProject: false, projectPath: view.projectPath },
        view.projectPath,
        projects,
      ),
    ).toBeNull()
    expect(
      sidebarTabStop(
        { main: view.main, collapsedProjects: {}, expandedParents: {} },
        useSessionsStore.getState().byId,
        projects,
      ),
    ).toBeNull()
  })

  it('archives a non-active project without disturbing the open session and closes split panes cleanly', async () => {
    const alpha = makeProject({ path: '/work/alpha', name: 'Alpha' })
    const beta = makeProject({ path: '/work/beta', name: 'Beta' })
    const sAlpha = makeSession({ id: 's-alpha', projectPath: '/work/alpha' })
    const sBeta = makeSession({ id: 's-beta', projectPath: '/work/beta' })

    useProjectsStore.setState({ projects: [alpha, beta] })
    useSessionsStore.setState({ byId: { [sAlpha.id]: sAlpha, [sBeta.id]: sBeta } })
    openSession(sBeta.id, beta.path)

    await archiveProject(alpha.path)

    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: sBeta.id })
    expect(useViewStore.getState().projectPath).toBe(beta.path)

    // Restoring alpha and re-opening the archive dialog also stays stable.
    await unarchiveProject(alpha.path)
    expect(activeProjects(useProjectsStore.getState().projects).map((p) => p.path)).toEqual([
      '/work/alpha',
      '/work/beta',
    ])

    expect(() => {
      flushSync(() => {
        root!.render(
          createElement(ArchiveProjectDialog, {
            project: useProjectsStore.getState().projects[0]!,
            open: true,
            onOpenChange: () => {},
          }),
        )
      })
    }).not.toThrow()
  })

  it('leaves the last split pane cleanly when every pane in a split belongs to the archived project', async () => {
    const alpha = makeProject({ path: '/work/alpha', name: 'Alpha' })
    const beta = makeProject({ path: '/work/beta', name: 'Beta' })
    const s1 = makeSession({ id: 's-1', projectPath: '/work/alpha' })
    const s2 = makeSession({ id: 's-2', projectPath: '/work/alpha' })

    useProjectsStore.setState({ projects: [alpha, beta] })
    useSessionsStore.setState({ byId: { [s1.id]: s1, [s2.id]: s2 } })
    openSession(s1.id, alpha.path)
    useViewStore.setState((s) => ({
      layout: openBeside(
        s.layout,
        {
          kind: 'session',
          sessionId: s2.id,
          projectPath: alpha.path,
        },
        'right',
        { width: 1400, height: 900 },
      )!,
      main: { kind: 'session', sessionId: s2.id },
    }))

    await archiveProject(alpha.path)

    const view = useViewStore.getState()
    expect(view.main.kind).toBe('new')
    expect(view.projectPath).toBe('/work/beta')
  })
})
