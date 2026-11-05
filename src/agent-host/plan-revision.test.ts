import { describe, expect, it } from 'vitest'
import { threadFromSnapshot, type ThreadEntry, type ToolEntry } from '@shared/thread'
import { planRevision } from './plan-revision'

function plan(
  id: string,
  markdown: string,
  result: ToolEntry['permissionResult'],
  planVersion = 1,
): ThreadEntry {
  return {
    kind: 'tool',
    id,
    title: 'Plan',
    toolKind: 'switch_mode',
    status: 'completed',
    content: [{ type: 'markdown', markdown }],
    locations: [],
    permission: null,
    permissionResult: result,
    planVersion,
  }
}

function thread(entries: ThreadEntry[]) {
  return threadFromSnapshot({
    session: {} as never,
    entries,
    seq: 0,
  })
}

const kept = { optionId: 'reject', kind: 'reject_once' as const, note: 'Shorter' }
const approved = { optionId: 'exit-plan-default', kind: 'allow_once' as const }

describe('planRevision', () => {
  it('counts the plans since the last approved one, and revises one sent back', () => {
    const entries = [
      plan('a', 'Old', approved),
      plan('b', 'First', kept),
      plan('c', 'Second', null),
    ]
    expect(planRevision(thread(entries), 'c')).toEqual({ version: 2, previous: 'First' })
    expect(planRevision(thread(entries), 'new')).toEqual({ version: 3, previous: null })
    expect(planRevision(thread([plan('a', 'Old', approved)]), 'new')).toEqual({
      version: 1,
      previous: null,
    })
  })

  it('revises nothing when the plan before was stopped rather than sent back', () => {
    expect(planRevision(thread([plan('a', 'First', 'cancelled')]), 'new')).toEqual({
      version: 2,
      previous: null,
    })
  })
})
