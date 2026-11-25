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
  type ToolEntry,
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

  it('cuts the thread at an entry, which goes with all after it, and accepts new ones', () => {
    const reply: ThreadEntry = { ...agent, id: 'm:2', markdown: 'Bye', streaming: false }
    const before = state([user, agent, { ...user, id: 'e:2' }, reply])
    const after = applyPatches(before, [
      { op: 'thread.truncate', id: 'e:2' },
      { op: 'entry.add', entry: { ...user, id: 'e:3' } },
    ])
    expect(after.order).toEqual(['e:1', 'm:1', 'e:3'])
    expect(Object.keys(after.byId).sort()).toEqual(['e:1', 'e:3', 'm:1'])
    expect(before.order).toEqual(['e:1', 'm:1', 'e:2', 'm:2'])
    // A cut at an entry on an older page, which a partial state lacks, asks for a snapshot.
    expect(() =>
      applyPatches(state([agent]), [{ op: 'thread.truncate', id: 'e:1' }], { partial: true }),
    ).toThrow(UnknownEntryError)
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

  it('cuts the thread at an entry', () => {
    const after = applyPatchInPlace(state(), { op: 'thread.truncate', id: 'm:1' })
    expect(after.order).toEqual(['e:1'])
    expect(after.byId).toEqual({ 'e:1': user })
    expect(() => applyPatchInPlace(state(), { op: 'thread.truncate', id: 'nope' })).toThrow(
      UnknownEntryError,
    )
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

describe('coalescePatches merging updates', () => {
  const run: ToolEntry = {
    kind: 'tool',
    id: 't:1',
    title: 'Run',
    toolKind: 'execute',
    status: 'in_progress',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
  }
  const other: ToolEntry = { ...run, id: 't:2', title: 'Other' }
  const withTools = (): ThreadState => state([user, agent, run, other])
  const output = (text: string): Patch => ({
    op: 'entry.update',
    id: 't:1',
    changes: { content: [{ type: 'markdown', markdown: text }] },
  })
  const retitle = (id: string, title: string): Patch => ({
    op: 'entry.update',
    id,
    changes: { title },
  })

  function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (const child of Object.values(value)) deepFreeze(child)
    }
    return value
  }

  // What the unmerged patches do, or that they throw, as the renderer's and the host's appliers do.
  function outcome(patches: readonly Patch[]): ThreadState | 'throws' {
    try {
      let owned = withTools()
      owned = { ...owned, order: [...owned.order], byId: { ...owned.byId } }
      for (const patch of patches) owned = applyPatchInPlace(owned, patch)
      expect(applyPatches(withTools(), patches)).toEqual(owned)
      return owned
    } catch (error) {
      if (error instanceof UnknownEntryError) return 'throws'
      throw error
    }
  }

  it('merges repeated updates of an entry, the later field winning', () => {
    const patches: Patch[] = [
      output('a'),
      retitle('t:1', 'Run it'),
      output('ab'),
      { op: 'entry.update', id: 't:1', changes: { status: 'completed' } },
    ]
    expect(coalescePatches(patches)).toEqual([
      {
        op: 'entry.update',
        id: 't:1',
        changes: {
          content: [{ type: 'markdown', markdown: 'ab' }],
          title: 'Run it',
          status: 'completed',
        },
      },
    ])
    expect(outcome(coalescePatches(patches))).toEqual(outcome(patches))
  })

  it('reduces a stream of whole outputs to the last one, the rest in order', () => {
    const patches: Patch[] = []
    for (let i = 1; i <= 50; i++) {
      patches.push(output('x'.repeat(i)))
      if (i % 10 === 0) patches.push({ op: 'session.update', changes: { updatedAt: i } })
    }
    patches.push({ op: 'entry.appendText', id: 'm:1', text: 'lo' })
    patches.push({ op: 'entry.update', id: 't:2', changes: { status: 'completed' } })
    expect(coalescePatches(patches)).toEqual([
      output('x'.repeat(50)),
      { op: 'session.update', changes: { updatedAt: 50 } },
      { op: 'entry.appendText', id: 'm:1', text: 'lo' },
      { op: 'entry.update', id: 't:2', changes: { status: 'completed' } },
    ])
    expect(outcome(coalescePatches(patches))).toEqual(outcome(patches))
  })

  it('merges across patches of other entries and keeps their order', () => {
    const patches: Patch[] = [
      output('a'),
      retitle('t:2', 'Two'),
      { op: 'entry.appendText', id: 'm:1', text: 'lo' },
      { op: 'session.update', changes: { updatedAt: 2 } },
      { op: 'entry.add', entry: { ...run, id: 't:3' } },
      output('ab'),
      { op: 'entry.update', id: 't:2', changes: { status: 'completed' } },
    ]
    expect(coalescePatches(patches).map((patch) => patch.op)).toEqual([
      'entry.update',
      'entry.update',
      'entry.appendText',
      'session.update',
      'entry.add',
    ])
    expect(outcome(coalescePatches(patches))).toEqual(outcome(patches))
  })

  it('merges consecutive session updates only', () => {
    const patches: Patch[] = [
      { op: 'session.update', changes: { updatedAt: 2, title: 'a' } },
      { op: 'session.update', changes: { updatedAt: 3 } },
      { op: 'entry.appendText', id: 'm:1', text: 'lo' },
      { op: 'session.update', changes: { title: 'b' } },
    ]
    expect(coalescePatches(patches)).toEqual([
      { op: 'session.update', changes: { updatedAt: 3, title: 'a' } },
      { op: 'entry.appendText', id: 'm:1', text: 'lo' },
      { op: 'session.update', changes: { title: 'b' } },
    ])
    expect(outcome(coalescePatches(patches))).toEqual(outcome(patches))
  })

  it.each<[string, Patch]>([
    ['an add of the entry', { op: 'entry.add', entry: { ...run, title: 'Again' } }],
    ['a reset', { op: 'thread.reset' }],
    ['a truncate', { op: 'thread.truncate', id: 't:2' }],
  ])('stops at %s', (_, stop) => {
    const patches: Patch[] = [retitle('t:1', 'a'), stop, retitle('t:1', 'b')]
    expect(coalescePatches(patches)).toEqual(patches)
    expect(outcome(coalescePatches(patches))).toEqual(outcome(patches))
  })

  it('stops at a text append to the entry itself', () => {
    const update = (markdown: string): Patch => ({
      op: 'entry.update',
      id: 'm:1',
      changes: { markdown },
    })
    const patches: Patch[] = [
      update('a'),
      { op: 'entry.appendText', id: 'm:1', text: 'b' },
      update('c'),
    ]
    expect(coalescePatches(patches)).toEqual(patches)
    expect(outcome(coalescePatches(patches))).toEqual(outcome(patches))
  })

  it('applies like the patches it was given, whatever their order', () => {
    let seed = 7
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return (seed >> 8) % n
    }
    const tools = ['t:1', 't:2', 't:3']
    for (let round = 0; round < 300; round++) {
      const patches: Patch[] = []
      for (let i = 0, count = 2 + next(12); i < count; i++) {
        const id = tools[next(tools.length)]
        switch (next(9)) {
          case 0:
            patches.push({
              op: 'session.update',
              changes: next(2) ? { updatedAt: i } : { title: `t${i}` },
            })
            break
          case 1:
            patches.push({ op: 'entry.add', entry: { ...run, id, title: `n${i}` } })
            break
          case 2:
            patches.push({ op: 'entry.appendText', id: 'm:1', text: `${i}` })
            break
          case 3:
            patches.push(next(2) ? { op: 'thread.reset' } : { op: 'thread.truncate', id })
            break
          case 4:
            patches.push({ op: 'entry.update', id: 'm:1', changes: { markdown: `m${i}` } })
            break
          default:
            patches.push(
              next(2)
                ? retitle(id, `u${i}`)
                : { op: 'entry.update', id, changes: { status: next(2) ? 'completed' : 'failed' } },
            )
        }
      }
      expect(outcome(coalescePatches(patches)), JSON.stringify(patches)).toEqual(outcome(patches))
    }
  })

  it('leaves its input, and the patches in it, as they were', () => {
    const patches = deepFreeze<Patch[]>([
      output('a'),
      output('ab'),
      { op: 'session.update', changes: { updatedAt: 2 } },
      { op: 'session.update', changes: { title: 'x' } },
      { op: 'entry.appendText', id: 'm:1', text: 'l' },
      { op: 'entry.appendText', id: 'm:1', text: 'o' },
    ])
    const before = JSON.stringify(patches)
    const merged = coalescePatches(patches)
    expect(merged).toHaveLength(3)
    expect(JSON.stringify(patches)).toBe(before)
    expect(patches).toHaveLength(6)
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
    {
      kind: 'task_delivery',
      id: 'e:17',
      taskId: 't-1',
      title: 'Ship the release',
      status: 'done',
      steps: 3,
      durationMs: 60_000,
      deliverables: [
        { kind: 'pull_request', url: 'https://github.com/o/r/pull/1' },
        { kind: 'document', artifactId: 'art_1', version: 2, title: 'Design' },
        { kind: 'file', title: 'App.dmg', detail: null, path: '/w/App.dmg' },
        { kind: 'link', title: 'Build 42', detail: 'iOS', url: 'https://example.com/b/42' },
      ],
      written: { agentId: 'claude-code' },
      publishAsked: 1_700_000_000_000,
      after: null,
    },
    {
      kind: 'task_delivery',
      id: 'e:18',
      taskId: 't-2',
      title: 'Try an idea',
      status: 'cancelled',
      steps: 1,
      durationMs: 5,
      deliverables: [],
      written: null,
      after: 'm:1',
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
    const delivery = valid.find((entry) => entry.kind === 'task_delivery')!
    expect(isThreadEntry({ ...delivery, status: 'running' })).toBe(false)
    expect(isThreadEntry({ ...delivery, deliverables: [{ kind: 'link', title: 'x' }] })).toBe(false)
    expect(isThreadEntry({ ...delivery, written: { agentId: 1 } })).toBe(false)
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
      isThreadEntry({
        kind: 'notice',
        id: 'n',
        severity: 'info',
        title: 'x',
        cause: 'reports_paused',
      }),
    ).toBe(true)
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
