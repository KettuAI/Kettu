import { create } from 'zustand'
import { sameSessionBrowserTabs, type SessionBrowserTab } from '@shared/browser'
import { errorCode, host, sessionHost } from '@renderer/lib/host'

// Browser tabs reported to each session's agent host by a desktop window, kept separate from
// `useBrowserStore.bySession` (which tracks only local Electron WebContentsViews of this window).
// Paired clients (web, remote desktop) read and follow these tabs to list and reference pages.

interface SessionBrowserTabsStore {
  bySession: Record<string, SessionBrowserTab[]>
}

export const useSessionBrowserTabsStore = create<SessionBrowserTabsStore>()(() => ({
  bySession: {},
}))

const NO_TABS: SessionBrowserTab[] = []

/** Sessions that have already been synced from their host in the current connection. */
const synced = new Set<string>()
/** Hosts that answered `browser.tabs` with `unknown_method` on the current connection. */
const unsupportedHosts = new Set<string | null>()
/** Concurrent reads per session, deduplicated. */
const inFlight = new Map<string, Promise<SessionBrowserTab[]>>()

/** Applies a session's reported browser tabs from a `browser.tabs` event or RPC answer. */
export function receiveSessionBrowserTabs(sessionId: string, tabs: SessionBrowserTab[]): void {
  synced.add(sessionId)
  if (tabs.length === 0) {
    useSessionBrowserTabsStore.setState((s) => {
      if (!(sessionId in s.bySession)) return s
      const bySession = { ...s.bySession }
      delete bySession[sessionId]
      return { bySession }
    })
    return
  }
  useSessionBrowserTabsStore.setState((s) => {
    const prev = s.bySession[sessionId]
    if (prev && sameSessionBrowserTabs(prev, tabs)) return s
    return { bySession: { ...s.bySession, [sessionId]: tabs } }
  })
}

/** Drops reported tabs for a removed or archived session. */
export function forgetSessionBrowserTabs(sessionId: string): void {
  synced.delete(sessionId)
  inFlight.delete(sessionId)
  useSessionBrowserTabsStore.setState((s) => {
    if (!(sessionId in s.bySession)) return s
    const bySession = { ...s.bySession }
    delete bySession[sessionId]
    return { bySession }
  })
}

/** Clears cached tabs and unsupported markers for a host that disconnected or restarted. */
export function clearHostSessionBrowserTabs(hostId: string | null): void {
  unsupportedHosts.delete(hostId)
  for (const id of [...synced]) {
    if (sessionHost(id) === hostId) synced.delete(id)
  }
  for (const id of [...inFlight.keys()]) {
    if (sessionHost(id) === hostId) inFlight.delete(id)
  }
  useSessionBrowserTabsStore.setState((s) => {
    let changed = false
    const bySession: Record<string, SessionBrowserTab[]> = {}
    for (const [id, tabs] of Object.entries(s.bySession)) {
      if (sessionHost(id) === hostId) {
        changed = true
      } else {
        bySession[id] = tabs
      }
    }
    return changed ? { bySession } : s
  })
}

/** Re-enables `browser.tabs` queries for `hostId` after a new connection opens. */
export function hostBrowserTabsOpened(hostId: string | null): void {
  clearHostSessionBrowserTabs(hostId)
}

/**
 * Fetches `sessionId`'s current reported browser tabs from its owning host. Gracefully falls
 * back to an empty list when talking to an older host that does not implement `browser.tabs`.
 */
export function loadSessionBrowserTabs(sessionId: string): Promise<SessionBrowserTab[]> {
  const hostId = sessionHost(sessionId)
  if (unsupportedHosts.has(hostId)) return Promise.resolve(NO_TABS)
  const existing = inFlight.get(sessionId)
  if (existing) return existing
  const request = host('browser.tabs', { sessionId })
    .then((result) => {
      const tabs = Array.isArray(result?.tabs) ? result.tabs : []
      receiveSessionBrowserTabs(sessionId, tabs)
      return tabs
    })
    .catch((error: unknown) => {
      if (errorCode(error) === 'unknown_method') {
        unsupportedHosts.add(hostId)
        receiveSessionBrowserTabs(sessionId, [])
        return NO_TABS
      }
      return useSessionBrowserTabsStore.getState().bySession[sessionId] ?? NO_TABS
    })
    .finally(() => {
      if (inFlight.get(sessionId) === request) inFlight.delete(sessionId)
    })
  inFlight.set(sessionId, request)
  return request
}

/** Loads a session's reported browser tabs once per connection if not yet synced. */
export function ensureSessionBrowserTabs(sessionId: string): void {
  if (synced.has(sessionId)) return
  void loadSessionBrowserTabs(sessionId)
}

/** Resets module state between unit tests. */
export function resetSessionBrowserTabs(): void {
  synced.clear()
  unsupportedHosts.clear()
  inFlight.clear()
  useSessionBrowserTabsStore.setState({ bySession: {} })
}
