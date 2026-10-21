import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { sessionToRestore } from './restore'

const summary = { id: 's1', projectPath: '/repo' } as SessionSummary
const byId = { s1: summary }
const home = { kind: 'home' } as const

describe('sessionToRestore', () => {
  it('reopens the saved session when the setting is on', () => {
    expect(sessionToRestore({ enabled: true, sessionId: 's1', main: home, byId })).toBe(summary)
  })

  it('leaves the launch alone when the setting is off or nothing was saved', () => {
    expect(sessionToRestore({ enabled: false, sessionId: 's1', main: home, byId })).toBeNull()
    expect(sessionToRestore({ enabled: true, sessionId: null, main: home, byId })).toBeNull()
  })

  it('skips a session that no longer exists', () => {
    expect(sessionToRestore({ enabled: true, sessionId: 'gone', main: home, byId })).toBeNull()
  })

  it('does not take over once the user has opened something', () => {
    const main = { kind: 'session', sessionId: 's2' } as const
    expect(sessionToRestore({ enabled: true, sessionId: 's1', main, byId })).toBeNull()
  })
})
