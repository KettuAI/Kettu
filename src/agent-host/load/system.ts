// The whole computer's load as the host reads it with Node.js and the system's own small tools:
// CPU from the cores' times, memory as idle release reads it, the free space of the fullest volume
// that holds a project or Kettu's data, disk reads and writes (IOKit's block storage statistics on
// macOS, `/proc/diskstats` on Linux), network traffic (`netstat` over the `en*` interfaces on
// macOS, `/proc/net/dev` over those backed by a device on Linux, `netstat -e` on Windows) and the
// battery (`pmset` on macOS, `/sys/class/power_supply` on Linux, only whether it is on battery on
// Windows). A daemon in a container reads its cgroup v2 CPU, memory and disk activity and its own
// network. On macOS a volume's free space adds the purgeable space Finder counts as available,
// which `statfs` leaves out.

import { execFile } from 'node:child_process'
import { access, readdir, readFile, readlink, stat, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HostBattery, HostLoad } from '@shared/host-load'
import type { MemoryState } from '@shared/idle-release'
import type { Platform } from '@shared/platform'
import { readMemory, type MemoryReading } from '../idle-release'

/** Busy and total times of the cores, or a container's CPU use, at one moment. */
export interface CpuSample {
  at: number
  busy: number
  total: number
}

/** The cores' times now, in milliseconds. */
export function coresSample(cpus: os.CpuInfo[] = os.cpus(), at = Date.now()): CpuSample {
  let busy = 0
  let total = 0
  for (const { times } of cpus) {
    const idle = times.idle
    const all = times.user + times.nice + times.sys + times.irq + idle
    busy += all - idle
    total += all
  }
  return { at, busy, total }
}

/** The share of the time between two samples the CPU was busy, 0 to 100. */
export function cpuPercent(from: CpuSample, to: CpuSample): number {
  const total = to.total - from.total
  if (!(total > 0)) return 0
  return clampPercent(((to.busy - from.busy) / total) * 100)
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value))

/** Two byte counters, such as read and written, of each disk or interface, at one moment. */
export interface Counters {
  at: number
  values: Map<string, [number, number]>
}

/**
 * Bytes per second of the two counters between two readings, over the disks or interfaces both
 * have. Null when a counter went back, which a reset or a wrap does, so a reading is skipped
 * rather than shown negative or as a spike; and when the two share none.
 */
export function counterRates(from: Counters, to: Counters): [number, number] | null {
  const seconds = (to.at - from.at) / 1000
  if (!(seconds > 0)) return null
  let first = 0
  let second = 0
  let shared = 0
  for (const [key, [a, b]] of to.values) {
    const before = from.values.get(key)
    if (!before) continue
    const da = a - before[0]
    const db = b - before[1]
    if (!(da >= 0 && db >= 0)) return null
    first += da
    second += db
    shared++
  }
  if (shared === 0) return null
  return [Math.round(first / seconds), Math.round(second / seconds)]
}

const num = (text: string | undefined): number | null => {
  if (text === undefined || !/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * `ioreg -c IOBlockStorageDriver -r -k Statistics -d 1`: the bytes each block storage driver, one
 * per physical disk, has read and written, by the driver's registry id.
 */
export function parseIoreg(text: string): Map<string, [number, number]> {
  const values = new Map<string, [number, number]>()
  for (const block of text.split('+-o ').slice(1)) {
    const id = /\bid (0x[0-9a-f]+)/i.exec(block)?.[1]
    const read = num(/"Bytes \(Read\)"=(\d+)/.exec(block)?.[1])
    const written = num(/"Bytes \(Write\)"=(\d+)/.exec(block)?.[1])
    if (id && read !== null && written !== null) values.set(id, [read, written])
  }
  return values
}

// `/proc/diskstats` counts in sectors of 512 bytes, whatever the disk's own sector size.
const SECTOR_BYTES = 512

/**
 * `/proc/diskstats`: the bytes read and written of the whole disks named, so a partition, or a
 * mapped or RAID device over the disks, is not counted twice.
 */
export function parseDiskstats(
  text: string,
  disks: ReadonlySet<string>,
): Map<string, [number, number]> {
  const values = new Map<string, [number, number]>()
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const name = fields[2]
    if (!name || !disks.has(name)) continue
    const read = num(fields[5])
    const written = num(fields[9])
    if (read !== null && written !== null) {
      values.set(name, [read * SECTOR_BYTES, written * SECTOR_BYTES])
    }
  }
  return values
}

/** cgroup v2 `io.stat`: the bytes the group read and wrote, by device. */
export function parseIoStat(text: string): Map<string, [number, number]> {
  const values = new Map<string, [number, number]>()
  for (const line of text.split('\n')) {
    const [device, ...pairs] = line.trim().split(/\s+/)
    if (!device || !/^\d+:\d+$/.test(device)) continue
    const field = (key: string) =>
      num(pairs.find((pair) => pair.startsWith(`${key}=`))?.slice(key.length + 1))
    const read = field('rbytes')
    const written = field('wbytes')
    if (read !== null && written !== null) values.set(device, [read, written])
  }
  return values
}

const isLoopback = (name: string): boolean => /^lo\d*$/.test(name)

/**
 * `netstat -ibn` on macOS: the bytes each physical interface (`en*`: Wi-Fi, Ethernet, USB and
 * Thunderbolt adapters, tethering) received and sent, from its link row, which every interface has
 * once. A VPN's or proxy's tunnel, a bridge and AWDL carry traffic an `en*` already counts, and a
 * bridge's members are `en*` themselves. The address may be blank, so the columns are read from
 * the right: Ibytes, Opkts, Oerrs, Obytes, Coll.
 */
export function parseNetstat(text: string): Map<string, [number, number]> {
  const values = new Map<string, [number, number]>()
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 8 || !fields[2]?.startsWith('<Link#')) continue
    const name = fields[0]!.replace(/\*$/, '')
    if (!/^en\d+$/.test(name)) continue
    const received = num(fields.at(-5))
    const sent = num(fields.at(-2))
    if (received !== null && sent !== null) values.set(name, [received, sent])
  }
  return values
}

/**
 * `/proc/net/dev`: the bytes the interfaces named received and sent, or, with none named, every
 * interface but loopback, as a container's own are.
 */
export function parseNetDev(
  text: string,
  physical?: ReadonlySet<string>,
): Map<string, [number, number]> {
  const values = new Map<string, [number, number]>()
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim()
    if (!name || (physical ? !physical.has(name) : isLoopback(name))) continue
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
    const received = num(fields[0])
    const sent = num(fields[8])
    if (received !== null && sent !== null) values.set(name, [received, sent])
  }
  return values
}

/**
 * `netstat -e` on Windows: the bytes received and sent, which are the first row of two numbers
 * whatever the language the system writes its labels in.
 */
export function parseNetstatE(text: string): Map<string, [number, number]> {
  for (const line of text.split('\n')) {
    const match = /^\D+?\s(\d+)\s+(\d+)\s*$/.exec(line.trim())
    if (!match) continue
    const received = num(match[1])
    const sent = num(match[2])
    return received !== null && sent !== null
      ? new Map([['all', [received, sent]]])
      : new Map<string, [number, number]>()
  }
  return new Map()
}

// cgroup v2, as a container sees its own group at the root of the mount.
const CGROUP = '/sys/fs/cgroup'

/** `cpu.max`: the quota and period in microseconds, as cores; null without a quota. */
export function parseCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/)
  if (!quota || quota === 'max') return null
  const cores = Number(quota) / Number(period ?? 100_000)
  return Number.isFinite(cores) && cores > 0 ? cores : null
}

/** `cpu.stat`'s `usage_usec`: the CPU time the group used, in microseconds. */
export function parseCpuUsage(text: string): number | null {
  const match = /^usage_usec\s+(\d+)/m.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * The group's memory: `memory.current` less the inactive file cache in `memory.stat`, which the
 * kernel takes back first, out of `memory.max`. Null without a limit.
 */
export function parseCgroupMemory(
  max: string,
  current: string,
  statText: string,
): { used: number; total: number } | null {
  const limit = max.trim()
  if (limit === 'max') return null
  const total = Number(limit)
  const now = Number(current.trim())
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(now)) return null
  const inactive = Number(/^inactive_file\s+(\d+)/m.exec(statText)?.[1] ?? 0)
  return { used: Math.max(0, Math.min(total, now - inactive)), total }
}

// The same lines idle release reads the system's memory by: at least this share available is
// plenty, and under the second critical.
const PLENTY_PERCENT = 20
const CRITICAL_PERCENT = 10

function stateByShare(available: number): MemoryState {
  if (available >= PLENTY_PERCENT) return 'plenty'
  return available >= CRITICAL_PERCENT ? 'tight' : 'critical'
}

/**
 * `pmset -g batt`, such as:
 *
 *     Now drawing from 'Battery Power'
 *      -InternalBattery-0 (id=1234)	45%; discharging; 3:12 remaining present: true
 *
 * Null without an internal battery, as on a desktop Mac or with only a UPS.
 */
export function parsePmset(text: string): HostBattery | null {
  const line = text.split('\n').find((row) => /-InternalBattery/.test(row))
  if (!line) return null
  const percent = /(\d+)%/.exec(line)
  const fields = line
    .slice(line.indexOf('\t') + 1)
    .split(';')
    .map((field) => field.trim().toLowerCase())
  const state = fields[1] ?? ''
  const onBattery = /'battery power'/i.test(text) || state === 'discharging'
  const charging = !onBattery && (state === 'charging' || state === 'finishing charge')
  const time = /(\d+):(\d{2}) remaining/.exec(line)
  const minutes = time ? Number(time[1]) * 60 + Number(time[2]) : null
  return {
    ...(percent ? { percent: Number(percent[1]) } : {}),
    charging,
    onBattery,
    // A full or idle battery says 0:00; only a real estimate is kept.
    ...(minutes !== null && minutes > 0 && (onBattery || charging) ? { minutesLeft: minutes } : {}),
  }
}

/** One supply's files under `/sys/class/power_supply/<name>`, those read. */
export interface PowerSupply {
  type: string
  online?: string
  status?: string
  capacity?: string
  energy_now?: string
  energy_full?: string
  power_now?: string
  charge_now?: string
  charge_full?: string
  current_now?: string
}

/** The batteries and mains of `/sys/class/power_supply` as one battery; null with no battery. */
export function parseSupplies(supplies: PowerSupply[]): HostBattery | null {
  const batteries = supplies.filter((supply) => supply.type.trim() === 'Battery')
  if (batteries.length === 0) return null
  const value = (text: string | undefined): number | null => {
    const n = Number(text?.trim())
    return text !== undefined && Number.isFinite(n) ? n : null
  }
  let now = 0
  let full = 0
  let rate = 0
  let capacities = 0
  let counted = 0
  for (const battery of batteries) {
    const energy = value(battery.energy_now) ?? value(battery.charge_now)
    const top = value(battery.energy_full) ?? value(battery.charge_full)
    const flow = value(battery.power_now) ?? value(battery.current_now)
    if (energy !== null && top !== null && top > 0) {
      now += energy
      full += top
    }
    if (flow !== null) rate += Math.abs(flow)
    const capacity = value(battery.capacity)
    if (capacity !== null) {
      capacities += capacity
      counted++
    }
  }
  const statuses = batteries.map((battery) => battery.status?.trim() ?? '')
  const mains = supplies.filter((supply) => supply.type.trim() === 'Mains')
  const onMains = mains.some((supply) => supply.online?.trim() === '1')
  const discharging = statuses.includes('Discharging')
  const onBattery = mains.length > 0 ? !onMains && discharging : discharging
  const charging = !onBattery && statuses.includes('Charging')
  const percent =
    full > 0
      ? Math.round((now / full) * 100)
      : counted > 0
        ? Math.round(capacities / counted)
        : null
  let minutesLeft: number | null = null
  if (rate > 0 && full > 0) {
    if (onBattery) minutesLeft = Math.round((now / rate) * 60)
    else if (charging) minutesLeft = Math.round(((full - now) / rate) * 60)
  }
  return {
    ...(percent !== null ? { percent: Math.min(100, Math.max(0, percent)) } : {}),
    charging,
    onBattery,
    ...(minutesLeft !== null && minutesLeft > 0 ? { minutesLeft } : {}),
  }
}

const SUPPLY_FILES = [
  'type',
  'online',
  'status',
  'capacity',
  'energy_now',
  'energy_full',
  'power_now',
  'charge_now',
  'charge_full',
  'current_now',
] as const

async function readSupplies(): Promise<PowerSupply[]> {
  const root = '/sys/class/power_supply'
  const names = await readdir(root).catch(() => [] as string[])
  return Promise.all(
    names.map(async (name) => {
      const supply: PowerSupply = { type: '' }
      await Promise.all(
        SUPPLY_FILES.map(async (file) => {
          const text = await readFile(path.join(root, name, file), 'utf8').catch(() => undefined)
          if (text !== undefined) supply[file] = text
        }),
      )
      return supply
    }),
  )
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    )
  })
}

/** The whole disks, which have a device under `/sys/block`, unlike loop, RAM and mapped ones. */
async function wholeDisks(): Promise<Set<string>> {
  const names = await readdir('/sys/block').catch(() => [] as string[])
  const found = await Promise.all(
    names.map((name) =>
      access(`/sys/block/${name}/device`).then(
        () => name,
        () => null,
      ),
    ),
  )
  return new Set(found.filter((name): name is string => name !== null))
}

/**
 * The interfaces backed by a device, virtio's included. A tunnel, bridge, bond, VLAN or veth has
 * none, and what it carries is counted on the interfaces under it.
 */
async function physicalInterfaces(): Promise<Set<string>> {
  const names = await readdir('/sys/class/net').catch(() => [] as string[])
  const found = await Promise.all(
    names.map((name) =>
      access(`/sys/class/net/${name}/device`).then(
        () => name,
        () => null,
      ),
    ),
  )
  return new Set(found.filter((name): name is string => name !== null))
}

interface Mount {
  dev: number
  path: string
  name: string
}

/** Where a path's volume is mounted and what it is called, looked up once per path. */
class Mounts {
  private readonly cache = new Map<string, Mount | null>()
  private macRoot: Promise<{ dataDev: number | null; name: string }> | null = null

  constructor(private readonly platform: Platform) {}

  async of(folder: string): Promise<Mount | null> {
    if (this.cache.has(folder)) return this.cache.get(folder)!
    const found = await this.resolve(folder).catch(() => null)
    this.cache.set(folder, found)
    return found
  }

  /** Paths may have moved between volumes: they are looked up again. */
  forget(): void {
    this.cache.clear()
    this.macRoot = null
  }

  private async resolve(folder: string): Promise<Mount> {
    const { dev } = await stat(folder)
    if (this.platform === 'win32') {
      const root = path.win32.parse(path.win32.resolve(folder)).root
      return { dev, path: root, name: root.replace(/\\$/, '') }
    }
    if (this.platform === 'darwin') {
      const root = await (this.macRoot ??= macRootVolume())
      const rootDev = (await stat('/')).dev
      // The system volume and its data volume share one name and one free space.
      if (dev === rootDev || dev === root.dataDev) return { dev, path: '/', name: root.name }
    }
    let mount = path.resolve(folder)
    for (;;) {
      const parent = path.dirname(mount)
      if (parent === mount) break
      const parentDev = await stat(parent).then(
        (s) => s.dev,
        () => null,
      )
      if (parentDev !== dev) break
      mount = parent
    }
    const name = this.platform === 'darwin' ? path.basename(mount) || mount : mount
    return { dev, path: mount, name }
  }
}

/** The startup volume's name, the link to `/` in `/Volumes`, and its data volume's device. */
async function macRootVolume(): Promise<{ dataDev: number | null; name: string }> {
  const dataDev = await stat('/System/Volumes/Data').then(
    (s) => s.dev,
    () => null,
  )
  let name = '/'
  for (const entry of await readdir('/Volumes').catch(() => [] as string[])) {
    if ((await readlink(path.join('/Volumes', entry)).catch(() => null)) === '/') {
      name = entry
      break
    }
  }
  return { dataDev, name }
}

// Foundation's figure for a volume's space available to important files, which Finder shows.
const MAC_AVAILABLE_SCRIPT = `function run(argv) {
  ObjC.import('Foundation')
  return JSON.stringify(argv.map((p) => {
    const out = Ref()
    const ok = $.NSURL.fileURLWithPath(p).getResourceValueForKeyError(out, $.NSURLVolumeAvailableCapacityForImportantUsageKey, null)
    return ok && out[0] ? Number(out[0].js) : null
  }))
}`

// The purgeable space changes slowly and reading it starts a process, so once a minute is enough.
const PURGEABLE_MS = 60_000
// The battery changes slowly too, and `pmset` costs about as much as the rest of a reading.
const BATTERY_MS = 10_000

/** Each volume's space available to important files, null where it could not be read. */
async function macAvailable(paths: string[]): Promise<(number | null)[]> {
  const text = await run('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    MAC_AVAILABLE_SCRIPT,
    ...paths,
  ])
  const values: unknown = JSON.parse(text)
  if (!Array.isArray(values)) return paths.map(() => null)
  return paths.map((_, i) => {
    const value: unknown = values[i]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  })
}

interface Volume {
  path: string
  name: string
  free: number
  total: number
}

/** What reading the computer needs from the host. */
export interface SystemReaderDeps {
  platform: Platform
  /** The folders whose volumes count: the projects' and Kettu's data folder. */
  folders(): string[]
  /** Whether the computer runs on battery, as main says on Windows; null when unknown. */
  onBattery(): boolean | null
  readMemory?: (platform: Platform) => Promise<MemoryReading>
  log(level: 'warn', message: string): void
}

/** The counters a load is measured between: the CPU's, the disks' and the network's. */
export interface LoadSample {
  cpu: CpuSample
  io: Counters | null
  network: Counters | null
}

/** Reads the whole computer; only the purgeable space and the battery are kept, until `forget`. */
export class SystemReader {
  private readonly mounts: Mounts
  private container: Promise<ContainerLimits | null> | null = null
  private failed = new Set<string>()
  /** macOS: purgeable bytes per volume path on top of `statfs`, as last read. */
  private purgeable = new Map<string, number>()
  private purgeableAt = 0
  private purgeableRead: Promise<void> | null = null
  private batteryRead: { at: number; battery: Promise<HostBattery | null> } | null = null

  constructor(private readonly deps: SystemReaderDeps) {
    this.mounts = new Mounts(deps.platform)
  }

  forgetMounts(): void {
    this.mounts.forget()
  }

  /** Drops what it kept, once nobody watches. */
  forget(): void {
    this.purgeable.clear()
    this.purgeableAt = 0
    this.batteryRead = null
  }

  /** The counters now. */
  async sample(): Promise<LoadSample> {
    const [cpu, io, network] = await Promise.all([
      this.cpuSample(),
      this.counters('io', () => this.ioValues()),
      this.counters('network', () => this.networkValues()),
    ])
    return { cpu, io, network }
  }

  /** The load between two samples, and the rest as it is now. */
  async read(from: LoadSample, to: LoadSample): Promise<HostLoad> {
    const limits = await this.limits()
    const [memory, disk, battery] = await Promise.all([
      this.memory(limits),
      this.disk(),
      limits ? Promise.resolve(null) : this.recentBattery(),
    ])
    const io = from.io && to.io ? counterRates(from.io, to.io) : null
    const network = from.network && to.network ? counterRates(from.network, to.network) : null
    return {
      at: Date.now(),
      cpu: {
        percent: Math.round(cpuPercent(from.cpu, to.cpu) * 10) / 10,
        cores: limits?.cores ?? Math.max(1, os.availableParallelism()),
      },
      memory: { used: memory.used, total: memory.total, state: memory.state },
      ...(disk ? { disk: { name: disk.name, free: disk.free, total: disk.total } } : {}),
      ...(io ? { io: { readPerSecond: io[0], writePerSecond: io[1] } } : {}),
      ...(network ? { network: { receivePerSecond: network[0], sendPerSecond: network[1] } } : {}),
      ...(battery ? { battery } : {}),
      ...(limits ? { container: true as const } : {}),
    }
  }

  private limits(): Promise<ContainerLimits | null> {
    return (this.container ??= containerLimits(this.deps.platform))
  }

  /** A sample to measure the CPU from, the container's when it has a CPU limit. */
  private async cpuSample(): Promise<CpuSample> {
    const limits = await this.limits()
    if (limits?.cores) {
      const usage = parseCpuUsage(await readFile(`${CGROUP}/cpu.stat`, 'utf8'))
      if (usage !== null) {
        const at = Date.now()
        // Busy time in microseconds against the limit's time over the same wall clock.
        return { at, busy: usage, total: at * 1000 * limits.cores }
      }
    }
    return coresSample()
  }

  private async counters(
    what: 'io' | 'network',
    read: () => Promise<Map<string, [number, number]> | null>,
  ): Promise<Counters | null> {
    try {
      const values = await read()
      return values ? { at: Date.now(), values } : null
    } catch (error) {
      this.warnOnce(what, `Could not read the ${what} counters: ${(error as Error).message}`)
      return null
    }
  }

  /** The disks' counters; null where they are not read, on Windows. */
  private async ioValues(): Promise<Map<string, [number, number]> | null> {
    const { platform } = this.deps
    if (await this.limits()) {
      const text = await readFile(`${CGROUP}/io.stat`, 'utf8').catch(() => null)
      return text === null ? null : parseIoStat(text)
    }
    if (platform === 'darwin') {
      return parseIoreg(
        await run('/usr/sbin/ioreg', [
          '-c',
          'IOBlockStorageDriver',
          '-r',
          '-k',
          'Statistics',
          '-d',
          '1',
        ]),
      )
    }
    if (platform === 'linux') {
      const [text, disks] = await Promise.all([readFile('/proc/diskstats', 'utf8'), wholeDisks()])
      return parseDiskstats(text, disks)
    }
    return null
  }

  /** The network's counters, a container's its own since `/proc/net/dev` follows its namespace. */
  private async networkValues(): Promise<Map<string, [number, number]> | null> {
    const { platform } = this.deps
    if (platform === 'darwin') return parseNetstat(await run('/usr/sbin/netstat', ['-ibn']))
    if (platform === 'linux') {
      const text = await readFile('/proc/net/dev', 'utf8')
      if (await this.limits()) return parseNetDev(text)
      // An unmarked container (LXC, some Kubernetes runtimes) has only virtual interfaces.
      const physical = await physicalInterfaces()
      return parseNetDev(text, physical.size > 0 ? physical : undefined)
    }
    if (platform === 'win32') {
      const system = process.env.SystemRoot ?? 'C:\\Windows'
      return parseNetstatE(await run(path.win32.join(system, 'System32', 'netstat.exe'), ['-e']))
    }
    return null
  }

  private async memory(
    limits: ContainerLimits | null,
  ): Promise<{ state: MemoryState; used: number; total: number }> {
    if (limits?.memory) {
      const read = await readCgroupMemory()
      if (read) {
        const available = ((read.total - read.used) / read.total) * 100
        return { state: stateByShare(available), ...read }
      }
    }
    const total = os.totalmem()
    let reading: MemoryReading
    try {
      reading = await (this.deps.readMemory ?? readMemory)(this.deps.platform)
      this.failed.delete('memory')
    } catch (error) {
      this.warnOnce('memory', `Could not read the system's memory: ${(error as Error).message}`)
      reading = { state: 'unknown', available: null }
    }
    const used =
      reading.available === null
        ? total - os.freemem()
        : Math.round(total * (1 - reading.available / 100))
    return { state: reading.state, used: Math.max(0, used), total }
  }

  /** Of the volumes with a project or Kettu's data, the one with the least free space. */
  private async disk(): Promise<Volume | null> {
    const seen = new Map<number, Volume>()
    const folders = [...new Set(this.deps.folders())]
    await Promise.all(
      folders.map(async (folder) => {
        const mount = await this.mounts.of(folder)
        if (!mount || seen.has(mount.dev)) return
        const fs = await statfs(folder).catch(() => null)
        if (!fs || seen.has(mount.dev)) return
        seen.set(mount.dev, {
          path: mount.path,
          name: mount.name,
          free: fs.bavail * fs.bsize,
          total: fs.blocks * fs.bsize,
        })
      }),
    )
    const volumes = [...seen.values()]
    if (this.deps.platform === 'darwin' && volumes.length > 0) await this.addPurgeable(volumes)
    return volumes.sort((a, b) => a.free - b.free)[0] ?? null
  }

  private async addPurgeable(volumes: Volume[]): Promise<void> {
    const stale = Date.now() - this.purgeableAt >= PURGEABLE_MS
    const unread = volumes.some((volume) => !this.purgeable.has(volume.path))
    if ((stale || unread) && !this.purgeableRead) {
      const read = this.readPurgeable(volumes.map((volume) => ({ ...volume })))
      this.purgeableRead = read.finally(() => (this.purgeableRead = null))
    }
    // Only the first read waits, so the free space never jumps once shown.
    if (unread && this.purgeableRead) await this.purgeableRead
    for (const volume of volumes) volume.free += this.purgeable.get(volume.path) ?? 0
  }

  private async readPurgeable(volumes: Volume[]): Promise<void> {
    this.purgeableAt = Date.now()
    try {
      const available = await macAvailable(volumes.map((volume) => volume.path))
      this.purgeable.clear()
      volumes.forEach((volume, i) => {
        const value = available[i]
        this.purgeable.set(volume.path, value == null ? 0 : Math.max(0, value - volume.free))
      })
      this.failed.delete('purgeable')
    } catch (error) {
      for (const volume of volumes) {
        this.purgeable.set(volume.path, this.purgeable.get(volume.path) ?? 0)
      }
      this.warnOnce('purgeable', `Could not read the purgeable space: ${(error as Error).message}`)
    }
  }

  private recentBattery(): Promise<HostBattery | null> {
    const now = Date.now()
    if (!this.batteryRead || now - this.batteryRead.at >= BATTERY_MS) {
      this.batteryRead = { at: now, battery: this.battery() }
    }
    return this.batteryRead.battery
  }

  private async battery(): Promise<HostBattery | null> {
    try {
      if (this.deps.platform === 'darwin')
        return parsePmset(await run('/usr/bin/pmset', ['-g', 'batt']))
      if (this.deps.platform === 'linux') return parseSupplies(await readSupplies())
    } catch (error) {
      this.warnOnce('battery', `Could not read the battery: ${(error as Error).message}`)
      return null
    }
    // Windows: only whether it runs on battery, which main tells.
    return this.deps.onBattery() ? { charging: false, onBattery: true } : null
  }

  private warnOnce(what: string, message: string): void {
    if (this.failed.has(what)) return
    this.failed.add(what)
    this.deps.log('warn', message)
  }
}

interface ContainerLimits {
  /** The CPU limit in cores; null without one. */
  cores: number | null
  /** Whether the group has a memory limit. */
  memory: boolean
}

/** A daemon in a Linux container, with the cgroup v2 limits it runs under; null outside one. */
async function containerLimits(platform: Platform): Promise<ContainerLimits | null> {
  if (platform !== 'linux') return null
  const marked = await Promise.any(
    ['/.dockerenv', '/run/.containerenv'].map((file) => access(file)),
  ).then(
    () => true,
    () => false,
  )
  if (!marked) return null
  const cpuMax = await readFile(`${CGROUP}/cpu.max`, 'utf8').catch(() => null)
  const memoryMax = await readFile(`${CGROUP}/memory.max`, 'utf8').catch(() => null)
  return {
    cores: cpuMax === null ? null : parseCpuMax(cpuMax),
    memory: memoryMax !== null && memoryMax.trim() !== 'max',
  }
}

async function readCgroupMemory(): Promise<{ used: number; total: number } | null> {
  const [max, current, statText] = await Promise.all(
    ['memory.max', 'memory.current', 'memory.stat'].map((file) =>
      readFile(`${CGROUP}/${file}`, 'utf8').catch(() => ''),
    ),
  )
  return parseCgroupMemory(max!, current!, statText!)
}
