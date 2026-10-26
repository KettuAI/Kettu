import { describe, expect, it } from 'vitest'
import type { SessionView, ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
import { endedOnRejection, inLatestTurn, turnPhase, turnTokens } from './turn-phase'

function tool(
  id: string,
  toolKind: ToolEntry['toolKind'],
  status: ToolEntry['status'] = 'in_progress',
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
  markdown: 'On it.',
  attachments: [],
  streaming: true,
})
const thought = (id: string, streaming: boolean): ThreadEntry => ({
  kind: 'thought',
  id,
  markdown: 'Hmm',
  streaming,
})
const plan = (id: string): ThreadEntry => ({ kind: 'plan', id, items: [] })

function state(entries: ThreadEntry[], status: SessionView['status'] = 'running'): ThreadState {
  return {
    session: { id: 's1', status } as SessionView,
    order: entries.map((e) => e.id),
    byId: Object.fromEntries(entries.map((e) => [e.id, e])),
  }
}

describe('turnPhase', () => {
  it('is working before the first output and without a thread', () => {
    expect(turnPhase(state([user('u1')]))).toEqual({ phase: 'working', count: 1 })
    expect(turnPhase(undefined)).toEqual({ phase: 'working', count: 1 })
  })

  it('is thinking while a thought streams, and working once it closed', () => {
    expect(turnPhase(state([user('u1'), thought('h1', true)])).phase).toBe('thinking')
    expect(turnPhase(state([user('u1'), thought('h1', false)])).phase).toBe('working')
  })

  it('is writing while a message is the latest output', () => {
    expect(turnPhase(state([user('u1'), agent('a1')])).phase).toBe('writing')
  })

  it("names a running tool call's work, counting those that run at once", () => {
    expect(turnPhase(state([user('u1'), tool('t1', 'execute')]))).toEqual({
      phase: 'execute',
      count: 1,
    })
    expect(turnPhase(state([user('u1'), tool('t1', 'read'), tool('t2', 'read')]))).toEqual({
      phase: 'read',
      count: 2,
    })
    expect(turnPhase(state([user('u1'), tool('t1', 'move', 'pending')])).phase).toBe('edit')
    expect(turnPhase(state([user('u1'), tool('t1', 'search')])).phase).toBe('search')
    expect(turnPhase(state([user('u1'), tool('t1', 'fetch')])).phase).toBe('fetch')
  })

  it('takes the latest tool call still running when others finished after it', () => {
    const entries = [
      user('u1'),
      tool('t1', 'edit'),
      tool('t2', 'execute'),
      tool('t3', 'read', 'completed'),
    ]
    expect(turnPhase(state(entries))).toEqual({ phase: 'execute', count: 1 })
  })

  it('is working between steps, after tool calls that finished', () => {
    const entries = [user('u1'), thought('h1', true), tool('t1', 'read', 'completed')]
    expect(turnPhase(state(entries)).phase).toBe('working')
  })

  it('is working for tool calls it has no words for', () => {
    expect(turnPhase(state([user('u1'), tool('t1', 'think')])).phase).toBe('working')
    expect(turnPhase(state([user('u1'), tool('t1', 'other')])).phase).toBe('working')
  })

  it('looks past plan updates to the output before them', () => {
    expect(turnPhase(state([user('u1'), agent('a1'), plan('p1')])).phase).toBe('writing')
  })

  it('never reaches into the turn before', () => {
    expect(turnPhase(state([user('u1'), agent('a1'), user('u2')])).phase).toBe('working')
  })

  it('is compacting while the context is compacted', () => {
    const compaction: ThreadEntry = {
      kind: 'compaction',
      id: 'c1',
      status: 'in_progress',
      summary: '',
    }
    expect(turnPhase(state([user('u1'), compaction])).phase).toBe('compacting')
    expect(turnPhase(state([user('u1'), { ...compaction, status: 'completed' }])).phase).toBe(
      'working',
    )
  })

  it('waits for your approval while a request is pending', () => {
    const entries = [user('u1'), tool('t1', 'execute', 'pending')]
    expect(turnPhase(state(entries, 'awaiting_permission')).phase).toBe('approval')
  })
})

describe('turnTokens', () => {
  const view = (turnStartUsed: number | null, used: number | null) =>
    ({
      turnStartUsed,
      usage: used === null ? null : { used, size: 200_000, cost: null, tokens: null },
    }) as SessionView

  it('is the context the turn has added since it started', () => {
    expect(turnTokens(view(12_000, 48_600))).toBe(36_600)
  })

  it('is null when the start or the context is not known, or nothing was added', () => {
    expect(turnTokens(view(null, 48_600))).toBeNull()
    expect(turnTokens(view(12_000, null))).toBeNull()
    expect(turnTokens(view(12_000, 12_000))).toBeNull()
    // A compaction during the turn shrinks the context below where it started.
    expect(turnTokens(view(120_000, 30_000))).toBeNull()
    expect(turnTokens(undefined)).toBeNull()
  })
})

describe('inLatestTurn', () => {
  const cut = (id: string): ThreadEntry => ({
    kind: 'notice',
    id,
    severity: 'error',
    title: 'Claude Code exited before finishing this turn',
    cause: 'agent_stopped',
  })
  const steered: ThreadEntry = { kind: 'user', id: 's1', content: [], steered: true }

  it('holds for an entry that no message of yours follows', () => {
    expect(inLatestTurn(state([user('u1'), agent('a1'), cut('n1')]), 'n1')).toBe(true)
  })

  it('holds past a message steered into the turn', () => {
    expect(inLatestTurn(state([user('u1'), cut('n1'), steered, agent('a2')]), 'n1')).toBe(true)
  })

  it('does not hold for a turn an older message of yours started', () => {
    const entries = [user('u1'), cut('n1'), user('u2'), agent('a2'), cut('n2')]
    expect(inLatestTurn(state(entries), 'n1')).toBe(false)
    expect(inLatestTurn(state(entries), 'n2')).toBe(true)
  })

  it('does not hold for an entry the thread does not have', () => {
    expect(inLatestTurn(state([user('u1'), agent('a1')]), 'n1')).toBe(false)
  })
})

describe('endedOnRejection', () => {
  const answered = (id: string, result: ToolEntry['permissionResult']): ToolEntry => ({
    ...tool(id, 'execute', 'failed'),
    permissionResult: result,
  })

  it('holds when the latest tool call was rejected, whatever the agent wrote after it', () => {
    const rejected = answered('t1', { optionId: 'no', kind: 'reject_once' })
    expect(endedOnRejection(state([user('u1'), rejected], 'ready'))).toBe(true)
    expect(endedOnRejection(state([user('u1'), rejected, agent('a1'), plan('p1')], 'ready'))).toBe(
      true,
    )
    const always = answered('t1', { optionId: 'never', kind: 'reject_always', by: 'routine' })
    expect(endedOnRejection(state([user('u1'), always], 'ready'))).toBe(true)
  })

  it('does not hold once you wrote since, or a later tool call ran', () => {
    const rejected = answered('t1', { optionId: 'no', kind: 'reject_once' })
    expect(endedOnRejection(state([rejected, user('u2')], 'ready'))).toBe(false)
    expect(endedOnRejection(state([rejected, tool('t2', 'read', 'completed')], 'ready'))).toBe(
      false,
    )
  })

  it('does not hold for an allowed, stopped or unanswered call, or without a thread', () => {
    const allowed = answered('t1', { optionId: 'yes', kind: 'allow_once' })
    expect(endedOnRejection(state([user('u1'), allowed], 'ready'))).toBe(false)
    expect(endedOnRejection(state([user('u1'), answered('t1', 'cancelled')], 'ready'))).toBe(false)
    expect(endedOnRejection(state([user('u1'), tool('t1', 'execute')]))).toBe(false)
    expect(endedOnRejection(state([user('u1'), agent('a1')], 'ready'))).toBe(false)
    expect(endedOnRejection(undefined)).toBe(false)
  })
})
