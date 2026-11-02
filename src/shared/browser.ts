/** The partition every page in the side panel's browser uses, shared by all sessions. */
export const BROWSER_PARTITION = 'persist:kettu-browser'

/** Where the page sits in the window, in device-independent pixels. */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
  /** The radius of the pane's lower corners, which the page fills. */
  radius: number
}

/**
 * Something the pane says under its header: a download it refused, a page it lost to make room,
 * or a page that did not load.
 */
export type BrowserNotice =
  { kind: 'download-blocked' } | { kind: 'evicted' } | { kind: 'load-failed'; description: string }

/** Who drives a page: nobody, an agent's running call, or the user until they hand back. */
export type BrowserControlState =
  | { kind: 'none' }
  | { kind: 'agent' }
  // `bar` says whether the pane shows the bar: it leaves after 10 s without a call.
  | { kind: 'user'; bar: boolean }

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

/** An origin without its scheme, as the pane and the thread name it to the user. */
export function originLabel(origin: string): string {
  return origin.replace(/^[a-z]+:\/\//, '') || origin
}

/** What the pane draws for one session's page. */
export interface BrowserState {
  sessionId: string
  url: string | null
  title: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  notice: BrowserNotice | null
  control: BrowserControlState
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
] as const

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number]

export type BrowserToolErrorCode =
  | 'user_has_control'
  | 'not_allowed'
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
