import { describe, expect, it } from 'vitest'
import type { SessionBrowserTab } from '@shared/browser'
import { MAIN_BROWSER_SOURCE, SessionBrowserTabs } from './browser-tabs'

const tab = (id: string, overrides: Partial<SessionBrowserTab> = {}): SessionBrowserTab => ({
  id,
  url: `https://example.com/${id}`,
  title: `Tab ${id}`,
  active: false,
  by: 'user',
  allowed: false,
  ...overrides,
})

describe('SessionBrowserTabs', () => {
  it('tracks, updates, deduplicates and clears tabs per session in isolation', () => {
    const store = new SessionBrowserTabs()
    const t1 = tab('t1', { active: true })
    const t2 = tab('t2', { by: 'agent', allowed: true })

    expect(store.list('s1')).toEqual([])
    expect(store.report(MAIN_BROWSER_SOURCE, 's1', [t1])).toEqual([t1])
    // Reporting identical tabs is a no-op and produces no change event.
    expect(store.report(MAIN_BROWSER_SOURCE, 's1', [t1])).toBeNull()
    expect(store.list('s1')).toEqual([t1])
    // Session isolation: s2 stays empty.
    expect(store.list('s2')).toEqual([])

    // Updating title/active state or adding a second tab emits the updated list.
    const t1Updated = tab('t1', { title: 'Docs', active: false })
    const t2Active = { ...t2, active: true }
    expect(store.report(MAIN_BROWSER_SOURCE, 's1', [t1Updated, t2Active])).toEqual([
      t1Updated,
      t2Active,
    ])
    expect(store.list('s1')).toEqual([t1Updated, t2Active])

    // Closing all tabs clears the session and emits an empty list once.
    expect(store.report(MAIN_BROWSER_SOURCE, 's1', [])).toEqual([])
    expect(store.report(MAIN_BROWSER_SOURCE, 's1', [])).toBeNull()
    expect(store.list('s1')).toEqual([])
  })

  it('isolates sources and clears only the disconnected desktop app on port close', () => {
    const store = new SessionBrowserTabs()
    const mainTab = tab('t-main', { active: true })
    const remoteTab = tab('t-remote', { active: true })

    // Both main and a paired desktop app report tabs for different and shared sessions.
    store.report(MAIN_BROWSER_SOURCE, 's-shared', [mainTab])
    store.report('port-1', 's-shared', [remoteTab])
    store.report('port-1', 's-remote-only', [remoteTab])

    // Preferred source selects the browser target driving the session's turns.
    expect(store.list('s-shared', MAIN_BROWSER_SOURCE)).toEqual([mainTab])
    expect(store.list('s-shared', 'port-1')).toEqual([remoteTab])
    expect(store.list('s-remote-only', MAIN_BROWSER_SOURCE)).toEqual([remoteTab])

    // When port-1 disconnects, s-remote-only clears to [] while s-shared falls back to main.
    const changes = store.clearSource('port-1', (id) =>
      id === 's-shared' ? 'port-1' : MAIN_BROWSER_SOURCE,
    )
    expect(changes).toEqual([
      { sessionId: 's-shared', tabs: [mainTab] },
      { sessionId: 's-remote-only', tabs: [] },
    ])
    expect(store.list('s-shared', MAIN_BROWSER_SOURCE)).toEqual([mainTab])
    expect(store.list('s-remote-only')).toEqual([])
  })

  it('replaces a source atomically on syncSource and removes ended sessions completely', () => {
    const store = new SessionBrowserTabs()
    const t1 = tab('t1', { active: true })
    const t2 = tab('t2', { active: true })

    store.report(MAIN_BROWSER_SOURCE, 's1', [t1])
    store.report(MAIN_BROWSER_SOURCE, 's2', [t2])
    store.report('port-2', 's3', [t2])

    // Syncing main with only s1 clears s2 without touching port-2's s3 or re-emitting s1.
    expect(store.syncSource(MAIN_BROWSER_SOURCE, { s1: [t1] })).toEqual([
      { sessionId: 's2', tabs: [] },
    ])
    expect(store.list('s1')).toEqual([t1])
    expect(store.list('s2')).toEqual([])
    expect(store.list('s3')).toEqual([t2])

    // Syncing main with empty map (e.g. window detached) clears remaining main tabs only.
    expect(store.syncSource(MAIN_BROWSER_SOURCE, {})).toEqual([{ sessionId: 's1', tabs: [] }])
    expect(store.list('s3')).toEqual([t2])

    // Ending s3 drops its tabs across all sources.
    store.removeSessions(['s3'])
    expect(store.list('s3')).toEqual([])
  })
})
