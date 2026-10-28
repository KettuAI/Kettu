/** The partition every page in the side panel's browser uses, shared by all sessions. */
export const BROWSER_PARTITION = 'persist:overbench-browser'

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

/** The browser tools the `overbench` MCP server offers, which main runs on the page. */
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
