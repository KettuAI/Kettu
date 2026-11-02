import { describe, expect, it } from 'vitest'
import type { AgentStatus, PlanLimit, SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { agentGroups, agentLine, pickupSessions, pickupState } from './picker'

const NOW = new Date(2026, 10, 2, 9, 0).getTime()

const ready = (overrides: Partial<AgentStatus>): AgentStatus =>
  ({
    id: 'codex',
    name: 'Codex',
    harnessId: 'codex',
    harnessName: 'Codex',
    isDefault: true,
    hidden: false,
    apiKey: null,
    state: 'ready',
    signIn: 'signed-in',
    account: null,
    limits: [],
    detail: null,
    package: null,
    cli: null,
    ...overrides,
  }) as AgentStatus

const limit = (overrides: Partial<PlanLimit>): PlanLimit => ({
  window: 'five_hour',
  label: '5-hour',
  usedPercent: 42,
  resetsAt: NOW + 3_600_000,
  state: 'ok',
  observedAt: NOW,
  ...overrides,
})

describe('agentGroups', () => {
  it('gives a harness with two agents a group, and puts single agents together last', () => {
    const groups = agentGroups([
      ready({
        id: 'claude-code',
        name: 'Claude Code',
        harnessId: 'claude-code',
        harnessName: 'Claude Code',
      }),
      ready({ id: 'grok', name: 'Grok', harnessId: 'grok', harnessName: 'Grok Build' }),
      ready({
        id: 'claude-work' as AgentId,
        name: 'Work',
        harnessId: 'claude-code',
        harnessName: 'Claude Code',
      }),
    ])
    expect(groups.map((g) => [g.harness, g.agents.map((a) => a.id)])).toEqual([
      ['Claude Code', ['claude-code', 'claude-work']],
      [null, ['grok']],
    ])
  })

  it('makes one group of single agents when no harness has two', () => {
    const groups = agentGroups([ready({ id: 'codex' }), ready({ id: 'pi', harnessId: 'pi' })])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.harness).toBeNull()
  })
})

describe('agentLine', () => {
  it('names the account and the fullest limit', () => {
    const status = ready({
      account: { kind: 'account', label: 'Claude Max', email: null },
      limits: [limit({}), limit({ window: 'seven_day', label: 'Weekly', usedPercent: 18 })],
    })
    expect(agentLine(status, NOW)).toEqual({
      text: 'Claude Max · 42% of 5-hour limit',
      tone: 'muted',
    })
  })

  it('names the harness of an agent of another name', () => {
    const status = ready({
      id: 'deepseek' as AgentId,
      name: 'DeepSeek',
      harnessId: 'opencode',
      harnessName: 'opencode',
    })
    expect(agentLine(status, NOW)?.text).toBe('opencode')
  })

  it('says a reached limit, and nothing for an agent with nothing to say', () => {
    const status = ready({ limits: [limit({ usedPercent: null, state: 'reached' })] })
    expect(agentLine(status, NOW)?.text).toBe('5-hour limit reached')
    expect(agentLine(ready({}), NOW)).toBeNull()
  })
})

const session = (overrides: Partial<SessionSummary>): SessionSummary =>
  ({
    id: 's1',
    agentId: 'codex',
    projectPath: '/work/kettu',
    scratch: false,
    title: 'A session',
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 0,
    updatedAt: 0,
    parentId: null,
    origin: 'user',
    archivedAt: null,
    ...overrides,
  }) as SessionSummary

describe('pickupSessions', () => {
  it("lists the user's top-level sessions outside the archive, the latest first", () => {
    const byId = Object.fromEntries(
      [
        session({ id: 'old', updatedAt: 1 }),
        session({ id: 'new', updatedAt: 5 }),
        session({ id: 'child', updatedAt: 9, parentId: 'new' }),
        session({ id: 'routine', updatedAt: 9, origin: 'routine' }),
        session({ id: 'archived', updatedAt: 9, archivedAt: 9 }),
        session({ id: 'mid', updatedAt: 3 }),
        session({ id: 'oldest', updatedAt: 0 }),
      ].map((s) => [s.id, s]),
    )
    expect(pickupSessions(byId).map((s) => s.id)).toEqual(['new', 'mid', 'old'])
  })
})

describe('pickupState', () => {
  it('puts a waiting approval first, then a turn at work', () => {
    expect(pickupState(session({ status: 'awaiting_permission' }))).toBe('waiting')
    expect(pickupState(session({ status: 'running', permissionCount: 1 }))).toBe('waiting')
    expect(pickupState(session({ status: 'running' }))).toBe('working')
    expect(pickupState(session({ status: 'failed' }))).toBe('failed')
    expect(pickupState(session({ status: 'auth_required' }))).toBe('signIn')
    expect(pickupState(session({ status: 'ready' }))).toBe('finished')
  })
})
