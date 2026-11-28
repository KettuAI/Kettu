import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  act,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import type { ContextReport } from '@shared/context'
import type { McpToolChanges, SessionMcpServer } from '@shared/mcp-insight'
import enCommon from '@shared/locales/en/common.json'
import enComposer from '@shared/locales/en/composer.json'
import type { SessionUsage } from '@shared/thread'

let mockMcpChanged: string[] | undefined = undefined
let mockMcpServers: SessionMcpServer[] = []
let mockContextReports: Record<string, ContextReport | undefined> = {}
let capturedPopoverContentProps: Record<string, unknown> | null = null
let capturedReviewDialogProps: {
  server: { id: string; title: string }
  changes: McpToolChanges | null
  open: boolean
  onOpenChange: (open: boolean) => void
} | null = null

const { mockCollisionPadding, mockHost, mockLoadContext, mockOpenMarketplace, mockRefreshLimits } =
  vi.hoisted(() => ({
    mockCollisionPadding: { top: 40, right: 5, bottom: 5, left: 5 },
    mockHost: vi.fn<(...args: unknown[]) => Promise<unknown>>(async (method: unknown) => {
      if (method === 'sessions.mcpServers') return mockMcpServers
      return undefined
    }),
    mockRefreshLimits: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    mockLoadContext: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    mockOpenMarketplace: vi.fn(),
  }))

function lookup(catalog: Record<string, unknown>, key: string): string {
  const value = key.split('.').reduce<unknown>((cur, part) => {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[part]
    }
    return undefined
  }, catalog)
  return typeof value === 'string' ? value : key
}

function translate(key: string, values?: Record<string, unknown>): string {
  const [ns, keyPath] = key.includes(':') ? key.split(':', 2) : ['composer', key]
  const catalog = (ns === 'common' ? enCommon : enComposer) as Record<string, unknown>
  let resolved = keyPath!
  if (values && typeof values.count === 'number') {
    const suffix = values.count === 1 ? '_one' : '_other'
    const plural = lookup(catalog, `${resolved}${suffix}`)
    if (plural !== `${resolved}${suffix}`) resolved = `${resolved}${suffix}`
  }
  let text = lookup(catalog, resolved)
  if (values) {
    for (const [name, val] of Object.entries(values)) {
      text = text.replaceAll(`{{${name}}}`, String(val))
    }
  }
  return text
}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: translate }),
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, unknown> }) =>
    createElement('span', null, translate(i18nKey, values)),
}))

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-mock': 'popover' }, children),
  PopoverTrigger: ({ children, render }: { children?: ReactNode; render?: ReactNode }) =>
    createElement(
      'div',
      { 'data-mock': 'popover-trigger' },
      isValidElement(render) ? cloneElement(render as ReactElement, {}, children) : children,
    ),
  PopoverContent: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    capturedPopoverContentProps = props
    return createElement(
      'div',
      { 'data-mock': 'popover-content', className: props.className },
      children,
    )
  },
}))

vi.mock('@renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-mock': 'dropdown-menu' }, children),
  DropdownMenuTrigger: ({ children, render }: { children?: ReactNode; render?: ReactNode }) =>
    isValidElement(render)
      ? cloneElement(render as ReactElement, {}, children)
      : createElement('button', { type: 'button' }, children),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-mock': 'dropdown-content' }, children),
  DropdownMenuItem: ({
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
      { type: 'button', 'data-mock': 'dropdown-item', disabled, onClick },
      children,
    ),
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  TooltipTrigger: ({ children, render }: { children?: ReactNode; render?: ReactNode }) =>
    createElement('span', null, render ?? children),
  TooltipContent: () => null,
}))

vi.mock('@renderer/components/ui/collapsible', () => ({
  Collapsible: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  CollapsibleTrigger: ({
    children,
    ...props
  }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement('button', { type: 'button', ...props }, children),
  CollapsibleContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement('button', { type: 'button', ...props }, children),
}))

vi.mock('@renderer/components/ui/skeleton', () => ({
  Skeleton: () => createElement('span', null),
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => createElement('span', { 'data-mock': 'spinner' }),
}))

vi.mock('@renderer/components/ui/toast', () => ({
  toast: vi.fn(),
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: () => createElement('span', { 'data-mock': 'agent-mark' }),
}))

vi.mock('@renderer/features/marketplace/mcp-tool-changes', () => ({
  McpToolChangesTag: ({ changes }: { changes: McpToolChanges }) =>
    createElement(
      'span',
      { className: 'k-mcp-held-tag', 'data-mock': 'mcp-held-tag' },
      `${changes.added.length + changes.changed.length} held`,
    ),
  McpToolChangesDialog: (props: {
    server: { id: string; title: string }
    changes: McpToolChanges | null
    open: boolean
    onOpenChange: (open: boolean) => void
  }) => {
    capturedReviewDialogProps = props
    return createElement('div', { 'data-mock': 'mcp-review-dialog' }, props.server.title)
  },
}))

vi.mock('@renderer/features/marketplace/model', () => ({
  itemKey: ({ kind, id }: { kind: string; id: string }) => `${kind}:${id}`,
}))

vi.mock('@renderer/features/marketplace/tiles', () => ({
  ItemTile: ({ subject }: { subject: { id: string } }) =>
    createElement('span', { 'data-mock': 'item-tile', 'data-id': subject.id }),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: ({ className }: { className?: string }) =>
    createElement('span', { 'data-mock': 'glyph', className }),
}))

vi.mock('@renderer/features/requests/icon', () => ({
  REQUESTS_ICON: 'requests',
}))

vi.mock('@renderer/features/requests/support', () => ({
  readsModelRequests: () => true,
}))

vi.mock('@renderer/features/prompt-cache/cache-phase', () => ({
  useCacheLeft: () => null,
  useCachePhase: () => null,
}))

vi.mock('@renderer/features/session/use-thread', () => ({
  useSessionView: () => undefined,
}))

vi.mock('@renderer/hooks/use-limit-view', () => ({
  useLimitView: () => 'used',
}))

vi.mock('@renderer/lib/use-now', () => ({
  useNow: () => 1_700_000_000_000,
}))

vi.mock('@renderer/lib/platform', () => ({
  menuCollisionPadding: mockCollisionPadding,
}))

vi.mock('@renderer/lib/host', () => ({
  errorMessage: (error: unknown) => String(error),
  host: (...args: unknown[]) => mockHost(...args),
  sessionHost: () => 'local',
}))

vi.mock('@renderer/stores/settings', () => ({
  useSettingsStore: {
    getState: () => ({ update: vi.fn() }),
  },
}))

vi.mock('@renderer/stores/threads', () => ({
  useThreadsStore: <T>(
    selector: (state: {
      replicas: Record<string, { state?: { session: { mcpChanged?: string[] } } }>
    }) => T,
  ) =>
    selector({
      replicas: {
        s1: {
          state: {
            session: {
              mcpChanged: mockMcpChanged,
            },
          },
        },
      },
    }),
}))

vi.mock('@renderer/stores/usage', () => ({
  loadContext: (...args: unknown[]) => mockLoadContext(...args),
  refreshLimits: (...args: unknown[]) => mockRefreshLimits(...args),
  useUsageStore: <T>(selector: (state: { context: typeof mockContextReports }) => T) =>
    selector({ context: mockContextReports }),
}))

vi.mock('@renderer/stores/view', () => ({
  openMarketplace: (...args: unknown[]) => mockOpenMarketplace(...args),
  toggleSidePane: vi.fn(),
}))

import { ContextButton } from './usage'

// Minimal DOM harness so React 19 `createRoot` interaction tests run directly in Node.
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
  type = ''

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument) {
    super()
    this.nodeType = nodeType
    this.nodeName = nodeName.toUpperCase()
    this.tagName = this.nodeName
    this.ownerDocument = ownerDocument
  }

  get className(): string {
    return this.attributes.get('class') ?? ''
  }
  set className(next: string) {
    this.attributes.set('class', String(next))
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
  hasClass(name: string): boolean {
    return this.className.split(/\s+/).includes(name)
  }
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

function installFakeDom(): { container: FakeDomNode } {
  const doc = new FakeDocument()
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const win = {
    document: doc,
    navigator: { userAgent: 'vitest' },
    HTMLElement: FakeElementBase,
    SVGElement: FakeElementBase,
    Element: FakeElementBase,
    Node: FakeNodeBase,
    Document: FakeDocumentBase,
    HTMLIFrameElement: FakeElementBase,
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
    IS_REACT_ACT_ENVIRONMENT: true,
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
  })
  return { container }
}

const BASE_USAGE: SessionUsage = {
  used: 120_000,
  size: 512_000,
  tokens: {
    total: 125_000,
    input: 20_000,
    output: 5_000,
    thought: null,
    cacheRead: 100_000,
    cacheWrite: null,
  },
  cost: null,
}

const ACCOUNT_WITH_PLAN: AgentAccount = {
  kind: 'account',
  label: 'Antigravity',
  email: null,
  tier: 'Pro',
}

const SAMPLE_LIMIT: PlanLimit = {
  window: 'five_hour',
  label: '5-hour',
  usedPercent: 42,
  resetsAt: 1_700_010_000_000,
  state: 'ok',
  observedAt: 1_700_000_000_000,
}

function makeServer(overrides: Partial<SessionMcpServer> = {}): SessionMcpServer {
  return {
    serverId: 'srv-github',
    name: 'github',
    title: 'GitHub',
    site: 'https://github.com',
    state: { state: 'running', instances: 1 },
    tools: 12,
    tokens: 1500,
    off: false,
    routed: true,
    ...overrides,
  }
}

function baseProps(
  overrides: Partial<Parameters<typeof ContextButton>[0]> = {},
): Parameters<typeof ContextButton>[0] {
  return {
    sessionId: 's1',
    agentId: 'antigravity',
    idle: true,
    closed: false,
    reports: true,
    direct: true,
    live: true,
    usage: BASE_USAGE,
    limits: [],
    holding: [],
    account: ACCOUNT_WITH_PLAN,
    model: 'Gemini 4 Neon',
    ...overrides,
  }
}

function renderContextButton(overrides: Partial<Parameters<typeof ContextButton>[0]> = {}): string {
  return renderToStaticMarkup(createElement(ContextButton, baseProps(overrides)))
}

let mountedRoot: Root | null = null

async function mountContextButton(
  overrides: Partial<Parameters<typeof ContextButton>[0]> = {},
): Promise<FakeDomNode> {
  const { container } = installFakeDom()
  mountedRoot = createRoot(container as unknown as Element)
  await act(async () => {
    mountedRoot!.render(createElement(ContextButton, baseProps(overrides)))
    await Promise.resolve()
  })
  return container
}

describe('ContextButton popover', () => {
  beforeEach(() => {
    mockMcpChanged = undefined
    mockMcpServers = []
    mockContextReports = {}
    capturedPopoverContentProps = null
    capturedReviewDialogProps = null
    mockHost.mockClear()
    mockRefreshLimits.mockClear()
    mockLoadContext.mockClear()
    mockOpenMarketplace.mockClear()
  })

  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => {
        mountedRoot?.unmount()
      })
      mountedRoot = null
    }
  })

  it('omits the MCP section when both mcpChanged and session servers are empty', async () => {
    mockMcpChanged = []
    mockMcpServers = []
    const root = await mountContextButton()

    expect(mockHost).toHaveBeenCalledWith('sessions.mcpServers', { sessionId: 's1' })
    expect(root.find((el) => el.hasClass('kettu-ctx__mcp'))).toBeNull()
    expect(root.textContent).not.toContain('MCP servers')
    expect(root.textContent).not.toContain('Manage')
    expect(root.textContent).not.toContain('Use now')
  })

  it('renders MCP servers collapsed by default and reveals server rows and actions when expanded', async () => {
    const held: McpToolChanges = {
      serverId: 'srv-local',
      guard: 'hold',
      added: ['dangerous_tool'],
      changed: [],
      removed: [],
      since: 1_700_000_000_000,
    }
    mockMcpServers = [
      makeServer(),
      makeServer({
        serverId: 'srv-off',
        name: 'linear',
        title: 'Linear',
        off: true,
        tools: 4,
        tokens: 800,
      }),
      makeServer({
        serverId: 'srv-auth',
        name: 'notion',
        title: 'Notion',
        state: { state: 'needs-sign-in' },
        tools: null,
        tokens: null,
      }),
      makeServer({
        serverId: 'srv-local',
        name: 'local-db',
        title: 'Local DB',
        site: null,
        project: true,
        changes: held,
        tools: 3,
        tokens: 400,
      }),
      makeServer({
        serverId: 'srv-err',
        name: 'broken',
        title: 'Broken',
        state: { state: 'error', reason: 'Connection refused', at: 1_700_000_000_000 },
        tools: null,
        tokens: null,
      }),
    ]

    const root = await mountContextButton()
    const head = root.find((el) => el.hasClass('kettu-ctx__mcp-head'))
    expect(head).not.toBeNull()

    const toggle = head!.find((el) => el.hasClass('kettu-ctx__mcp-toggle'))
    const manage = head!.find((el) => el.hasClass('kettu-ctx__mcp-manage'))
    expect(toggle).not.toBeNull()
    expect(manage).not.toBeNull()
    expect(toggle!.tagName).toBe('BUTTON')
    expect(manage!.tagName).toBe('BUTTON')
    // Ensure Manage is a sibling of the toggle, never nested inside another button.
    expect(toggle!.find((el) => el.tagName === 'BUTTON' && el !== toggle)).toBeNull()
    expect(toggle!.getAttribute('aria-expanded')).toBe('false')
    expect(toggle!.getAttribute('aria-controls')).toBeTruthy()
    expect(toggle!.textContent).toContain('MCP servers')
    expect(toggle!.textContent).toContain('5')

    // List and rows stay hidden until expanded.
    expect(root.find((el) => el.hasClass('kettu-ctx__mcp-list'))).toBeNull()
    expect(root.findAll((el) => el.hasClass('kettu-ctx__mcp-row'))).toHaveLength(0)

    // Clicking Manage from the collapsed header opens the MCP tab.
    await act(async () => {
      manage!.click()
    })
    expect(mockOpenMarketplace).toHaveBeenCalledWith({ tab: 'mcp', hostId: 'local' })

    // Expanding reveals the list with matching aria-controls id and all rows.
    await act(async () => {
      toggle!.click()
    })
    expect(toggle!.getAttribute('aria-expanded')).toBe('true')

    const list = root.find((el) => el.hasClass('kettu-ctx__mcp-list'))
    expect(list).not.toBeNull()
    expect(list!.getAttribute('id')).toBe(toggle!.getAttribute('aria-controls'))

    const rows = list!.findAll((el) => el.hasClass('kettu-ctx__mcp-row'))
    expect(rows).toHaveLength(5)

    // Connected server shows status, tool count, tokens/turn, and dropdown actions.
    expect(rows[0]!.textContent).toContain('github')
    expect(rows[0]!.textContent).toContain('Connected · 12 tools')
    expect(rows[0]!.textContent).toContain('~1.5K tokens / turn')
    const reconnectBtn = rows[0]!.find((el) => el.textContent === 'Reconnect')
    const turnOffBtn = rows[0]!.find((el) => el.textContent === 'Turn off for this session')
    const openPageBtn = rows[0]!.find((el) => el.textContent === 'Open server page')
    expect(reconnectBtn).not.toBeNull()
    expect(turnOffBtn).not.toBeNull()
    expect(openPageBtn).not.toBeNull()

    await act(async () => {
      reconnectBtn!.click()
      await Promise.resolve()
    })
    expect(mockHost).toHaveBeenCalledWith('sessions.mcpServer', {
      sessionId: 's1',
      serverId: 'srv-github',
      action: 'reconnect',
    })

    await act(async () => {
      turnOffBtn!.click()
      await Promise.resolve()
    })
    expect(mockHost).toHaveBeenCalledWith('sessions.mcpServer', {
      sessionId: 's1',
      serverId: 'srv-github',
      action: 'off',
    })

    await act(async () => {
      openPageBtn!.click()
    })
    expect(mockOpenMarketplace).toHaveBeenCalledWith({ item: 'mcp:srv-github', hostId: 'local' })

    // Off server shows Turn on action.
    expect(rows[1]!.textContent).toContain('Off for this session')
    const turnOnBtn = rows[1]!.find((el) => el.textContent === 'Turn on')
    expect(turnOnBtn).not.toBeNull()
    await act(async () => {
      turnOnBtn!.click()
      await Promise.resolve()
    })
    expect(mockHost).toHaveBeenCalledWith('sessions.mcpServer', {
      sessionId: 's1',
      serverId: 'srv-off',
      action: 'on',
    })

    // Needs-sign-in server shows Sign in action linking to its server page.
    expect(rows[2]!.textContent).toContain('Needs sign-in')
    const signInBtn = rows[2]!.find((el) => el.textContent === 'Sign in')
    expect(signInBtn).not.toBeNull()
    await act(async () => {
      signInBtn!.click()
    })
    expect(mockOpenMarketplace).toHaveBeenCalledWith({ item: 'mcp:srv-auth', hostId: 'local' })

    // Project server with held tool changes shows tag and Review action opening the dialog.
    expect(rows[3]!.textContent).toContain('This project’s')
    expect(rows[3]!.find((el) => el.getAttribute('data-mock') === 'mcp-held-tag')).not.toBeNull()
    const reviewBtn = rows[3]!.find((el) => el.textContent === 'Review')
    expect(reviewBtn).not.toBeNull()
    await act(async () => {
      reviewBtn!.click()
    })
    expect(capturedReviewDialogProps?.server).toEqual({ id: 'srv-local', title: 'Local DB' })
    expect(capturedReviewDialogProps?.changes).toEqual(held)
    expect(capturedReviewDialogProps?.open).toBe(true)

    // Error server shows its failure reason.
    expect(rows[4]!.textContent).toContain('Connection refused')

    // Collapsing again hides the server rows.
    await act(async () => {
      toggle!.click()
    })
    expect(toggle!.getAttribute('aria-expanded')).toBe('false')
    expect(root.find((el) => el.hasClass('kettu-ctx__mcp-list'))).toBeNull()
  })

  it('shows an attention dot on the collapsed header for active error, needs-sign-in, or held changes', async () => {
    // Healthy active servers produce no attention dot.
    mockMcpServers = [
      makeServer({ state: { state: 'running', instances: 1 } }),
      makeServer({ serverId: 'srv-2', name: 'docs', state: { state: 'idle' } }),
    ]
    let root = await mountContextButton()
    expect(root.find((el) => el.hasClass('kettu-ctx__mcp-dot'))).toBeNull()

    // Error, sign-in, and held states on off servers are ignored.
    await act(async () => {
      mountedRoot?.unmount()
      mountedRoot = null
    })
    mockMcpServers = [
      makeServer({
        serverId: 'srv-off-err',
        off: true,
        state: { state: 'error', reason: 'Boom', at: 1_700_000_000_000 },
      }),
      makeServer({
        serverId: 'srv-off-auth',
        off: true,
        state: { state: 'needs-sign-in' },
      }),
      makeServer({
        serverId: 'srv-off-held',
        off: true,
        project: true,
        changes: {
          serverId: 'srv-off-held',
          guard: 'hold',
          added: ['x'],
          changed: [],
          removed: [],
          since: 1_700_000_000_000,
        },
      }),
    ]
    root = await mountContextButton()
    expect(root.find((el) => el.hasClass('kettu-ctx__mcp-dot'))).toBeNull()

    // Needs-sign-in on an active server yields a warn dot while collapsed.
    await act(async () => {
      mountedRoot?.unmount()
      mountedRoot = null
    })
    mockMcpServers = [makeServer({ state: { state: 'needs-sign-in' } })]
    root = await mountContextButton()
    let dot = root.find((el) => el.hasClass('kettu-ctx__mcp-dot'))
    expect(dot).not.toBeNull()
    expect(dot!.getAttribute('data-tone')).toBe('warn')

    // Held project tool changes on an active server also yield a warn dot while collapsed.
    await act(async () => {
      mountedRoot?.unmount()
      mountedRoot = null
    })
    mockMcpServers = [
      makeServer({
        project: true,
        changes: {
          serverId: 'srv-github',
          guard: 'hold',
          added: [],
          changed: ['list_issues'],
          removed: [],
          since: 1_700_000_000_000,
        },
      }),
    ]
    root = await mountContextButton()
    dot = root.find((el) => el.hasClass('kettu-ctx__mcp-dot'))
    expect(dot).not.toBeNull()
    expect(dot!.getAttribute('data-tone')).toBe('warn')

    // Active error takes precedence over warn and disappears once expanded.
    await act(async () => {
      mountedRoot?.unmount()
      mountedRoot = null
    })
    mockMcpServers = [
      makeServer({ serverId: 'srv-auth', state: { state: 'needs-sign-in' } }),
      makeServer({
        serverId: 'srv-err',
        state: { state: 'error', reason: 'Timed out', at: 1_700_000_000_000 },
      }),
    ]
    root = await mountContextButton()
    dot = root.find((el) => el.hasClass('kettu-ctx__mcp-dot'))
    expect(dot).not.toBeNull()
    expect(dot!.getAttribute('data-tone')).toBe('error')

    const toggle = root.find((el) => el.hasClass('kettu-ctx__mcp-toggle'))
    await act(async () => {
      toggle!.click()
    })
    expect(root.find((el) => el.hasClass('kettu-ctx__mcp-dot'))).toBeNull()
  })

  it('keeps the Use now notice visible outside the collapsed list when mcpChanged is non-empty', async () => {
    mockMcpChanged = ['github', 'linear']
    mockMcpServers = [makeServer()]

    const root = await mountContextButton({ idle: true })
    const toggle = root.find((el) => el.hasClass('kettu-ctx__mcp-toggle'))
    expect(toggle!.getAttribute('aria-expanded')).toBe('false')
    expect(root.find((el) => el.hasClass('kettu-ctx__mcp-list'))).toBeNull()

    const notice = root.find((el) => el.hasClass('kettu-ctx__mcp-notice'))
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain(
      'github, linear were added or changed since this session started.',
    )

    const useNow = notice!.find((el) => el.hasClass('kettu-ctx__mcp-use'))
    expect(useNow).not.toBeNull()
    expect(useNow!.disabled).toBe(false)
    await act(async () => {
      useNow!.click()
      await Promise.resolve()
    })
    expect(mockHost).toHaveBeenCalledWith('sessions.applyMcp', { sessionId: 's1' })

    // While a turn is running, Use now is disabled with an explanatory title.
    const busyHtml = renderContextButton({ idle: false })
    expect(busyHtml).toContain('kettu-ctx__mcp-notice')
    expect(busyHtml).toContain('disabled=""')
    expect(busyHtml).toContain('Available once the turn ends')
  })

  it('hides PlanLimits when limits is empty even if account.kind is account', () => {
    const emptyLimitsHtml = renderContextButton({
      account: ACCOUNT_WITH_PLAN,
      limits: [],
    })
    expect(emptyLimitsHtml).not.toContain('kettu-ctx__plan')
    expect(emptyLimitsHtml).not.toContain('Plan limits')

    const withLimitsHtml = renderContextButton({
      account: ACCOUNT_WITH_PLAN,
      limits: [SAMPLE_LIMIT],
    })
    expect(withLimitsHtml).toContain('kettu-ctx__plan')
    expect(withLimitsHtml).toContain('Plan limits')

    const apiKeyHtml = renderContextButton({
      account: { kind: 'api_key', label: 'API key', email: null },
      limits: [SAMPLE_LIMIT],
    })
    expect(apiKeyHtml).not.toContain('kettu-ctx__plan')
  })

  it('preserves popover overflow scrolling rules and bounds the expanded MCP server list', () => {
    renderContextButton()
    expect(capturedPopoverContentProps?.collisionPadding).toEqual(mockCollisionPadding)
    expect(String(capturedPopoverContentProps?.className)).toContain(
      'max-h-[calc(var(--available-height)-8px)]',
    )
    expect(String(capturedPopoverContentProps?.className)).toContain('overflow-y-auto')
    expect(String(capturedPopoverContentProps?.className)).toContain('overscroll-contain')

    const css = readFileSync(
      path.resolve(import.meta.dirname, '../../../styles/affect.css'),
      'utf8',
    )
    const ctxBlock = /\.kettu-ctx\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(ctxBlock).toContain('flex: none;')

    const partsBlock = /\.kettu-ctx__parts\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(partsBlock).not.toContain('max-height:')
    expect(partsBlock).not.toContain('overflow-y:')

    const partItemsBlock = /\.kettu-ctx__part-items\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(partItemsBlock).toContain('max-height: calc(6 * 20px + 4px);')
    expect(partItemsBlock).toContain('overflow-y: auto;')
    expect(partItemsBlock).toContain('overscroll-behavior: contain;')

    const partItemRowBlock = /\.kettu-ctx__part-items\s*>\s*li\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(partItemRowBlock).toContain('flex: none;')

    const mcpListBlock = /\.kettu-ctx__mcp-list\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(mcpListBlock).toContain('max-height: calc(5 * 36px + 8px);')
    expect(mcpListBlock).toContain('overflow-y: auto;')
    expect(mcpListBlock).toContain('overscroll-behavior: contain;')

    const mcpRowBlock = /\.kettu-ctx__mcp-row\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(mcpRowBlock).toContain('flex: none;')
  })
})
