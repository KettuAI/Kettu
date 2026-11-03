import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionSnapshot, SessionView, ThreadEntry, ToolEntry } from '@shared/thread'

const request = vi.fn()
vi.stubGlobal('window', { kettu: { agents: { request } } })

const { digestOf, progressOf, readSubagent, subagentRunning } = await import('./progress')

const tool = (id: string, extra: Partial<ToolEntry> = {}): ThreadEntry => ({
  kind: 'tool',
  id,
  title: `Read ${id}`,
  toolKind: 'read',
  status: 'completed',
  content: [{ type: 'markdown', markdown: 'a long file' }],
  locations: [{ path: `/repo/${id}.ts` }, { path: '/repo/other.ts' }],
  permission: null,
  permissionResult: null,
  ...extra,
})
const end = (id: string, durationMs: number): ThreadEntry => ({
  kind: 'turn_end',
  id,
  stopReason: 'end_turn',
  durationMs,
})
const user: ThreadEntry = { kind: 'user', id: 'u', content: [] }

const child = (extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: 'c', status: 'ready', createdAt: 1_000, updatedAt: 5_000, ...extra }) as SessionSummary

describe('digestOf', () => {
  it('counts the tool calls of a complete thread and keeps what a step shows', () => {
    const digest = digestOf(
      [
        user,
        tool('a'),
        tool('b', { permission: { requestId: 'r', options: [] } }),
        end('e', 41_000),
      ],
      true,
      true,
    )
    expect(digest.tools).toBe(2)
    expect(digest.steps.map((s) => [s.id, s.waiting])).toEqual([
      ['a', false],
      ['b', true],
    ])
    expect(digest.steps[0]).not.toHaveProperty('content')
    expect(digest.steps[0]!.locations).toEqual([{ path: '/repo/a.ts' }])
    expect(digest).toMatchObject({ durationMs: 41_000, stopReason: 'end_turn', canCancel: true })
  })

  it('leaves the count unknown when the start of the thread is not loaded', () => {
    expect(digestOf([tool('a')], false, false).tools).toBeNull()
  })
})

describe('progressOf', () => {
  it('counts the time since it started while it runs', () => {
    const digest = digestOf([tool('a')], true, false)
    expect(progressOf(child({ status: 'running' }), digest, 42_000)).toEqual({
      tools: 1,
      elapsedMs: 41_000,
      running: true,
    })
    expect(progressOf(child({ status: 'running' }), null, 42_000).tools).toBeNull()
  })

  it('does not count a later run from when the first started', () => {
    const digest = digestOf([tool('a'), end('e', 9_000), tool('b')], true, false)
    expect(progressOf(child({ status: 'running' }), digest, 60_000).elapsedMs).toBeNull()
  })

  it("gives a finished one its run's length, or nothing without its thread", () => {
    const digest = digestOf([tool('a'), end('e', 68_000)], true, false)
    expect(progressOf(child(), digest, 999_999)).toEqual({
      tools: 1,
      elapsedMs: 68_000,
      running: false,
    })
    expect(progressOf(child(), null, 999_999).elapsedMs).toBeNull()
  })

  it('takes starting and waiting for an answer as running', () => {
    expect(subagentRunning({ status: 'starting' })).toBe(true)
    expect(subagentRunning({ status: 'awaiting_permission' })).toBe(true)
    expect(subagentRunning({ status: 'failed' })).toBe(false)
  })
})

describe('readSubagent', () => {
  const snapshot = (entries: ThreadEntry[]): SessionSnapshot => ({
    session: { subagent: { canCancel: false } } as SessionView,
    entries,
    seq: 1,
    older: null,
    plan: null,
  })

  beforeEach(() => request.mockReset())

  it('reads the whole thread once per state of the sub-agent', async () => {
    request.mockResolvedValue(snapshot([tool('a')]))
    await Promise.all([readSubagent(child({ id: 'r1' })), readSubagent(child({ id: 'r1' }))])
    await readSubagent(child({ id: 'r1' }))
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('sessions.snapshot', { sessionId: 'r1', from: 0 })
    await readSubagent(child({ id: 'r1', updatedAt: 6_000 }))
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('reads again after a failed read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    request.mockRejectedValueOnce(new Error('gone'))
    await readSubagent(child({ id: 'r2' }))
    request.mockResolvedValue(snapshot([]))
    await readSubagent(child({ id: 'r2' }))
    expect(request).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
