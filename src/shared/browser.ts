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

/** What the pane draws for one session's page. */
export interface BrowserState {
  sessionId: string
  url: string | null
  title: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  notice: BrowserNotice | null
}
