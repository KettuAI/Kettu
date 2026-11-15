// The remote host's relay regions, for both of its sides. It keeps the main relay's signed list for
// this computer's location and what the main relay offers. As a host, it picks the regions to sign
// in to from that list and from the regions its devices prefer, kept per device for 30 days, and
// tells devices its list and its leg to each region. As a device, it times its own leg to each
// region, tells hosts its fastest, and ranks a host's regions by the whole path. It counts the day
// for the round trip report and sends it once the day is over. A region at an IP address is used
// only with a relay token, which is all such a region ever gets.

import path from 'node:path'
import {
  RELAY_PROTOCOL,
  RELAY_TOKENS_FEATURE,
  REGIONS_FEATURE,
  REPORTS_FEATURE,
  parseRelayInfo,
  relayInfoPath,
  reportsPath,
  type RelayRegion,
} from '@shared/remote/relay'
import {
  DeviceRegions,
  RegionSource,
  RegionTimes,
  parseSavedRegionList,
  type SavedRegionList,
} from '@shared/remote/region-source'
import {
  PREFERENCE_TTL_MS,
  hostRegions,
  parseRelayPrefer,
  parseRelayRegions,
  parseSignedRegionList,
  verifyRegionList,
  type ListedRegion,
  type RankedRegion,
  type RelayPreferMessage,
  type RelayRegionsMessage,
  type SignedRegionList,
} from '@shared/remote/relay-regions'
import { DEVICE_ID } from '@shared/remote/device'
import { RelayStats, parseRelayStats, type RelayStatsState } from '@shared/remote/relay-report'
import { JsonFile, type LogFn } from '../agent-host/storage'
import { jsonOf, relayRequest } from './relay-net'

/** How long reading the main relay's features, the list or a report may take. */
const REQUEST_TIMEOUT_MS = 15_000
/** How long one `GET /v1/ping` may take. */
const PING_TIMEOUT_MS = 5_000
/** How often the main relay's features are read again. */
const FEATURES_MS = 6 * 60 * 60_000
/** How often the regions are timed again when due and a report is looked for. */
const TICK_MS = 60 * 60_000
/** The first look for a report after the start. */
const FIRST_REPORT_MS = 60_000
/** The most devices whose preferred regions are kept. */
const MAX_PREFERENCES = 64

interface Preference {
  seenAt: number
  /** The regions' ids, as the device sent them. */
  ids: string[]
  list: SignedRegionList
  /** The regions, as its list gave them. */
  regions: ListedRegion[]
}

interface PreferencesFile {
  version: 1
  devices: Record<string, { seenAt: number; ids: string[]; list: SignedRegionList }>
}

interface RegionsFile {
  version: 1
  saved: SavedRegionList | null
}

interface StatsFile {
  version: 1
  stats: RelayStatsState | null
}

export interface RemoteRegionsOptions {
  userDataPath: string
  /** The main relay's origin. */
  main: string
  app: 'desktop' | 'daemon'
  keys: Readonly<Record<string, string>>
  /** Whether this process connects to hosts as a device, which times its own leg. */
  device: boolean
  /** The account's access token now; null while the relay may not be used at all. */
  accessToken(): string | null
  /** The relay token now; null where the relays take the access token. */
  relayToken(): string | null
  /** Whether Use the Kettu relay is on. */
  relayOn(): boolean
  /** The regions the host signs in to, null for those `GET /v1` lists. */
  plan(regions: RelayRegion[] | null): void
  /** The list or the host's regions changed: devices hear `relay.regions` again. */
  hostChanged(): void
  /**
   * This device timed its regions again, so hosts' regions rank anew; `prefer` when its fastest
   * changed too, which hosts then hear in `relay.prefer`.
   */
  timesChanged(prefer: boolean): void
  log: LogFn
  now?: () => number
}

export class RemoteRegions {
  readonly source: RegionSource
  readonly times: RegionTimes
  readonly devices: DeviceRegions
  private readonly preferences = new Map<string, Preference>()
  private readonly stats: RelayStats
  private features: string[] | null = null
  private featuresAt = -Infinity
  private readingFeatures: Promise<void> | null = null
  private tick: ReturnType<typeof setInterval> | null = null
  private firstReport: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  private sentPlan = 'null'
  private sentPrefer = ''
  /** Every region's id by its origin, for counting the day by region. */
  private readonly ids = new Map<string, string>()
  private readonly now: () => number

  private constructor(
    readonly options: RemoteRegionsOptions,
    private readonly files: {
      regions: JsonFile<RegionsFile>
      preferences: JsonFile<PreferencesFile>
      stats: JsonFile<StatsFile>
    },
    saved: SavedRegionList | null,
    stats: RelayStatsState | null,
  ) {
    this.now = options.now ?? Date.now
    const log = (level: 'info' | 'warn' | 'error', message: string): void =>
      options.log(level, message)
    this.source = new RegionSource({
      main: options.main,
      keys: options.keys,
      saved,
      fetchList: async (url, etag) => {
        const response = await relayRequest(url, {
          headers: etag ? { 'if-none-match': etag } : {},
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        return {
          status: response.status,
          etag: response.header('etag'),
          body: jsonOf(response.text),
        }
      },
      save: (next) => files.regions.save({ version: 1, saved: next }),
      changed: () => this.listChanged(),
      log,
      now: this.now,
    })
    this.times = new RegionTimes({
      ping: async (region, url) => {
        const response = await relayRequest(url, {
          ...(region.pin ? { pin: region.pin } : {}),
          timeoutMs: PING_TIMEOUT_MS,
        })
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`it answered ${response.status}`)
        }
      },
      measured: (region, rtt) => {
        if (rtt === null) this.stats.connected(region.id, false)
        else this.stats.sample(region.id, rtt)
      },
      changed: () => this.timesChanged(),
      now: this.now,
    })
    this.devices = new DeviceRegions({
      source: this.source,
      times: this.times,
      pinned: true,
      now: this.now,
    })
    this.stats = new RelayStats({
      state: stats,
      save: (state) => files.stats.save({ version: 1, stats: state }),
      now: this.now,
    })
  }

  static async load(options: RemoteRegionsOptions): Promise<RemoteRegions> {
    const dir = path.join(options.userDataPath, 'remote')
    const regions = new JsonFile<RegionsFile>({
      file: path.join(dir, 'relay-regions.json'),
      version: 1,
      migrations: {},
      parse: (data) => ({ version: 1, saved: parseSavedRegionList(data.saved) }),
      empty: () => ({ version: 1, saved: null }),
      log: options.log,
    })
    const preferences = new JsonFile<PreferencesFile>({
      file: path.join(dir, 'relay-preferences.json'),
      version: 1,
      migrations: {},
      parse: (data) => ({ version: 1, devices: parsePreferences(data.devices) }),
      empty: () => ({ version: 1, devices: {} }),
      log: options.log,
    })
    const stats = new JsonFile<StatsFile>({
      file: path.join(dir, 'relay-stats.json'),
      version: 1,
      migrations: {},
      parse: (data) => ({ version: 1, stats: parseRelayStats(data.stats) }),
      empty: () => ({ version: 1, stats: null }),
      log: options.log,
      compact: true,
    })
    const [savedRegions, savedPreferences, savedStats] = await Promise.all([
      regions.load(),
      preferences.load(),
      stats.load(),
    ])
    const loaded = new RemoteRegions(
      options,
      { regions, preferences, stats },
      savedRegions.saved,
      savedStats.stats,
    )
    await loaded.source.load()
    await loaded.loadPreferences(savedPreferences.devices)
    return loaded
  }

  /** Whether the relays may get the regions of the signed list: only with a relay token. */
  private get listUsable(): boolean {
    return this.options.relayToken() !== null && this.source.list !== null
  }

  /** The tokens or Use the Kettu relay changed: starts or stops reading, and picks again. */
  update(): void {
    if (this.stopped) return
    const active = this.options.accessToken() !== null
    if (active && !this.running) {
      this.running = true
      void this.readFeatures().then(() => this.startList())
      this.tick = setInterval(() => this.onTick(), TICK_MS)
      this.tick.unref?.()
      this.firstReport = setTimeout(() => void this.report(), FIRST_REPORT_MS)
      this.firstReport.unref?.()
    } else if (!active && this.running) {
      this.halt()
    }
    this.replan()
  }

  stop(): void {
    this.stopped = true
    this.halt()
    void Promise.all([
      this.files.regions.flush(),
      this.files.preferences.flush(),
      this.files.stats.flush(),
    ])
  }

  private halt(): void {
    this.running = false
    this.source.stop()
    if (this.tick) clearInterval(this.tick)
    if (this.firstReport) clearTimeout(this.firstReport)
    this.tick = null
    this.firstReport = null
  }

  private startList(): void {
    if (this.running && this.features?.includes(REGIONS_FEATURE)) this.source.start()
  }

  private onTick(): void {
    void this.readFeatures().then(() => this.startList())
    if (this.options.device) void this.times.measure(this.devices.ownRegions())
    void this.report()
    this.prunePreferences()
  }

  private async readFeatures(): Promise<void> {
    if (this.now() - this.featuresAt < FEATURES_MS) return
    this.readingFeatures ??= (async () => {
      try {
        const response = await relayRequest(`${this.options.main}${relayInfoPath()}`, {
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        const info = response.status === 200 ? parseRelayInfo(jsonOf(response.text)) : null
        if (info?.protocol === RELAY_PROTOCOL) {
          this.features = info.features
          this.featuresAt = this.now()
          for (const region of info.regions) this.ids.set(region.url, region.id)
        }
      } catch (error) {
        this.options.log('warn', `Cannot read the main relay: ${(error as Error).message}`)
      } finally {
        this.readingFeatures = null
      }
    })()
    await this.readingFeatures
  }

  private listChanged(): void {
    for (const region of this.source.list?.regions ?? []) this.ids.set(region.url, region.id)
    this.replan()
    this.options.hostChanged()
    if (this.options.device) void this.times.measure(this.devices.ownRegions(), true)
    this.timesChanged()
  }

  private timesChanged(): void {
    const prefer = this.preferMessage()
    const key = prefer ? `${prefer.regions.join(',')} ${prefer.list.payload}` : ''
    const changed = key !== this.sentPrefer && prefer !== null
    this.sentPrefer = key
    this.options.timesChanged(changed)
  }

  // The host's side.

  /** The regions to sign in to: by the region rules with a relay token, else `GET /v1`'s. */
  plan(): RelayRegion[] | null {
    const own = this.source.list
    if (!own || this.options.relayToken() === null) return null
    const preferred = [...this.preferences.values()]
      .sort((a, b) => b.seenAt - a.seenAt)
      .flatMap((preference) => preference.regions)
    return hostRegions({ main: this.options.main, own, preferred })
  }

  /** Picks the regions again, telling the host when they changed. */
  replan(): void {
    const plan = this.plan()
    const key = JSON.stringify(plan)
    if (key === this.sentPlan) return
    this.sentPlan = key
    this.options.plan(plan)
  }

  /** What a device that reads it hears of the host's regions; null without a list. */
  regionsMessage(
    legs: readonly (RelayRegion & { hostRtt: number | null })[],
  ): RelayRegionsMessage | null {
    const signed = this.source.signed
    if (!signed || !this.source.list) return null
    return {
      type: 'relay.regions',
      list: signed,
      regions: legs.map((leg) => ({ id: leg.id, rtt: leg.hostRtt })),
    }
  }

  /** Whether devices hear of the regions: a host with a verified list. */
  get offered(): boolean {
    return this.source.list !== null
  }

  /** A device's `relay.prefer`: kept with its list when that verifies, and the regions picked again. */
  async preferred(deviceId: string, value: unknown): Promise<void> {
    const message = parseRelayPrefer(value)
    if (!message) return
    const list = await this.source.verify(message.list)
    if (!list) {
      this.options.log('warn', `Device ${deviceId} sent a region list that does not verify`)
      return
    }
    const regions = message.regions
      .map((id) => list.regions.find((region) => region.id === id))
      .filter((region): region is ListedRegion => region?.state === 'active')
    this.preferences.set(deviceId, {
      seenAt: this.now(),
      ids: message.regions,
      list: message.list,
      regions,
    })
    for (const region of regions) this.ids.set(region.url, region.id)
    this.prunePreferences()
    this.savePreferences()
    this.replan()
  }

  /** A device connected: its preference is kept 30 days from now. */
  seen(deviceId: string): void {
    const preference = this.preferences.get(deviceId)
    if (!preference) return
    preference.seenAt = this.now()
    this.savePreferences()
  }

  /** A sign-in to a region was made or failed. */
  hostConnected(region: RelayRegion, ok: boolean): void {
    this.stats.connected(this.idOf(region), ok)
  }

  /** A round trip on a region's control socket. */
  hostMeasured(region: RelayRegion, rtt: number): void {
    this.stats.sample(this.idOf(region), rtt)
  }

  /** A region could not be reached, or said it drains: the list is read again. */
  regionFailed(): void {
    if (!this.running) return
    this.source.failed()
    // Until the main relay said what it offers, only it gets a token; ask it again.
    if (this.features === null) void this.readFeatures().then(() => this.startList())
  }

  /** A region the host is signed in to said it drains. */
  hostDrained(): void {
    if (this.running) void this.source.refresh()
  }

  // The device's side.

  /** A host's `relay.regions`, resolved through the lists this computer holds. */
  async hostRegions(hostId: string, value: unknown): Promise<void> {
    const message = parseRelayRegions(value)
    if (!message || !this.running) return
    const resolved = await this.devices.received(hostId, message)
    for (const region of resolved) this.ids.set(region.url, region.id)
    if (this.options.device) void this.times.measure(resolved)
  }

  /** A host's regions in the order to try them; null where the regions of `GET /v1` are used. */
  ranked(hostId: string): RankedRegion[] | null {
    if (this.options.relayToken() === null) return null
    return this.devices.ranked(hostId)
  }

  /** What this device tells a host: its fastest regions, once timed; only with a relay token. */
  preferMessage(): RelayPreferMessage | null {
    if (!this.listUsable) return null
    return this.devices.prefer()
  }

  /** A relay's try ended, for the day's report; one not reached is reason to read the list. */
  dialed(url: string, outcome: 'joined' | 'unreachable' | 'answered'): void {
    if (outcome === 'answered') return
    this.stats.connected(this.idOf({ id: '', url }), outcome === 'joined')
    if (outcome === 'unreachable') this.regionFailed()
  }

  /**
   * The relays the token in hand may go to: any with a relay token, or while the main relay takes
   * none; the main relay alone with the access token once it does, or before it said.
   */
  allowed(urls: string[]): string[] {
    if (this.options.relayToken() !== null) return urls
    if (this.features !== null && !this.features.includes(RELAY_TOKENS_FEATURE)) return urls
    return urls.filter((url) => url === this.options.main)
  }

  /** The relay a session went through says its region drains: tried last for a while. */
  drained(url: string): void {
    this.devices.drain(url)
    this.regionFailed()
  }

  // The report.

  /** Sends the day before's report, once a day, to a main relay that takes it. */
  private async report(): Promise<void> {
    const token = this.options.relayToken()
    if (!token || !this.options.relayOn() || !this.features?.includes(REPORTS_FEATURE)) return
    const body = this.stats.due(this.options.app)
    if (!body) return
    try {
      const response = await relayRequest(`${this.options.main}${reportsPath()}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
      // A report the relay will never take is not sent again; it tries again tomorrow.
      if (response.status < 500 && response.status !== 401 && response.status !== 429) {
        this.stats.sent(body.day)
      }
      if (response.status >= 300) {
        this.options.log(
          'warn',
          `The relay took no round trip report: it answered ${response.status}`,
        )
      }
    } catch (error) {
      this.options.log('warn', `Cannot send the round trip report: ${(error as Error).message}`)
    }
  }

  private idOf(region: RelayRegion): string {
    return (
      this.ids.get(region.url) ?? (region.id || (region.url === this.options.main ? 'main' : ''))
    )
  }

  private async loadPreferences(devices: PreferencesFile['devices']): Promise<void> {
    for (const [deviceId, entry] of Object.entries(devices)) {
      // Kept from a list that verified when it came; checked again rather than trusted.
      const list = await verifyRegionList(entry.list, this.options.main, this.options.keys)
      if (!list) continue
      const regions = entry.ids
        .map((id) => list.regions.find((region) => region.id === id))
        .filter((region): region is ListedRegion => region?.state === 'active')
      this.preferences.set(deviceId, { ...entry, regions })
    }
    if (this.prunePreferences()) this.savePreferences()
  }

  /** Forgets the preferences of devices not seen for 30 days; whether any went. */
  private prunePreferences(): boolean {
    const before = this.preferences.size
    const cutoff = this.now() - PREFERENCE_TTL_MS
    for (const [deviceId, preference] of this.preferences) {
      if (preference.seenAt < cutoff) this.preferences.delete(deviceId)
    }
    const byAge = [...this.preferences.entries()].sort((a, b) => b[1].seenAt - a[1].seenAt)
    for (const [deviceId] of byAge.slice(MAX_PREFERENCES)) this.preferences.delete(deviceId)
    const changed = this.preferences.size !== before
    if (changed) this.replan()
    return changed
  }

  private savePreferences(): void {
    const devices: PreferencesFile['devices'] = {}
    for (const [deviceId, { seenAt, ids, list }] of this.preferences) {
      devices[deviceId] = { seenAt, ids, list }
    }
    this.files.preferences.save({ version: 1, devices })
  }
}

function parsePreferences(value: unknown): PreferencesFile['devices'] {
  const devices: PreferencesFile['devices'] = {}
  if (typeof value !== 'object' || value === null) return devices
  for (const [deviceId, entry] of Object.entries(value)) {
    const { seenAt, ids, list } = (entry ?? {}) as Record<string, unknown>
    const signed = parseSignedRegionList(list)
    if (!DEVICE_ID.test(deviceId) || typeof seenAt !== 'number' || !signed) continue
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) continue
    devices[deviceId] = { seenAt, ids: ids.slice(0, 2) as string[], list: signed }
  }
  return devices
}
