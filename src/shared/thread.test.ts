import { describe, expect, it } from 'vitest'
import {
  applyPatchInPlace,
  applyPatches,
  coalescePatches,
  entryMessageId,
  isThreadEntry,
  outOfCreditTurn,
  prependEntries,
  retryableTurn,
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
  turnStartUsed: null,
  createdAt: 1,
  updatedAt: 1,
  parentId: null,
  origin: 'user',
  subagent: null,
  routine: null,
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

describe('pages', () => {
  it('ignores a patch for an entry on a page not loaded yet, only when told to', () => {
    const before = state([agent])
    const patch: Patch = { op: 'entry.update', id: 'e:1', changes: { content: [] } }
    expect(() => applyPatches(before, [patch])).toThrow(UnknownEntryError)
    expect(applyPatches(before, [patch], { partial: true })).toBe(before)
    const append: Patch = { op: 'entry.appendText', id: 'gone', text: 'x' }
    expect(applyPatches(before, [append], { partial: true })).toBe(before)
  })

  it('prepends older entries, skipping any already there', () => {
    const before = state([agent])
    const after = prependEntries(before, [user, agent])
    expect(after.order).toEqual(['e:1', 'm:1'])
    expect(after.byId['m:1']).toBe(before.byId['m:1'])
    expect(prependEntries(after, [user])).toBe(after)
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

describe('isThreadEntry', () => {
  const valid: ThreadEntry[] = [
    { kind: 'user', id: 'e:1', content: [{ type: 'text', text: 'hi' }], steered: true },
    {
      kind: 'agent',
      id: 'm:1',
      markdown: 'ok',
      attachments: [{ kind: 'link', uri: 'https://x', name: 'x' }],
      streaming: false,
    },
    { kind: 'thought', id: 'm:2', markdown: '', streaming: true },
    {
      kind: 'tool',
      id: 't:1',
      title: 'Edit',
      toolKind: 'edit',
      status: 'completed',
      content: [
        { type: 'diff', path: 'a.ts', oldText: null, newText: 'x' },
        { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: 'AA' } },
      ],
      locations: [{ path: 'a.ts' }],
      permission: { requestId: 'p1', options: [{ id: 'o', name: 'Allow', kind: 'allow_once' }] },
      permissionResult: null,
      description: 'Rewrite a.ts',
    },
    { kind: 'subagent', id: 's:1', sessionId: 'child' },
    { kind: 'session_message', id: 'sm:1', senderId: null, content: [] },
    { kind: 'plan', id: 'e:2', items: [{ content: 'x', priority: 'low', status: 'pending' }] },
    { kind: 'notice', id: 'e:3', severity: 'info', title: 'x' },
    { kind: 'notice', id: 'e:5', severity: 'error', title: 'x', cause: 'agent_stopped' },
    {
      kind: 'notice',
      id: 'e:6',
      severity: 'warning',
      title: 'x',
      cause: 'out_of_credit',
      model: 'deepseek-v4.1-flash',
      after: 'm:1',
    },
    { kind: 'notice', id: 'e:7', severity: 'info', title: 'x', after: null },
    {
      kind: 'notice',
      id: 'e:11',
      severity: 'error',
      title: 'The turn failed',
      description: 'Overloaded',
      cause: 'turn_failed',
      after: 'm:1',
    },
    { kind: 'compaction', id: 'c:1', status: 'completed', summary: '' },
    { kind: 'turn_end', id: 'e:4', stopReason: 'end_turn', durationMs: 5 },
    { kind: 'turn_end', id: 'e:8', stopReason: 'cancelled', durationMs: 5, after: 't:1' },
    { kind: 'git', id: 'g:1', event: 'commit', commits: [{ oid: 'a', subject: 'b' }], more: 0 },
    { kind: 'git', id: 'g:2', event: 'branch', branch: 'main' },
    { kind: 'git', id: 'g:3', event: 'push', upstream: 'origin/main', count: 1, after: 't:1' },
    { kind: 'git', id: 'g:4', event: 'pull_request', url: 'https://x', after: null },
    {
      kind: 'artifact',
      id: 'a:6',
      artifactId: 'art_1',
      title: 'Deck',
      action: 'create',
      version: 3,
      writes: 2,
      after: 't:1',
    },
    {
      kind: 'artifact',
      id: 'a:7',
      artifactId: 'art_1',
      title: 'Deck',
      action: 'delete',
      version: null,
      writes: 1,
      after: null,
    },
    {
      kind: 'browser_origin',
      id: 'e:9',
      requestId: 1,
      origin: 'https://example.com',
      decision: null,
      after: 't:1',
    },
    {
      kind: 'browser_origin',
      id: 'e:10',
      requestId: 2,
      origin: 'https://example.com',
      decision: 'timeout',
      after: null,
    },
    {
      kind: 'computer_app',
      id: 'e:11',
      requestId: 3,
      appId: 'com.apple.textedit',
      appName: 'TextEdit',
      decision: null,
      after: 't:1',
    },
    {
      kind: 'computer_app',
      id: 'e:12',
      requestId: 4,
      appId: 'com.apple.textedit',
      appName: 'TextEdit',
      decision: 'always',
      device: { id: 'phone', name: 'Phone' },
      after: null,
    },
    {
      kind: 'computer_setup',
      id: 'e:13',
      requestId: 5,
      steps: ['enable', 'accessibility', 'screen-recording'],
      done: ['enable'],
      outcome: null,
      after: 't:1',
    },
    {
      kind: 'computer_setup',
      id: 'e:14',
      requestId: 6,
      steps: ['enable'],
      done: [],
      outcome: 'declined',
      device: { id: 'phone', name: 'Phone' },
      after: null,
    },
    {
      kind: 'problem_report',
      id: 'e:15',
      title: 'create_artifact rejects an SVG sprite',
      details: 'It fails every time.',
      error: null,
      at: 1_700_000_000_000,
      outcome: null,
      after: 't:1',
    },
    {
      kind: 'problem_report',
      id: 'e:16',
      title: 'create_artifact rejects an SVG sprite',
      details: 'It fails every time.',
      error: 'invalid file entry',
      at: 1_700_000_000_000,
      outcome: { kind: 'sent', reportId: 'R-7K2F' },
      device: { id: 'phone', name: 'Phone' },
      after: null,
    },
  ]

  it('accepts every kind of entry', () => {
    for (const entry of valid) expect(isThreadEntry(entry), entry.kind).toBe(true)
  })

  it('refuses unknown kinds and missing fields the renderer reads', () => {
    expect(isThreadEntry(null)).toBe(false)
    expect(isThreadEntry({ kind: 'mystery', id: 'x' })).toBe(false)
    expect(isThreadEntry({ kind: 'user', content: [] })).toBe(false)
    expect(isThreadEntry({ kind: 'agent', id: 'x', markdown: '', streaming: false })).toBe(false)
    expect(
      isThreadEntry({ kind: 'user', id: 'x', content: [{ type: 'ref', ref: { kind: 'image' } }] }),
    ).toBe(false)
    expect(
      isThreadEntry({
        ...valid[3],
        content: [{ type: 'diff', path: 'a', oldText: 1, newText: '' }],
      }),
    ).toBe(false)
    expect(isThreadEntry({ ...valid[3], permission: { requestId: 'p' } })).toBe(false)
    expect(isThreadEntry({ ...valid[3], description: 1 })).toBe(false)
    const artifact = valid.find((entry) => entry.kind === 'artifact')!
    expect(isThreadEntry({ ...artifact, action: 'read' })).toBe(false)
    expect(isThreadEntry({ ...artifact, writes: undefined })).toBe(false)
    expect(isThreadEntry({ ...artifact, after: 1 })).toBe(false)
    const origin = valid.find((entry) => entry.kind === 'browser_origin')!
    expect(isThreadEntry({ ...origin, requestId: 'one' })).toBe(false)
    expect(isThreadEntry({ ...origin, decision: 'maybe' })).toBe(false)
    expect(isThreadEntry({ ...origin, after: 1 })).toBe(false)
    const app = valid.find((entry) => entry.kind === 'computer_app')!
    expect(isThreadEntry({ ...app, requestId: 1.5 })).toBe(false)
    expect(isThreadEntry({ ...app, appId: undefined })).toBe(false)
    expect(isThreadEntry({ ...app, appName: 7 })).toBe(false)
    expect(isThreadEntry({ ...app, decision: 'project' })).toBe(false)
    expect(isThreadEntry({ ...app, after: 1 })).toBe(false)
    const report = valid.find((entry) => entry.kind === 'problem_report')!
    expect(isThreadEntry({ ...report, details: undefined })).toBe(false)
    expect(isThreadEntry({ ...report, at: '1700000000000' })).toBe(false)
    expect(isThreadEntry({ ...report, outcome: { kind: 'sent' } })).toBe(false)
    expect(isThreadEntry({ ...report, outcome: 'skipped' })).toBe(false)
    const setup = valid.find((entry) => entry.kind === 'computer_setup')!
    expect(isThreadEntry({ ...setup, requestId: 'five' })).toBe(false)
    expect(isThreadEntry({ ...setup, steps: ['enable', 'camera'] })).toBe(false)
    expect(isThreadEntry({ ...setup, steps: undefined })).toBe(false)
    expect(isThreadEntry({ ...setup, done: 'enable' })).toBe(false)
    expect(isThreadEntry({ ...setup, outcome: 'deny' })).toBe(false)
    expect(isThreadEntry({ ...setup, after: 1 })).toBe(false)
    expect(isThreadEntry({ kind: 'git', id: 'g', event: 'commit' })).toBe(false)
    expect(isThreadEntry({ kind: 'git', id: 'g', event: 'branch', branch: 'x', after: 1 })).toBe(
      false,
    )
    expect(isThreadEntry({ kind: 'notice', id: 'n', severity: 'info', title: 'x', after: 1 })).toBe(
      false,
    )
    expect(
      isThreadEntry({ kind: 'turn_end', id: 'e', stopReason: 'end_turn', durationMs: 1, after: 1 }),
    ).toBe(false)
    expect(
      isThreadEntry({ kind: 'notice', id: 'n', severity: 'error', title: 'x', cause: 'other' }),
    ).toBe(false)
    expect(
      isThreadEntry({ kind: 'notice', id: 'n', severity: 'warning', title: 'x', model: 1 }),
    ).toBe(false)
  })
})

describe('retryableTurn', () => {
  const failed: ThreadEntry = {
    kind: 'notice',
    id: 'e:9',
    severity: 'error',
    title: 'The turn failed',
    cause: 'turn_failed',
  }
  const unpaid: ThreadEntry = {
    kind: 'notice',
    id: 'e:9',
    severity: 'warning',
    title: 'Out of credit',
    cause: 'out_of_credit',
  }
  const done: ThreadEntry = {
    kind: 'agent',
    id: 'm:1',
    markdown: 'Hi',
    attachments: [],
    streaming: false,
  }

  it("gives a failed turn's notice and prompt, past the work it did", () => {
    const turn = retryableTurn(state([user, done, failed]))
    expect(turn?.notice.id).toBe('e:9')
    expect(turn?.prompt.id).toBe('e:1')
  })

  it('gives a turn refused for want of credit too', () => {
    expect(retryableTurn(state([user, unpaid]))?.notice.cause).toBe('out_of_credit')
  })

  it('gives nothing once work follows the notice or the turn ended otherwise', () => {
    expect(retryableTurn(state([user, failed, done]))).toBeNull()
    expect(retryableTurn(state([user, done]))).toBeNull()
    const stopped: ThreadEntry = { ...failed, cause: 'agent_stopped' }
    expect(retryableTurn(state([user, stopped]))).toBeNull()
  })

  it('leaves the out-of-credit turn to a notice of its own', () => {
    expect(outOfCreditTurn(state([user, failed]))).toBeNull()
    expect(outOfCreditTurn(state([user, unpaid]))?.prompt.id).toBe('e:1')
  })
})

describe('entryMessageId', () => {
  it("gives the agent's message id of a message entry", () => {
    expect(entryMessageId('m:msg_1')).toBe('msg_1')
    expect(entryMessageId('m:msg_1#agent')).toBe('msg_1')
    expect(entryMessageId('m:item-3#thought')).toBe('item-3')
  })

  it('gives null for an entry without one', () => {
    expect(entryMessageId('e:12')).toBeNull()
    expect(entryMessageId('t:call_1')).toBeNull()
    expect(entryMessageId('sm:msg_1')).toBeNull()
  })
})
