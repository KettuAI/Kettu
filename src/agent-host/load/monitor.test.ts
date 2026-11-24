import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import { LOAD_LEASE_MS, LOAD_READ_MS, type HostLoad } from '@shared/host-load'
import { LoadMonitor, type LoadSource } from './monitor'
import type { LoadSample } from './system'

const GB = 1e9

function setup() {
  let samples = 0
  let reads = 0
  let forgets = 0
  const froms: (LoadSample | null)[] = []
  const source: LoadSource = {
    sample: () => {
      samples++
      const at = Date.now()
      return Promise.resolve({
        cpu: { at, busy: samples * 100, total: samples * 400 },
        io: { at, values: new Map([['disk0', [samples * 1000, samples * 500]]]) },
        network: null,
      })
    },
    read: (from, to) => {
      reads++
      froms.push(from)
      const load: HostLoad = {
        at: to.cpu.at,
        cpu: { percent: 25, cores: 4 },
        memory: { used: 8 * GB, total: 16 * GB, state: 'plenty' },
        disk: { name: 'Disk', free: 100 * GB, total: 500 * GB },
        io: { readPerSecond: 1, writePerSecond: 2 },
      }
      return Promise.resolve(load)
    },
    forget: () => forgets++,
  }
  const sent: { portId: string; event: HostEvent }[] = []
  const logs: string[] = []
  const monitor = new LoadMonitor({
    source,
    send: (portIds, event) => portIds.forEach((portId) => sent.push({ portId, event })),
    log: (_, message) => logs.push(message),
    delay: () => Promise.resolve(),
  })
  const loads = (portId: string) =>
    sent.filter((entry) => entry.portId === portId && entry.event.type === 'host.load')
  return {
    monitor,
    sent,
    loads,
    logs,
    froms,
    counts: () => ({ samples, reads, forgets }),
  }
}

describe('LoadMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it('reads nothing until a client watches', async () => {
    const { counts } = setup()
    await vi.advanceTimersByTimeAsync(LOAD_LEASE_MS * 4)
    expect(counts().samples).toBe(0)
    expect(counts().reads).toBe(0)
  })

  it('answers a watch with the load alone, measured over two samples', async () => {
    const { monitor, froms } = setup()
    const answer = await monitor.watch('window')
    expect(Object.keys(answer)).toEqual(['load'])
    expect(answer.load.disk?.free).toBe(100 * GB)
    // The first reading measures between two samples rather than from nothing.
    expect(froms[0]).not.toBeNull()
    monitor.stop()
  })

  it('sends only the load every 2 s until the lease runs out', async () => {
    const { monitor, loads } = setup()
    await monitor.watch('window')
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 5)
    expect(loads('window')).toHaveLength(5)
    expect(Object.keys(loads('window')[0]!.event)).toEqual(['type', 'load'])
    await vi.advanceTimersByTimeAsync(LOAD_LEASE_MS)
    const sent = loads('window').length
    expect(sent).toBeLessThanOrEqual(15)
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 10)
    expect(loads('window')).toHaveLength(sent)
    expect(monitor.watching()).toEqual([])
  })

  it('keeps sending while the client renews its lease', async () => {
    const { monitor, loads } = setup()
    await monitor.watch('window')
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(LOAD_LEASE_MS - 5_000)
      await monitor.watch('window')
    }
    const before = loads('window').length
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 3)
    expect(loads('window').length).toBe(before + 3)
    monitor.stop()
  })

  it('stops at once for a port that unwatches or closes, and reads no more for nobody', async () => {
    const { monitor, loads, counts } = setup()
    await monitor.watch('a')
    await monitor.watch('b')
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS)
    monitor.unwatch('a')
    const a = loads('a').length
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 2)
    expect(loads('a')).toHaveLength(a)
    expect(loads('b').length).toBeGreaterThan(a)
    monitor.portClosed('b')
    const { reads } = counts()
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 5)
    expect(counts().reads).toBe(reads)
  })

  it('forgets what it measured from once the last watch ends', async () => {
    const { monitor, froms, counts } = setup()
    await monitor.watch('window')
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS)
    monitor.unwatch('window')
    expect(counts().forgets).toBeGreaterThan(0)
    const samples = counts().samples
    await monitor.watch('window')
    // A new watch takes two fresh samples instead of measuring from the old one.
    expect(counts().samples).toBe(samples + 2)
    expect(froms.at(-1)?.io?.values.get('disk0')).toEqual([
      (samples + 1) * 1000,
      (samples + 1) * 500,
    ])
    monitor.stop()
  })
})
