import { describe, expect, it } from 'vitest'
import {
  coresSample,
  counterRates,
  cpuPercent,
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
  parseSupplies,
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
