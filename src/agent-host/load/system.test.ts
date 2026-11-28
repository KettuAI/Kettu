import { describe, expect, it, vi } from 'vitest'
import {
  coresSample,
  counterRates,
  cpuPercent,
  parseAppleSmartBattery,
  parseCgroupMemory,
  parseCpuMax,
  parseCpuUsage,
  parseDiskstats,
  parseIoreg,
  parseIoStat,
  parseNetDev,
  parseNetstat,
  parseNetstatE,
  parsePmset,
  parseSignedInt64,
  parseSupplies,
  parseSuppliesPower,
  parseWindowsBatteryPower,
  raplWatts,
  readRaplSample,
  SystemReader,
  type RaplFs,
  type RaplSample,
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

describe('counterRates', () => {
  const counters = (at: number, entries: [string, [number, number]][]) => ({
    at,
    values: new Map(entries),
  })

  it('gives bytes per second over the disks or interfaces both readings have', () => {
    const from = counters(0, [
      ['en0', [1_000, 500]],
      ['en1', [0, 0]],
    ])
    const to = counters(2_000, [
      ['en0', [5_000, 1_500]],
      ['en1', [2_000, 500]],
      // New since the last reading: not counted until it has two.
      ['utun4', [9_000_000, 9_000_000]],
    ])
    expect(counterRates(from, to)).toEqual([3_000, 750])
  })

  it('gives no reading when a counter went back, from a reset or a wrap', () => {
    const from = counters(0, [
      ['en0', [4_294_967_000, 100]],
      ['en1', [10, 10]],
    ])
    const to = counters(2_000, [
      ['en0', [200, 300]],
      ['en1', [20, 20]],
    ])
    expect(counterRates(from, to)).toBeNull()
  })

  it('gives no reading with nothing shared or no time between', () => {
    expect(counterRates(counters(0, [['a', [1, 1]]]), counters(2_000, [['b', [2, 2]]]))).toBeNull()
    expect(counterRates(counters(0, [['a', [1, 1]]]), counters(0, [['a', [2, 2]]]))).toBeNull()
  })
})

describe('disk counters', () => {
  it("reads each block storage driver's bytes from ioreg", () => {
    const text = [
      '+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x1000009f2, registered, matched, active, busy 0 (0 ms), retain 6>',
      '    {',
      '      "Statistics" = {"Operations (Write)"=0,"Bytes (Read)"=0,"Bytes (Write)"=0,"Operations (Read)"=0}',
      '    }',
      '+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x10000095d, registered, matched, active, busy 0 (1080 ms), retain 8>',
      '    {',
      '      "IOClass" = "IOBlockStorageDriver"',
      '      "Statistics" = {"Operations (Write)"=633537143,"Bytes (Read)"=31838347636736,"Errors (Read)"=0,"Bytes (Write)"=12597319012352}',
      '    }',
    ].join('\n')
    expect(parseIoreg(text)).toEqual(
      new Map([
        ['0x1000009f2', [0, 0]],
        ['0x10000095d', [31_838_347_636_736, 12_597_319_012_352]],
      ]),
    )
    expect(parseIoreg('')).toEqual(new Map())
  })

  it('reads the whole disks of /proc/diskstats in bytes, not their partitions or mapped devices', () => {
    const text = [
      '   8       0 sda 1000 10 20000 300 500 5 8000 200 0 400 500 0 0 0 0',
      '   8       1 sda1 900 10 18000 250 480 5 7900 190 0 380 440 0 0 0 0',
      ' 259       0 nvme0n1 10 0 4 0 2 0 6 0 0 0 0',
      ' 253       0 dm-0 800 0 16000 280 470 0 7800 210 0 390 490 0 0 0 0',
      '   7       0 loop0 5 0 10 0 0 0 0 0 0 0 0 0 0 0 0',
    ].join('\n')
    expect(parseDiskstats(text, new Set(['sda', 'nvme0n1']))).toEqual(
      new Map([
        ['sda', [20_000 * 512, 8_000 * 512]],
        ['nvme0n1', [4 * 512, 6 * 512]],
      ]),
    )
  })

  it("reads a container's bytes by device from io.stat", () => {
    const text = [
      '8:0 rbytes=1048576 wbytes=4096 rios=12 wios=1 dbytes=0 dios=0',
      '259:0 rbytes=10 wbytes=20 rios=1 wios=1 dbytes=0 dios=0',
      '',
    ].join('\n')
    expect(parseIoStat(text)).toEqual(
      new Map([
        ['8:0', [1_048_576, 4_096]],
        ['259:0', [10, 20]],
      ]),
    )
    expect(parseIoStat('')).toEqual(new Map())
  })
})

describe('network counters', () => {
  it("reads only the en* interfaces' link rows from netstat -ibn", () => {
    const text = [
      'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
      'lo0        16384 <Link#1>                      187191703     0 568862669365 187191703     0 568862669365     0',
      'lo0        16384 127           127.0.0.1       187191703     - 568862669365 187191703     - 568862669365     -',
      'gif0*      1280  <Link#2>                             0     0          0        0     0          0     0',
      'en0        1500  <Link#14>   6e:e9:dd:e9:3c:1e 386246856     0 407539575552 291831320     0 194834695766     0',
      'en0        1500  192.168.1     192.168.1.20    386246856     - 407539575552 291831320     - 194834695766     -',
      'bridge0    1500  <Link#18>   36:2c:a8:10:4e:c0   1000000     0 300000000000   900000     0 150000000000     0',
      'utun0      1380  <Link#19>                          50     0       4000       40     0       3000     0',
      'utun1      2000  <Link#20>                          60     0       5000       50     0       4000     0',
      'utun2      1000  <Link#21>                          70     0       6000       60     0       5000     0',
      'utun3      1500  <Link#22>                   300000000     0 380000000000 250000000     0 180000000000     0',
      'utun3      1500  198.18.0.1    198.18.0.1      300000000     - 380000000000 250000000     - 180000000000     -',
    ].join('\n')
    expect(parseNetstat(text)).toEqual(new Map([['en0', [407_539_575_552, 194_834_695_766]]]))
  })

  const netDev = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0',
    '  eth0:123456789 1000    0    0    0     0          0         0 98765432    900    0    0    0     0       0          0',
    'docker0: 5000000   400    0    0    0     0          0         0  6000000    500    0    0    0     0       0          0',
    'veth1a2b3c: 6000000 500    0    0    0     0          0         0  5000000    400    0    0    0     0       0          0',
    '   wg0: 70000000  6000    0    0    0     0          0         0 60000000   5000    0    0    0     0       0          0',
  ].join('\n')

  it('reads /proc/net/dev over the physical interfaces named', () => {
    expect(parseNetDev(netDev, new Set(['eth0']))).toEqual(
      new Map([['eth0', [123_456_789, 98_765_432]]]),
    )
  })

  it("reads a container's own interfaces from /proc/net/dev, without loopback", () => {
    expect([...parseNetDev(netDev).keys()]).toEqual(['eth0', 'docker0', 'veth1a2b3c', 'wg0'])
  })

  it("reads netstat -e's byte row whatever the language of its labels", () => {
    const english = [
      'Interface Statistics',
      '',
      '                           Received            Sent',
      '',
      'Bytes                    1234567890      123456789',
      'Unicast packets             5000000        4000000',
    ].join('\r\n')
    expect(parseNetstatE(english)).toEqual(new Map([['all', [1_234_567_890, 123_456_789]]]))
    const chinese = [
      '接口统计',
      '',
      '                           接收的            发送的',
      '',
      '字节                    42      7',
    ].join('\r\n')
    expect(parseNetstatE(chinese)).toEqual(new Map([['all', [42, 7]]]))
    expect(parseNetstatE('')).toEqual(new Map())
  })
})

describe('parseSignedInt64', () => {
  it('decodes positive, negative, and unsigned 64-bit two’s-complement integers', () => {
    expect(parseSignedInt64('0')).toBe(0)
    expect(parseSignedInt64('2400')).toBe(2400)
    expect(parseSignedInt64('-1500')).toBe(-1500)
    expect(parseSignedInt64('18446744073709550116')).toBe(-1500)
    expect(parseSignedInt64('18446744073709551615')).toBe(-1)
    expect(parseSignedInt64('')).toBeNull()
    expect(parseSignedInt64('abc')).toBeNull()
    expect(parseSignedInt64(undefined)).toBeNull()
  })
})

describe('parseAppleSmartBattery', () => {
  it('reads plugged-in charging state using SystemLoad rather than SystemPowerIn', () => {
    const text = [
      '+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000960>',
      '    {',
      '      "BatteryInstalled" = Yes',
      '      "ExternalConnected" = Yes',
      '      "IsCharging" = Yes',
      '      "Voltage" = 12500',
      '      "InstantAmperage" = 2400',
      '      "PowerTelemetryData" = {"SystemLoad"=12340,"SystemPowerIn"=42340,"BatteryPower"=30000}',
      '    }',
    ].join('\n')
    expect(parseAppleSmartBattery(text)).toEqual({
      systemWatts: 12.3,
      cpuWatts: null,
      batteryWatts: 30,
      batteryState: 'charging',
    })
  })

  it('reads plugged-in full/idle state matching real Apple Silicon ioreg output', () => {
    const text = [
      '+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000960>',
      '    {',
      '      "ExternalConnected" = Yes',
      '      "Voltage" = 12098',
      '      "PowerTelemetryData" = {"SystemLoad"=5546,"SystemVoltageIn"=20274,"SystemCurrentIn"=273,"SystemPowerIn"=5546,"BatteryPower"=0}',
      '      "BatteryInstalled" = Yes',
      '      "BatteryData" = {"CurrentCapacity"=80,"BatteryPower"=0}',
      '      "InstantAmperage" = 0',
      '      "AppleRawBatteryVoltage" = 12098',
      '      "Amperage" = 0',
      '      "IsCharging" = No',
      '    }',
    ].join('\n')
    expect(parseAppleSmartBattery(text)).toEqual({
      systemWatts: 5.5,
      cpuWatts: null,
      batteryWatts: 0,
      batteryState: 'idle',
    })
  })

  it('decodes 64-bit unsigned two’s-complement InstantAmperage while discharging on battery', () => {
    const text = [
      '+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000960>',
      '    {',
      '      "BatteryInstalled" = Yes',
      '      "ExternalConnected" = No',
      '      "IsCharging" = No',
      '      "Voltage" = 11800',
      '      "InstantAmperage" = 18446744073709550116',
      '      "PowerTelemetryData" = {"SystemLoad"=17920,"SystemPowerIn"=0,"BatteryPower"=18446744073709533916}',
      '    }',
    ].join('\n')
    expect(parseAppleSmartBattery(text)).toEqual({
      systemWatts: 17.9,
      cpuWatts: null,
      batteryWatts: 17.7,
      batteryState: 'discharging',
    })
  })

  it('does not promote battery discharge to systemWatts when PowerTelemetryData is absent', () => {
    const text = [
      '+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000400>',
      '    {',
      '      "BatteryInstalled" = Yes',
      '      "ExternalConnected" = No',
      '      "IsCharging" = No',
      '      "Voltage" = 11400',
      '      "InstantAmperage" = 18446744073709550616',
      '    }',
    ].join('\n')
    expect(parseAppleSmartBattery(text)).toEqual({
      systemWatts: null,
      cpuWatts: null,
      batteryWatts: 11.4,
      batteryState: 'discharging',
    })
  })

  it('falls back to SystemPowerIn only when plugged in with an idle battery, never while charging', () => {
    const idleFallback = [
      '+-o AppleSmartBattery  <class AppleSmartBattery>',
      '    {',
      '      "BatteryInstalled" = Yes',
      '      "ExternalConnected" = Yes',
      '      "IsCharging" = No',
      '      "Voltage" = 12100',
      '      "InstantAmperage" = 0',
      '      "PowerTelemetryData" = {"SystemPowerIn"=9450,"BatteryPower"=0}',
      '    }',
    ].join('\n')
    expect(parseAppleSmartBattery(idleFallback)).toEqual({
      systemWatts: 9.5,
      cpuWatts: null,
      batteryWatts: 0,
      batteryState: 'idle',
    })

    const chargingNoSystemLoad = [
      '+-o AppleSmartBattery  <class AppleSmartBattery>',
      '    {',
      '      "BatteryInstalled" = Yes',
      '      "ExternalConnected" = Yes',
      '      "IsCharging" = Yes',
      '      "Voltage" = 12500',
      '      "InstantAmperage" = 2000',
      '      "PowerTelemetryData" = {"SystemPowerIn"=40000,"BatteryPower"=25000}',
      '    }',
    ].join('\n')
    expect(parseAppleSmartBattery(chargingNoSystemLoad)).toEqual({
      systemWatts: null,
      cpuWatts: null,
      batteryWatts: 25,
      batteryState: 'charging',
    })
  })

  it('returns null cleanly on desktop Macs without AppleSmartBattery or reliable fields', () => {
    expect(parseAppleSmartBattery('')).toBeNull()
    expect(
      parseAppleSmartBattery(
        '+-o AppleSmartBattery  <class AppleSmartBattery>\n    {\n      "BatteryInstalled" = No\n    }',
      ),
    ).toBeNull()
    expect(
      parseAppleSmartBattery(
        '+-o AppleSmartBattery  <class AppleSmartBattery>\n    {\n      "BatteryInstalled" = Yes\n      "PowerTelemetryData" = {"SystemLoad"=0,"SystemPowerIn"=0}\n    }',
      ),
    ).toBeNull()
  })
})

describe('Linux RAPL power', () => {
  const sample = (at: number, entries: [string, number, number | null][]): RaplSample => ({
    at,
    packages: new Map(
      entries.map(([key, energyUj, maxEnergyRangeUj]) => [key, { energyUj, maxEnergyRangeUj }]),
    ),
  })

  it('returns null on first sample and accurate watts on consecutive samples', () => {
    const first = sample(1_000, [['intel-rapl:0', 100_000_000, 262_143_288_509]])
    const second = sample(3_000, [['intel-rapl:0', 130_400_000, 262_143_288_509]])
    expect(raplWatts(null, first)).toBeNull()
    expect(raplWatts(first, second)).toBe(15.2)
  })

  it('handles counter wraparound across max_energy_range_uj and sums multiple CPU sockets', () => {
    const max = 262_143_000_000
    const before = sample(0, [
      ['intel-rapl:0', max - 5_000_000, max],
      ['intel-rapl:1', 10_000_000, max],
    ])
    const after = sample(2_000, [
      ['intel-rapl:0', 15_000_000, max], // delta = 20 J -> 10 W
      ['intel-rapl:1', 26_000_000, max], // delta = 16 J -> 8 W
    ])
    expect(raplWatts(before, after)).toBe(18)
  })

  it('returns null on counter reset without max_energy_range_uj or zero energy delta', () => {
    const a = sample(0, [['intel-rapl:0', 50_000_000, null]])
    const reset = sample(2_000, [['intel-rapl:0', 10_000_000, null]])
    const frozen = sample(2_000, [['intel-rapl:0', 50_000_000, 262_143_000_000]])
    expect(raplWatts(a, reset)).toBeNull()
    expect(raplWatts(a, frozen)).toBeNull()
  })

  it('reads package domains, excludes subzones and psys, and silently handles EACCES', async () => {
    const files: Record<string, string> = {
      '/powercap/intel-rapl:0/name': 'package-0\n',
      '/powercap/intel-rapl:0/energy_uj': '42000000\n',
      '/powercap/intel-rapl:0/max_energy_range_uj': '262143288509\n',
      '/powercap/intel-rapl:0:0/name': 'core\n',
      '/powercap/intel-rapl:0:0/energy_uj': '20000000\n',
      '/powercap/intel-rapl:1/name': 'psys\n',
      '/powercap/intel-rapl:1/energy_uj': '99000000\n',
      '/powercap/intel-rapl-mmio:0/name': 'package-0\n',
      '/powercap/intel-rapl-mmio:0/energy_uj': '42000000\n',
    }
    const fs: RaplFs = {
      readdir: async () => ['intel-rapl:0', 'intel-rapl:0:0', 'intel-rapl:1', 'intel-rapl-mmio:0'],
      readFile: async (file) => {
        if (file in files) return files[file]!
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    }
    const reading = await readRaplSample('/powercap', 10_000, fs)
    expect(reading).toEqual({
      at: 10_000,
      packages: new Map([
        ['intel-rapl:0', { energyUj: 42_000_000, maxEnergyRangeUj: 262_143_288_509 }],
      ]),
    })

    const eaccesFs: RaplFs = {
      readdir: async () => ['intel-rapl:0'],
      readFile: async (file) => {
        if (file.endsWith('/name')) return 'package-0\n'
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
    }
    expect(await readRaplSample('/powercap', 10_000, eaccesFs)).toBeNull()
  })

  it('falls back to intel-rapl-mmio only when MSR intel-rapl domains are unreadable', async () => {
    const mmioFs: RaplFs = {
      readdir: async () => ['intel-rapl:0', 'intel-rapl-mmio:0'],
      readFile: async (file) => {
        if (file.includes('intel-rapl:0/energy_uj')) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        }
        if (file.endsWith('/name')) return 'package-0\n'
        if (file.endsWith('/energy_uj')) return '12345678\n'
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    }
    const reading = await readRaplSample('/powercap', 5_000, mmioFs)
    expect(reading).toEqual({
      at: 5_000,
      packages: new Map([['intel-rapl-mmio:0', { energyUj: 12_345_678, maxEnergyRangeUj: null }]]),
    })
  })
})

describe('parseSuppliesPower', () => {
  it('reads battery discharging and charging power from power_now (µW -> W)', () => {
    expect(
      parseSuppliesPower([
        { type: 'Mains\n', online: '0\n' },
        { type: 'Battery\n', status: 'Discharging\n', power_now: '14250000\n' },
      ]),
    ).toEqual({ batteryWatts: 14.3, batteryState: 'discharging' })

    expect(
      parseSuppliesPower([
        { type: 'Mains\n', online: '1\n' },
        { type: 'Battery\n', status: 'Charging\n', power_now: '28400000\n' },
      ]),
    ).toEqual({ batteryWatts: 28.4, batteryState: 'charging' })
  })

  it('computes battery power from voltage_now (µV) * current_now (µA) when power_now is absent', () => {
    expect(
      parseSuppliesPower([
        { type: 'Mains', online: '0' },
        {
          type: 'Battery',
          status: 'Discharging',
          voltage_now: '11800000',
          current_now: '1500000',
        },
      ]),
    ).toEqual({ batteryWatts: 17.7, batteryState: 'discharging' })
  })

  it('reports 0 W idle when a sensor exists on a full battery and null when no sensor exists', () => {
    expect(
      parseSuppliesPower([
        { type: 'Mains', online: '1' },
        { type: 'Battery', status: 'Full', power_now: '0' },
      ]),
    ).toEqual({ batteryWatts: 0, batteryState: 'idle' })

    expect(
      parseSuppliesPower([{ type: 'Battery', status: 'Discharging', capacity: '64' }]),
    ).toBeNull()
    expect(parseSuppliesPower([{ type: 'Mains', online: '1' }])).toBeNull()
  })
})

describe('parseWindowsBatteryPower', () => {
  it('parses single-battery and multi-battery JSON payloads in milliwatts', () => {
    expect(
      parseWindowsBatteryPower(
        JSON.stringify({ Charging: false, Discharging: true, ChargeRate: 0, DischargeRate: 15420 }),
      ),
    ).toEqual({
      systemWatts: null,
      cpuWatts: null,
      batteryWatts: 15.4,
      batteryState: 'discharging',
    })

    expect(
      parseWindowsBatteryPower(
        JSON.stringify([
          { Charging: true, Discharging: false, ChargeRate: 18500, DischargeRate: 0 },
          { Charging: true, Discharging: false, ChargeRate: 11500, DischargeRate: 0 },
        ]),
      ),
    ).toEqual({
      systemWatts: null,
      cpuWatts: null,
      batteryWatts: 30,
      batteryState: 'charging',
    })

    expect(
      parseWindowsBatteryPower(
        JSON.stringify({ Charging: false, Discharging: false, ChargeRate: 0, DischargeRate: 0 }),
      ),
    ).toEqual({
      systemWatts: null,
      cpuWatts: null,
      batteryWatts: 0,
      batteryState: 'idle',
    })
  })

  it('ignores BATTERY_UNKNOWN_RATE sentinels and returns null for desktops or invalid output', () => {
    expect(
      parseWindowsBatteryPower(
        JSON.stringify({
          Charging: false,
          Discharging: true,
          ChargeRate: 0,
          DischargeRate: 4294967295,
        }),
      ),
    ).toBeNull()
    expect(parseWindowsBatteryPower('')).toBeNull()
    expect(parseWindowsBatteryPower('not json')).toBeNull()
  })
})

describe('SystemReader power integration', () => {
  it('omits power on desktop Macs without AppleSmartBattery and caches absence until forget()', async () => {
    const readCommand = vi.fn(async (file: string) => {
      if (file === '/usr/bin/pmset') return "Now drawing from 'AC Power'\n"
      return ''
    })
    const reader = new SystemReader({
      platform: 'darwin',
      folders: () => [],
      onBattery: () => null,
      readMemory: async () => ({ state: 'plenty', available: 50 }),
      readCommand,
      log: () => {},
    })
    const sample = { cpu: { at: 0, busy: 10, total: 100 }, io: null, network: null }
    const next = { cpu: { at: 2_000, busy: 30, total: 200 }, io: null, network: null }

    const first = await reader.read(sample, next)
    expect('power' in first).toBe(false)
    const ioregCallsAfterFirst = readCommand.mock.calls.filter(([file]) =>
      file.includes('ioreg'),
    ).length
    expect(ioregCallsAfterFirst).toBe(1)

    await reader.read(sample, next)
    const ioregCallsAfterSecond = readCommand.mock.calls.filter(([file]) =>
      file.includes('ioreg'),
    ).length
    expect(ioregCallsAfterSecond).toBe(1)

    reader.forget()
    await reader.read(sample, next)
    const ioregCallsAfterForget = readCommand.mock.calls.filter(([file]) =>
      file.includes('ioreg'),
    ).length
    expect(ioregCallsAfterForget).toBe(2)
  })

  it('combines Linux RAPL CPU watts and power_supply battery watts cleanly without warning on EACCES', async () => {
    const logs: string[] = []
    const raplSamples: (RaplSample | null)[] = [
      {
        at: 1_000,
        packages: new Map([['intel-rapl:0', { energyUj: 10_000_000, maxEnergyRangeUj: null }]]),
      },
      {
        at: 3_000,
        packages: new Map([['intel-rapl:0', { energyUj: 44_000_000, maxEnergyRangeUj: null }]]),
      },
    ]
    let raplIdx = 0
    const reader = new SystemReader({
      platform: 'linux',
      folders: () => [],
      onBattery: () => null,
      readMemory: async () => ({ state: 'plenty', available: 60 }),
      readRapl: async () => raplSamples[raplIdx++] ?? null,
      readSupplies: async () => [
        { type: 'Mains\n', online: '0\n' },
        {
          type: 'Battery\n',
          status: 'Discharging\n',
          capacity: '55\n',
          power_now: '18500000\n',
        },
      ],
      log: (_, message) => logs.push(message),
    })

    const from = {
      cpu: { at: 1_000, busy: 10, total: 100 },
      io: null,
      network: null,
      rapl: raplSamples[0],
    }
    const to = {
      cpu: { at: 3_000, busy: 40, total: 200 },
      io: null,
      network: null,
      rapl: raplSamples[1],
    }
    const load = await reader.read(from, to)
    expect(load.power).toEqual({
      systemWatts: null,
      cpuWatts: 17,
      batteryWatts: 18.5,
      batteryState: 'discharging',
    })
    expect(load.battery).toEqual({ percent: 55, charging: false, onBattery: true })
    expect(logs).toEqual([])
  })

  it('falls back silently on Windows when BatteryStatus WMI query fails', async () => {
    const logs: string[] = []
    const readCommand = vi.fn(async () => {
      throw new Error('Access denied')
    })
    const reader = new SystemReader({
      platform: 'win32',
      folders: () => [],
      onBattery: () => false,
      readMemory: async () => ({ state: 'plenty', available: 70 }),
      readCommand,
      log: (_, message) => logs.push(message),
    })
    const from = { cpu: { at: 0, busy: 10, total: 100 }, io: null, network: null }
    const to = { cpu: { at: 2_000, busy: 20, total: 200 }, io: null, network: null }

    const first = await reader.read(from, to)
    expect('power' in first).toBe(false)
    expect(logs).toEqual([])
    expect(readCommand).toHaveBeenCalledTimes(1)

    // Subsequent reads in the same watch do not respawn PowerShell after unavailability.
    const second = await reader.read(from, to)
    expect('power' in second).toBe(false)
    expect(readCommand).toHaveBeenCalledTimes(1)
  })
})
