import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { shallow } from 'zustand/shallow'
import { isScratchFolder, recentSessions, sessionTree } from './sessions'

const session = (id: string, projectPath: string, extra: Partial<SessionSummary> = {}) =>
  ({
    id,
    projectPath,
    scratch: false,
    parentId: null,
    updatedAt: 0,
    createdAt: 0,
    permissionCount: 0,
    status: 'closed',
    ...extra,
  }) as SessionSummary

const byId = Object.fromEntries(
  [
    session('p1', '/repo'),
    session('x1', '/data/scratch/a', { scratch: true, updatedAt: 1 }),
    session('x2', '/data/scratch/b', { scratch: true, updatedAt: 2 }),
    session('x3', '/data/scratch/a', { scratch: true, parentId: 'x1' }),
  ].map((s) => [s.id, s]),
)

describe('sessionTree', () => {
  it("groups No project's sessions across their scratch folders", () => {
    const tree = sessionTree(byId, null)
    expect(tree.map((n) => n.summary.id)).toEqual(['x2', 'x1'])
    expect(tree[1]!.children.map((n) => n.summary.id)).toEqual(['x3'])
    expect(sessionTree(byId, '/repo').map((n) => n.summary.id)).toEqual(['p1'])
  })
})

describe('isScratchFolder', () => {
  it("knows a scratch session's folder from a project's", () => {
    expect(isScratchFolder(byId, '/data/scratch/a')).toBe(true)
    expect(isScratchFolder(byId, '/repo')).toBe(false)
  })
})

describe('recentSessions', () => {
  const user = (id: string, updatedAt: number, extra: Partial<SessionSummary> = {}) =>
    session(id, '/repo', { origin: 'user', updatedAt, ...extra })
  const sessions = Object.fromEntries(
    [
      user('a', 1),
      user('b', 4),
      user('c', 3),
      user('d', 2),
      user('child', 9, { parentId: 'b' }),
      session('sub', '/repo', { origin: 'subagent', updatedAt: 8 }),
    ].map((s) => [s.id, s]),
  )

  it("lists the user's top-level sessions, most recently updated first", () => {
    expect(recentSessions(sessions, 3).map((s) => s.id)).toEqual(['b', 'c', 'd'])
  })

  it('keeps its items when a session outside them changes', () => {
    const before = recentSessions(sessions, 3)
    const after = recentSessions({ ...sessions, a: { ...sessions.a!, status: 'running' } }, 3)
    expect(shallow(before, after)).toBe(true)
  })
})
