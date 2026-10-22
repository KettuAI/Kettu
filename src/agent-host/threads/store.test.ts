import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { inThreadWorker } from '../testing/thread-worker'
import type { ThreadHead } from './model'
import type { ThreadReply, ThreadRequest } from './protocol'
import { ThreadStore, ThreadStoreError, type ThreadWorker } from './store'

const head: ThreadHead = { agentId: 'fake-agent', acpSessionId: 'acp-1' }
const dirs: string[] = []
const stores: ThreadStore[] = []
const logs: { level: string; message: string }[] = []

function store(createWorker = inThreadWorker, closeTimeoutMs?: number): ThreadStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-store-'))
  dirs.push(dir)
  const created = new ThreadStore({
    file: path.join(dir, 'threads.db'),
    createWorker,
    log: (level, message) => logs.push({ level, message }),
    ...(closeTimeoutMs ? { closeTimeoutMs } : {}),
  })
  stores.push(created)
  return created
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  logs.length = 0
})

const note = (id: string): ThreadEntry => ({ kind: 'notice', id, severity: 'info', title: id })

/** A worker that answers `ready`, then whatever `answer` makes of each request. */
function fakeWorker(answer: (request: ThreadRequest) => ThreadReply | null): {
  create: () => ThreadWorker
  exit: (error: Error | null) => void
  terminated: () => boolean
} {
  let onMessage: (reply: ThreadReply) => void = () => {}
  let onExit: (error: Error | null) => void = () => {}
  let terminated = false
  return {
    create: () => {
      setImmediate(() => onMessage({ type: 'ready', status: 'ok' }))
      return {
        postMessage: (request) => {
          const reply = answer(request)
          if (reply) setImmediate(() => onMessage(reply))
        },
        onMessage: (listener) => {
          onMessage = listener
        },
        onExit: (listener) => {
          onExit = listener
        },
        terminate: async () => {
          terminated = true
          onExit(null)
        },
      }
    },
    exit: (error) => onExit(error),
    terminated: () => terminated,
  }
}

describe('the thread store', () => {
  it('reads and writes through the worker', async () => {
    const threads = store()
    expect(await threads.ready).toBe('created')
    await threads.write('s1', {
      head,
      entries: [
        { pos: 0, entry: note('a') },
        { pos: 1, entry: note('b') },
      ],
    })
    const page = await threads.page('s1')
    expect(page?.entries.map((e) => e.id)).toEqual(['a', 'b'])
    expect((await threads.tail('s1', 1))?.entries.map((e) => e.id)).toEqual(['b'])
    expect((await threads.load('s1'))?.entries.map((p) => p.pos)).toEqual([0, 1])
    await threads.remove(['s1'])
    expect(await threads.page('s1')).toBeNull()
  })

  it('rejects a write that conflicts with what is stored, naming the code', async () => {
    const threads = store()
    await threads.write('s1', { head, entries: [{ pos: 0, entry: note('a') }] })
    const failed = threads.write('s1', { head, entries: [{ pos: 3, entry: note('a') }] })
    await expect(failed).rejects.toBeInstanceOf(ThreadStoreError)
    await expect(failed).rejects.toMatchObject({ code: 'conflict' })
  })

  it('answers in order, and flush waits for every request made so far', async () => {
    const threads = store()
    const order: string[] = []
    const writes = ['a', 'b', 'c'].map((id, pos) =>
      threads.write('s1', { head, entries: [{ pos, entry: note(id) }] }).then(() => order.push(id)),
    )
    await threads.flush()
    expect(order).toEqual(['a', 'b', 'c'])
    await Promise.all(writes)
  })

  it('refuses requests once closed', async () => {
    const threads = store()
    await threads.write('s1', { head, entries: [{ pos: 0, entry: note('a') }] })
    await threads.close()
    await threads.close()
    await expect(threads.page('s1')).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('fails what was in flight when the worker stops, and says why', async () => {
    const worker = fakeWorker(() => null)
    const threads = store(worker.create)
    expect(await threads.ready).toBe('ok')
    const pending = threads.page('s1')
    worker.exit(new Error('out of memory'))
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    await expect(threads.write('s1', { head, entries: [] })).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(logs).toContainEqual({
      level: 'error',
      message: 'The thread worker stopped: out of memory',
    })
  })

  it('stops a worker that does not close in time', async () => {
    const worker = fakeWorker(() => null)
    const threads = store(worker.create, 20)
    await threads.ready
    await threads.close()
    expect(worker.terminated()).toBe(true)
    expect(logs.some((l) => l.message.includes('did not close in time'))).toBe(true)
  })

  it('passes the worker log on to the host log', async () => {
    const worker = fakeWorker((request) =>
      request.op === 'page' ? { type: 'log', level: 'warn', message: 'slow disk' } : null,
    )
    const threads = store(worker.create, 20)
    await threads.ready
    void threads.page('s1').catch(() => {})
    await new Promise((resolve) => setImmediate(resolve))
    expect(logs).toContainEqual({ level: 'warn', message: 'Thread database: slow disk' })
  })
})
