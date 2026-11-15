// The daily round trip report: what a client timed to each region on a local day, how often it
// connected through each and how often that failed, sent to the main relay once the day is over,
// with no host or device id. Imports nothing of Node.js, since browsers run it too.

import { percentiles } from './relay-regions'

export type ReportApp = 'desktop' | 'daemon' | 'web' | 'ios'

export interface RegionReport {
  id: string
  rttMedian: number
  rttP90: number
  connects: number
  failures: number
}

/** What `POST /v1/reports` takes. */
export interface RelayReportBody {
  v: 1
  /** The local day the numbers are for, `YYYY-MM-DD`. */
  day: string
  app: ReportApp
  regions: RegionReport[]
  p2p: { attempts: number; opened: number }
}

interface RegionDay {
  rtts: number[]
  connects: number
  failures: number
}

/** One local day's numbers. */
export interface DayStats {
  day: string
  regions: Record<string, RegionDay>
  p2p: { attempts: number; opened: number }
}

/** What is kept between runs. */
export interface RelayStatsState {
  /** The day being counted. */
  current: DayStats | null
  /** The day before it, not sent yet. */
  pending: DayStats | null
  /** The local day a report was last sent on. */
  sentOn: string | null
}

/** Round trips kept per region and day; later ones replace the oldest. */
const MAX_SAMPLES = 500
/** Regions counted per day. */
const MAX_REGIONS = 16
const DAY = /^\d{4}-\d{2}-\d{2}$/
const REGION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/** The local day of a time, `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The local day before `day`. */
export function dayBefore(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return localDay(new Date(year, month - 1, date - 1, 12).getTime())
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function parseDay(value: unknown): DayStats | null {
  if (typeof value !== 'object' || value === null) return null
  const { day, regions, p2p } = value as Record<string, unknown>
  if (typeof day !== 'string' || !DAY.test(day)) return null
  if (typeof regions !== 'object' || regions === null) return null
  const kept: Record<string, RegionDay> = {}
  for (const [id, entry] of Object.entries(regions).slice(0, MAX_REGIONS)) {
    const { rtts, connects, failures } = (entry ?? {}) as Record<string, unknown>
    if (!REGION_ID.test(id) || !Array.isArray(rtts) || !isCount(connects) || !isCount(failures)) {
      return null
    }
    kept[id] = { rtts: rtts.filter(isCount).slice(-MAX_SAMPLES), connects, failures }
  }
  const { attempts, opened } = (p2p ?? {}) as Record<string, unknown>
  return {
    day,
    regions: kept,
    p2p: { attempts: isCount(attempts) ? attempts : 0, opened: isCount(opened) ? opened : 0 },
  }
}

/** Stats a run before kept, or none when they are not that. */
export function parseRelayStats(value: unknown): RelayStatsState | null {
  if (typeof value !== 'object' || value === null) return null
  const { current, pending, sentOn } = value as Record<string, unknown>
  return {
    current: parseDay(current),
    pending: parseDay(pending),
    sentOn: typeof sentOn === 'string' && DAY.test(sentOn) ? sentOn : null,
  }
}

/** The report of a day: each region timed that day, with its connects and failures. */
export function reportBody(stats: DayStats, app: ReportApp): RelayReportBody {
  const regions: RegionReport[] = []
  for (const [id, entry] of Object.entries(stats.regions)) {
    const rtt = percentiles(entry.rtts)
    // The report carries a region's round trip; one never timed that day has none to give.
    if (!rtt) continue
    regions.push({
      id,
      rttMedian: rtt.median,
      rttP90: rtt.p90,
      connects: entry.connects,
      failures: entry.failures,
    })
  }
  return { v: 1, day: stats.day, app, regions, p2p: { ...stats.p2p } }
}

export interface RelayStatsOptions {
  state?: RelayStatsState | null
  save(state: RelayStatsState): void
  now?: () => number
}

/** Counts the day as it goes, and says when the day before is due to be reported. */
export class RelayStats {
  private state: RelayStatsState
  private readonly now: () => number

  constructor(private readonly options: RelayStatsOptions) {
    this.now = options.now ?? Date.now
    this.state = options.state ?? { current: null, pending: null, sentOn: null }
  }

  /** A round trip to a region, in milliseconds. */
  sample(id: string, rtt: number): void {
    const region = this.region(id)
    if (!region) return
    region.rtts.push(Math.round(rtt))
    if (region.rtts.length > MAX_SAMPLES) region.rtts.shift()
    this.save()
  }

  /** A connection through a region, made or failed. */
  connected(id: string, ok: boolean): void {
    const region = this.region(id)
    if (!region) return
    if (ok) region.connects++
    else region.failures++
    this.save()
  }

  /** A direct connection tried by punching through NAT, opened or not. */
  punched(opened: boolean): void {
    const day = this.today()
    day.p2p.attempts++
    if (opened) day.p2p.opened++
    this.save()
  }

  /** The report due now: the day before today's, once a local day; null when none is. */
  due(app: ReportApp): RelayReportBody | null {
    this.roll()
    const today = localDay(this.now())
    const { pending, sentOn } = this.state
    if (!pending || sentOn === today) return null
    const body = reportBody(pending, app)
    return body.regions.length > 0 || body.p2p.attempts > 0 ? body : null
  }

  /** The report of `day` reached the relay, or will never be taken: none more today. */
  sent(day: string): void {
    if (this.state.pending?.day === day) this.state.pending = null
    this.state.sentOn = localDay(this.now())
    this.save()
  }

  private region(id: string): RegionDay | null {
    if (!REGION_ID.test(id)) return null
    const day = this.today()
    const kept = day.regions[id]
    if (kept) return kept
    if (Object.keys(day.regions).length >= MAX_REGIONS) return null
    return (day.regions[id] = { rtts: [], connects: 0, failures: 0 })
  }

  private today(): DayStats {
    this.roll()
    const day = localDay(this.now())
    return (this.state.current ??= { day, regions: {}, p2p: { attempts: 0, opened: 0 } })
  }

  /** A new day: the one before becomes due, and anything older than it goes unsent. */
  private roll(): void {
    const today = localDay(this.now())
    const { current, pending } = this.state
    if (pending && pending.day !== dayBefore(today)) this.state.pending = null
    if (!current || current.day === today) return
    this.state.pending = current.day === dayBefore(today) ? current : null
    this.state.current = null
    this.save()
  }

  private save(): void {
    this.options.save(this.state)
  }
}
