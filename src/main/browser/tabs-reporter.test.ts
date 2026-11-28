import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionBrowserTab } from '@shared/browser'
import { BrowserTabsReporter } from './tabs-reporter'

const tab = (id: string, overrides: Partial<SessionBrowserTab> = {}): SessionBrowserTab => ({
  id,
  url: `https://example.com/${id}`,
  title: `Page ${id}`,
  active: true,
  by: 'user',
  allowed: false,
  ...overrides,
})

describe('BrowserTabsReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces rapid updates, skips no-op updates, and clears immediately', () => {
    const reportLocal = vi.fn()
    const syncLocal = vi.fn()
    const reportRemote = vi.fn(() => true)
    const reporter = new BrowserTabsReporter({
      hostOf: () => null,
      reportLocal,
      syncLocal,
      reportRemote,
      debounceMs: 80,
    })

    const t1Initial = tab('t1', { title: null, url: 'https://example.com' })
    const t1Titled = tab('t1', { title: 'Example', url: 'https://example.com' })

    reporter.update('s1', [t1Initial])
    vi.advanceTimersByTime(40)
    reporter.update('s1', [t1Titled])
    expect(reportLocal).not.toHaveBeenCalled()

    vi.advanceTimersByTime(80)
    expect(reportLocal).toHaveBeenCalledTimes(1)
    expect(reportLocal).toHaveBeenCalledWith('s1', [t1Titled])

    // Identical update is ignored.
    reporter.update('s1', [{ ...t1Titled }])
    vi.advanceTimersByTime(200)
    expect(reportLocal).toHaveBeenCalledTimes(1)

    // Clearing flushes immediately without waiting for debounce.
    reporter.update('s1', [])
    expect(reportLocal).toHaveBeenCalledTimes(2)
    expect(reportLocal).toHaveBeenLastCalledWith('s1', [])
  })

  it('routes local and remote sessions strictly to their owning hosts and resyncs on reconnect', () => {
    const hosts = new Map<string, string>([['s-remote', 'host-a']])
    const reportLocal = vi.fn()
    const syncLocal = vi.fn()
    const reportRemote = vi.fn(() => true)
    const reporter = new BrowserTabsReporter({
      hostOf: (sessionId) => hosts.get(sessionId) ?? null,
      reportLocal,
      syncLocal,
      reportRemote,
      debounceMs: 0,
    })

    const localTab = tab('t-local')
    const remoteTab = tab('t-remote')

    reporter.update('s-local', [localTab])
    reporter.update('s-remote', [remoteTab])

    expect(reportLocal).toHaveBeenCalledWith('s-local', [localTab])
    expect(reportLocal).not.toHaveBeenCalledWith('s-remote', expect.anything())
    expect(reportRemote).toHaveBeenCalledWith('host-a', 's-remote', [remoteTab])
    expect(reportRemote).not.toHaveBeenCalledWith('host-a', 's-local', expect.anything())

    // Local agent host restart gets only local sessions in its sync snapshot.
    expect(reporter.takeLocalSnapshot()).toEqual({ 's-local': [localTab] })

    // Remote host disconnects then reconnects: remote tabs replay to host-a.
    reportRemote.mockClear()
    reporter.hostClosed('host-a')
    reporter.hostOpened('host-a')
    expect(reportRemote).toHaveBeenCalledTimes(1)
    expect(reportRemote).toHaveBeenCalledWith('host-a', 's-remote', [remoteTab])

    // Window detach clears both local host (syncLocal) and remote hosts (reportRemote []).
    reportRemote.mockClear()
    reporter.windowDetached()
    expect(syncLocal).toHaveBeenCalledWith({})
    expect(reportRemote).toHaveBeenCalledWith('host-a', 's-remote', [])
  })

  it('clears a previously reported remote session even if its host mapping was already dropped', () => {
    const hosts = new Map<string, string>([['s-remote', 'host-a']])
    const reportRemote = vi.fn(() => true)
    const reporter = new BrowserTabsReporter({
      hostOf: (sessionId) => hosts.get(sessionId) ?? null,
      reportLocal: vi.fn(),
      syncLocal: vi.fn(),
      reportRemote,
      debounceMs: 0,
    })

    reporter.update('s-remote', [tab('t1')])
    hosts.delete('s-remote')
    reporter.clear('s-remote')

    expect(reportRemote).toHaveBeenLastCalledWith('host-a', 's-remote', [])
  })
})
