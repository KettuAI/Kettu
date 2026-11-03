import { describe, expect, it } from 'vitest'
import { RECENT_LIMIT, searchSessions, type SessionSearchInput } from './search-sessions'

function session(
  patch: Partial<SessionSearchInput> & Pick<SessionSearchInput, 'id'>,
): SessionSearchInput {
  return {
    title: patch.id,
    project: 'kettu',
    host: null,
    branch: null,
    detail: null,
    updatedAt: 0,
    ...patch,
  }
}

describe('searchSessions', () => {
  it('lists the most recently updated few when nothing is typed', () => {
    const sessions = Array.from({ length: RECENT_LIMIT + 1 }, (_, i) =>
      session({ id: `s${i}`, updatedAt: i }),
    )
    expect(searchSessions(sessions, '   ').map((s) => s.id)).toEqual(
      Array.from({ length: RECENT_LIMIT }, (_, i) => `s${RECENT_LIMIT - i}`),
    )
  })

  it('breaks a tie on the id, so the order does not depend on the input', () => {
    const sessions = [session({ id: 'b', updatedAt: 1 }), session({ id: 'a', updatedAt: 1 })]
    expect(searchSessions(sessions, '').map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('keeps a session only when every word matches, in any of the fields', () => {
    const sessions = [
      session({ id: 'title', title: 'Fix the login', project: 'web' }),
      session({ id: 'project', title: 'Notes', project: 'KettuAI' }),
      session({ id: 'branch', title: 'Notes', project: 'web', branch: 'fix-login' }),
      session({
        id: 'detail',
        title: 'Worker',
        project: 'web',
        detail: 'Look through the login form',
      }),
      session({ id: 'host', title: 'Notes', project: 'web', host: 'office' }),
    ]
    expect(searchSessions(sessions, 'LOGIN').map((s) => s.id)).toEqual([
      'branch',
      'detail',
      'title',
    ])
    expect(searchSessions(sessions, 'notes kettu').map((s) => s.id)).toEqual(['project'])
    expect(searchSessions(sessions, 'office').map((s) => s.id)).toEqual(['host'])
  })

  it('returns nothing when a word matches no field', () => {
    expect(searchSessions([session({ id: 's', title: 'Fix the login' })], 'login deploy')).toEqual(
      [],
    )
  })
})
