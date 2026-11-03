import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionNode } from '@renderer/stores/sessions'
import { rowStatus } from './row-status'

const node = (
  extra: Partial<SessionSummary>,
  children: SessionNode[] = [],
  own = { permissionCount: 0, running: false },
): SessionNode => ({
  summary: { attention: 'none', status: 'ready', ...extra } as SessionSummary,
  children,
  subagents: [],
  permissionCount: own.permissionCount + children.reduce((n, c) => n + c.permissionCount, 0),
  running: own.running || children.some((c) => c.running),
  own,
})

describe('rowStatus', () => {
  const waiting = node({}, [], { permissionCount: 2, running: true })
  const unread = node({ attention: 'unread' })
  const parent = node({}, [unread, waiting])

  it('shows its own status while its sub-sessions show as rows', () => {
    expect(rowStatus(parent, false)).toEqual({
      waiting: 0,
      failed: false,
      running: false,
      starting: false,
      unread: false,
    })
  })

  it('rolls the loudest child status up into a collapsed parent', () => {
    expect(rowStatus(parent, true)).toMatchObject({ waiting: 2, running: true, unread: true })
    expect(rowStatus(node({}, [unread]), true)).toMatchObject({ waiting: 0, unread: true })
  })

  it('counts a failed run as its own', () => {
    expect(rowStatus(node({ status: 'failed' }), false).failed).toBe(true)
    expect(rowStatus(node({}, [node({ attention: 'error' })]), true).failed).toBe(true)
  })
})
