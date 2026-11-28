import { create } from 'zustand'
import {
  activeBrowserControl,
  MAX_BROWSER_ANNOTATIONS,
  type BrowserElementAnnotatedEvent,
  type BrowserState,
} from '@shared/browser'
import { emitAppEvent } from '@renderer/app/events'
import { toast } from '@renderer/components/ui/toast'
import { addDraftBrowserAnnotation } from '@renderer/features/session/composer/browser-annotations'
import { i18n } from '@renderer/lib/i18n'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import {
  awaitSurfaceKeys,
  isSurfaceKind,
  replaceSurfaceKey,
  surfaceKey,
} from '@renderer/stores/surface-tabs'
import { panelSession, toggleSidePane, useViewStore, type SidePane } from '@renderer/stores/view'

interface BrowserStore {
  /** What main last said about each session's page. */
  bySession: Record<string, BrowserState>
  /** A still of the page, shown in its place while an overlay would cover the view. */
  stills: Record<string, string>
  /** Sessions whose page an agent opened while the pane showed something else. */
  unseen: Record<string, true>
  receive(state: BrowserState): void
  setStill(sessionId: string, still: string | null): void
  /** The pane shows the page now, so the toggle's dot is no longer needed. */
  seen(sessionId: string): void
  forget(sessionId: string): void
}

export const useBrowserStore = create<BrowserStore>()((set) => ({
  bySession: {},
  stills: {},
  unseen: {},
  receive(state) {
    set((s) => ({ bySession: { ...s.bySession, [state.sessionId]: state } }))
  },
  setStill(sessionId, still) {
    set((s) => {
      const stills = { ...s.stills }
      if (still) stills[sessionId] = still
      else delete stills[sessionId]
      return { stills }
    })
  },
  seen(sessionId) {
    set((s) => {
      if (!s.unseen[sessionId]) return s
      const unseen = { ...s.unseen }
      delete unseen[sessionId]
      return { unseen }
    })
  },
  forget(sessionId) {
    set((s) => {
      const bySession = { ...s.bySession }
      const stills = { ...s.stills }
      const unseen = { ...s.unseen }
      delete bySession[sessionId]
      delete stills[sessionId]
      delete unseen[sessionId]
      return { bySession, stills, unseen }
    })
  },
}))

// The pages each session had open, which a restart opens again at their addresses.
const PAGES_KEY = 'browser-pages:v1'
const REMEMBERED_SESSIONS = 200

interface SavedPage {
  id: string
  url: string
}
interface SavedPages {
  pages: SavedPage[]
  /** The tab that was selected, by its place among `pages`. */
  selected: number
}

const savedPages = readJson<Record<string, SavedPages>>(PAGES_KEY, {})
// Sessions whose pages an earlier run left, until this run opens them again. A page that only
// loads again in a running app finds main still holding its pages, so it restores none.
const toRestore = new Map(firstLoad() ? Object.entries(savedPages) : [])
for (const [sessionId, saved] of toRestore) {
  awaitSurfaceKeys(
    sessionId,
    saved.pages.map((page) => surfaceKey('browser', page.id)),
  )
}

/** Whether the app's page loads for the first time in this run of the app. */
function firstLoad(): boolean {
  const LOADED = 'browser-pages:loaded'
  try {
    if (sessionStorage.getItem(LOADED)) return false
    sessionStorage.setItem(LOADED, '1')
    return true
  } catch {
    return false
  }
}

function rememberPages(state: BrowserState): void {
  if (toRestore.has(state.sessionId)) return
  const pages = state.tabs.flatMap((tab) => (tab.url ? [{ id: tab.id, url: tab.url }] : []))
  const before = savedPages[state.sessionId]
  if (pages.length === 0 && !before) return
  delete savedPages[state.sessionId]
  if (pages.length > 0) {
    const selected = pages.findIndex((page) => page.id === state.selected)
    savedPages[state.sessionId] = { pages, selected: Math.max(selected, 0) }
  }
  for (const id of Object.keys(savedPages).slice(0, -REMEMBERED_SESSIONS)) delete savedPages[id]
  writeJson(PAGES_KEY, savedPages)
}

/**
 * Opens the pages a session had when the app last ran, each at its address and in its place in
 * the row, once its side panel shows. A session that already has pages keeps those.
 */
export async function restorePages(sessionId: string): Promise<void> {
  const saved = toRestore.get(sessionId)
  if (!saved) return
  toRestore.delete(sessionId)
  if (useBrowserStore.getState().bySession[sessionId]?.tabs.length) {
    awaitSurfaceKeys(sessionId, [])
    return
  }
  const shown = useViewStore.getState().sidePane[sessionId]
  const opened: string[] = []
  try {
    for (const page of saved.pages) {
      const id = await window.kettu.browser.newTab(sessionId)
      if (!id) break
      replaceSurfaceKey(sessionId, surfaceKey('browser', page.id), surfaceKey('browser', id))
      await window.kettu.browser.navigate(sessionId, page.url)
      opened.push(id)
    }
    const selected = opened[saved.selected] ?? opened[0]
    if (selected) await window.kettu.browser.selectTab(sessionId, selected)
  } catch (error) {
    console.error('Could not reopen the pages', error)
  }
  awaitSurfaceKeys(sessionId, [])
  // Opening them is no reason to leave what the panel showed.
  const now = useViewStore.getState().sidePane[sessionId]
  if (shown && now && now !== shown) toggleSidePane(sessionId, shown, true)
}

/**
 * Sessions whose browser side panel just collapsed (not switched to another tab or session) while
 * the user held takeover control of the browser.
 */
export function closedTakeoverBrowserPanels(
  prevSidePane: Record<string, SidePane>,
  nextSidePane: Record<string, SidePane>,
  bySession: Record<string, BrowserState>,
): string[] {
  const closed: string[] = []
  for (const [panel, prev] of Object.entries(prevSidePane)) {
    if (prev !== 'browser' || nextSidePane[panel] !== undefined) continue
    const sessionId = panelSession(panel)
    if (!sessionId) continue
    if (activeBrowserControl(bySession[sessionId])?.kind === 'you') {
      closed.push(sessionId)
    }
  }
  return closed
}

// Sessions whose taken-over browser tab is closing in the current turn so closing the last tab
// with `closeSidePanelWithLastTab` does not also emit a duplicate "panel closed" toast.
const closingTakenOverTabs = new Set<string>()

/** Marks a session's taken-over tab as closing so panel-collapse notifications do not double up. */
export function markTakenOverBrowserTabClosing(sessionId: string): void {
  closingTakenOverTabs.add(sessionId)
  queueMicrotask(() => closingTakenOverTabs.delete(sessionId))
}

/**
 * Handles a picked page element from the built-in browser: attaches it to the active session's
 * composer draft and focuses the composer, or shows a clear non-crashing notice when the target
 * session cannot accept composer references.
 */
export function handleBrowserAnnotatedEvent(event: BrowserElementAnnotatedEvent): boolean {
  const session = useSessionsStore.getState().byId[event.sessionId]
  const threadSession = useThreadsStore.getState().replicas[event.sessionId]?.state?.session
  const origin = threadSession?.origin ?? session?.origin
  if (!session || session.archivedAt !== null || origin === 'subagent') {
    toast(i18n.t('composer:browserAnnotations.noActiveSession'), undefined, { tone: 'warning' })
    return false
  }
  if (threadSession?.heldOutside === true) {
    toast(i18n.t('composer:browserAnnotations.sessionHeldOutside'), undefined, { tone: 'warning' })
    return false
  }
  const status = threadSession?.status ?? session.status
  if (status === 'starting') {
    toast(i18n.t('composer:browserAnnotations.sessionStarting'), undefined, { tone: 'info' })
    return false
  }
  const result = addDraftBrowserAnnotation(event.sessionId, event.annotation)
  if (result.limitReached) {
    toast(
      i18n.t('composer:browserAnnotations.limit', { count: MAX_BROWSER_ANNOTATIONS }),
      undefined,
      {
        tone: 'warning',
      },
    )
    return false
  }
  emitAppEvent({ kind: 'focus-composer', sessionId: event.sessionId })
  return true
}

/**
 * Follows the page state main sends, and tells main which sessions still exist, so a page closes
 * once its session leaves the host's memory. The first navigation of a session shows its tab when
 * its side panel is closed or shows the list; one showing another tab keeps it, and the side
 * panel's button gets a dot.
 */
export function initBrowser(): void {
  window.kettu.browser.onState((state) => {
    useBrowserStore.getState().receive(state)
    rememberPages(state)
  })
  window.kettu.browser.onAnnotated(handleBrowserAnnotatedEvent)
  window.kettu.browser.onOpened(({ sessionId }) => {
    if (!useSessionsStore.getState().byId[sessionId]) return
    const shown = useViewStore.getState().sidePane[sessionId]
    if (shown === undefined || shown === 'surfaces') {
      // Nothing else in the session's panel: show the browser, without taking the focus.
      useViewStore.setState((s) => ({ sidePane: { ...s.sidePane, [sessionId]: 'browser' } }))
      return
    }
    // A terminal or a device showing has the page's tab beside its own in the row.
    if (!isSurfaceKind(shown)) {
      useBrowserStore.setState((s) => ({ unseen: { ...s.unseen, [sessionId]: true } }))
    }
  })
  let prevSidePane = useViewStore.getState().sidePane
  useViewStore.subscribe((state) => {
    const nextSidePane = state.sidePane
    if (nextSidePane === prevSidePane) return
    const closed = closedTakeoverBrowserPanels(
      prevSidePane,
      nextSidePane,
      useBrowserStore.getState().bySession,
    )
    prevSidePane = nextSidePane
    for (const sessionId of closed) {
      if (closingTakenOverTabs.has(sessionId)) continue
      void window.kettu.browser
        .releaseTakeover(sessionId)
        .catch((error: unknown) => console.error('Could not release browser takeover', error))
      toast(i18n.t('control:note.closed.browserPanel'), undefined, { tone: 'info' })
    }
  })
  let known = new Set(Object.keys(useSessionsStore.getState().byId))
  // Until this computer's sessions are read the store is empty, which would close every page.
  useSessionsStore.subscribe((state) => {
    const ids = Object.keys(state.byId)
    for (const id of known) if (!(id in state.byId)) useBrowserStore.getState().forget(id)
    known = new Set(ids)
    if (state.loaded) window.kettu.browser.setSessions(ids)
  })
  if (useSessionsStore.getState().loaded) window.kettu.browser.setSessions([...known])
}
