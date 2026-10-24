import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { sessionMenuGroups } from './session-menu-model'

const summary = (extra: Partial<SessionSummary> = {}) =>
  ({ status: 'ready', parentId: null, origin: 'user', pr: null, ...extra }) as SessionSummary
const pr = { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12' } as const

describe('sessionMenuGroups', () => {
  it('gives an idle top-level session every group but the state one', () => {
    expect(sessionMenuGroups(summary(), true)).toEqual([
      ['pin', 'unread', 'rename'],
      ['fork', 'newSubSession'],
      ['showInFolder'],
      ['archive'],
      ['delete'],
    ])
  })

  it('leads with Stop while it runs or waits, and Retry while it failed or needs sign-in', () => {
    expect(sessionMenuGroups(summary({ status: 'running' }), true)[0]).toEqual(['stop'])
    expect(sessionMenuGroups(summary({ status: 'awaiting_permission' }), true)[0]).toEqual(['stop'])
    expect(sessionMenuGroups(summary({ status: 'failed' }), true)[0]).toEqual(['retry'])
    expect(sessionMenuGroups(summary({ status: 'auth_required' }), true)[0]).toEqual(['retry'])
  })

  it('offers the pull request when the branch has one, and Fork only when the agent can', () => {
    const groups = sessionMenuGroups(summary({ pr }), false)
    expect(groups).toContainEqual(['pullRequest', 'showInFolder'])
    expect(groups).toContainEqual(['newSubSession'])
  })

  it('leaves Pin, Fork and Archive out for a sub-session', () => {
    expect(sessionMenuGroups(summary({ parentId: 'p' }), true)).toEqual([
      ['unread', 'rename'],
      ['newSubSession'],
      ['showInFolder'],
      ['delete'],
    ])
  })

  it('gives a subagent only what its parent does not do for it', () => {
    const subagent = summary({ parentId: 'p', origin: 'subagent', status: 'running' })
    expect(sessionMenuGroups(subagent, true)).toEqual([['unread', 'rename']])
  })
})
