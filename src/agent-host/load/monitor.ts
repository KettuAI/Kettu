// When the host reads its load, and who hears it. A client watches with a lease it renews; while
// any watch lasts the host reads every LOAD_READ_MS and sends each reading to the watching ports.
// Without a watch it reads nothing and keeps nothing, not even the counters to measure from.

import type { HostEvent } from '@shared/agent-host'
import { LOAD_LEASE_MS, LOAD_READ_MS, type HostLoad, type HostLoadWatch } from '@shared/host-load'
import type { LoadSample } from './system'

/** How long the counters are measured over for the first reading of a watch. */
const FIRST_SAMPLE_MS = 250

/** What the monitor reads the computer with; the system's, or a test's. */
export interface LoadSource {
  sample(): Promise<LoadSample>
  read(from: LoadSample, to: LoadSample): Promise<HostLoad>
  /** Drops whatever it kept between reads. */
  forget(): void
}

export interface LoadMonitorDeps {
  source: LoadSource
  send(portIds: string[], event: HostEvent): void
  log(level: 'warn', message: string): void
  now?: () => number
  delay?: (ms: number) => Promise<void>
}

export class LoadMonitor {
  /** Each watching port and when its lease runs out. */
  private readonly watchers = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private from: LoadSample | null = null
  private last: HostLoad | null = null
  private lastAt = -Infinity
  private reading: Promise<HostLoad> | null = null
  /** Bumped when the watches end, so a read under way then keeps nothing. */
  private generation = 0
  private failed = false
  private ticking = false

  constructor(private readonly deps: LoadMonitorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private delay(ms: number): Promise<void> {
    return this.deps.delay?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Starts or renews a port's watch for LOAD_LEASE_MS, answering with the load now. */
  async watch(portId: string): Promise<HostLoadWatch> {
    if (this.stopped) throw new Error('The host is shutting down.')
    const now = this.now()
    this.watchers.set(portId, now + LOAD_LEASE_MS)
    const load = this.last && now - this.lastAt < LOAD_READ_MS ? this.last : await this.read()
    this.schedule()
    return { load }
  }

  unwatch(portId: string): void {
    if (!this.watchers.delete(portId)) return
    if (this.watchers.size === 0) this.idle()
    else this.schedule()
  }

  portClosed(portId: string): void {
    this.unwatch(portId)
  }

  stop(): void {
    this.stopped = true
    this.watchers.clear()
    this.idle()
  }

  /** The ports watching now, after their leases are checked. */
  watching(): string[] {
    this.expire()
    return [...this.watchers.keys()]
  }

  private expire(): void {
    const now = this.now()
    for (const [portId, until] of this.watchers) {
      if (until <= now) this.watchers.delete(portId)
    }
    if (this.watchers.size === 0) this.idle()
  }

  /** Nobody watches: the reads stop and what they kept goes. */
  private idle(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.generation++
    this.from = null
    this.last = null
    this.lastAt = -Infinity
    this.deps.source.forget()
  }

  private schedule(): void {
    if (this.stopped || this.ticking) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.expire()
    if (this.watchers.size === 0) return
    // A lease that runs out stops the reads then.
    let due = this.lastAt + LOAD_READ_MS
    for (const until of this.watchers.values()) due = Math.min(due, until)
    this.timer = setTimeout(() => void this.tick(), Math.max(0, due - this.now()))
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.stopped) return
    this.ticking = true
    try {
      if (this.watching().length === 0) return
      if (this.now() < this.lastAt + LOAD_READ_MS - 50) return
      const load = await this.read()
      const ports = this.watching()
      if (ports.length > 0) this.deps.send(ports, { type: 'host.load', load })
    } catch (error) {
      // Only the failure is said, never a figure.
      if (!this.failed)
        this.deps.log('warn', `Could not read the load: ${(error as Error).message}`)
      this.failed = true
    } finally {
      this.ticking = false
      this.schedule()
    }
  }

  /** The load now, one read at a time. */
  private read(): Promise<HostLoad> {
    this.reading ??= this.measure().finally(() => (this.reading = null))
    return this.reading
  }

  private async measure(): Promise<HostLoad> {
    const { source } = this.deps
    const generation = this.generation
    let from = this.from
    let to = await source.sample()
    if (!from) {
      from = to
      await this.delay(FIRST_SAMPLE_MS)
      to = await source.sample()
    }
    const load = await source.read(from, to)
    this.failed = false
    if (generation === this.generation) {
      this.from = to
      this.last = load
      this.lastAt = this.now()
    }
    return load
  }
}
