import { describe, expect, it } from 'vitest'
import { isActivelyRunning, isWaitingBackground, type SessionSummary } from './agent-host'
import { groupSessions } from './session-groups'
import { threadFromSnapshot, type ThreadEntry, type ThreadState } from './thread'
import { turnPhase } from './turn-phase'

function thread(
  entries: ThreadEntry[],
  sessionOverrides: Partial<ThreadState['session']> = {},
): ThreadState {
  return threadFromSnapshot({
    session: {
      id: 's-1',
      agentId: 'antigravity',
      projectPath: '/repo',
      acpSessionId: 'acp-1',
      status: 'running',
      title: null,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: 1_000,
      turnStartUsed: null,
      createdAt: 0,
      updatedAt: 0,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
      ...sessionOverrides,
    },
    entries,
    seq: 1,
  })
}

describe('turnPhase while waiting on background work', () => {
  const streamingReply: ThreadEntry = {
    kind: 'agent',
    id: 'e:1',
    markdown: 'Started a background task.',
    attachments: [],
    streaming: true,
  }

  const settledReply: ThreadEntry = {
    ...streamingReply,
    streaming: false,
  }

  it('reports writing while an agent message streams normally', () => {
    const state = thread([streamingReply])
    expect(turnPhase(state)).toEqual({ phase: 'writing', count: 1 })
  })

  it('reports waiting_background once waitingBackground is set', () => {
    const state = thread([settledReply], { waitingBackground: true })
    expect(turnPhase(state)).toEqual({ phase: 'waiting_background', count: 1 })

    // Even before a streaming flag clears, waitingBackground suppresses the writing phase.
    const defensive = thread([streamingReply], { waitingBackground: true })
    expect(turnPhase(defensive)).toEqual({ phase: 'waiting_background', count: 1 })
  })

  it('still prioritizes awaiting_permission over waitingBackground', () => {
    const askingTool: ThreadEntry = {
      kind: 'tool',
      id: 't:ask-1',
      title: 'Run command',
      toolKind: 'execute',
      status: 'pending',
      content: [],
      locations: [],
      permission: {
        requestId: 'req-1',
        options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }],
        risky: false,
      },
      permissionResult: null,
    }
    const state = thread([settledReply, askingTool], {
      status: 'awaiting_permission',
      waitingBackground: true,
    })
    expect(turnPhase(state)).toEqual({ phase: 'approval', count: 1 })
  })
})

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'antigravity',
    projectPath: '/repo',
    scratch: false,
    title: id,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1,
    updatedAt: 1,
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
    ...overrides,
  }
}

describe('isWaitingBackground and isActivelyRunning', () => {
  it('distinguishes idle background wait from active running turns', () => {
    expect(isWaitingBackground({ status: 'running', phase: 'waiting_background' })).toBe(true)
    expect(isActivelyRunning({ status: 'running', phase: 'waiting_background' })).toBe(false)

    expect(isWaitingBackground({ status: 'running', phase: 'writing' })).toBe(false)
    expect(isActivelyRunning({ status: 'running', phase: 'writing' })).toBe(true)

    expect(isWaitingBackground({ status: 'running', phase: null })).toBe(false)
    expect(isActivelyRunning({ status: 'running', phase: null })).toBe(true)

    expect(isActivelyRunning({ status: 'awaiting_permission', phase: null })).toBe(true)
    expect(isActivelyRunning({ status: 'ready', phase: null })).toBe(false)
    expect(isActivelyRunning({ status: 'closed', phase: null })).toBe(false)
  })

  it('excludes waiting_background sessions from groupSessions.running until they wake up', () => {
    const waitingBg = summary('s-wait', {
      status: 'running',
      phase: 'waiting_background',
      stillRunning: { commands: 0, subagents: 1, reportsBack: true },
      updatedAt: 100,
    })
    const active = summary('s-run', { status: 'running', phase: 'writing', updatedAt: 90 })
    const groups = groupSessions([waitingBg, active])
    expect(groups.running.map((s) => s.id)).toEqual(['s-run'])

    // Once background work wakes the session up, it returns to the running group immediately.
    const woken = { ...waitingBg, phase: 'writing' as const, stillRunning: null }
    expect(groupSessions([woken, active]).running.map((s) => s.id)).toEqual(['s-wait', 's-run'])
  })
})
