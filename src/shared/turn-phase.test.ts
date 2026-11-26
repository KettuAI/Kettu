import { describe, expect, it } from 'vitest'
import { threadFromSnapshot, type ThreadEntry, type ThreadState } from '@shared/thread'
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
