import { describe, expect, it } from 'vitest'
import { isActivelyRunning, isWaitingBackground, type SessionSummary } from './agent-host'
import { groupSessions } from './session-groups'
import { threadFromSnapshot, type ThreadEntry, type ThreadState } from './thread'
import { turnPhase, writingEntryId } from './turn-phase'

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

describe('turnPhase and writingEntryId boundary parity', () => {
  const streamingReply: ThreadEntry = {
    kind: 'agent',
    id: 'a:1',
    markdown: 'Drafting response...',
    attachments: [],
    streaming: true,
  }

  const settledReply: ThreadEntry = {
    ...streamingReply,
    streaming: false,
  }

  const quietEntries: { label: string; entry: ThreadEntry }[] = [
    {
      label: 'plan',
      entry: {
        kind: 'plan',
        id: 'p:1',
        items: [{ content: 'Step 1', priority: 'medium', status: 'in_progress' }],
      },
    },
    {
      label: 'notice',
      entry: { kind: 'notice', id: 'n:1', severity: 'info', title: 'Heads up' },
    },
    {
      label: 'artifact',
      entry: {
        kind: 'artifact',
        id: 'art:1',
        artifactId: 'art_1',
        title: 'Design doc',
        action: 'create',
        version: 1,
        writes: 1,
        after: 'a:1',
      },
    },
    {
      label: 'session_started',
      entry: { kind: 'session_started', id: 'ss:1', sessionId: 'child-1', after: 'a:1' },
    },
    {
      label: 'git',
      entry: { kind: 'git', id: 'g:1', event: 'branch', branch: 'feat/demo', after: 'a:1' },
    },
    {
      label: 'memory',
      entry: {
        kind: 'memory',
        id: 'm:1',
        layer: 'project',
        action: 'remember',
        memoryId: 'mem-1',
        title: 'Remember convention',
        status: 'written',
        undo: null,
        draft: null,
        after: 'a:1',
      },
    },
    {
      label: 'control_note',
      entry: {
        kind: 'control_note',
        id: 'cn:1',
        surface: 'browser',
        event: 'handed_back',
        durationMs: 1_500,
        after: 'a:1',
      },
    },
    {
      label: 'resolved control_ask',
      entry: {
        kind: 'control_ask',
        id: 'ca:done',
        surface: 'browser',
        step: 'sign_in',
        target: 'Tab 1',
        reason: 'Sign in required',
        outcome: 'done',
        after: 'a:1',
      },
    },
    {
      label: 'task_delivery',
      entry: {
        kind: 'task_delivery',
        id: 'td:1',
        taskId: 'task-1',
        title: 'Done',
        status: 'done',
        steps: 1,
        durationMs: 2_000,
        deliverables: [],
        written: null,
        after: 'a:1',
      },
    },
    {
      label: 'plugin_denial',
      entry: {
        kind: 'plugin_denial',
        id: 'pd:1',
        pluginId: 'plug-1',
        plugin: 'Plugin',
        request: 'Write file',
        reason: 'Denied',
        after: 'a:1',
      },
    },
  ]

  it('keeps writing phase and writingEntryId aligned when quiet/card entries follow a streaming reply', () => {
    for (const { label, entry } of quietEntries) {
      const state = thread([streamingReply, entry])
      expect(turnPhase(state), label).toEqual({ phase: 'writing', count: 1 })
      expect(writingEntryId(state), label).toBe('a:1')
    }
  })

  it('switches both turnPhase and writingEntryId out of writing when a subagent card follows', () => {
    const subagent: ThreadEntry = { kind: 'subagent', id: 's:child', sessionId: 'child-1' }
    const state = thread([streamingReply, subagent])
    expect(turnPhase(state)).toEqual({ phase: 'working', count: 1 })
    expect(writingEntryId(state)).toBeNull()

    const withArtifactAfterSubagent = thread([streamingReply, subagent, quietEntries[2]!.entry])
    expect(turnPhase(withArtifactAfterSubagent)).toEqual({ phase: 'working', count: 1 })
    expect(writingEntryId(withArtifactAfterSubagent)).toBeNull()
  })

  it('switches both turnPhase and writingEntryId out of writing for a pending control_ask', () => {
    const pendingAsk: ThreadEntry = {
      kind: 'control_ask',
      id: 'ca:pending',
      surface: 'browser',
      step: 'sign_in',
      target: 'Tab 1',
      reason: 'Please sign in',
      outcome: null,
      after: 'a:1',
    }
    const state = thread([streamingReply, pendingAsk])
    expect(turnPhase(state)).toEqual({ phase: 'working', count: 1 })
    expect(writingEntryId(state)).toBeNull()
  })

  it('keeps tool, thinking, compacting, settled, and non-running transitions aligned', () => {
    const completedArtifactTool: ThreadEntry = {
      kind: 'tool',
      id: 't:art',
      title: 'mcp__kettu__create_artifact',
      toolKind: 'edit',
      status: 'completed',
      content: [],
      locations: [],
      permission: null,
      permissionResult: null,
    }
    const afterArtifactWrite = thread([
      streamingReply,
      completedArtifactTool,
      quietEntries[2]!.entry,
    ])
    expect(turnPhase(afterArtifactWrite)).toEqual({ phase: 'working', count: 1 })
    expect(writingEntryId(afterArtifactWrite)).toBeNull()

    const runningReadTool: ThreadEntry = {
      kind: 'tool',
      id: 't:read',
      title: 'Read file',
      toolKind: 'read',
      status: 'in_progress',
      content: [],
      locations: [],
      permission: null,
      permissionResult: null,
    }
    const readingAfterSubagent = thread([
      streamingReply,
      { kind: 'subagent', id: 's:child', sessionId: 'child-1' },
      runningReadTool,
    ])
    expect(turnPhase(readingAfterSubagent)).toEqual({ phase: 'read', count: 1 })
    expect(writingEntryId(readingAfterSubagent)).toBeNull()

    const runningToolBeforeSessionStarted = thread([
      streamingReply,
      runningReadTool,
      quietEntries[3]!.entry,
    ])
    expect(turnPhase(runningToolBeforeSessionStarted)).toEqual({ phase: 'read', count: 1 })
    expect(writingEntryId(runningToolBeforeSessionStarted)).toBeNull()

    const thinking = thread([
      streamingReply,
      { kind: 'thought', id: 'th:1', markdown: 'Considering...', streaming: true },
    ])
    expect(turnPhase(thinking)).toEqual({ phase: 'thinking', count: 1 })
    expect(writingEntryId(thinking)).toBeNull()

    const compacting = thread([
      streamingReply,
      { kind: 'compaction', id: 'c:1', status: 'in_progress', summary: '' },
    ])
    expect(turnPhase(compacting)).toEqual({ phase: 'compacting', count: 1 })
    expect(writingEntryId(compacting)).toBeNull()

    const settled = thread([settledReply])
    expect(turnPhase(settled)).toEqual({ phase: 'working', count: 1 })
    expect(writingEntryId(settled)).toBeNull()

    // A non-running session never reports an active writing entry even if a stale flag remains.
    expect(writingEntryId(thread([streamingReply], { status: 'ready' }))).toBeNull()
    expect(writingEntryId(thread([streamingReply], { status: 'awaiting_permission' }))).toBeNull()
  })
})
