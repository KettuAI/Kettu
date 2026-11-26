import { describe, expect, it } from 'vitest'
import type { ToolEntry } from '@shared/thread'
import { turnChanges } from './turn-work'

function tool(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    id: 't1',
    kind: 'tool',
    title: 'Edit',
    toolKind: 'edit',
    status: 'completed',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...overrides,
  }
}

describe('turnChanges', () => {
  it('marks files deleted when the latest completed tool for that path deleted them', () => {
    const changes = turnChanges([
      tool({
        id: 't1',
        toolKind: 'edit',
        content: [{ type: 'diff', path: '/app/a.ts', oldText: 'a', newText: 'b' }],
      }),
      tool({
        id: 't2',
        toolKind: 'delete',
        content: [{ type: 'diff', path: '/app/b.ts', oldText: 'gone', newText: '' }],
      }),
      tool({
        id: 't3',
        toolKind: 'delete',
        locations: [{ path: '/app/a.ts' }],
      }),
    ])
    expect(changes.map(({ path, deleted }) => ({ path, deleted }))).toEqual([
      { path: '/app/a.ts', deleted: true },
      { path: '/app/b.ts', deleted: true },
    ])
  })

  it('clears the deleted flag if a later completed edit recreates the file', () => {
    const changes = turnChanges([
      tool({
        id: 't1',
        toolKind: 'delete',
        content: [{ type: 'diff', path: '/app/a.ts', oldText: 'old', newText: '' }],
      }),
      tool({
        id: 't2',
        toolKind: 'edit',
        content: [{ type: 'diff', path: '/app/a.ts', oldText: null, newText: 'fresh' }],
      }),
      tool({
        id: 't3',
        toolKind: 'delete',
        status: 'in_progress',
        locations: [{ path: '/app/a.ts' }],
      }),
    ])
    expect(changes).toHaveLength(1)
    expect(changes[0]?.deleted).toBe(false)
  })
})
