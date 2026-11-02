import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { listedSubagents } from './subagents'

const agent = (id: string, status: SessionSummary['status'], createdAt: number, updatedAt = 0) =>
  ({ id, status, createdAt, updatedAt }) as SessionSummary

describe('listedSubagents', () => {
  const all = [
    agent('old-done', 'ready', 1, 10),
    agent('first', 'running', 2),
    agent('waiting', 'awaiting_permission', 3),
    agent('new-done', 'ready', 4, 20),
  ]

  it('lists only the running ones, the latest first, unless finished ones are wanted', () => {
    expect(listedSubagents(all, false).map((s) => s.id)).toEqual(['waiting', 'first'])
  })

  it('adds the finished ones after them, the latest finished first', () => {
    expect(listedSubagents(all, true).map((s) => s.id)).toEqual([
      'waiting',
      'first',
      'new-done',
      'old-done',
    ])
  })
})
