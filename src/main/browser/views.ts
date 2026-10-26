// One page per session in the side panel's browser. Main owns every page, since only it holds web
// contents; the renderer draws the pane's frame and tells main where the page sits.

import { BrowserWindow, session as electronSession, shell, WebContentsView } from 'electron'
import type { Input } from 'electron'
import {
  BROWSER_PARTITION,
  type BrowserBounds,
  type BrowserNotice,
  type BrowserState,
} from '@shared/browser'
import { forwardedKey } from '../artifacts/guards'
import { sendEvent } from '../events'
import { createLogger } from '../log'
import { BrowserPolicy, isAllowedNavigation, isHttp, navigateInPlace } from './policy'

const log = createLogger('browser')

/** Pages kept alive at once; the least recently used goes when one more is made. */
export const MAX_LIVE_PAGES = 4

/** What a page gets before the pane reports its bounds. */
export const DEFAULT_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 1280, height: 800 }

interface Page {
  sessionId: string
  view: WebContentsView | null
  bounds: BrowserBounds
  lastUrl: string | null
  lastTitle: string | null
  notice: BrowserNotice | null
  lastUsed: number
  shown: boolean
  frozen: boolean
  loading: boolean
}

export interface BrowserViewsDeps {
  /** The window the pages sit over; null while none exists. */
  window(): BrowserWindow | null
  send(state: BrowserState): void
}

/** The least recently used page among those with a live view, other than `keep`. */
export function leastRecentlyUsed(
  pages: Iterable<{ sessionId: string; lastUsed: number; live: boolean }>,
  keep: string,
): string | null {
  let oldest: { sessionId: string; lastUsed: number } | null = null
  for (const page of pages) {
    if (!page.live || page.sessionId === keep) continue
    if (!oldest || page.lastUsed < oldest.lastUsed) oldest = page
  }
  return oldest?.sessionId ?? null
}

export class BrowserViews {
  private readonly pages = new Map<string, Page>()
  private readonly policy: BrowserPolicy
  private readonly browserSession = electronSession.fromPartition(BROWSER_PARTITION)

  constructor(private readonly deps: BrowserViewsDeps) {
    this.policy = new BrowserPolicy(this.browserSession, {
      downloadBlocked: (contents) => this.downloadBlocked(contents.id),
    })
    this.policy.install()
  }

  /** The artifacts service's port; a page never reaches it. */
  setServicePort(port: number | null): void {
    this.policy.setServicePort(port)
  }

  show(sessionId: string): void {
    const page = this.page(sessionId)
    for (const other of this.pages.values()) {
      if (other !== page && other.shown) {
        other.shown = false
        other.view?.setVisible(false)
      }
    }
    page.shown = true
    page.frozen = false
    page.lastUsed = Date.now()
    if (page.view) {
      page.view.setBounds(page.bounds)
      page.view.setVisible(true)
    }
    this.emit(page)
  }

  hide(sessionId: string): void {
    const page = this.pages.get(sessionId)
    if (!page) return
    page.shown = false
    page.frozen = false
    page.view?.setVisible(false)
  }

  setBounds(sessionId: string, bounds: BrowserBounds): void {
    const page = this.page(sessionId)
    page.bounds = bounds
    if (page.shown && page.view) page.view.setBounds(bounds)
  }

  navigate(sessionId: string, url: string): void {
    if (!isHttp(url)) throw new Error('A browser page opens an http or https address only')
    const page = this.page(sessionId)
    this.open(page, url)
  }

  back(sessionId: string): void {
    const history = this.pages.get(sessionId)?.view?.webContents.navigationHistory
    if (history?.canGoBack()) history.goBack()
  }

  forward(sessionId: string): void {
    const history = this.pages.get(sessionId)?.view?.webContents.navigationHistory
    if (history?.canGoForward()) history.goForward()
  }

  reload(sessionId: string): void {
    const page = this.pages.get(sessionId)
    if (!page) return
    page.notice = null
    if (page.view) page.view.webContents.reload()
    else if (page.lastUrl) this.open(page, page.lastUrl)
    else this.emit(page)
  }

  stop(sessionId: string): void {
    this.pages.get(sessionId)?.view?.webContents.stop()
  }

  openExternal(sessionId: string): void {
    const page = this.pages.get(sessionId)
    const url = page?.view?.webContents.getURL() || page?.lastUrl
    if (url && isHttp(url)) void shell.openExternal(url)
  }

  /** Captures the page and hides the view, so the pane can show the still in its place. */
  async freeze(sessionId: string): Promise<string | null> {
    const page = this.pages.get(sessionId)
    if (!page?.view || !page.shown || page.frozen) return null
    const image = await page.view.webContents.capturePage()
    if (image.isEmpty()) return null
    page.frozen = true
    page.view.setVisible(false)
    return image.toDataURL()
  }

  thaw(sessionId: string): void {
    const page = this.pages.get(sessionId)
    if (!page) return
    page.frozen = false
    if (page.shown) page.view?.setVisible(true)
  }

  async clearData(): Promise<void> {
    await this.browserSession.clearStorageData()
    await this.browserSession.clearCache()
  }

  /** Closes the page of every session that no longer exists in the renderer's list. */
  setSessions(sessionIds: readonly string[]): void {
    const live = new Set(sessionIds)
    for (const [sessionId, page] of this.pages) {
      if (live.has(sessionId)) continue
      this.close(page)
      this.pages.delete(sessionId)
    }
  }

  private page(sessionId: string): Page {
    let page = this.pages.get(sessionId)
    if (!page) {
      page = {
        sessionId,
        view: null,
        bounds: DEFAULT_BOUNDS,
        lastUrl: null,
        lastTitle: null,
        notice: null,
        lastUsed: Date.now(),
        shown: false,
        frozen: false,
        loading: false,
      }
      this.pages.set(sessionId, page)
    }
    return page
  }

  /** Loads `url` in the session's page, making one when there is none. */
  private open(page: Page, url: string): void {
    const view = page.view ?? this.create(page.sessionId)
    page.lastUrl = url
    page.lastTitle = null
    page.notice = null
    page.lastUsed = Date.now()
    page.loading = true
    view.setBounds(page.bounds)
    if (page.shown && !page.frozen) view.setVisible(true)
    void view.webContents.loadURL(url).catch((error: unknown) => {
      log.warn(`Could not load ${url}: ${(error as Error).message}`)
    })
    this.emit(page)
  }

  private create(sessionId: string): WebContentsView {
    const window = this.deps.window()
    if (!window) throw new Error('The browser has no window to sit over')
    this.evictFor(sessionId)
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    const page = this.page(sessionId)
    page.view = view
    window.contentView.addChildView(view)
    view.setBounds(page.bounds)
    view.setVisible(page.shown)
    this.wire(page, view)
    return view
  }

  /** Closes the least recently used page when a new one would be the fifth. */
  private evictFor(sessionId: string): void {
    const live = [...this.pages.values()].filter((page) => page.view !== null)
    if (live.length < MAX_LIVE_PAGES) return
    const oldest = leastRecentlyUsed(
      live.map((page) => ({
        sessionId: page.sessionId,
        lastUsed: page.lastUsed,
        // The page in front of the user is never closed to make room.
        live: page.view !== null && !page.shown,
      })),
      sessionId,
    )
    if (!oldest) return
    const evicted = this.pages.get(oldest)
    if (!evicted) return
    this.close(evicted)
    evicted.notice = { kind: 'evicted' }
    this.emit(evicted)
  }

  private close(page: Page): void {
    const view = page.view
    page.view = null
    page.loading = false
    if (!view) return
    const window = this.deps.window()
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private wire(page: Page, view: WebContentsView): void {
    const contents = view.webContents
    const emit = () => this.emit(page)
    contents.on('did-start-loading', () => {
      page.loading = true
      emit()
    })
    contents.on('did-stop-loading', () => {
      page.loading = false
      emit()
    })
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      page.notice = null
      emit()
    })
    contents.on('did-navigate', (_event, url) => {
      if (isAllowedNavigation(url)) page.lastUrl = url
      emit()
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && isAllowedNavigation(url)) page.lastUrl = url
      emit()
    })
    contents.on('page-title-updated', (_event, title) => {
      page.lastTitle = title
      emit()
    })
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 is ERR_ABORTED, which a cancelled or replaced navigation reports.
      if (!isMainFrame || code === -3) return
      log.warn(`A page failed to load: ${description} (${code})`)
      page.notice = { kind: 'load-failed', description }
      page.loading = false
      emit()
    })
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!isAllowedNavigation(url)) event.preventDefault()
    })
    contents.on('will-prevent-unload', (event) => event.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      navigateInPlace(contents, url)
      return { action: 'deny' }
    })
    contents.on('before-input-event', (event, input) => {
      if (this.shortcut(page, input)) {
        event.preventDefault()
        return
      }
      // The app's shortcuts still work while the page has focus, as in an artifact's frame.
      const key = forwardedKey(input, process.platform)
      if (!key) return
      event.preventDefault()
      const window = this.deps.window()
      if (window && !window.isDestroyed()) sendEvent(window.webContents, 'app:shortcut', key)
    })
    this.silenceDialogs(contents)
    contents.once('destroyed', () => {
      if (page.view?.webContents === contents) {
        page.view = null
        page.loading = false
      }
    })
  }

  /** Back, forward and reload while the page has focus; the app keeps the rest. */
  private shortcut(page: Page, input: Input): boolean {
    if (input.type !== 'keyDown' || input.alt || input.isAutoRepeat) return false
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (!mod) return false
    if (input.key === '[') {
      this.back(page.sessionId)
      return true
    }
    if (input.key === ']') {
      this.forward(page.sessionId)
      return true
    }
    if (input.key.toLowerCase() === 'r') {
      this.reload(page.sessionId)
      return true
    }
    return false
  }

  /**
   * Answers alert, confirm and prompt at once, so a page that opens one never holds up an agent
   * or the pane. Chromium reports them only over the DevTools protocol.
   */
  private silenceDialogs(contents: WebContentsView['webContents']): void {
    const debuggerSession = contents.debugger
    try {
      if (!debuggerSession.isAttached()) debuggerSession.attach('1.3')
    } catch (error) {
      log.warn(`Could not watch a page's dialogs: ${(error as Error).message}`)
      return
    }
    debuggerSession.on('message', (_event, method, params) => {
      if (method !== 'Page.javascriptDialogOpening') return
      const type = (params as { type?: string }).type
      void debuggerSession
        .sendCommand('Page.handleJavaScriptDialog', { accept: type === 'alert' })
        .catch(() => {})
    })
    void debuggerSession.sendCommand('Page.enable').catch(() => {})
  }

  private downloadBlocked(contentsId: number): void {
    for (const page of this.pages.values()) {
      if (page.view?.webContents.id !== contentsId) continue
      page.notice = { kind: 'download-blocked' }
      this.emit(page)
      return
    }
  }

  private emit(page: Page): void {
    const view = page.view
    const contents = view?.webContents
    const url = (contents && !contents.isDestroyed() ? contents.getURL() : '') || page.lastUrl
    this.deps.send({
      sessionId: page.sessionId,
      url: url || null,
      title: page.lastTitle,
      loading: page.loading,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      notice: page.notice,
    })
  }
}
