import { describe, expect, it } from 'vitest'
import { attentionTarget } from './attention'
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
