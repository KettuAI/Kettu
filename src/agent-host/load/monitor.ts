// When the host reads its load, and who hears it. A client watches with a lease it renews: every
// LOAD_READ_MS the whole computer, and every LOAD_DETAIL_MS what uses it while a client shows that.
// Otherwise once a minute while a client is connected or an agent runs, which also gives idle
// release its memory reading; while only a device that wants to hear the computer runs low could
// see it, once a minute its disks and battery alone; and not at all when nobody could. The last
// hour stays in memory, one point a minute; the strains go to every client as they change, and a
// disk or battery going under a line, or a deeper one, goes to the devices.

import type { HostEvent } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import {
  LOAD_DETAIL_MS,
  LOAD_HISTORY_POINTS,
  LOAD_IDLE_MS,
  LOAD_LEASE_MS,
  LOAD_READ_MS,
  type HostLoad,
  type HostLoadPoint,
  type HostLoadStatus,
  type HostLoadUsage,
  type HostLoadWatch,
  type HostStrain,
} from '@shared/host-load'
import type { MemoryReading } from '../idle-release'
import { attributeUsage, type Listing, type UsageOwners } from './processes'
import { Strains } from './strains'
import { cpuPercent, type CpuSample, type LowRead, type SystemRead } from './system'

const MINUTE = 60_000
/** A CPU sample older than this is no base to measure from: a short one is taken instead. */
const STALE_SAMPLE_MS = MINUTE + 5_000
/** How long the CPU is sampled for when there is no recent sample. */
const SHORT_SAMPLE_MS = 250
/** After a listing to start from, the first breakdown comes this soon. */
const FIRST_DETAIL_MS = 1_000
/** A listing older than this is no base for the next breakdown. */
const STALE_LISTING_MS = 3 * LOAD_DETAIL_MS
/** A client that connects gets a fresh reading when the last is older than this. */
const WAKE_MS = 10_000

/** What the monitor reads the computer with; the system's, or a test's. */
export interface LoadSource {
  cpuSample(): Promise<CpuSample>
  cores(): Promise<number>
  /** Everything but the CPU, given as measured. */
  read(cpu: number): Promise<SystemRead>
  /** The disks and the battery alone. */
  readLow(): Promise<LowRead>
  /** Every process now, or null where they are not read. */
  list(): Promise<Listing> | null
}

export interface OwnersRead {
  owners: UsageOwners
  /** Each terminal's shell, which names it to a client that may not see the terminals. */
  shells: Map<string, string>
  /** Whether devices may see the terminals. */
  devices: boolean
}

export interface LoadMonitorDeps {
  platform: Platform
  source: LoadSource
  /** Whether a read is worth it without a watch: a client is connected, or an agent runs. */
  active(): boolean
  /** Whether a device wants to hear the computer runs low, which keeps the disks and battery read. */
  lowWatch(): boolean
  /** A disk or the battery went under a line, or a deeper one; memory never comes here. */
  low(strain: HostStrain): void
  owners(): Promise<OwnersRead>
  /** Whether the port serves a paired device, which sees the terminals only as the owner allows. */
  isDevice(portId: string): boolean
  send(portIds: string[], event: HostEvent): void
  broadcast(event: HostEvent): void
  /** Each memory reading, for idle release. */
  memory(reading: MemoryReading): void
  log(level: 'info' | 'warn', message: string): void
  now?: () => number
  delay?: (ms: number) => Promise<void>
}

interface Watcher {
  until: number
  detail: boolean
}

interface Bucket {
  minute: number
  cpu: number
  weight: number
  memory: number
}

const round1 = (value: number): number => Math.round(value * 10) / 10

export class LoadMonitor {
  private readonly watchers = new Map<string, Watcher>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private lastLoad: HostLoad | null = null
  private lastReadAt = -Infinity
  /** When the disks and battery were last read alone. */
  private lastLowAt = -Infinity
  /** When a minute's check last found nothing worth reading. */
  private idleCheckAt = -Infinity
  private cpuFrom: CpuSample | null = null
  private reading: Promise<HostLoad> | null = null
  private detailFrom: { listing: Listing; cpu: CpuSample } | null = null
  private detailing: Promise<void> | null = null
  private nextDetailAt = 0
  private lastUsage: { usage: HostLoadUsage; at: number; read: OwnersRead } | null = null
  private history: HostLoadPoint[] = []
  private bucket: Bucket | null = null
  private readonly strains = new Strains()
  private sentStrains = '[]'
  private failures = new Set<string>()
  private ticking = false

  constructor(private readonly deps: LoadMonitorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private delay(ms: number): Promise<void> {
    return this.deps.delay?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Reads now, if it is worth it, and from then on as clients and work call for. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watchers.clear()
  }

  /** A client connected or an agent started: what it shows should be current. */
  wake(): void {
    if (this.stopped || this.watchers.size > 0) return
    if (this.now() - this.lastReadAt < WAKE_MS) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.tick()
  }

  status(): HostLoadStatus {
    return { strains: this.strains.list() }
  }

  /** Starts or renews a port's watch for LOAD_LEASE_MS; `detail` adds what uses the computer. */
  async watch(portId: string, detail: boolean): Promise<HostLoadWatch> {
    const now = this.now()
    this.watchers.set(portId, { until: now + LOAD_LEASE_MS, detail })
    const load =
      this.lastLoad && now - this.lastReadAt < LOAD_READ_MS ? this.lastLoad : await this.readLoad()
    let usage: HostLoadUsage | undefined
    if (detail) {
      const last = this.lastUsage
      if (last && now - last.at < 2 * LOAD_DETAIL_MS) usage = this.forPort(portId, last)
      else if (!this.detailFrom || now - this.detailFrom.listing.at > STALE_LISTING_MS) {
        // The first breakdown needs a listing to measure from.
        await this.readDetail()
      }
    }
    this.schedule()
    return { load, history: this.points(), ...(usage ? { usage } : {}) }
  }

  unwatch(portId: string): void {
    if (this.watchers.delete(portId)) this.schedule()
  }

  portClosed(portId: string): void {
    this.unwatch(portId)
  }

  /** The ports watching now, after their leases are checked. */
  watching(): string[] {
    this.expire()
    return [...this.watchers.keys()]
  }

  private expire(): void {
    const now = this.now()
    for (const [portId, watcher] of this.watchers) {
      if (watcher.until <= now) this.watchers.delete(portId)
    }
  }

  private wantsDetail(): boolean {
    for (const watcher of this.watchers.values()) if (watcher.detail) return true
    return false
  }

  private schedule(): void {
    if (this.stopped || this.ticking) return
    if (this.timer) clearTimeout(this.timer)
    this.expire()
    const now = this.now()
    let due: number
    if (this.watchers.size > 0) {
      due = this.lastReadAt + LOAD_READ_MS
      if (this.wantsDetail()) due = Math.min(due, this.nextDetailAt)
      // A lease that runs out stops the reads then.
      for (const watcher of this.watchers.values()) due = Math.min(due, watcher.until)
    } else {
      due = Math.max(this.lastReadAt, this.lastLowAt, this.idleCheckAt) + LOAD_IDLE_MS
    }
    this.timer = setTimeout(() => void this.tick(), Math.max(0, due - now))
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.stopped) return
    this.ticking = true
    try {
      this.expire()
      const now = this.now()
      if (this.watchers.size === 0) {
        this.detailFrom = null
        this.lastUsage = null
        if (this.deps.active()) await this.readLoad()
        // Only a push needs it: the disks and the battery, nothing more.
        else if (this.deps.lowWatch()) await this.readLow()
        // Nothing to see: the next check is a minute away, as a read would be.
        else this.idleCheckAt = now
        return
      }
      const loadDue = now >= this.lastReadAt + LOAD_READ_MS - 50
      const detailDue = this.wantsDetail() && now >= this.nextDetailAt - 50
      const load = loadDue ? await this.readLoad() : this.lastLoad
      const usage = detailDue ? await this.readDetail() : null
      if (!load || (!loadDue && !usage)) return
      const point = this.points().at(-1)!
      const read = this.lastUsage
      for (const portId of this.watching()) {
        const watcher = this.watchers.get(portId)!
        const shown =
          usage && read && watcher.detail
            ? this.forPort(portId, { usage, read: read.read })
            : undefined
        if (!loadDue && !shown) continue
        this.deps.send([portId], {
          type: 'host.load',
          load,
          point,
          ...(shown ? { usage: shown } : {}),
        })
      }
    } catch (error) {
      this.warnOnce('tick', `Could not read the load: ${(error as Error).message}`)
    } finally {
      this.ticking = false
      this.schedule()
    }
  }

  /** The whole computer now, once at a time. */
  private readLoad(): Promise<HostLoad> {
    this.reading ??= this.measure().finally(() => (this.reading = null))
    return this.reading
  }

  private async measure(): Promise<HostLoad> {
    const { source } = this.deps
    let from = this.cpuFrom
    let to = await source.cpuSample()
    if (!from || to.at - from.at > STALE_SAMPLE_MS) {
      from = to
      await this.delay(SHORT_SAMPLE_MS)
      to = await source.cpuSample()
    }
    this.cpuFrom = to
    const cpu = cpuPercent(from, to)
    const { load, memory } = await source.read(cpu)
    this.lastLoad = load
    this.lastReadAt = this.now()
    this.addPoint(load, Math.max(1, to.at - from.at))
    this.deps.memory(memory)
    this.takeStrains(() => this.strains.read(load))
    return load
  }

  private async readLow(): Promise<void> {
    const read = await this.deps.source.readLow()
    this.lastLowAt = this.now()
    this.takeStrains(() => this.strains.readLow(read))
  }

  /**
   * Reads the strains: every port hears when they changed, and the devices of each disk or battery
   * level that is new. A level ends only once its reading stays back over the line, so each
   * crossing is told once. Memory is not, since idle release makes room first.
   */
  private takeStrains(read: () => void): void {
    const before = this.strains.list()
    read()
    const after = this.strains.list()
    const sent = JSON.stringify(after)
    if (sent !== this.sentStrains) {
      this.sentStrains = sent
      this.deps.broadcast({ type: 'host.status', status: { strains: after } })
    }
    for (const strain of after) {
      if (strain.kind === 'memory') continue
      const was = before.find((s) => s.kind === strain.kind && s.path === strain.path)
      if (!was || (was.level === 'warn' && strain.level === 'critical')) this.deps.low(strain)
    }
  }

  /**
   * What uses the computer since the last listing, once at a time; null the first time, which
   * only takes the listing to measure from, and when another read is under way.
   */
  private async readDetail(): Promise<HostLoadUsage | null> {
    if (this.detailing) {
      await this.detailing
      return null
    }
    const run = this.breakdown().catch((error: unknown) => {
      this.nextDetailAt = this.now() + LOAD_DETAIL_MS
      this.warnOnce('detail', `Could not read what uses the computer: ${(error as Error).message}`)
      return null
    })
    this.detailing = run.then(() => {})
    try {
      return await run
    } finally {
      this.detailing = null
    }
  }

  private async breakdown(): Promise<HostLoadUsage | null> {
    const { source } = this.deps
    const listing = source.list()
    if (!listing) {
      this.nextDetailAt = Infinity
      return null
    }
    const [rows, cpu, cores, read] = await Promise.all([
      listing,
      source.cpuSample(),
      source.cores(),
      this.deps.owners(),
    ])
    const from = this.detailFrom
    this.detailFrom = { listing: rows, cpu }
    if (!from || rows.at - from.listing.at > STALE_LISTING_MS) {
      this.nextDetailAt = this.now() + FIRST_DETAIL_MS
      return null
    }
    this.nextDetailAt = this.now() + LOAD_DETAIL_MS
    const totals = {
      cpu: cpuPercent(from.cpu, cpu),
      memory: this.lastLoad?.memory.used ?? 0,
      cores,
    }
    const usage = attributeUsage(from.listing, rows, read.owners, totals, this.deps.platform)
    this.lastUsage = { usage, read, at: this.now() }
    return usage
  }

  /** A device the owner keeps from the terminals sees each one by its shell, not its tab's name. */
  private forPort(
    portId: string,
    { usage, read }: { usage: HostLoadUsage; read: OwnersRead },
  ): HostLoadUsage {
    if (read.devices || !this.deps.isDevice(portId)) return usage
    return {
      ...usage,
      terminals: usage.terminals.map((terminal) => ({
        ...terminal,
        name: read.shells.get(terminal.terminalId) ?? '',
      })),
    }
  }

  private addPoint(load: HostLoad, weight: number): void {
    const minute = Math.floor(load.at / MINUTE) * MINUTE
    const memory = load.memory.total > 0 ? (load.memory.used / load.memory.total) * 100 : 0
    if (this.bucket && this.bucket.minute !== minute) {
      this.history.push(pointOf(this.bucket))
      this.history = this.history.filter(
        (point) => point.at > minute - LOAD_HISTORY_POINTS * MINUTE,
      )
      this.history = this.history.slice(-(LOAD_HISTORY_POINTS - 1))
      this.bucket = null
    }
    const bucket = (this.bucket ??= { minute, cpu: 0, weight: 0, memory })
    // A minute's CPU is the reads' average, each counted for the time it measured.
    const counted = Math.min(weight, MINUTE)
    bucket.cpu += load.cpu.percent * counted
    bucket.weight += counted
    bucket.memory = memory
  }

  /** The last hour, the minute under way last. */
  private points(): HostLoadPoint[] {
    const since = this.now() - LOAD_HISTORY_POINTS * MINUTE
    const points = this.bucket ? [...this.history, pointOf(this.bucket)] : [...this.history]
    return points.filter((point) => point.at > since)
  }

  private warnOnce(what: string, message: string): void {
    if (this.failures.has(what)) return
    this.failures.add(what)
    this.deps.log('warn', message)
  }
}

function pointOf(bucket: Bucket): HostLoadPoint {
  return {
    at: bucket.minute,
    cpu: round1(bucket.weight > 0 ? bucket.cpu / bucket.weight : 0),
    memory: round1(bucket.memory),
  }
}
