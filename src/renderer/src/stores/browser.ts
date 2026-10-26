import { create } from 'zustand'
import type { BrowserState } from '@shared/browser'
import { useSessionsStore } from '@renderer/stores/sessions'

interface BrowserStore {
  /** What main last said about each session's page. */
  bySession: Record<string, BrowserState>
  /** A still of the page, shown in its place while an overlay would cover the view. */
  stills: Record<string, string>
  receive(state: BrowserState): void
  setStill(sessionId: string, still: string | null): void
  forget(sessionId: string): void
}

export const useBrowserStore = create<BrowserStore>()((set) => ({
  bySession: {},
  stills: {},
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
  forget(sessionId) {
    set((s) => {
      const bySession = { ...s.bySession }
      const stills = { ...s.stills }
      delete bySession[sessionId]
      delete stills[sessionId]
      return { bySession, stills }
    })
  },
}))

/**
 * Follows the page state main sends, and tells main which sessions still exist, so a page closes
 * once its session leaves the host's memory.
 */
export function initBrowser(): void {
  window.overbench.browser.onState((state) => useBrowserStore.getState().receive(state))
  let known = new Set(Object.keys(useSessionsStore.getState().byId))
  useSessionsStore.subscribe((state) => {
    const ids = Object.keys(state.byId)
    for (const id of known) if (!(id in state.byId)) useBrowserStore.getState().forget(id)
    known = new Set(ids)
    window.overbench.browser.setSessions(ids)
  })
  window.overbench.browser.setSessions([...known])
}
