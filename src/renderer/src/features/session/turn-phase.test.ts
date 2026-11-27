import { describe, expect, it } from 'vitest'
import { threadFromSnapshot, type ThreadEntry, type ThreadState } from '@shared/thread'
import { turnPhase, writingId } from './turn-phase'

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

  it('keeps writingId in lockstep with turnPhase across trailing cards and transitions', () => {
    const artifact: ThreadEntry = {
      kind: 'artifact',
      id: 'art:1',
      artifactId: 'art_1',
      title: 'Page',
      action: 'create',
      version: 1,
      writes: 1,
      after: 'e:1',
    }
    const started: ThreadEntry = {
      kind: 'session_started',
      id: 'ss:1',
      sessionId: 'child-1',
      after: 'e:1',
    }
    const git: ThreadEntry = {
      kind: 'git',
      id: 'g:1',
      event: 'branch',
      branch: 'main',
      after: 'e:1',
    }
    const memory: ThreadEntry = {
      kind: 'memory',
      id: 'm:1',
      layer: 'project',
      action: 'remember',
      memoryId: 'mem-1',
      title: 'Note',
      status: 'written',
      undo: null,
      draft: null,
      after: 'e:1',
    }
    const subagent: ThreadEntry = {
      kind: 'subagent',
      id: 's:child',
      sessionId: 'child-1',
    }

    for (const trailing of [artifact, started, git, memory]) {
      const state = thread([streamingReply, trailing])
      expect(turnPhase(state).phase).toBe('writing')
      expect(writingId(state)).toBe('e:1')
    }

    const withSubagent = thread([streamingReply, subagent])
    expect(turnPhase(withSubagent).phase).toBe('working')
    expect(writingId(withSubagent)).toBeNull()

    const awaitingPermission = thread([streamingReply], { status: 'awaiting_permission' })
    expect(turnPhase(awaitingPermission).phase).toBe('approval')
    expect(writingId(awaitingPermission)).toBeNull()
  })
})
