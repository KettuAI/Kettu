// Drives a session's page over the DevTools protocol, on the debugger that BrowserViews attaches
// to every page for its dialogs. The page's snapshot is its accessibility tree; every action is a
// real input event, so a framework that listens for one behaves as it would for the user.

import type { WebContents } from 'electron'
import type { BrowserCallResult, BrowserToolName } from '@shared/browser'
import type { BrowserControl } from './control'
import { isNeverOpened } from './policy'

/** The outline an agent reads, before its "… N more lines" marker. */
export const MAX_SNAPSHOT_LINES = 2_000
/** How long the network stays quiet before a page counts as settled. */
export const QUIET_MS = 500
/** The longest a page is waited for after an action. */
export const SETTLE_MAX_MS = 5_000
/** A full-page screenshot stops at this height. */
export const MAX_PAGE_HEIGHT = 8_000
/** A screenshot's longer side, in pixels. */
export const MAX_SHOT_SIDE = 2_000
export const MAX_CONSOLE = 200
export const MAX_REQUESTS = 300
/** The longest JSON value browser_evaluate returns. */
export const MAX_VALUE_BYTES = 64 * 1024

const POLL_MS = 50

/** A refused call, with the code an agent reads and text that says what to do. */
export class ToolFailure extends Error {
  constructor(
    readonly code:
      | 'user_has_control'
      | 'not_allowed'
      | 'stale_ref'
      | 'timeout'
      | 'navigation_failed'
      | 'no_page'
      | 'invalid',
    message: string,
  ) {
    super(message)
    this.name = 'ToolFailure'
  }
}

/** What a navigation ended as. */
export interface LoadOutcome {
  url: string
  title: string | null
}

export interface BrowserCdpDeps {
  /** The page's web contents, or null when the session has none. */
  contents(sessionId: string): WebContents | null
  /** Loads a URL in the session's page, making the page when it has none. */
  load(sessionId: string, url: string): Promise<LoadOutcome>
  back(sessionId: string): Promise<LoadOutcome>
  reload(sessionId: string): Promise<LoadOutcome>
  control: BrowserControl
  log(level: 'warn' | 'error', message: string): void
}

interface ConsoleMessage {
  level: string
  text: string
  url: string
  line: number
  /** The page's document it was logged under, so `since_navigation` can leave earlier ones out. */
  nav: number
}

interface NetworkRequest {
  id: string
  method: string
  url: string
  status: number | null
  type: string
  size: number | null
  nav: number
}

interface Snapshot {
  /** The document it was taken from; a ref from another one is stale. */
  nav: number
  refs: Map<string, number>
  /** The accessibility node behind each backend id, for the covered-centre message. */
  outline: string
  url: string
  title: string
}

interface PageState {
  nav: number
  loading: boolean
  inFlight: Set<string>
  console: ConsoleMessage[]
  requests: NetworkRequest[]
  snapshot: Snapshot | null
  dialogs: string[]
  /** Input events injected right now; the page reports them as it reports the user's. */
  injecting: number
  /** The HTTP status of the main document, as the network saw it. */
  status: number | null
  frameId: string | null
}

// Accessibility node, as Accessibility.getFullAXTree reports it.
interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  description?: { value?: string }
  value?: { value?: unknown }
  properties?: { name: string; value?: { value?: unknown } }[]
  childIds?: string[]
  backendDOMNodeId?: number
  parentId?: string
}

export interface Outline {
  lines: string[]
  /** `eN` to the node's backend id, in the order the page holds them. */
  refs: Map<string, number>
  /** Lines left out beyond the cap. */
  more: number
}

const ROLE_NAMES: Record<string, string> = {
  RootWebArea: 'page',
  StaticText: 'text',
  InlineTextBox: 'text',
  TextField: 'textbox',
  SearchBox: 'searchbox',
  CheckBox: 'checkbox',
  RadioButton: 'radio',
  ComboBox: 'combobox',
  ListBox: 'listbox',
  ListBoxOption: 'option',
  MenuListPopup: 'menu',
  MenuItem: 'menuitem',
  MenuBar: 'menubar',
  Menu: 'menu',
  ToggleButton: 'button',
  DisclosureTriangle: 'button',
  PopUpButton: 'button',
  Slider: 'slider',
  SpinButton: 'spinbutton',
  ProgressIndicator: 'progressbar',
  Image: 'image',
  Iframe: 'iframe',
  Heading: 'heading',
  Paragraph: 'paragraph',
  ListItem: 'listitem',
  UnorderedList: 'list',
  OrderedList: 'list',
  DescriptionList: 'list',
  Term: 'term',
  Description: 'definition',
  Link: 'link',
}

const ACTIONABLE = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
  'textfield',
])

// Wrappers that add nothing an agent needs; their children take their place.
const TRANSPARENT = new Set(['none', 'presentation', 'generic', 'ignored', 'paragraph'])

// Roles that hold other elements, so their line ends in a colon.
const CONTAINERS = new Set([
  'page',
  'banner',
  'main',
  'navigation',
  'region',
  'form',
  'list',
  'menu',
  'menubar',
  'tablist',
  'tree',
  'row',
  'rowgroup',
  'table',
  'listbox',
  'combobox',
  'grid',
  'group',
  'toolbar',
  'dialog',
  'alertdialog',
  'iframe',
])

const STATES: Record<string, string> = {
  checked: 'checked',
  expanded: 'expanded',
  selected: 'selected',
  pressed: 'pressed',
  level: 'level',
  invalid: 'invalid',
  haspopup: 'popup',
  readonly: 'readonly',
  multiselectable: 'multiselectable',
}

function roleOf(node: AXNode): string {
  const role = node.role?.value ?? ''
  return ROLE_NAMES[role] ?? role.toLowerCase()
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function quoted(text: string): string {
  return `"${clean(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The outline of a page's accessibility tree, with a ref on every element an agent can act on. */
export function buildOutline(nodes: readonly AXNode[]): Outline {
  const byId = new Map<string, AXNode>()
  for (const node of nodes) byId.set(node.nodeId, node)
  const roots = nodes.filter((node) => node.parentId === undefined || !byId.has(node.parentId))
  const refs = new Map<string, number>()
  const lines: string[] = []
  const seen = new Set<string>()

  const walk = (node: AXNode, depth: number): void => {
    if (seen.has(node.nodeId)) return
    seen.add(node.nodeId)
    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is AXNode => !!child)
    const role = roleOf(node)
    const name = clean(node.name?.value ?? '')
    if (node.ignored) {
      for (const child of children) walk(child, depth)
      return
    }
    // The page itself heads the outline, which outlineText writes.
    if (role === 'page' && node.role?.value === 'RootWebArea') {
      for (const child of children) walk(child, depth)
      return
    }
    // A text node repeats its container's words; the container already says them.
    if (node.role?.value === 'StaticText') return
    if (node.role?.value === 'InlineTextBox') return
    const transparent = TRANSPARENT.has(role) && name === ''
    if (transparent && children.length === 1) {
      walk(children[0]!, depth)
      return
    }
    let line = `${'  '.repeat(depth)}- ${role}`
    if (name !== '') line += ` ${quoted(name)}`
    else if (node.description?.value && clean(node.description.value) !== '')
      line += ` ${quoted(node.description.value)}`
    const props = new Map((node.properties ?? []).map((p) => [p.name, p.value?.value]))
    for (const [prop, label] of Object.entries(STATES)) {
      const value = props.get(prop)
      if (value === undefined || value === false || value === 'false') continue
      if (prop === 'level') line += ` [level=${String(value)}]`
      else if (value === true || value === 'true') line += ` [${label}]`
      else line += ` [${label}=${String(value)}]`
    }
    if (props.get('disabled') === true) line += ' [disabled]'
    const value = props.get('valuetext') ?? node.value?.value
    if (typeof value === 'string' && value !== '' && (role === 'textbox' || role === 'combobox'))
      line += ` [value=${quoted(value.slice(0, 80))}]`
    if (ACTIONABLE.has(role) && node.backendDOMNodeId !== undefined) {
      const ref = `e${refs.size + 1}`
      refs.set(ref, node.backendDOMNodeId)
      line += ` [ref=${ref}]`
    }
    if (CONTAINERS.has(role) && children.length > 0) line += ':'
    lines.push(line)
    for (const child of children) walk(child, depth + 1)
  }

  for (const root of roots) walk(root, 0)

  const more = Math.max(0, lines.length - MAX_SNAPSHOT_LINES)
  return { lines: more > 0 ? lines.slice(0, MAX_SNAPSHOT_LINES) : lines, refs, more }
}

/** The text an agent reads for a snapshot: the page's title and address, then the outline. */
export function outlineText(page: { title: string | null; url: string }, outline: Outline): string {
  const head = `- Page: ${clean(page.title ?? '') || 'Untitled'} (${page.url || 'about:blank'})`
  const lines = [head, ...outline.lines]
  if (outline.more > 0) lines.push(`… ${outline.more} more lines`)
  return lines.join('\n')
}

/** Whether a page has settled: nothing loading, nothing in flight, and a quiet network. */
export function hasSettled(
  state: { loading: boolean; inFlight: number; idleSince: number | null },
  now: number,
  quietMs = QUIET_MS,
): boolean {
  if (state.loading || state.inFlight > 0) return false
  return state.idleSince !== null && now - state.idleSince >= quietMs
}

export interface KeyStroke {
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
  modifiers: number
}

const MODIFIERS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  super: 4,
  shift: 8,
}

const NAMED: Record<string, { code: string; vk: number; text?: string }> = {
  enter: { code: 'Enter', vk: 13, text: '\r' },
  return: { code: 'Enter', vk: 13, text: '\r' },
  tab: { code: 'Tab', vk: 9, text: '\t' },
  escape: { code: 'Escape', vk: 27 },
  esc: { code: 'Escape', vk: 27 },
  backspace: { code: 'Backspace', vk: 8 },
  delete: { code: 'Delete', vk: 46 },
  arrowup: { code: 'ArrowUp', vk: 38 },
  arrowdown: { code: 'ArrowDown', vk: 40 },
  arrowleft: { code: 'ArrowLeft', vk: 37 },
  arrowright: { code: 'ArrowRight', vk: 39 },
  up: { code: 'ArrowUp', vk: 38 },
  down: { code: 'ArrowDown', vk: 40 },
  left: { code: 'ArrowLeft', vk: 37 },
  right: { code: 'ArrowRight', vk: 39 },
  home: { code: 'Home', vk: 36 },
  end: { code: 'End', vk: 35 },
  pageup: { code: 'PageUp', vk: 33 },
  pagedown: { code: 'PageDown', vk: 34 },
  space: { code: 'Space', vk: 32, text: ' ' },
}

const PUNCTUATION: Record<string, string> = {
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
}

/**
 * A key name or a combination such as `Control+A`, `Shift+Enter` or `Meta+ArrowLeft`, as Chromium's
 * input event takes it. A key that is not one of these is refused, so a typo cannot type text.
 */
export function parseKey(input: string): KeyStroke {
  const parts = input.split('+')
  const last = parts.pop() ?? ''
  let modifiers = 0
  for (const raw of parts) {
    const modifier = MODIFIERS[raw.trim().toLowerCase()]
    if (modifier === undefined) throw new ToolFailure('invalid', `Unknown modifier "${raw}".`)
    modifiers |= modifier
  }
  const key = last.trim()
  if (key === '') throw new ToolFailure('invalid', 'The key is empty.')
  const named = NAMED[key.toLowerCase()]
  if (named) {
    return {
      key: named.code === 'Space' ? ' ' : named.code,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      // A control key sends no text; Enter and Tab do, so the page acts on them.
      ...(named.text !== undefined && (modifiers & 2) === 0 ? { text: named.text } : {}),
      modifiers,
    }
  }
  if (/^f([1-9]|1[0-2])$/i.test(key)) {
    const n = Number(key.slice(1))
    return { key: `F${n}`, code: `F${n}`, windowsVirtualKeyCode: 111 + n, modifiers }
  }
  if ([...key].length === 1) {
    const char = key
    const upper = char.toUpperCase()
    const code = /[a-z]/i.test(char)
      ? `Key${upper}`
      : /[0-9]/.test(char)
        ? `Digit${char}`
        : PUNCTUATION[char]
    if (!code) throw new ToolFailure('invalid', `Unknown key "${input}".`)
    const shift = (modifiers & 8) !== 0
    const typed = shift && /[a-z]/i.test(char) ? upper : char
    const vk = /[a-z]/i.test(char)
      ? upper.charCodeAt(0)
      : /[0-9]/.test(char)
        ? char.charCodeAt(0)
        : 0
    return {
      key: typed,
      code,
      windowsVirtualKeyCode: vk,
      ...((modifiers & (2 | 4)) === 0 ? { text: typed } : {}),
      modifiers,
    }
  }
  throw new ToolFailure('invalid', `Unknown key "${input}". Use a key name or a combination.`)
}

/**
 * A navigation an agent asked for: an http(s) address or the empty document. Whether its origin
 * may open is main's to decide, which asks the user for one they have not allowed yet.
 */
export function checkAgentNavigation(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ToolFailure('invalid', `"${url}" is not an absolute URL.`)
  }
  if (parsed.href === 'about:blank') return parsed.href
  if (isNeverOpened(parsed)) {
    throw new ToolFailure('not_allowed', `${parsed.protocol} pages never open in Kettu.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolFailure('not_allowed', `${parsed.protocol} pages never open in Kettu.`)
  }
  return parsed.href
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function failure(error: unknown): ToolFailure {
  if (error instanceof ToolFailure) return error
  return new ToolFailure('invalid', (error as Error)?.message ?? String(error))
}

export class BrowserCdp {
  private readonly pages = new Map<string, PageState>()

  constructor(private readonly deps: BrowserCdpDeps) {}

  /** A page's debugger starts handing its events here; the debugger stays attached as it was. */
  watch(sessionId: string, contents: WebContents): void {
    if (this.pages.has(sessionId)) return
    const page: PageState = {
      nav: 0,
      loading: false,
      inFlight: new Set(),
      console: [],
      requests: [],
      snapshot: null,
      dialogs: [],
      injecting: 0,
      status: null,
      frameId: null,
    }
    this.pages.set(sessionId, page)
    for (const method of [
      'DOM.enable',
      'Runtime.enable',
      'Log.enable',
      'Network.enable',
      'Accessibility.enable',
    ]) {
      void contents.debugger.sendCommand(method).catch(() => {})
    }
    void contents.debugger
      .sendCommand('Page.getFrameTree')
      .then((tree: { frameTree?: { frame?: { id?: string } } }) => {
        page.frameId = tree.frameTree?.frame?.id ?? null
        return tree
      })
      .catch(() => {})
    contents.debugger.on('message', (_event, method, params) => {
      this.event(page, method, params as Record<string, unknown>)
    })
  }

  /** The page is gone, or belongs to a session no longer used. */
  forget(sessionId: string): void {
    this.pages.delete(sessionId)
  }

  /** The ids of the page's frames, the main one first, then its same-origin children. */
  private async frameIds(sessionId: string): Promise<string[]> {
    const ids: string[] = []
    const visit = (tree: { frame?: { id?: string }; childFrames?: unknown[] }): void => {
      if (typeof tree.frame?.id === 'string') ids.push(tree.frame.id)
      for (const child of (tree.childFrames ?? []) as (typeof tree)[]) visit(child)
    }
    try {
      const tree = await this.send<{
        frameTree?: { frame?: { id?: string }; childFrames?: unknown[] }
      }>(sessionId, 'Page.getFrameTree')
      if (tree.frameTree) visit(tree.frameTree)
    } catch {
      // Without a frame tree the page's own nodes are all there is.
    }
    return ids.length > 0 ? ids : ['']
  }

  /** A dialog the page opened, which views.ts answered at once. */
  dialogOpened(sessionId: string, type: string, accepted: boolean): void {
    const page = this.pages.get(sessionId)
    if (!page) return
    const noun = type === 'alert' ? 'An alert' : `A ${type}`
    page.dialogs.push(`${noun} dialog was ${accepted ? 'accepted' : 'dismissed'}.`)
  }

  /** Runs a tool call on the session's page and answers its result or throws a ToolFailure. */
  async call(
    sessionId: string,
    tool: BrowserToolName,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    if (tool !== 'browser_navigate') this.pageOf(sessionId)
    const control = this.deps.control
    control.begin(sessionId)
    try {
      return await this.dispatch(sessionId, tool, args)
    } catch (error) {
      throw failure(error)
    } finally {
      control.end(sessionId)
    }
  }

  private async dispatch(
    sessionId: string,
    tool: BrowserToolName,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    switch (tool) {
      case 'browser_navigate':
        return this.navigate(sessionId, args)
      case 'browser_navigate_back':
        return this.navigateBack(sessionId)
      case 'browser_reload':
        return this.reload(sessionId)
      case 'browser_snapshot':
        return this.snapshotResult(sessionId)
      case 'browser_click':
        return this.click(sessionId, args)
      case 'browser_type':
        return this.type(sessionId, args)
      case 'browser_press_key':
        return this.press(sessionId, args)
      case 'browser_scroll':
        return this.scroll(sessionId, args)
      case 'browser_select_option':
        return this.select(sessionId, args)
      case 'browser_take_screenshot':
        return this.screenshot(sessionId, args)
      case 'browser_wait_for':
        return this.waitFor(sessionId, args)
      case 'browser_console_messages':
        return this.consoleMessages(sessionId, args)
      case 'browser_network_requests':
        return this.networkRequests(sessionId, args)
      case 'browser_evaluate':
        return this.evaluate(sessionId, args)
    }
  }

  private pageOf(sessionId: string): PageState {
    const page = this.pages.get(sessionId)
    if (!page) {
      throw new ToolFailure(
        'no_page',
        'This session has no page yet. Use browser_navigate to open one.',
      )
    }
    return page
  }

  private contentsOf(sessionId: string): WebContents {
    this.pageOf(sessionId)
    const contents = this.deps.contents(sessionId)
    if (!contents || contents.isDestroyed()) {
      throw new ToolFailure(
        'no_page',
        'This session has no page yet. Use browser_navigate to open one.',
      )
    }
    return contents
  }

  /** Runs one CDP command, unless the user took control meanwhile. */
  private async send<T = Record<string, unknown>>(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.deps.control.assert(sessionId)
    const contents = this.contentsOf(sessionId)
    // Chromium reports an injected input event as it reports the user's, so the pane's input
    // watch must know this one is the agent's.
    const injecting = method.startsWith('Input.')
    const state = this.pages.get(sessionId)
    if (injecting && state) state.injecting += 1
    try {
      return (await contents.debugger.sendCommand(method, params)) as T
    } finally {
      if (injecting && state) state.injecting -= 1
    }
  }

  /** Whether an input event the page reports right now is the agent's own. */
  isInjecting(sessionId: string): boolean {
    return (this.pages.get(sessionId)?.injecting ?? 0) > 0
  }

  private event(page: PageState, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const args = Array.isArray(params.args) ? (params.args as Record<string, unknown>[]) : []
        const stack = params.stackTrace as
          { callFrames?: { url?: string; lineNumber?: number }[] } | undefined
        const frame = stack?.callFrames?.[0]
        this.pushConsole(page, {
          level: consoleLevel(params.type),
          text: args.map(argumentText).join(' '),
          url: String(frame?.url ?? ''),
          line: (frame?.lineNumber ?? 0) + 1,
          nav: page.nav,
        })
        break
      }
      case 'Log.entryAdded': {
        const entry = (params.entry ?? {}) as Record<string, unknown>
        this.pushConsole(page, {
          level: entry.level === 'warning' ? 'warn' : String(entry.level ?? 'info'),
          text: String(entry.text ?? ''),
          url: String(entry.url ?? ''),
          line: Number(entry.lineNumber ?? 0) + 1,
          nav: page.nav,
        })
        break
      }
      case 'Network.requestWillBeSent': {
        const request = (params.request ?? {}) as Record<string, unknown>
        const id = String(params.requestId ?? '')
        if (!id) break
        page.inFlight.add(id)
        const existing = page.requests.find((entry) => entry.id === id)
        if (existing) break
        page.requests.push({
          id,
          method: String(request.method ?? 'GET'),
          url: String(request.url ?? ''),
          status: null,
          type: String(params.type ?? ''),
          size: null,
          nav: page.nav,
        })
        this.trimRequests(page)
        break
      }
      case 'Network.responseReceived': {
        const id = String(params.requestId ?? '')
        const response = (params.response ?? {}) as Record<string, unknown>
        const entry = page.requests.find((item) => item.id === id)
        if (entry) {
          entry.status = Number(response.status ?? 0) || null
          if (!entry.type) entry.type = String(params.type ?? '')
        }
        if (entry?.type === 'Document' && page.status === null) {
          page.status = Number(response.status ?? 0) || null
        }
        break
      }
      case 'Network.loadingFinished': {
        const id = String(params.requestId ?? '')
        page.inFlight.delete(id)
        const entry = page.requests.find((item) => item.id === id)
        if (entry) entry.size = Number(params.encodedDataLength ?? 0)
        break
      }
      case 'Network.loadingFailed': {
        page.inFlight.delete(String(params.requestId ?? ''))
        break
      }
      case 'Page.frameStartedLoading': {
        if (this.isMainFrame(page, params.frameId)) {
          page.loading = true
          page.status = null
        }
        break
      }
      case 'Page.frameStoppedLoading': {
        if (this.isMainFrame(page, params.frameId)) page.loading = false
        break
      }
      case 'Page.frameNavigated': {
        const frame = (params.frame ?? {}) as Record<string, unknown>
        if (frame.parentId !== undefined) break
        if (typeof frame.id === 'string') page.frameId = frame.id
        page.nav += 1
        page.snapshot = null
        page.status = null
        break
      }
      default:
        break
    }
  }

  private isMainFrame(page: PageState, frameId: unknown): boolean {
    if (page.frameId === null) return true
    return frameId === undefined || frameId === page.frameId
  }

  private pushConsole(page: PageState, message: ConsoleMessage): void {
    page.console.push(message)
    if (page.console.length > MAX_CONSOLE) page.console.splice(0, page.console.length - MAX_CONSOLE)
  }

  private trimRequests(page: PageState): void {
    while (page.requests.length > MAX_REQUESTS) {
      const dropped = page.requests.shift()
      if (dropped) page.inFlight.delete(dropped.id)
    }
  }

  private async settle(sessionId: string, page: PageState): Promise<void> {
    const start = Date.now()
    let idleSince: number | null = null
    for (;;) {
      this.deps.control.assert(sessionId)
      if (
        hasSettled({ loading: page.loading, inFlight: page.inFlight.size, idleSince }, Date.now())
      )
        return
      if (Date.now() - start >= SETTLE_MAX_MS) return
      idleSince = page.loading || page.inFlight.size > 0 ? null : (idleSince ?? Date.now())
      await sleep(POLL_MS)
    }
  }

  private async capture(
    sessionId: string,
    page: PageState,
  ): Promise<{ outline: string; refs: Map<string, number>; nav: number }> {
    // Each frame has a tree of its own; the same-origin ones sit under their iframe's node.
    const nodes: AXNode[] = []
    for (const frameId of await this.frameIds(sessionId)) {
      const tree = await this.send<{ nodes: AXNode[] }>(sessionId, 'Accessibility.getFullAXTree', {
        frameId,
      }).catch(() => null)
      if (!tree) continue
      if (nodes.length === 0) nodes.push(...tree.nodes)
      else nodes.push(...tree.nodes.filter((node) => node.role?.value !== 'RootWebArea'))
    }
    const contents = this.contentsOf(sessionId)
    const built = buildOutline(nodes)
    const url = contents.getURL()
    const title = contents.getTitle() || null
    const text = outlineText({ title, url }, built)
    page.snapshot = {
      nav: page.nav,
      refs: built.refs,
      outline: text,
      url,
      title: title ?? '',
    }
    return { outline: text, refs: built.refs, nav: page.nav }
  }

  private async snapshotResult(sessionId: string): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const contents = this.contentsOf(sessionId)
    const { outline } = await this.capture(sessionId, page)
    const url = contents.getURL()
    const title = contents.getTitle()
    return {
      text: `Snapshotted the page at ${url || 'about:blank'}${title ? `, "${title}"` : ''}.`,
      value: { url, title, snapshot: outline },
    }
  }

  /** The snapshot every acting tool answers with, after the page settles. */
  private async afterAction(
    sessionId: string,
    page: PageState,
    text: string,
  ): Promise<BrowserCallResult> {
    await this.settle(sessionId, page)
    const contents = this.contentsOf(sessionId)
    const { outline } = await this.capture(sessionId, page)
    const url = contents.getURL()
    const title = contents.getTitle()
    const dialogs = page.dialogs.splice(0)
    return {
      text: [text, ...dialogs].join(' '),
      value: { url, title, snapshot: outline },
    }
  }

  private async navigate(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const url = checkAgentNavigation(String(args.url ?? ''))
    let outcome: LoadOutcome
    try {
      outcome = await this.deps.load(sessionId, url)
    } catch (error) {
      const failed = failure(error)
      // A site the user refused keeps its own code; anything else is the page failing to load.
      if (failed.code === 'navigation_failed' || failed.code === 'not_allowed') throw failed
      throw new ToolFailure('navigation_failed', failed.message)
    }
    const page = this.pageOf(sessionId)
    const status = page.status
    await this.settle(sessionId, page)
    const { outline } = await this.capture(sessionId, page)
    const contents = this.contentsOf(sessionId)
    const title = contents.getTitle() || outcome.title
    const shown = contents.getURL() || outcome.url
    const dialogs = page.dialogs.splice(0)
    return {
      text: [
        `Opened ${shown}${title ? `, "${title}"` : ''}${status === null ? '' : ` (HTTP ${status})`}.`,
        ...dialogs,
      ].join(' '),
      value: { url: shown, title, status, snapshot: outline },
    }
  }

  private async navigateBack(sessionId: string): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    try {
      await this.deps.back(sessionId)
    } catch (error) {
      throw failure(error)
    }
    return this.afterAction(sessionId, page, 'Went back one page.')
  }

  private async reload(sessionId: string): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    try {
      await this.deps.reload(sessionId)
    } catch (error) {
      throw failure(error)
    }
    return this.afterAction(sessionId, page, 'Reloaded the page.')
  }

  /** The backend id of a snapshot's ref; a ref from an earlier document is stale. */
  private resolveRef(page: PageState, ref: string): number {
    const match = /^e(\d+)$/.exec(ref)
    if (!match) throw new ToolFailure('invalid', `"${ref}" is not a ref such as e12.`)
    const snapshot = page.snapshot
    const backend = snapshot?.refs.get(ref)
    if (!snapshot || snapshot.nav !== page.nav || backend === undefined) {
      throw new ToolFailure(
        'stale_ref',
        `Ref ${ref} is no longer on the page. Take a new snapshot.`,
      )
    }
    return backend
  }

  /** Runs a function with the element as `this`, which answers by value. */
  private async onElement<T>(
    sessionId: string,
    backend: number,
    source: string,
    args: unknown[] = [],
  ): Promise<T> {
    const { object } = await this.send<{ object: { objectId?: string } }>(
      sessionId,
      'DOM.resolveNode',
      { backendNodeId: backend },
    )
    if (!object?.objectId) {
      throw new ToolFailure(
        'stale_ref',
        'That element is no longer on the page. Take a new snapshot.',
      )
    }
    const result = await this.send<{
      result?: { value?: T; objectId?: string }
      exceptionDetails?: { exception?: { description?: string } }
    }>(sessionId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: source,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new ToolFailure(
        'invalid',
        result.exceptionDetails.exception?.description ?? 'The page refused the call.',
      )
    }
    return result.result?.value as T
  }

  private async click(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const backend = this.resolveRef(page, String(args.ref ?? ''))
    const double = args.double === true
    const button = clickButton(args.button)
    await this.send(sessionId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backend }).catch(
      () => {},
    )
    // The centre in the top frame's viewport, and what covers it there; a shadow root or a frame
    // is the page's own answer, not a guess from the outline.
    const spot = await this.onElement<{
      x: number
      y: number
      covered: string | null
      inside: boolean
    }>(
      sessionId,
      backend,
      `function () {
        const rect = this.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0, covered: null, inside: false }
        let x = rect.x + rect.width / 2
        let y = rect.y + rect.height / 2
        let view = window
        for (let depth = 0; depth < 8 && view !== window.top; depth++) {
          const frame = view.frameElement
          if (!frame) break
          const box = frame.getBoundingClientRect()
          x += box.x
          y += box.y
          view = frame.ownerDocument.defaultView
        }
        const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        let covered = null
        if (at && at !== this && !this.contains(at)) {
          const name = at.tagName ? at.tagName.toLowerCase() : 'element'
          const id = at.id ? '#' + at.id : ''
          const text = (at.innerText || at.textContent || '').trim().slice(0, 60)
          covered = text ? name + id + ' "' + text + '"' : name + id
        }
        const inside =
          x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight
        return { x, y, covered, inside }
      }`,
    )
    if (!spot.inside) {
      throw new ToolFailure(
        'invalid',
        `${describe(args, 'The element')} is not visible on the page. Scroll it into view, then click again.`,
      )
    }
    if (spot.covered !== null) {
      throw new ToolFailure(
        'invalid',
        `The centre of ${describe(args, 'the element')} is covered by ${spot.covered}. Scroll it or close what covers it, then click again.`,
      )
    }
    const { x, y } = spot
    await this.send(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    const clicks = double ? 2 : 1
    for (let count = 1; count <= clicks; count++) {
      await this.send(sessionId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        buttons: buttonMask(button),
        clickCount: count,
      })
      await this.send(sessionId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        buttons: 0,
        clickCount: count,
      })
    }
    return this.afterAction(
      sessionId,
      page,
      `Clicked ${describe(args, 'the element')}${double ? ' twice' : ''}.`,
    )
  }

  private async type(sessionId: string, args: Record<string, unknown>): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const backend = this.resolveRef(page, String(args.ref ?? ''))
    const text = String(args.text ?? '')
    const slowly = args.slowly === true
    await this.send(sessionId, 'DOM.focus', { backendNodeId: backend })
    const { object } = await this.send<{ object: { objectId?: string } }>(
      sessionId,
      'DOM.resolveNode',
      { backendNodeId: backend },
    )
    if (object?.objectId) {
      await this.send(sessionId, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function () {
          if (typeof this.focus === 'function') this.focus()
          if (typeof this.select === 'function') this.select()
          else if (this.isContentEditable) {
            const range = document.createRange()
            range.selectNodeContents(this)
            const selection = getSelection()
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }`,
        returnByValue: true,
      }).catch(() => {})
    }
    if (slowly) {
      for (const char of text) {
        await this.send(sessionId, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: char,
          text: char,
        })
        await this.send(sessionId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: char })
      }
    } else {
      await this.send(sessionId, 'Input.insertText', { text })
    }
    if (args.submit === true) await this.pressKey(sessionId, 'Enter')
    return this.afterAction(
      sessionId,
      page,
      `Typed ${JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text)} into ${describe(args, 'the element')}${args.submit === true ? ' and pressed Enter' : ''}.`,
    )
  }

  private async press(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const key = String(args.key ?? '')
    await this.pressKey(sessionId, key)
    return this.afterAction(sessionId, page, `Pressed ${key}.`)
  }

  private async pressKey(sessionId: string, input: string): Promise<void> {
    const stroke = parseKey(input)
    const base = {
      key: stroke.key,
      code: stroke.code,
      windowsVirtualKeyCode: stroke.windowsVirtualKeyCode,
      nativeVirtualKeyCode: stroke.windowsVirtualKeyCode,
      modifiers: stroke.modifiers,
    }
    await this.send(sessionId, 'Input.dispatchKeyEvent', {
      type: stroke.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...base,
      ...(stroke.text === undefined ? {} : { text: stroke.text, unmodifiedText: stroke.text }),
    })
    await this.send(sessionId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  private async scroll(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const direction = String(args.direction ?? '')
    const amount = args.amount === undefined ? 1 : Number(args.amount)
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      throw new ToolFailure('invalid', 'direction must be up, down, left or right.')
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 50) {
      throw new ToolFailure('invalid', 'amount must be a number of screens from 0 to 50.')
    }
    const viewport = await this.viewport(sessionId)
    let x = viewport.width / 2
    let y = viewport.height / 2
    if (args.ref !== undefined) {
      const backend = this.resolveRef(page, String(args.ref))
      await this.send(sessionId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backend }).catch(
        () => {},
      )
      const spot = await this.onElement<{ x: number; y: number }>(
        sessionId,
        backend,
        `function () {
          const rect = this.getBoundingClientRect()
          let x = rect.x + rect.width / 2
          let y = rect.y + rect.height / 2
          let view = window
          for (let depth = 0; depth < 8 && view !== window.top; depth++) {
            const frame = view.frameElement
            if (!frame) break
            const box = frame.getBoundingClientRect()
            x += box.x
            y += box.y
            view = frame.ownerDocument.defaultView
          }
          return { x, y }
        }`,
      )
      x = spot.x
      y = spot.y
    }
    const step = amount
    const deltaX =
      direction === 'left'
        ? -step * viewport.width
        : direction === 'right'
          ? step * viewport.width
          : 0
    const deltaY =
      direction === 'up'
        ? -step * viewport.height
        : direction === 'down'
          ? step * viewport.height
          : 0
    await this.send(sessionId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    })
    return this.afterAction(sessionId, page, `Scrolled ${direction} ${amount} screen(s).`)
  }

  private async viewport(sessionId: string): Promise<{ width: number; height: number }> {
    const metrics = await this.send<{
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
    }>(sessionId, 'Page.getLayoutMetrics')
    const view = metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? {}
    return { width: view.clientWidth ?? 1280, height: view.clientHeight ?? 800 }
  }

  private async select(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const backend = this.resolveRef(page, String(args.ref ?? ''))
    const values = Array.isArray(args.values) ? args.values.map(String) : []
    if (values.length === 0)
      throw new ToolFailure('invalid', 'values must list at least one option.')
    const { object } = await this.send<{ object: { objectId?: string } }>(
      sessionId,
      'DOM.resolveNode',
      { backendNodeId: backend },
    )
    if (!object?.objectId) {
      throw new ToolFailure(
        'stale_ref',
        'That element is no longer on the page. Take a new snapshot.',
      )
    }
    const result = await this.send<{
      result?: { value?: string | null }
      exceptionDetails?: { exception?: { description?: string } }
    }>(sessionId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function (wanted) {
        if (this.tagName !== 'SELECT') return 'not a select element'
        const options = [...this.options]
        const chosen = options.filter((option) => wanted.includes(option.value) || wanted.includes(option.label) || wanted.includes(option.text))
        if (chosen.length === 0) return 'no option matches ' + wanted.join(', ') + '; the options are: ' + options.map((option) => option.value).join(', ')
        if (!this.multiple) {
          this.value = chosen[0].value
        } else {
          for (const option of options) option.selected = chosen.includes(option)
        }
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
        return null
      }`,
      arguments: [{ value: values }],
      returnByValue: true,
    })
    const refusal = result.result?.value
    if (refusal) {
      throw new ToolFailure(
        'invalid',
        `${describe(args, 'The element')} could not take those values: ${refusal}.`,
      )
    }
    return this.afterAction(
      sessionId,
      page,
      `Selected ${values.map((value) => JSON.stringify(value)).join(', ')} in ${describe(args, 'the element')}.`,
    )
  }

  private async screenshot(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const fullPage = args.full_page === true
    let clip: { x: number; y: number; width: number; height: number } | null = null
    let what = 'the page'
    if (args.ref !== undefined) {
      const backend = this.resolveRef(page, String(args.ref))
      await this.send(sessionId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backend }).catch(
        () => {},
      )
      // The element's box in the top document, so a capture clips where the element shows.
      const box = await this.onElement<{
        x: number
        y: number
        width: number
        height: number
      }>(
        sessionId,
        backend,
        `function () {
          const rect = this.getBoundingClientRect()
          let x = rect.x
          let y = rect.y
          let view = window
          for (let depth = 0; depth < 8 && view !== window.top; depth++) {
            const frame = view.frameElement
            if (!frame) break
            const outer = frame.getBoundingClientRect()
            x += outer.x
            y += outer.y
            view = frame.ownerDocument.defaultView
          }
          return { x: x + window.scrollX, y: y + window.scrollY, width: rect.width, height: rect.height }
        }`,
      )
      if (box.width <= 0 || box.height <= 0) {
        throw new ToolFailure('invalid', 'That element has no box to capture.')
      }
      clip = box
      what = describe(args, 'the element')
    } else if (fullPage) {
      const metrics = await this.send<{ cssContentSize?: { width?: number; height?: number } }>(
        sessionId,
        'Page.getLayoutMetrics',
      )
      const width = Math.max(1, Math.round(metrics.cssContentSize?.width ?? 0))
      const height = Math.min(
        MAX_PAGE_HEIGHT,
        Math.max(1, Math.round(metrics.cssContentSize?.height ?? 0)),
      )
      clip = { x: 0, y: 0, width, height }
      what = 'the whole page'
    }
    const ratio = await this.devicePixelRatio(sessionId)
    if (!clip) {
      // The viewport is the clip when none was asked for, so its longer side caps too.
      const view = await this.viewport(sessionId)
      const longest = Math.max(view.width, view.height) * ratio
      if (longest > MAX_SHOT_SIDE) {
        clip = { x: 0, y: 0, width: view.width, height: view.height }
      }
    }
    const longest = clip ? Math.max(clip.width, clip.height) * ratio : 0
    const scale = clip && longest > MAX_SHOT_SIDE ? MAX_SHOT_SIDE / longest : 1
    const captured = await this.send<{ data: string }>(sessionId, 'Page.captureScreenshot', {
      format: 'png',
      ...(clip
        ? {
            clip: { ...clip, scale },
            // The viewport clip stays as the user sees it; the others reach past it.
            captureBeyondViewport: args.ref !== undefined || fullPage,
          }
        : { captureBeyondViewport: false }),
    })
    const contents = this.contentsOf(sessionId)
    return {
      text: `Took a screenshot of ${what} at ${contents.getURL() || 'about:blank'}.`,
      value: { url: contents.getURL(), title: contents.getTitle() },
      image: captured.data,
    }
  }

  private async devicePixelRatio(sessionId: string): Promise<number> {
    try {
      const result = await this.send<{ result?: { value?: number } }>(
        sessionId,
        'Runtime.evaluate',
        { expression: 'window.devicePixelRatio', returnByValue: true },
      )
      const ratio = result.result?.value
      return typeof ratio === 'number' && ratio > 0 ? ratio : 1
    } catch {
      return 1
    }
  }

  private async waitFor(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const text = args.text === undefined ? undefined : String(args.text)
    const gone = args.text_gone === undefined ? undefined : String(args.text_gone)
    const seconds = args.time === undefined ? undefined : Number(args.time)
    if (text === undefined && gone === undefined && seconds === undefined) {
      throw new ToolFailure('invalid', 'Give text, text_gone or time to wait for.')
    }
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0 || seconds > 30)) {
      throw new ToolFailure('invalid', 'time must be 0 to 30 seconds.')
    }
    const deadline = Date.now() + (seconds ?? 30) * 1000
    if (text !== undefined || gone !== undefined) {
      let seen: boolean
      for (;;) {
        const body = await this.pageText(sessionId)
        seen = text !== undefined ? body.includes(text) : !body.includes(gone!)
        if (seen || Date.now() >= deadline) break
        this.deps.control.assert(sessionId)
        await sleep(100)
      }
      if (!seen) {
        throw new ToolFailure(
          'timeout',
          text !== undefined
            ? `"${text}" did not appear within ${seconds ?? 30} s.`
            : `"${gone}" was still on the page after ${seconds ?? 30} s.`,
        )
      }
    } else {
      const until = Date.now() + (seconds ?? 0) * 1000
      while (Date.now() < until) {
        this.deps.control.assert(sessionId)
        await sleep(Math.min(100, Math.max(1, until - Date.now())))
      }
    }
    const contents = this.contentsOf(sessionId)
    const { outline } = await this.capture(sessionId, page)
    return {
      text:
        text !== undefined
          ? `"${text}" appeared.`
          : gone !== undefined
            ? `"${gone}" left the page.`
            : `Waited ${seconds ?? 0} s.`,
      value: { url: contents.getURL(), title: contents.getTitle(), snapshot: outline },
    }
  }

  private async pageText(sessionId: string): Promise<string> {
    const result = await this.send<{ result?: { value?: string } }>(sessionId, 'Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    })
    return result.result?.value ?? ''
  }

  private async consoleMessages(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const since = args.since_navigation === true
    const messages = page.console
      .filter((message) => !since || message.nav === page.nav)
      .map(({ level, text, url, line }) => ({ level, text, url, line }))
    return {
      text:
        messages.length === 0
          ? 'No console messages.'
          : `${messages.length} console message${messages.length === 1 ? '' : 's'}, oldest first.`,
      value: { messages },
    }
  }

  private async networkRequests(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const since = args.since_navigation === true
    const requests = page.requests
      .filter((request) => !since || request.nav === page.nav)
      .map(({ method, url, status, type, size }) => ({ method, url, status, type, size }))
    return {
      text:
        requests.length === 0
          ? 'No network requests.'
          : `${requests.length} network request${requests.length === 1 ? '' : 's'}, oldest first.`,
      value: { requests },
    }
  }

  private async evaluate(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const source = String(args.function ?? '')
    if (source.trim() === '') throw new ToolFailure('invalid', 'function must be JavaScript.')
    let objectId: string | undefined
    if (args.ref !== undefined) {
      const backend = this.resolveRef(page, String(args.ref))
      const resolved = await this.send<{ object: { objectId?: string } }>(
        sessionId,
        'DOM.resolveNode',
        { backendNodeId: backend },
      )
      objectId = resolved.object.objectId
      if (!objectId) {
        throw new ToolFailure(
          'stale_ref',
          'That element is no longer on the page. Take a new snapshot.',
        )
      }
    } else {
      const global = await this.send<{ result?: { objectId?: string } }>(
        sessionId,
        'Runtime.evaluate',
        { expression: 'globalThis' },
      )
      objectId = global.result?.objectId
      if (!objectId) throw new ToolFailure('invalid', 'The page did not answer.')
    }
    const result = await this.send<{
      result?: { value?: unknown; unserializableValue?: string; description?: string }
      exceptionDetails?: { exception?: { description?: string }; text?: string }
    }>(sessionId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: source,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Error'
      throw new ToolFailure('invalid', `The function failed: ${detail}`)
    }
    const raw = result.result?.value
    let json: string
    try {
      json = JSON.stringify(raw ?? null) ?? 'null'
    } catch {
      json = String(raw)
    }
    if (!json) json = 'null'
    if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) {
      json = `${json.slice(0, MAX_VALUE_BYTES)}\n… the value was longer than 64 KB`
    }
    const contents = this.contentsOf(sessionId)
    return {
      text: `Ran the function on ${contents.getURL() || 'about:blank'}.`,
      value: { value: json },
    }
  }
}

function argumentText(argument: Record<string, unknown>): string {
  const value = argument.value
  if (value !== undefined) return typeof value === 'string' ? value : JSON.stringify(value)
  if (argument.unserializableValue !== undefined) return String(argument.unserializableValue)
  if (argument.description !== undefined) return String(argument.description)
  return String(argument.type ?? '')
}

/** A console message's level, in Chrome's words. */
function consoleLevel(type: unknown): string {
  switch (type) {
    case 'warning':
      return 'warn'
    case 'startGroup':
    case 'startGroupCollapsed':
    case 'endGroup':
    case 'debug':
    case 'verbose':
      return 'debug'
    case 'error':
    case 'assert':
      return 'error'
    case 'info':
      return 'info'
    default:
      return 'log'
  }
}

function describe(args: Record<string, unknown>, fallback: string): string {
  const element = args.element
  if (typeof element === 'string' && element.trim() !== '') return `"${element.trim()}"`
  const ref = args.ref
  return typeof ref === 'string' ? `ref ${ref}` : fallback
}

function clickButton(value: unknown): string {
  if (value === undefined) return 'left'
  if (value === 'left' || value === 'right' || value === 'middle') return value
  throw new ToolFailure('invalid', 'button must be left, right or middle.')
}

function buttonMask(button: string): number {
  return button === 'right' ? 2 : button === 'middle' ? 4 : 1
}
