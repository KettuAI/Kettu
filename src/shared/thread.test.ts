import { describe, expect, it } from 'vitest'
import {
  applyPatchInPlace,
  applyPatches,
  coalescePatches,
  threadEntries,
  threadFromSnapshot,
  UnknownEntryError,
  type Patch,
  type SessionView,
  type ThreadEntry,
  type ThreadState,
} from './thread'

const session: SessionView = {
  id: 's1',
  agentId: 'fake-agent',
  projectPath: '/tmp/project',
  acpSessionId: 'acp-1',
  status: 'ready',
  title: null,
  config: [],
  commands: [],
  usage: null,
  error: null,
  turnStartedAt: null,
  createdAt: 1,
  updatedAt: 1,
  parentId: null,
  origin: 'user',
  subagent: null,
  queue: [],
  queuePaused: false,
}

const user: ThreadEntry = { kind: 'user', id: 'e:1', content: [{ type: 'text', text: 'Hi' }] }
const agent: ThreadEntry = {
  kind: 'agent',
  id: 'm:1',
  markdown: 'Hel',
  attachments: [],
  streaming: true,
}

function state(entries: ThreadEntry[] = [user, agent]): ThreadState {
  return threadFromSnapshot({ session, entries, seq: 0 })
}

describe('applyPatches', () => {
  it('returns the same state when there is nothing to apply', () => {
    const before = state()
    expect(applyPatches(before, [])).toBe(before)
  })

  it('appends text and keeps every untouched object', () => {
    const before = state()
    const after = applyPatches(before, [{ op: 'entry.appendText', id: 'm:1', text: 'lo' }])
    expect(after.byId['m:1']).toMatchObject({ markdown: 'Hello' })
    expect(after.byId['e:1']).toBe(before.byId['e:1'])
    expect(after.order).toBe(before.order)
    expect(after.session).toBe(before.session)
    expect(before.byId['m:1']).toMatchObject({ markdown: 'Hel' })
  })

  it('adds entries in arrival order and upserts an id it already has in place', () => {
    const tool: ThreadEntry = {
      kind: 'tool',
      id: 't:1',
      title: 'Read file',
      toolKind: 'read',
      status: 'pending',
      content: [],
      locations: [],
      permission: null,
      permissionResult: null,
    }
    const after = applyPatches(state(), [
      { op: 'entry.add', entry: tool },
      { op: 'entry.add', entry: { ...user, content: [{ type: 'text', text: 'Edited' }] } },
    ])
    expect(after.order).toEqual(['e:1', 'm:1', 't:1'])
    expect(after.byId['e:1']).toMatchObject({ content: [{ type: 'text', text: 'Edited' }] })
  })

  it('updates only the fields given', () => {
    const after = applyPatches(state(), [
      { op: 'entry.update', id: 'm:1', changes: { streaming: false } },
    ])
    expect(after.byId['m:1']).toEqual({ ...agent, streaming: false })
  })

  it('updates the session without touching entries', () => {
    const before = state()
    const after = applyPatches(before, [
      { op: 'session.update', changes: { status: 'running', title: 'Fix it' } },
    ])
    expect(after.session).toMatchObject({ status: 'running', title: 'Fix it', id: 's1' })
    expect(after.byId).toBe(before.byId)
  })

  it('clears the thread on reset and accepts new entries after it', () => {
    const after = applyPatches(state(), [
      { op: 'thread.reset' },
      { op: 'entry.add', entry: { ...agent, id: 'm:2', markdown: 'Again' } },
    ])
    expect(threadEntries(after).map((e) => e.id)).toEqual(['m:2'])
  })

  it('throws for an unknown entry', () => {
    expect(() =>
      applyPatches(state(), [{ op: 'entry.appendText', id: 'nope', text: 'x' }]),
    ).toThrow(UnknownEntryError)
    expect(() => applyPatches(state(), [{ op: 'entry.update', id: 'nope', changes: {} }])).toThrow(
      UnknownEntryError,
    )
  })

  it('appends to a compaction summary', () => {
    const compaction: ThreadEntry = {
      kind: 'compaction',
      id: 'c:1',
      status: 'in_progress',
      summary: 'A',
    }
    const after = applyPatches(state([compaction]), [
      { op: 'entry.appendText', id: 'c:1', text: 'B' },
    ])
    expect(after.byId['c:1']).toMatchObject({ summary: 'AB' })
  })
})

describe('applyPatchInPlace', () => {
  const patches: Patch[] = [
    { op: 'entry.appendText', id: 'm:1', text: 'lo' },
    { op: 'entry.add', entry: { kind: 'user', id: 'e:2', content: [] } },
    { op: 'entry.update', id: 'm:1', changes: { streaming: false } },
    { op: 'entry.add', entry: { ...user, content: [{ type: 'text', text: 'Hi again' }] } },
    { op: 'session.update', changes: { title: 'Greeting' } },
  ]

  it('ends where applyPatches does', () => {
    let owned = state()
    for (const patch of patches) owned = applyPatchInPlace(owned, patch)
    expect(owned).toEqual(applyPatches(state(), patches))
  })

  it('reuses the containers it owns instead of copying them', () => {
    const owned = state()
    const { order, byId } = owned
    const after = applyPatchInPlace(owned, patches[1])
    expect(after.byId).toBe(byId)
    expect(after.order).toBe(order)
    expect(order).toEqual(['e:1', 'm:1', 'e:2'])
  })

  it('replaces a changed entry rather than mutating it', () => {
    const owned = state()
    applyPatchInPlace(owned, patches[0])
    expect(agent.kind === 'agent' && agent.markdown).toBe('Hel')
    expect(owned.byId['m:1']).toMatchObject({ markdown: 'Hello' })
  })

  it('clears the thread on reset', () => {
    const after = applyPatchInPlace(state(), { op: 'thread.reset' })
    expect(after.order).toEqual([])
    expect(after.byId).toEqual({})
  })

  it('throws for an unknown entry and leaves the state as it was', () => {
    const owned = state()
    expect(() =>
      applyPatchInPlace(owned, { op: 'entry.appendText', id: 'nope', text: 'x' }),
    ).toThrow(UnknownEntryError)
    expect(owned).toEqual(state())
  })
})

describe('coalescePatches', () => {
  it('merges consecutive appends to the same entry only', () => {
    expect(
      coalescePatches([
        { op: 'entry.appendText', id: 'm:1', text: 'a' },
        { op: 'entry.appendText', id: 'm:1', text: 'b' },
        { op: 'entry.appendText', id: 'm:2', text: 'c' },
        { op: 'entry.appendText', id: 'm:1', text: 'd' },
      ]),
    ).toEqual([
      { op: 'entry.appendText', id: 'm:1', text: 'ab' },
      { op: 'entry.appendText', id: 'm:2', text: 'c' },
      { op: 'entry.appendText', id: 'm:1', text: 'd' },
    ])
  })
})
