import { describe, expect, it } from 'vitest'
import { attentionNotice, attentionTarget, pushedAttention } from './attention'
import type { HostAttention } from './remote/host-admin'

const limit = (over: Record<string, unknown> = {}): HostAttention =>
  ({
    kind: 'plan-limit',
    agentId: 'claude-code',
    level: 'near',
    key: 'claude-code:me@example.com:five_hour',
    usedPercent: 92,
    title: '5-hour limit 92% used',
    body: 'Claude Max',
    ...over,
  }) as HostAttention

describe('attentionTarget for a plan limit', () => {
  it('opens Usage, or the session the used-up window stopped, replacing its notice', () => {
    expect(attentionTarget(limit())).toEqual({
      key: 'limit:claude-code:me@example.com:five_hour',
      command: { kind: 'open-usage' },
    })
    expect(attentionTarget(limit({ level: 'reached', sessionId: 's1' }))).toEqual({
      key: 's1',
      command: { kind: 'open-session', sessionId: 's1' },
    })
  })

  it('refuses one another host sent malformed', () => {
    expect(attentionTarget(limit({ level: 'soon' }))).toBeNull()
    expect(attentionTarget(limit({ key: '' }))).toBeNull()
    expect(attentionTarget(limit({ agentId: 7 }))).toBeNull()
    expect(attentionTarget(limit({ sessionId: '' }))).toBeNull()
    expect(attentionTarget(limit({ title: null }))).toBeNull()
  })
})

describe('pushedAttention for a plan limit', () => {
  it('pushes none to devices, which take only sessions, routines and tasks', () => {
    const message = { type: 'host:attention', ...limit() } as Parameters<typeof pushedAttention>[0]
    expect(pushedAttention(message)).toBeNull()
  })
})

describe('attentionNotice', () => {
  const turn = (over: Record<string, unknown> = {}): HostAttention =>
    ({
      kind: 'turn-ended',
      sessionId: 's1',
      title: 'Fix the flaky test · done',
      body: 'All four steps are done.',
      ...over,
    }) as HostAttention

  it("shows a session's turn, titled as another host names it", () => {
    expect(attentionNotice(turn())).toEqual({
      sessionId: 's1',
      kind: 'turn-ended',
      title: 'Fix the flaky test · done',
      body: 'All four steps are done.',
    })
    expect(attentionNotice(turn({ kind: 'error' }), 'Studio · Fix the flaky test')).toMatchObject({
      kind: 'error',
      title: 'Studio · Fix the flaky test',
    })
  })

  it('leaves out what is not a session, and one another host sent malformed', () => {
    expect(attentionNotice(limit({ sessionId: 's1' }))).toBeNull()
    expect(
      attentionNotice({ kind: 'task-ended', taskId: 't1', title: 'Task', body: 'Done' }),
    ).toBeNull()
    expect(attentionNotice(turn({ sessionId: '' }))).toBeNull()
    expect(attentionNotice(turn({ body: 7 }))).toBeNull()
  })
})
