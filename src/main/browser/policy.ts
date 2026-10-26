// What keeps the side panel's browser to plain web pages: one partition for every session, with
// every permission refused, downloads stopped, and requests to OverBench's own surfaces cancelled.

import type { Session, WebContents } from 'electron'
import { refuseRequests } from '../request-filter'

/** A request that never leaves the partition: a local file or one of OverBench's own schemes. */
export function isForbiddenRequest(url: string, servicePort: number | null): boolean {
  if (url.startsWith('file:') || url.startsWith('overbench-')) return true
  if (servicePort === null) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
    parsed.port === String(servicePort)
  )
}

/** Whether a top-level navigation may happen: http(s), and an empty document. */
export function isAllowedNavigation(url: string): boolean {
  return url === 'about:blank' || url === 'about:srcdoc' || isHttp(url)
}

/** Whether an address is one the page may load; the pane only ever asks for these. */
export function isHttp(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** The user agent of the Chromium Electron ships, without the token that names Electron. */
export function stripElectronUserAgent(userAgent: string): string {
  return userAgent.replace(/\sElectron\/[\d.]+/g, '')
}

export interface BrowserPolicyDeps {
  /** A page asked to download; the pane tells the user and points at the system browser. */
  downloadBlocked(contents: WebContents): void
}

/** The partition's rules, set once for every page. */
export class BrowserPolicy {
  private servicePort: number | null = null
  private installed = false

  constructor(
    private readonly session: Session,
    private readonly deps: BrowserPolicyDeps,
  ) {}

  install(): void {
    if (this.installed) return
    this.installed = true
    this.session.setUserAgent(stripElectronUserAgent(this.session.getUserAgent()))
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.session.setPermissionCheckHandler(() => false)
    this.session.setDevicePermissionHandler(() => false)
    this.session.on('will-download', (event, _item, contents) => {
      event.preventDefault()
      this.deps.downloadBlocked(contents)
    })
    refuseRequests(this.session, (details) => isForbiddenRequest(details.url, this.servicePort))
  }

  /** The artifacts service's port, which a page must never reach; null while it does not run. */
  setServicePort(port: number | null): void {
    this.servicePort = port
  }
}

/** Sends a link meant for a new window to the same page, and opens no window at all. */
export function navigateInPlace(contents: WebContents, url: string): void {
  if (!isAllowedNavigation(url) || url === 'about:srcdoc') return
  void contents.loadURL(url)
}
