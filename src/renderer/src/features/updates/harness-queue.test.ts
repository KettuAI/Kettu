import { describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/thread'
import { HarnessQueue, type HarnessQueueState } from './harness-queue'

function setup(busy: Partial<Record<AgentId, number>> = {}) {
  const runs: AgentId[] = []
  const finish: (() => void)[] = []
  const states: HarnessQueueState[] = []
  const watching = { on: 0, change: () => {} }
  const queue = new HarnessQueue({
    run: (id) => {
      runs.push(id)
      return new Promise<void>((resolve) => finish.push(resolve))
    },
    busy: (id) => busy[id] ?? 0,
    watch: (onChange) => {
      watching.on++
      watching.change = onChange
      return () => watching.on--
    },
    changed: (state) => states.push(state),
  })
  const settle = async () => {
    finish.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { queue, runs, states, busy, settle, watching, last: () => states.at(-1) }
}

describe('HarnessQueue', () => {
  it('installs one update at once, and the next when it ends', async () => {
    const q = setup()
    q.queue.request(['claude-code', 'codex'])
    expect(q.runs).toEqual(['claude-code'])
    expect(q.last()).toEqual({ waiting: [], queued: ['codex'] })
    await q.settle()
    expect(q.runs).toEqual(['claude-code', 'codex'])
    expect(q.last()).toEqual({ waiting: [], queued: [] })
  })

  it('waits for the running sessions of a harness, then installs', async () => {
    const q = setup({ codex: 1 })
    q.queue.request(['codex'])
    expect(q.runs).toEqual([])
    expect(q.last()).toEqual({ waiting: ['codex'], queued: [] })

    expect(q.watching.on).toBe(1)
    q.watching.change()
    expect(q.runs).toEqual([])

    q.busy.codex = 0
    q.watching.change()
    expect(q.runs).toEqual(['codex'])
    expect(q.last()).toEqual({ waiting: [], queued: [] })
    // Nothing waits, so the sessions are no longer watched.
    expect(q.watching.on).toBe(0)
  })

  it('installs at once when asked to after stopping its sessions', () => {
    const q = setup({ codex: 1 })
    q.queue.request(['codex'])
    q.queue.request(['codex'], { now: true })
    expect(q.runs).toEqual(['codex'])
    expect(q.last()?.waiting).toEqual([])
  })

  it('holds a queued update again when a session starts before its turn, then installs it', async () => {
    const q = setup()
    q.queue.request(['claude-code', 'codex'])
    expect(q.watching.on).toBe(0)
    q.busy.codex = 2
    await q.settle()
    expect(q.runs).toEqual(['claude-code'])
    expect(q.last()).toEqual({ waiting: ['codex'], queued: [] })
    expect(q.watching.on).toBe(1)

    q.busy.codex = 0
    q.watching.change()
    expect(q.runs).toEqual(['claude-code', 'codex'])
  })

  it('stops waiting for one the user forgets', () => {
    const q = setup({ codex: 1 })
    q.queue.request(['codex'])
    q.queue.forget('codex')
    expect(q.last()).toEqual({ waiting: [], queued: [] })
    expect(q.watching.on).toBe(0)
    q.busy.codex = 0
    q.queue.check()
    expect(q.runs).toEqual([])
  })

  it('drops the queue when the update installing is stopped', async () => {
    const q = setup()
    q.queue.request(['claude-code', 'codex'])
    q.queue.clear()
    await q.settle()
    expect(q.runs).toEqual(['claude-code'])
  })
})
