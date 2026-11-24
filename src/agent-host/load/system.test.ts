import { describe, expect, it } from 'vitest'
import {
  coresSample,
  cpuPercent,
  parseCgroupMemory,
  parseCpuMax,
  parseCpuUsage,
  parsePmset,
  parseSupplies,
  procStartTicks,
} from './system'

describe('parsePmset', () => {
  it('reads a battery that drains', () => {
    const text = [
      "Now drawing from 'Battery Power'",
      ' -InternalBattery-0 (id=24182883)\t45%; discharging; 3:12 remaining present: true',
    ].join('\n')
    expect(parsePmset(text)).toEqual({
      percent: 45,
      charging: false,
      onBattery: true,
      minutesLeft: 192,
    })
  })

  it('reads one that charges, and one that is full or held on mains', () => {
    const charging =
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t86%; charging; 0:40 remaining present: true"
    expect(parsePmset(charging)).toEqual({
      percent: 86,
      charging: true,
      onBattery: false,
      minutesLeft: 40,
    })
    const held =
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=24182883)\t80%; AC attached; not charging present: true"
    expect(parsePmset(held)).toEqual({ percent: 80, charging: false, onBattery: false })
    const full =
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true"
    expect(parsePmset(full)).toEqual({ percent: 100, charging: false, onBattery: false })
  })

  it('leaves out an estimate it does not have yet', () => {
    const text =
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t12%; discharging; (no estimate) present: true"
    expect(parsePmset(text)).toEqual({ percent: 12, charging: false, onBattery: true })
  })

  it('finds no battery on a desktop Mac or behind a UPS alone', () => {
    expect(parsePmset("Now drawing from 'AC Power'\n")).toBeNull()
    expect(
      parsePmset(
        "Now drawing from 'UPS Power'\n -CP1500PFCLCD (id=3)\t100%; charged; 0:00 remaining present: true",
      ),
    ).toBeNull()
  })
})

describe('parseSupplies', () => {
  it('reads a laptop on battery from its energy and power', () => {
    expect(
      parseSupplies([
        { type: 'Mains\n', online: '0\n' },
        {
          type: 'Battery\n',
          status: 'Discharging\n',
          capacity: '18\n',
          energy_now: '9000000\n',
          energy_full: '50000000\n',
          power_now: '9000000\n',
        },
      ]),
    ).toEqual({ percent: 18, charging: false, onBattery: true, minutesLeft: 60 })
  })

  it('reads one charging from its charge and current', () => {
    expect(
      parseSupplies([
        { type: 'Mains', online: '1' },
        {
          type: 'Battery',
          status: 'Charging',
          charge_now: '2000000',
          charge_full: '4000000',
          current_now: '2000000',
        },
      ]),
    ).toEqual({ percent: 50, charging: true, onBattery: false, minutesLeft: 60 })
  })

  it('takes two batteries as one, and the capacity when there is no energy', () => {
    expect(
      parseSupplies([
        { type: 'Battery', status: 'Discharging', capacity: '40' },
        { type: 'Battery', status: 'Discharging', capacity: '60' },
      ]),
    ).toEqual({ percent: 50, charging: false, onBattery: true })
  })

  it('finds none without a battery, as a server or a container', () => {
    expect(parseSupplies([])).toBeNull()
    expect(parseSupplies([{ type: 'Mains', online: '1' }, { type: 'USB' }])).toBeNull()
  })
})

describe('cgroup v2', () => {
  it('reads the CPU limit in cores, and none without a quota', () => {
    expect(parseCpuMax('200000 100000\n')).toBe(2)
    expect(parseCpuMax('50000 100000')).toBe(0.5)
    expect(parseCpuMax('max 100000\n')).toBeNull()
    expect(parseCpuMax('')).toBeNull()
  })

  it('reads the CPU time used', () => {
    expect(parseCpuUsage('usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\n')).toBe(123456)
    expect(parseCpuUsage('user_usec 1')).toBeNull()
  })

  it('reads memory without the file cache the kernel takes back first', () => {
    const stat = 'anon 400000000\nfile 300000000\ninactive_file 200000000\nactive_file 100000000\n'
    expect(parseCgroupMemory('1073741824\n', '700000000\n', stat)).toEqual({
      used: 500_000_000,
      total: 1_073_741_824,
    })
    expect(parseCgroupMemory('max\n', '700000000\n', stat)).toBeNull()
    expect(parseCgroupMemory('', '', '')).toBeNull()
  })
})

describe('procStartTicks', () => {
  it("reads a process's start after boot, its name holding spaces and parentheses", () => {
    const stat = '1 (my (init) x) S 0 1 1 0 -1 4194560 0 0 0 0 5 3 0 0 20 0 1 0 4321 0 0'
    expect(procStartTicks(stat)).toBe(4321)
    expect(procStartTicks('')).toBeNull()
  })
})

describe('cpuPercent', () => {
  it("measures the cores' busy share between two samples", () => {
    const times = (user: number, idle: number) => ({ user, nice: 0, sys: 0, irq: 0, idle })
    const cpu = (user: number, idle: number) => ({ model: '', speed: 0, times: times(user, idle) })
    const from = coresSample([cpu(100, 900), cpu(100, 900)], 0)
    const to = coresSample([cpu(400, 1600), cpu(100, 1900)], 1000)
    expect(cpuPercent(from, to)).toBe(15)
    expect(cpuPercent(from, from)).toBe(0)
  })
})
