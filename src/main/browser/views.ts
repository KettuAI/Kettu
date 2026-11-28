// The tabs of each session's browser in the side panel. Main owns every page, since only it holds
// web contents; the renderer draws the pane's frame and tab strip and tells main where the page
// sits.

import { randomUUID } from 'node:crypto'
import { BrowserWindow, session as electronSession, shell, WebContentsView } from 'electron'
import type { HandlerDetails, Input, WebContents, WindowOpenHandlerResponse } from 'electron'
import {
  AGENT_VIEWPORT,
  BROWSER_PARTITION,
  canonicalBrowserUrl,
  desktopViewportFor,
  fitPageViewport,
  isAnnotatableBrowserUrl,
  MAX_SESSION_TABS,
  PAGE_SIZES,
  samePageSize,
  SIZE_LINE_ROOM,
  type BrowserBounds,
  type BrowserElementAnnotatedEvent,
  type BrowserNotice,
  type BrowserOriginAnswer,
  type BrowserOriginDecision,
  type BrowserState,
  type BrowserTab,
  type PageSize,
  type PanePageSizeMode,
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
import {
  ANNOTATE_BINDING,
  ANNOTATE_WORLD,
  buildAnnotateInstallScript,
  buildAnnotateTeardownScript,
  parseBindingMessage,
  sanitizeAnnotatedPayload,
} from './annotate'
import { originOf, BrowserOrigins, type BrowserOriginStore } from './origins'
import { PageOverlay, type OverlayParent } from './overlay'
import { BrowserPolicy, isAllowedNavigation, isHttp } from './policy'
import { MAX_LIVE_TABS, TabStrip, tabsToRelease } from './tabs'

const log = createLogger('browser')

/** The size a page renders at, off screen, until the pane reports its frame. */
export const DEFAULT_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 1280, height: 800, radius: 0 }

/** How long a navigation an agent asked for may take. */
export const NAVIGATION_TIMEOUT_MS = 30_000

/** How long a screenshot for a message may take before it gives up. */
const CAPTURE_MS = 10_000

/** How long the overlay stays after the turn ended, while its light and pill leave. */
const OVERLAY_LEAVE_MS = 480

/** How long the overlay's page is kept, off screen, after the last turn that used a page ended. */
const OVERLAY_KEEP_MS = 60_000

/** How often, and how many times, a covered page is checked for looking as its still does again. */
const COVER_RETRY_MS = 50
const COVER_TRIES = 6

/** How long a still of a page may take; a page that draws no frame gets no cover. */
const STILL_MS = 500

/** How long a page may take to confirm its size before what waits on it goes on. */
const SIZE_MS = 2_000

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
  by: 'agent' | 'user'
  usable: boolean
}

/** The viewport mode chosen for a tab: native pane fill, responsive desktop, or a fixed device size. */
type TabSizeChoice = { kind: 'fit' } | { kind: 'desktop' } | { kind: 'fixed'; size: PageSize }

interface Tab {
  id: string
  sessionId: string
  view: WebContentsView | null
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
  /** An agent used it at least once. */
  used: boolean
  /** The size mode the agent or the user picked for this tab. */
  choice: TabSizeChoice
  /**
   * The resolved desktop viewport frozen while an agent actively drives this tab, so resizing the
   * panel mid-turn scales the view without reflowing the page or shifting click coordinates.
   */
  frozenDesktop: PageSize | null
  /** What its page was last told: the size it keeps and the scale it draws at; null for none. */
  told: { size: PageSize; scale: number } | null
  /** The latest size or scale its page was told and has not confirmed yet. */
  sizing: Promise<void> | null
  /** Whether element annotation mode is active on this tab. */
  annotating: boolean
  /** Random token validating CDP binding messages from the active annotation overlay. */
  annotateToken: string | null
  /** Isolated world execution context id holding the active annotation overlay, if any. */
  annotateContextId: number | null
  /** Monotonic counter preventing stale async annotate enable calls from activating after disable. */
  annotateOp: number
}

/** A still of a page that its overlay draws over it while its screenshots are taken. */
interface Cover {
  tabId: string
  /** The still's pixels, which the page's picture matches again once it draws as before. */
  bitmap: Buffer
  /** The captures running under it. */
  uses: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** What a page's view shows now, or null when it cannot be read in time. */
function stillOf(contents: WebContents): Promise<Electron.NativeImage | null> {
  return Promise.race([contents.capturePage().catch(() => null), delay(STILL_MS).then(() => null)])
}

interface Browser {
  sessionId: string
  strip: TabStrip
  bounds: BrowserBounds
  /** Whether the pane reported a frame; until then `bounds` is a default and no page shows. */
  framed: boolean
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
  /** The agent's current tab closed while other tabs stay open: control of it ended. */
  agentTabClosed?(sessionId: string): void
  /** The user closed the browser side panel while holding takeover control. */
  panelClosed?(sessionId: string): void
  /** A page opened a site, and later named its icons, which links in replies show. */
  siteOpened?(pageUrl: string, favicons?: string[]): void
  /** The user picked an element in a tab while annotation mode was active. */
  annotated?(event: BrowserElementAnnotatedEvent): void
  /** How long a new origin waits for the user; set only by tests, which cannot wait 2 minutes. */
  originWaitMs?: number
}

/** How many device pixels a CSS pixel takes on a phone and a tablet; others take the screen's. */
const PIXEL_RATIO: Partial<Record<PageSize['name'], number>> = { phone: 3, tablet: 2 }

/** `Emulation.setDeviceMetricsOverride` for a page of `size` that draws at `scale` in its view. */
function metricsOf(size: PageSize, scale: number): Record<string, unknown> {
  return {
    width: size.width,
    height: size.height,
    deviceScaleFactor: PIXEL_RATIO[size.name] ?? 0,
    mobile: size.mobile,
    scale,
    // A phone's screen is as large as its page; a desktop page keeps the real screen's.
    ...(size.mobile ? { screenWidth: size.width, screenHeight: size.height } : {}),
    // The view keeps the box the pane has for it.
    dontSetVisibleSize: true,
  }
}

/** The device a size lays a page out as, beyond its size; null for a desktop's. */
function deviceOf(size: PageSize | undefined): PageSize['name'] | null {
  return size?.mobile ? size.name : null
}

/**
 * What a page laid out as a phone or a tablet is told beyond its size: touch, and the user agent of
 * Chromium on Android with its client hints, so that pages which ask either take their mobile
 * layout. For any other size, or none, the page's own come back.
 */
function deviceCommands(size: PageSize | null): [string, Record<string, unknown>][] {
  if (!size?.mobile) {
    return [
      ['Emulation.setTouchEmulationEnabled', { enabled: false }],
      // An empty user agent ends the override.
      ['Emulation.setUserAgentOverride', { userAgent: '' }],
    ]
  }
  const phone = size.name === 'phone'
  const version = process.versions.chrome
  const major = version.split('.')[0]
  return [
    ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }],
    [
      'Emulation.setUserAgentOverride',
      {
        userAgent:
          `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ` +
          `Chrome/${major}.0.0.0 ${phone ? 'Mobile ' : ''}Safari/537.36`,
        platform: 'Linux armv8l',
        userAgentMetadata: {
          brands: [
            { brand: 'Chromium', version: major },
            { brand: 'Not_A Brand', version: '24' },
          ],
          fullVersionList: [
            { brand: 'Chromium', version },
            { brand: 'Not_A Brand', version: '24.0.0.0' },
          ],
          platform: 'Android',
          platformVersion: '10.0.0',
          architecture: '',
          model: '',
          mobile: phone,
        },
      },
    ],
  ]
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
  private cover: Cover | null = null
  /** Last real pane bounds reported by any session, used as initial desktop layout hint before a new browser is framed. */
  private lastBounds: BrowserBounds | null = null

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
        this.disableBrowserAnnotate(other)
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
    this.disableBrowserAnnotate(browser)
    this.present(browser)
    this.syncOverlay()
  }

  /**
   * The user closed the browser side panel while holding takeover control: hide the views and
   * immediately release takeover so the agent and UI do not stay stuck waiting for hand-back.
   */
  releaseTakeover(sessionId: string): void {
    const browser = this.browsers.get(sessionId)
    if (browser) {
      browser.shown = false
      browser.frozen = false
      this.disableBrowserAnnotate(browser)
      this.present(browser)
    }
    this.deps.panelClosed?.(sessionId)
    this.syncOverlay()
  }

  /**
   * Destroys every tab of the session's browser. The session stays, so the next navigation starts
   * a new tab; hiding still only takes the pages off screen. The browser keeps whether the pane
   * shows it and its frame, which the pane reports only when it mounts and its page appears.
   */
  close(sessionId: string): void {
    const browser = this.browsers.get(sessionId)
    if (!browser) return
    this.disableBrowserAnnotate(browser, false)
    for (const tab of this.tabsOf(browser)) this.dropTab(tab)
    browser.strip.clear()
    this.origins.close(sessionId)
    this.deps.ended?.(sessionId)
    this.emit(browser)
    this.syncOverlay()
  }

  /** A blank tab the user opened, at the end of the strip and selected. */
  newTab(sessionId: string): string | null {
    const browser = this.browser(sessionId)
    if (browser.strip.size >= MAX_SESSION_TABS) return null
    this.disableBrowserAnnotate(browser)
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
    this.disableBrowserAnnotate(browser)
    this.present(browser)
    this.emit(browser)
    this.syncOverlay()
  }

  /** Closes one tab; closing the last one closes the browser. */
  closeTab(sessionId: string, tabId: string): void {
    const browser = this.browsers.get(sessionId)
    if (!browser?.strip.has(tabId)) return
    if (browser.strip.size === 1) return this.close(sessionId)
    const wasAgent = browser.strip.agent === tabId
    const tab = this.tabs.get(tabId)
    if (tab) {
      void this.disableAnnotate(tab, false)
      this.dropTab(tab)
    }
    browser.strip.remove(tabId)
    this.disableBrowserAnnotate(browser)
    if (wasAgent && browser.strip.agent === null) {
      this.deps.agentTabClosed?.(sessionId)
    }
    this.present(browser)
    this.emit(browser)
    this.syncOverlay()
  }

  setBounds(sessionId: string, bounds: BrowserBounds): void {
    const browser = this.browser(sessionId)
    const first = !browser.framed
    const selectedBefore = this.selectedTab(browser)
    const viewportBefore = selectedBefore ? this.viewportOf(selectedBefore) : null
    browser.bounds = bounds
    browser.framed = true
    this.lastBounds = bounds
    for (const tab of this.tabsOf(browser)) {
      // Lock the first real pane frame for an agent turn that started before the pane mounted.
      if (first) this.freezeDesktopIfNeeded(tab)
      this.place(tab)
    }
    if (first) {
      this.present(browser)
      this.syncOverlay()
    }
    const selectedAfter = this.selectedTab(browser)
    const viewportAfter = selectedAfter ? this.viewportOf(selectedAfter) : null
    if (first || !samePageSize(viewportBefore, viewportAfter)) {
      this.emit(browser)
    }
  }

  /** The user's own navigation, in the selected tab, or a new one when the browser has none. */
  navigate(sessionId: string, url: string): void {
    if (!isHttp(url)) throw new Error('A browser page opens an http or https address only')
    const browser = this.browser(sessionId)
    const tab = this.selectedTab(browser) ?? this.addTab(browser, { select: true, agent: false })
    this.open(tab, url)
  }

  /**
   * Opens a link from the session UI in the session's browser: selects an already-open tab on the
   * same URL without reloading it, else reuses a blank selected user tab, else opens a new tab
   * (falling back to navigating an existing tab when the session is at `MAX_SESSION_TABS`).
   */
  openLink(sessionId: string, url: string): void {
    if (!isHttp(url)) throw new Error('A browser page opens an http or https address only')
    const browser = this.browser(sessionId)
    const target = canonicalBrowserUrl(url)
    const selected = this.selectedTab(browser)
    const match =
      target !== null
        ? selected && canonicalBrowserUrl(this.urlOf(selected)) === target
          ? selected
          : (this.tabsOf(browser).find((tab) => canonicalBrowserUrl(this.urlOf(tab)) === target) ??
            null)
        : null
    if (match) {
      if (browser.strip.select(match.id)) {
        this.disableBrowserAnnotate(browser)
        this.present(browser)
        this.emit(browser)
        this.syncOverlay()
      }
      return
    }
    if (this.isReusableBlankTab(browser, selected)) {
      this.open(selected, url)
      return
    }
    if (browser.strip.size >= MAX_SESSION_TABS) {
      const fallback =
        selected && !this.holdsInput(selected)
          ? selected
          : (this.tabsOf(browser).findLast((tab) => !this.holdsInput(tab)) ?? selected)
      if (!fallback) return
      if (browser.strip.select(fallback.id)) {
        this.disableBrowserAnnotate(browser)
        this.present(browser)
      }
      this.open(fallback, url)
      this.syncOverlay()
      return
    }
    this.disableBrowserAnnotate(browser)
    const tab = this.addTab(browser, { select: true, agent: false })
    this.present(browser)
    this.open(tab, url)
    this.syncOverlay()
  }

  /** The tab the agent's calls act on, which it keeps from then on; null when there is none. */
  agentTab(sessionId: string): string | null {
    return this.browsers.get(sessionId)?.strip.agentTarget() ?? null
  }

  /** A tab's web contents, or null when it has none now. */
  tabContents(tabId: string): WebContents | null {
    return this.contentsOf(this.tabs.get(tabId))
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
   * Opens `url` in the agent's tab, making one of its own when it has none rather than taking the
   * user's, and settles when the navigation has ended: the page's address and title, or
   * Chromium's error. An origin the page may not open yet is asked for first, and the call fails
   * `not_allowed` without an answer.
   */
  async load(sessionId: string, url: string): Promise<NavigateResult> {
    const browser = this.browser(sessionId)
    const id = browser.strip.agent
    const tab =
      (id ? this.tabs.get(id) : undefined) ?? this.addTab(browser, { select: true, agent: true })
    await this.fix(tab)
    const asked = await this.askFor(tab, url)
    if (asked) return asked
    return this.navigateAndWait(tab, url)
  }

  /**
   * The tab of the user's a call would act on, which the agent may use only once they allow it;
   * null when it acts on its own tab, one they allowed, or none yet.
   */
  userTabFor(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
  ): { id: string; title: string } | null {
    const browser = this.browsers.get(sessionId)
    if (!browser) return null
    const { strip } = browser
    let id: string | null
    if (tool === 'browser_tabs') {
      if (args.action !== 'select' && args.action !== 'close') return null
      const at = typeof args.index === 'number' ? strip.at(args.index) : null
      id = at?.id ?? (args.action === 'close' && args.index === undefined ? strip.agent : null)
    } else if (tool === 'browser_navigate') {
      // With no tab of its own, the agent opens one.
      id = strip.agent
    } else {
      id = strip.agent ?? strip.selected
    }
    if (id === null || strip.usable(id)) return null
    const tab = this.tabs.get(id)
    return { id, title: tab?.lastTitle || (tab ? this.urlOf(tab) : null) || id }
  }

  /** Allows the agent a tab the user opened in the session's browser, or takes the allow back. */
  allowTab(sessionId: string, tabId: string, allowed: boolean): void {
    const browser = this.browsers.get(sessionId)
    if (browser?.strip.allow(tabId, allowed)) this.emit(browser)
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

  /**
   * Readies the agent's tab for a call that reads or acts on it: from its first use its page keeps
   * the agent's size, and a released one loads its page again.
   */
  async readyAgentTab(sessionId: string): Promise<void> {
    const tab = this.agentTabOf(sessionId)
    if (!tab) return
    await this.fix(tab)
    if (tab.released && !tab.view && tab.lastUrl) await this.navigateAndWait(tab, tab.lastUrl)
    await this.pointScale(tab.id)
  }

  /**
   * The scale a tab's page draws at in its view, once the page has its latest size. The debugger
   * takes a mouse event's point in the view's pixels, so an agent's point on a page of a fixed
   * size is scaled by it.
   */
  async pointScale(tabId: string): Promise<number> {
    const tab = this.tabs.get(tabId)
    if (!tab) return 1
    while (tab.sizing) await tab.sizing
    return this.drawnScale(tab)
  }

  /**
   * Runs a screenshot of a tab's page. Chromium draws a page of a fixed size unscaled for a moment
   * to capture it, so while the page's overlay covers it, the overlay draws a still of it
   * meanwhile. Only another page's view draws over a page's view, and the overlay is one.
   */
  async steady<T>(tabId: string, capture: () => Promise<T>): Promise<T> {
    const tab = this.tabs.get(tabId)
    if (!tab || !tab.told) return capture()
    await this.coverPage(tab)
    try {
      return await capture()
    } finally {
      // The capture ends by putting back the scale it began with, which a resize may have changed.
      this.size(tab, true)
      void this.uncover(tab)
    }
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
        by: browser.strip.byOf(tab.id) ?? 'user',
        usable: browser.strip.usable(tab.id),
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
    if (follow) {
      this.disableBrowserAnnotate(browser)
      browser.strip.select(tabId)
    }
    this.syncDesktopFreeze(browser)
    this.present(browser)
    this.emit(browser)
    this.syncOverlay()
    await this.fix(tab)
    if (tab.released && !tab.view && tab.lastUrl) await this.navigateAndWait(tab, tab.lastUrl)
  }

  /**
   * The user picked a page size mode for the selected tab: native pane fill (`fit`), responsive
   * desktop (`desktop`), or a fixed device preset (`tablet`, `phone`).
   */
  async setPageSize(sessionId: string, mode: PanePageSizeMode): Promise<void> {
    const tab = this.selected(sessionId)
    if (!tab) return
    await this.resize(tab, () => {
      tab.frozenDesktop = null
      tab.choice =
        mode === 'fit'
          ? { kind: 'fit' }
          : mode === 'desktop'
            ? { kind: 'desktop' }
            : { kind: 'fixed', size: PAGE_SIZES[mode] }
    })
  }

  /**
   * Enables or exits element annotation mode on the selected tab. Refuses to enable when no
   * annotatable http(s) page is loaded, the page errored/crashed, or an agent actively owns input.
   */
  async setAnnotate(sessionId: string, enabled: boolean): Promise<boolean> {
    const browser = this.browsers.get(sessionId)
    const tab = browser ? this.selectedTab(browser) : null
    if (!browser || !tab) return false
    if (!enabled) {
      await this.disableAnnotate(tab)
      return false
    }
    if (!this.canAnnotate(tab)) {
      if (tab.annotating) await this.disableAnnotate(tab)
      return false
    }
    if (tab.annotating) return true
    for (const other of this.tabsOf(browser)) {
      if (other !== tab && (other.annotating || other.annotateToken !== null)) {
        await this.disableAnnotate(other)
      }
    }
    const contents = this.contentsOf(tab)
    if (!contents || !contents.debugger.isAttached()) return false
    const op = ++tab.annotateOp
    const token = randomUUID()
    tab.annotateToken = token
    let contextId: number | null = null
    try {
      await contents.debugger.sendCommand('Runtime.enable')
      const frameTree = (await contents.debugger.sendCommand('Page.getFrameTree')) as {
        frameTree?: { frame?: { id?: string } }
      }
      const frameId = frameTree?.frameTree?.frame?.id
      if (typeof frameId === 'string' && frameId.length > 0) {
        const world = (await contents.debugger.sendCommand('Page.createIsolatedWorld', {
          frameId,
          worldName: ANNOTATE_WORLD,
        })) as { executionContextId?: number }
        if (typeof world?.executionContextId === 'number') {
          contextId = world.executionContextId
        }
      }
      await contents.debugger.sendCommand(
        'Runtime.addBinding',
        contextId !== null
          ? { name: ANNOTATE_BINDING, executionContextName: ANNOTATE_WORLD }
          : { name: ANNOTATE_BINDING },
      )
      await contents.debugger.sendCommand('Runtime.evaluate', {
        expression: buildAnnotateInstallScript(token),
        ...(contextId !== null ? { contextId } : {}),
        returnByValue: true,
      })
      if (tab.annotateOp !== op || this.contentsOf(tab) !== contents || !this.canAnnotate(tab)) {
        void contents.debugger
          .sendCommand('Runtime.evaluate', {
            expression: buildAnnotateTeardownScript(),
            ...(contextId !== null ? { contextId } : {}),
            returnByValue: true,
          })
          .catch(() => {})
        if (tab.annotateOp === op) {
          tab.annotating = false
          tab.annotateToken = null
          tab.annotateContextId = null
          this.emitTab(tab)
        }
        return false
      }
      tab.annotating = true
      tab.annotateContextId = contextId
      this.emitTab(tab)
      return true
    } catch (error) {
      log.warn(`Could not start page annotation: ${(error as Error).message}`)
      if (tab.annotateOp === op) {
        tab.annotating = false
        tab.annotateToken = null
        tab.annotateContextId = null
        this.emitTab(tab)
      }
      return false
    }
  }

  /** An agent's `browser_resize` on its tab, whose page keeps the size from then on. */
  async resizeAgentTab(tabId: string, size: PageSize): Promise<PageSize> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('The tab closed.')
    await this.resize(tab, () => {
      tab.used = true
      tab.frozenDesktop = null
      if (size.name === 'desktop') {
        tab.choice = { kind: 'desktop' }
        this.freezeDesktopIfNeeded(tab)
      } else {
        tab.choice = { kind: 'fixed', size }
      }
    })
    return this.viewportOf(tab) ?? AGENT_VIEWPORT
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
    const tab = browser ? this.selectedTab(browser) : null
    const contents = this.contentsOf(tab)
    if (!browser?.shown || browser.frozen || !tab || !contents) return null
    if (contents.isCrashed() || !contents.getURL() || !contents.debugger.isAttached()) return null
    let timer: NodeJS.Timeout | undefined
    try {
      const shot = (await Promise.race([
        this.steady(tab.id, () =>
          contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }),
        ),
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

  /** Closes every open browser across all sessions (for example once the last app window closes). */
  closeAll(): void {
    for (const [sessionId, browser] of [...this.browsers]) {
      this.disableBrowserAnnotate(browser, false)
      for (const tab of this.tabsOf(browser)) this.dropTab(tab)
      browser.strip.clear()
      this.origins.close(sessionId)
      this.browsers.delete(sessionId)
      this.deps.ended?.(sessionId)
      this.deps.removed?.(sessionId)
    }
    this.syncOverlay()
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
        framed: false,
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
      lastUrl: null,
      lastTitle: null,
      notice: null,
      lastShown: Date.now(),
      loading: false,
      released: false,
      pending: null,
      asking: false,
      restartWait: null,
      used: how.agent,
      choice: how.agent ? { kind: 'desktop' } : { kind: 'fit' },
      frozenDesktop: null,
      told: null,
      sizing: null,
      annotating: false,
      annotateToken: null,
      annotateContextId: null,
      annotateOp: 0,
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
    const visible = browser.shown && !browser.frozen && browser.framed
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
    void this.disableAnnotate(tab)
    tab.notice = null
    if (tab.view) tab.view.webContents.reload()
    else if (tab.lastUrl) this.open(tab, tab.lastUrl)
    else this.emitTab(tab)
  }

  /** Loads `url` in the tab, making its page when it has none. */
  private open(tab: Tab, url: string): void {
    void this.disableAnnotate(tab)
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
    return (
      !!browser &&
      browser.shown &&
      !browser.frozen &&
      browser.framed &&
      browser.strip.selected === tab.id
    )
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
    window.contentView.addChildView(view)
    this.place(tab)
    this.setVisible(tab, this.isShown(tab))
    this.wire(tab, view)
    // A popup's page has its frame already; a new page takes its size once its renderer made it.
    tab.told = null
    this.size(tab)
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

  /**
   * Puts the page where the pane reported it, its corners rounded as the pane's frame is. Only the
   * page's own radius clips it: a view around it leaves its corners square on macOS.
   */
  private place(tab: Tab): void {
    const { view } = tab
    if (!view) return
    const { x, y, width, height, radius } = this.boundsOf(tab)
    view.setBounds({ x, y, width, height })
    view.setBorderRadius(radius)
    this.size(tab)
    const at = this.overlayParent(tab)
    if (at && this.overlayTab === tab.id) this.overlay.move(at)
  }

  /** The pane frame used to lay out `tab`: its browser's real frame once reported, else the last known frame. */
  private frameFor(tab: Tab): BrowserBounds {
    const browser = this.browsers.get(tab.sessionId)
    if (browser?.framed) return browser.bounds
    return this.lastBounds ?? DEFAULT_BOUNDS
  }

  /** Whether `tab`'s desktop viewport should stay frozen against panel resizes right now. */
  private shouldFreezeDesktop(tab: Tab): boolean {
    if (tab.choice.kind !== 'desktop') return false
    if (!this.agentDrives(tab.sessionId)) return false
    return this.browsers.get(tab.sessionId)?.strip.agent === tab.id
  }

  /** Freezes `tab`'s resolved desktop dimensions once its browser has a real frame. */
  private freezeDesktopIfNeeded(tab: Tab): boolean {
    if (!this.shouldFreezeDesktop(tab) || tab.frozenDesktop !== null) return false
    const browser = this.browsers.get(tab.sessionId)
    if (!browser?.framed) return false
    tab.frozenDesktop = desktopViewportFor(browser.bounds)
    return true
  }

  /** Updates desktop viewport freeze/unfreeze for every tab in `browser` when agent control changes. */
  private syncDesktopFreeze(browser: Browser): void {
    for (const tab of this.tabsOf(browser)) {
      if (this.shouldFreezeDesktop(tab)) {
        if (this.freezeDesktopIfNeeded(tab)) this.size(tab)
      } else if (tab.frozenDesktop !== null) {
        tab.frozenDesktop = null
        this.place(tab)
      }
    }
  }

  /** The logical viewport the tab's page uses; null when it fills the pane natively (`fit`). */
  private viewportOf(tab: Tab): PageSize | null {
    switch (tab.choice.kind) {
      case 'fit':
        return null
      case 'fixed':
        return tab.choice.size
      case 'desktop':
        return tab.frozenDesktop ?? desktopViewportFor(this.frameFor(tab))
    }
  }

  /** Fits `tab`'s viewport in its pane frame; desktop fills the full frame with no bottom caption strip. */
  private fitOf(tab: Tab): { bounds: BrowserBounds; scale: number; showSizeLine: boolean } {
    const frame = this.frameFor(tab)
    const viewport = this.viewportOf(tab)
    // Fixed device presets keep room below for their size caption, in the renderer's zoomed pixels.
    return fitPageViewport(frame, viewport, Math.round(SIZE_LINE_ROOM * this.overlayZoom()))
  }

  /** Whether `tab` needs CDP device metrics emulation for its current viewport and scale. */
  private needsEmulation(tab: Tab, viewport: PageSize | null, scale: number): boolean {
    if (!viewport) return false
    // A desktop page in a wide pane fills natively at 1:1; only emulate when frozen mid-turn so
    // shrinking the panel during an agent turn never reflows the page.
    if (viewport.name === 'desktop' && scale === 1 && tab.frozenDesktop === null) return false
    return true
  }

  private boundsOf(tab: Tab): BrowserBounds {
    return this.fitOf(tab).bounds
  }

  /** The scale the tab's page was last told to draw at. */
  private drawnScale(tab: Tab): number {
    return tab.told ? tab.told.scale : 1
  }

  /**
   * Readies a tab for agent use: on its first use a native-fill tab switches to responsive desktop
   * width, and while an agent actively drives it its desktop dimensions stay frozen.
   */
  private async fix(tab: Tab): Promise<void> {
    await this.resize(tab, () => {
      const wasUsed = tab.used
      tab.used = true
      if (!wasUsed && tab.choice.kind === 'fit') tab.choice = { kind: 'desktop' }
      this.freezeDesktopIfNeeded(tab)
    })
  }

  /**
   * Changes the size a tab's page keeps. A page entering emulation takes its metrics before its
   * view shrinks to fit, so it never lays out at the smaller box; one returning to native fill
   * grows with the frame first and clears emulation cleanly.
   */
  private async resize(tab: Tab, change: () => void): Promise<void> {
    const before = this.viewportOf(tab)
    const emulateBefore = this.needsEmulation(tab, before, this.fitOf(tab).scale)
    change()
    const after = this.viewportOf(tab)
    const emulateAfter = this.needsEmulation(tab, after, this.fitOf(tab).scale)
    if (samePageSize(before, after) && emulateBefore === emulateAfter) return
    if (after && emulateAfter) {
      this.size(tab, true)
      await tab.sizing
    }
    this.place(tab)
    if (!emulateAfter && tab.sizing) await tab.sizing
    this.emitTab(tab)
  }

  /**
   * Tells a page how large to lay out and how small to draw in its view, when either changed or
   * `again` asks, and clears emulation when a page fills the frame natively. It goes through the
   * page's debugger, whose overrides every later navigation of the page keeps. `afresh` clears
   * them first, since Chromium does not re-send a size it already holds.
   */
  private size(tab: Tab, again: boolean | 'afresh' = false): void {
    const contents = this.contentsOf(tab)
    if (!contents?.debugger.isAttached()) return
    const viewport = this.viewportOf(tab)
    const { scale } = this.fitOf(tab)
    const emulate = this.needsEmulation(tab, viewport, scale)
    const told = tab.told
    const commands: [string, Record<string, unknown>][] = []
    if (!emulate || !viewport) {
      if (!told) return
      tab.told = null
      commands.push(['Emulation.clearDeviceMetricsOverride', {}])
      if (told.size.mobile) commands.push(...deviceCommands(null))
    } else {
      if (!again && told?.scale === scale && samePageSize(told.size, viewport)) return
      tab.told = { size: viewport, scale }
      if (again === 'afresh') commands.push(['Emulation.clearDeviceMetricsOverride', {}])
      commands.push(['Emulation.setDeviceMetricsOverride', metricsOf(viewport, scale)])
      if (deviceOf(told?.size) !== deviceOf(viewport)) commands.push(...deviceCommands(viewport))
    }
    const command = Promise.all(
      commands.map(([method, params]) => contents.debugger.sendCommand(method, params)),
    ).catch((error: unknown) => {
      log.warn(`Could not size a page: ${(error as Error).message}`)
    })
    // A page that went away meanwhile may never answer, and an agent's call waits on this.
    const sent: Promise<void> = Promise.race([command, delay(SIZE_MS)]).then(() => {
      if (tab.sizing === sent) tab.sizing = null
    })
    tab.sizing = sent
  }

  /** Has the tab's overlay draw a still of its page over it, while the overlay covers the page. */
  private async coverPage(tab: Tab): Promise<void> {
    const reuse = (): boolean => {
      if (!this.cover) return false
      if (this.cover.tabId === tab.id) this.cover.uses += 1
      return true
    }
    const contents = this.contentsOf(tab)
    if (reuse() || !contents || !this.overlay.covers(contents)) return
    const image = await stillOf(contents)
    // The page may have gone, or the overlay left it, while it was captured.
    if (!image || image.isEmpty() || reuse()) return
    if (this.contentsOf(tab) !== contents || !this.overlay.covers(contents)) return
    this.cover = { tabId: tab.id, bitmap: image.toBitmap(), uses: 1 }
    await this.overlay.showStill(image.toDataURL())
  }

  /**
   * Takes the still off once no capture runs under it and the page looks as the still does again;
   * a page that moves never does, so it is given up after a few looks, by when it has drawn anew.
   */
  private async uncover(tab: Tab): Promise<void> {
    const cover = this.cover
    if (cover?.tabId !== tab.id) return
    cover.uses -= 1
    const left = (): boolean => this.cover !== cover || cover.uses > 0
    for (let tries = 0; tries < COVER_TRIES && !left(); tries++) {
      await delay(COVER_RETRY_MS)
      const contents = this.contentsOf(tab)
      if (left() || !contents) break
      const image = await stillOf(contents)
      if (left()) return
      if (image?.toBitmap().equals(cover.bitmap)) break
    }
    if (!left()) this.dropCover(tab.id)
  }

  private dropCover(tabId: string): void {
    if (this.cover?.tabId !== tabId) return
    this.cover = null
    this.overlay.dropStill()
  }

  private setVisible(tab: Tab, visible: boolean): void {
    if (!visible) this.dropCover(tab.id)
    tab.view?.setVisible(visible)
  }

  private destroy(tab: Tab): void {
    if (this.overlayTab === tab.id) {
      this.overlay.hide()
      this.overlayTab = null
    }
    this.dropCover(tab.id)
    const view = tab.view
    tab.view = null
    tab.loading = false
    tab.asking = false
    tab.told = null
    tab.annotating = false
    tab.annotateToken = null
    tab.annotateContextId = null
    tab.annotateOp += 1
    if (!view) return
    const window = this.deps.window()
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view)
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
    const wasAgent = browser.strip.agent === tab.id
    this.tabs.delete(tab.id)
    browser.strip.remove(tab.id)
    if (browser.strip.size === 0) {
      this.origins.close(tab.sessionId)
      this.deps.ended?.(tab.sessionId)
      this.emit(browser)
    } else {
      if (wasAgent && browser.strip.agent === null) {
        this.deps.agentTabClosed?.(tab.sessionId)
      }
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
    // Chromium sends the size only to a frame its renderer has made, and sends it again only when a
    // navigation moves to another frame, so a new page's first frame is told here, before its
    // document lays out.
    contents.on('frame-created', (_event, { frame }) => {
      if (tab.view?.webContents === contents && frame === contents.mainFrame) {
        this.size(tab, 'afresh')
      }
    })
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      void this.disableAnnotate(tab, details.isSameDocument)
      tab.notice = null
      emit()
    })
    contents.on('did-navigate', (_event, url, code) => {
      void this.disableAnnotate(tab, false)
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
      if (isMainFrame) void this.disableAnnotate(tab, true)
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
      void this.disableAnnotate(tab, false)
      log.warn(`A page failed to load: ${description} (${code})`)
      tab.notice = { kind: 'load-failed', description }
      tab.loading = false
      emit()
      if (tab.asking) return
      this.endNavigation(tab, { ok: false, error: description })
    })
    // A crashed or hung page shows as it was; the pane says so, with Reload.
    const fail = (kind: 'crashed' | 'unresponsive', message: string): void => {
      void this.disableAnnotate(tab, false)
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
      if (
        !held &&
        tab.annotating &&
        input.type === 'keyDown' &&
        !input.isAutoRepeat &&
        input.key === 'Escape'
      ) {
        event.preventDefault()
        void this.disableAnnotate(tab)
        return
      }
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
      if (input.type === 'keyDown' && !input.isAutoRepeat) {
        if (input.key === 'Escape') this.dismissBubble(tab)
        else this.held(tab, null)
      }
    })
    contents.on('before-mouse-event', (event, mouse) => {
      if (!isHeldMouse(mouse.type) || !this.holdsInput(tab)) return
      event.preventDefault()
      if (mouse.type === 'mouseDown') this.held(tab, this.toOverlay(tab, mouse, 1))
    })
    this.silenceDialogs(tab.id, contents)
    contents.once('destroyed', () => {
      // The view drops its contents once they are destroyed, so it is compared itself.
      if (tab.view !== view) return
      const window = this.deps.window()
      if (window && !window.isDestroyed()) window.contentView.removeChildView(view)
      if (this.overlayTab === tab.id) {
        this.overlay.hide()
        this.overlayTab = null
      }
      this.dropCover(tab.id)
      tab.view = null
      tab.loading = false
      tab.asking = false
      tab.told = null
      tab.annotating = false
      tab.annotateToken = null
      tab.annotateContextId = null
      tab.annotateOp += 1
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
      if (method === 'Runtime.bindingCalled') {
        const record = params as { name?: unknown; payload?: unknown }
        if (record.name === ANNOTATE_BINDING) {
          this.handleAnnotateBinding(tabId, record.payload)
        }
        return
      }
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

  /** Whether `tab` can enter element annotation mode right now. */
  private canAnnotate(tab: Tab): boolean {
    const contents = this.contentsOf(tab)
    if (!contents || contents.isCrashed() || !contents.debugger.isAttached()) return false
    if (
      tab.notice?.kind === 'load-failed' ||
      tab.notice?.kind === 'crashed' ||
      tab.notice?.kind === 'unresponsive'
    ) {
      return false
    }
    if (!isAnnotatableBrowserUrl(this.urlOf(tab))) return false
    return !this.holdsInput(tab)
  }

  /** Exits annotation mode on `tab`, tearing down injected overlay DOM and listeners when live. */
  private async disableAnnotate(tab: Tab, teardown = true): Promise<void> {
    tab.annotateOp += 1
    const wasActive = tab.annotating || tab.annotateToken !== null
    const contextId = tab.annotateContextId
    tab.annotating = false
    tab.annotateToken = null
    tab.annotateContextId = null
    if (!wasActive) return
    // Emit immediately so renderer toolbar state updates synchronously while CDP teardown runs.
    this.emitTab(tab)
    if (teardown) {
      const contents = this.contentsOf(tab)
      if (contents?.debugger.isAttached()) {
        await contents.debugger
          .sendCommand('Runtime.evaluate', {
            expression: buildAnnotateTeardownScript(),
            ...(contextId !== null ? { contextId } : {}),
            returnByValue: true,
          })
          .catch(() => {})
      }
    }
  }

  /** Exits annotation mode on every tab of `browser`. */
  private disableBrowserAnnotate(browser: Browser, teardown = true): void {
    for (const tab of this.tabsOf(browser)) {
      if (tab.annotating || tab.annotateToken !== null) {
        void this.disableAnnotate(tab, teardown)
      }
    }
  }

  /** Processes a validated pick or exit message sent from the tab's isolated annotation world. */
  private handleAnnotateBinding(tabId: string, payload: unknown): void {
    const tab = this.tabs.get(tabId)
    if (!tab || !tab.annotating) return
    const message = parseBindingMessage(payload, tab.annotateToken)
    if (!message) return
    if (message.type === 'exit') {
      void this.disableAnnotate(tab)
      return
    }
    const annotation = sanitizeAnnotatedPayload(
      message.element,
      this.urlOf(tab),
      tab.lastTitle,
      tab.id,
    )
    if (!annotation) return
    // Return keyboard focus to the host window so the session composer can immediately accept notes.
    const window = this.deps.window()
    if (window && !window.isDestroyed()) window.webContents.focus()
    this.deps.annotated?.({ sessionId: tab.sessionId, tabId: tab.id, annotation })
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
    this.overlay.send({
      type: 'act',
      at: at && this.toOverlay(tab, at, this.drawnScale(tab)),
      click,
    })
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

  /** Escape on the page itself dismisses any open held-input bubble on its overlay. */
  private dismissBubble(tab: Tab): void {
    if (this.overlayTab === tab.id) this.overlay.dismissBubble()
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

  /**
   * A point in a page's CSS pixels, in its overlay's. `drawn` is the scale the page draws at for a
   * point on the page itself, and 1 for one an input event gives, which is in the view already.
   */
  private toOverlay(tab: Tab, at: ControlPoint, drawn: number): ControlPoint {
    const scale = (this.zoomOf(tab) * drawn) / this.overlayZoom()
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

  /** Where the overlay goes for a tab: beside the page, over the same box. */
  private overlayParent(tab: Tab): OverlayParent | null {
    const window = this.deps.window()
    const contents = this.contentsOf(tab)
    if (!tab.view || !contents || !window || window.isDestroyed()) return null
    if (!this.browsers.get(tab.sessionId)?.framed) return null
    const { x, y, width, height, radius } = this.boundsOf(tab)
    return {
      sessionId: tab.sessionId,
      contents,
      parent: window.contentView,
      bounds: { x, y, width, height },
      radius: radius / this.overlayZoom(),
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

  private isReusableBlankTab(browser: Browser, tab: Tab | null): tab is Tab {
    if (!tab) return false
    if (browser.strip.agent === tab.id || browser.strip.byOf(tab.id) === 'agent') return false
    return this.urlOf(tab) === null && !tab.loading && !tab.asking && !tab.released
  }

  private urlOf(tab: Tab): string | null {
    const contents = this.contentsOf(tab)
    const current = contents?.getURL()
    const url = current && current !== 'about:blank' ? current : tab.lastUrl
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
      by: browser.strip.byOf(tab.id) ?? 'user',
      allowed: browser.strip.isAllowed(tab.id),
    }))
    const selected = this.selectedTab(browser)
    const contents = this.contentsOf(selected)
    this.deps.send({
      sessionId: browser.sessionId,
      tabs,
      selected: browser.strip.selected,
      agentTab: browser.strip.agent,
      url: selected ? this.urlOf(selected) : null,
      page: contents !== null,
      viewport: selected ? this.viewportOf(selected) : null,
      agentUsed: selected?.used ?? false,
      title: selected?.lastTitle ?? null,
      loading: selected?.loading ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      notice: selected?.notice ?? null,
      control: this.deps.control?.(browser.sessionId) ?? IDLE_CONTROL,
      originRequest: this.origins.requestOf(browser.sessionId),
      annotating: selected?.annotating ?? false,
    })
  }

  /** Who uses a session's browser changed: sync desktop freeze state, emit, and update overlay. */
  controlChanged(sessionId: string): void {
    const browser = this.browsers.get(sessionId)
    if (browser) {
      for (const tab of this.tabsOf(browser)) {
        if ((tab.annotating || tab.annotateToken !== null) && this.holdsInput(tab)) {
          void this.disableAnnotate(tab)
        }
      }
      this.syncDesktopFreeze(browser)
      this.emit(browser)
    }
    this.syncOverlay()
  }
}
