import { create } from 'zustand'
import type { BrowserState } from '@shared/browser'
import { useSessionsStore } from '@renderer/stores/sessions'
import { isSurfacePane } from '@renderer/stores/surface-tabs'
import { useViewStore } from '@renderer/stores/view'

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

/**
 * Follows the page state main sends, and tells main which sessions still exist, so a page closes
 * once its session leaves the host's memory. The first navigation of a session opens the pane
 * when its side panel shows nothing else; one showing another pane keeps it, and the toggle gets
 * a dot unless the pane is one with the row of tabs the page joins.
 */
export function initBrowser(): void {
  window.kettu.browser.onState((state) => useBrowserStore.getState().receive(state))
  window.kettu.browser.onOpened(({ sessionId }) => {
    if (!useSessionsStore.getState().byId[sessionId]) return
    const shown = useViewStore.getState().sidePane[sessionId]
    if (shown === undefined || shown === 'surfaces') {
      // Nothing else in the session's panel: show the browser, without taking the focus.
      useViewStore.setState((s) => ({ sidePane: { ...s.sidePane, [sessionId]: 'browser' } }))
      return
    }
    // A terminal or a device showing has the page's tab beside its own in the row.
    if (!isSurfacePane(shown)) {
      useBrowserStore.setState((s) => ({ unseen: { ...s.unseen, [sessionId]: true } }))
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
