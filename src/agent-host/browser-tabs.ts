// Tracks each session's currently open browser tabs reported by the host's desktop window
// ('main') and paired desktop apps (by port id), so any connected client can list and reference
// them without leaking across sessions or leaving stale tabs after a window or app disconnects.

import { sameSessionBrowserTabs, type SessionBrowserTab } from '@shared/browser'

/** Source id used for the host's own desktop window reports over the main control channel. */
export const MAIN_BROWSER_SOURCE = 'main'

interface ReportedEntry {
  tabs: SessionBrowserTab[]
  seq: number
}

export interface SessionBrowserTabsChange {
  sessionId: string
  tabs: SessionBrowserTab[]
}

function cloneTabs(tabs: readonly SessionBrowserTab[]): SessionBrowserTab[] {
  return tabs.map((tab) => ({ ...tab }))
}

export class SessionBrowserTabs {
  private readonly bySession = new Map<string, Map<string, ReportedEntry>>()
  private readonly sessionsBySource = new Map<string, Set<string>>()
  private seq = 0

  /**
   * Effective browser tabs for `sessionId`. Prefers `preferredSource` when it holds tabs (matching
   * where browser tool calls currently route); otherwise falls back to the most recently updated
   * source that holds tabs.
   */
  list(sessionId: string, preferredSource?: string | null): SessionBrowserTab[] {
    const sources = this.bySession.get(sessionId)
    if (!sources || sources.size === 0) return []
    if (preferredSource) {
      const preferred = sources.get(preferredSource)
      if (preferred && preferred.tabs.length > 0) return cloneTabs(preferred.tabs)
    }
    let best: ReportedEntry | null = null
    for (const entry of sources.values()) {
      if (entry.tabs.length === 0) continue
      if (!best || entry.seq > best.seq) best = entry
    }
    return best ? cloneTabs(best.tabs) : []
  }

  /**
   * Updates `source`'s reported tabs for `sessionId` (an empty list clears them). Returns the new
   * effective tab list when it changed for clients watching `sessionId`, or null when unchanged.
   */
  report(
    source: string,
    sessionId: string,
    tabs: readonly SessionBrowserTab[],
    preferredSource?: (sessionId: string) => string | null,
  ): SessionBrowserTab[] | null {
    const before = this.list(sessionId, preferredSource?.(sessionId))
    if (tabs.length === 0) {
      this.deleteEntry(source, sessionId)
    } else {
      let sources = this.bySession.get(sessionId)
      if (!sources) {
        sources = new Map()
        this.bySession.set(sessionId, sources)
      }
      sources.set(source, { tabs: cloneTabs(tabs), seq: ++this.seq })
      let sessions = this.sessionsBySource.get(source)
      if (!sessions) {
        sessions = new Set()
        this.sessionsBySource.set(source, sessions)
      }
      sessions.add(sessionId)
    }
    const after = this.list(sessionId, preferredSource?.(sessionId))
    return sameSessionBrowserTabs(before, after) ? null : after
  }

  /**
   * Replaces every session reported by `source` atomically (for host restart sync or window close).
   * Returns only the sessions whose effective tab list changed.
   */
  syncSource(
    source: string,
    sessions: Readonly<Record<string, readonly SessionBrowserTab[]>>,
    preferredSource?: (sessionId: string) => string | null,
  ): SessionBrowserTabsChange[] {
    const affected = new Set<string>(this.sessionsBySource.get(source) ?? [])
    for (const sessionId of Object.keys(sessions)) affected.add(sessionId)
    const changes: SessionBrowserTabsChange[] = []
    for (const sessionId of affected) {
      const next = sessions[sessionId] ?? []
      const changed = this.report(source, sessionId, next, preferredSource)
      if (changed !== null) changes.push({ sessionId, tabs: changed })
    }
    return changes
  }

  /** Clears every session reported by `source`, returning those whose effective tabs changed. */
  clearSource(
    source: string,
    preferredSource?: (sessionId: string) => string | null,
  ): SessionBrowserTabsChange[] {
    return this.syncSource(source, {}, preferredSource)
  }

  /** Drops all reported tabs for ended or removed sessions across every source. */
  removeSessions(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const sources = this.bySession.get(sessionId)
      if (!sources) continue
      for (const source of sources.keys()) {
        const owned = this.sessionsBySource.get(source)
        if (owned) {
          owned.delete(sessionId)
          if (owned.size === 0) this.sessionsBySource.delete(source)
        }
      }
      this.bySession.delete(sessionId)
    }
  }

  clear(): void {
    this.bySession.clear()
    this.sessionsBySource.clear()
  }

  private deleteEntry(source: string, sessionId: string): void {
    const sources = this.bySession.get(sessionId)
    if (sources) {
      sources.delete(source)
      if (sources.size === 0) this.bySession.delete(sessionId)
    }
    const owned = this.sessionsBySource.get(source)
    if (owned) {
      owned.delete(sessionId)
      if (owned.size === 0) this.sessionsBySource.delete(source)
    }
  }
}
