// Opening a link where its plan sends it, shared across replies, chips, sidebars, git UI, and terminals.

import { createContext, useContext, type MouseEvent } from 'react'
import { create } from 'zustand'
import type { LinkDestination } from '@shared/settings'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { isMod, isWeb } from '@renderer/lib/platform'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { iconFor, loadSiteIcons, useSiteIconsStore } from '@renderer/stores/site-icons'
import { openSession, toggleSidePane, useViewStore } from '@renderer/stores/view'
import {
  linkSite,
  planLinkOpen,
  planLinkOpenIn,
  rememberSite,
  type LinkContext,
  type LinkPlan,
} from './link-open'
import { SessionIdContext } from './media/grants'

/**
 * The session whose browser a link in this subtree may open in. Kept separate from
 * `SessionIdContext` so routing web links does not widen media-grant scope.
 */
export const LinkSessionContext = createContext<string | null>(null)

/**
 * Resolves the owning session for link routing: an explicit id (including explicit `null`) wins,
 * then `LinkSessionContext`, then `SessionIdContext`.
 */
export function useLinkSessionId(explicit?: string | null): string | null {
  const fromLink = useContext(LinkSessionContext)
  const fromMedia = useContext(SessionIdContext)
  return explicit !== undefined ? explicit : (fromLink ?? fromMedia)
}

/** Pending confirmation shown by the global `LinkConfirmHost`. */
export interface LinkConfirmRequest {
  key: number
  url: string
  destination: LinkDestination
  /** The session whose browser can open the link; null outside a session or on web. */
  sessionId: string | null
  open: boolean
}

export const useLinkConfirmStore = create<{ request: LinkConfirmRequest | null }>(() => ({
  request: null,
}))

/** Closes the global "Open link?" dialog while keeping it mounted for its exit transition. */
export function closeLinkConfirm(): void {
  useLinkConfirmStore.setState((s) => (s.request ? { request: { ...s.request, open: false } } : s))
}

/** Confirms the active global "Open link?" request and opens it at the chosen destination. */
export function confirmLinkOpen(destination: LinkDestination, remember: boolean): void {
  const request = useLinkConfirmStore.getState().request
  if (!request) return
  if (remember) rememberDestination(request.url, destination)
  openLinkIn(request.url, destination, request.sessionId)
}

function askLinkConfirm(url: string, destination: LinkDestination, sessionId: string | null): void {
  loadSiteIcons()
  useLinkConfirmStore.setState((s) => ({
    request: {
      key: (s.request?.key ?? 0) + 1,
      url,
      destination,
      sessionId,
      open: true,
    },
  }))
}

function isHttpUrl(url: string): boolean {
  const parsed = URL.parse(url)
  return !!parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
}

function hasSessionTarget(sessionId: string | null): boolean {
  if (isWeb || !sessionId) return false
  if (useSessionsStore.getState().byId[sessionId]) return true
  const { main } = useViewStore.getState()
  return main.kind === 'session' && main.sessionId === sessionId
}

/**
 * Opens a link in the default browser, or in the session's browser in Kettu (selecting a matching
 * tab without reloading or opening a new tab), which the session's side panel then shows.
 */
export function openLinkIn(url: string, destination: LinkDestination, sessionId: string | null) {
  // Either place makes the site one opened from Kettu, which is not asked about as new again.
  window.kettu.browser
    .siteOpened(url)
    .catch((e: unknown) => console.warn(`Could not record the link's site: ${errorMessage(e)}`))
  if (destination === 'session' && !isWeb && sessionId) {
    const { main } = useViewStore.getState()
    const summary = useSessionsStore.getState().byId[sessionId]
    if (main.kind !== 'session' || main.sessionId !== sessionId) {
      if (!summary) {
        window.open(url, '_blank', 'noreferrer')
        return
      }
      openSession(sessionId, summary.projectPath)
    }
    toggleSidePane(sessionId, 'browser', true)
    window.kettu.browser
      .openLink(sessionId, url)
      .catch((e: unknown) => toast(i18n.t('session:link.openFailed', { error: errorMessage(e) })))
    return
  }
  // Main hands the address of a window the page opens to the default browser.
  window.open(url, '_blank', 'noreferrer')
}

export interface OpenSessionLinkOptions {
  /** Whether a modifier click asks for the alternate destination. */
  other?: boolean
  /** Explicit destination override, which still honors confirmation rules. */
  destination?: LinkDestination
}

/**
 * Routes an http(s) link through `planLinkOpen` / `planLinkOpenIn` using the user's link settings,
 * site memory, localhost rules, and global confirmation dialog. Returns false for non-http(s) URLs.
 */
export function openSessionLink(
  url: string,
  sessionId: string | null | undefined,
  options: OpenSessionLinkOptions = {},
): boolean {
  if (!isHttpUrl(url)) return false
  const resolved = sessionId ?? null
  const canUseSession = hasSessionTarget(resolved)
  const context: LinkContext = { session: canUseSession }
  const prefs = useSettingsStore.getState().settings.thread
  const known = iconFor(useSiteIconsStore.getState().sites, url) !== undefined
  const plan: LinkPlan = options.destination
    ? planLinkOpenIn(url, prefs, context, known, options.destination)
    : planLinkOpen(url, prefs, context, known, options.other ?? false)
  const targetSession = canUseSession ? resolved : null
  if (plan.ask) {
    askLinkConfirm(url, plan.destination, targetSession)
  } else {
    openLinkIn(url, plan.destination, targetSession)
  }
  return true
}

export interface SessionLinkOptions {
  /** Runs when an http(s) link click is intercepted, e.g. to dismiss a popover or hover card. */
  onOpen?: () => void
}

/** Handles a primary click on a session-associated anchor through `openSessionLink`. */
export function handleSessionLinkClick(
  event: Pick<
    MouseEvent<HTMLElement>,
    'button' | 'metaKey' | 'ctrlKey' | 'defaultPrevented' | 'preventDefault'
  >,
  url: string,
  sessionId: string | null | undefined,
  options?: SessionLinkOptions,
): void {
  if (event.defaultPrevented || event.button !== 0 || !isHttpUrl(url)) return
  event.preventDefault()
  options?.onOpen?.()
  openSessionLink(url, sessionId, { other: isMod(event) })
}

/** Handles a middle click on a session-associated anchor through `openSessionLink`. */
export function handleSessionLinkAuxClick(
  event: Pick<MouseEvent<HTMLElement>, 'button' | 'defaultPrevented' | 'preventDefault'>,
  url: string,
  sessionId: string | null | undefined,
  options?: SessionLinkOptions,
): void {
  if (event.defaultPrevented || event.button !== 1 || !isHttpUrl(url)) return
  event.preventDefault()
  options?.onOpen?.()
  openSessionLink(url, sessionId, { other: false })
}

/** Props for an `<a>` associated with a session so clicks route through `openSessionLink`. */
export function sessionLinkProps(
  url: string,
  sessionId: string | null | undefined,
  options?: SessionLinkOptions,
) {
  return {
    href: url,
    rel: 'noreferrer',
    onClick: (event: MouseEvent<HTMLAnchorElement>) =>
      handleSessionLinkClick(event, url, sessionId, options),
    onAuxClick: (event: MouseEvent<HTMLAnchorElement>) =>
      handleSessionLinkAuxClick(event, url, sessionId, options),
  } as const
}

/** Remembers where the link's site opens from now on, for the dialog's "Always open". */
export function rememberDestination(url: string, destination: LinkDestination): void {
  const site = linkSite(url)
  if (!site) return
  const { settings, update } = useSettingsStore.getState()
  update({
    thread: { alwaysOpenIn: rememberSite(settings.thread.alwaysOpenIn, site, destination) },
  }).catch((e: unknown) =>
    console.warn(`Could not remember where ${site} opens: ${errorMessage(e)}`),
  )
}
