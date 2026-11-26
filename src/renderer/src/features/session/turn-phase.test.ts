import { describe, expect, it } from 'vitest'
import { threadFromSnapshot, type ThreadEntry, type ThreadState } from '@shared/thread'
import { writingId } from './turn-phase'

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

describe('writingId while waiting on background work', () => {
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

  it('returns the streaming entry id during active writing', () => {
    expect(writingId(thread([streamingReply]))).toBe('e:1')
  })

  it('returns null when waitingBackground is active', () => {
    expect(writingId(thread([settledReply], { waitingBackground: true }))).toBeNull()
    expect(writingId(thread([streamingReply], { waitingBackground: true }))).toBeNull()
  })
})
