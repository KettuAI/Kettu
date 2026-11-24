import { describe, expect, it } from 'vitest'
import type { HostLoad } from '@shared/host-load'
import { Strains } from './strains'

const GB = 1e9
const MINUTE = 60_000

function load(at: number, changes: Partial<HostLoad> = {}): HostLoad {
  return {
    at,
    cpu: { percent: 99, cores: 8 },
    memory: { used: 8 * GB, total: 16 * GB, state: 'plenty' },
    disks: [{ path: '/', name: 'Macintosh HD', free: 100 * GB, total: 500 * GB }],
    uptime: 1000,
    ...changes,
  }
}

const disk = (free: number) => ({
  disks: [{ path: '/', name: 'Macintosh HD', free: free * GB, total: 500 * GB }],
})
const battery = (percent: number, onBattery = true) => ({
  battery: { percent, charging: false, onBattery },
})

describe('Strains', () => {
  it('never counts a busy CPU or tight memory', () => {
    const strains = new Strains()
    for (let i = 0; i < 5; i++) {
      strains.read(load(i * 2000, { memory: { used: 15 * GB, total: 16 * GB, state: 'tight' } }))
    }
    expect(strains.list()).toEqual([])
  })

  it('starts a level only after two reads in a row under its line', () => {
    const strains = new Strains()
    strains.read(load(0, disk(9)))
    expect(strains.list()).toEqual([])
    strains.read(load(2000, disk(11)))
    strains.read(load(4000, disk(9)))
    expect(strains.list()).toEqual([])
    expect(strains.read(load(6000, disk(9.5)))).toBe(true)
    expect(strains.list()).toEqual([{ kind: 'disk', level: 'warn', value: 9.5 * GB, path: '/' }])
  })

  it('goes from warn to critical, and takes the lower of two levels read', () => {
    const strains = new Strains()
    strains.read(load(0, disk(1)))
    strains.read(load(2000, disk(5)))
    expect(strains.list()[0]?.level).toBe('warn')
    strains.read(load(4000, disk(1)))
    strains.read(load(6000, disk(1.5)))
    expect(strains.list()[0]?.level).toBe('critical')
  })

  it('ends a level only after five minutes back over its line and the margin', () => {
    const strains = new Strains()
    strains.read(load(0, disk(5)))
    strains.read(load(2000, disk(5)))
    // Over the line but within the 2 GB margin: still low.
    strains.read(load(MINUTE, disk(11)))
    strains.read(load(7 * MINUTE, disk(11)))
    expect(strains.list()).toHaveLength(1)
    strains.read(load(8 * MINUTE, disk(13)))
    strains.read(load(12 * MINUTE, disk(13)))
    // A dip under the margin starts the five minutes again.
    strains.read(load(12 * MINUTE + 2000, disk(11.5)))
    strains.read(load(13 * MINUTE, disk(13)))
    expect(strains.list()).toHaveLength(1)
    strains.read(load(17 * MINUTE, disk(13)))
    expect(strains.list()).toHaveLength(1)
    expect(strains.read(load(18 * MINUTE, disk(13)))).toBe(true)
    expect(strains.list()).toEqual([])
  })

  it('steps down from critical to warn as the reading recovers part of the way', () => {
    const strains = new Strains()
    strains.read(load(0, disk(1)))
    strains.read(load(2000, disk(1)))
    strains.read(load(MINUTE, disk(6)))
    strains.read(load(7 * MINUTE, disk(6)))
    expect(strains.list()[0]?.level).toBe('warn')
  })

  it('counts memory only when the system judges it critical', () => {
    const strains = new Strains()
    const critical = { memory: { used: 15.4 * GB, total: 16 * GB, state: 'critical' as const } }
    strains.read(load(0, critical))
    strains.read(load(2000, critical))
    expect(strains.list()).toEqual([{ kind: 'memory', level: 'critical', value: 4 }])
  })

  it('counts the battery only on battery, and lets it go as soon as it is plugged in', () => {
    const strains = new Strains()
    strains.read(load(0, battery(15, false)))
    strains.read(load(2000, battery(15, false)))
    expect(strains.list()).toEqual([])
    strains.read(load(4000, battery(18)))
    strains.read(load(6000, battery(18)))
    expect(strains.list()).toEqual([{ kind: 'battery', level: 'warn', value: 18 }])
    strains.read(load(8000, battery(9)))
    strains.read(load(10_000, battery(8)))
    expect(strains.list()).toEqual([{ kind: 'battery', level: 'critical', value: 8 }])
    strains.read(load(12_000, battery(8, false)))
    expect(strains.list()).toEqual([])
  })

  it('lists the most pressing first', () => {
    const strains = new Strains()
    const all = {
      ...disk(1),
      ...battery(15),
      memory: { used: 15 * GB, total: 16 * GB, state: 'critical' as const },
    }
    strains.read(load(0, all))
    strains.read(load(2000, all))
    expect(strains.list().map((s) => `${s.level} ${s.kind}`)).toEqual([
      'critical memory',
      'critical disk',
      'warn battery',
    ])
  })

  it('forgets a volume no longer read', () => {
    const strains = new Strains()
    strains.read(load(0, disk(1)))
    strains.read(load(2000, disk(1)))
    expect(strains.read(load(4000, { disks: [] }))).toBe(true)
    expect(strains.list()).toEqual([])
  })
})
