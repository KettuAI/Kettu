// A client's region list and what it measured: the main relay's signed list for this client's
// location, read again every 10 minutes with its ETag and at once when a region fails; the round
// trip to each region, measured while the client is in the foreground; and, as a device, the
// regions each host is signed in to with the host's leg, ranked by the whole path. Shared by the
// remote host, the web client and their tests; the caller brings the network.

import { pingPath, regionsPath, type RelayRegion } from './relay'
import {
  MEASURE_EVERY_MS,
  PREFERRED_REGIONS,
  REGIONS_CHECK_MS,
  REGIONS_RETRY_GAP_MS,
  RegionSerial,
  asRelay,
  DRAINED_MS,
  fastestRegions,
  parseSignedRegionList,
  rankRegions,
  serializeRelayPreference,
  verifyRegionList,
  type HostLegRegion,
  type ListedRegion,
  type RankedRegion,
  type RegionList,
  type RelayPreferMessage,
  type RelayPreference,
  type RelayRegionsMessage,
  type SignedRegionList,
} from './relay-regions'

type Log = (level: 'info' | 'warn' | 'error', message: string) => void

/** What a read of `GET /v1/regions` answered: 304 when the ETag still holds. */
export interface RegionListAnswer {
  status: number
  etag: string | null
  body: unknown
}

/** The list kept between runs, verified again when it is read back. */
export interface SavedRegionList {
  signed: SignedRegionList
  etag: string | null
  /** The newest serial seen, of any list. */
  serial: number
}

export function parseSavedRegionList(value: unknown): SavedRegionList | null {
  if (typeof value !== 'object' || value === null) return null
  const { signed, etag, serial } = value as Record<string, unknown>
  const list = parseSignedRegionList(signed)
  if (!list || (etag !== null && typeof etag !== 'string')) return null
  if (typeof serial !== 'number' || !Number.isSafeInteger(serial)) return null
  return { signed: list, etag, serial }
}

export interface RegionSourceOptions {
  /** The main relay's origin. */
  main: string
  /** Reads the list, sending `If-None-Match` with `etag` when there is one; rejects offline. */
  fetchList(url: string, etag: string | null): Promise<RegionListAnswer>
  keys?: Readonly<Record<string, string>>
  /** What a run before kept. */
  saved?: SavedRegionList | null
  save?(saved: SavedRegionList): void
  /** The list changed. */
  changed(): void
  log: Log
  checkMs?: number
  retryGapMs?: number
  now?: () => number
}

/** The main relay's list for this client, kept current. */
export class RegionSource {
  list: RegionList | null = null
  signed: SignedRegionList | null = null
  readonly serial = new RegionSerial()
  private etag: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private reading: Promise<void> | null = null
  private lastRead = -Infinity
  /** Whether it reads at all: only while the relay may be used. */
  private running = false
  private readonly now: () => number

  constructor(readonly options: RegionSourceOptions) {
    this.now = options.now ?? Date.now
  }

  get main(): string {
    return this.options.main
  }

  /** Takes back what a run before kept, when it still verifies. */
  async load(): Promise<void> {
    const saved = this.options.saved
    if (!saved) return
    this.serial.take(saved.serial)
    const list = await verifyRegionList(saved.signed, this.main, this.options.keys)
    if (!list || list.serial < this.serial.current || this.list) return
    this.list = list
    this.signed = saved.signed
    this.etag = saved.etag
  }

  /** Reads now, then every 10 minutes, until stopped. */
  start(): void {
    if (this.running) return
    this.running = true
    if (!this.reading) void this.read()
  }

  /** Reads no more until started again; the list held stays. */
  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** A region could not be reached, or said it drains: reads now, unless it just did. */
  failed(): void {
    if (!this.running || this.reading) return
    if (this.now() - this.lastRead < (this.options.retryGapMs ?? REGIONS_RETRY_GAP_MS)) return
    void this.read()
  }

  /** Reads now whatever the gap, resolving once it is read. */
  refresh(): Promise<void> {
    if (!this.running) return Promise.resolve()
    return this.reading ?? this.read()
  }

  /**
   * A list a host or a device forwarded, for the regions it names: verified, and refused below
   * the newest serial. A newer serial than this client's own list means the main relay has a
   * newer one for here too, which is read now.
   */
  async verify(value: unknown): Promise<RegionList | null> {
    const list = await verifyRegionList(value, this.main, this.options.keys)
    if (!list || !this.serial.take(list.serial)) return null
    if (this.list && list.serial > this.list.serial) this.failed()
    return list
  }

  private read(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.lastRead = this.now()
    this.reading = (async () => {
      try {
        await this.fetch()
      } catch (error) {
        // The list kept stays.
        this.options.log('warn', `Cannot read the relay regions: ${(error as Error).message}`)
      }
      this.reading = null
      if (!this.running) return
      this.timer = setTimeout(() => {
        this.timer = null
        void this.read()
      }, this.options.checkMs ?? REGIONS_CHECK_MS)
    })()
    return this.reading
  }

  private async fetch(): Promise<void> {
    const answer = await this.options.fetchList(`${this.main}${regionsPath()}`, this.etag)
    if (answer.status === 304) return
    // A relay without the list answers 404: the regions of `GET /v1` stay in use.
    if (answer.status !== 200) throw new Error(`it answered ${answer.status}`)
    const signed = parseSignedRegionList(answer.body)
    const list = signed && (await verifyRegionList(signed, this.main, this.options.keys))
    if (!signed || !list) throw new Error('the list does not verify')
    if (!this.serial.take(list.serial)) {
      throw new Error(`its serial ${list.serial} is below ${this.serial.current}`)
    }
    const same =
      this.signed?.payload === signed.payload && this.signed.signature === signed.signature
    this.list = list
    this.signed = signed
    this.etag = answer.etag
    this.options.save?.({ signed, etag: answer.etag, serial: this.serial.current })
    if (!same) this.options.changed()
  }
}

/**
 * Times a region: one request to open the connection, then the round trip of a second on it.
 * Null when either fails.
 */
export async function timeRegion(
  ping: () => Promise<void>,
  now: () => number = Date.now,
): Promise<number | null> {
  try {
    await ping()
    const start = now()
    await ping()
    return Math.max(0, Math.round(now() - start))
  } catch {
    return null
  }
}

export interface RegionTimesOptions {
  /** One `GET /v1/ping` on the region, through its pin when it has one; rejects when it fails. */
  ping(region: RelayRegion, url: string): Promise<void>
  /** Whether measuring may happen now: in the foreground. */
  active?(): boolean
  /** A region was timed, or could not be. */
  measured?(region: RelayRegion, rtt: number | null): void
  /** The round trips changed. */
  changed(): void
  everyMs?: number
  /** How many regions are timed at once. */
  concurrency?: number
  now?: () => number
}

/** This device's leg to each region: the last round trip timed, by origin. */
export class RegionTimes {
  private readonly times = new Map<string, { rtt: number | null; at: number }>()
  private readonly running = new Set<string>()
  private readonly now: () => number

  constructor(readonly options: RegionTimesOptions) {
    this.now = options.now ?? Date.now
  }

  rtt(region: { url: string }): number | null {
    return this.times.get(region.url)?.rtt ?? null
  }

  /**
   * Times the regions not timed within the last few hours, or all of them with `all`, as for a
   * new list; skipped while in the background.
   */
  async measure(regions: readonly RelayRegion[], all = false): Promise<void> {
    if (this.options.active && !this.options.active()) return
    const every = this.options.everyMs ?? MEASURE_EVERY_MS
    const due = regions.filter((region) => {
      if (this.running.has(region.url)) return false
      const last = this.times.get(region.url)
      return all || !last || this.now() - last.at >= every
    })
    if (due.length === 0) return
    for (const region of due) this.running.add(region.url)
    let next = 0
    let changed = false
    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const region = due[next++]!
        const rtt = await timeRegion(
          () => this.options.ping(region, `${region.url}${pingPath()}`),
          this.now,
        )
        this.running.delete(region.url)
        const before = this.times.get(region.url)?.rtt ?? null
        this.times.set(region.url, { rtt, at: this.now() })
        this.options.measured?.(region, rtt)
        if (rtt !== before) changed = true
      }
    }
    const workers = Math.min(due.length, this.options.concurrency ?? 4)
    await Promise.all(Array.from({ length: workers }, worker))
    if (changed) this.options.changed()
  }

  /** Whether a region was timed within the last few hours. */
  fresh(region: RelayRegion): boolean {
    const last = this.times.get(region.url)
    return !!last && this.now() - last.at < (this.options.everyMs ?? MEASURE_EVERY_MS)
  }
}

export interface DeviceRegionsOptions {
  source: RegionSource
  times: RegionTimes
  /** Whether regions with a pin may be used: never in a browser. */
  pinned: boolean
  /** Initial client relay preference; defaults to automatic fastest-path selection. */
  preference?: RelayPreference
  /** How long a region that said it drains is tried last. */
  drainedMs?: number
  now?: () => number
}

/** As a device: what each host said of its regions, ranked by the whole path. */
export class DeviceRegions {
  private readonly hosts = new Map<string, HostLegRegion[]>()
  private readonly drained = new Map<string, number>()
  private readonly now: () => number
  private preference: RelayPreference

  constructor(readonly options: DeviceRegionsOptions) {
    this.now = options.now ?? Date.now
    this.preference = options.preference ?? { kind: 'automatic' }
  }

  /** Current client relay preference. */
  getPreference(): RelayPreference {
    return this.preference
  }

  /** Updates the client relay preference; returns true when the effective value changed. */
  setPreference(next: RelayPreference): boolean {
    if (serializeRelayPreference(this.preference) === serializeRelayPreference(next)) {
      return false
    }
    this.preference = next
    return true
  }

  /**
   * A host's `relay.regions`: its list verified, each region resolved through that list or this
   * device's own; regions this device cannot use are left out. The regions resolved, which may
   * need timing.
   */
  async received(host: string, message: RelayRegionsMessage): Promise<RelayRegion[]> {
    const { source } = this.options
    const forwarded = await source.verify(message.list)
    const lists = [forwarded, source.list].filter((list): list is RegionList => list !== null)
    const resolved: HostLegRegion[] = []
    for (const { id, rtt } of message.regions) {
      let region: ListedRegion | undefined
      for (const list of lists) {
        region = list.regions.find((entry) => entry.id === id)
        if (region) break
      }
      if (!region || region.state !== 'active') continue
      if (region.pin && !this.options.pinned) continue
      resolved.push({ ...asRelay(region), hostRtt: rtt })
    }
    // A list that did not verify leaves what the host said before, unless this one resolved.
    if (resolved.length > 0 || forwarded) this.hosts.set(host, resolved)
    return resolved
  }

  /** The host's regions in the order to try them; null before the host said. */
  ranked(host: string): RankedRegion[] | null {
    const regions = this.hosts.get(host)
    if (!regions) return null
    const now = this.now()
    const ranked = rankRegions(regions, (region) => this.options.times.rtt(region))
    const drained = (region: RelayRegion): boolean => (this.drained.get(region.url) ?? 0) > now
    const active = ranked.filter((region) => !drained(region))
    const draining = ranked.filter(drained)
    if (this.preference.kind === 'official') {
      const targetId = this.preference.id
      const index = active.findIndex(
        (region) =>
          region.id === targetId ||
          (targetId === 'main' && region.url === this.options.source.main),
      )
      if (index > 0) {
        const chosen = active[index]!
        active.splice(index, 1)
        active.unshift(chosen)
      }
    }
    return [...active, ...draining]
  }

  /** A region said it drains: tried last for a while. */
  drain(url: string): void {
    this.drained.set(url, this.now() + (this.options.drainedMs ?? DRAINED_MS))
  }

  forget(host: string): void {
    this.hosts.delete(host)
  }

  /** What to tell a host: this device's preferred or fastest regions with its list. */
  prefer(): RelayPreferMessage | null {
    const { list, signed } = this.options.source
    if (!list || !signed) return null
    const fastest = fastestRegions(list, (region) => this.options.times.rtt(region), {
      pinned: this.options.pinned,
    })
    if (this.preference.kind === 'official' && this.preference.id !== 'main') {
      const targetId = this.preference.id
      const chosen = list.regions.find(
        (region) =>
          region.id === targetId &&
          region.state === 'active' &&
          (this.options.pinned || !region.pin),
      )
      if (chosen) {
        const regions = [chosen.id, ...fastest.filter((id) => id !== chosen.id)].slice(
          0,
          PREFERRED_REGIONS,
        )
        return { type: 'relay.prefer', regions, list: signed }
      }
    }
    return fastest.length > 0 ? { type: 'relay.prefer', regions: fastest, list: signed } : null
  }

  /** The regions of this device's own list worth timing: active and probe, usable here. */
  ownRegions(): RelayRegion[] {
    return (this.options.source.list?.regions ?? [])
      .filter((region) => this.options.pinned || !region.pin)
      .map(asRelay)
  }
}
