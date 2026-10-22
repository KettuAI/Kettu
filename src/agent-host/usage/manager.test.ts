import { describe, expect, it, vi } from 'vitest'
import type { AgentId } from '@shared/thread'
import type { UsageStatus } from '@shared/usage'
import { UsageManager, type UsageManagerDeps } from './manager'
import type { LogReader } from './model'
import type { ScanRequest } from './protocol'
import type { ScanOutcome } from './service'
import type { UsageStore } from './store'

interface FakeScan {
  agents: AgentId[]
  finish(cancelled?: boolean): void
  fail(error: Error): void
  done: boolean
}

/** A store whose scans run until the test finishes them or the manager cancels them. */
function fakeStore() {
  const scans: FakeScan[] = []
  const store = {
    ready: Promise.resolve('ok'),
    scan: (request: ScanRequest) =>
      new Promise<ScanOutcome>((resolve, reject) => {
        const scan: FakeScan = {
          agents: request.agents,
          done: false,
          finish: (cancelled = false) => {
            scan.done = true
            resolve({ results: [], cancelled })
          },
          fail: (error) => {
            scan.done = true
            reject(error)
          },
        }
        scans.push(scan)
      }),
    cancel: async () => {
      for (const scan of scans) if (!scan.done) scan.finish(true)
    },
    stats: async () => [],
    removeLogs: async () => {},
    close: async () => {},
  }
  return { store: store as unknown as UsageStore, scans }
}

const reader = (agentId: AgentId): LogReader => ({
  agentId,
  locations: () => [],
  scan: async () => true,
})

function manager(store: UsageStore, overrides: Partial<UsageManagerDeps> = {}) {
  return new UsageManager({
    store,
    readers: [reader('claude-code'), reader('codex')],
    fromComputer: true,
    platform: 'darwin',
    home: '/home/test',
    env: async () => ({}),
    isScratch: () => false,
    log: () => {},
    changed: () => {},
    status: () => {},
    ...overrides,
  })
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('turning Usage on this computer off and on', () => {
  it('starts a new import when it is turned on again while the cancelled scan ends', async () => {
    const { store, scans } = fakeStore()
    const usage = manager(store)
    void usage.sync()
    await vi.waitFor(() => expect(scans).toHaveLength(1))

    usage.setFromComputer(false)
    usage.setFromComputer(true)
    await vi.waitFor(() => expect(scans).toHaveLength(2))
    expect(scans[0]?.done).toBe(true)
    expect(scans[1]?.agents).toEqual(['claude-code', 'codex'])
  })

  it('drops a queued re-import once it is turned off', async () => {
    const { store, scans } = fakeStore()
    let reimporting = false
    let queued = false
    const usage = manager(store, {
      changed: () => {
        // reimport says the figures changed just before it queues its scan.
        if (reimporting) queued = true
      },
    })
    void usage.sync()
    await vi.waitFor(() => expect(scans).toHaveLength(1))
    reimporting = true
    const reimport = usage.reimport('codex')
    await vi.waitFor(() => expect(queued).toBe(true))
    reimporting = false

    usage.setFromComputer(false)
    await settle()
    expect(scans).toHaveLength(1)
    await reimport
  })

  it('reads the agents a deletion asks for after the scan that runs', async () => {
    const { store, scans } = fakeStore()
    const usage = manager(store)
    void usage.sync()
    await vi.waitFor(() => expect(scans).toHaveLength(1))
    let synced = false
    const sync = usage.syncAgents(['codex', 'fake-agent']).then(() => (synced = true))
    await settle()
    expect(scans).toHaveLength(1)

    scans[0]?.finish()
    await vi.waitFor(() => expect(scans).toHaveLength(2))
    expect(scans[1]?.agents).toEqual(['codex'])
    expect(synced).toBe(false)
    scans[1]?.finish()
    await sync
  })

  it('reads nothing for a deletion while it is off', async () => {
    const { store, scans } = fakeStore()
    const usage = manager(store, { fromComputer: false })
    await usage.syncAgents(['codex'])
    expect(scans).toHaveLength(0)
  })
})

describe('a scan that fails', () => {
  it('fails Sync now and a re-import, and only logs a scan nobody asked for', async () => {
    const { store, scans } = fakeStore()
    const logs: string[] = []
    const usage = manager(store, { log: (_, message) => logs.push(message) })
    const sync = usage.sync()
    await vi.waitFor(() => expect(scans).toHaveLength(1))
    scans[0]?.fail(new Error('The usage worker stopped'))
    await expect(sync).rejects.toThrow('The usage worker stopped')

    const reimport = usage.reimport('codex')
    await vi.waitFor(() => expect(scans).toHaveLength(2))
    scans[1]?.fail(new Error('disk I/O error'))
    await expect(reimport).rejects.toThrow('disk I/O error')

    usage.setFromComputer(false)
    usage.setFromComputer(true)
    await vi.waitFor(() => expect(scans).toHaveLength(3))
    scans[2]?.fail(new Error('again'))
    await vi.waitFor(() => expect(logs).toHaveLength(3))
    expect(logs.at(-1)).toBe('The usage scan failed: again')
  })
})

describe('the database', () => {
  it('says usage is unavailable once the store stops for good, and back after a restart', async () => {
    const { store } = fakeStore()
    const statuses: UsageStatus[] = []
    let changed = 0
    const usage = manager(store, {
      status: (status) => statuses.push(status),
      changed: () => changed++,
    })
    usage.storeStatus('unavailable')
    await vi.waitFor(() => expect(changed).toBe(1))
    expect(statuses.at(-1)).toMatchObject({ unavailable: true })
    await expect(usage.summary([], 0, 1, 'computer')).resolves.toMatchObject({ days: [] })

    usage.storeStatus('recovered')
    await vi.waitFor(() => expect(changed).toBe(2))
    expect(statuses.at(-1)).toMatchObject({ unavailable: false })
  })
})
