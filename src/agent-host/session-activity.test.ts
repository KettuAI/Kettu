import { expect, it } from 'vitest'
import { applyPatchInPlace, type Patch, type ThreadState, type ToolEntry } from '@shared/thread'
import { activityDetail, ToolActivity } from './session-activity'

function tool(id: string, changes: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id,
    title: `Run ${id}`,
    toolKind: 'execute',
    status: 'in_progress',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...changes,
  }
}

function follower() {
  // The patches these tests apply touch only the entries.
  let thread = { order: [], byId: {} } as unknown as ThreadState
  const activity = new ToolActivity()
  return {
    activity,
    apply(patch: Patch, now: number): boolean {
      thread = applyPatchInPlace(thread, patch)
      return activity.follow(thread, patch, now)
    },
    current: () => activity.current(thread),
  }
}

it('shows the latest call to start, and the one before once it ends', () => {
  const f = follower()
  expect(f.apply({ op: 'entry.add', entry: tool('a') }, 10)).toBe(true)
  expect(f.apply({ op: 'entry.add', entry: tool('b') }, 20)).toBe(true)
  expect(f.current()).toMatchObject({ entryId: 'b', startedAt: 20 })
  expect(f.apply({ op: 'entry.update', id: 'b', changes: { status: 'completed' } }, 30)).toBe(true)
  expect(f.current()).toMatchObject({ entryId: 'a', startedAt: 10 })
  expect(f.apply({ op: 'entry.update', id: 'a', changes: { status: 'failed' } }, 40)).toBe(true)
  expect(f.current()).toBeNull()
})

it('changes with a call starting or ending, not with its output', () => {
  const f = follower()
  f.apply({ op: 'entry.add', entry: tool('a') }, 10)
  const output: Patch = {
    op: 'entry.update',
    id: 'a',
    changes: { content: [{ type: 'markdown', markdown: 'ok' }] },
  }
  expect(f.apply(output, 20)).toBe(false)
  expect(f.apply({ op: 'entry.update', id: 'a', changes: { rawInput: 'ls' } }, 30)).toBe(true)
  expect(f.current()).toMatchObject({ detail: 'ls', startedAt: 10 })
  expect(f.apply({ op: 'entry.add', entry: tool('done', { status: 'completed' }) }, 40)).toBe(false)
})

it('forgets the calls a replay brings back', () => {
  const f = follower()
  f.apply({ op: 'entry.add', entry: tool('a') }, 10)
  expect(f.apply({ op: 'thread.reset' }, 20)).toBe(true)
  expect(f.current()).toBeNull()
})

it("names a call's key argument", () => {
  expect(activityDetail(tool('a', { rawInput: '\n  pnpm test\n  pnpm lint' }))).toBe('pnpm test')
  expect(activityDetail(tool('a', { rawInput: '{"command":"git status","x":1}' }))).toBe(
    'git status',
  )
  expect(
    activityDetail(tool('a', { toolKind: 'edit', locations: [{ path: '/p/src/app.ts' }] })),
  ).toBe('/p/src/app.ts')
  expect(
    activityDetail(tool('a', { toolKind: 'search', rawInput: '{"pattern":"Date.now"}' })),
  ).toBe('Date.now')
  expect(
    activityDetail(tool('a', { toolKind: 'fetch', rawInput: '{"url":"https://a.b/c"}' })),
  ).toBe('https://a.b/c')
  expect(activityDetail(tool('a', { toolKind: 'think', rawInput: '{"prompt":"x"}' }))).toBeNull()
  expect(activityDetail(tool('a', { rawInput: 'x'.repeat(500) }))?.length).toBe(200)
})
