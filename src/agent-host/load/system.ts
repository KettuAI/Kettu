// The whole computer's load as the host reads it with Node.js and the system's own small tools:
// CPU from the cores' times, memory as idle release reads it, each volume's free space, the
// battery (`pmset` on macOS, `/sys/class/power_supply` on Linux, only whether it is on battery
// on Windows) and the uptime. A daemon in a container reads its cgroup v2 CPU and memory limits.
// On macOS a volume's free space adds the purgeable space Finder counts as available, which
// `statfs` leaves out.

import { execFile } from 'node:child_process'
import { access, readdir, readFile, readlink, stat, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HostBattery, HostDisk, HostLoad } from '@shared/host-load'
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
  const num = (value: string | undefined): number | null => {
    const n = Number(value?.trim())
    return value !== undefined && Number.isFinite(n) ? n : null
  }
  let now = 0
  let full = 0
  let rate = 0
  let capacities = 0
  let counted = 0
  for (const battery of batteries) {
    const energy = num(battery.energy_now) ?? num(battery.charge_now)
    const top = num(battery.energy_full) ?? num(battery.charge_full)
    const flow = num(battery.power_now) ?? num(battery.current_now)
    if (energy !== null && top !== null && top > 0) {
      now += energy
      full += top
    }
    if (flow !== null) rate += Math.abs(flow)
    const capacity = num(battery.capacity)
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

/** `/proc/<pid>/stat`'s start time, the 22nd field, in clock ticks after boot. */
export function procStartTicks(text: string): number | null {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  const ticks = Number(fields[19])
  return Number.isFinite(ticks) ? ticks : null
}

// The kernel reports times to user space in USER_HZ, 100 on every architecture Linux runs on.
export const CLOCK_TICKS = 100

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

/** What reading the computer needs from the host. */
export interface SystemReaderDeps {
  platform: Platform
  /** The folders whose volumes count: the projects' and Kettu's data folder. */
  folders(): string[]
  /** Whether the computer runs on battery, as main says on Windows; null when unknown. */
  onBattery(): boolean | null
  readMemory?: (platform: Platform) => Promise<MemoryReading>
  log(level: 'info' | 'warn', message: string): void
}

/** The memory as read, for idle release too, and the load's figures. */
export interface SystemRead {
  load: HostLoad
  memory: MemoryReading
}

/** Reads the whole computer; each instance keeps its own CPU sample to measure from. */
export class SystemReader {
  private readonly mounts: Mounts
  private container: Promise<ContainerLimits | null> | null = null
  private failed = new Set<string>()
  /** macOS: purgeable bytes per volume path on top of `statfs`, as last read. */
  private purgeable = new Map<string, number>()
  private purgeableAt = 0
  private purgeableRead: Promise<void> | null = null

  constructor(private readonly deps: SystemReaderDeps) {
    this.mounts = new Mounts(deps.platform)
  }

  /** The cores in use: the container's limit, else the computer's. */
  async cores(): Promise<number> {
    const limits = await this.limits()
    return limits?.cores ?? Math.max(1, os.availableParallelism())
  }

  /** A sample to measure the CPU from, the container's when it has a CPU limit. */
  async cpuSample(): Promise<CpuSample> {
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

  forgetMounts(): void {
    this.mounts.forget()
  }

  /** Reads everything but the CPU, which the caller measures between two samples. */
  async read(cpu: number): Promise<SystemRead> {
    const { platform } = this.deps
    const limits = await this.limits()
    const [memory, disks, battery, uptime] = await Promise.all([
      this.memory(limits),
      this.disks(),
      limits ? Promise.resolve(null) : this.battery(),
      limits ? containerUptime() : Promise.resolve(os.uptime()),
    ])
    const average = os.loadavg()
    const load: HostLoad = {
      at: Date.now(),
      cpu: {
        percent: Math.round(cpu * 10) / 10,
        cores: limits?.cores ?? Math.max(1, os.availableParallelism()),
        ...(platform !== 'win32' ? { loadAverage: average as [number, number, number] } : {}),
      },
      memory: { used: memory.used, total: memory.total, state: memory.reading.state },
      disks,
      ...(battery ? { battery } : {}),
      uptime: Math.round(uptime),
      ...(limits ? { container: true as const } : {}),
    }
    return { load, memory: memory.reading }
  }

  private limits(): Promise<ContainerLimits | null> {
    return (this.container ??= containerLimits(this.deps.platform))
  }

  private async memory(
    limits: ContainerLimits | null,
  ): Promise<{ reading: MemoryReading; used: number; total: number }> {
    if (limits?.memory) {
      const read = await readCgroupMemory()
      if (read) {
        const available = ((read.total - read.used) / read.total) * 100
        return { reading: { state: stateByShare(available), available }, ...read }
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
    return { reading, used: Math.max(0, used), total }
  }

  private async disks(): Promise<HostDisk[]> {
    const seen = new Map<number, HostDisk>()
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
    const disks = [...seen.values()]
    if (this.deps.platform === 'darwin' && disks.length > 0) await this.addPurgeable(disks)
    return disks.sort((a, b) => a.free - b.free)
  }

  private async addPurgeable(disks: HostDisk[]): Promise<void> {
    const stale = Date.now() - this.purgeableAt >= PURGEABLE_MS
    const unread = disks.some((disk) => !this.purgeable.has(disk.path))
    if ((stale || unread) && !this.purgeableRead) {
      const read = this.readPurgeable(disks.map((disk) => ({ ...disk })))
      this.purgeableRead = read.finally(() => (this.purgeableRead = null))
    }
    // Only the first read waits, so the free space never jumps once shown.
    if (unread && this.purgeableRead) await this.purgeableRead
    for (const disk of disks) disk.free += this.purgeable.get(disk.path) ?? 0
  }

  private async readPurgeable(disks: HostDisk[]): Promise<void> {
    this.purgeableAt = Date.now()
    try {
      const available = await macAvailable(disks.map((disk) => disk.path))
      this.purgeable.clear()
      disks.forEach((disk, i) => {
        const value = available[i]
        this.purgeable.set(disk.path, value == null ? 0 : Math.max(0, value - disk.free))
      })
      this.failed.delete('purgeable')
    } catch (error) {
      for (const disk of disks) this.purgeable.set(disk.path, this.purgeable.get(disk.path) ?? 0)
      this.warnOnce('purgeable', `Could not read the purgeable space: ${(error as Error).message}`)
    }
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

/** Seconds since the container's first process started, which the boot's uptime counts from. */
async function containerUptime(): Promise<number> {
  const ticks = procStartTicks(await readFile('/proc/1/stat', 'utf8').catch(() => ''))
  const uptime = os.uptime()
  return ticks === null ? uptime : Math.max(0, uptime - ticks / CLOCK_TICKS)
}
