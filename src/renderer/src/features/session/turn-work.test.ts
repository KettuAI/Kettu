import { describe, expect, it } from 'vitest'
import type { ToolContent, ToolEntry } from '@shared/thread'
import { turnChanges, workCounts } from './turn-work'

function tool(
  id: string,
  toolKind: ToolEntry['toolKind'],
  {
    paths = [],
    content = [],
    status = 'completed',
  }: {
    paths?: string[]
    content?: ToolContent[]
    status?: ToolEntry['status']
  } = {},
): ToolEntry {
  return {
    kind: 'tool',
    id,
    title: id,
    toolKind,
    status,
    content,
    locations: paths.map((path) => ({ path })),
    permission: null,
    permissionResult: null,
  }
}

const diff = (path: string, newText = 'b'): ToolContent => ({
  type: 'diff',
  path,
  oldText: 'a',
  newText,
})

describe('workCounts', () => {
  it('counts each file read or edited once', () => {
    expect(
      workCounts([
        tool('r1', 'read', { paths: ['/p/a.ts'] }),
        tool('r2', 'read', { paths: ['/p/a.ts', '/p/b.ts'] }),
        tool('e1', 'edit', { content: [diff('/p/a.ts')] }),
        tool('e2', 'edit', { content: [diff('/p/a.ts'), diff('/p/c.ts')] }),
      ]),
    ).toEqual({ reads: 2, edits: 2 })
  })

  it('counts a read without locations once, and an edit without diffs by its locations', () => {
    expect(
      workCounts([
        tool('r1', 'read'),
        tool('r2', 'read'),
        tool('e1', 'edit', { paths: ['/p/a.ts'] }),
        tool('d1', 'delete', { paths: ['/p/old.ts'] }),
      ]),
    ).toEqual({ reads: 2, edits: 2 })
  })

  it('skips calls that did not finish and calls of other kinds', () => {
    expect(
      workCounts([
        tool('r1', 'read', { paths: ['/p/a.ts'], status: 'failed' }),
        tool('e1', 'edit', { content: [diff('/p/a.ts')], status: 'cancelled' }),
        tool('x1', 'execute', { paths: ['/p/a.ts'] }),
        tool('s1', 'search', { paths: ['/p/b.ts'] }),
        undefined,
        { kind: 'agent', id: 'a1', markdown: '', attachments: [], streaming: false },
      ]),
    ).toEqual({ reads: 0, edits: 0 })
  })
})

describe('turnChanges', () => {
  it('lists each changed file once, in the order first changed, with its diffs in order', () => {
    const first = diff('/p/a.ts', '1')
    const second = diff('/p/b.ts')
    const third = diff('/p/a.ts', '2')
    expect(
      turnChanges([
        tool('e1', 'edit', { content: [first] }),
        tool('e2', 'edit', { content: [second, third] }),
        tool('e3', 'edit', { content: [diff('/p/c.ts')], status: 'failed' }),
      ]),
    ).toEqual([
      { path: '/p/a.ts', diffs: [first, third] },
      { path: '/p/b.ts', diffs: [second] },
    ])
  })
})
