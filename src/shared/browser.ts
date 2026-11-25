import type { SurfaceControl } from './control'

/** The partition every page in the side panel's browser uses, shared by all sessions. */
export const BROWSER_PARTITION = 'persist:kettu-browser'

/** Where the page sits in the window, in device-independent pixels. */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
  /** The radius of the page's corners, as the pane's frame for it draws them. */
  radius: number
}

/** The size a page lays out at, in its own CSS pixels. */
export interface BrowserViewport {
  width: number
  height: number
}

/** The sizes a page can be given by name, by an agent's `browser_resize` or the pane's menu. */
export const PAGE_SIZE_NAMES = ['desktop', 'tablet', 'phone'] as const
export type PageSizeName = (typeof PAGE_SIZE_NAMES)[number]

/** A size a page keeps, and whether it lays out there as a phone or a tablet does. */
export interface PageSize extends BrowserViewport {
  /** Which named size it is; custom for a width and height an agent gave. */
  name: PageSizeName | 'custom'
  /** Touch, a mobile browser's user agent and the page's own viewport tag. */
  mobile: boolean
}

export const PAGE_SIZES: Record<PageSizeName, PageSize> = {
  desktop: { name: 'desktop', width: 1280, height: 800, mobile: false },
  tablet: { name: 'tablet', width: 768, height: 1024, mobile: true },
  phone: { name: 'phone', width: 390, height: 844, mobile: true },
}

/**
 * The size the pages an agent uses lay out at until it or the user picks another. It never follows
 * the pane, so the page an agent reads and clicks stays as it is while the user resizes around it.
 */
export const AGENT_VIEWPORT: PageSize = PAGE_SIZES.desktop

/** The sides of a size an agent gives itself, in CSS pixels. */
export const MIN_PAGE_SIDE = 320
export const MAX_PAGE_SIDE = 2560

/** The size `browser_resize`'s arguments ask for, or what is wrong with them. */
export function pageSizeOf(args: Record<string, unknown>): PageSize | { error: string } {
  const { size, width, height } = args
  if (size !== undefined) {
    if (width !== undefined || height !== undefined) {
      return { error: 'Give size, or width and height, not both.' }
    }
    if (!(PAGE_SIZE_NAMES as readonly unknown[]).includes(size)) {
      return { error: 'size must be desktop, tablet or phone.' }
    }
    return PAGE_SIZES[size as PageSizeName]
  }
  const side = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PAGE_SIDE &&
    value <= MAX_PAGE_SIDE
  if (width === undefined && height === undefined) {
    return { error: 'Give size (desktop, tablet or phone), or width and height.' }
  }
  if (!side(width) || !side(height)) {
    return {
      error: `width and height must both be whole numbers from ${MIN_PAGE_SIDE} to ${MAX_PAGE_SIDE}.`,
    }
  }
  return { name: 'custom', width, height, mobile: false }
}

/** Whether two sizes lay a page out the same. */
export function samePageSize(a: PageSize | null, b: PageSize | null): boolean {
  if (a === null || b === null) return a === b
  return a.name === b.name && a.width === b.width && a.height === b.height && a.mobile === b.mobile
}

/** The room kept under a page of a fixed size for the line with its size, in CSS pixels. */
export const SIZE_LINE_ROOM = 36

/**
 * Where a page of a fixed size shows in the pane's frame: whole, scaled down to fit and never
 * enlarged, at the top and centred, with `below` of the frame's height kept free under it. `scale`
 * is exact for the box's width, so the page's picture ends where the box does.
 */
export function fitViewport(
  frame: BrowserBounds,
  viewport: BrowserViewport,
  below = 0,
): { bounds: BrowserBounds; scale: number } {
  const room = Math.max(1, frame.height - below)
  const fit = Math.min(1, frame.width / viewport.width, room / viewport.height)
  const width = Math.max(1, Math.floor(viewport.width * fit))
  const scale = width / viewport.width
  const height = Math.max(1, Math.min(room, Math.round(viewport.height * scale)))
  return {
    bounds: {
      x: frame.x + Math.floor((frame.width - width) / 2),
      y: frame.y,
      width,
      height,
      radius: frame.radius,
    },
    scale,
  }
}

/**
 * Something the pane says under its header: a download it refused, a page that did not load, or
 * one whose renderer crashed or stopped responding.
 */
export type BrowserNotice =
  | { kind: 'download-blocked' }
  | { kind: 'load-failed'; description: string }
  | { kind: 'crashed' }
  | { kind: 'unresponsive' }

/** What the user answered a request to open a new origin. */
export type BrowserOriginDecision = 'session' | 'project' | 'deny'

export function isOriginDecision(value: unknown): value is BrowserOriginDecision {
  return value === 'session' || value === 'project' || value === 'deny'
}

/** The answer to a request to open a new origin; `timeout` when the user did not answer. */
export type BrowserOriginAnswer = BrowserOriginDecision | 'timeout'

/** How long a call waits for the user to answer a new origin before it fails. */
export const ORIGIN_WAIT_MS = 120_000

/** An origin an agent's page wanted to open, waiting for the user or answered. */
export interface BrowserOriginRequest {
  id: number
  origin: string
  /** null while it waits. */
  decision: BrowserOriginAnswer | null
}

/** The site a page shows, as a step asked for there names it: an http(s) address's host. */
export function siteOf(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const parsed = URL.parse(url)
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null
  return parsed.host || null
}

/** An origin without its scheme, as the pane and the thread name it to the user. */
export function originLabel(origin: string): string {
  return origin.replace(/^[a-z]+:\/\//, '') || origin
}

/** A tab in a session's browser, as the strip draws it. */
export interface BrowserTab {
  id: string
  url: string | null
  title: string | null
  loading: boolean
  /** Released to stay within the live limit: it loads again when shown. */
  released: boolean
  /** The tab whose page opened this one as a popup, while that tab is open. */
  opener: string | null
  /** Who opened it, and for the user's, whether they allowed the session's agent to use it. */
  by: 'agent' | 'user'
  allowed: boolean
}

/** The most tabs one session's browser holds. */
export const MAX_SESSION_TABS = 50

/**
 * What the pane draws for one session's browser: its tabs, and the selected tab's page in the
 * fields after them.
 */
export interface BrowserState {
  sessionId: string
  tabs: BrowserTab[]
  /** The tab the pane shows; null when the browser has none. */
  selected: string | null
  /** The tab the agent works in; null until it uses one. */
  agentTab: string | null
  url: string | null
  /** Whether the selected tab has a page, which main shows even before it has an address. */
  page: boolean
  /** The size the selected tab's page keeps; null when it fills the pane's frame. */
  viewport: PageSize | null
  /** An agent used the selected tab, so at the desktop's size it keeps one rather than filling. */
  agentUsed: boolean
  title: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  notice: BrowserNotice | null
  /** Who uses the agent's tab in the turn that runs. */
  control: SurfaceControl
  /** A new site that waits for the user, or the answer just given, for the pane's bar. */
  originRequest: BrowserOriginRequest | null
}

/** The browser tools the `kettu` MCP server offers, which main runs on the page. */
export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_reload',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_scroll',
  'browser_select_option',
  'browser_take_screenshot',
  'browser_wait_for',
  'browser_console_messages',
  'browser_network_requests',
  'browser_evaluate',
  'browser_ask_user',
  'browser_tabs',
  'browser_resize',
] as const

/** What `browser_tabs` does. */
export const BROWSER_TAB_ACTIONS = ['list', 'new', 'select', 'close'] as const
export type BrowserTabAction = (typeof BROWSER_TAB_ACTIONS)[number]

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number]

export type BrowserToolErrorCode =
  | 'user_has_control'
  // The turn ended, or the user stopped it, while the call waited on them.
  | 'stopped'
  | 'not_allowed'
  // The call would act on a tab the user opened, which the agent may use once they allow it.
  | 'needs_allow'
  | 'stale_ref'
  | 'timeout'
  | 'navigation_failed'
  | 'no_page'
  | 'invalid'
  // Nobody on a desktop app sent the turn, so no browser can open for it.
  | 'unavailable'

/** What an agent is told when the turn did not come from a desktop app, which has the browser. */
export const BROWSER_UNAVAILABLE =
  'The browser is unavailable: it opens in the Kettu desktop app of whoever sent this turn, and ' +
  'this turn did not come from one. Ask the user to check the page themselves, or to send their ' +
  'next message from the desktop app.'

/** A refused browser call, whose message says what to do next. */
export interface BrowserToolError {
  code: BrowserToolErrorCode
  message: string
  /** With `needs_allow`, the user's tab the call would act on. */
  tab?: { id: string; title: string }
}

/** What main answers for a browser call: the tool's result, or its error. */
export interface BrowserCallResult {
  /** One line of text saying what happened. */
  text: string
  /** The tool's structured value, as its output schema says. */
  value: Record<string, unknown>
  /** A PNG in base64, for browser_take_screenshot. */
  image?: string
}

export type BrowserCallAnswer = { result: BrowserCallResult } | { error: BrowserToolError }

/** A tool call forwarded from the agent host to main, answered by its id. */
export interface BrowserCallRequest {
  callId: number
  sessionId: string
  tool: BrowserToolName
  args: Record<string, unknown>
  /** The calling session's project, whose always-allowed sites the page reads. */
  projectPath: string
  /** A tab of the user's they just allowed the agent, which the call may then act on. */
  allowTab?: string
}

/** A dev server on the agent's own host, which another computer's page reaches through a forward. */
export interface BrowserForward {
  /** What the host connects to; `localhost` tries both of its loopback addresses. */
  host: 'localhost' | '127.0.0.1' | '::1'
  port: number
}

/**
 * A call for the desktop app that sent the turn, on another host than the agent's: a navigation to
 * a dev server there names the forward it needs, which the host grants that app's session.
 */
export interface BrowserDeviceCall extends BrowserCallRequest {
  forward?: BrowserForward
}

/** The forward an address needs to reach a dev server on the agent's host; null for others. */
export function loopbackForward(url: string): BrowserForward | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const name = parsed.hostname.toLowerCase()
  const host =
    name === '127.0.0.1'
      ? '127.0.0.1'
      : name === '[::1]'
        ? '::1'
        : name === 'localhost' || name.endsWith('.localhost')
          ? 'localhost'
          : null
  if (!host) return null
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)
  return { host, port }
}

/** Whether a value is a forward a host may grant. */
export function isBrowserForward(value: unknown): value is BrowserForward {
  if (typeof value !== 'object' || value === null) return false
  const { host, port } = value as Record<string, unknown>
  return (
    (host === 'localhost' || host === '127.0.0.1' || host === '::1') &&
    Number.isSafeInteger(port) &&
    (port as number) > 0 &&
    (port as number) < 65_536
  )
}
