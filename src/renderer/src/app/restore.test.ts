import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { launchTarget } from './restore'

const summary = { id: 's1', projectPath: '/repo' } as SessionSummary
const byId = { s1: summary }
const launching = { kind: 'launch' } as const
const launch = { enabled: true, sessionId: 's1', main: launching, byId }

describe('launchTarget', () => {
  it('reopens the saved session when the setting is on', () => {
    expect(launchTarget(launch)).toEqual({ kind: 'session', summary })
  })

  it('opens New session when the setting is off or nothing was saved', () => {
    expect(launchTarget({ ...launch, enabled: false })).toEqual({ kind: 'new' })
    expect(launchTarget({ ...launch, sessionId: null })).toEqual({ kind: 'new' })
  })

  it('opens New session in place of a session that no longer exists', () => {
    expect(launchTarget({ ...launch, sessionId: 'gone' })).toEqual({ kind: 'new' })
  })

  it('opens New session on a first run, with no projects and no sessions', () => {
    expect(launchTarget({ ...launch, sessionId: null, byId: {} })).toEqual({ kind: 'new' })
  })

  it('does not take over once the user has opened something', () => {
    const main = { kind: 'session', sessionId: 's2' } as const
    expect(launchTarget({ ...launch, main })).toBeNull()
    expect(launchTarget({ ...launch, main: { kind: 'usage' } })).toBeNull()
  })
})
