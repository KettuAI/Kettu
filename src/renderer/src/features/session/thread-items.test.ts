import { describe, expect, it } from 'vitest'
import type { SessionView, ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
import { buildItems, signatureOf, stepItems } from './thread-items'

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
  it('marks users, groupable lookups, thoughts and other tools', () => {
    const s = state([
      user('u1'),
      thought('h1'),
      tool('r1', 'read'),
      tool('e1', 'edit'),
      tool('x1', 'execute'),
      agent('a1'),
    ])
    expect(signatureOf(s)).toBe('uhgtto')
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
    expect(result.map((i) => i.key)).toEqual(['u1', 'run:h1', 'a1'])
    expect(result[1]).toMatchObject({ type: 'run', ids: ['h1', 'x1', 'e1'], signature: 'htt' })
  })

  it('leaves a single step as its own entry', () => {
    const result = items([user('u1'), tool('x1', 'execute'), agent('a1'), thought('h1')])
    expect(result.map((i) => i.type)).toEqual(['entry', 'entry', 'entry', 'entry'])
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
    const result = items([user('u1'), agent('a1'), user('u2')])
    expect(result.map((i) => i.type === 'entry' && i.turnStart)).toEqual([true, false, true])
  })

  it("anchors the scroll to the latest turn's start only", () => {
    const result = items([user('u1'), agent('a1'), user('u2'), agent('a2')])
    expect(result.map((i) => i.type === 'entry' && i.scrollAnchor)).toEqual([
      false,
      false,
      true,
      false,
    ])
  })
})

describe('stepItems', () => {
  it('groups two or more consecutive completed lookups', () => {
    const result = stepItems(['x1', 'r1', 's1', 'r2', 'e1', 'r3'], 'tgggtg')
    expect(result.map((i) => i.key)).toEqual(['x1', 'group:r1', 'e1', 'r3'])
    expect(result[1]).toMatchObject({ type: 'group', ids: ['r1', 's1', 'r2'] })
  })
})
