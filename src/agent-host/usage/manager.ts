// Usage in the host: writes OverBench's record, schedules the log scans while Usage on this
// computer is on, picks the source each agent counts from, and answers the page.

import type { Platform } from '@shared/platform'
import { AGENT_IDS, type AgentId } from '@shared/thread'
import {
  partsTotal,
  type ScanProgress,
  type UsageLogStatus,
  type UsageScope,
  type UsageStatus,
  type UsageSummary,
  type UsageTotal,
} from '@shared/usage'
import type { LogFn } from '../storage'
import type { SourceMap, SourceStats } from './db'
import type { LogReader, UsageRow } from './model'
import type { ScanResult } from './protocol'
import type { UsageStore } from './store'

export interface UsageTimings {
  /** After launch, how long the first scan waits for startup to settle. */
  firstScanMs: number
  intervalMs: number
}

const TIMINGS: UsageTimings = { firstScanMs: 8_000, intervalMs: 10 * 60_000 }

export interface UsageManagerDeps {
  store: UsageStore | null
  readers: readonly LogReader[]
  fromComputer: boolean
  platform: Platform
  home: string
  /** The resolved agent environment, once it is ready. */
  env(): Promise<Record<string, string | undefined>>
  /** Whether a folder is one of OverBench's No project folders. */
  isScratch(path: string): boolean
  log: LogFn
  changed(): void
  status(status: UsageStatus): void
  now?: () => number
  timings?: Partial<UsageTimings>
}

interface LogState {
  found: boolean | null
  syncedAt: number | null
  error: string | null
}

export class UsageManager {
  private fromComputer: boolean
  private readonly timings: UsageTimings
  private readonly now: () => number
  private progress: ScanProgress | null = null
  private readonly logs = new Map<AgentId, LogState>()
  private stats: SourceStats[] = []
  private unavailable = false
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private scanning: Promise<void> | null = null
  private stopped = false
  /** The environment the locations are shown with; the readers see the same one. */
  private env: Record<string, string | undefined> = {}

  constructor(private readonly deps: UsageManagerDeps) {
    this.fromComputer = deps.fromComputer
    this.timings = { ...TIMINGS, ...deps.timings }
    this.now = deps.now ?? Date.now
    for (const reader of deps.readers) {
      this.logs.set(reader.agentId, { found: null, syncedAt: null, error: null })
    }
  }

  /** Reads the stored figures, then scans once startup has settled and every interval after. */
  start(): void {
    const { store } = this.deps
    if (!store) {
      this.unavailable = true
      return
    }
    void store.ready.then((status) => {
      this.unavailable = status === 'unavailable' || status === 'newer'
      void this.refreshStats()
    })
    void this.deps.env().then((env) => {
      this.env = env
      this.publish()
    })
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null
      void this.scan()
    }, this.timings.firstScanMs)
    this.interval = setInterval(() => void this.scan(), this.timings.intervalMs)
    this.interval.unref?.()
  }

  /** Stops the timers and any scan, and closes the database. */
  async close(): Promise<void> {
    this.stop()
    await this.deps.store?.close()
  }

  stop(): void {
    this.stopped = true
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.interval) clearInterval(this.interval)
    this.firstTimer = null
    this.interval = null
  }

  /** The setting changed: turning it on starts the first import, off stops a scan. */
  setFromComputer(on: boolean): void {
    if (on === this.fromComputer) return
    this.fromComputer = on
    if (on) void this.scan()
    else void this.deps.store?.cancel().catch(() => {})
    this.publish()
    this.deps.changed()
  }

  /** Adds OverBench's rows for a turn; a failure is logged and the turn goes on. */
  record(rows: UsageRow[]): void {
    if (rows.length === 0 || !this.deps.store) return
    this.deps.store
      .write(rows)
      .catch((error: unknown) =>
        this.deps.log('warn', `Could not record a turn's usage: ${(error as Error).message}`),
      )
  }

  /** Reads what is new in the logs; one scan at a time, and nothing while the setting is off. */
  sync(): Promise<void> {
    return this.scan()
  }

  /** Reads what is new in these agents' logs, after any scan that runs. */
  syncAgents(agentIds: AgentId[]): Promise<void> {
    const agents = agentIds.filter((id) => this.deps.readers.some((r) => r.agentId === id))
    return agents.length > 0 ? this.scan(agents) : Promise.resolve()
  }

  private scan(agents?: AgentId[]): Promise<void> {
    const { store } = this.deps
    if (!store || !this.fromComputer || this.stopped || this.unavailable) {
      return this.scanning ?? Promise.resolve()
    }
    // A full scan asked for while one runs joins it; a scan of chosen agents follows it.
    if (this.scanning && !agents) return this.scanning
    const run = (this.scanning ?? Promise.resolve())
      .then(async () => {
        const env = await this.deps.env()
        this.env = env
        const outcome = await store.scan({
          agents: agents ?? this.deps.readers.map((r) => r.agentId),
          env,
          home: this.deps.home,
          platform: this.deps.platform,
        })
        this.applyResults(outcome.results)
        await this.refreshStats()
      })
      .catch((error: unknown) => {
        this.deps.log('warn', `The usage scan failed: ${(error as Error).message}`)
      })
    const tracked: Promise<void> = run.finally(() => {
      if (this.scanning === tracked) this.scanning = null
    })
    this.scanning = tracked
    return tracked
  }

  private applyResults(results: ScanResult[]): void {
    const at = this.now()
    for (const result of results) {
      this.logs.set(result.agentId, { found: result.found, syncedAt: at, error: result.error })
    }
  }

  /** Forgets an agent's imported history and reads its logs again. */
  async reimport(agentId: AgentId): Promise<void> {
    const { store } = this.deps
    if (!store || !this.deps.readers.some((r) => r.agentId === agentId)) return
    await store.removeLogs(agentId)
    this.logs.set(agentId, { found: null, syncedAt: null, error: null })
    await this.refreshStats()
    this.deps.changed()
    await this.scan([agentId])
  }

  async clearRecord(): Promise<void> {
    await this.deps.store?.clearRecord()
    await this.refreshStats()
    this.deps.changed()
  }

  /** The store wrote rows; the page reads again, once the first days and counts are current. */
  rowsChanged(): void {
    void this.refreshStats().then(() => this.deps.changed())
  }

  progressed(progress: ScanProgress | null): void {
    this.progress = progress
    this.publish()
  }

  private async refreshStats(): Promise<void> {
    const { store } = this.deps
    if (!store) return
    try {
      this.stats = await store.stats()
    } catch {
      // The database is not open; the status says so.
    }
    this.publish()
  }

  private publish(): void {
    if (!this.stopped) this.deps.status(this.status())
  }

  /** The source each agent counts from in a scope. */
  sources(scope: UsageScope): SourceMap {
    const map: SourceMap = {}
    for (const agentId of AGENT_IDS) {
      map[agentId] = scope === 'computer' && this.countsLogs(agentId) ? 'log' : 'overbench'
    }
    return map
  }

  private countsLogs(agentId: AgentId): boolean {
    if (!this.fromComputer) return false
    const state = this.logs.get(agentId)
    if (!state) return false
    // Before this run's first scan, logs imported earlier still count.
    if (state.found === null) {
      return this.stats.some((s) => s.agentId === agentId && s.source === 'log')
    }
    return state.found
  }

  async summary(
    dayStarts: number[],
    from: number,
    to: number,
    scope: UsageScope,
  ): Promise<UsageSummary> {
    const sources = this.sources(scope)
    const { store } = this.deps
    const first = this.stats
      .filter((s) => sources[s.agentId] === s.source)
      .reduce<number | null>((min, s) => (min === null || s.first < min ? s.first : min), null)
    if (!store || this.unavailable) return { days: [], models: [], projects: [], sources, first }
    const summary = await store.summary(dayStarts, from, to, sources)
    const projects = summary.projects.map((p) => ({
      ...p,
      scratch: p.project !== null && this.deps.isScratch(p.project),
    }))
    return { ...summary, projects, sources, first }
  }

  async total(from: number, to: number): Promise<UsageTotal> {
    const { store } = this.deps
    if (!store || this.unavailable) return { total: 0, byAgent: {} }
    const rows = await store.totals(from, to, this.sources('computer'))
    const byAgent: UsageTotal['byAgent'] = {}
    let total = 0
    for (const row of rows) {
      const sum = partsTotal(row)
      byAgent[row.agentId] = (byAgent[row.agentId] ?? 0) + sum
      total += sum
    }
    return { total, byAgent }
  }

  status(): UsageStatus {
    const record = this.stats.filter((s) => s.source === 'overbench')
    const logs: UsageLogStatus[] = this.deps.readers.map((reader) => {
      const state = this.logs.get(reader.agentId)
      const stats = this.stats.find((s) => s.agentId === reader.agentId && s.source === 'log')
      return {
        agentId: reader.agentId,
        locations: reader.locations(this.env, this.deps.home),
        found: state?.found ?? null,
        rows: stats?.rows ?? 0,
        first: stats?.first ?? null,
        last: stats?.last ?? null,
        syncedAt: state?.syncedAt ?? null,
        error: state?.error ?? null,
      }
    })
    return {
      fromComputer: this.fromComputer,
      scanning: this.progress,
      recordSince: record.length > 0 ? Math.min(...record.map((s) => s.first)) : null,
      logs,
      unavailable: this.unavailable,
    }
  }
}
