// Reports each session's desktop browser tabs to its owning agent host (local main-to-host control
// channel for local sessions, or `browser.reportTabs` over hostSessions for remote sessions).
// Coalesces rapid navigation/title bursts, skips no-op updates, clears immediately on close or
// window detach, and resynchronizes after local host restarts or remote host reconnects.

import { sameSessionBrowserTabs, type SessionBrowserTab } from '@shared/browser'

/** Default coalescing delay for non-empty tab updates during page navigation bursts. */
export const BROWSER_TABS_DEBOUNCE_MS = 80

export interface BrowserTabsReporterDeps {
  /** Which remote host owns `sessionId`, or null for this computer's own agent host. */
  hostOf(sessionId: string): string | null
  /** Reports one local session's tabs to this computer's agent host. */
  reportLocal(sessionId: string, tabs: SessionBrowserTab[]): void
  /** Replaces every local session's tabs on this computer's agent host. */
  syncLocal(sessions: Record<string, SessionBrowserTab[]>): void
  /**
   * Reports one remote session's tabs to its host; returns false when the host is offline or does
   * not support `browser.reportTabs`.
   */
  reportRemote(hostId: string, sessionId: string, tabs: SessionBrowserTab[]): boolean
  /** Coalescing delay in milliseconds for non-empty updates; defaults to 80 ms. */
  debounceMs?: number
}

function cloneTabs(tabs: readonly SessionBrowserTab[]): SessionBrowserTab[] {
  return tabs.map((tab) => ({ ...tab }))
}

export class BrowserTabsReporter {
  /** Latest non-empty tab list per session. */
  private readonly current = new Map<string, SessionBrowserTab[]>()
  /** Last tab list sent to this computer's agent host, per session. */
  private readonly sentLocal = new Map<string, SessionBrowserTab[]>()
  /** Last tab list sent to each remote host, per host then session. */
  private readonly sentRemote = new Map<string, Map<string, SessionBrowserTab[]>>()
  /** Pending debounce timers, per session. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: BrowserTabsReporterDeps) {}

  /** Records a session's latest tab list and schedules (or immediately flushes) its report. */
  update(sessionId: string, tabs: readonly SessionBrowserTab[]): void {
    if (tabs.length === 0) {
      this.clear(sessionId)
      return
    }
    const next = cloneTabs(tabs)
    const prev = this.current.get(sessionId)
    if (prev && sameSessionBrowserTabs(prev, next)) return
    this.current.set(sessionId, next)
    const delay = this.deps.debounceMs ?? BROWSER_TABS_DEBOUNCE_MS
    if (delay <= 0) {
      this.cancelTimer(sessionId)
      this.flush(sessionId)
      return
    }
    this.cancelTimer(sessionId)
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      this.flush(sessionId)
    }, delay)
    this.timers.set(sessionId, timer)
  }

  /** Immediately clears a session's reported tabs wherever they were previously sent. */
  clear(sessionId: string): void {
    this.cancelTimer(sessionId)
    this.current.delete(sessionId)
    if (this.sentLocal.delete(sessionId)) {
      this.deps.reportLocal(sessionId, [])
    }
    for (const [hostId, bySession] of [...this.sentRemote]) {
      if (!bySession.delete(sessionId)) continue
      if (bySession.size === 0) this.sentRemote.delete(hostId)
      this.deps.reportRemote(hostId, sessionId, [])
    }
  }

  /**
   * Returns a snapshot of every local session's current tabs for `host:browser-tabs-sync` on
   * local agent host startup or restart, updating the local sent state to match.
   */
  takeLocalSnapshot(): Record<string, SessionBrowserTab[]> {
    this.sentLocal.clear()
    const snapshot: Record<string, SessionBrowserTab[]> = {}
    for (const [sessionId, tabs] of this.current) {
      if (this.deps.hostOf(sessionId) !== null) continue
      this.cancelTimer(sessionId)
      const copy = cloneTabs(tabs)
      snapshot[sessionId] = copy
      this.sentLocal.set(sessionId, cloneTabs(tabs))
    }
    return snapshot
  }

  /** Replays every current tab list owned by `hostId` after a connection to it opens. */
  hostOpened(hostId: string): void {
    this.sentRemote.delete(hostId)
    for (const [sessionId, tabs] of this.current) {
      if (this.deps.hostOf(sessionId) !== hostId) continue
      this.cancelTimer(sessionId)
      this.sendRemote(hostId, sessionId, tabs)
    }
  }

  /** Drops remote tracking for a host whose connection ended (the host clears on port close). */
  hostClosed(hostId: string): void {
    this.sentRemote.delete(hostId)
    for (const sessionId of [...this.timers.keys()]) {
      if (this.deps.hostOf(sessionId) === hostId) this.cancelTimer(sessionId)
    }
  }

  /**
   * All desktop windows closed and were destroyed: clears every local and remote reported session
   * so paired devices never see stale tabs from a detached window.
   */
  windowDetached(): void {
    this.dispose()
    this.current.clear()
    const hadLocal = this.sentLocal.size > 0
    this.sentLocal.clear()
    if (hadLocal) this.deps.syncLocal({})
    for (const [hostId, bySession] of [...this.sentRemote]) {
      for (const sessionId of bySession.keys()) {
        this.deps.reportRemote(hostId, sessionId, [])
      }
    }
    this.sentRemote.clear()
  }

  /** Cancels any pending timers on shutdown. */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private cancelTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(sessionId)
  }

  private flush(sessionId: string): void {
    const tabs = this.current.get(sessionId)
    if (!tabs || tabs.length === 0) {
      this.clear(sessionId)
      return
    }
    const hostId = this.deps.hostOf(sessionId)
    if (hostId === null) {
      // Clear any remote host that previously held this session before ownership settled.
      for (const [otherHost, bySession] of [...this.sentRemote]) {
        if (!bySession.delete(sessionId)) continue
        if (bySession.size === 0) this.sentRemote.delete(otherHost)
        this.deps.reportRemote(otherHost, sessionId, [])
      }
      const sent = this.sentLocal.get(sessionId)
      if (sent && sameSessionBrowserTabs(sent, tabs)) return
      this.sentLocal.set(sessionId, cloneTabs(tabs))
      this.deps.reportLocal(sessionId, cloneTabs(tabs))
      return
    }
    if (this.sentLocal.delete(sessionId)) {
      this.deps.reportLocal(sessionId, [])
    }
    for (const [otherHost, bySession] of [...this.sentRemote]) {
      if (otherHost === hostId || !bySession.delete(sessionId)) continue
      if (bySession.size === 0) this.sentRemote.delete(otherHost)
      this.deps.reportRemote(otherHost, sessionId, [])
    }
    this.sendRemote(hostId, sessionId, tabs)
  }

  private sendRemote(hostId: string, sessionId: string, tabs: readonly SessionBrowserTab[]): void {
    const bySession = this.sentRemote.get(hostId)
    const sent = bySession?.get(sessionId)
    if (sent && sameSessionBrowserTabs(sent, tabs)) return
    if (!this.deps.reportRemote(hostId, sessionId, cloneTabs(tabs))) return
    let map = bySession
    if (!map) {
      map = new Map()
      this.sentRemote.set(hostId, map)
    }
    map.set(sessionId, cloneTabs(tabs))
  }
}
