import { describe, expect, it } from 'vitest'
import type { ScanProgress } from '@shared/usage'
import type { UsageDbStatus } from './db'
import type { UsageReply, UsageRequest } from './protocol'
import { UsageStore, type UsageWorker } from './store'

interface FakeWorker extends UsageWorker {
  posted: UsageRequest[]
  reply(reply: UsageReply): void
  exit(error: Error | null): void
}

function fakeWorkers() {
  const workers: FakeWorker[] = []
  const create = (): UsageWorker => {
    let onMessage: (reply: UsageReply) => void = () => {}
    let onExit: (error: Error | null) => void = () => {}
    const worker: FakeWorker = {
      posted: [],
      reply: (reply) => onMessage(reply),
      exit: (error) => onExit(error),
      postMessage: (request) => worker.posted.push(request),
      onMessage: (listener) => {
        onMessage = listener
      },
      onExit: (listener) => {
        onExit = listener
      },
      terminate: async () => onExit(null),
    }
    workers.push(worker)
    return worker
  }
  return { workers, create }
}

function store() {
  const { workers, create } = fakeWorkers()
  const statuses: UsageDbStatus[] = []
  const progress: (ScanProgress | null)[] = []
  const logs: string[] = []
  const usage = new UsageStore({
    file: '/tmp/usage.db',
    createWorker: create,
    log: (level, message) => logs.push(`${level}: ${message}`),
    onChanged: () => {},
    onProgress: (value) => progress.push(value),
    onStatus: (status) => statuses.push(status),
  })
  return { usage, workers, statuses, progress, logs }
}

const crash = new Error('out of memory')

describe('the usage store', () => {
  it('starts its worker again when it stops, failing only what was waiting', async () => {
    const { usage, workers, statuses, progress, logs } = store()
    workers[0]!.reply({ type: 'ready', status: 'ok' })
    expect(await usage.ready).toBe('ok')
    const waiting = usage.stats()

    workers[0]!.exit(crash)
    await expect(waiting).rejects.toThrow('out of memory')
    expect(progress).toEqual([null])
    expect(logs).toEqual([expect.stringMatching(/^warn: The usage worker stopped: out of memory/)])
    expect(workers).toHaveLength(2)

    workers[1]!.reply({ type: 'ready', status: 'recovered' })
    expect(statuses).toEqual(['recovered'])
    const stats = usage.stats()
    const request = workers[1]!.posted.at(-1)!
    workers[1]!.reply({ type: 'result', id: request.id, value: [] })
    expect(await stats).toEqual([])
  })

  it('gives up after two restarts and says the database is unavailable', async () => {
    const { usage, workers, statuses, logs } = store()
    for (let i = 0; i < 3; i++) workers[i]!.exit(crash)
    expect(workers).toHaveLength(3)
    expect(statuses).toEqual(['unavailable'])
    expect(await usage.ready).toBe('unavailable')
    expect(logs.at(-1)).toMatch(/^error: The usage worker stopped/)
    await expect(usage.stats()).rejects.toThrow('out of memory')
  })

  it('does not restart a worker it closes', async () => {
    const { usage, workers, statuses } = store()
    workers[0]!.reply({ type: 'ready', status: 'ok' })
    const closing = usage.close()
    const request = workers[0]!.posted.at(-1)!
    workers[0]!.reply({ type: 'result', id: request.id, value: null })
    await closing
    expect(workers).toHaveLength(1)
    expect(statuses).toEqual([])
  })
})
