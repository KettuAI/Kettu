import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'

vi.mock('@renderer/lib/platform', () => ({
  platform: 'darwin',
  isMac: true,
  isWindows: false,
  isWeb: false,
  isHosted: false,
}))

import {
  boardChildActivity,
  boardChildKeys,
  boardChildren,
  boardSubagents,
  isBoardChild,
} from './board-model'

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'claude-code',
    projectPath: '/proj/a',
    scratch: false,
    title: id,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 100,
    updatedAt: 100,
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

describe('board child selection and activity (#2918)', () => {
  it('includes unarchived user child sessions and sub-agents under the parent', () => {
    const parent = summary('parent')
    const startedChild = summary('child-user', {
      parentId: 'parent',
      origin: 'user',
      status: 'running',
      agentId: 'codex',
    })
    const subagent = summary('child-subagent', {
      parentId: 'parent',
      origin: 'subagent',
      status: 'running',
    })
    const archivedRunning = summary('child-archived', {
      parentId: 'parent',
      origin: 'user',
      status: 'running',
      archivedAt: 500,
    })
    const archivedSubagent = summary('subagent-archived', {
      parentId: 'parent',
      origin: 'subagent',
      status: 'running',
      archivedAt: 500,
    })
    const preparedDraft = summary('child-prepared', {
      parentId: 'parent',
      origin: 'user',
      status: 'starting',
      prepared: { config: [], notices: [], openedAt: 100 },
    })
    const otherParentChild = summary('other-child', {
      parentId: 'other-parent',
      origin: 'user',
      status: 'running',
    })
    const grandchild = summary('grandchild', {
      parentId: 'child-user',
      origin: 'subagent',
      status: 'running',
    })
    const routineChild = summary('routine-child', {
      parentId: 'parent',
      origin: 'routine',
      status: 'running',
    })

    const byId = Object.fromEntries(
      [
        parent,
        startedChild,
        subagent,
        archivedRunning,
        archivedSubagent,
        preparedDraft,
        otherParentChild,
        grandchild,
        routineChild,
      ].map((item) => [item.id, item]),
    )

    expect(isBoardChild(startedChild, 'parent')).toBe(true)
    expect(isBoardChild(subagent, 'parent')).toBe(true)
    expect(isBoardChild(archivedRunning, 'parent')).toBe(false)
    expect(isBoardChild(preparedDraft, 'parent')).toBe(false)
    expect(isBoardChild(routineChild, 'parent')).toBe(false)

    expect(boardChildren(byId, 'parent').map((child) => child.id)).toEqual([
      'child-user',
      'child-subagent',
    ])
    expect(boardChildActivity(byId, 'parent')).toEqual({ running: 2, needs: 0 })
    expect(boardChildKeys(byId, 'parent')).toEqual([
      'agent:child-user:running',
      'agent:child-subagent:running',
    ])
  })

  it('counts waiting user child sessions under needs rather than running', () => {
    const byId: Record<string, SessionSummary> = {
      waiting: summary('waiting', {
        parentId: 'parent',
        origin: 'user',
        status: 'awaiting_permission',
      }),
      starting: summary('starting', {
        parentId: 'parent',
        origin: 'user',
        status: 'starting',
      }),
      done: summary('done', {
        parentId: 'parent',
        origin: 'user',
        status: 'ready',
      }),
    }

    expect(boardChildActivity(byId, 'parent')).toEqual({ running: 1, needs: 1 })
    expect(boardChildKeys(byId, 'parent')).toEqual([
      'agent:waiting:needs',
      'agent:starting:running',
    ])
  })

  it('deduplicates repeated child entries and orders waiting before running and finished', () => {
    const finished = summary('done', {
      parentId: 'parent',
      origin: 'user',
      status: 'ready',
      createdAt: 10,
      updatedAt: 50,
    })
    const running = summary('run', {
      parentId: 'parent',
      origin: 'subagent',
      status: 'running',
      createdAt: 20,
      updatedAt: 20,
    })
    const waiting = summary('wait', {
      parentId: 'parent',
      origin: 'user',
      status: 'awaiting_permission',
      createdAt: 15,
      updatedAt: 30,
    })

    const ordered = boardSubagents([finished, running, running, waiting, finished])
    expect(ordered.map((child) => child.id)).toEqual(['wait', 'run', 'done'])
  })
})
