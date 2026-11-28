import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus } from '@shared/account'
import type { AgentStatus, Project, SessionSummary } from '@shared/agent-host'
import type { HostsStatus, HostStatus } from '@shared/remote/hosts'
import type {
  RemoteDelegationEntry as RemoteDelegationThreadEntry,
  ThreadState,
} from '@shared/thread'
import { onHost } from '@renderer/lib/host-paths'
import type { ExecuteCrossHostDelegationInput } from '../cross-host-delegation-tracker'

const {
  openSessionMock,
  learnSessionHostsMock,
  hostAtMock,
  mockProjectsState,
  mockAgentsState,
  mockSessionsState,
  mockHostsState,
  mockThreadsState,
} = vi.hoisted(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size
    },
  })
  return {
    openSessionMock: vi.fn<(sessionId: string, projectPath: string) => void>(),
    learnSessionHostsMock: vi.fn<(hostId: string, ids: readonly string[]) => void>(),
    hostAtMock:
      vi.fn<(hostId: string | null, method: string, params: unknown) => Promise<unknown>>(),
    mockProjectsState: {
      projects: [] as Project[],
      setAll: vi.fn(),
    },
    mockAgentsState: {
      byId: {} as Record<string, AgentStatus>,
      order: [] as string[],
      hosts: {} as Record<string, { byId: Record<string, AgentStatus>; order: string[] }>,
      loaded: true,
      refresh: vi.fn(async () => undefined),
    },
    mockSessionsState: {
      byId: {} as Record<string, SessionSummary>,
      upsert: vi.fn(),
    },
    mockHostsState: {
      status: null as HostsStatus | null,
      kept: [] as never[],
    },
    mockThreadsState: {
      replicas: {} as Record<string, { state: ThreadState | null }>,
    },
  }
})

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const normalized = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
      if (!values) return normalized
      return Object.entries(values).reduce(
        (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)),
        `${normalized} (${Object.entries(values)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(',')})`,
      )
    },
    i18n: { language: 'en' },
  }),
}))

vi.mock('@renderer/lib/i18n', () => ({
  currentLocale: () => 'en',
  i18n: {
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  },
}))

vi.mock('@renderer/lib/host', () => ({
  hostAt: (hostId: string | null, method: string, params: unknown) =>
    hostAtMock(hostId, method, params),
  learnSessionHosts: (hostId: string, ids: readonly string[]) => learnSessionHostsMock(hostId, ids),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

vi.mock('@renderer/stores/view', () => ({
  openSession: (sessionId: string, projectPath: string) => openSessionMock(sessionId, projectPath),
}))

vi.mock('@renderer/stores/projects', () => {
  const hook = <T>(selector: (s: typeof mockProjectsState) => T) => selector(mockProjectsState)
  hook.getState = () => mockProjectsState
  return {
    isProjectArchived: (project: Pick<Project, 'archivedAt'>) => project.archivedAt != null,
    useProjectsStore: hook,
  }
})

vi.mock('@renderer/stores/agents', () => {
  const hook = <T>(selector: (s: typeof mockAgentsState) => T) => selector(mockAgentsState)
  hook.getState = () => mockAgentsState
  return {
    agentsOn: (state: typeof mockAgentsState, hostId: string | null) =>
      hostId === null ? state : (state.hosts[hostId] ?? { byId: {}, order: [] }),
    readHostAgents: vi.fn(async () => undefined),
    useAgentsStore: hook,
  }
})

vi.mock('@renderer/stores/sessions', () => {
  const hook = <T>(selector: (s: typeof mockSessionsState) => T) => selector(mockSessionsState)
  hook.getState = () => mockSessionsState
  return {
    sessionTitle: (summary: Pick<SessionSummary, 'title'>) => summary.title?.trim() || 'Untitled',
    useSessionsStore: hook,
  }
})

vi.mock('@renderer/stores/hosts', () => {
  const hook = <T>(selector: (s: typeof mockHostsState) => T) => selector(mockHostsState)
  hook.getState = () => mockHostsState
  return {
    isAway: (connection: HostStatus['connection'] | null) =>
      connection !== null && connection.state !== 'online' && connection.state !== 'connecting',
    useOtherHost: (hostId: string | null) =>
      hostId === null ? null : (mockHostsState.status?.hosts?.find((h) => h.id === hostId) ?? null),
    useHostsStore: hook,
  }
})

vi.mock('@renderer/stores/threads', () => {
  const hook = <T>(selector: (s: typeof mockThreadsState) => T) => selector(mockThreadsState)
  hook.getState = () => mockThreadsState
  return {
    isFresh: () => false,
    useThreadsStore: hook,
  }
})

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? createElement('div', { 'data-dialog-root': '' }, children) : null,
  DialogContent: ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) =>
    createElement('div', rest, children),
  DialogHeader: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => createElement('h2', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    id,
    checked,
    disabled,
    onCheckedChange,
    ...rest
  }: {
    id?: string
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
    [k: string]: unknown
  }) =>
    createElement('button', {
      type: 'button',
      role: 'checkbox',
      id,
      'aria-checked': Boolean(checked),
      disabled,
      onClick: () => onCheckedChange?.(!checked),
      ...rest,
    }),
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: ({ agent }: { agent: string }) => createElement('span', { 'data-agent-mark': agent }),
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => createElement('span', { 'data-spinner': '' }),
}))

vi.mock('@renderer/features/settings/remote-parts', () => ({
  HostIcon: ({ platform }: { platform: string }) =>
    createElement('span', { 'data-host-icon': platform }),
  OnlineDot: () => createElement('span', { 'data-online-dot': '' }),
}))

vi.mock('@renderer/features/shell/project-icon', () => ({
  ProjectMark: () => createElement('span', { 'data-project-mark': '' }),
}))

import {
  buildOriginContextPreview,
  buildTargetSessionCreateParams,
  composeCrossHostPrompt,
  crossHostMenuState,
  defaultTargetAgentId,
  pairedHostTargets,
  selectDelegatableHostAgents,
  targetHostProjects,
} from './cross-host-delegation'
import { CrossHostDelegateDialog } from './cross-host-delegate-dialog'
import { RemoteDelegationEntry } from '../entries/remote-delegation-entry'

// Minimal DOM harness matching `delegation.test.ts` so React 19 `createRoot` tests run in node.
class FakeNodeBase {
  static readonly ELEMENT_NODE = 1
  static readonly TEXT_NODE = 3
  static readonly COMMENT_NODE = 8
  static readonly DOCUMENT_NODE = 9
}

class FakeElementBase extends FakeNodeBase {}
class FakeDocumentBase extends FakeNodeBase {}

class FakeDomNode extends FakeElementBase {
  nodeType: number
  nodeName: string
  tagName: string
  ownerDocument: FakeDocument
  parentNode: FakeDomNode | null = null
  childNodes: FakeDomNode[] = []
  attributes = new Map<string, string>()
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  listeners = new Map<string, Set<(event: unknown) => void>>()
  nodeValue: string | null = null
  disabled = false
  value = ''
  checked = false
  type = ''

  get defaultValue(): string {
    return this.value
  }
  set defaultValue(next: string) {
    this.value = String(next)
  }

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument) {
    super()
    this.nodeType = nodeType
    this.nodeName = nodeName.toUpperCase()
    this.tagName = this.nodeName
    this.ownerDocument = ownerDocument
  }

  get firstChild(): FakeDomNode | null {
    return this.childNodes[0] ?? null
  }
  get lastChild(): FakeDomNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }
  get nextSibling(): FakeDomNode | null {
    if (!this.parentNode) return null
    const i = this.parentNode.childNodes.indexOf(this)
    return i >= 0 ? (this.parentNode.childNodes[i + 1] ?? null) : null
  }
  get textContent(): string {
    if (this.nodeType === FakeNodeBase.TEXT_NODE) return this.nodeValue ?? ''
    return this.childNodes.map((child) => child.textContent).join('')
  }
  set textContent(next: string) {
    this.childNodes = []
    if (next) this.appendChild(this.ownerDocument.createTextNode(next))
  }

  appendChild(child: FakeDomNode): FakeDomNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }
  insertBefore(child: FakeDomNode, before: FakeDomNode | null): FakeDomNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    if (!before) return this.appendChild(child)
    const idx = this.childNodes.indexOf(before)
    child.parentNode = this
    if (idx === -1) this.childNodes.push(child)
    else this.childNodes.splice(idx, 0, child)
    return child
  }
  removeChild(child: FakeDomNode): FakeDomNode {
    const idx = this.childNodes.indexOf(child)
    if (idx >= 0) this.childNodes.splice(idx, 1)
    child.parentNode = null
    return child
  }
  setAttribute(name: string, value: string): void {
    const str = String(value)
    this.attributes.set(name, str)
    if (name === 'disabled') this.disabled = true
    if (name === 'value') this.value = str
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
      this.dataset[key] = str
    }
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
    if (name === 'disabled') this.disabled = false
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  dispatchEvent(event: Record<string, unknown>): boolean {
    const type = String(event.type)
    const evt = {
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      target: this as FakeDomNode,
      currentTarget: this as FakeDomNode | FakeDocument,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {},
      ...event,
    }
    const visit = (node: FakeDomNode | FakeDocument | null): void => {
      let current = node
      while (current) {
        evt.currentTarget = current
        const set = current.listeners.get(type)
        if (set) {
          for (const fn of [...set]) fn(evt)
        }
        if (!evt.bubbles) break
        current = current instanceof FakeDomNode ? current.parentNode : null
      }
    }
    visit(this)
    return !evt.defaultPrevented
  }
  click(): void {
    if (this.disabled) return
    this.dispatchEvent({ type: 'click', bubbles: true })
  }
  focus(): void {}
  findAll(predicate: (el: FakeDomNode) => boolean): FakeDomNode[] {
    const out: FakeDomNode[] = []
    const walk = (node: FakeDomNode) => {
      if (node.nodeType === FakeNodeBase.ELEMENT_NODE && predicate(node)) out.push(node)
      for (const child of node.childNodes) walk(child)
    }
    walk(this)
    return out
  }
  find(predicate: (el: FakeDomNode) => boolean): FakeDomNode | null {
    return this.findAll(predicate)[0] ?? null
  }
}

class FakeDocument extends FakeDocumentBase {
  nodeType = FakeNodeBase.DOCUMENT_NODE
  nodeName = '#document'
  documentElement: FakeDomNode
  head: FakeDomNode
  body: FakeDomNode
  defaultView: Record<string, unknown> | null = null
  listeners = new Map<string, Set<(event: unknown) => void>>()
  activeElement: FakeDomNode | null = null

  constructor() {
    super()
    this.documentElement = new FakeDomNode(FakeNodeBase.ELEMENT_NODE, 'html', this)
    this.head = new FakeDomNode(FakeNodeBase.ELEMENT_NODE, 'head', this)
    this.body = new FakeDomNode(FakeNodeBase.ELEMENT_NODE, 'body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.activeElement = this.body
  }
  createElement(tag: string): FakeDomNode {
    return new FakeDomNode(FakeNodeBase.ELEMENT_NODE, tag, this)
  }
  createElementNS(_ns: string, tag: string): FakeDomNode {
    return this.createElement(tag)
  }
  createTextNode(text: string): FakeDomNode {
    const node = new FakeDomNode(FakeNodeBase.TEXT_NODE, '#text', this)
    node.nodeValue = text
    return node
  }
  createComment(text: string): FakeDomNode {
    const node = new FakeDomNode(FakeNodeBase.COMMENT_NODE, '#comment', this)
    node.nodeValue = text
    return node
  }
  getElementById(id: string): FakeDomNode | null {
    return this.body.find((el) => el.getAttribute('id') === id)
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
}

function installFakeDom(): { doc: FakeDocument; container: FakeDomNode } {
  const doc = new FakeDocument()
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const win = {
    document: doc,
    navigator: { userAgent: 'vitest' },
    kettu: { platform: 'darwin' },
    HTMLElement: FakeElementBase,
    SVGElement: FakeElementBase,
    Element: FakeElementBase,
    Node: FakeNodeBase,
    Document: FakeDocumentBase,
    HTMLIFrameElement: FakeElementBase,
    HTMLInputElement: FakeDomNode,
    HTMLTextAreaElement: FakeDomNode,
    addEventListener: doc.addEventListener.bind(doc),
    removeEventListener: doc.removeEventListener.bind(doc),
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    },
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
  }
  doc.defaultView = win
  Object.assign(globalThis, {
    document: doc,
    window: win,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    Node: FakeNodeBase,
    Element: FakeElementBase,
    HTMLElement: FakeElementBase,
    SVGElement: FakeElementBase,
    Document: FakeDocumentBase,
    HTMLIFrameElement: FakeElementBase,
    HTMLInputElement: FakeDomNode,
    HTMLTextAreaElement: FakeDomNode,
  })
  return { doc, container }
}

const ACCOUNT_A = 'acct_aaaaaaaaaaaaaaaaaaaaaaaa'
const ACCOUNT_B = 'acct_bbbbbbbbbbbbbbbbbbbbbbbb'
const HOST_PC = '11111111111111111111111111111111'
const HOST_LINUX = '22222222222222222222222222222222'
const HOST_OTHER_ACCT = '33333333333333333333333333333333'
const HOST_SSH_UNLINKED = '44444444444444444444444444444444'
const HOST_REMOVED = '55555555555555555555555555555555'

function makeAccount(id: string): AccountStatus {
  return {
    state: 'signed-in',
    account: { id, email: 'dev@example.com', name: 'Dev' },
    plan: null,
    subscription: null,
    usage: null,
    points: 0,
  } as unknown as AccountStatus
}

function makeHostStatus(overrides: Partial<HostStatus> & { id: string; name: string }): HostStatus {
  return {
    publicKey: 'pk',
    platform: 'win32',
    version: '0.1.30',
    addresses: [],
    deviceName: 'MacBook',
    addedAt: 1_700_000_000_000,
    lastOnlineAt: 1_700_000_000_000,
    removed: false,
    account: ACCOUNT_A,
    connection: { state: 'online', relay: 'https://relay.kettu.sh' },
    ...overrides,
  }
}

function makeHostsStatus(hosts: HostStatus[]): HostsStatus {
  return {
    self: { name: 'MacBook Pro', platform: 'darwin', version: '0.1.30', model: 'Mac' },
    hosts,
    plainTextKey: false,
    keyFailed: false,
  }
}

function makeAgent(
  overrides: Partial<AgentStatus> & { id: AgentStatus['id']; name: string },
): AgentStatus {
  return {
    harnessId: overrides.harnessId ?? (overrides.id as AgentStatus['harnessId']),
    harnessName: overrides.harnessName ?? overrides.name,
    isDefault: true,
    registered: true,
    disabled: false,
    hidden: false,
    state: 'ready',
    signIn: 'signed-in',
    capabilities: {
      steering: false,
      context: false,
      liveContext: false,
      cancel: true,
      loadSession: true,
      resumeSession: true,
    },
    ...overrides,
  } as unknown as AgentStatus
}

function makeProject(overrides: Partial<Project> & { path: string; name: string }): Project {
  return {
    missing: false,
    openedAt: 1_700_000_000_000,
    ...overrides,
  } as Project
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 10))
}

/** Triggers React's synthetic `onChange` handler on a FakeDomNode `<textarea>` / `<input>`. */
function setFieldValue(node: FakeDomNode, next: string): void {
  node.value = next
  const reactPropsKey = Object.keys(node).find((key) => key.startsWith('__reactProps$'))
  const onChange = reactPropsKey
    ? (node as unknown as Record<string, { onChange?: (e: unknown) => void }>)[reactPropsKey]
        ?.onChange
    : undefined
  if (onChange) {
    flushSync(() => onChange({ target: node, currentTarget: node }))
  } else {
    flushSync(() => node.dispatchEvent({ type: 'input', bubbles: true }))
  }
}

describe('cross-host delegation pure helpers (#2581)', () => {
  it('filters paired computers strictly to the same Kettu account, excludes the origin host, and marks offline hosts disabled', () => {
    const hosts = makeHostsStatus([
      makeHostStatus({
        id: HOST_PC,
        name: 'Office PC',
        platform: 'win32',
        account: ACCOUNT_A,
        connection: { state: 'online', relay: 'https://relay.kettu.sh' },
      }),
      makeHostStatus({
        id: HOST_LINUX,
        name: 'Lab Linux',
        platform: 'linux',
        account: ACCOUNT_A,
        connection: { state: 'offline' },
      }),
      makeHostStatus({
        id: HOST_OTHER_ACCT,
        name: 'Colleague Mac',
        platform: 'darwin',
        account: ACCOUNT_B,
        connection: { state: 'online', relay: 'https://relay.kettu.sh' },
      }),
      makeHostStatus({
        id: HOST_SSH_UNLINKED,
        name: 'SSH Server',
        platform: 'linux',
        account: null,
        connection: { state: 'online', address: { host: '10.0.0.2', port: 4444 } },
      }),
      makeHostStatus({
        id: HOST_REMOVED,
        name: 'Old Laptop',
        platform: 'darwin',
        account: ACCOUNT_A,
        removed: true,
        connection: { state: 'stopped', reason: 'removed' },
      }),
    ])

    // From a local session (originHostId: null): shows only same-account paired remote hosts.
    const fromLocal = pairedHostTargets({
      accountStatus: makeAccount(ACCOUNT_A),
      hostsStatus: hosts,
      originHostId: null,
      isWebClient: false,
      selfName: 'This Mac',
      selfPlatform: 'darwin',
    })
    expect(fromLocal).toEqual([
      {
        hostId: HOST_PC,
        name: 'Office PC',
        platform: 'win32',
        availability: 'online',
        selectable: true,
      },
      {
        hostId: HOST_LINUX,
        name: 'Lab Linux',
        platform: 'linux',
        availability: 'offline',
        selectable: false,
      },
    ])

    // From a remote session on HOST_PC: excludes HOST_PC and offers this computer (null) + HOST_LINUX.
    const fromRemote = pairedHostTargets({
      accountStatus: makeAccount(ACCOUNT_A),
      hostsStatus: hosts,
      originHostId: HOST_PC,
      isWebClient: false,
      selfName: 'This Mac',
      selfPlatform: 'darwin',
    })
    expect(
      fromRemote.map((t) => ({ id: t.hostId, name: t.name, selectable: t.selectable })),
    ).toEqual([
      { id: null, name: 'MacBook Pro', selectable: true },
      { id: HOST_LINUX, name: 'Lab Linux', selectable: false },
    ])

    // Signed out or web client: no cross-host targets offered.
    expect(
      pairedHostTargets({
        accountStatus: { state: 'signed-out' } as AccountStatus,
        hostsStatus: hosts,
        originHostId: null,
        isWebClient: false,
        selfName: 'This Mac',
        selfPlatform: 'darwin',
      }),
    ).toEqual([])
    expect(
      pairedHostTargets({
        accountStatus: makeAccount(ACCOUNT_A),
        hostsStatus: hosts,
        originHostId: null,
        isWebClient: true,
        selfName: 'This Mac',
        selfPlatform: 'darwin',
      }),
    ).toEqual([])
  })

  it('hides the + menu entry with no paired hosts and disables it with an explanation when all paired hosts are offline', () => {
    expect(crossHostMenuState({ canDelegate: true, targets: [] })).toEqual({
      visible: false,
      disabled: false,
    })
    expect(
      crossHostMenuState({
        canDelegate: false,
        targets: [
          {
            hostId: HOST_PC,
            name: 'PC',
            platform: 'win32',
            availability: 'online',
            selectable: true,
          },
        ],
      }),
    ).toEqual({ visible: false, disabled: false })
    expect(
      crossHostMenuState({
        canDelegate: true,
        targets: [
          {
            hostId: HOST_LINUX,
            name: 'Lab Linux',
            platform: 'linux',
            availability: 'offline',
            selectable: false,
          },
        ],
      }),
    ).toEqual({ visible: true, disabled: true, reason: 'all_offline' })
    expect(
      crossHostMenuState({
        canDelegate: true,
        targets: [
          {
            hostId: HOST_PC,
            name: 'PC',
            platform: 'win32',
            availability: 'online',
            selectable: true,
          },
          {
            hostId: HOST_LINUX,
            name: 'Lab Linux',
            platform: 'linux',
            availability: 'offline',
            selectable: false,
          },
        ],
      }),
    ).toEqual({ visible: true, disabled: false })
  })

  it('never carries over options, permission mode, or parentId in target sessions.create params', () => {
    const params = buildTargetSessionCreateParams({
      agentId: 'codex',
      projectPath: onHost(HOST_PC, 'C:\\work\\app'),
      promptText: 'Run tests',
    })
    expect(params).toEqual({
      agentId: 'codex',
      projectPath: onHost(HOST_PC, 'C:\\work\\app'),
      prompt: [{ type: 'text', text: 'Run tests' }],
    })
    expect(Object.keys(params).sort()).toEqual(['agentId', 'projectPath', 'prompt'])
  })

  it('builds an explicit context preview and only appends context when the user opts in', () => {
    const thread = {
      session: { id: 's1' },
      order: ['u1', 'a1', 'u2'],
      byId: {
        u1: { kind: 'user', id: 'u1', content: [{ type: 'text', text: 'Check Windows CI' }] },
        a1: {
          kind: 'agent',
          id: 'a1',
          markdown: 'The packaging step fails on win32.',
          attachments: [],
          streaming: false,
        },
        u2: {
          kind: 'user',
          id: 'u2',
          content: [{ type: 'text', text: 'Report' }],
          from: {
            sessionId: 'c1',
            title: 'Child',
            ended: { agent: 'Codex', stopReason: 'end_turn' },
          },
        },
      },
    } as unknown as ThreadState

    const preview = buildOriginContextPreview(thread, {
      sessionTitle: 'Release prep',
      projectName: 'kettu',
    })
    expect(preview).toContain('Origin session: Release prep')
    expect(preview).toContain('Origin project: kettu')
    expect(preview).toContain('User: Check Windows CI')
    expect(preview).toContain('Assistant: The packaging step fails on win32.')
    expect(preview).not.toContain('Report')

    // Context omitted unless explicitly opted in.
    expect(
      composeCrossHostPrompt({
        task: 'Rebuild installer',
        includeContext: false,
        contextText: preview,
        originHostName: 'MacBook Pro',
        originSessionTitle: 'Release prep',
      }),
    ).toBe('Rebuild installer')

    // Context included with edited text when opted in.
    const withContext = composeCrossHostPrompt({
      task: 'Rebuild installer',
      includeContext: true,
      contextText: 'Only include the signing step.',
      originHostName: 'MacBook Pro',
      originSessionTitle: 'Release prep',
    })
    expect(withContext).toContain('Rebuild installer')
    expect(withContext).toContain('Shared context from MacBook Pro (Release prep):')
    expect(withContext).toContain('Only include the signing step.')
  })

  it('filters target host projects and delegatable agents accurately', () => {
    const projects = [
      makeProject({ path: onHost(HOST_PC, 'C:\\work\\active'), name: 'active' }),
      makeProject({
        path: onHost(HOST_PC, 'C:\\work\\archived'),
        name: 'archived',
        archivedAt: 1_700_000_000_000,
      }),
      makeProject({ path: '/Users/dev/local', name: 'local' }),
    ]
    expect(targetHostProjects(projects, HOST_PC).map((p) => p.name)).toEqual(['active'])

    const agents = selectDelegatableHostAgents({
      order: ['claude-code', 'codex', 'opencode', 'gemini'],
      byId: {
        'claude-code': makeAgent({ id: 'claude-code', name: 'Claude Code', state: 'ready' }),
        codex: makeAgent({ id: 'codex', name: 'Codex', state: 'installing' }),
        opencode: makeAgent({ id: 'opencode', name: 'OpenCode', state: 'not-installed' }),
        gemini: makeAgent({ id: 'gemini', name: 'Gemini CLI', state: 'ready', disabled: true }),
      },
    })
    expect(agents.map((a) => ({ id: a.id, state: a.state, selectable: a.selectable }))).toEqual([
      { id: 'claude-code', state: 'ready', selectable: true },
      { id: 'codex', state: 'installing', selectable: false },
    ])
    expect(defaultTargetAgentId(agents, 'codex')).toBe('claude-code')
  })
})

describe('CrossHostDelegateDialog & RemoteDelegationEntry UI (#2581)', () => {
  let container: FakeDomNode
  let root: Root

  beforeEach(() => {
    const dom = installFakeDom()
    container = dom.container
    root = createRoot(container as unknown as Element)
    openSessionMock.mockReset()
    learnSessionHostsMock.mockReset()
    hostAtMock.mockReset()
    mockProjectsState.projects = [
      makeProject({ path: onHost(HOST_PC, 'C:\\work\\app'), name: 'app' }),
      makeProject({ path: onHost(HOST_PC, 'C:\\work\\missing'), name: 'missing', missing: true }),
    ]
    mockAgentsState.hosts = {
      [HOST_PC]: {
        order: ['claude-code', 'codex'],
        byId: {
          'claude-code': makeAgent({ id: 'claude-code', name: 'Claude Code', state: 'ready' }),
          codex: makeAgent({ id: 'codex', name: 'Codex', state: 'installing' }),
        },
      },
    }
    mockSessionsState.byId = {}
    mockHostsState.status = makeHostsStatus([
      makeHostStatus({ id: HOST_PC, name: 'Office PC', platform: 'win32' }),
      makeHostStatus({
        id: HOST_LINUX,
        name: 'Lab Linux',
        platform: 'linux',
        connection: { state: 'offline' },
      }),
    ])
    mockThreadsState.replicas = {}
  })

  afterEach(() => {
    flushSync(() => root.unmount())
  })

  it('prefills draft, disables offline hosts & installing agents, opts into editable context, shows permission notice, and preserves draft on error', async () => {
    const loadHostData = vi.fn(async () => undefined)
    const runDelegation = vi
      .fn<(input: ExecuteCrossHostDelegationInput) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('Target host offline'))
      .mockResolvedValueOnce({ delegationId: 'del-1' })
    const onDelegated = vi.fn()
    const onOpenChange = vi.fn()

    const targets = [
      {
        hostId: HOST_PC,
        name: 'Office PC',
        platform: 'win32' as const,
        availability: 'online' as const,
        selectable: true,
      },
      {
        hostId: HOST_LINUX,
        name: 'Lab Linux',
        platform: 'linux' as const,
        availability: 'offline' as const,
        selectable: false,
      },
    ]

    flushSync(() => {
      root.render(
        createElement(CrossHostDelegateDialog, {
          open: true,
          onOpenChange,
          originSessionId: 'origin-1',
          originHostId: null,
          originHostName: 'MacBook Pro',
          originSessionTitle: 'Release prep',
          originAgentId: 'claude-code',
          originFullAccess: true,
          initialTask: 'Run Windows smoke tests',
          originContextPreview: 'Origin session: Release prep\nUser: Earlier detail',
          targets,
          onDelegated,
          loadHostData,
          runDelegation,
        }),
      )
    })
    await flushMicrotasks()

    expect(loadHostData).toHaveBeenCalledWith(HOST_PC)

    // Offline host & missing project & installing agent are explicitly disabled.
    const offlineHostBtn = container.find(
      (el) => el.getAttribute('data-cross-host-option') === HOST_LINUX,
    )
    expect(offlineHostBtn?.disabled).toBe(true)
    const missingProjectBtn = container.find(
      (el) => el.getAttribute('data-cross-host-project') === onHost(HOST_PC, 'C:\\work\\missing'),
    )
    expect(missingProjectBtn?.disabled).toBe(true)
    const installingAgentBtn = container.find(
      (el) => el.getAttribute('data-cross-host-agent') === 'codex',
    )
    expect(installingAgentBtn?.disabled).toBe(true)

    // Permission isolation notice and Full access warning are displayed.
    const permissionNote = container.find((el) =>
      el.attributes.has('data-cross-host-permission-note'),
    )
    expect(permissionNote?.textContent).toContain('crossHostDelegation.permissionNotice')
    expect(permissionNote?.textContent).toContain('crossHostDelegation.fullAccessNotCarried')

    // Draft task is prefilled; context checkbox is unchecked by default (no silent history).
    const taskBox = container.find((el) => el.attributes.has('data-cross-host-task'))!
    expect(taskBox.value).toBe('Run Windows smoke tests')
    expect(container.find((el) => el.attributes.has('data-cross-host-context'))).toBeNull()

    // First attempt fails -> error is shown, dialog stays open, onDelegated NOT called (draft preserved).
    const confirmBtn = container.find((el) => el.attributes.has('data-cross-host-confirm'))!
    flushSync(() => confirmBtn.click())
    await flushMicrotasks()

    expect(runDelegation).toHaveBeenCalledTimes(1)
    expect(runDelegation.mock.calls[0]![0].promptText).toBe('Run Windows smoke tests')
    expect(onDelegated).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    const errorBanner = container.find((el) => el.attributes.has('data-cross-host-error'))
    expect(errorBanner?.textContent).toContain('Target host offline')

    // User opts into context, edits it, and retries -> succeeds and sends reviewed context only.
    const contextCheckbox = container.find((el) =>
      el.attributes.has('data-cross-host-include-context'),
    )!
    flushSync(() => contextCheckbox.click())
    const contextBox = container.find((el) => el.attributes.has('data-cross-host-context'))!
    expect(contextBox.value).toContain('Origin session: Release prep')

    setFieldValue(contextBox, 'Edited context approved by user')

    flushSync(() => confirmBtn.click())
    await flushMicrotasks()

    expect(runDelegation).toHaveBeenCalledTimes(2)
    const secondCall = runDelegation.mock.calls[1]![0]
    expect(secondCall.targetHostId).toBe(HOST_PC)
    expect(secondCall.targetAgentId).toBe('claude-code')
    expect(secondCall.targetProjectPath).toBe(onHost(HOST_PC, 'C:\\work\\app'))
    expect(secondCall.promptText).toContain('Run Windows smoke tests')
    expect(secondCall.promptText).toContain('Edited context approved by user')
    expect(secondCall.promptText).not.toContain('Earlier detail')
    expect(onDelegated).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('renders started and report RemoteDelegationEntry cards and jumps directly to the remote session on click', () => {
    const started: RemoteDelegationThreadEntry = {
      kind: 'remote_delegation',
      id: 'rd:1',
      delegationId: 'del-jump-1',
      phase: 'started',
      targetHostId: HOST_PC,
      targetHostName: 'Office PC',
      targetHostPlatform: 'win32',
      targetSessionId: 'remote-sess-1',
      targetProjectPath: 'C:\\work\\app',
      targetProjectName: 'app',
      targetAgentId: 'claude-code',
      targetAgentName: 'Claude Code',
      targetTitle: 'Verify Windows build',
      at: Date.now(),
      after: null,
    }
    const report: RemoteDelegationThreadEntry = {
      ...started,
      id: 'rd:2',
      phase: 'report',
      outcome: 'failed',
      error: 'Build script exited with code 1',
    }
    mockThreadsState.replicas['origin-1'] = {
      state: {
        session: { id: 'origin-1' },
        order: ['rd:1', 'rd:2'],
        byId: { 'rd:1': started, 'rd:2': report },
      } as unknown as ThreadState,
    }

    flushSync(() => {
      root.render(
        createElement(
          'div',
          null,
          createElement(RemoteDelegationEntry, { sessionId: 'origin-1', entryId: 'rd:1' }),
          createElement(RemoteDelegationEntry, { sessionId: 'origin-1', entryId: 'rd:2' }),
        ),
      )
    })

    const startedBtn = container.find(
      (el) => el.getAttribute('data-remote-delegation-started') === 'del-jump-1',
    )!
    expect(startedBtn.textContent).toContain('Verify Windows build')
    expect(startedBtn.textContent).toContain('Office PC')

    const reportCard = container.find(
      (el) => el.getAttribute('data-remote-delegation-report') === 'del-jump-1',
    )!
    expect(reportCard.dataset.outcome).toBe('failed')
    expect(reportCard.textContent).toContain('Build script exited with code 1')

    const jumpBtn = reportCard.find((el) => el.tagName === 'BUTTON')!
    flushSync(() => jumpBtn.click())

    expect(learnSessionHostsMock).toHaveBeenCalledWith(HOST_PC, ['remote-sess-1'])
    expect(openSessionMock).toHaveBeenCalledWith('remote-sess-1', onHost(HOST_PC, 'C:\\work\\app'))
  })
})
