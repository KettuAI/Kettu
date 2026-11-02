// One page per session in the side panel's browser. Main owns every page, since only it holds web
// contents; the renderer draws the pane's frame and tells main where the page sits.

import { BrowserWindow, session as electronSession, shell, View, WebContentsView } from 'electron'
import type { Input, Rectangle, WebContents } from 'electron'
import {
  BROWSER_PARTITION,
  type BrowserBounds,
  type BrowserControlState,
  type BrowserNotice,
  type BrowserOriginAnswer,
  type BrowserOriginDecision,
  type BrowserState,
} from '@shared/browser'
import { forwardedKey } from '../artifacts/guards'
import { sendEvent } from '../events'
import { createLogger } from '../log'
import type { AllowedSites } from '@shared/ipc'
import { originOf, BrowserOrigins, type BrowserOriginStore } from './origins'
import { BrowserPolicy, isAllowedNavigation, isHttp, navigateInPlace } from './policy'

const log = createLogger('browser')

/** Pages kept alive at once; the least recently used goes when one more is made. */
export const MAX_LIVE_PAGES = 4

/** What a page gets before the pane reports its bounds. */
export const DEFAULT_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 1280, height: 800, radius: 0 }

/** How long a navigation an agent asked for may take. */
export const NAVIGATION_TIMEOUT_MS = 30_000

// On macOS a page draws in its window's own compositor, so a view around it clips it: a frame
// rounds the page's lower corners and leaves its upper ones square under the pane's header.
// Elsewhere a page is a native window of its own that only its own radius clips, on all four
// corners alike.
const FRAMED = process.platform === 'darwin'

/** A navigation that ended, or the Chromium error that stopped it. */
export type NavigateResult =
  | { ok: true; url: string; title: string | null }
  // `not_allowed`: the user refused a new origin, or did not answer in time.
  | { ok: false; error: string; code?: 'not_allowed' }

interface Page {
  sessionId: string
  view: WebContentsView | null
  /** The view around the page that rounds its lower corners, on macOS. */
  frame: View | null
  bounds: BrowserBounds
  lastUrl: string | null
  lastTitle: string | null
  notice: BrowserNotice | null
  lastUsed: number
  shown: boolean
  frozen: boolean
  loading: boolean
  /** The navigation that has not ended yet, by the page's promise handlers. */
  pending: ((result: NavigateResult) => void) | null
  /** A navigation waits for the user to answer a new origin. */
  asking: boolean
  /** Restarts the pending navigation's time limit, which a site's wait extends. */
  restartWait: (() => void) | null
}

/** Whether a mouse event is the user using the page: a click, a wheel or a touch, not a hover. */
export function isUserMouse(type: string): boolean {
  return type !== 'mouseMove' && type !== 'mouseEnter' && type !== 'mouseLeave'
}

/**
 * The page's own keys: `Mod+[`, `Mod+]` and `Mod+R`, and outside macOS `Alt+Left` and `Alt+Right`
 * as well, the platform's back and forward in a browser.
 */
export function pageKey(
  input: Input,
  platform: NodeJS.Platform,
): 'back' | 'forward' | 'reload' | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null
  if (input.alt) {
    if (platform === 'darwin' || input.control || input.meta || input.shift) return null
    return input.code === 'ArrowLeft' ? 'back' : input.code === 'ArrowRight' ? 'forward' : null
  }
  if (!(platform === 'darwin' ? input.meta : input.control)) return null
  if (input.key === '[') return 'back'
  if (input.key === ']') return 'forward'
  return input.key.toLowerCase() === 'r' ? 'reload' : null
}

export interface BrowserViewsDeps {
  /** The window the pages sit over; null while none exists. */
  window(): BrowserWindow | null
  send(state: BrowserState): void
  /** A page opened a dialog, which was answered at once; the call in flight says so. */
  dialogOpened?(sessionId: string, type: string, accepted: boolean): void
  /** The user typed or used the mouse in a page, or used the pane's controls. */
  userInput?(sessionId: string): void
  /** The pane's Hand back was pressed. */
  handBack?(sessionId: string): void
  /** The driving bar's Stop was pressed. */
  stopDriving?(sessionId: string): void
  /** The control state to draw with a page's state. */
  control?(sessionId: string): BrowserControlState
  /** A page's web contents is ready, before its first navigation starts. */
  created?(sessionId: string, contents: WebContents): void
  /** A page's web contents is gone: its next one starts afresh. */
  closed?(sessionId: string): void
  /** An agent's call started or ended, so a hidden page keeps or gives up rendering. */
  driving?(sessionId: string, driving: boolean): void
  /** The projects' always-allowed origins, which the pages ask for before opening a site. */
  origins: BrowserOriginStore
  /** A page asked for a new origin, for the session's thread. */
  originAsked?(request: { id: number; sessionId: string; origin: string }): void
  /** The wait ended, so the session's card takes the answer too; from either place it is one. */
  originAnswered?(request: { id: number; sessionId: string; decision: BrowserOriginAnswer }): void
  /** A page went with its session, which the renderer no longer lists. */
  removed?(sessionId: string): void
  /** How long a new origin waits for the user; set only by tests, which cannot wait 2 minutes. */
  originWaitMs?: number
}

/**
 * A page's frame and the page inside it. The frame reaches `radius` above the page, as far as
 * the window allows, so its own rounded upper corners fall outside the page and only the page's
 * lower corners round, as the pane's do.
 */
export function framePage(bounds: BrowserBounds): { frame: Rectangle; page: Rectangle } {
  const above = Math.min(bounds.radius, bounds.y)
  return {
    frame: {
      x: bounds.x,
      y: bounds.y - above,
      width: bounds.width,
      height: bounds.height + above,
    },
    page: { x: 0, y: above, width: bounds.width, height: bounds.height },
  }
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
  /** The running call of each session, which an origin wait holds up. */
  private readonly originWaits = new Map<
    string,
    { callId: number; waiting: (on: boolean) => void }
  >()
  readonly origins: BrowserOrigins

  constructor(private readonly deps: BrowserViewsDeps) {
    this.policy = new BrowserPolicy(this.browserSession, {
      downloadBlocked: (contents) => this.downloadBlocked(contents.id),
    })
    this.policy.install()
    this.origins = new BrowserOrigins(deps.origins, {
      asked: (request) => deps.originAsked?.(request),
      settled: (request) => deps.originAnswered?.(request),
      changed: (sessionId) => {
        const page = this.pages.get(sessionId)
        if (page) this.emit(page)
      },
      ...(deps.originWaitMs !== undefined ? { waitMs: deps.originWaitMs } : {}),
    })
  }

  /** The artifacts service's port; a page never reaches it. */
  setServicePort(port: number | null): void {
    this.policy.setServicePort(port)
  }

  /** The project a session's page belongs to, from the agent's call that drives it. */
  setProject(sessionId: string, projectPath: string): void {
    this.origins.setProject(sessionId, projectPath)
  }

  /**
   * While an agent's call waits for a new origin, its own time limit grows to the wait's, so the
   * call fails `not_allowed` when the user does not answer rather than timing out first.
   */
  setOriginWait(
    sessionId: string,
    callId: number,
    waiting: ((waiting: boolean) => void) | null,
  ): void {
    if (!waiting) this.originWaits.delete(sessionId)
    else this.originWaits.set(sessionId, { callId, waiting })
  }

  /** The pane's or the card's answer to a new origin; both show the one request. */
  answerOrigin(sessionId: string, requestId: number, decision: BrowserOriginDecision): void {
    this.origins.answer(sessionId, requestId, decision)
  }

  /** Settings' always-allowed sites, and what its Remove takes away. */
  allowedSites(): AllowedSites[] {
    return this.origins.allowedSites()
  }

  removeAllowedSite(projectPath: string, origin: string): void {
    this.origins.removeAllowedSite(projectPath, origin)
  }

  /** Writes a pending allowed site before the app goes. */
  flushOrigins(): Promise<void> {
    return this.origins.flush()
  }

  show(sessionId: string): void {
    const page = this.page(sessionId)
    for (const other of this.pages.values()) {
      if (other !== page && other.shown) {
        other.shown = false
        this.setVisible(other, false)
      }
    }
    page.shown = true
    page.frozen = false
    page.lastUsed = Date.now()
    this.place(page)
    this.setVisible(page, true)
    this.emit(page)
  }

  hide(sessionId: string): void {
    const page = this.pages.get(sessionId)
    if (!page) return
    page.shown = false
    page.frozen = false
    this.setVisible(page, false)
  }

  setBounds(sessionId: string, bounds: BrowserBounds): void {
    const page = this.page(sessionId)
    page.bounds = bounds
    if (page.shown) this.place(page)
  }

  navigate(sessionId: string, url: string): void {
    if (!isHttp(url)) throw new Error('A browser page opens an http or https address only')
    const page = this.page(sessionId)
    this.open(page, url)
  }

  /** The web contents of a session's page, or null when it has none yet. */
  contents(sessionId: string): WebContents | null {
    const view = this.pages.get(sessionId)?.view
    const contents = view?.webContents
    return contents && !contents.isDestroyed() ? contents : null
  }

  /**
   * A page an agent drives keeps rendering timers and animations while it is hidden or behind the
   * pane; once idle it throttles as any background page does.
   */
  setDriving(sessionId: string, driving: boolean): void {
    const contents = this.contents(sessionId)
    if (!contents) return
    contents.setBackgroundThrottling(!driving)
  }

  /**
   * Opens `url` in the session's page, making one when it has none, and settles when the
   * navigation has ended: the page's address and title, or Chromium's error. An origin the page
   * may not open yet is asked for first, and the call fails `not_allowed` without an answer.
   */
  async load(sessionId: string, url: string): Promise<NavigateResult> {
    const page = this.page(sessionId)
    const asked = await this.askFor(page, url)
    if (asked) return asked
    return this.navigateAndWait(page, url)
  }

  /** One step back in the session's history, settled as `load` is. */
  async backAndWait(sessionId: string): Promise<NavigateResult> {
    const page = this.page(sessionId)
    const history = page.view?.webContents.navigationHistory
    if (!history?.canGoBack()) {
      throw new Error('There is no page before this one.')
    }
    const target = history.getEntryAtIndex(history.getActiveIndex() - 1)?.url
    if (target !== undefined) {
      const asked = await this.askFor(page, target)
      if (asked) return asked
    }
    const wait = this.waitForNavigation(page)
    history.goBack()
    return wait
  }

  /** Reloads the session's page, settled as `load` is. */
  async reloadAndWait(sessionId: string): Promise<NavigateResult> {
    const page = this.page(sessionId)
    if (!page.view) {
      if (!page.lastUrl) throw new Error('The page has no address to reload.')
      return this.load(sessionId, page.lastUrl)
    }
    const target = page.view.webContents.getURL()
    if (target) {
      const asked = await this.askFor(page, target)
      if (asked) return asked
    }
    const wait = this.waitForNavigation(page)
    page.view.webContents.reload()
    return wait
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
    this.setVisible(page, false)
    return image.toDataURL()
  }

  thaw(sessionId: string): void {
    const page = this.pages.get(sessionId)
    if (!page) return
    page.frozen = false
    if (page.shown) this.setVisible(page, true)
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
      this.deps.removed?.(sessionId)
    }
  }

  private page(sessionId: string): Page {
    let page = this.pages.get(sessionId)
    if (!page) {
      page = {
        sessionId,
        view: null,
        frame: null,
        bounds: DEFAULT_BOUNDS,
        lastUrl: null,
        lastTitle: null,
        notice: null,
        lastUsed: Date.now(),
        shown: false,
        frozen: false,
        loading: false,
        pending: null,
        asking: false,
        restartWait: null,
      }
      this.pages.set(sessionId, page)
    }
    return page
  }

  /** Loads `url` in the session's page, making one when there is none, and waits for its end. */
  private navigateAndWait(page: Page, url: string): Promise<NavigateResult> {
    const wait = this.waitForNavigation(page)
    this.open(page, url)
    return wait
  }

  /**
   * Asks for a new origin an agent's navigation wants, and settles with the refusal when the user
   * denies it or does not answer; null when it may open, so the caller goes on.
   */
  private async askFor(page: Page, url: string): Promise<NavigateResult | null> {
    if (!this.origins.needsAsking(page.sessionId, url)) return null
    const origin = originOf(url)
    if (origin === null) return null
    this.originWaiters(page.sessionId, true)
    const decision = await this.origins.ask(page.sessionId, origin)
    this.originWaiters(page.sessionId, false)
    if (decision === 'session' || decision === 'project') return null
    return {
      ok: false,
      code: 'not_allowed',
      error:
        decision === 'deny'
          ? `The user did not allow ${origin}.`
          : `${origin} was not opened: the user did not answer in time.`,
    }
  }

  /** Tells the call that drives the session's page that a site wait started or ended. */
  private originWaiters(sessionId: string, waiting: boolean): void {
    this.originWaits.get(sessionId)?.waiting(waiting)
  }

  /** Whether an agent's call drives the session's page, so its navigation is the agent's. */
  private agentDrives(sessionId: string): boolean {
    return this.deps.control?.(sessionId)?.kind === 'agent'
  }

  /**
   * A link or a redirect in the page wants to open `url` while an agent drives: a new origin is
   * asked for, and the navigation waits for the answer.
   */
  private navigationWanted(page: Page, url: string): void {
    if (!this.agentDrives(page.sessionId) || !this.origins.needsAsking(page.sessionId, url)) return
    if (page.asking) return
    page.asking = true
    // Chromium reports the held-up navigation as finished; it settles when the answer comes.
    page.loading = false
    this.originWaiters(page.sessionId, true)
    const origin = originOf(url)
    if (origin === null) return
    void this.origins.ask(page.sessionId, origin).then((decision) => {
      page.asking = false
      page.restartWait?.()
      this.originWaiters(page.sessionId, false)
      const contents = this.contents(page.sessionId)
      if (!contents) return
      if (decision === 'session' || decision === 'project') {
        page.loading = true
        void contents.loadURL(url).catch((error: unknown) => {
          log.warn(`Could not load ${url}: ${(error as Error).message}`)
        })
        this.emit(page)
        return
      }
      this.endNavigation(page, {
        ok: false,
        code: 'not_allowed',
        error:
          decision === 'deny'
            ? `The user did not allow ${origin}.`
            : `${origin} was not opened: the user did not answer in time.`,
      })
      this.emit(page)
    })
  }

  /**
   * Settles with what the page ends at, or the error that stopped it, whichever comes first:
   * `did-stop-loading`, `did-fail-load`, or the time limit.
   */
  private waitForNavigation(page: Page): Promise<NavigateResult> {
    page.pending?.({ ok: false, error: 'The navigation was replaced.' })
    let done = false
    let timer: ReturnType<typeof setTimeout>
    let resolve!: (result: NavigateResult) => void
    const promise = new Promise<NavigateResult>((settle) => (resolve = settle))
    const finish = (result: NavigateResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (page.pending === finish) page.pending = null
      if (page.restartWait === restart) page.restartWait = null
      resolve(result)
    }
    // A site that waits for the user takes longer than a page load, so the limit starts afresh
    // when the answer comes.
    const restart = (): void => {
      if (done) return
      clearTimeout(timer)
      timer = setTimeout(
        () => finish({ ok: false, error: 'Navigation timed out' }),
        NAVIGATION_TIMEOUT_MS,
      )
    }
    restart()
    page.pending = finish
    page.restartWait = restart
    return promise
  }

  private resultOf(page: Page, result: NavigateResult): NavigateResult {
    if (!result.ok) return result
    const contents = this.contents(page.sessionId)
    return {
      ok: true,
      url: contents?.getURL() || page.lastUrl || result.url,
      title: contents?.getTitle() || page.lastTitle || result.title,
    }
  }

  /** The page settled after a navigation, successfully or not. */
  private endNavigation(page: Page, result: NavigateResult): void {
    page.pending?.(this.resultOf(page, result))
    page.pending = null
  }

  /** Loads `url` in the session's page, making one when there is none. */
  private open(page: Page, url: string): void {
    const view = page.view ?? this.create(page.sessionId)
    page.lastUrl = url
    page.lastTitle = null
    page.notice = null
    page.lastUsed = Date.now()
    page.loading = true
    this.place(page)
    if (page.shown && !page.frozen) this.setVisible(page, true)
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
    if (FRAMED) {
      page.frame = new View()
      page.frame.addChildView(view)
    }
    window.contentView.addChildView(page.frame ?? view)
    this.place(page)
    this.setVisible(page, page.shown)
    this.wire(page, view)
    this.deps.created?.(sessionId, view.webContents)
    this.setDriving(sessionId, this.deps.control?.(sessionId)?.kind === 'agent')
    return view
  }

  /** Puts the page where the pane reported it, its lower corners rounded as the pane's are. */
  private place(page: Page): void {
    const { view, frame, bounds } = page
    if (!view) return
    const { x, y, width, height, radius } = bounds
    if (frame) {
      const framed = framePage(bounds)
      frame.setBounds(framed.frame)
      frame.setBorderRadius(radius)
      view.setBounds(framed.page)
    } else {
      view.setBounds({ x, y, width, height })
      view.setBorderRadius(radius)
    }
  }

  private setVisible(page: Page, visible: boolean): void {
    const shown = page.frame ?? page.view
    shown?.setVisible(visible)
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
    const attached = page.frame ?? view
    page.view = null
    page.frame = null
    page.loading = false
    page.asking = false
    this.origins.close(page.sessionId)
    if (!view || !attached) return
    const window = this.deps.window()
    if (window && !window.isDestroyed()) window.contentView.removeChildView(attached)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.deps.closed?.(page.sessionId)
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
      // A navigation held for the user's answer settles when the answer comes.
      if (page.asking) return
      this.endNavigation(page, { ok: true, url: contents.getURL(), title: contents.getTitle() })
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
      if (page.asking) return
      this.endNavigation(page, { ok: false, error: description })
    })
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) {
        event.preventDefault()
        return
      }
      if (!this.origins.needsAsking(page.sessionId, url) || !this.agentDrives(page.sessionId))
        return
      event.preventDefault()
      this.navigationWanted(page, url)
    })
    contents.on('will-redirect', (event, url) => {
      if (!isAllowedNavigation(url)) {
        event.preventDefault()
        return
      }
      if (!this.origins.needsAsking(page.sessionId, url) || !this.agentDrives(page.sessionId))
        return
      event.preventDefault()
      this.navigationWanted(page, url)
    })
    contents.on('will-prevent-unload', (event) => event.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      navigateInPlace(contents, url)
      return { action: 'deny' }
    })
    contents.on('before-input-event', (event, input) => {
      // The user typed in the page: they drive from here on, whatever the key was.
      this.deps.userInput?.(page.sessionId)
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
    contents.on('before-mouse-event', (_event, mouse) => {
      if (!isUserMouse(mouse.type)) return
      this.deps.userInput?.(page.sessionId)
    })
    this.silenceDialogs(contents)
    contents.once('destroyed', () => {
      if (page.view?.webContents === contents) {
        const window = this.deps.window()
        if (page.frame && window && !window.isDestroyed()) {
          window.contentView.removeChildView(page.frame)
        }
        page.view = null
        page.frame = null
        page.loading = false
        page.asking = false
        this.origins.close(page.sessionId)
        this.endNavigation(page, { ok: false, error: 'The page closed.' })
        this.deps.closed?.(page.sessionId)
      }
    })
  }

  /** Back, forward and reload while the page has focus; the app keeps the rest. */
  private shortcut(page: Page, input: Input): boolean {
    const key = pageKey(input, process.platform)
    if (key === 'back') this.back(page.sessionId)
    else if (key === 'forward') this.forward(page.sessionId)
    else if (key === 'reload') this.reload(page.sessionId)
    return key !== null
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
    let sessionId: string | null = null
    debuggerSession.on('message', (_event, method, params) => {
      if (method !== 'Page.javascriptDialogOpening') return
      const type = (params as { type?: string }).type
      const accepted = type === 'alert'
      void debuggerSession
        .sendCommand('Page.handleJavaScriptDialog', { accept: accepted })
        .catch(() => {})
      sessionId ??=
        [...this.pages.values()].find((page) => page.view?.webContents === contents)?.sessionId ??
        null
      if (sessionId) this.deps.dialogOpened?.(sessionId, type ?? 'alert', accepted)
    })
    void debuggerSession.sendCommand('Page.enable').catch(() => {})
  }

  /** Typing in the address field or using the pane's own controls takes control, as a click does. */
  userInput(sessionId: string): void {
    this.deps.userInput?.(sessionId)
  }

  /** The pane's Hand back: the agent may drive the page again. */
  handBack(sessionId: string): void {
    this.deps.handBack?.(sessionId)
  }

  /** The driving bar's Stop: the user takes control, and the running call fails. */
  stopDriving(sessionId: string): void {
    this.deps.stopDriving?.(sessionId)
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
      control: this.deps.control?.(page.sessionId) ?? { kind: 'none' },
      originRequest: this.origins.requestOf(page.sessionId),
    })
  }

  /** The pane's control state changed; its page state goes out again with it. */
  controlChanged(sessionId: string): void {
    const page = this.pages.get(sessionId)
    if (page) this.emit(page)
  }
}
