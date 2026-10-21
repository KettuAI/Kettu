import { describe, expect, it } from 'vitest'
import type { SessionView, ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
import { buildItems, signatureOf } from './thread-items'

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

describe('signatureOf', () => {
  it('marks users, groupable lookups, edits and other tools', () => {
    const s = state([
      user('u1'),
      tool('r1', 'read'),
      tool('e1', 'edit'),
      tool('x1', 'execute'),
      agent('a1'),
    ])
    expect(signatureOf(s)).toBe('ugeto')
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
  it('groups two or more consecutive completed lookups', () => {
    const result = items([
      user('u1'),
      tool('r1', 'read'),
      tool('s1', 'search'),
      tool('f1', 'fetch'),
      agent('a1'),
    ])
    expect(result.map((i) => i.key)).toEqual(['u1', 'group:r1', 'a1'])
    expect(result[1]).toMatchObject({ type: 'group', ids: ['r1', 's1', 'f1'] })
  })

  it('leaves a single lookup as its own card', () => {
    const result = items([tool('r1', 'read'), agent('a1'), tool('r2', 'read')])
    expect(result.map((i) => i.type)).toEqual(['entry', 'entry', 'entry'])
  })

  it('never groups across other entries', () => {
    const result = items([
      tool('r1', 'read'),
      tool('r2', 'read'),
      tool('x1', 'execute'),
      tool('r3', 'read'),
      tool('r4', 'read'),
    ])
    expect(result.map((i) => i.key)).toEqual(['group:r1', 'x1', 'group:r3'])
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

  it("keeps only the latest turn's last edit open", () => {
    const result = items([
      user('u1'),
      tool('e1', 'edit'),
      user('u2'),
      tool('e2', 'edit'),
      tool('e3', 'edit'),
      agent('a1'),
    ])
    const open = result.filter((i) => i.type === 'entry' && i.keepOpen).map((i) => i.key)
    expect(open).toEqual(['e3'])
  })

  it('closes the last edit once a new turn starts', () => {
    const result = items([user('u1'), tool('e1', 'edit'), user('u2')])
    expect(result.some((i) => i.type === 'entry' && i.keepOpen)).toBe(false)
  })
})
