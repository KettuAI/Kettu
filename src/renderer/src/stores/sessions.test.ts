import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { isScratchFolder, sessionTree } from './sessions'

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
