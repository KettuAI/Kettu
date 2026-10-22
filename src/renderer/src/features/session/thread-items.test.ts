import { describe, expect, it } from 'vitest'
import type { SessionView, ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
import { buildItems, runParts, signatureOf, stepItems } from './thread-items'

const session = { id: 's1' } as SessionView

function tool(
  id: string,
  toolKind: ToolEntry['toolKind'],
  status: ToolEntry['status'] = 'completed',
): ToolEntry {
  return {
    kind: 'tool',
    id,
    title: id,
    toolKind,
    status,
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
  }
}

const user = (id: string): ThreadEntry => ({ kind: 'user', id, content: [] })
const agent = (id: string): ThreadEntry => ({
  kind: 'agent',
  id,
  markdown: '',
  attachments: [],
  streaming: false,
})

function state(entries: ThreadEntry[]): ThreadState {
  return {
    session,
    order: entries.map((e) => e.id),
    byId: Object.fromEntries(entries.map((e) => [e.id, e])),
  }
}

function items(entries: ThreadEntry[]) {
  const s = state(entries)
  return buildItems(s.order, signatureOf(s))
}

const thought = (id: string): ThreadEntry => ({
  kind: 'thought',
  id,
  markdown: '',
  streaming: false,
})
const plan = (id: string): ThreadEntry => ({ kind: 'plan', id, items: [] })

describe('signatureOf', () => {
  it('marks users, thoughts, groupable lookups, other tools and agent messages', () => {
    const s = state([
      user('u1'),
      thought('h1'),
      tool('r1', 'read'),
      tool('e1', 'edit'),
      tool('x1', 'execute'),
      agent('a1'),
    ])
    expect(signatureOf(s)).toBe('uhgtta')
  })

  it('does not group a lookup that runs or waits for permission', () => {
    const waiting: ToolEntry = {
      ...tool('r2', 'read'),
      permission: { requestId: 'p', options: [] },
    }
    expect(signatureOf(state([tool('r1', 'read', 'in_progress'), waiting]))).toBe('tt')
  })

  it('is empty without a state', () => {
    expect(signatureOf(null)).toBe('')
  })
})

describe('buildItems', () => {
  it('folds a run of thoughts and tool calls between messages', () => {
    const result = items([
      user('u1'),
      thought('h1'),
      tool('x1', 'execute'),
      tool('e1', 'edit'),
      agent('a1'),
    ])
    expect(result.map((i) => i.key)).toEqual(['u1', 'run:h1', 'a1', 'reply:u1'])
    expect(result[1]).toMatchObject({ type: 'run', ids: ['h1', 'x1', 'e1'], signature: 'htt' })
  })

  it('leaves a single step as its own entry', () => {
    const result = items([user('u1'), tool('x1', 'execute'), agent('a1'), thought('h1')])
    expect(result.map((i) => i.type)).toEqual(['entry', 'entry', 'entry', 'entry', 'reply'])
  })

  it('breaks a run at a plan, a subagent or a notice', () => {
    const result = items([
      tool('x1', 'execute'),
      tool('x2', 'execute'),
      plan('p1'),
      tool('x3', 'execute'),
      tool('x4', 'execute'),
    ])
    expect(result.map((i) => i.key)).toEqual(['run:x1', 'p1', 'run:x3'])
  })

  it('shows the run still growing in a live turn step by step', () => {
    const entries = [user('u1'), tool('x1', 'execute'), tool('x2', 'execute')]
    const s = state(entries)
    const live = buildItems(s.order, signatureOf(s), true)
    expect(live.map((i) => i.key)).toEqual(['u1', 'x1', 'x2'])
    const done = buildItems(s.order, signatureOf(s), false)
    expect(done.map((i) => i.key)).toEqual(['u1', 'run:x1'])
  })

  it("folds a live turn's earlier runs once a message follows them", () => {
    const s = state([
      user('u1'),
      tool('x1', 'execute'),
      tool('x2', 'execute'),
      agent('a1'),
      tool('x3', 'execute'),
      tool('x4', 'execute'),
    ])
    const result = buildItems(s.order, signatureOf(s), true)
    expect(result.map((i) => i.key)).toEqual(['u1', 'run:x1', 'a1', 'x3', 'x4'])
  })

  it('groups consecutive completed lookups in a live run', () => {
    const s = state([
      user('u1'),
      tool('r1', 'read'),
      tool('s1', 'search'),
      tool('f1', 'fetch'),
      tool('x1', 'execute', 'in_progress'),
    ])
    const result = buildItems(s.order, signatureOf(s), true)
    expect(result.map((i) => i.key)).toEqual(['u1', 'group:r1', 'x1'])
    expect(result[1]).toMatchObject({ type: 'group', ids: ['r1', 's1', 'f1'] })
  })

  it('marks user entries as turn starts', () => {
    const result = items([user('u1'), agent('a1'), user('u2')]).filter((i) => i.type === 'entry')
    expect(result.map((i) => i.turnStart)).toEqual([true, false, true])
  })

  it("anchors the scroll to the latest turn's start only", () => {
    const result = items([user('u1'), agent('a1'), user('u2'), agent('a2')]).filter(
      (i) => i.type === 'entry',
    )
    expect(result.map((i) => i.scrollAnchor)).toEqual([false, false, true, false])
  })
})

describe("a finished turn's work", () => {
  const end = (id: string): ThreadEntry => ({
    kind: 'turn_end',
    id,
    stopReason: 'end_turn',
    durationMs: 1000,
  })
  const turn = [
    user('u1'),
    thought('h1'),
    agent('a1'),
    tool('x1', 'execute'),
    tool('x2', 'execute'),
    agent('a2'),
    thought('h2'),
    tool('r1', 'read'),
    plan('p1'),
    tool('x3', 'execute'),
    agent('a3'),
    end('t1'),
  ]

  it('folds everything before the answer into one run', () => {
    const s = state(turn)
    const result = buildItems(s.order, signatureOf(s))
    expect(result.map((i) => i.key)).toEqual(['u1', 'run:h1', 'a3', 'reply:u1'])
    expect(result[1]).toMatchObject({
      type: 'run',
      ids: ['h1', 'a1', 'x1', 'x2', 'a2', 'h2', 'r1', 'p1', 'x3'],
      signature: 'hattahgot',
    })
  })

  it('shows the running turn as it goes, and folds it when it ends', () => {
    const s = state(turn.slice(0, -1))
    const live = buildItems(s.order, signatureOf(s), true)
    expect(live.map((i) => i.key)).toEqual([
      'u1',
      'h1',
      'a1',
      'run:x1',
      'a2',
      'run:h2',
      'p1',
      'x3',
      'a3',
    ])
    const done = buildItems(s.order, signatureOf(s), false)
    expect(done.map((i) => i.key)).toEqual(['u1', 'run:h1', 'a3', 'reply:u1'])
  })

  it('keeps an answer in several messages together', () => {
    const s = state([user('u1'), tool('x1', 'execute'), agent('a1'), agent('a2')])
    expect(buildItems(s.order, signatureOf(s)).map((i) => i.key)).toEqual([
      'u1',
      'x1',
      'a1',
      'a2',
      'reply:u1',
    ])
  })

  it('folds nothing without a step', () => {
    const s = state([user('u1'), agent('a1'), plan('p1'), agent('a2')])
    expect(buildItems(s.order, signatureOf(s)).map((i) => i.key)).toEqual([
      'u1',
      'a1',
      'p1',
      'a2',
      'reply:u1',
    ])
  })

  it('stops at a steered message', () => {
    const steered: ThreadEntry = { kind: 'user', id: 's1', content: [], steered: true }
    const s = state([
      user('u1'),
      agent('a1'),
      agent('a2'),
      tool('x1', 'execute'),
      steered,
      thought('h1'),
      agent('a3'),
      tool('x2', 'execute'),
      agent('a4'),
    ])
    expect(buildItems(s.order, signatureOf(s)).map((i) => i.key)).toEqual([
      'u1',
      'run:a1',
      's1',
      'run:h1',
      'a4',
      'reply:u1',
    ])
  })
})

describe('runParts', () => {
  it('lists the steps of a run of steps, with lookups grouped', () => {
    const parts = runParts(['x1', 'r1', 'r2'], 'tgg')
    expect(parts.map((p) => p.key)).toEqual(['x1', 'group:r1'])
  })

  it("folds again the steps between a turn's earlier messages", () => {
    const parts = runParts(['h1', 'a1', 'x1', 'x2', 'a2', 'x3'], 'hattat')
    expect(parts.map((p) => p.key)).toEqual(['h1', 'a1', 'run:x1', 'a2', 'x3'])
    expect(parts.map((p) => p.type === 'entry' && !p.step)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ])
  })
})

describe('reply footers', () => {
  const end = (id: string): ThreadEntry => ({
    kind: 'turn_end',
    id,
    stopReason: 'end_turn',
    durationMs: 1000,
  })
  const keys = (entries: ThreadEntry[], live = false) => {
    const s = state(entries)
    return buildItems(s.order, signatureOf(s), live).map((i) => i.key)
  }

  it("take the place of a turn's end, after its messages", () => {
    const s = state([user('u1'), agent('a1'), tool('x1', 'execute'), agent('a2'), end('t1')])
    const result = buildItems(s.order, signatureOf(s))
    expect(result.map((i) => i.key)).toEqual(['u1', 'run:a1', 'a2', 'reply:u1'])
    expect(result.at(-1)).toMatchObject({
      type: 'reply',
      agentIds: ['a1', 'a2'],
      endId: 't1',
      latest: true,
    })
  })

  it('close a turn from history that has no end of its own', () => {
    const s = state([user('u1'), agent('a1'), user('u2'), agent('a2')])
    const result = buildItems(s.order, signatureOf(s))
    expect(result.map((i) => i.key)).toEqual(['u1', 'a1', 'reply:u1', 'u2', 'a2', 'reply:u2'])
    expect(result[2]).toMatchObject({ endId: null, latest: false })
  })

  it('wait for the running turn to end', () => {
    expect(keys([user('u1'), agent('a1')], true)).toEqual(['u1', 'a1'])
  })

  it('keep a steered message inside its turn', () => {
    const steered: ThreadEntry = { kind: 'user', id: 's1', content: [], steered: true }
    const s = state([user('u1'), agent('a1'), steered, agent('a2'), end('t1')])
    const result = buildItems(s.order, signatureOf(s))
    expect(result.map((i) => i.key)).toEqual(['u1', 'a1', 's1', 'a2', 'reply:u1'])
    expect(result[2]).toMatchObject({ turnStart: false, scrollAnchor: false })
  })

  it('leave a turn without a message to its end marker', () => {
    expect(keys([user('u1'), tool('x1', 'execute'), end('t1')])).toEqual(['u1', 'x1', 't1'])
  })
})

describe('stepItems', () => {
  it('groups two or more consecutive completed lookups', () => {
    const result = stepItems(['x1', 'r1', 's1', 'r2', 'e1', 'r3'], 'tgggtg')
    expect(result.map((i) => i.key)).toEqual(['x1', 'group:r1', 'e1', 'r3'])
    expect(result[1]).toMatchObject({ type: 'group', ids: ['r1', 's1', 'r2'] })
  })
})
