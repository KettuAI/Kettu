import { describe, expect, it } from 'vitest'
import type { SessionView, ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
import { buildItems, lastSent, replyKeys, signatureOf, stepItems } from './thread-items'

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
const compaction = (id: string): ThreadEntry => ({
  kind: 'compaction',
  id,
  status: 'completed',
  summary: '',
})
const notice = (id: string): ThreadEntry => ({ kind: 'notice', id, severity: 'error', title: id })

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

  it('does not group a lookup that runs, and marks one waiting for permission', () => {
    const waiting: ToolEntry = {
      ...tool('r2', 'read'),
      permission: { requestId: 'p', options: [] },
    }
    expect(signatureOf(state([tool('r1', 'read', 'in_progress'), waiting]))).toBe('tw')
  })

  it('marks plans and compactions as work', () => {
    expect(signatureOf(state([plan('p1'), compaction('c1'), notice('n1')]))).toBe('ppo')
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

  it('folds a lone tool call into a line of its own', () => {
    const result = items([user('u1'), tool('x1', 'execute'), agent('a1'), tool('r1', 'read')])
    expect(result.map((i) => i.key)).toEqual(['u1', 'run:x1', 'a1', 'run:r1', 'reply:u1'])
    expect(result[1]).toMatchObject({ type: 'run', ids: ['x1'], signature: 't' })
  })

  it('leaves a lone thought, plan or permission request as it is', () => {
    const waiting: ToolEntry = {
      ...tool('x2', 'execute', 'in_progress'),
      permission: { requestId: 'p', options: [] },
    }
    const result = items([user('u1'), thought('h1'), agent('a1'), plan('p1'), agent('a2'), waiting])
    expect(result.map((i) => i.type)).toEqual([
      'entry',
      'entry',
      'entry',
      'entry',
      'entry',
      'entry',
      'reply',
    ])
  })

  it('never folds an agent message', () => {
    const result = items([
      user('u1'),
      thought('h1'),
      tool('x1', 'execute'),
      agent('a1'),
      tool('x2', 'execute'),
      tool('x3', 'execute'),
      agent('a2'),
    ])
    expect(result.map((i) => i.key)).toEqual(['u1', 'run:h1', 'a1', 'run:x2', 'a2', 'reply:u1'])
  })

  it('keeps plans and compactions inside a run', () => {
    const result = items([
      tool('x1', 'execute'),
      plan('p1'),
      tool('x2', 'execute'),
      compaction('c1'),
      tool('x3', 'execute'),
    ])
    expect(result.map((i) => i.key)).toEqual(['run:x1'])
    expect(result[0]).toMatchObject({ signature: 'tptpt' })
  })

  it('breaks a run at a notice', () => {
    const result = items([
      tool('x1', 'execute'),
      tool('x2', 'execute'),
      notice('n1'),
      tool('x3', 'execute'),
      tool('x4', 'execute'),
    ])
    expect(result.map((i) => i.key)).toEqual(['run:x1', 'n1', 'run:x3'])
  })

  it('folds the run still growing in a live turn, as it will fold once the turn ends', () => {
    const entries = [user('u1'), tool('x1', 'execute'), tool('x2', 'execute', 'in_progress')]
    const s = state(entries)
    const live = buildItems(s.order, signatureOf(s), true)
    expect(live.map((i) => i.key)).toEqual(['u1', 'run:x1'])
    expect(live[1]).toMatchObject({ type: 'run', ids: ['x1', 'x2'] })
  })

  it('folds a lone call at the end of a live turn', () => {
    const s = state([user('u1'), agent('a1'), tool('x1', 'execute', 'in_progress')])
    expect(buildItems(s.order, signatureOf(s), true).map((i) => i.key)).toEqual([
      'u1',
      'a1',
      'run:x1',
    ])
  })

  it('shows a lone thought or a request for permission at the end of a live turn as it is', () => {
    const streaming: ThreadEntry = { kind: 'thought', id: 'h1', markdown: '', streaming: true }
    const thinking = state([user('u1'), streaming])
    expect(buildItems(thinking.order, signatureOf(thinking), true).map((i) => i.key)).toEqual([
      'u1',
      'h1',
    ])
    const asking: ToolEntry = {
      ...tool('x1', 'execute', 'pending'),
      permission: { options: [] } as unknown as ToolEntry['permission'],
    }
    const waiting = state([user('u1'), asking])
    expect(buildItems(waiting.order, signatureOf(waiting), true).map((i) => i.key)).toEqual([
      'u1',
      'x1',
    ])
  })

  it('folds every run of a live turn, a message between them or not', () => {
    const s = state([
      user('u1'),
      tool('x1', 'execute'),
      tool('x2', 'execute'),
      agent('a1'),
      tool('r1', 'read'),
      tool('s1', 'search'),
      tool('x3', 'execute', 'in_progress'),
    ])
    const result = buildItems(s.order, signatureOf(s), true)
    expect(result.map((i) => i.key)).toEqual(['u1', 'run:x1', 'a1', 'run:r1'])
    expect(result[3]).toMatchObject({ signature: 'ggt' })
  })

  it('marks user entries as turn starts', () => {
    const result = items([user('u1'), agent('a1'), user('u2')]).filter((i) => i.type === 'entry')
    expect(result.map((i) => i.turnStart)).toEqual([true, false, true])
  })
})

describe('lastSent', () => {
  it('names the latest message you sent, steered ones included', () => {
    const steered: ThreadEntry = { kind: 'user', id: 's1', content: [], steered: true }
    const s = state([user('u1'), agent('a1'), steered, tool('x1', 'execute')])
    expect(lastSent(s.order, signatureOf(s))).toBe('s1')
    const plain = state([user('u1'), agent('a1')])
    expect(lastSent(plain.order, signatureOf(plain))).toBe('u1')
    expect(lastSent([], '')).toBeNull()
  })
})

describe('progress notes', () => {
  // As Codex's commentary: a message that more work in the same turn follows.
  const notes = (entries: ThreadEntry[], live = false) => {
    const s = state(entries)
    return buildItems(s.order, signatureOf(s), live, true)
  }

  it('fold with the work, and the answer stays', () => {
    const result = notes([
      user('u1'),
      thought('h1'),
      agent('a1'),
      tool('x1', 'execute'),
      thought('h2'),
      agent('a2'),
      tool('x2', 'execute'),
      agent('a3'),
    ])
    expect(result.map((i) => i.key)).toEqual(['u1', 'run:h1', 'a3', 'reply:u1'])
    expect(result[1]).toMatchObject({ signature: 'hcthct' })
    expect(result[3]).toMatchObject({ agentIds: ['a3'] })
  })

  it('leave every message as it is for other agents', () => {
    const result = items([user('u1'), agent('a1'), tool('x1', 'execute'), agent('a2')])
    expect(result.map((i) => i.key)).toEqual(['u1', 'a1', 'run:x1', 'a2', 'reply:u1'])
  })

  it('keep a turn without work as its answer', () => {
    expect(notes([user('u1'), agent('a1')]).map((i) => i.key)).toEqual(['u1', 'a1', 'reply:u1'])
  })

  it('end with their turn', () => {
    const result = notes([
      user('u1'),
      agent('a1'),
      tool('x1', 'execute'),
      agent('a2'),
      user('u2'),
      agent('a3'),
    ])
    expect(result.map((i) => i.key)).toEqual([
      'u1',
      'run:a1',
      'a2',
      'reply:u1',
      'u2',
      'a3',
      'reply:u2',
    ])
  })

  it('fold into the running turn as soon as more work follows them', () => {
    const result = notes(
      [
        user('u1'),
        tool('x1', 'execute'),
        tool('x2', 'execute'),
        agent('a1'),
        tool('x3', 'execute'),
        agent('a2'),
      ],
      true,
    )
    expect(result.map((i) => i.key)).toEqual(['u1', 'run:x1', 'a2'])
    expect(result[1]).toMatchObject({ signature: 'ttct' })
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
    expect(result.map((i) => i.key)).toEqual(['u1', 'a1', 'run:x1', 'a2', 'reply:u1'])
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
    expect(result[2]).toMatchObject({ turnStart: false })
  })

  it('leave a turn without a message to its end marker', () => {
    expect(keys([user('u1'), tool('x1', 'execute'), end('t1')])).toEqual(['u1', 'run:x1', 't1'])
  })
})

describe('replyKeys', () => {
  it("gives each item after a user message its turn's footer", () => {
    const result = items([
      user('u1'),
      tool('x1', 'execute'),
      agent('a1'),
      user('u2'),
      agent('a2'),
      tool('x2', 'execute'),
    ])
    expect(result.map((i) => i.key)).toEqual([
      'u1',
      'run:x1',
      'a1',
      'reply:u1',
      'u2',
      'a2',
      'run:x2',
      'reply:u2',
    ])
    expect(replyKeys(result)).toEqual([
      null,
      'reply:u1',
      'reply:u1',
      'reply:u1',
      null,
      'reply:u2',
      'reply:u2',
      'reply:u2',
    ])
  })

  it('leaves a turn without a footer out', () => {
    const s = state([user('u1'), agent('a1'), user('u2'), agent('a2')])
    const result = buildItems(s.order, signatureOf(s), true)
    expect(replyKeys(result)).toEqual([null, 'reply:u1', 'reply:u1', null, null])
  })
})

describe('stepItems', () => {
  it('groups two or more consecutive completed lookups', () => {
    const result = stepItems(['x1', 'r1', 's1', 'r2', 'e1', 'r3'], 'tgggtg')
    expect(result.map((i) => i.key)).toEqual(['x1', 'group:r1', 'e1', 'r3'])
    expect(result[1]).toMatchObject({ type: 'group', ids: ['r1', 's1', 'r2'] })
  })
})
