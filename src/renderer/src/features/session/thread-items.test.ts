import { describe, expect, it } from 'vitest'
import type { StopReason, ThreadEntry, ThreadState } from '@shared/thread'
import { completedTurnDuration } from './entries/turn-end'
import { buildItems, signatureOf, withoutHidden, type Item } from './thread-items'

function user(id: string, text = 'Hello'): ThreadEntry {
  return { kind: 'user', id, content: [{ type: 'text', text }] }
}

function agent(id: string, markdown = 'Reply'): ThreadEntry {
  return { kind: 'agent', id, markdown, attachments: [], streaming: false, at: 1_000 }
}

function tool(id: string): ThreadEntry {
  return {
    kind: 'tool',
    id,
    title: 'Run command',
    toolKind: 'execute',
    status: 'completed',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
  }
}

function notice(id: string): ThreadEntry {
  return { kind: 'notice', id, severity: 'info', title: 'Info' }
}

function turnEnd(id: string, durationMs: number, stopReason: StopReason = 'end_turn'): ThreadEntry {
  return { kind: 'turn_end', id, stopReason, durationMs }
}

function threadOf(entries: ThreadEntry[]): ThreadState {
  return {
    session: {} as ThreadState['session'],
    order: entries.map((entry) => entry.id),
    byId: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
  }
}

function itemsFor(entries: ThreadEntry[], live = false): Item[] {
  const thread = threadOf(entries)
  const { order, signature } = withoutHidden(thread.order, signatureOf(thread))
  return buildItems(order, signature, live)
}

describe('signatureOf turn_end classification', () => {
  it('distinguishes normal end_turn entries from abnormal stop reasons', () => {
    const thread = threadOf([
      user('u1'),
      agent('a1'),
      turnEnd('e1', 17_000, 'end_turn'),
      turnEnd('e2', 2_000, 'cancelled'),
      turnEnd('e3', 3_000, 'max_tokens'),
      turnEnd('e4', 4_000, 'max_turn_requests'),
      turnEnd('e5', 5_000, 'refusal'),
    ])
    expect(signatureOf(thread)).toBe('uaeEEEE')
  })
})

describe('buildItems deduplication of redundant turn_end entries', () => {
  it('keeps the real reply duration and suppresses stacked empty end_turn rows in historical threads', () => {
    const entries = [
      user('u1'),
      agent('a1', 'Started background task.'),
      turnEnd('e1', 17_000),
      turnEnd('e2', 15),
      turnEnd('e3', 8),
      turnEnd('e4', 12),
    ]
    const thread = threadOf(entries)
    const items = itemsFor(entries)

    expect(items).toEqual([
      { key: 'u1', type: 'entry', id: 'u1', turnStart: true, char: 'u', endId: undefined },
      { key: 'a1', type: 'entry', id: 'a1', turnStart: false, char: 'a', endId: undefined },
      {
        key: 'reply:u1',
        type: 'reply',
        agentIds: ['a1'],
        endId: 'e1',
        latest: true,
        toolIds: [],
      },
    ])

    const reply = items.find((item) => item.type === 'reply')
    expect(reply?.type).toBe('reply')
    const end = reply?.type === 'reply' && reply.endId ? thread.byId[reply.endId] : undefined
    expect(end?.kind).toBe('turn_end')
    expect(completedTurnDuration(end?.kind === 'turn_end' ? end : null)?.label).toBe(
      'Worked for 17s',
    )
  })

  it('keeps separate reply footers when a real follow-up reply comes after stacked empty end_turns', () => {
    const entries = [
      user('u1'),
      tool('t1'),
      agent('a1', 'First reply'),
      turnEnd('e1', 17_000),
      turnEnd('e2', 10),
      turnEnd('e3', 9),
      agent('a2', 'Background agent finished.'),
      turnEnd('e4', 4_000),
    ]
    const items = itemsFor(entries)

    expect(
      items.filter((item) => item.type === 'entry' && (item.char === 'e' || item.char === 'E')),
    ).toEqual([])
    const replies = items.filter((item) => item.type === 'reply')
    expect(replies).toEqual([
      {
        key: 'reply:u1',
        type: 'reply',
        agentIds: ['a1'],
        endId: 'e1',
        latest: false,
        toolIds: ['t1'],
      },
      {
        key: 'reply:a2',
        type: 'reply',
        agentIds: ['a2'],
        endId: 'e4',
        latest: true,
        toolIds: [],
      },
    ])
  })

  it('keeps the settled reply footer clean without mounting thread-level still-running items (#2951)', () => {
    const entries = [
      user('u1'),
      agent('a1', 'Running in background.'),
      turnEnd('e1', 17_000),
      turnEnd('e2', 12),
      turnEnd('e3', 7),
    ]
    const items = itemsFor(entries, false)

    expect(items.at(-1)).toEqual({
      key: 'reply:u1',
      type: 'reply',
      agentIds: ['a1'],
      endId: 'e1',
      latest: true,
      toolIds: [],
    })
  })

  it('suppresses trailing empty end_turns even when non-work entries appear after the real turn_end', () => {
    const entries = [
      user('u1'),
      agent('a1', 'Done.'),
      turnEnd('e1', 17_000),
      notice('n1'),
      turnEnd('e2', 10),
      turnEnd('e3', 5),
    ]
    const items = itemsFor(entries)

    expect(items).toEqual([
      { key: 'u1', type: 'entry', id: 'u1', turnStart: true, char: 'u', endId: undefined },
      { key: 'a1', type: 'entry', id: 'a1', turnStart: false, char: 'a', endId: undefined },
      {
        key: 'reply:u1',
        type: 'reply',
        agentIds: ['a1'],
        endId: 'e1',
        latest: true,
        toolIds: [],
      },
      { key: 'n1', type: 'entry', id: 'n1', turnStart: false, char: 'o', endId: undefined },
    ])
  })

  it('preserves abnormal stop markers after a normal reply turn_end while dropping empty end_turns', () => {
    const entries = [
      user('u1'),
      agent('a1', 'Done.'),
      turnEnd('e1', 17_000, 'end_turn'),
      turnEnd('e2', 10, 'end_turn'),
      turnEnd('e3', 2_000, 'cancelled'),
      turnEnd('e4', 5, 'end_turn'),
    ]
    const items = itemsFor(entries)

    expect(items).toEqual([
      { key: 'u1', type: 'entry', id: 'u1', turnStart: true, char: 'u', endId: undefined },
      { key: 'a1', type: 'entry', id: 'a1', turnStart: false, char: 'a', endId: undefined },
      {
        key: 'reply:u1',
        type: 'reply',
        agentIds: ['a1'],
        endId: 'e1',
        latest: true,
        toolIds: [],
      },
      { key: 'e3', type: 'entry', id: 'e3', turnStart: false, char: 'E', endId: undefined },
    ])
  })

  it('keeps an abnormal stop marker on ReplyFooter when followed by trailing empty end_turns', () => {
    const entries = [
      user('u1'),
      agent('a1', 'Partial reply'),
      turnEnd('e1', 12_000, 'cancelled'),
      turnEnd('e2', 10, 'end_turn'),
      turnEnd('e3', 8, 'end_turn'),
    ]
    const items = itemsFor(entries)

    expect(items).toEqual([
      { key: 'u1', type: 'entry', id: 'u1', turnStart: true, char: 'u', endId: undefined },
      { key: 'a1', type: 'entry', id: 'a1', turnStart: false, char: 'a', endId: undefined },
      {
        key: 'reply:u1',
        type: 'reply',
        agentIds: ['a1'],
        endId: 'e1',
        latest: true,
        toolIds: [],
      },
    ])
  })

  it('deduplicates trailing empty end_turns in turns without an agent reply', () => {
    // User message with no reply followed by stacked end_turn entries.
    expect(
      itemsFor([user('u1'), turnEnd('e1', 5_000), turnEnd('e2', 10), turnEnd('e3', 5)]),
    ).toEqual([{ key: 'u1', type: 'entry', id: 'u1', turnStart: true, char: 'u', endId: 'e1' }])

    // User message cancelled before any reply, followed by an empty end_turn.
    expect(itemsFor([user('u1'), turnEnd('e1', 2_000, 'cancelled'), turnEnd('e2', 10)])).toEqual([
      { key: 'u1', type: 'entry', id: 'u1', turnStart: true, char: 'u', endId: 'e1' },
    ])

    // Tool-only turn followed by stacked empty end_turns and then a cancelled marker.
    expect(
      itemsFor([
        user('u1'),
        tool('t1'),
        turnEnd('e1', 17_000),
        turnEnd('e2', 12),
        turnEnd('e3', 2_000, 'cancelled'),
      ]),
    ).toEqual([
      { key: 'u1', type: 'entry', id: 'u1', turnStart: true, char: 'u', endId: undefined },
      { key: 'run:t1', type: 'run', ids: ['t1'], signature: 't' },
      { key: 'e1', type: 'entry', id: 'e1', turnStart: false, char: 'e', endId: undefined },
      { key: 'e3', type: 'entry', id: 'e3', turnStart: false, char: 'E', endId: undefined },
    ])
  })

  it('renders a stopped reply footer and no live TurnStatus when waitingBackground settles (#2855, #2951)', () => {
    const entries = [
      user('u1', 'Run worker'),
      tool('t1'),
      agent('a1', 'Started.'),
      turnEnd('e1', 12_000),
    ]
    // SessionView passes working=false during waitingBackground; background work lives in the dock.
    const items = itemsFor(entries, false)
    expect(items.some((item) => item.type === 'status')).toBe(false)
    expect(items.at(-1)).toEqual({
      key: 'reply:u1',
      type: 'reply',
      agentIds: ['a1'],
      endId: 'e1',
      latest: true,
      toolIds: ['t1'],
    })
  })

  it('keeps prior turn tool changes above a follow-up sent during waitingBackground even if cancelled (#2845)', () => {
    const entries = [
      user('u1', 'Edit file and run background task'),
      tool('t1'),
      agent('a1', 'Edited file and started background task.'),
      turnEnd('e1', 14_000, 'end_turn'),
      user('u2', 'Follow-up during background wait'),
      turnEnd('e2', 1_500, 'cancelled'),
    ]
    const items = itemsFor(entries, false)
    expect(items).toEqual([
      { key: 'u1', type: 'entry', id: 'u1', turnStart: true, char: 'u', endId: undefined },
      { key: 'run:t1', type: 'run', ids: ['t1'], signature: 't' },
      { key: 'a1', type: 'entry', id: 'a1', turnStart: false, char: 'a', endId: undefined },
      {
        key: 'reply:u1',
        type: 'reply',
        agentIds: ['a1'],
        endId: 'e1',
        latest: false,
        toolIds: ['t1'],
      },
      { key: 'u2', type: 'entry', id: 'u2', turnStart: true, char: 'u', endId: 'e2' },
    ])
  })
})
