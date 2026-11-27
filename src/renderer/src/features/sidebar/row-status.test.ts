import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import type { SessionSummary } from '@shared/agent-host'
import { sessionTree } from '@renderer/stores/sessions'
import { backgroundText, hasNamedBackground, joinBackground, rowStatus } from './row-status'

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'antigravity',
    projectPath: '/proj/a',
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

describe('rowStatus and joinBackground for waitingBackground sessions (#2855)', () => {
  it('shows background-only status (BackgroundDots) instead of running TurnDots while waiting_background', () => {
    const waitingNamed = summary('s1', {
      status: 'running',
      phase: 'waiting_background',
      stillRunning: { commands: 1, subagents: 0, reportsBack: true },
    })
    const [nodeNamed] = sessionTree({ s1: waitingNamed }, '/proj/a')
    const statusNamed = rowStatus(nodeNamed!, false)
    expect(statusNamed.running).toBe(false)
    expect(statusNamed.background).toEqual({ commands: 1, subagents: 0 })
    expect(hasNamedBackground(statusNamed.background!)).toBe(true)

    const waitingUnnamed = summary('s2', {
      status: 'running',
      phase: 'waiting_background',
      stillRunning: { commands: 0, subagents: 0, reportsBack: true, unnamed: true },
    })
    const [nodeUnnamed] = sessionTree({ s2: waitingUnnamed }, '/proj/a')
    const statusUnnamed = rowStatus(nodeUnnamed!, false)
    expect(statusUnnamed.running).toBe(false)
    expect(statusUnnamed.background).toEqual({ commands: 0, subagents: 0, unnamed: true })
    expect(hasNamedBackground(statusUnnamed.background!)).toBe(false)

    // Waking back up transitions back to orange running indicator immediately.
    const woken = summary('s2', { status: 'running', phase: 'writing', stillRunning: null })
    const [nodeWoken] = sessionTree({ s2: woken }, '/proj/a')
    const statusWoken = rowStatus(nodeWoken!, false)
    expect(statusWoken.running).toBe(true)
    expect(statusWoken.background).toBeNull()
  })

  it('combines named and unnamed background work when rolling up collapsed parent rows', () => {
    expect(joinBackground([null, undefined])).toBeNull()
    expect(joinBackground([{ commands: 0, subagents: 0, unnamed: true }, null])).toEqual({
      commands: 0,
      subagents: 0,
      unnamed: true,
    })
    expect(
      joinBackground([
        { commands: 0, subagents: 0, unnamed: true },
        { commands: 0, subagents: 2 },
      ]),
    ).toEqual({ commands: 0, subagents: 2 })

    const parent = summary('p', { status: 'ready', stillRunning: null })
    const child = summary('c', {
      parentId: 'p',
      status: 'running',
      phase: 'waiting_background',
      stillRunning: { commands: 0, subagents: 0, reportsBack: true, unnamed: true },
    })
    const [tree] = sessionTree({ p: parent, c: child }, '/proj/a')
    expect(rowStatus(tree!, true)).toMatchObject({
      running: false,
      background: { commands: 0, subagents: 0, unnamed: true },
    })
  })

  it('counts and formats monitors and scheduled jobs as named background work (#2933)', () => {
    const waitingScheduled = summary('s-sched', {
      status: 'running',
      phase: 'waiting_background',
      stillRunning: { commands: 0, subagents: 0, monitors: 1, scheduled: 2, reportsBack: true },
    })
    const [node] = sessionTree({ 's-sched': waitingScheduled }, '/proj/a')
    const status = rowStatus(node!, false)
    expect(status.running).toBe(false)
    expect(status.background).toEqual({ commands: 0, subagents: 0, monitors: 1, scheduled: 2 })
    expect(hasNamedBackground(status.background!)).toBe(true)

    expect(
      joinBackground([
        { commands: 1, subagents: 0, monitors: 1 },
        { commands: 0, subagents: 1, scheduled: 2 },
      ]),
    ).toEqual({ commands: 1, subagents: 1, monitors: 1, scheduled: 2 })

    const fakeT = ((key: string, params?: Record<string, unknown>) => {
      if (key === 'stillRunning.listSeparator') return ', '
      return `${key}(${String(params?.count ?? '')})`
    }) as unknown as TFunction<'sidebar'>
    expect(backgroundText(fakeT, { commands: 0, subagents: 0, monitors: 1, scheduled: 2 })).toBe(
      'stillRunning.monitors(1), stillRunning.scheduled(2)',
    )
  })
})
