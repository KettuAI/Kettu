import { createElement, forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentStatus,
  DelegateAgentsResult,
  DelegateTargetAgent,
  SessionSummary,
} from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import type { ComposerAddSection } from '@renderer/components/affect/chat-composer'

const { hostMock, localStorageMap } = vi.hoisted(() => {
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
    hostMock: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
    localStorageMap: storage,
  }
})

let mockAgentsById: Record<string, AgentStatus> = {}
let mockAgentsOrder: string[] = []
let mockAgentsLoaded = true
let mockUpsertedSessions: SessionSummary[] = []
let capturedAddMenu: { sections: ComposerAddSection[]; onAttach?: (id: string) => void } | null =
  null
let capturedPlaceholder = ''
let capturedEditorKeyDown: ((event: KeyboardEvent) => boolean) | null = null
let mockEditorText = ''

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

vi.mock('@base-ui/react/popover', () => ({
  Popover: {
    Root: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? createElement('div', { 'data-popover-root': '' }, children) : null,
    Portal: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Positioner: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Popup: ({ children, ...rest }: { children?: ReactNode; [key: string]: unknown }) => {
      const attrs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rest)) {
        if (k.startsWith('data-') || k === 'className') attrs[k] = v
      }
      return createElement('div', attrs, children)
    },
  },
}))

vi.mock('@renderer/lib/host', () => ({
  host: (method: string, params: unknown) => hostMock(method, params),
  hostAt: (_hostId: string | null, method: string, params: unknown) => hostMock(method, params),
  artifactHost: () => null,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

vi.mock('@renderer/lib/platform', () => ({
  formatShortcut: (s: string) => s,
  isMac: true,
  isMod: (e: { metaKey?: boolean; ctrlKey?: boolean }) => !!(e.metaKey || e.ctrlKey),
  isWeb: false,
  menuCollisionPadding: 8,
}))

vi.mock('@renderer/stores/agents', () => ({
  agentsOn: () => ({ byId: mockAgentsById, order: mockAgentsOrder }),
  useAgentsStore: <T>(selector: (state: unknown) => T) =>
    selector({
      byId: mockAgentsById,
      order: mockAgentsOrder,
      hosts: {},
      loaded: mockAgentsLoaded,
    }),
  usePlanReadings: () => new Map(),
  agentName: (agentId: string) => mockAgentsById[agentId]?.name ?? agentId,
}))

vi.mock('@renderer/stores/sessions', () => {
  const state = {
    byId: {} as Record<string, SessionSummary>,
    upsert: (summary: SessionSummary) => {
      mockUpsertedSessions.push(summary)
      state.byId[summary.id] = summary
    },
  }
  const hook = <T>(selector: (s: typeof state) => T) => selector(state)
  hook.getState = () => state
  return {
    hostOfSession: () => null,
    useSessionsStore: hook,
  }
})

vi.mock('@renderer/stores/overlays', () => ({
  useOverlayPresence: () => undefined,
}))

vi.mock('@renderer/stores/browser', () => ({
  useBrowserStore: (selector: (s: { bySession: Record<string, never> }) => unknown) =>
    selector({ bySession: {} }),
}))

vi.mock('@renderer/stores/view', () => ({
  shownSidePane: () => null,
  artifactShown: () => false,
  panelSession: () => null,
  useViewStore: (selector: (s: { main: { kind: string; sessionId: string } }) => unknown) =>
    selector({ main: { kind: 'session', sessionId: 'parent-1' } }),
}))

vi.mock('@renderer/stores/artifacts', () => ({
  setPaneSelection: vi.fn(),
  artifactListShown: vi.fn(),
  artifactStanding: () => 'live',
  useArtifactsStore: (
    selector: (s: {
      paneSelection: null
      list: never[]
      hidden: Set<string>
      hostsRead: string[]
      awayLists: Record<string, never[]>
    }) => unknown,
  ) =>
    selector({
      paneSelection: null,
      list: [],
      hidden: new Set(),
      hostsRead: [],
      awayLists: {},
    }),
}))

vi.mock('@renderer/stores/tasks', () => ({
  taskFrom: () => null,
  useTasksStore: (selector: (s: { summaries: never[] }) => unknown) => selector({ summaries: [] }),
}))

vi.mock('@renderer/stores/workflow-suggestions', () => {
  const state = { editing: {}, byId: {}, stopEditing: vi.fn() }
  const hook = <T>(selector: (s: typeof state) => T) => selector(state)
  hook.getState = () => state
  return { useSuggestionsStore: hook }
})

vi.mock('@renderer/stores/agent-options', () => {
  const state = { local: {}, hosts: {} }
  const hook = <T>(selector: (s: typeof state) => T) => selector(state)
  hook.getState = () => state
  return {
    optionsOn: () => ({}),
    useAgentOptionsStore: hook,
  }
})

vi.mock('@renderer/stores/agent-switch', () => {
  const state = { pending: {} as Record<string, unknown> }
  const hook = <T>(selector: (s: typeof state) => T) => selector(state)
  hook.getState = () => state
  return {
    setPendingSwitch: vi.fn(),
    updatePendingSwitch: vi.fn(),
    useAgentSwitchStore: hook,
  }
})

vi.mock('@renderer/stores/settings', () => ({
  useSettingsStore: (
    selector: (s: {
      settings: {
        general: { sendKey: string; runningSend: string }
        thread: { promptCacheDropNotice: boolean }
      }
    }) => unknown,
  ) =>
    selector({
      settings: {
        general: { sendKey: 'enter', runningSend: 'queue' },
        thread: { promptCacheDropNotice: false },
      },
    }),
}))

vi.mock('@renderer/stores/threads', () => ({
  showSending: () => () => {},
  suppressSuggestion: () => () => {},
  useThreadsStore: (selector: (s: { replicas: Record<string, never> }) => unknown) =>
    selector({ replicas: {} }),
}))

vi.mock('@renderer/stores/reply-comments', () => ({
  commentsOf: () => [],
  keepComments: vi.fn(),
  removeComments: vi.fn(),
  useReplyComments: () => [],
}))

vi.mock('@renderer/stores/side-chat', () => ({
  askSide: vi.fn(),
  openSideChat: vi.fn(),
  sideQuestionOf: () => null,
}))

vi.mock('@renderer/stores/git', () => {
  const state = { status: {} as Record<string, never> }
  const hook = (selector: (s: typeof state) => unknown) => selector(state)
  hook.getState = () => state
  hook.subscribe = () => () => {}
  return {
    rememberReferenceSummary: vi.fn(),
    useGitStore: hook,
  }
})

vi.mock('@renderer/stores/kettu-commands', () => ({
  loadKettuCommands: vi.fn(),
}))

vi.mock('@renderer/stores/projects', () => ({
  useProjectsStore: (selector: (s: { projects: never[] }) => unknown) => selector({ projects: [] }),
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: ({ agent }: { agent: string }) => createElement('span', { 'data-agent-mark': agent }),
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => createElement('span', { 'data-spinner': '' }),
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  TooltipTrigger: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  TooltipContent: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: () => createElement('span', { 'data-glyph': '' }),
}))

vi.mock('@renderer/features/shell/narrow', () => ({
  usePhoneWindow: () => false,
}))

vi.mock('@renderer/features/split/pane-context', () => ({
  usePane: () => ({ paneId: 'pane-1', focused: true }),
}))

vi.mock('@renderer/lib/session-folder', () => ({
  useSessionFolder: () => '/repo',
}))

vi.mock('@renderer/features/prompt-cache/cache-phase', () => ({
  useCachePhase: () => 'fresh',
}))

vi.mock('@renderer/features/git/git-status', () => ({
  BranchTrayLink: () => null,
}))

vi.mock('@renderer/features/session/new-session/agent-menu', () => ({
  AgentMenu: () => null,
}))

vi.mock('@renderer/features/session/new-session/prepared', () => ({
  readFirstOptions: vi.fn(),
}))

vi.mock('@renderer/features/session/new-session/start-options', () => ({
  startConfig: () => [],
}))

vi.mock('@renderer/features/sidebar/running-work', () => ({
  runningWorkOf: async () => [],
  workItems: () => [],
}))

vi.mock('@renderer/features/artifacts/selection-chip', () => ({
  SelectionChip: () => null,
}))

vi.mock('./editor', () => ({
  ComposerEditor: forwardRef(function MockComposerEditor(
    props: {
      initialText: string
      placeholder: string
      onChange: (next: string) => void
      onKeyDown: (event: KeyboardEvent) => boolean
    },
    ref,
  ) {
    capturedPlaceholder = props.placeholder
    capturedEditorKeyDown = props.onKeyDown
    const textRef = useRef(props.initialText)
    mockEditorText = textRef.current
    useImperativeHandle(ref, () => ({
      text: () => textRef.current,
      setText: (next: string) => {
        textRef.current = next
        mockEditorText = next
      },
      selection: () => ({ from: textRef.current.length, to: textRef.current.length }),
      insert: (chunk: string) => {
        textRef.current += chunk
        mockEditorText = textRef.current
        props.onChange(textRef.current)
      },
      focus: () => {},
      rectOf: () => null,
      scrollElement: () => null,
    }))
    return createElement('input', {
      'data-mock-editor': '',
      value: textRef.current,
      placeholder: props.placeholder,
      onChange: (event: { target: { value: string } }) => {
        textRef.current = event.target.value
        mockEditorText = textRef.current
        props.onChange(event.target.value)
      },
    })
  }),
}))

vi.mock('@renderer/components/affect/chat-composer', () => ({
  ChatComposer: ({
    field,
    addSections,
    onAttach,
    send,
    foot,
  }: {
    field?: ReactNode
    addSections?: ComposerAddSection[]
    onAttach?: (id: string) => void
    send?: ReactNode
    foot?: ReactNode
  }) => {
    capturedAddMenu = { sections: addSections ?? [], onAttach }
    return createElement(
      'div',
      { 'data-chat-composer': '' },
      field,
      createElement('div', { 'data-send-slot': '' }, send),
      foot,
    )
  },
}))

vi.mock('./send-button', () => ({
  SendButton: ({
    disabled,
    label,
    onClick,
  }: {
    disabled?: boolean
    label: string
    onClick?: () => void
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        'data-send-button': '',
        'aria-label': label,
        disabled: !!disabled,
        onClick,
      },
      label,
    ),
  QueueButton: () => createElement('button', { type: 'button', 'data-queue-button': '' }, 'Queue'),
  StopButton: () => createElement('button', { type: 'button', 'data-stop-button': '' }, 'Stop'),
}))

vi.mock('./artifact-picker', () => ({
  ArtifactPickerPopover: () => null,
  AttachedArtifactChips: () => null,
}))

vi.mock('./browser-annotation-chips', () => ({
  BrowserAnnotationChips: () => null,
}))

vi.mock('./attachment-tray', () => ({
  AttachmentTray: () => null,
}))

vi.mock('./prompt-chips', () => ({
  usePromptChips: () => ({
    chipContext: {},
    hidden: new Set(),
    overlays: null,
    keyDown: () => false,
  }),
}))

vi.mock('./use-mention-list', () => ({
  useMentionList: () => ({ files: null, rows: [], noProject: false, used: false }),
}))

vi.mock('./use-plugin-mentions', () => ({
  usePluginMentions: () => ({ groups: [], rows: [], starts: [], visible: false }),
}))

vi.mock('./use-github-ref-picker', () => ({
  useGitHubRefPicker: () => ({ rows: [], loading: false, searching: false, error: null }),
}))

vi.mock('./use-slash-commands', () => ({
  useSlashCommands: () => [],
}))

vi.mock('./use-out-of-credit', () => ({
  useOutOfCredit: () => null,
}))

vi.mock('./usage', () => ({
  CacheButton: () => null,
  ContextButton: () => null,
}))

vi.mock('./speed', () => ({
  SpeedButton: () => null,
}))

vi.mock('./session-place', () => ({
  SessionPlace: () => null,
}))

vi.mock('./affect-styles', () => ({
  TrayStyles: () => null,
}))

vi.mock('./resize-grip', () => ({
  ResizeGrip: () => null,
}))

vi.mock('./comment-list', () => ({
  CommentList: () => null,
}))

vi.mock('./model-menu', () => ({
  ModelMenu: () => null,
}))

vi.mock('./switch-confirm', () => ({
  SwitchConfirm: () => null,
}))

vi.mock('../attachments/text-dialog', () => ({
  TextDialog: () => null,
}))

import { clearDraft, flushDraft, readDraft, readDraftDelegateTarget, writeDraft } from './drafts'
import {
  canOfferDelegation,
  draftDelegateTarget,
  filterDelegateAgents,
  firstSelectableIndex,
  hydrateDraftDelegateTarget,
  isDelegatableAgentStatus,
  moveSelectableHighlight,
  restoreDraftDelegateTarget,
  setDraftDelegateTarget,
} from './delegation'
import { DelegateAgentPickerPopover, DelegateRecipientChip } from './delegate-picker'
import { Composer } from './composer'

// Minimal DOM stub so React 19's client reconciler runs interactive components under Vitest node.
class FakeNodeBase {
  static ELEMENT_NODE = 1
  static TEXT_NODE = 3
  static COMMENT_NODE = 8
  static DOCUMENT_NODE = 9
}

class FakeElementBase extends FakeNodeBase {}
class FakeDocumentBase extends FakeNodeBase {}

class FakeDomNode extends FakeElementBase {
  nodeType: number
  nodeName: string
  tagName?: string
  namespaceURI?: string
  nodeValue?: string
  childNodes: FakeDomNode[] = []
  parentNode: FakeDomNode | null = null
  ownerDocument: FakeDocument | null
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  listeners = new Map<string, Set<(event: unknown) => void>>()
  value = ''
  disabled = false

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument | null) {
    super()
    this.nodeType = nodeType
    this.nodeName = nodeName
    if (nodeType === FakeNodeBase.ELEMENT_NODE) {
      this.tagName = nodeName.toUpperCase()
      this.namespaceURI = 'http://www.w3.org/1999/xhtml'
    }
    this.ownerDocument = ownerDocument
  }

  get textContent(): string {
    if (this.nodeType === FakeNodeBase.TEXT_NODE) return this.nodeValue ?? ''
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.childNodes = []
    if (value) this.appendChild(this.ownerDocument!.createTextNode(value))
  }

  appendChild(child: FakeDomNode): FakeDomNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child: FakeDomNode, before: FakeDomNode | null): FakeDomNode {
    if (!before) return this.appendChild(child)
    if (child.parentNode) child.parentNode.removeChild(child)
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

  focus(): void {}
  scrollIntoView(): void {}
  contains(node: FakeDomNode | null): boolean {
    let cur = node
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
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
  })
  return { doc, container }
}

function agentStatus(overrides: Partial<AgentStatus> & { id: AgentStatus['id'] }): AgentStatus {
  return {
    name: overrides.id,
    harnessId: 'codex',
    harnessName: 'Codex',
    isDefault: true,
    registered: true,
    hidden: false,
    disabled: false,
    apiKey: null,
    state: 'ready',
    version: '1.0.0',
    package: null,
    signIn: 'signed-in',
    authMethods: [],
    canLogout: false,
    account: null,
    limits: [],
    detail: null,
    installUrl: null,
    progress: [],
    launchCommand: '',
    binaryOverride: null,
    binaryCommand: null,
    update: null,
    updateCheckedAt: null,
    updateSkipped: false,
    task: null,
    installMethods: [],
    cli: null,
    configDir: null,
    kettuServer: { runs: true, active: true },
    capabilities: {
      loadSession: true,
      listSessions: true,
      resumeSession: true,
      closeSession: true,
      deleteSession: true,
      forkSession: true,
      forkAtMessage: false,
      steering: false,
      reports: false,
      context: false,
      liveContext: false,
      account: false,
      mcpHttp: true,
      prompt: { image: false, audio: false, embeddedContext: false },
    },
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 'parent-1',
    agentId: 'claude-code',
    projectPath: '/repo',
    acpSessionId: 'acp-1',
    status: 'ready',
    title: 'Main session',
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
    ...overrides,
  }
}

const TARGETS: DelegateTargetAgent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    harnessId: 'claude-code',
    harnessName: 'Claude Code',
    isCurrent: true,
    status: 'ready',
    modes: [{ id: 'bypassPermissions', name: 'Full access', description: 'Never asks' }],
    inheritedMode: { id: 'bypassPermissions', name: 'Full access' },
  },
  {
    id: 'codex',
    name: 'Codex',
    harnessId: 'codex',
    harnessName: 'Codex',
    isCurrent: false,
    status: 'ready',
    modes: [{ id: 'agent-full-access', name: 'Full access', description: 'Never asks' }],
    inheritedMode: { id: 'agent-full-access', name: 'Full access' },
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    harnessId: 'antigravity',
    harnessName: 'Google Antigravity',
    isCurrent: false,
    status: 'installing',
    modes: [],
    inheritedMode: null,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    harnessId: 'opencode',
    harnessName: 'OpenCode',
    isCurrent: false,
    status: 'needs_sign_in',
    modes: [],
    inheritedMode: null,
  },
]

let mountedRoot: Root | null = null

beforeEach(() => {
  localStorageMap.clear()
  hostMock.mockReset()
  mockUpsertedSessions = []
  capturedAddMenu = null
  capturedPlaceholder = ''
  capturedEditorKeyDown = null
  mockEditorText = ''
  mockAgentsLoaded = true
  mockAgentsById = {
    'claude-code': agentStatus({
      id: 'claude-code',
      name: 'Claude Code',
      harnessId: 'claude-code',
      harnessName: 'Claude Code',
    }),
    codex: agentStatus({
      id: 'codex',
      name: 'Codex',
      harnessId: 'codex',
      harnessName: 'Codex',
    }),
  }
  mockAgentsOrder = ['claude-code', 'codex']
  for (const id of ['parent-1', 'parent-2', 'child-1']) {
    setDraftDelegateTarget(id, null)
    clearDraft(id)
  }
})

afterEach(() => {
  if (mountedRoot) {
    flushSync(() => mountedRoot!.unmount())
    mountedRoot = null
  }
})

describe('delegation gating, filtering, and draft state', () => {
  it('offers delegation only on active top-level user sessions', () => {
    expect(
      canOfferDelegation({
        sessionId: 'parent-1',
        parentId: null,
        origin: 'user',
        mustSwitch: false,
        heldOutside: false,
      }),
    ).toBe(true)

    // Child sessions, subagents, routines, tasks, new session, mustSwitch, and heldOutside are gated.
    expect(
      canOfferDelegation({
        sessionId: 'child-1',
        parentId: 'parent-1',
        origin: 'user',
        mustSwitch: false,
        heldOutside: false,
      }),
    ).toBe(false)
    expect(
      canOfferDelegation({
        sessionId: 'sub-1',
        parentId: null,
        origin: 'subagent',
        mustSwitch: false,
        heldOutside: false,
      }),
    ).toBe(false)
    expect(
      canOfferDelegation({
        sessionId: null,
        parentId: null,
        origin: 'user',
        mustSwitch: false,
        heldOutside: false,
      }),
    ).toBe(false)
    expect(
      canOfferDelegation({
        sessionId: 'parent-1',
        parentId: null,
        origin: 'user',
        mustSwitch: true,
        heldOutside: false,
      }),
    ).toBe(false)
    expect(
      canOfferDelegation({
        sessionId: 'parent-1',
        parentId: null,
        origin: 'user',
        mustSwitch: false,
        heldOutside: true,
      }),
    ).toBe(false)
  })

  it('mirrors host toolAgentStatus availability rules', () => {
    expect(isDelegatableAgentStatus(agentStatus({ id: 'codex', state: 'ready' }))).toBe(true)
    expect(isDelegatableAgentStatus(agentStatus({ id: 'codex', state: 'available' }))).toBe(true)
    expect(isDelegatableAgentStatus(agentStatus({ id: 'codex', disabled: true }))).toBe(false)
    expect(isDelegatableAgentStatus(agentStatus({ id: 'codex', hidden: true }))).toBe(false)
    expect(isDelegatableAgentStatus(agentStatus({ id: 'codex', registered: false }))).toBe(false)
    expect(isDelegatableAgentStatus(agentStatus({ id: 'codex', uninstalled: true }))).toBe(false)
    expect(isDelegatableAgentStatus(agentStatus({ id: 'codex', state: 'not-installed' }))).toBe(
      false,
    )
    expect(
      isDelegatableAgentStatus(
        agentStatus({
          id: 'codex',
          package: { name: 'codex-acp', version: '1.0', installed: false },
          cli: null,
        }),
      ),
    ).toBe(false)
  })

  it('filters agents by name, harness, and id and skips non-selectable rows during keyboard navigation', () => {
    expect(filterDelegateAgents(TARGETS, '').map((a) => a.id)).toEqual([
      'claude-code',
      'codex',
      'antigravity',
      'opencode',
    ])
    expect(filterDelegateAgents(TARGETS, 'cod').map((a) => a.id)).toEqual([
      'claude-code',
      'codex',
      'opencode',
    ])
    expect(filterDelegateAgents(TARGETS, 'codex').map((a) => a.id)).toEqual(['codex'])
    expect(filterDelegateAgents(TARGETS, 'anti').map((a) => a.id)).toEqual(['antigravity'])
    expect(filterDelegateAgents(TARGETS, 'OPENCODE').map((a) => a.id)).toEqual(['opencode'])
    expect(filterDelegateAgents(TARGETS, 'does-not-exist')).toEqual([])

    expect(firstSelectableIndex(TARGETS)).toBe(0)
    // Index 2 is `installing`, so ArrowDown from index 1 skips directly to index 3 (`opencode`).
    expect(moveSelectableHighlight(TARGETS, 1, 'ArrowDown')).toBe(3)
    expect(moveSelectableHighlight(TARGETS, 3, 'ArrowUp')).toBe(1)
    expect(moveSelectableHighlight(TARGETS, 3, 'ArrowDown')).toBe(0)
  })

  it('persists recipient per session draft and restores it after failed send', () => {
    setDraftDelegateTarget('parent-1', { agentId: 'codex', name: 'Codex' })
    flushDraft('parent-1')
    expect(draftDelegateTarget('parent-1')).toEqual({ agentId: 'codex', name: 'Codex' })
    expect(draftDelegateTarget('parent-2')).toBeNull()
    expect(readDraftDelegateTarget('parent-1')).toEqual({ agentId: 'codex', name: 'Codex' })

    // Clearing the recipient removes it cleanly without touching other sessions.
    setDraftDelegateTarget('parent-1', null)
    flushDraft('parent-1')
    expect(draftDelegateTarget('parent-1')).toBeNull()

    // Hydrate loads persisted target on composer mount, and restore recovers it after failure.
    restoreDraftDelegateTarget('parent-2', { agentId: 'claude-code', name: 'Claude Code' })
    flushDraft('parent-2')
    hydrateDraftDelegateTarget('parent-2')
    expect(draftDelegateTarget('parent-2')).toEqual({
      agentId: 'claude-code',
      name: 'Claude Code',
    })
  })
})

describe('DelegateAgentPickerPopover and DelegateRecipientChip', () => {
  it('filters agents, navigates with keyboard, selects on Enter, and clears on chip × click', async () => {
    const { container } = installFakeDom()
    const onOpenChange = vi.fn()
    const onSelect = vi.fn()
    const onPicked = vi.fn()
    const loadAgents = vi.fn(async (): Promise<DelegateAgentsResult> => ({
      canDelegate: true,
      agents: TARGETS,
    }))

    const anchor = { current: null }
    mountedRoot = createRoot(container as unknown as Element)
    flushSync(() => {
      mountedRoot!.render(
        createElement(DelegateAgentPickerPopover, {
          open: true,
          onOpenChange,
          anchor,
          draft: 'parent-1',
          sessionId: 'parent-1',
          hostId: null,
          onSelect,
          onPicked,
          loadAgents,
        }),
      )
    })

    // Wait for async loadAgents promise and React commit to settle.
    await vi.waitFor(() => {
      expect(loadAgents).toHaveBeenCalledWith('parent-1')
      const options = container.findAll((el) => el.getAttribute('role') === 'option')
      expect(options.map((el) => el.getAttribute('data-delegate-option'))).toEqual([
        'claude-code',
        'codex',
        'antigravity',
        'opencode',
      ])
    })

    // Verify keyboard navigation (ArrowDown -> Codex -> Enter) and Escape close via input handlers.
    const input = container.find((el) => el.tagName === 'INPUT')!
    expect(input).toBeTruthy()
    const propsKey = () =>
      Object.keys(input).find((key) => key.startsWith('__reactProps$')) as string
    const inputProps = () =>
      (input as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[
        propsKey()
      ]!

    // Press ArrowDown to move from claude-code (0) to codex (1), then Enter to select codex.
    flushSync(() => {
      inputProps().onKeyDown({
        key: 'ArrowDown',
        keyCode: 40,
        nativeEvent: { isComposing: false },
        preventDefault() {},
        stopPropagation() {},
      })
    })
    const highlighted = container.find((el) => el.getAttribute('data-highlighted') !== null)
    expect(highlighted?.getAttribute('data-delegate-option')).toBe('codex')

    flushSync(() => {
      inputProps().onKeyDown({
        key: 'Enter',
        keyCode: 13,
        nativeEvent: { isComposing: false },
        preventDefault() {},
        stopPropagation() {},
      })
    })
    expect(draftDelegateTarget('parent-1')).toEqual({ agentId: 'codex', name: 'Codex' })
    expect(onSelect).toHaveBeenCalledWith({ agentId: 'codex', name: 'Codex' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onPicked).toHaveBeenCalled()

    // Filter search input down to OpenCode and verify only OpenCode renders, then press Escape.
    flushSync(() => {
      inputProps().onChange({ target: { value: 'open' } })
    })
    const filtered = container.findAll((el) => el.getAttribute('role') === 'option')
    expect(filtered.map((el) => el.getAttribute('data-delegate-option'))).toEqual(['opencode'])

    onOpenChange.mockClear()
    flushSync(() => {
      inputProps().onKeyDown({
        key: 'Escape',
        keyCode: 27,
        nativeEvent: { isComposing: false },
        preventDefault() {},
        stopPropagation() {},
      })
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // Render recipient chip and clear it via the × button.
    const onLeave = vi.fn()
    flushSync(() => {
      mountedRoot!.render(
        createElement(DelegateRecipientChip, {
          draft: 'parent-1',
          hostId: null,
          onChange: vi.fn(),
          onLeave,
        }),
      )
    })
    expect(container.textContent).toContain('Codex')
    const removeBtn = container.find((el) => el.getAttribute('data-delegate-remove') !== null)!
    expect(removeBtn).toBeTruthy()
    flushSync(() => {
      removeBtn.dispatchEvent({ type: 'click' })
    })
    expect(draftDelegateTarget('parent-1')).toBeNull()
    expect(onLeave).toHaveBeenCalled()
    expect(container.find((el) => el.getAttribute('data-delegate-recipient') !== null)).toBeNull()
  })
})

describe('Composer manual delegation flow', () => {
  it('shows Delegate to agent in + menu for top-level sessions, hides it for child sessions, and disables it when no agents exist', () => {
    const { container } = installFakeDom()
    mountedRoot = createRoot(container as unknown as Element)

    // 1. Top-level user session with available agents -> enabled delegate row.
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          session: makeSession({ id: 'parent-1', parentId: null }),
          agentName: 'Claude Code',
        }),
      )
    })
    const topRows = capturedAddMenu!.sections.flatMap((s) => s.rows)
    const delegateRow = topRows.find((r) => r.id === 'delegate')
    expect(delegateRow).toBeDefined()
    expect(delegateRow?.disabled).toBeFalsy()

    // 2. Child session -> delegate row hidden.
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          session: makeSession({ id: 'child-1', parentId: 'parent-1' }),
          agentName: 'Codex',
        }),
      )
    })
    const childRows = capturedAddMenu!.sections.flatMap((s) => s.rows)
    expect(childRows.find((r) => r.id === 'delegate')).toBeUndefined()

    // 3. Top-level session when no agents are available -> delegate row disabled with reason.
    mockAgentsById = {}
    mockAgentsOrder = []
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          session: makeSession({ id: 'parent-1', parentId: null }),
          agentName: 'Claude Code',
        }),
      )
    })
    const emptyRows = capturedAddMenu!.sections.flatMap((s) => s.rows)
    const disabledRow = emptyRows.find((r) => r.id === 'delegate')
    expect(disabledRow).toBeDefined()
    expect(disabledRow?.disabled).toBe(true)
    expect(disabledRow?.description).toBe('delegation.noAgents')
  })

  it('delegates directly via sessions.delegate when recipient is selected, restores draft on failure, and resumes normal queue send after clearing recipient', async () => {
    const { container } = installFakeDom()
    mountedRoot = createRoot(container as unknown as Element)

    writeDraft('parent-1', 'Review the auth PR')
    setDraftDelegateTarget('parent-1', { agentId: 'codex', name: 'Codex' })

    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          session: makeSession({ id: 'parent-1', status: 'ready' }),
          agentName: 'Claude Code',
        }),
      )
    })

    // Recipient chip and delegation placeholder are shown.
    expect(container.find((el) => el.getAttribute('data-delegate-recipient') !== null)).toBeTruthy()
    expect(capturedPlaceholder).toContain('delegation.placeholder')

    // 1. Failed delegation preserves draft text, keeps recipient chip, and displays error.
    hostMock.mockRejectedValueOnce(new Error('Codex is unavailable'))
    const sendBtn = container.find((el) => el.getAttribute('data-send-button') !== null)!
    expect(sendBtn.disabled).toBe(false)
    flushSync(() => {
      sendBtn.dispatchEvent({ type: 'click' })
    })
    await Promise.resolve()
    await Promise.resolve()
    flushSync(() => {})

    expect(hostMock).toHaveBeenCalledWith('sessions.delegate', {
      sessionId: 'parent-1',
      agentId: 'codex',
      content: [{ type: 'text', text: 'Review the auth PR' }],
    })
    expect(hostMock).not.toHaveBeenCalledWith('sessions.queue', expect.anything())
    expect(readDraft('parent-1')).toBe('Review the auth PR')
    expect(draftDelegateTarget('parent-1')).toEqual({ agentId: 'codex', name: 'Codex' })
    expect(container.find((el) => el.getAttribute('role') === 'alert')?.textContent).toContain(
      'Codex is unavailable',
    )

    // 2. Successful delegation clears draft & recipient chip and upserts the child session summary.
    const childSummary: SessionSummary = {
      id: 'child-new',
      agentId: 'codex',
      projectPath: '/repo',
      scratch: false,
      title: 'Review the auth PR',
      status: 'running',
      attention: 'none',
      permissionCount: 0,
      createdAt: 10,
      updatedAt: 10,
      parentId: 'parent-1',
      origin: 'user',
      routine: null,
      description: null,
      missing: false,
      branch: null,
      pr: null,
      cache: null,
      model: null,
      pinnedAt: null,
      archivedAt: null,
      acpSessionId: 'acp-child',
    }
    hostMock.mockResolvedValueOnce(childSummary)

    // Re-sync editor text after restore put it back into draft storage.
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'retry',
          session: makeSession({ id: 'parent-1', status: 'ready' }),
          agentName: 'Claude Code',
        }),
      )
    })
    const retrySendBtn = container.find((el) => el.getAttribute('data-send-button') !== null)!
    flushSync(() => {
      retrySendBtn.dispatchEvent({ type: 'click' })
    })
    await Promise.resolve()
    await Promise.resolve()
    flushSync(() => {})

    expect(mockUpsertedSessions).toEqual([childSummary])
    expect(readDraft('parent-1')).toBe('')
    expect(draftDelegateTarget('parent-1')).toBeNull()
    expect(container.find((el) => el.getAttribute('data-delegate-recipient') !== null)).toBeNull()

    // 3. After clearing recipient, sending uses normal `sessions.queue` on the parent session.
    hostMock.mockResolvedValueOnce({ itemId: null })
    writeDraft('parent-1', 'Normal follow-up message')
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'normal',
          session: makeSession({ id: 'parent-1', status: 'ready' }),
          agentName: 'Claude Code',
        }),
      )
    })
    expect(capturedPlaceholder).toBe('prompt.placeholder.ask')
    expect(capturedEditorKeyDown).not.toBeNull()
    expect(mockEditorText).toBe('Normal follow-up message')
    const normalSendBtn = container.find((el) => el.getAttribute('data-send-button') !== null)!
    flushSync(() => {
      normalSendBtn.dispatchEvent({ type: 'click' })
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(hostMock).toHaveBeenLastCalledWith('sessions.queue', {
      sessionId: 'parent-1',
      content: [{ type: 'text', text: 'Normal follow-up message' }],
    })
  })
})
