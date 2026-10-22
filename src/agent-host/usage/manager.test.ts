import { describe, expect, it, vi } from 'vitest'
import type { AgentId } from '@shared/thread'
import { UsageManager, type UsageManagerDeps } from './manager'
import type { LogReader } from './model'
import type { ScanRequest } from './protocol'
import type { ScanOutcome } from './service'
import type { UsageStore } from './store'

interface FakeScan {
  agents: AgentId[]
  finish(cancelled?: boolean): void
  done: boolean
}

/** A store whose scans run until the test finishes them or the manager cancels them. */
function fakeStore() {
  const scans: FakeScan[] = []
  const store = {
    ready: Promise.resolve('ok'),
    scan: (request: ScanRequest) =>
      new Promise<ScanOutcome>((resolve) => {
        const scan: FakeScan = {
          agents: request.agents,
          done: false,
          finish: (cancelled = false) => {
            scan.done = true
            resolve({ results: [], cancelled })
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
