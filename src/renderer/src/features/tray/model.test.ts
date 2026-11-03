import { describe, expect, it } from 'vitest'
import type { AgentStatus, PlanLimit, SessionSummary } from '@shared/agent-host'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { elapsed, groupSessions, limitRows, planName, readDetail, stale } from './model'

function session(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'claude-code',
    projectPath: '/p',
    scratch: false,
    title: id,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 0,
    updatedAt: 0,
    parentId: null,
    origin: 'user',
    routine: null,
    description: null,
    missing: false,
    branch: null,
    pr: null,
    cache: null,
    model: null,
    pinnedAt: null,
    archivedAt: null,
    acpSessionId: null,
    ...patch,
  }
}

function tool(id: string, patch: Partial<ToolEntry> = {}): ThreadEntry {
  return {
    kind: 'tool',
    id,
    title: id,
    toolKind: 'edit',
    status: 'completed',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...patch,
  }
}

const user = (id: string): ThreadEntry => ({ kind: 'user', id, content: [] })

describe('groupSessions', () => {
  it('lists what waits, what runs and what finished out of view, the latest first', () => {
    const groups = groupSessions([
      session('waiting', { status: 'awaiting_permission', attention: 'permission', updatedAt: 5 }),
      session('running', { status: 'running', updatedAt: 4 }),
      session('older-run', { status: 'running', updatedAt: 1 }),
      session('unread', { attention: 'unread', updatedAt: 3 }),
      session('failed', { attention: 'error', status: 'failed', updatedAt: 6 }),
      session('seen', { updatedAt: 9 }),
    ])
    expect(groups.needsYou.map((s) => s.id)).toEqual(['waiting'])
    expect(groups.running.map((s) => s.id)).toEqual(['running', 'older-run'])
    expect(groups.finished.map((s) => s.id)).toEqual(['failed', 'unread'])
    expect(groups.recent).toEqual([])
  })

  it('leaves out sub-agents and archived sessions, and keeps three finished', () => {
    const groups = groupSessions([
      session('agent', { origin: 'subagent', status: 'running' }),
      session('archived', { archivedAt: 1, attention: 'unread' }),
      ...['a', 'b', 'c', 'd'].map((id, i) => session(id, { attention: 'unread', updatedAt: i })),
    ])
    expect(groups.running).toEqual([])
    expect(groups.finished.map((s) => s.id)).toEqual(['d', 'c', 'b'])
  })

  it('lists the two latest top-level sessions while nothing goes on', () => {
    const groups = groupSessions([
      session('old', { updatedAt: 1 }),
      session('child', { parentId: 'new', updatedAt: 9 }),
      session('new', { updatedAt: 5 }),
      session('mid', { updatedAt: 3 }),
    ])
    expect(groups.recent.map((s) => s.id)).toEqual(['new', 'mid'])
  })
})

describe('readDetail', () => {
  const permission = { requestId: 'r1', options: [] }

  it('finds the waiting requests, the running step and the files the last turn changed', () => {
    const detail = readDetail(
      [
        tool('old-edit', { locations: [{ path: '/p/old.ts' }] }),
        user('u1'),
        tool('edit', { locations: [{ path: '/p/a.ts' }, { path: '/p/b.ts' }] }),
        tool('diff', {
          content: [{ type: 'diff', path: '/p/a.ts', oldText: null, newText: 'x' }],
        }),
        tool('read', { toolKind: 'read', locations: [{ path: '/p/c.ts' }] }),
        tool('failed-edit', { status: 'failed', locations: [{ path: '/p/d.ts' }] }),
        tool('run', { toolKind: 'execute', status: 'in_progress', rawInput: 'pnpm test' }),
        tool('ask', { toolKind: 'execute', status: 'pending', permission }),
        {
          kind: 'browser_origin',
          id: 'site',
          requestId: 1,
          origin: 'https://example.com',
          decision: null,
          after: null,
        },
        {
          kind: 'browser_origin',
          id: 'answered',
          requestId: 2,
          origin: 'https://other.example',
          decision: 'deny',
          after: null,
        },
      ],
      100,
      { updatedAt: 7, permissionCount: 2 },
    )
    expect(detail).toMatchObject({ readAt: 7, readRequests: 2 })
    expect(detail.turnStartedAt).toBe(100)
    expect(detail.files).toBe(2)
    expect(detail.requests.map((r) => r.entryId)).toEqual(['ask', 'site'])
    expect(detail.requests[1]).toEqual({
      kind: 'origin',
      entryId: 'site',
      origin: 'https://example.com',
    })
    expect(detail.activity?.title).toBe('ask')
  })
})

describe('planName', () => {
  it('drops the word the plan shares with the agent', () => {
    expect(planName('Claude Code', 'Claude Max')).toBe('Max')
    expect(planName('Codex', 'ChatGPT Plus')).toBe('ChatGPT Plus')
    expect(planName('Claude Code', 'Claude')).toBe('Claude')
  })
})

describe('limitRows', () => {
  const limit = (patch: Partial<PlanLimit>): PlanLimit => ({
    window: 'five_hour',
    label: '5-hour',
    usedPercent: 10,
    resetsAt: null,
    state: 'ok',
    observedAt: 0,
    ...patch,
  })
  const agent = (patch: Partial<AgentStatus>): AgentStatus =>
    ({
      id: 'claude-code',
      name: 'Claude Code',
      hidden: false,
      account: null,
      limits: [],
      ...patch,
    }) as AgentStatus

  it('shows each agent on a plan with its fullest window', () => {
    const rows = limitRows(
      [
        agent({
          account: { kind: 'account', label: 'Claude Max', email: null },
          limits: [limit({ usedPercent: 12 }), limit({ window: 'seven_day', usedPercent: 74 })],
        }),
        agent({ id: 'codex', name: 'Codex', limits: [limit({ usedPercent: 4 })] }),
        agent({ id: 'pi', name: 'Pi' }),
        agent({ id: 'gemini', hidden: true, limits: [limit({})] }),
      ],
      0,
    )
    expect(rows.map((r) => [r.agent.id, r.plan, r.limit.usedPercent])).toEqual([
      ['claude-code', 'Max', 74],
      ['codex', null, 4],
    ])
  })

  it('skips an agent that was not added, whose remembered limits never refresh', () => {
    const rows = limitRows(
      [
        agent({ id: 'codex', name: 'Codex', registered: false, limits: [limit({})] }),
        agent({ limits: [limit({})] }),
      ],
      0,
    )
    expect(rows.map((r) => r.agent.id)).toEqual(['claude-code'])
  })

  it('skips an agent whose windows report no use yet', () => {
    const rows = limitRows([agent({ limits: [limit({ usedPercent: null })] })], 0)
    expect(rows).toEqual([])
  })
})

describe('elapsed', () => {
  it('counts whole minutes, at least one, and hours past an hour', () => {
    expect(elapsed(10_000)).toEqual({ h: 0, m: 1 })
    expect(elapsed(4 * 60_000 + 59_000)).toEqual({ h: 0, m: 4 })
    expect(elapsed(65 * 60_000)).toEqual({ h: 1, m: 5 })
  })
})

describe('stale', () => {
  it('reads a thread again once its summary moves on or a request settles', () => {
    const read = readDetail([], null, { updatedAt: 5, permissionCount: 2 })
    expect(stale(session('s', { updatedAt: 5, permissionCount: 2 }), read)).toBe(false)
    expect(stale(session('s', { updatedAt: 6, permissionCount: 2 }), read)).toBe(true)
    expect(stale(session('s', { updatedAt: 5, permissionCount: 1 }), read)).toBe(true)
    expect(stale(session('s'), undefined)).toBe(true)
  })
})
