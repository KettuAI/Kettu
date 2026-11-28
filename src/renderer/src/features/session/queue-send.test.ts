import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import type { RunningSend } from '@shared/settings'
import type { AgentId, QueuedPrompt, SessionView } from '@shared/thread'

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

let mockMac = true
let mockPhone = false
let mockSendKey: 'enter' | 'mod-enter' = 'enter'
let mockRunningSend: RunningSend = 'queue'
let mockAgentsById: Record<string, AgentStatus> = {}
let mockAgentsOrder: string[] = []
let mockWaitingCardId: string | null = null
let mockPressWaitingCard = vi.fn<() => boolean>(() => false)
let mockComments: Array<{
  id: string
  entryId: string
  passage: string
  start: number
  end: number
  comment: string
}> = []
let mockPaneSelection: {
  projectPath: string
  artifactId: string
  selector: string
  label: string
  text: string
} | null = null
let mockArtifactShown = false
let mockSlashCommands: Array<{ name: string; description: string }> = []

let capturedEditorKeyDown: ((event: KeyboardEvent) => boolean) | null = null
let capturedEditorSetText: ((next: string) => void) | null = null
let capturedEditorChange: ((next: string) => void) | null = null
let capturedEditorCaret: ((caret: number | null) => void) | null = null

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@base-ui/react/popover', () => ({
  Popover: {
    Root: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? createElement('div', { 'data-popover-root': '' }, children) : null,
    Portal: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Positioner: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Popup: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  },
}))

vi.mock('@renderer/lib/host', () => ({
  host: (method: string, params: unknown) => hostMock(method, params),
  hostAt: (_hostId: string | null, method: string, params: unknown) => hostMock(method, params),
  artifactHost: () => null,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

vi.mock('@renderer/lib/platform', () => ({
  formatShortcut: (s: string) =>
    mockMac ? s.replace('Mod+', '⌘').replace('Enter', '↩') : s.replace('Mod', 'Ctrl'),
  get isMac() {
    return mockMac
  },
  isMod: (e: { metaKey?: boolean; ctrlKey?: boolean }) =>
    mockMac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey,
  isWeb: false,
  menuCollisionPadding: 8,
}))

vi.mock('@renderer/lib/use-now', () => ({
  useClock: <T>(select: (now: number) => T) => select(Date.now()),
  useNow: () => Date.now(),
}))

vi.mock('@renderer/stores/agents', () => ({
  agentsOn: () => ({ byId: mockAgentsById, order: mockAgentsOrder }),
  useAgentsStore: <T>(selector: (state: unknown) => T) =>
    selector({
      byId: mockAgentsById,
      order: mockAgentsOrder,
      hosts: {},
      loaded: true,
    }),
  usePlanReadings: () => new Map(),
  agentName: (agentId: string) => mockAgentsById[agentId]?.name ?? agentId,
}))

vi.mock('@renderer/stores/sessions', () => {
  const state = { byId: {} as Record<string, unknown>, upsert: vi.fn() }
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

vi.mock('@renderer/stores/account', () => ({
  useAccountStore: (selector: (s: { status: null }) => unknown) => selector({ status: null }),
}))

vi.mock('@renderer/stores/hosts', () => ({
  useHostsStore: (selector: (s: { status: null }) => unknown) => selector({ status: null }),
}))

vi.mock('@renderer/stores/browser', () => ({
  useBrowserStore: (selector: (s: { bySession: Record<string, never> }) => unknown) =>
    selector({ bySession: {} }),
}))

vi.mock('@renderer/stores/view', () => ({
  shownSidePane: () => null,
  artifactShown: () => mockArtifactShown,
  panelSession: () => null,
  useViewStore: (selector: (s: { main: { kind: string; sessionId: string } }) => unknown) =>
    selector({ main: { kind: 'session', sessionId: 'sess-1' } }),
}))

vi.mock('@renderer/stores/artifacts', () => {
  const getState = () => ({
    paneSelection: mockPaneSelection,
    list: [] as never[],
    hidden: new Set<string>(),
    hostsRead: [] as string[],
    awayLists: {} as Record<string, never[]>,
  })
  const useArtifactsStore = <T>(selector: (s: ReturnType<typeof getState>) => T) =>
    selector(getState())
  useArtifactsStore.getState = getState
  return {
    setPaneSelection: vi.fn(),
    artifactListShown: vi.fn(),
    artifactStanding: () => 'live',
    useArtifactsStore,
  }
})

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
        general: { sendKey: 'enter' | 'mod-enter'; runningSend: RunningSend }
        thread: { promptCacheDropNotice: boolean }
      }
    }) => unknown,
  ) =>
    selector({
      settings: {
        general: { sendKey: mockSendKey, runningSend: mockRunningSend },
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
  commentsOf: () => mockComments,
  keepComments: vi.fn(),
  removeComments: vi.fn(),
  useReplyComments: () => mockComments,
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

vi.mock('./waiting-card', () => ({
  firstWaiting: () => mockWaitingCardId,
  pressWaitingCard: () => mockPressWaitingCard(),
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: ({ agent }: { agent: string }) => createElement('span', { 'data-agent-mark': agent }),
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => createElement('span', { 'data-spinner': '' }),
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) =>
    createElement('span', { 'data-tooltip': '' }, children),
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => {
    if (render && typeof render === 'object' && 'type' in render) {
      const el = render as { type: string; props: Record<string, unknown> }
      return createElement(el.type, el.props, children)
    }
    return createElement('span', null, children)
  },
  TooltipContent: ({ children }: { children?: ReactNode }) =>
    createElement('span', { 'data-tooltip-content': '' }, children),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: () => createElement('span', { 'data-glyph': '' }),
}))

vi.mock('@renderer/features/shell/narrow', () => ({
  usePhoneWindow: () => mockPhone,
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
  SelectionChip: () => createElement('div', { 'data-selection-chip': '' }),
}))

vi.mock('./composer/editor', () => ({
  ComposerEditor: forwardRef(function MockComposerEditor(
    props: {
      initialText: string
      placeholder: string
      onChange: (next: string) => void
      onCaret: (caret: number | null) => void
      onKeyDown: (event: KeyboardEvent) => boolean
    },
    ref,
  ) {
    capturedEditorKeyDown = props.onKeyDown
    capturedEditorChange = props.onChange
    capturedEditorCaret = props.onCaret
    const textRef = useRef(props.initialText)
    capturedEditorSetText = (next: string) => {
      textRef.current = next
    }
    useImperativeHandle(ref, () => ({
      text: () => textRef.current,
      setText: (next: string) => {
        textRef.current = next
      },
      selection: () => ({ from: textRef.current.length, to: textRef.current.length }),
      atBoundary: () => true,
      insert: (chunk: string) => {
        textRef.current += chunk
        props.onChange(textRef.current)
      },
      keepAsText: () => {},
      chipElement: () => null,
      focus: () => {},
      rectOf: () => null,
      scrollElement: () => null,
      measure: () => ({ height: 48, least: 48 }),
    }))
    return createElement('input', {
      'data-mock-editor': '',
      value: textRef.current,
      readOnly: true,
      placeholder: props.placeholder,
    })
  }),
}))

vi.mock('@renderer/components/affect/chat-composer', () => ({
  ChatComposer: ({
    field,
    send,
    foot,
  }: {
    field?: ReactNode
    send?: ReactNode
    foot?: ReactNode
  }) =>
    createElement(
      'div',
      { 'data-chat-composer': '' },
      field,
      createElement('div', { 'data-send-slot': '' }, send),
      foot,
    ),
}))

vi.mock('./composer/send-button', () => ({
  SendButton: ({ label }: { label: string }) =>
    createElement('button', { type: 'button', 'data-send-button': '' }, label),
  QueueButton: () => createElement('button', { type: 'button', 'data-queue-button': '' }, 'Queue'),
  StopButton: () => createElement('button', { type: 'button', 'data-stop-button': '' }, 'Stop'),
}))

vi.mock('./composer/artifact-picker', () => ({
  ArtifactPickerPopover: () => null,
  AttachedArtifactChips: () => null,
}))

vi.mock('./composer/browser-annotation-chips', () => ({
  BrowserAnnotationChips: () => null,
}))

vi.mock('./composer/attachment-tray', () => ({
  AttachmentTray: () => null,
}))

vi.mock('./composer/delegate-picker', () => ({
  DelegateAgentPickerPopover: () => null,
  DelegateRecipientChip: () => null,
}))

vi.mock('./composer/prompt-chips', () => ({
  usePromptChips: () => ({
    chipContext: {},
    hidden: new Set(),
    overlays: null,
    keyDown: () => false,
  }),
}))

vi.mock('./composer/use-mention-list', () => ({
  useMentionList: () => ({ files: null, rows: [], noProject: false, used: false }),
}))

vi.mock('./composer/use-plugin-mentions', () => ({
  usePluginMentions: () => ({ groups: [], rows: [], starts: [], visible: false }),
}))

vi.mock('./composer/use-github-ref-picker', () => ({
  useGitHubRefPicker: () => ({ rows: [], loading: false, searching: false, error: null }),
}))

vi.mock('./composer/use-slash-commands', () => ({
  useSlashCommands: () => mockSlashCommands,
}))

vi.mock('./composer/use-out-of-credit', () => ({
  useOutOfCredit: () => null,
}))

vi.mock('./composer/usage', () => ({
  CacheButton: () => null,
  ContextButton: () => null,
}))

vi.mock('./composer/speed', () => ({
  SpeedButton: () => null,
}))

vi.mock('./composer/session-place', () => ({
  SessionPlace: () => null,
}))

vi.mock('./composer/affect-styles', () => ({
  TrayStyles: () => null,
}))

vi.mock('./composer/resize-grip', () => ({
  ResizeGrip: () => null,
}))

vi.mock('./composer/comment-list', () => ({
  CommentList: () => null,
}))

vi.mock('./composer/model-menu', () => ({
  ModelMenu: () => null,
}))

vi.mock('./composer/switch-confirm', () => ({
  SwitchConfirm: () => null,
}))

vi.mock('./attachments/text-dialog', () => ({
  TextDialog: () => null,
}))

import { setDraftAttachments } from '@renderer/stores/attachments'
import { setDraftArtifactAttachments } from './composer/artifact-attachments'
import { setDraftBrowserAnnotations } from './composer/browser-annotations'
import { clearDraft, writeDraft } from './composer/drafts'
import { Composer } from './composer/composer'
import { QueueStack } from './queue-stack'
import {
  firstSendableQueuedPrompt,
  inFlightQueuedSend,
  isQueuedPromptSendable,
  isQueueSendNowShortcut,
  resolveEmptyComposerQueueSend,
  runQueuedSendNow,
  type QueueSendNowKeyEvent,
} from './queue-send'

// Minimal DOM stub so React 19 renders Composer and QueueStack in Vitest's node environment.
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
  style: Record<string, unknown> = {
    setProperty(name: string, value: string) {
      this[name] = value
    },
    removeProperty(name: string) {
      delete this[name]
    },
  }
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
    let current: FakeDomNode | FakeDocument | null = evt.target
    while (current) {
      evt.currentTarget = current
      const set = current.listeners.get(type)
      if (set) {
        for (const fn of [...set]) fn(evt)
      }
      if (!evt.bubbles) break
      current = current instanceof FakeDomNode ? current.parentNode : null
    }
    return !evt.defaultPrevented
  }

  focus(): void {}
  scrollIntoView(): void {}
  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: 600,
      height: 100,
      top: 0,
      right: 600,
      bottom: 100,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect
  }

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
    node.nodeValue = String(text)
    return node
  }

  createComment(text: string): FakeDomNode {
    const node = new FakeDomNode(FakeNodeBase.COMMENT_NODE, '#comment', this)
    node.nodeValue = String(text)
    return node
  }

  getElementById(): null {
    return null
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

let mountedRoot: Root | null = null

function installFakeDom(): { container: FakeDomNode; document: FakeDocument } {
  const document = new FakeDocument()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const fakeWindow = {
    document,
    navigator: { userAgent: 'vitest' },
    innerHeight: 800,
    HTMLElement: FakeElementBase,
    SVGElement: FakeElementBase,
    Element: FakeElementBase,
    Node: FakeNodeBase,
    Document: FakeDocumentBase,
    HTMLIFrameElement: FakeElementBase,
    DOMRect: class {
      constructor(
        public x = 0,
        public y = 0,
        public width = 0,
        public height = 0,
      ) {}
    },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    },
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  document.defaultView = fakeWindow
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('document', document)
  vi.stubGlobal('Node', FakeNodeBase)
  vi.stubGlobal('Element', FakeElementBase)
  vi.stubGlobal('HTMLElement', FakeElementBase)
  vi.stubGlobal('DOMRect', fakeWindow.DOMRect)
  vi.stubGlobal('requestAnimationFrame', fakeWindow.requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', fakeWindow.cancelAnimationFrame)
  return { container, document }
}

function makePrompt(id: string, text: string, extra: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return {
    id,
    content: [{ type: 'text', text }],
    at: 1,
    ...extra,
  }
}

function makeReportItem(id: string): QueuedPrompt {
  return {
    id,
    content: [{ type: 'text', text: 'Child finished' }],
    at: 1,
    from: {
      sessionId: 'child-1',
      title: 'Child session',
      ended: {
        agent: 'Codex',
        stopReason: 'end_turn',
        round: 1,
        completedAt: 10,
        entryId: 'e1',
      },
    },
  }
}

function makeKeyEvent(overrides: Partial<QueueSendNowKeyEvent> = {}): KeyboardEvent {
  let defaultPrevented = false
  return {
    key: 'Enter',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    repeat: false,
    get defaultPrevented() {
      return defaultPrevented
    },
    preventDefault() {
      defaultPrevented = true
    },
    stopPropagation() {},
    ...overrides,
  } as unknown as KeyboardEvent
}

function makeAgent(id: AgentId, steering: boolean): AgentStatus {
  return {
    id,
    harness: id,
    harnessName: id,
    name: id,
    state: 'ready',
    installed: true,
    registered: true,
    capabilities: {
      steering,
      context: false,
      liveContext: false,
      images: true,
    },
  } as unknown as AgentStatus
}

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 'sess-1',
    agentId: 'claude-code',
    projectPath: '/repo',
    acpSessionId: 'acp-1',
    title: 'Test session',
    status: 'running',
    config: [],
    commands: [],
    usage: null,
    context: null,
    speed: null,
    lastRequest: null,
    queue: [],
    queuePaused: false,
    error: null,
    parentId: null,
    origin: 'user',
    ...overrides,
  } as SessionView
}

beforeEach(() => {
  mockMac = true
  mockPhone = false
  mockSendKey = 'enter'
  mockRunningSend = 'queue'
  mockAgentsById = {
    'claude-code': makeAgent('claude-code', true),
    gemini: makeAgent('gemini', false),
  }
  mockAgentsOrder = ['claude-code', 'gemini']
  mockWaitingCardId = null
  mockPressWaitingCard = vi.fn(() => false)
  mockComments = []
  mockPaneSelection = null
  mockArtifactShown = false
  mockSlashCommands = []
  capturedEditorKeyDown = null
  capturedEditorSetText = null
  capturedEditorChange = null
  capturedEditorCaret = null
  hostMock.mockReset()
  hostMock.mockResolvedValue(undefined)
  localStorageMap.clear()
  clearDraft('sess-1')
  setDraftAttachments('sess-1', [])
  setDraftArtifactAttachments('sess-1', [])
  setDraftBrowserAnnotations('sess-1', [])
})

afterEach(() => {
  if (mountedRoot) {
    flushSync(() => mountedRoot!.unmount())
    mountedRoot = null
  }
  clearDraft('sess-1')
  setDraftAttachments('sess-1', [])
  setDraftArtifactAttachments('sess-1', [])
  setDraftBrowserAnnotations('sess-1', [])
})

describe('queue-send eligibility and shortcut helpers (#3005)', () => {
  it('identifies sendable queued prompts and skips completion reports, kettu reminders, approvals, and empty items', () => {
    const report = makeReportItem('rep-1')
    const kettu = makePrompt('ket-1', 'Step reminder', { kettu: true })
    const approval = makePrompt('app-1', 'Approved', { approval: true })
    const empty: QueuedPrompt = { id: 'emp-1', content: [], at: 1 }
    const userA = makePrompt('q-a', 'Message A')
    const userB = makePrompt('q-b', 'Message B', {
      device: { id: 'dev-1', name: 'iPhone', platform: 'ios' } as QueuedPrompt['device'],
    })
    const commented = makePrompt('q-c', 'Commented', {
      comments: { count: 1, text: 'Fix this' },
    })
    const crossSession = makePrompt('q-d', 'From peer session', {
      from: { sessionId: 'peer-1', title: 'Peer' },
    })

    expect(isQueuedPromptSendable(report)).toBe(false)
    expect(isQueuedPromptSendable(kettu)).toBe(false)
    expect(isQueuedPromptSendable(approval)).toBe(false)
    expect(isQueuedPromptSendable(empty)).toBe(false)
    expect(isQueuedPromptSendable(userA)).toBe(true)
    expect(isQueuedPromptSendable(userB)).toBe(true)
    expect(isQueuedPromptSendable(commented)).toBe(true)
    expect(isQueuedPromptSendable(crossSession)).toBe(true)

    expect(firstSendableQueuedPrompt([report, kettu, approval, empty, userA, userB])?.id).toBe(
      'q-a',
    )
    expect(firstSendableQueuedPrompt([report, kettu, approval, empty])).toBeNull()
    expect(firstSendableQueuedPrompt([])).toBeNull()
  })

  it('matches Mod+Enter across all sendKey and runningSend settings, plus Mod+Shift+Enter for mod-enter + queue', () => {
    const macModEnter = {
      key: 'Enter',
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }
    const winModEnter = {
      key: 'Enter',
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
    }
    const macModShiftEnter = {
      key: 'Enter',
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    }
    const plainEnter = {
      key: 'Enter',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }
    const shiftEnter = {
      key: 'Enter',
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    }

    // macOS Cmd+Enter works across every sendKey x runningSend combination
    for (const sendKey of ['enter', 'mod-enter'] as const) {
      for (const runningSend of ['queue', 'steer'] as const) {
        expect(isQueueSendNowShortcut(macModEnter, { sendKey, runningSend, mac: true })).toBe(true)
        expect(isQueueSendNowShortcut(winModEnter, { sendKey, runningSend, mac: true })).toBe(false)
        expect(isQueueSendNowShortcut(winModEnter, { sendKey, runningSend, mac: false })).toBe(true)
        expect(isQueueSendNowShortcut(macModEnter, { sendKey, runningSend, mac: false })).toBe(
          false,
        )
        expect(isQueueSendNowShortcut(plainEnter, { sendKey, runningSend, mac: true })).toBe(false)
        expect(isQueueSendNowShortcut(shiftEnter, { sendKey, runningSend, mac: true })).toBe(false)
      }
    }

    // Mod+Shift+Enter is additionally accepted only when it is the active steer shortcut (mod-enter + queue)
    expect(
      isQueueSendNowShortcut(macModShiftEnter, {
        sendKey: 'mod-enter',
        runningSend: 'queue',
        mac: true,
      }),
    ).toBe(true)
    expect(
      isQueueSendNowShortcut(macModShiftEnter, {
        sendKey: 'mod-enter',
        runningSend: 'steer',
        mac: true,
      }),
    ).toBe(false)
    expect(
      isQueueSendNowShortcut(macModShiftEnter, {
        sendKey: 'enter',
        runningSend: 'queue',
        mac: true,
      }),
    ).toBe(false)
    expect(
      isQueueSendNowShortcut(macModShiftEnter, {
        sendKey: 'enter',
        runningSend: 'steer',
        mac: true,
      }),
    ).toBe(false)

    // Blocks IME composition, repeat, Alt, and dual modifiers
    expect(
      isQueueSendNowShortcut(
        { ...macModEnter, isComposing: true },
        { sendKey: 'enter', runningSend: 'queue', mac: true },
      ),
    ).toBe(false)
    expect(
      isQueueSendNowShortcut(
        { ...macModEnter, keyCode: 229 },
        { sendKey: 'enter', runningSend: 'queue', mac: true },
      ),
    ).toBe(false)
    expect(
      isQueueSendNowShortcut(
        { ...macModEnter, repeat: true },
        { sendKey: 'enter', runningSend: 'queue', mac: true },
      ),
    ).toBe(false)
    expect(
      isQueueSendNowShortcut(
        { ...macModEnter, altKey: true },
        { sendKey: 'enter', runningSend: 'queue', mac: true },
      ),
    ).toBe(false)
    expect(
      isQueueSendNowShortcut(
        { ...macModEnter, ctrlKey: true },
        { sendKey: 'enter', runningSend: 'queue', mac: true },
      ),
    ).toBe(false)
  })

  it('enforces all session and composer guards in resolveEmptyComposerQueueSend', () => {
    const queue = [makePrompt('q-a', 'A'), makePrompt('q-b', 'B')]
    const base = {
      event: { key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
      sendKey: 'enter' as const,
      runningSend: 'queue' as const,
      mac: true,
      status: 'running' as const,
      waitingBackground: false,
      queue,
      holdsMessage: false,
    }

    expect(resolveEmptyComposerQueueSend(base)?.id).toBe('q-a')
    expect(resolveEmptyComposerQueueSend({ ...base, holdsMessage: true })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, disabled: true })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, heldOutside: true })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, mustSwitch: true })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, pendingSwitch: true })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, activeDelegate: true })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, editingSuggestion: true })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, hasWaitingCard: true })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, popoverOpen: true })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, inFlightItemId: 'q-a' })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, waitingBackground: true })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, status: 'awaiting_permission' })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, status: 'ready' })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, status: 'closed' })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, status: 'starting' })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, status: 'failed' })).toBeNull()
    expect(resolveEmptyComposerQueueSend({ ...base, status: 'auth_required' })).toBeNull()
  })

  it('prevents concurrent in-flight sendNow calls for the same session and releases once settled', async () => {
    let resolveFirst!: () => void
    const firstSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve
        }),
    )
    const secondSend = vi.fn(async () => {})
    const otherSessionSend = vi.fn(async () => {})

    const p1 = runQueuedSendNow('s-lock', 'item-a', firstSend)
    expect(p1).not.toBeNull()
    expect(inFlightQueuedSend('s-lock')).toBe('item-a')

    // Rapid duplicate press on same session is ignored while pending.
    expect(runQueuedSendNow('s-lock', 'item-a', secondSend)).toBeNull()
    expect(runQueuedSendNow('s-lock', 'item-b', secondSend)).toBeNull()
    expect(secondSend).not.toHaveBeenCalled()

    // Independent session is not blocked.
    const pOther = runQueuedSendNow('s-other', 'item-x', otherSessionSend)
    expect(pOther).not.toBeNull()
    await pOther
    expect(otherSessionSend).toHaveBeenCalledTimes(1)

    resolveFirst()
    await p1
    expect(inFlightQueuedSend('s-lock')).toBeNull()

    // Rejected RPC also releases the lock so the user can retry.
    const failing = runQueuedSendNow('s-lock', 'item-a', () => Promise.reject(new Error('boom')))
    await expect(failing).rejects.toThrow('boom')
    expect(inFlightQueuedSend('s-lock')).toBeNull()
  })
})

describe('Composer empty-box Cmd/Ctrl+Enter queue sendNow interaction (#3005)', () => {
  function mountComposer(session: SessionView, mustSwitch = false) {
    const dom = installFakeDom()
    mountedRoot = createRoot(dom.container as unknown as Element)
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          session,
          agentName: session.agentId,
          mustSwitch,
        }),
      )
    })
    return dom
  }

  it('sends only the first eligible queued message A via sessions.sendNow when composer is empty, leaving B queued', async () => {
    const session = makeSession({
      queue: [makePrompt('q-a', 'Message A'), makePrompt('q-b', 'Message B')],
    })
    mountComposer(session)

    const event = makeKeyEvent({ metaKey: true })
    flushSync(() => {
      capturedEditorKeyDown!(event)
    })
    await Promise.resolve()

    expect(event.defaultPrevented).toBe(true)
    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('sessions.sendNow', {
      sessionId: 'sess-1',
      itemId: 'q-a',
    })
  })

  it('treats whitespace-only editor content as empty and supports Ctrl+Enter on Windows/Linux', async () => {
    mockMac = false
    writeDraft('sess-1', '   \n\t  ')
    const session = makeSession({
      queue: [makePrompt('q-a', 'Message A')],
    })
    mountComposer(session)

    const event = makeKeyEvent({ ctrlKey: true })
    flushSync(() => {
      capturedEditorKeyDown!(event)
    })
    await Promise.resolve()

    expect(event.defaultPrevented).toBe(true)
    expect(hostMock).toHaveBeenCalledWith('sessions.sendNow', {
      sessionId: 'sess-1',
      itemId: 'q-a',
    })
  })

  it('keeps existing steer/queue behavior when composer has text, attachment, artifact chip, browser annotation, comment, or selection chip', async () => {
    const queue = [makePrompt('q-a', 'Queued A'), makePrompt('q-b', 'Queued B')]

    // 1. Non-empty text -> steers composer input via sessions.queue + sessions.steer, not sessions.sendNow.
    hostMock.mockResolvedValueOnce({ itemId: 'new-1' }).mockResolvedValueOnce(undefined)
    writeDraft('sess-1', 'Steer this draft')
    mountComposer(makeSession({ queue }))
    const textEvent = makeKeyEvent({ metaKey: true })
    flushSync(() => {
      capturedEditorKeyDown!(textEvent)
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(hostMock).toHaveBeenCalledWith('sessions.queue', {
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Steer this draft' }],
    })
    expect(hostMock).toHaveBeenCalledWith('sessions.steer', {
      sessionId: 'sess-1',
      itemId: 'new-1',
    })
    expect(hostMock).not.toHaveBeenCalledWith('sessions.sendNow', expect.anything())

    // 2. Empty text + attachment -> keeps composer send, does not call sessions.sendNow.
    hostMock.mockClear()
    hostMock.mockResolvedValueOnce({ itemId: 'new-attach' }).mockResolvedValueOnce(undefined)
    clearDraft('sess-1')
    setDraftAttachments('sess-1', [
      {
        key: 'att-1',
        status: 'ready',
        attachment: {
          id: 'att-1',
          kind: 'file',
          name: 'notes.txt',
          path: '/repo/notes.txt',
          size: 12,
        },
        pixels: null,
        scaled: null,
      } as never,
    ])
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'attachment-chip',
          session: makeSession({ queue }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(hostMock).toHaveBeenCalledWith('sessions.queue', expect.anything())
    expect(hostMock).not.toHaveBeenCalledWith('sessions.sendNow', expect.anything())

    // 3. Empty text + attached artifact chip -> keeps composer send, does not call sessions.sendNow.
    hostMock.mockClear()
    hostMock.mockResolvedValueOnce({ itemId: 'new-2' }).mockResolvedValueOnce(undefined)
    setDraftAttachments('sess-1', [])
    setDraftArtifactAttachments('sess-1', [{ id: 'art-1', title: 'Design doc', kind: 'document' }])
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'artifact-chip',
          session: makeSession({ queue }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(hostMock).toHaveBeenCalledWith('sessions.queue', expect.anything())
    expect(hostMock).not.toHaveBeenCalledWith('sessions.sendNow', expect.anything())

    // 4. Empty text + browser annotation chip -> keeps composer send, does not call sessions.sendNow.
    hostMock.mockClear()
    hostMock.mockResolvedValueOnce({ itemId: 'new-3' }).mockResolvedValueOnce(undefined)
    setDraftArtifactAttachments('sess-1', [])
    setDraftBrowserAnnotations('sess-1', [
      {
        id: 'ann-1',
        url: 'http://localhost:3000',
        pageTitle: 'App',
        selector: '#btn',
        tag: 'button',
        domId: 'btn',
        role: 'button',
        accessibleName: 'Submit',
        text: 'Submit',
        attributes: {},
        rect: { x: 10, y: 20, width: 100, height: 32 },
        viewport: { width: 1280, height: 800 },
      },
    ])
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'browser-chip',
          session: makeSession({ queue }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(hostMock).toHaveBeenCalledWith('sessions.queue', expect.anything())
    expect(hostMock).not.toHaveBeenCalledWith('sessions.sendNow', expect.anything())

    // 5. Empty text + passage comment -> keeps composer send, does not call sessions.sendNow.
    hostMock.mockClear()
    hostMock.mockResolvedValueOnce({ itemId: 'new-4' }).mockResolvedValueOnce(undefined)
    setDraftBrowserAnnotations('sess-1', [])
    mockComments = [
      { id: 'c1', entryId: 'e1', passage: 'hello', start: 0, end: 5, comment: 'Clarify this' },
    ]
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'comment',
          session: makeSession({ queue }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(hostMock).toHaveBeenCalledWith('sessions.queue', expect.anything())
    expect(hostMock).not.toHaveBeenCalledWith('sessions.sendNow', expect.anything())

    // 6. Empty text + visible artifact selection chip -> blocks empty-composer queue sendNow.
    hostMock.mockClear()
    mockComments = []
    mockPaneSelection = {
      projectPath: '/repo',
      artifactId: 'art-1',
      selector: 'h1',
      label: 'Heading',
      text: 'Title',
    }
    mockArtifactShown = true
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'selection-chip',
          session: makeSession({ queue }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()
    expect(hostMock).not.toHaveBeenCalledWith('sessions.sendNow', expect.anything())
  })

  it('skips non-sendable queue entries before prompt A and is a no-op when only non-sendable or empty queue exists', async () => {
    const report = makeReportItem('rep-1')
    const kettu = makePrompt('ket-1', 'Reminder', { kettu: true })
    const userA = makePrompt('q-a', 'Message A')

    mountComposer(makeSession({ queue: [report, kettu, userA] }))
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('sessions.sendNow', {
      sessionId: 'sess-1',
      itemId: 'q-a',
    })

    // Queue containing only non-sendable items -> no-op.
    hostMock.mockClear()
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'only-non-sendable',
          session: makeSession({ queue: [report, kettu] }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()
    expect(hostMock).not.toHaveBeenCalled()

    // Empty queue -> no-op.
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'empty-queue',
          session: makeSession({ queue: [] }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()
    expect(hostMock).not.toHaveBeenCalled()
  })

  it('works for both steering-capable and non-steering agents via sessions.sendNow', async () => {
    const queue = [makePrompt('q-a', 'Message A')]
    mountComposer(makeSession({ agentId: 'gemini', queue }))

    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()

    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('sessions.sendNow', {
      sessionId: 'sess-1',
      itemId: 'q-a',
    })
  })

  it('blocks rapid double-presses while sessions.sendNow is in flight and surfaces failures cleanly', async () => {
    let resolveRpc!: () => void
    hostMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRpc = resolve
        }),
    )
    const { container } = mountComposer(
      makeSession({ queue: [makePrompt('q-a', 'A'), makePrompt('q-b', 'B')] }),
    )

    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    expect(hostMock).toHaveBeenCalledTimes(1)

    resolveRpc()
    await Promise.resolve()
    await Promise.resolve()

    // Once resolved and queue advances to [B], the next press sends B; a rejection shows an alert.
    hostMock.mockRejectedValueOnce(new Error('Could not steer now'))
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          session: makeSession({ queue: [makePrompt('q-b', 'B')] }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => {})

    expect(hostMock).toHaveBeenCalledTimes(2)
    expect(hostMock).toHaveBeenLastCalledWith('sessions.sendNow', {
      sessionId: 'sess-1',
      itemId: 'q-b',
    })
    expect(container.find((el) => el.getAttribute('role') === 'alert')?.textContent).toContain(
      'Could not steer now',
    )
  })

  it('respects IME composition, open popover, waiting card, heldOutside, mustSwitch, idle, and all sendKey/runningSend settings', async () => {
    const queue = [makePrompt('q-a', 'A')]
    mountComposer(makeSession({ queue }))

    // IME composing (both isComposing and keyCode 229)
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true, isComposing: true }))
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true, keyCode: 229 }))
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true, repeat: true }))
    })
    expect(hostMock).not.toHaveBeenCalled()

    // Open slash popover blocks empty-composer queue shortcut
    mockSlashCommands = [{ name: 'plan', description: 'Plan task' }]
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'slash-open',
          session: makeSession({ queue }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorSetText!('/')
      capturedEditorChange!('/')
      capturedEditorCaret!(1)
    })
    // Even if editor text were transiently empty while popover state was open, popover blocks it;
    // with `/` typed it is also non-empty and never calls sessions.sendNow.
    hostMock.mockResolvedValueOnce({ itemId: 'slash-1' })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(hostMock).not.toHaveBeenCalledWith('sessions.sendNow', expect.anything())

    // Reset draft and test waiting card / awaiting_permission / heldOutside / mustSwitch / ready / waitingBackground
    hostMock.mockClear()
    clearDraft('sess-1')
    mockSlashCommands = []
    mockWaitingCardId = 'entry-wait-1'
    mockPressWaitingCard = vi.fn(() => true)
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'waiting-card',
          session: makeSession({ status: 'awaiting_permission', queue }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    expect(mockPressWaitingCard).toHaveBeenCalledTimes(1)
    expect(hostMock).not.toHaveBeenCalledWith('sessions.sendNow', expect.anything())

    // heldOutside / mustSwitch / ready / waitingBackground
    mockWaitingCardId = null
    for (const [key, session, mustSwitch] of [
      ['held', makeSession({ queue, heldOutside: true }), false],
      ['must-switch', makeSession({ queue }), true],
      ['ready', makeSession({ status: 'ready', queue }), false],
      ['waiting-bg', makeSession({ status: 'running', waitingBackground: true, queue }), false],
    ] as const) {
      flushSync(() => {
        mountedRoot!.render(
          createElement(Composer, {
            key,
            session,
            agentName: 'claude-code',
            mustSwitch,
          }),
        )
      })
      flushSync(() => {
        capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
      })
    }
    expect(hostMock).not.toHaveBeenCalled()

    // sendKey='enter' + runningSend='steer': plain Enter does NOT fire queued item, Cmd+Enter DOES.
    mockSendKey = 'enter'
    mockRunningSend = 'steer'
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'enter-steer',
          session: makeSession({ queue }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: false }))
    })
    expect(hostMock).not.toHaveBeenCalled()

    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true }))
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('sessions.sendNow', {
      sessionId: 'sess-1',
      itemId: 'q-a',
    })

    // sendKey='mod-enter' + runningSend='queue': both Cmd+Enter and Cmd+Shift+Enter send A.
    hostMock.mockClear()
    mockSendKey = 'mod-enter'
    mockRunningSend = 'queue'
    flushSync(() => {
      mountedRoot!.render(
        createElement(Composer, {
          key: 'mod-enter-queue',
          session: makeSession({ queue }),
          agentName: 'claude-code',
        }),
      )
    })
    flushSync(() => {
      capturedEditorKeyDown!(makeKeyEvent({ metaKey: true, shiftKey: true }))
    })
    await Promise.resolve()
    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('sessions.sendNow', {
      sessionId: 'sess-1',
      itemId: 'q-a',
    })
  })
})

describe('QueueStack sendNow eligibility, shortcut tooltip, and editor routing (#3005)', () => {
  it('hides Send now on non-sendable entries and shows the shortcut hint only on the first eligible entry', async () => {
    const { container } = installFakeDom()
    mountedRoot = createRoot(container as unknown as Element)
    const onError = vi.fn()
    const report = makeReportItem('rep-1')
    const userA = makePrompt('q-a', 'Message A')
    const userB = makePrompt('q-b', 'Message B')

    flushSync(() => {
      mountedRoot!.render(
        createElement(QueueStack, {
          session: makeSession({ queue: [report, userA, userB] }),
          onError,
        }),
      )
    })

    const sendNowButtons = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'queue.sendNow',
    )
    // Only userA and userB get Send now; the child session completion report does not.
    expect(sendNowButtons).toHaveLength(2)

    const sendNowTips = sendNowButtons.map(
      (btn) =>
        btn.parentNode?.find((el) => el.getAttribute('data-tooltip-content') !== null)?.textContent,
    )
    expect(sendNowTips[0]).toContain('queue.steer')
    expect(sendNowTips[0]).toContain('⌘↩')
    expect(sendNowTips[1]).toContain('queue.steer')
    expect(sendNowTips[1]).not.toContain('⌘↩')

    // Clicking Send now on A shares the in-flight guard and ignores rapid duplicate clicks.
    let resolveClick!: () => void
    hostMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClick = resolve
        }),
    )
    flushSync(() => {
      sendNowButtons[0]!.dispatchEvent({ type: 'click' })
      sendNowButtons[0]!.dispatchEvent({ type: 'click' })
    })
    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('sessions.sendNow', {
      sessionId: 'sess-1',
      itemId: 'q-a',
    })
    resolveClick()
    await Promise.resolve()
  })

  it('routes Mod+Enter through ComposerEditor domEventHandlers at Prec.highest before CodeMirror keymap', () => {
    const editorSource = readFileSync(join(import.meta.dirname, 'composer/editor.tsx'), 'utf8')
    const domHandlersIndex = editorSource.indexOf('EditorView.domEventHandlers')
    const keymapIndex = editorSource.indexOf('keymap.of([')
    expect(domHandlersIndex).toBeGreaterThan(-1)
    expect(keymapIndex).toBeGreaterThan(domHandlersIndex)
    expect(editorSource).toContain('Prec.highest(')
    expect(editorSource).toContain('keydown: (event) => keyDown(event)')
    expect(editorSource).toContain("{ key: 'Mod-Enter', run: () => true, shift: () => true }")
  })
})
