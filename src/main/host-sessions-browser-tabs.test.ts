import { describe, expect, it } from 'vitest'
import { isOtherHostMethod } from '@shared/host-sessions'
import { HostSessions, type RelayPort } from './host-sessions'

function fakePortPair(): {
  port1: RelayPort
  port2: RelayPort
  sentToHost: unknown[]
  receiveFromHost(message: unknown): void
} {
  const hostListeners: ((event: { data: unknown }) => void)[] = []
  const sentToHost: unknown[] = []
  const port1: RelayPort = {
    postMessage: (message) => sentToHost.push(message),
    on: (event, listener) => {
      if (event === 'message') hostListeners.push(listener as (event: { data: unknown }) => void)
    },
    start: () => {},
    close: () => {},
  }
  const port2: RelayPort = {
    postMessage: () => {},
    on: () => {},
    start: () => {},
    close: () => {},
  }
  return {
    port1,
    port2,
    sentToHost,
    receiveFromHost: (data) => {
      for (const listener of hostListeners) listener({ data })
    },
  }
}

describe('HostSessions browser tabs routing and backward compatibility (#2260)', () => {
  const HOST_ID = 'a'.repeat(43)

  it('allows windows to query browser.tabs on another host while blocking browser.reportTabs', () => {
    expect(isOtherHostMethod('browser.tabs')).toBe(true)
    expect(isOtherHostMethod('browser.answerOrigin')).toBe(true)
    expect(isOtherHostMethod('browser.reportTabs')).toBe(false)
    expect(isOtherHostMethod('browser.answer')).toBe(false)
  })

  it('learns remote session ownership from trusted host events and skips unsupported methods on older hosts', () => {
    const sessions = new HostSessions()
    const hostPort = fakePortPair()
    sessions.opened(HOST_ID, hostPort.port1)

    // Learns session ownership from trusted host events and clears on session.removed.
    hostPort.receiveFromHost({
      type: 'event',
      event: { type: 'session.summary', summary: { id: 's-remote' } },
    })
    expect(sessions.hostOfSession('s-remote')).toBe(HOST_ID)

    // First browser.reportTabs goes out; older host replies unknown_method.
    expect(
      sessions.request(HOST_ID, 'browser.reportTabs', { sessionId: 's-remote', tabs: [] }),
    ).toBe(true)
    expect(hostPort.sentToHost).toHaveLength(1)
    const reqId = (hostPort.sentToHost[0] as { id: number }).id
    hostPort.receiveFromHost({
      type: 'error',
      id: reqId,
      error: { code: 'unknown_method', message: 'Unknown method "browser.reportTabs"' },
    })

    // Subsequent browser.reportTabs on the same connection are skipped cleanly.
    expect(
      sessions.request(HOST_ID, 'browser.reportTabs', { sessionId: 's-remote', tabs: [] }),
    ).toBe(false)
    expect(hostPort.sentToHost).toHaveLength(1)

    // Reconnecting clears the unsupported cache so an upgraded host receives reports again.
    const nextPort = fakePortPair()
    sessions.opened(HOST_ID, nextPort.port1)
    expect(
      sessions.request(HOST_ID, 'browser.reportTabs', { sessionId: 's-remote', tabs: [] }),
    ).toBe(true)
    expect(nextPort.sentToHost).toHaveLength(1)

    // Removing the session clears ownership.
    nextPort.receiveFromHost({
      type: 'event',
      event: { type: 'session.removed', sessionId: 's-remote' },
    })
    expect(sessions.hostOfSession('s-remote')).toBeNull()
  })
})
