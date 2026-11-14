// The tabs of each session's browser in the side panel. Main owns every page, since only it holds
// web contents; the renderer draws the pane's frame and tab strip and tells main where the page
// sits.

import { BrowserWindow, session as electronSession, shell, View, WebContentsView } from 'electron'
import type {
  HandlerDetails,
  Input,
  Rectangle,
  WebContents,
  WindowOpenHandlerResponse,
} from 'electron'
import {
  BROWSER_PARTITION,
  MAX_SESSION_TABS,
  type BrowserBounds,
  type BrowserNotice,
  type BrowserOriginAnswer,
  type BrowserOriginDecision,
  type BrowserState,
  type BrowserTab,
} from '@shared/browser'
import {
  IDLE_CONTROL,
  type ControlAgent,
  type ControlOverlayRequest,
  type ControlPoint,
  type SurfaceControl,
} from '@shared/control'
import type { SettingsFile } from '@shared/settings'
import type { ThemesState } from '@shared/themes'
import { forwardedKey } from '../artifacts/guards'
import { sendEvent } from '../events'
import { createLogger } from '../log'
import type { AllowedSites } from '@shared/ipc'
import { originOf, BrowserOrigins, type BrowserOriginStore } from './origins'
import { PageOverlay, type OverlayParent } from './overlay'
import { BrowserPolicy, isAllowedNavigation, isHttp } from './policy'
import { MAX_LIVE_TABS, TabStrip, tabsToRelease } from './tabs'

const log = createLogger('browser')

/** What a page gets before the pane reports its bounds. */
export const DEFAULT_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 1280, height: 800, radius: 0 }

/** How long a navigation an agent asked for may take. */
export const NAVIGATION_TIMEOUT_MS = 30_000

/** How long a screenshot for a message may take before it gives up. */
const CAPTURE_MS = 10_000

/** How long the overlay stays after the turn ended, while its light and pill leave. */
const OVERLAY_LEAVE_MS = 480

/** How long the overlay's page is kept, off screen, after the last turn that used a page ended. */
const OVERLAY_KEEP_MS = 60_000

// On macOS a page draws in its window's own compositor, so a view around it clips it: a frame
// rounds the page's corners as the pane's frame for it is rounded. Elsewhere a page is a native
// window of its own that only its own radius clips, on all four corners alike.
const FRAMED = process.platform === 'darwin'

/** A navigation that ended, or the Chromium error that stopped it. */
export type NavigateResult =
  | { ok: true; url: string; title: string | null }
  // `not_allowed`: the user refused a new origin, or did not answer in time.
  | { ok: false; error: string; code?: 'not_allowed' }

/** A tab as the agent's `browser_tabs` lists it. */
export interface AgentTabInfo {
  id: string
  url: string | null
  title: string | null
  released: boolean
}

interface Tab {
  id: string
  sessionId: string
  view: WebContentsView | null
  /** The view around the page that rounds its corners, on macOS. */
  frame: View | null
  lastUrl: string | null
  lastTitle: string | null
  notice: BrowserNotice | null
  /** When the pane last showed it, which the live limit releases by. */
  lastShown: number
  loading: boolean
  /** Its page was released to stay within the live limit; showing it loads it again. */
  released: boolean
  /** The navigation that has not ended yet, by the page's promise handlers. */
  pending: ((result: NavigateResult) => void) | null
  /** A navigation waits for the user to answer a new origin. */
  asking: boolean
  /** Restarts the pending navigation's time limit, which a site's wait extends. */
  restartWait: (() => void) | null
}

interface Browser {
  sessionId: string
  strip: TabStrip
  bounds: BrowserBounds
  shown: boolean
  frozen: boolean
  /** The session's agent, as the pane names it, for the overlay's pill. */
  agent: ControlAgent | null
}

/**
 * Whether a mouse event on a page is held back while the agent has it: a press, a release or a
 * click; a hover moves nothing and the wheel goes through.
 */
export function isHeldMouse(type: string): boolean {
  return (
    type !== 'mouseMove' && type !== 'mouseEnter' && type !== 'mouseLeave' && type !== 'mouseWheel'
  )
}

/**
 * The page's own keys: `Mod+[`, `Mod+]`, `Mod+R` and `Mod+T`, and outside macOS `Alt+Left` and
 * `Alt+Right` as well, the platform's back and forward in a browser.
 */
export function pageKey(
  input: Input,
  platform: NodeJS.Platform,
): 'back' | 'forward' | 'reload' | 'new-tab' | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null
  if (input.alt) {
    if (platform === 'darwin' || input.control || input.meta || input.shift) return null
    return input.code === 'ArrowLeft' ? 'back' : input.code === 'ArrowRight' ? 'forward' : null
  }
  if (!(platform === 'darwin' ? input.meta : input.control)) return null
  if (input.key === '[') return 'back'
  if (input.key === ']') return 'forward'
  const key = input.key.toLowerCase()
  if (key === 't' && !input.shift) return 'new-tab'
  return key === 'r' ? 'reload' : null
}

export interface BrowserViewsDeps {
  /** The window the pages sit over; null while none exists. */
  window(): BrowserWindow | null
  send(state: BrowserState): void
  /** A tab's page opened a dialog, which was answered at once; the call in flight says so. */
  dialogOpened?(tabId: string, type: string, accepted: boolean): void
  /** Who uses a session's browser, which the pane, the label and the overlay draw. */
  control?(sessionId: string): SurfaceControl
  /** Whether an input event a tab's page reports right now is the agent's own. */
  isInjecting?(tabId: string): boolean
  /** The overlay's Take over, Hand back, Done or Skip on a page. */
  overlayRequest?(sessionId: string, request: ControlOverlayRequest): void
  /** What the overlay's page reads to look as the window does. */
  settings?(): SettingsFile
  themes?(): ThemesState
  systemLocale?: string
  /** A tab's web contents is ready, before its first navigation starts. */
  created?(tabId: string, contents: WebContents): void
  /** A tab's web contents is gone: its next one starts afresh. */
  closed?(tabId: string): void
  /** The agent's tab crashed or stopped responding: a call waiting on it fails with `message`. */
  failed?(sessionId: string, kind: 'crashed' | 'unresponsive', message: string): void
  /** The projects' always-allowed origins, which the pages ask for before opening a site. */
  origins: BrowserOriginStore
  /** A page asked for a new origin, for the session's thread. */
  originAsked?(request: { id: number; sessionId: string; origin: string }): void
  /** The wait ended, so the session's card takes the answer too; from either place it is one. */
  originAnswered?(request: { id: number; sessionId: string; decision: BrowserOriginAnswer }): void
  /** A browser went with its session, which the renderer no longer lists. */
  removed?(sessionId: string): void
  /** A session's browser closed its last tab: nothing drives it now. */
  ended?(sessionId: string): void
  /** A page opened a site, and later named its icons, which links in replies show. */
  siteOpened?(pageUrl: string, favicons?: string[]): void
  /** How long a new origin waits for the user; set only by tests, which cannot wait 2 minutes. */
  originWaitMs?: number
}

/** A page's frame and the page inside it: the frame is the page's own box, all four corners round. */
export function framePage(bounds: BrowserBounds): { frame: Rectangle; page: Rectangle } {
  return {
    frame: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    page: { x: 0, y: 0, width: bounds.width, height: bounds.height },
  }
}

let nextTab = 1

export class BrowserViews {
  private readonly browsers = new Map<string, Browser>()
  private readonly tabs = new Map<string, Tab>()
  private readonly policy: BrowserPolicy
  private readonly browserSession = electronSession.fromPartition(BROWSER_PARTITION)
  /** The running call of each session, which an origin wait holds up. */
  private readonly originWaits = new Map<
    string,
    { callId: number; waiting: (on: boolean) => void }
  >()
  readonly origins: BrowserOrigins
  private readonly overlay: PageOverlay
  /** The tab the overlay covers or last covered. */
  private overlayTab: string | null = null
  /** Takes the overlay off its page once its leaving has played. */
  private overlayLeave: ReturnType<typeof setTimeout> | null = null
  /** Lets the overlay's page go once no turn has used a page for a while. */
  private overlayDrop: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: BrowserViewsDeps) {
    this.policy = new BrowserPolicy(this.browserSession, {
      downloadBlocked: (contents) => this.downloadBlocked(contents.id),
    })
    this.policy.install()
    this.origins = new BrowserOrigins(deps.origins, {
      asked: (request) => deps.originAsked?.(request),
      settled: (request) => deps.originAnswered?.(request),
      changed: (sessionId) => {
        const browser = this.browsers.get(sessionId)
        if (browser) this.emit(browser)
      },
      ...(deps.originWaitMs !== undefined ? { waitMs: deps.originWaitMs } : {}),
    })
    this.overlay = new PageOverlay({
      window: () => deps.window(),
      systemLocale: deps.systemLocale ?? 'en',
      settings: () => deps.settings!(),
      themes: () => deps.themes!(),
      zoom: () => deps.settings?.().appearance.zoom ?? 1,
      request: (sessionId, request) => {
        if (request.type === 'wheel') this.wheel(sessionId, request)
        else deps.overlayRequest?.(sessionId, request)
      },
      key: (sessionId, input) => this.appKey(sessionId, input),
    })
  }

  /** The artifacts service's port; a page never reaches it. */
  setServicePort(port: number | null): void {
    this.policy.setServicePort(port)
  }

  /** The project a session's browser belongs to, from the agent's call that drives it. */
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

  show(sessionId: string, agent: ControlAgent | null = null): void {
    const browser = this.browser(sessionId)
    browser.agent = agent
    for (const other of this.browsers.values()) {
      if (other !== browser && other.shown) {
        other.shown = false
        this.present(other)
      }
    }
    browser.shown = true
    browser.frozen = false
    this.present(browser)
    this.emit(browser)
    this.syncOverlay()
  }

  hide(sessionId: string): void {
    const browser = this.browsers.get(sessionId)
    if (!browser) return
    browser.shown = false
    browser.frozen = false
    this.present(browser)
    this.syncOverlay()
  }

  /**
   * Destroys every tab of the session's browser. The session stays, so the next navigation starts
   * a new tab; hiding still only takes the pages off screen.
   */
  close(sessionId: string): void {
    const browser = this.browsers.get(sessionId)
    if (!browser) return
    for (const tab of this.tabsOf(browser)) this.dropTab(tab)
    browser.strip.clear()
    this.origins.close(sessionId)
    this.emit(browser)
    this.browsers.delete(sessionId)
    this.deps.ended?.(sessionId)
    this.syncOverlay()
  }

  /** A blank tab the user opened, at the end of the strip and selected. */
  newTab(sessionId: string): string | null {
    const browser = this.browser(sessionId)
    if (browser.strip.size >= MAX_SESSION_TABS) return null
    const tab = this.addTab(browser, { select: true, agent: false })
    this.present(browser)
    this.emit(browser)
    this.syncOverlay()
    return tab.id
  }

  /** The user picked a tab: the pane shows it, and the agent keeps its own. */
  selectTab(sessionId: string, tabId: string): void {
    const browser = this.browsers.get(sessionId)
    if (!browser?.strip.select(tabId)) return
    this.present(browser)
    this.emit(browser)
    this.syncOverlay()
  }

  /** Closes one tab; closing the last one closes the browser. */
  closeTab(sessionId: string, tabId: string): void {
    const browser = this.browsers.get(sessionId)
    if (!browser?.strip.has(tabId)) return
    if (browser.strip.size === 1) return this.close(sessionId)
    const tab = this.tabs.get(tabId)
    if (tab) this.dropTab(tab)
    browser.strip.remove(tabId)
    this.present(browser)
    this.emit(browser)
    this.syncOverlay()
  }

  setBounds(sessionId: string, bounds: BrowserBounds): void {
    const browser = this.browser(sessionId)
    browser.bounds = bounds
    for (const tab of this.tabsOf(browser)) this.place(tab)
  }

  /** The user's own navigation, in the selected tab, or a new one when the browser has none. */
  navigate(sessionId: string, url: string): void {
    if (!isHttp(url)) throw new Error('A browser page opens an http or https address only')
    const browser = this.browser(sessionId)
    const tab = this.selectedTab(browser) ?? this.addTab(browser, { select: true, agent: false })
    this.open(tab, url)
  }

  /** The tab the agent's calls act on, which it keeps from then on; null when there is none. */
  agentTab(sessionId: string): string | null {
    return this.browsers.get(sessionId)?.strip.agentTarget() ?? null
  }

  /** The web contents of the agent's tab, or null when it has none now. */
  contents(sessionId: string): WebContents | null {
    const id = this.agentTab(sessionId)
    return id ? this.contentsOf(this.tabs.get(id)) : null
  }

  /** Whether the contents is one of the session pages. */
  owns(contents: WebContents): boolean {
    return [...this.tabs.values()].some((tab) => tab.view?.webContents === contents)
  }

  /**
   * The pages of a browser an agent drives keep rendering timers and animations while hidden or
   * behind the pane; once idle they throttle as any background page does.
   */
  setDriving(sessionId: string, driving: boolean): void {
    const browser = this.browsers.get(sessionId)
    if (!browser) return
    for (const tab of this.tabsOf(browser)) {
      this.contentsOf(tab)?.setBackgroundThrottling(!driving)
    }
  }

  /**
   * Opens `url` in the agent's tab, making one when the browser has none, and settles when the
   * navigation has ended: the page's address and title, or Chromium's error. An origin the page
   * may not open yet is asked for first, and the call fails `not_allowed` without an answer.
   */
  async load(sessionId: string, url: string): Promise<NavigateResult> {
    const browser = this.browser(sessionId)
    const id = browser.strip.agentTarget()
    const tab =
      (id ? this.tabs.get(id) : undefined) ?? this.addTab(browser, { select: true, agent: true })
    const asked = await this.askFor(tab, url)
    if (asked) return asked
    return this.navigateAndWait(tab, url)
  }

  /** One step back in the agent's tab, settled as `load` is. */
  async backAndWait(sessionId: string): Promise<NavigateResult> {
    const tab = this.agentTabOf(sessionId)
    const history = tab?.view?.webContents.navigationHistory
    if (!tab || !history?.canGoBack()) {
      throw new Error('There is no page before this one.')
    }
    const target = history.getEntryAtIndex(history.getActiveIndex() - 1)?.url
    if (target !== undefined) {
      const asked = await this.askFor(tab, target)
      if (asked) return asked
    }
    const wait = this.waitForNavigation(tab)
    history.goBack()
    return wait
  }

  /** Reloads the agent's tab, settled as `load` is. */
  async reloadAndWait(sessionId: string): Promise<NavigateResult> {
    const tab = this.agentTabOf(sessionId)
    if (!tab) throw new Error('The page has no address to reload.')
    if (!tab.view) {
      if (!tab.lastUrl) throw new Error('The page has no address to reload.')
      return this.load(sessionId, tab.lastUrl)
    }
    const target = tab.view.webContents.getURL()
    if (target) {
      const asked = await this.askFor(tab, target)
      if (asked) return asked
    }
    const wait = this.waitForNavigation(tab)
    tab.view.webContents.reload()
    return wait
  }

  /** The agent's tab was released: it loads its page again before a call acts on it. */
  async reviveAgentTab(sessionId: string): Promise<void> {
    const tab = this.agentTabOf(sessionId)
    if (!tab?.released || tab.view || !tab.lastUrl) return
    await this.navigateAndWait(tab, tab.lastUrl)
  }

  /** The session's tabs in the strip's order, the agent's current one and the selected one. */
  agentTabs(sessionId: string): {
    tabs: AgentTabInfo[]
    current: string | null
    selected: string | null
  } {
    const browser = this.browsers.get(sessionId)
    if (!browser) return { tabs: [], current: null, selected: null }
    return {
      tabs: this.tabsOf(browser).map((tab) => ({
        id: tab.id,
        url: this.urlOf(tab),
        title: tab.lastTitle,
        released: tab.released,
      })),
      current: browser.strip.agent,
      selected: browser.strip.selected,
    }
  }

  /**
   * A blank tab the agent opened, which becomes its current tab. The pane follows it only when it
   * showed the agent's tab, so a user reading another tab keeps it.
   */
  agentNewTab(sessionId: string): string | null {
    const browser = this.browser(sessionId)
    if (browser.strip.size >= MAX_SESSION_TABS) return null
    const tab = this.addTab(browser, { select: this.following(browser), agent: true })
    this.present(browser)
    this.emit(browser)
    this.syncOverlay()
    return tab.id
  }

  /** The agent switched to another tab, which loads again when it was released. */
  async agentSelectTab(sessionId: string, tabId: string): Promise<void> {
    const browser = this.browsers.get(sessionId)
    const tab = this.tabs.get(tabId)
    if (!browser || !tab || !browser.strip.has(tabId)) return
    const follow = this.following(browser)
    browser.strip.setAgent(tabId)
    if (follow) browser.strip.select(tabId)
    this.present(browser)
    this.emit(browser)
    this.syncOverlay()
    if (tab.released && !tab.view && tab.lastUrl) await this.navigateAndWait(tab, tab.lastUrl)
  }

  back(sessionId: string): void {
    const history = this.selected(sessionId)?.view?.webContents.navigationHistory
    if (history?.canGoBack()) history.goBack()
  }

  forward(sessionId: string): void {
    const history = this.selected(sessionId)?.view?.webContents.navigationHistory
    if (history?.canGoForward()) history.goForward()
  }

  reload(sessionId: string): void {
    const tab = this.selected(sessionId)
    if (tab) this.reloadTab(tab)
  }

  stop(sessionId: string): void {
    this.selected(sessionId)?.view?.webContents.stop()
  }

  openExternal(sessionId: string): void {
    const tab = this.selected(sessionId)
    const url = tab?.view?.webContents.getURL() || tab?.lastUrl
    if (url && isHttp(url)) void shell.openExternal(url)
  }

  /** Captures the shown page and hides the view, so the pane can show the still in its place. */
  async freeze(sessionId: string): Promise<string | null> {
    const browser = this.browsers.get(sessionId)
    const tab = browser ? this.selectedTab(browser) : null
    if (!browser || !tab?.view || !browser.shown || browser.frozen) return null
    const image = await tab.view.webContents.capturePage()
    if (image.isEmpty()) return null
    browser.frozen = true
    this.present(browser)
    this.syncOverlay()
    return image.toDataURL()
  }

  /**
   * The page the pane shows, as PNG bytes for attaching to a message; null when the pane does not
   * show it, since a hidden view draws no frame to capture, or when the capture fails. Through the
   * page's debugger, which reads the page's own frame.
   */
  async capture(sessionId: string): Promise<Uint8Array | null> {
    const browser = this.browsers.get(sessionId)
    const contents = browser ? this.contentsOf(this.selectedTab(browser)) : null
    if (!browser?.shown || browser.frozen || !contents) return null
    if (contents.isCrashed() || !contents.getURL() || !contents.debugger.isAttached()) return null
    let timer: NodeJS.Timeout | undefined
    try {
      const shot = (await Promise.race([
        contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), CAPTURE_MS)
        }),
      ])) as { data: string }
      return Buffer.from(shot.data, 'base64')
    } catch (error) {
      log.warn(`Could not capture a page: ${(error as Error).message}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  thaw(sessionId: string): void {
    const browser = this.browsers.get(sessionId)
    if (!browser) return
    browser.frozen = false
    this.present(browser)
    this.syncOverlay()
  }

  async clearData(): Promise<void> {
    await this.browserSession.clearStorageData()
    await this.browserSession.clearCache()
  }

  /** Closes the browser of every session that no longer exists in the renderer's list. */
  setSessions(sessionIds: readonly string[]): void {
    const live = new Set(sessionIds)
    for (const [sessionId, browser] of this.browsers) {
      if (live.has(sessionId)) continue
      for (const tab of this.tabsOf(browser)) this.dropTab(tab)
      this.origins.close(sessionId)
      this.browsers.delete(sessionId)
      this.deps.ended?.(sessionId)
      this.deps.removed?.(sessionId)
    }
    this.syncOverlay()
  }

  private browser(sessionId: string): Browser {
    let browser = this.browsers.get(sessionId)
    if (!browser) {
      browser = {
        sessionId,
        strip: new TabStrip(),
        bounds: DEFAULT_BOUNDS,
        shown: false,
        frozen: false,
        agent: null,
      }
      this.browsers.set(sessionId, browser)
    }
    return browser
  }

  private tabsOf(browser: Browser): Tab[] {
    return browser.strip.tabs.flatMap((entry) => this.tabs.get(entry.id) ?? [])
  }

  private selectedTab(browser: Browser): Tab | null {
    const id = browser.strip.selected
    return id ? (this.tabs.get(id) ?? null) : null
  }

  private selected(sessionId: string): Tab | null {
    const browser = this.browsers.get(sessionId)
    return browser ? this.selectedTab(browser) : null
  }

  private agentTabOf(sessionId: string): Tab | null {
    const id = this.agentTab(sessionId)
    return id ? (this.tabs.get(id) ?? null) : null
  }

  private contentsOf(tab: Tab | null | undefined): WebContents | null {
    const contents = tab?.view?.webContents
    return contents && !contents.isDestroyed() ? contents : null
  }

  /** Whether the pane shows the agent's tab, or nothing, so what the agent opens may take it. */
  private following(browser: Browser): boolean {
    const { selected, agent } = browser.strip
    return selected === null || agent === null || selected === agent
  }

  private addTab(
    browser: Browser,
    how: { select: boolean; agent: boolean; after?: string; opener?: string },
  ): Tab {
    const tab: Tab = {
      id: `t${nextTab++}`,
      sessionId: browser.sessionId,
      view: null,
      frame: null,
      lastUrl: null,
      lastTitle: null,
      notice: null,
      lastShown: Date.now(),
      loading: false,
      released: false,
      pending: null,
      asking: false,
      restartWait: null,
    }
    this.tabs.set(tab.id, tab)
    browser.strip.add(tab.id, how)
    return tab
  }

  /** Destroys a tab's page and forgets the tab; the strip is the caller's to update. */
  private dropTab(tab: Tab): void {
    // destroy clears the view before the web contents is gone, so its destroyed listener cannot
    // settle a navigation that is still waiting.
    this.endNavigation(tab, { ok: false, error: 'The page closed.' })
    this.destroy(tab)
    this.tabs.delete(tab.id)
  }

  /**
   * Shows the selected tab's page while the browser is shown and not frozen, and hides every
   * other; a released tab coming into view loads again.
   */
  private present(browser: Browser): void {
    const selected = browser.strip.selected
    const visible = browser.shown && !browser.frozen
    for (const tab of this.tabsOf(browser)) {
      const on = visible && tab.id === selected
      if (on) {
        tab.lastShown = Date.now()
        if (tab.released && !tab.view && tab.lastUrl) {
          this.open(tab, tab.lastUrl)
          continue
        }
        this.place(tab)
      }
      this.setVisible(tab, on)
    }
  }

  /** Loads `url` in the tab, making its page when it has none, and waits for its end. */
  private navigateAndWait(tab: Tab, url: string): Promise<NavigateResult> {
    const wait = this.waitForNavigation(tab)
    this.open(tab, url)
    return wait
  }

  /**
   * Asks for a new origin an agent's navigation wants, and settles with the refusal when the user
   * denies it or does not answer; null when it may open, so the caller goes on.
   */
  private async askFor(tab: Tab, url: string): Promise<NavigateResult | null> {
    if (!this.origins.needsAsking(tab.sessionId, url)) return null
    const origin = originOf(url)
    if (origin === null) return null
    this.originWaiters(tab.sessionId, true)
    const decision = await this.origins.ask(tab.sessionId, origin)
    this.originWaiters(tab.sessionId, false)
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

  /** Tells the call that drives the session's browser that a site wait started or ended. */
  private originWaiters(sessionId: string, waiting: boolean): void {
    this.originWaits.get(sessionId)?.waiting(waiting)
  }

  /** Whether an agent's turn has the session's browser, so its navigation is the agent's. */
  private agentDrives(sessionId: string): boolean {
    return this.deps.control?.(sessionId)?.kind === 'agent'
  }

  /** Whether one of the agent's calls acts on the session's browser right now. */
  private agentActing(sessionId: string): boolean {
    const control = this.deps.control?.(sessionId)
    return control?.kind === 'agent' && control.acting
  }

  /**
   * A link or a redirect in the tab wants to open `url` while an agent drives: a new origin is
   * asked for, and the navigation waits for the answer.
   */
  private navigationWanted(tab: Tab, url: string): void {
    if (!this.agentDrives(tab.sessionId) || !this.origins.needsAsking(tab.sessionId, url)) return
    if (tab.asking) return
    tab.asking = true
    // Chromium reports the held-up navigation as finished; it settles when the answer comes.
    tab.loading = false
    this.originWaiters(tab.sessionId, true)
    const origin = originOf(url)
    if (origin === null) return
    void this.origins.ask(tab.sessionId, origin).then((decision) => {
      tab.asking = false
      tab.restartWait?.()
      this.originWaiters(tab.sessionId, false)
      if (!this.tabs.has(tab.id)) return
      if (decision === 'session' || decision === 'project') {
        this.open(tab, url)
        return
      }
      this.endNavigation(tab, {
        ok: false,
        code: 'not_allowed',
        error:
          decision === 'deny'
            ? `The user did not allow ${origin}.`
            : `${origin} was not opened: the user did not answer in time.`,
      })
      this.emitTab(tab)
    })
  }

  /**
   * Settles with what the page ends at, or the error that stopped it, whichever comes first:
   * `did-stop-loading`, `did-fail-load`, or the time limit.
   */
  private waitForNavigation(tab: Tab): Promise<NavigateResult> {
    tab.pending?.({ ok: false, error: 'The navigation was replaced.' })
    let done = false
    let timer: ReturnType<typeof setTimeout>
    let resolve!: (result: NavigateResult) => void
    const promise = new Promise<NavigateResult>((settle) => (resolve = settle))
    const finish = (result: NavigateResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (tab.pending === finish) tab.pending = null
      if (tab.restartWait === restart) tab.restartWait = null
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
    tab.pending = finish
    tab.restartWait = restart
    return promise
  }

  private resultOf(tab: Tab, result: NavigateResult): NavigateResult {
    if (!result.ok) return result
    const contents = this.contentsOf(tab)
    return {
      ok: true,
      url: contents?.getURL() || tab.lastUrl || result.url,
      title: contents?.getTitle() || tab.lastTitle || result.title,
    }
  }

  /** The page settled after a navigation, successfully or not. */
  private endNavigation(tab: Tab, result: NavigateResult): void {
    tab.pending?.(this.resultOf(tab, result))
    tab.pending = null
  }

  private reloadTab(tab: Tab): void {
    tab.notice = null
    if (tab.view) tab.view.webContents.reload()
    else if (tab.lastUrl) this.open(tab, tab.lastUrl)
    else this.emitTab(tab)
  }

  /** Loads `url` in the tab, making its page when it has none. */
  private open(tab: Tab, url: string): void {
    const view = tab.view ?? this.create(tab)
    tab.lastUrl = url
    tab.lastTitle = null
    tab.notice = null
    tab.loading = true
    this.place(tab)
    this.setVisible(tab, this.isShown(tab))
    void view.webContents.loadURL(url).catch((error: unknown) => {
      log.warn(`Could not load ${url}: ${(error as Error).message}`)
    })
    this.emitTab(tab)
  }

  /** Whether the pane shows this tab now. */
  private isShown(tab: Tab): boolean {
    const browser = this.browsers.get(tab.sessionId)
    return !!browser && browser.shown && !browser.frozen && browser.strip.selected === tab.id
  }

  /** Makes the tab's page, adopting a popup's contents that Chromium made for `window.open`. */
  private create(tab: Tab, adopt?: WebContents): WebContentsView {
    const window = this.deps.window()
    if (!window) throw new Error('The browser has no window to sit over')
    this.releaseFor(tab)
    const view = adopt
      ? new WebContentsView({ webContents: adopt })
      : new WebContentsView({
          webPreferences: {
            partition: BROWSER_PARTITION,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        })
    tab.view = view
    tab.released = false
    if (FRAMED) {
      tab.frame = new View()
      tab.frame.addChildView(view)
    }
    window.contentView.addChildView(tab.frame ?? view)
    this.place(tab)
    this.setVisible(tab, this.isShown(tab))
    this.wire(tab, view)
    this.deps.created?.(tab.id, view.webContents)
    this.syncOverlay()
    const driving = (this.deps.control?.(tab.sessionId) ?? IDLE_CONTROL).kind !== 'idle'
    view.webContents.setBackgroundThrottling(!driving)
    return view
  }

  /**
   * Releases the least recently shown pages so that one more fits under the live limit. A page on
   * screen, or the agent's in a turn that uses it, stays.
   */
  private releaseFor(making: Tab): void {
    const candidates = [...this.tabs.values()].map((tab) => {
      const browser = this.browsers.get(tab.sessionId)
      const onScreen = !!browser?.shown && browser.strip.selected === tab.id
      const agentInTurn =
        browser?.strip.agent === tab.id &&
        (this.deps.control?.(tab.sessionId) ?? IDLE_CONTROL).kind !== 'idle'
      return {
        id: tab.id,
        live: tab.view !== null,
        lastShown: tab.lastShown,
        keep: tab === making || onScreen || agentInTurn,
      }
    })
    for (const id of tabsToRelease(candidates, MAX_LIVE_TABS)) {
      const tab = this.tabs.get(id)
      if (!tab) continue
      const url = this.urlOf(tab)
      this.endNavigation(tab, { ok: false, error: 'The page was released to save memory.' })
      this.destroy(tab)
      tab.released = url !== null
      tab.lastUrl = url
      this.emitTab(tab)
    }
  }

  /** Puts the page where the pane reported it, its corners rounded as the pane's frame is. */
  private place(tab: Tab): void {
    const { view, frame } = tab
    if (!view) return
    const bounds = this.boundsOf(tab)
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
    const at = this.overlayParent(tab)
    if (at && this.overlayTab === tab.id) this.overlay.move(at)
  }

  private boundsOf(tab: Tab): BrowserBounds {
    return this.browsers.get(tab.sessionId)?.bounds ?? DEFAULT_BOUNDS
  }

  private setVisible(tab: Tab, visible: boolean): void {
    const shown = tab.frame ?? tab.view
    shown?.setVisible(visible)
  }

  private destroy(tab: Tab): void {
    if (this.overlayTab === tab.id) {
      this.overlay.hide()
      this.overlayTab = null
    }
    const view = tab.view
    const attached = tab.frame ?? view
    tab.view = null
    tab.frame = null
    tab.loading = false
    tab.asking = false
    if (!view || !attached) return
    const window = this.deps.window()
    if (window && !window.isDestroyed()) window.contentView.removeChildView(attached)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.deps.closed?.(tab.id)
  }

  /**
   * A page's `window.open`: a tab right after its opener, with the opener kept, so a sign-in in a
   * popup reaches the page that asked for it. A popup of the agent's call becomes its tab; one to
   * a new site the agent may not open yet asks first and opens without its opener.
   */
  private windowOpen(opener: Tab, details: HandlerDetails): WindowOpenHandlerResponse {
    const { url, disposition } = details
    const browser = this.browsers.get(opener.sessionId)
    if (!browser || (url !== '' && !isAllowedNavigation(url)) || url === 'about:srcdoc') {
      return { action: 'deny' }
    }
    if (browser.strip.size >= MAX_SESSION_TABS) {
      if (url !== '') this.open(opener, url)
      return { action: 'deny' }
    }
    const byAgent = this.agentActing(opener.sessionId)
    const select = byAgent
      ? browser.strip.selected === opener.id
      : disposition !== 'background-tab' || browser.strip.selected === null
    if (byAgent && url !== '' && this.origins.needsAsking(opener.sessionId, url)) {
      const tab = this.addTab(browser, { after: opener.id, select, agent: true })
      this.create(tab)
      this.present(browser)
      this.emit(browser)
      this.navigationWanted(tab, url)
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      // The popup stays when its opener tab closes, as in a browser.
      outlivesOpener: true,
      createWindow: (options) => {
        const tab = this.addTab(browser, {
          after: opener.id,
          opener: opener.id,
          select,
          agent: byAgent,
        })
        if (url !== '' && url !== 'about:blank') tab.lastUrl = url
        tab.loading = true
        // Electron hands the popup's own contents in `options`, though its types leave them out.
        const guest = (options as { webContents?: WebContents }).webContents
        const view = this.create(tab, guest)
        this.present(browser)
        this.emit(browser)
        this.syncOverlay()
        return view.webContents
      },
    }
  }

  /**
   * A tab's page closed itself, as a popup does once its sign-in is done: the tab goes, and the
   * pane and the agent go back to its opener.
   */
  private closedItself(tab: Tab): void {
    const browser = this.browsers.get(tab.sessionId)
    if (!browser || !browser.strip.has(tab.id)) return
    this.tabs.delete(tab.id)
    browser.strip.remove(tab.id)
    if (browser.strip.size === 0) {
      this.origins.close(tab.sessionId)
      this.emit(browser)
      this.browsers.delete(tab.sessionId)
      this.deps.ended?.(tab.sessionId)
    } else {
      this.present(browser)
      this.emit(browser)
    }
    this.syncOverlay()
  }

  private wire(tab: Tab, view: WebContentsView): void {
    const contents = view.webContents
    const emit = () => this.emitTab(tab)
    contents.on('did-start-loading', () => {
      tab.loading = true
      emit()
    })
    contents.on('did-stop-loading', () => {
      tab.loading = false
      emit()
      // A navigation held for the user's answer settles when the answer comes.
      if (tab.asking) return
      this.endNavigation(tab, { ok: true, url: contents.getURL(), title: contents.getTitle() })
    })
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      tab.notice = null
      emit()
    })
    contents.on('did-navigate', (_event, url, code) => {
      if (isAllowedNavigation(url)) tab.lastUrl = url
      // A page that failed to load commits too, with no response.
      if (code > 0 && isHttp(url)) this.deps.siteOpened?.(url)
      emit()
    })
    contents.on('page-favicon-updated', (_event, favicons) => {
      const url = contents.getURL()
      if (isHttp(url)) this.deps.siteOpened?.(url, favicons)
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && isAllowedNavigation(url)) tab.lastUrl = url
      emit()
    })
    contents.on('page-title-updated', (_event, title) => {
      tab.lastTitle = title
      emit()
    })
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 is ERR_ABORTED, which a cancelled or replaced navigation reports.
      if (!isMainFrame || code === -3) return
      log.warn(`A page failed to load: ${description} (${code})`)
      tab.notice = { kind: 'load-failed', description }
      tab.loading = false
      emit()
      if (tab.asking) return
      this.endNavigation(tab, { ok: false, error: description })
    })
    // A crashed or hung page shows as it was; the pane says so, with Reload.
    const fail = (kind: 'crashed' | 'unresponsive', message: string): void => {
      tab.notice = { kind }
      tab.loading = false
      emit()
      this.endNavigation(tab, { ok: false, error: message })
      if (this.browsers.get(tab.sessionId)?.strip.agent === tab.id) {
        this.deps.failed?.(tab.sessionId, kind, message)
      }
    }
    contents.on('render-process-gone', (_event, details) => {
      // A page closed on purpose is gone before its renderer.
      if (tab.view?.webContents !== contents) return
      log.warn(`A page's renderer is gone: ${details.reason} (${details.exitCode})`)
      fail('crashed', 'The page crashed.')
    })
    contents.on('unresponsive', () => {
      log.warn('A page stopped responding')
      fail('unresponsive', 'The page stopped responding.')
    })
    contents.on('responsive', () => {
      if (tab.notice?.kind !== 'unresponsive') return
      tab.notice = null
      emit()
    })
    const guard = (event: Electron.Event, url: string): void => {
      if (!isAllowedNavigation(url)) {
        event.preventDefault()
        return
      }
      if (!this.origins.needsAsking(tab.sessionId, url) || !this.agentDrives(tab.sessionId)) return
      event.preventDefault()
      this.navigationWanted(tab, url)
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
    contents.on('will-prevent-unload', (event) => event.preventDefault())
    contents.setWindowOpenHandler((details) => this.windowOpen(tab, details))
    contents.on('before-input-event', (event, input) => {
      // A new tab is the user's own, whoever has this one.
      if (pageKey(input, process.platform) === 'new-tab') {
        event.preventDefault()
        this.newTabFromKey(tab.sessionId)
        return
      }
      // The overlay takes the keyboard while the agent has the page; a key that still reaches the
      // page, before the overlay is up, is held back as well.
      const held = this.holdsInput(tab)
      if (!held && this.shortcut(tab, input)) {
        event.preventDefault()
        return
      }
      if (this.appKey(tab.sessionId, input)) {
        event.preventDefault()
        return
      }
      if (!held) return
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat) this.held(tab, null)
    })
    contents.on('before-mouse-event', (event, mouse) => {
      if (!isHeldMouse(mouse.type) || !this.holdsInput(tab)) return
      event.preventDefault()
      if (mouse.type === 'mouseDown') this.held(tab, this.toOverlay(tab, mouse))
    })
    this.silenceDialogs(tab.id, contents)
    contents.once('destroyed', () => {
      if (tab.view?.webContents !== contents) return
      const window = this.deps.window()
      const attached = tab.frame ?? tab.view
      if (window && !window.isDestroyed()) window.contentView.removeChildView(attached)
      if (this.overlayTab === tab.id) {
        this.overlay.hide()
        this.overlayTab = null
      }
      tab.view = null
      tab.frame = null
      tab.loading = false
      tab.asking = false
      this.endNavigation(tab, { ok: false, error: 'The page closed.' })
      this.deps.closed?.(tab.id)
      // Nothing of Kettu's closed it, so the page did: `window.close()`.
      this.closedItself(tab)
    })
  }

  /** Mod+T typed in a page or its overlay: a new tab, whose address field takes the keys. */
  private newTabFromKey(sessionId: string): void {
    if (this.newTab(sessionId) === null) return
    const window = this.deps.window()
    if (window && !window.isDestroyed()) window.webContents.focus()
  }

  /** Back, forward and reload while the page has focus; the app keeps the rest. */
  private shortcut(tab: Tab, input: Input): boolean {
    const key = pageKey(input, process.platform)
    const history = tab.view?.webContents.navigationHistory
    if (key === 'back' && history?.canGoBack()) history.goBack()
    else if (key === 'forward' && history?.canGoForward()) history.goForward()
    else if (key === 'reload') this.reloadTab(tab)
    return key !== null
  }

  /**
   * Answers alert, confirm and prompt at once, so a page that opens one never holds up an agent
   * or the pane. Chromium reports them only over the DevTools protocol.
   */
  private silenceDialogs(tabId: string, contents: WebContents): void {
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
      const accepted = type === 'alert'
      void debuggerSession
        .sendCommand('Page.handleJavaScriptDialog', { accept: accepted })
        .catch(() => {})
      this.deps.dialogOpened?.(tabId, type ?? 'alert', accepted)
    })
    void debuggerSession.sendCommand('Page.enable').catch(() => {})
  }

  /**
   * The pane's address field, back, forward or reload, which act on the selected tab only while
   * the agent does not have it; then they nudge its pill instead. True when they may act.
   */
  paneControl(sessionId: string): boolean {
    const tab = this.selected(sessionId)
    if (!tab || !this.holdsInput(tab)) return true
    this.held(tab, null)
    return false
  }

  /** Take over, Hand back, Done or Skip from the pane, the label or the thread. */
  controlRequest(
    sessionId: string,
    request: Extract<ControlOverlayRequest, { type: 'take-over' | 'hand-back' | 'answer' }>,
  ): void {
    this.deps.overlayRequest?.(sessionId, request)
  }

  /** The agent acted on its tab, at a point in its CSS pixels or on it as a whole. */
  acted(sessionId: string, at: ControlPoint | null, click: boolean): void {
    const tab = this.overlayTab ? this.tabs.get(this.overlayTab) : undefined
    if (!tab || tab.sessionId !== sessionId) return
    this.overlay.send({ type: 'act', at: at && this.toOverlay(tab, at), click })
  }

  /** The app's settings or themes changed: the overlay's page follows. */
  lookChanged(): void {
    this.overlay.lookChanged()
  }

  /** Whether the user's clicks and keys on a tab are held back now: only the agent's, in turn. */
  private holdsInput(tab: Tab): boolean {
    if (this.browsers.get(tab.sessionId)?.strip.agent !== tab.id) return false
    if (this.deps.isInjecting?.(tab.id)) return false
    return this.deps.control?.(tab.sessionId).kind === 'agent'
  }

  /** A click or key of the user's was held back on the page itself: the overlay shows it. */
  private held(tab: Tab, at: ControlPoint | null): void {
    if (this.overlayTab === tab.id) this.overlay.send({ type: 'held', at })
  }

  /** An app shortcut typed in the page or its overlay goes to the window; true when it was one. */
  private appKey(sessionId: string, input: Input): boolean {
    if (pageKey(input, process.platform) === 'new-tab') {
      this.newTabFromKey(sessionId)
      return true
    }
    // The app's shortcuts still work while the page has focus, as in an artifact's frame.
    const key = forwardedKey(input, process.platform)
    if (!key) return false
    const window = this.deps.window()
    if (!window || window.isDestroyed()) return true
    // Mod+L goes to the pane's address field, which needs the keyboard back from the page.
    if (key.key.toLowerCase() === 'l' && !key.shiftKey && !key.altKey) window.webContents.focus()
    sendEvent(window.webContents, 'app:shortcut', { ...key, browserSession: sessionId })
    return true
  }

  /** A point in a page's CSS pixels, in its overlay's. */
  private toOverlay(tab: Tab, at: ControlPoint): ControlPoint {
    const scale = this.zoomOf(tab) / this.overlayZoom()
    return { x: at.x * scale, y: at.y * scale }
  }

  private zoomOf(tab: Tab): number {
    return this.contentsOf(tab)?.getZoomFactor() || 1
  }

  private overlayZoom(): number {
    return this.deps.settings?.().appearance.zoom ?? 1
  }

  /** A wheel over the overlay goes through to the page under it, where it would have gone. */
  private wheel(sessionId: string, wheel: Extract<ControlOverlayRequest, { type: 'wheel' }>): void {
    const tab = this.overlayTab ? this.tabs.get(this.overlayTab) : undefined
    const contents = this.contentsOf(tab)
    if (!tab || tab.sessionId !== sessionId || !contents || !contents.debugger.isAttached()) return
    const scale = this.overlayZoom() / this.zoomOf(tab)
    void contents.debugger
      .sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: wheel.x * scale,
        y: wheel.y * scale,
        deltaX: wheel.deltaX * scale,
        deltaY: wheel.deltaY * scale,
      })
      .catch(() => {})
  }

  /** Where the overlay goes for a tab: the page's frame on macOS, beside the page elsewhere. */
  private overlayParent(tab: Tab): OverlayParent | null {
    const window = this.deps.window()
    const contents = this.contentsOf(tab)
    if (!tab.view || !contents || !window || window.isDestroyed()) return null
    const { x, y, width, height, radius } = this.boundsOf(tab)
    const zoom = this.overlayZoom()
    if (tab.frame) {
      return {
        sessionId: tab.sessionId,
        contents,
        parent: tab.frame,
        bounds: { x: 0, y: 0, width, height },
        framed: true,
        radius: radius / zoom,
      }
    }
    return {
      sessionId: tab.sessionId,
      contents,
      parent: window.contentView,
      bounds: { x, y, width, height },
      framed: false,
      radius: radius / zoom,
    }
  }

  /**
   * Puts the overlay over the agent's tab while a turn uses it and the pane shows that tab, in
   * the layout its state needs, and takes it off once the turn ended and its leaving played. The
   * user's other tabs never get it.
   */
  private syncOverlay(): void {
    const browser = [...this.browsers.values()].find((b) => b.shown && !b.frozen)
    const agentId = browser?.strip.agent ?? null
    const shown =
      browser && agentId !== null && browser.strip.selected === agentId
        ? this.tabs.get(agentId)
        : undefined
    const at = shown ? this.overlayParent(shown) : null
    const control = shown ? (this.deps.control?.(shown.sessionId) ?? IDLE_CONTROL) : IDLE_CONTROL
    if (shown && at && control.kind !== 'idle') {
      if (this.overlayLeave) clearTimeout(this.overlayLeave)
      if (this.overlayDrop) clearTimeout(this.overlayDrop)
      this.overlayLeave = this.overlayDrop = null
      this.overlayTab = shown.id
      this.overlay.show(at, {
        control,
        agent: browser!.agent,
        scope: 'tab',
        layout: control.kind === 'agent' ? 'full' : 'pill',
        radius: at.radius,
      })
      return
    }
    if (this.overlay.sessionId === null) return
    // The tab it covered is still shown and its turn ended: the light and the pill leave first.
    if (shown && shown.id === this.overlayTab && at && !this.overlayLeave) {
      this.overlay.show(at, {
        control: IDLE_CONTROL,
        agent: browser!.agent,
        scope: 'tab',
        layout: 'full',
        radius: at.radius,
      })
      this.overlayLeave = setTimeout(() => {
        this.overlayLeave = null
        this.overlay.hide()
        this.overlayTab = null
        this.dropOverlayLater()
      }, OVERLAY_LEAVE_MS)
      return
    }
    if (shown && shown.id === this.overlayTab && this.overlayLeave) return
    if (this.overlayLeave) clearTimeout(this.overlayLeave)
    this.overlayLeave = null
    this.overlay.hide()
    this.overlayTab = null
    this.dropOverlayLater()
  }

  private dropOverlayLater(): void {
    if (this.overlayDrop) clearTimeout(this.overlayDrop)
    this.overlayDrop = setTimeout(() => {
      this.overlayDrop = null
      if (this.overlay.sessionId === null) this.overlay.destroy()
    }, OVERLAY_KEEP_MS)
  }

  private downloadBlocked(contentsId: number): void {
    for (const tab of this.tabs.values()) {
      if (tab.view?.webContents.id !== contentsId) continue
      tab.notice = { kind: 'download-blocked' }
      this.emitTab(tab)
      return
    }
  }

  private urlOf(tab: Tab): string | null {
    const contents = this.contentsOf(tab)
    const url = contents?.getURL() || tab.lastUrl
    return url && url !== 'about:blank' ? url : null
  }

  private emitTab(tab: Tab): void {
    const browser = this.browsers.get(tab.sessionId)
    if (browser?.strip.has(tab.id)) this.emit(browser)
  }

  private emit(browser: Browser): void {
    const tabs: BrowserTab[] = this.tabsOf(browser).map((tab) => ({
      id: tab.id,
      url: this.urlOf(tab),
      title: tab.lastTitle,
      loading: tab.loading,
      released: tab.released,
      opener: browser.strip.opener(tab.id),
    }))
    const selected = this.selectedTab(browser)
    const contents = this.contentsOf(selected)
    this.deps.send({
      sessionId: browser.sessionId,
      tabs,
      selected: browser.strip.selected,
      agentTab: browser.strip.agent,
      url: selected ? this.urlOf(selected) : null,
      title: selected?.lastTitle ?? null,
      loading: selected?.loading ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      notice: selected?.notice ?? null,
      control: this.deps.control?.(browser.sessionId) ?? IDLE_CONTROL,
      originRequest: this.origins.requestOf(browser.sessionId),
    })
  }

  /** Who uses a session's browser changed: its state goes out again, and the overlay follows. */
  controlChanged(sessionId: string): void {
    const browser = this.browsers.get(sessionId)
    if (browser) this.emit(browser)
    this.syncOverlay()
  }
}
