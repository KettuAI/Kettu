import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import {
  LOAD_DETAIL_MS,
  LOAD_IDLE_MS,
  LOAD_LEASE_MS,
  LOAD_READ_MS,
  STRAIN_CLEAR_MS,
} from '@shared/host-load'
import type { HostBattery, HostLoad, HostStrain } from '@shared/host-load'
import type { MemoryState } from '@shared/idle-release'
import { LoadMonitor, type LoadSource, type OwnersRead } from './monitor'
import type { Listing } from './processes'

const GB = 1024 ** 3

function setup(
  options: {
    active?: boolean
    freeGb?: () => number
    devices?: boolean
    lowWatch?: () => boolean
    battery?: () => HostBattery | undefined
    memory?: () => MemoryState
  } = {},
) {
  let busy = 0
  let reads = 0
  let lowReads = 0
  let samples = 0
  let listings = 0
  const disks = () => [
    { path: '/', name: 'Disk', free: (options.freeGb?.() ?? 100) * GB, total: 500 * GB },
  ]
  const source: LoadSource = {
    cpuSample: () => {
      samples++
      return Promise.resolve({ at: Date.now(), busy: (busy += 100), total: busy * 4 })
    },
    cores: () => Promise.resolve(4),
    read: (cpu) => {
      reads++
      const battery = options.battery?.()
      const state = options.memory?.() ?? 'plenty'
      const load: HostLoad = {
        at: Date.now(),
        cpu: { percent: cpu, cores: 4 },
        memory: { used: 8 * GB, total: 16 * GB, state },
        disks: disks(),
        ...(battery ? { battery } : {}),
        uptime: 100,
      }
      return Promise.resolve({ load, memory: { state, available: 50 } })
    },
    readLow: () => {
      lowReads++
      const battery = options.battery?.()
      return Promise.resolve({ at: Date.now(), disks: disks(), ...(battery ? { battery } : {}) })
    },
    list: () => {
      listings++
      const at = Date.now()
      const rows = [
        {
          pid: 10,
          ppid: 1,
          pgid: 10,
          startedAt: 0,
          uid: 1,
          rss: GB,
          cpuMs: listings * 100,
          name: 'zsh',
        },
      ]
      return Promise.resolve<Listing>({ at, rows })
    },
  }
  const owners: OwnersRead = {
    owners: {
      kettu: 99_999,
      daemon: false,
      sessions: [],
      agents: [],
      terminals: [{ terminalId: 't1', sessionId: 's1', name: 'curl -H secret', pid: 10 }],
      uid: null,
    },
    shells: new Map([['t1', 'zsh']]),
    devices: options.devices ?? false,
  }
  const sent: { portId: string; event: HostEvent }[] = []
  const broadcasts: HostEvent[] = []
  const memory: unknown[] = []
  const lows: HostStrain[] = []
  const monitor = new LoadMonitor({
    platform: 'darwin',
    source,
    active: () => options.active ?? false,
    lowWatch: () => options.lowWatch?.() ?? false,
    low: (strain) => lows.push(strain),
    owners: () => Promise.resolve(owners),
    isDevice: (portId) => portId.startsWith('device'),
    send: (portIds, event) => portIds.forEach((portId) => sent.push({ portId, event })),
    broadcast: (event) => broadcasts.push(event),
    memory: (reading) => memory.push(reading),
    log: () => {},
    delay: () => Promise.resolve(),
  })
  const loads = (portId: string) =>
    sent.filter((entry) => entry.portId === portId && entry.event.type === 'host.load')
  return {
    monitor,
    sent,
    broadcasts,
    memory,
    lows,
    loads,
    counts: () => ({ reads, lowReads, samples, listings }),
  }
}

describe('LoadMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it('answers a watch at once and sends the load every 2 s until its lease runs out', async () => {
    const { monitor, loads } = setup()
    monitor.start()
    const answer = await monitor.watch('window', false)
    expect(answer.load.disks[0]?.free).toBe(100 * GB)
    expect(answer.history).toHaveLength(1)
    expect(answer.usage).toBeUndefined()
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 5)
    expect(loads('window')).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(LOAD_LEASE_MS)
    const sent = loads('window').length
    expect(sent).toBeLessThanOrEqual(15)
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 10)
    expect(loads('window')).toHaveLength(sent)
    expect(monitor.watching()).toEqual([])
  })

  it('keeps sending while the client renews its lease', async () => {
    const { monitor, loads } = setup()
    monitor.start()
    await monitor.watch('window', false)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(LOAD_LEASE_MS - 5_000)
      await monitor.watch('window', false)
    }
    const before = loads('window').length
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 3)
    expect(loads('window').length).toBe(before + 3)
  })

  it('stops at once for a port that unwatches or closes', async () => {
    const { monitor, loads } = setup()
    monitor.start()
    await monitor.watch('a', false)
    await monitor.watch('b', false)
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS)
    monitor.unwatch('a')
    monitor.portClosed('b')
    const a = loads('a').length
    const b = loads('b').length
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 5)
    expect(loads('a')).toHaveLength(a)
    expect(loads('b')).toHaveLength(b)
  })

  it('reads what uses the computer only for a detail watch, and only to that port', async () => {
    const { monitor, loads, counts } = setup()
    monitor.start()
    await monitor.watch('plain', false)
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 3)
    expect(counts().listings).toBe(0)
    await monitor.watch('detail', true)
    await vi.advanceTimersByTimeAsync(LOAD_DETAIL_MS * 2)
    const withUsage = loads('detail').filter((entry) => 'usage' in entry.event && entry.event.usage)
    expect(withUsage.length).toBeGreaterThan(0)
    expect(loads('plain').some((entry) => 'usage' in entry.event && entry.event.usage)).toBe(false)
    monitor.unwatch('detail')
    const listed = counts().listings
    await vi.advanceTimersByTimeAsync(LOAD_DETAIL_MS * 3)
    expect(counts().listings).toBe(listed)
  })

  it('names a terminal by its shell to a device the owner keeps from the terminals', async () => {
    const { monitor, loads } = setup({ devices: false })
    monitor.start()
    await monitor.watch('device-1', true)
    await monitor.watch('window', true)
    await vi.advanceTimersByTimeAsync(LOAD_DETAIL_MS * 2)
    const usageOf = (portId: string) => {
      const found = loads(portId).find((entry) => 'usage' in entry.event && entry.event.usage)
      return found?.event.type === 'host.load' ? found.event.usage : undefined
    }
    expect(usageOf('device-1')?.terminals[0]?.name).toBe('zsh')
    expect(usageOf('window')?.terminals[0]?.name).toBe('curl -H secret')
  })

  it('reads once a minute without a watch only while it is worth it', async () => {
    const idle = setup({ active: false })
    idle.monitor.start()
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS * 3)
    expect(idle.counts().reads).toBe(0)
    idle.monitor.stop()

    const busy = setup({ active: true })
    busy.monitor.start()
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS * 3 + 1000)
    expect(busy.counts().reads).toBe(4)
    // Idle release hears each reading.
    expect(busy.memory).toHaveLength(4)
    busy.monitor.stop()
  })

  it('tells every port of the strains only when they change', async () => {
    let free = 100
    const { monitor, broadcasts } = setup({ freeGb: () => free })
    monitor.start()
    await monitor.watch('window', false)
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 3)
    expect(broadcasts).toEqual([])
    free = 5
    await vi.advanceTimersByTimeAsync(LOAD_READ_MS * 3)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toMatchObject({
      type: 'host.status',
      status: { strains: [{ kind: 'disk', level: 'warn', path: '/' }] },
    })
    expect(monitor.status().strains).toHaveLength(1)
  })

  it('reads only the disks and battery once a minute while only a device wants to hear', async () => {
    let wanted = true
    const { monitor, counts } = setup({ lowWatch: () => wanted })
    monitor.start()
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS * 3 + 1000)
    // At start, then once a minute; never the CPU, memory or the processes.
    expect(counts()).toEqual({ reads: 0, lowReads: 4, samples: 0, listings: 0 })
    wanted = false
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS * 3)
    expect(counts().lowReads).toBe(4)
    monitor.stop()
  })

  it('tells devices once each time a disk crosses a line, again only after it cleared', async () => {
    let free = 100
    const { monitor, lows } = setup({ lowWatch: () => true, freeGb: () => free })
    monitor.start()
    free = 8
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS * 5)
    expect(lows).toMatchObject([{ kind: 'disk', level: 'warn', path: '/' }])
    free = 1.5
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS * 5)
    expect(lows.map((strain) => strain.level)).toEqual(['warn', 'critical'])
    // Back over the critical line, but not past its margin: still critical, nothing new.
    free = 3
    await vi.advanceTimersByTimeAsync(STRAIN_CLEAR_MS * 2)
    free = 1
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS * 5)
    expect(lows).toHaveLength(2)
    // Cleared for good, then under the line again.
    free = 100
    await vi.advanceTimersByTimeAsync(STRAIN_CLEAR_MS + LOAD_IDLE_MS * 2)
    expect(monitor.status().strains).toEqual([])
    free = 8
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS * 3)
    expect(lows.map((strain) => strain.level)).toEqual(['warn', 'critical', 'warn'])
    monitor.stop()
  })

  it('tells devices of a low battery again once it was plugged in, and never of memory', async () => {
    let battery: HostBattery = { percent: 18, charging: false, onBattery: true }
    const { monitor, lows } = setup({
      active: true,
      battery: () => battery,
      memory: () => 'critical',
    })
    monitor.start()
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS * 3)
    expect(monitor.status().strains.map((strain) => strain.kind)).toEqual(['memory', 'battery'])
    expect(lows).toEqual([{ kind: 'battery', level: 'warn', value: 18 }])
    battery = { percent: 30, charging: true, onBattery: false }
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS)
    battery = { percent: 17, charging: false, onBattery: true }
    await vi.advanceTimersByTimeAsync(LOAD_IDLE_MS * 3)
    expect(lows.map((strain) => strain.kind)).toEqual(['battery', 'battery'])
    monitor.stop()
  })
})
