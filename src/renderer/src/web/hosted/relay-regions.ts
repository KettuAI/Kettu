// The hosted web client's relay regions. The relays get a relay token once the main relay takes
// them, else the access token, which then goes to the main relay alone. The main relay's signed
// list gives the regions, of which a browser uses only those under the main relay's domain, since
// it cannot check a certificate by a pin. This browser's leg to each is timed while the page is in
// front, each host's regions are ranked by the whole path, and the day is counted for the round
// trip report, sent once it is over.

import { AccountApi } from '@shared/account-api'
import type {
  ClientRelayNodes,
  ClientRelayOfficialNode,
  ClientRelayOwnNode,
} from '@shared/remote/hosts'
import {
  RELAY_TOKENS_FEATURE,
  REGIONS_FEATURE,
  REPORTS_FEATURE,
  parseRelayInfo,
  relayInfoPath,
  reportsPath,
  trustedRelay,
  type HostRelay,
  type RelayRegion,
} from '@shared/remote/relay'
import type { RelayAttempt, RelayEndpoint } from '@shared/remote/relay-device'
import {
  REGIONS_CHANNEL_FEATURE,
  parseRelayOwn,
  parseRelayPreference,
  parseRelayRegions,
  serializeRelayPreference,
  type RelayPreferMessage,
  type RelayPreference,
  type RelayRegionsMessage,
} from '@shared/remote/relay-regions'
import { RelayStats, parseRelayStats } from '@shared/remote/relay-report'
import { DeviceRegions, RegionSource, RegionTimes } from '@shared/remote/region-source'
import type { HostLink } from '@shared/remote/link'
import { HOSTED_STORE, run } from '../storage'
import type { HostedAccount } from './account'

/** A relay token is renewed once less than this is left of it. */
const RENEW_MS = 10 * 60_000
/** How long what the main relay offers is taken as read. */
const FEATURES_MS = 10 * 60_000
/** How often the regions are timed again when due and a report is looked for. */
const TICK_MS = 60 * 60_000
const TIMEOUT_MS = 15_000
const STATS = 'relay-stats'
/** localStorage key persisting the hosted web client's preferred relay node. */
export const RELAY_PREFERENCE_STORAGE_KEY = 'kettu.relayPreference'

const visible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function loadStoredPreference(storage: Pick<Storage, 'getItem'> | null): RelayPreference {
  try {
    return parseRelayPreference(storage?.getItem(RELAY_PREFERENCE_STORAGE_KEY))
  } catch {
    return { kind: 'automatic' }
  }
}

function saveStoredPreference(
  storage: Pick<Storage, 'setItem'> | null,
  pref: RelayPreference,
): void {
  try {
    storage?.setItem(RELAY_PREFERENCE_STORAGE_KEY, serializeRelayPreference(pref))
  } catch {
    // Private browsing or a full storage quota: the preference still applies for this session.
  }
}

export class HostedRelay {
  readonly source: RegionSource
  readonly times: RegionTimes
  readonly devices: DeviceRegions
  private stats: RelayStats | null = null
  private features: string[] | null = null
  private featuresAt = -Infinity
  private relay: { token: string; expiresAt: number } | null = null
  private relayOnly = false
  private readonly api: AccountApi
  private readonly links = new Map<string, HostLink>()
  private readonly ownRelays = new Map<string, { url: string; hostRtt: number | null }>()
  private readonly listeners = new Set<() => void>()
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null
  private sentPrefer = ''

  constructor(
    private readonly account: HostedAccount,
    private readonly main: string,
    accountUrl: string,
    keys: Readonly<Record<string, string>>,
    storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage(),
  ) {
    this.storage = storage
    this.api = new AccountApi(accountUrl, (url, init) => fetch(url, init))
    this.source = new RegionSource({
      main,
      keys,
      // The browser revalidates with the ETag itself, which a header of the page's own would
      // turn into a preflight.
      fetchList: async (url) => {
        const response = await fetch(url, {
          cache: 'no-cache',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        return {
          status: response.status,
          etag: response.headers.get('etag'),
          body: await response.json().catch(() => null),
        }
      },
      changed: () => {
        void this.times.measure(this.measurableOfficialRegions(), true)
        this.timesChanged()
        this.notify()
      },
      log: (level, message) => console[level](message),
    })
    this.times = new RegionTimes({
      ping: async (_region, url) => {
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error(`it answered ${response.status}`)
      },
      active: visible,
      measured: (region, rtt) => {
        if (!this.isOfficialRegion(region)) return
        if (rtt === null) this.stats?.connected(region.id, false)
        else this.stats?.sample(region.id, rtt)
      },
      changed: () => {
        this.timesChanged()
        this.notify()
      },
    })
    this.devices = new DeviceRegions({
      source: this.source,
      times: this.times,
      pinned: false,
      preference: loadStoredPreference(this.storage),
    })
  }

  /** Reads what the main relay offers and its list, and keeps timing and counting the day. */
  async start(): Promise<void> {
    const kept = await run('readonly', (store) => store.get(STATS), HOSTED_STORE).catch(() => null)
    this.stats = new RelayStats({
      state: parseRelayStats(kept),
      save: (state) => void run('readwrite', (store) => store.put(state, STATS), HOSTED_STORE),
    })
    await this.readFeatures()
    if (this.features?.includes(REGIONS_FEATURE)) this.source.start()
    setInterval(() => {
      void this.readFeatures()
      void this.times.measure(this.measurableTargets())
      void this.report()
    }, TICK_MS)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (visible()) void this.times.measure(this.measurableTargets())
      })
    }
    setTimeout(() => void this.report(), 60_000)
  }

  /** Current client-side relay preference. */
  preference(): RelayPreference {
    return this.devices.getPreference()
  }

  /** Updates and persists the relay preference, pushing `relay.prefer` immediately. */
  setPreference(next: RelayPreference | string): void {
    const parsed = typeof next === 'string' ? parseRelayPreference(next) : next
    saveStoredPreference(this.storage, parsed)
    const changed = this.devices.setPreference(parsed)
    if (!changed) return
    const prefer = this.preferMessage()
    this.sentPrefer = prefer ? `${prefer.regions.join()} ${prefer.list.payload}` : ''
    for (const link of this.links.values()) this.sendPreference(link)
    this.notify()
  }

  /** Re-probes latency across all usable official regions and known non-pinned own relays. */
  async refreshSpeeds(): Promise<void> {
    if (this.features === null) await this.readFeatures()
    if (this.features?.includes(REGIONS_FEATURE) && this.source.list === null) {
      this.source.start()
      await this.source.refresh()
    }
    const targets = this.measurableTargets()
    const toProbe = targets.length > 0 ? targets : [{ id: 'main', url: this.main }]
    await this.times.measure(toProbe, true)
    this.notify()
  }

  /** Subscribes to preference, own-relay, list, or RTT updates. */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Client-side relay selection snapshot for Settings › Hosts in hosted web sessions. */
  snapshot(currentRelayUrl?: string | null): ClientRelayNodes {
    const official: ClientRelayOfficialNode[] = []
    const list = this.source.list
    const listedMain = list?.regions.find((region) => region.url === this.main)
    official.push({
      id: listedMain?.id ?? 'main',
      url: this.main,
      ...(listedMain?.name !== undefined ? { name: listedMain.name } : {}),
      ...(listedMain?.names ? { names: listedMain.names } : {}),
      rtt: this.times.rtt({ url: this.main }),
      inUse: currentRelayUrl === this.main,
    })
    for (const region of list?.regions ?? []) {
      if (region.state !== 'active' || region.pin || region.url === this.main) continue
      if (official.some((item) => item.url === region.url || item.id === region.id)) continue
      official.push({
        id: region.id,
        url: region.url,
        name: region.name,
        ...(region.names ? { names: region.names } : {}),
        rtt: this.times.rtt(region),
        inUse: currentRelayUrl === region.url,
      })
    }
    const own: ClientRelayOwnNode[] = []
    const seenOwn = new Set<string>()
    for (const entry of this.ownRelays.values()) {
      if (seenOwn.has(entry.url)) continue
      seenOwn.add(entry.url)
      own.push({
        origin: entry.url,
        rtt: this.times.rtt({ url: entry.url }),
        inUse: currentRelayUrl === entry.url,
      })
    }
    return {
      preference: serializeRelayPreference(this.preference()),
      official,
      own,
    }
  }

  /**
   * Key of the manually selected `LinkRoute` (`relay <url>`) for `hostId`, or null in automatic
   * mode or when the preferred node is not offered for this host.
   */
  preferredRouteKey(hostId: string, named: string[]): string | null {
    const pref = this.preference()
    if (pref.kind === 'automatic') return null
    if (pref.kind === 'own') {
      const own = this.ownRelays.get(hostId)
      return own && own.url === pref.origin ? `relay ${own.url}` : null
    }
    const targetUrl = this.officialUrlForId(pref.id, hostId)
    if (!targetUrl) return null
    const all = this.endpoints(hostId, named)
    return all.some((endpoint) => endpoint.url === targetUrl && endpoint.token !== null)
      ? `relay ${targetUrl}`
      : null
  }

  /** What the relays get: the relay token once the main relay takes them, else the access token. */
  async token(): Promise<string | null> {
    const access = await this.account.accessToken()
    if (!access) {
      this.relay = null
      this.relayOnly = false
      return null
    }
    await this.readFeatures()
    if (!this.features?.includes(RELAY_TOKENS_FEATURE)) {
      this.relayOnly = false
      return access
    }
    const now = Date.now()
    if (!this.relay || this.relay.expiresAt - now < RENEW_MS) {
      try {
        this.relay = await this.api.relayToken(access)
      } catch {
        // The one held while it lasts; else the access token, for the main relay alone.
        if (this.relay && this.relay.expiresAt - now < 30_000) this.relay = null
      }
    }
    this.relayOnly = this.relay !== null
    return this.relay?.token ?? access
  }

  /**
   * The relays the token last given may go to: any with a relay token, or while the main relay
   * takes none; the main relay alone with the access token once it does, or before it said.
   */
  allowed(urls: string[]): string[] {
    if (this.relayOnly) return urls
    if (this.features !== null && !this.features.includes(RELAY_TOKENS_FEATURE)) return urls
    return urls.filter((url) => url === this.main)
  }

  /** A host's regions to try, honoring manual preference and ranking by total RTT otherwise. */
  endpoints(hostId: string, named: string[]): RelayEndpoint[] {
    const ranked = this.relayOnly ? (this.devices.ranked(hostId) ?? []) : []
    const official: { endpoint: RelayEndpoint; rtt: number | null }[] = [
      ...ranked.map(({ url, rtt }) => ({ endpoint: { url }, rtt })),
      ...this.allowed(named)
        .filter((url) => !ranked.some((region) => region.url === url))
        .map((url) => ({ endpoint: { url }, rtt: null })),
    ]
    const own = this.ownRelays.get(hostId) ?? null
    // Browser own-relay endpoints strictly carry `token: null` so Kettu tokens are never leaked.
    const ownEndpoint: RelayEndpoint | null = own ? { url: own.url, token: null } : null
    const pref = this.preference()
    if (pref.kind === 'own' && ownEndpoint && ownEndpoint.url === pref.origin) {
      return [ownEndpoint, ...official.map((entry) => entry.endpoint)]
    }
    if (pref.kind === 'official') {
      const targetUrl = this.officialUrlForId(pref.id, hostId)
      const orderedOfficial = official.map((entry) => entry.endpoint)
      if (targetUrl) {
        const index = orderedOfficial.findIndex((entry) => entry.url === targetUrl)
        if (index > 0) {
          const chosen = orderedOfficial[index]!
          orderedOfficial.splice(index, 1)
          orderedOfficial.unshift(chosen)
        }
      }
      return ownEndpoint ? [...orderedOfficial, ownEndpoint] : orderedOfficial
    }
    if (!ownEndpoint || !own) return official.map((entry) => entry.endpoint)
    const deviceOwnRtt = this.times.rtt({ url: own.url })
    const ownTotalRtt =
      deviceOwnRtt !== null && own.hostRtt !== null ? deviceOwnRtt + own.hostRtt : null
    const combined = [
      ...official.map((entry, order) => ({ endpoint: entry.endpoint, rtt: entry.rtt, order })),
      { endpoint: ownEndpoint, rtt: ownTotalRtt, order: official.length },
    ]
    combined.sort((a, b) => {
      if (a.rtt !== null && b.rtt !== null && a.rtt !== b.rtt) return a.rtt - b.rtt
      if (a.rtt === null && b.rtt !== null) return 1
      if (a.rtt !== null && b.rtt === null) return -1
      return a.order - b.order
    })
    return combined.map((entry) => entry.endpoint)
  }

  /** The link to a host: hears its regions and own relay, and tells it this browser's preference. */
  attach(link: HostLink, host: HostRelay): void {
    this.links.set(host.id, link)
    if (host.own && !host.own.pin && !trustedRelay(host.own.url, this.main)) {
      this.ownRelays.set(host.id, { url: host.own.url, hostRtt: null })
      void this.times.measure([{ id: 'own', url: host.own.url }])
      this.notify()
    }
    // The link hands on what followed the welcome before it says it is connected; the host sends
    // its regions right after the welcome, so they wait for it.
    let early: RelayRegionsMessage | null = null
    link.onMessage((message) => {
      if (message.type === 'relay.own') {
        const parsed = parseRelayOwn(message, this.main)
        if (!parsed) return
        this.applyOwnRelay(host.id, parsed.own)
        return
      }
      if (message.type !== 'relay.regions') return
      const parsed = parseRelayRegions(message)
      if (!parsed) return
      if (link.state.kind !== 'connected') early = parsed
      else if (this.offered(link)) this.regionsOf(host.id, parsed)
    })
    link.onState((state) => {
      if (state.kind !== 'connected') return
      if (early && this.offered(link)) this.regionsOf(host.id, early)
      early = null
      this.sendPreference(link)
    })
  }

  private applyOwnRelay(
    hostId: string,
    own: { url: string; pin?: string; rtt: number | null } | null,
  ): void {
    // Browsers cannot verify self-signed certificate pins; ignore IP-only pinned own relays.
    if (!own || own.pin !== undefined) {
      if (this.ownRelays.delete(hostId)) this.notify()
      return
    }
    const previous = this.ownRelays.get(hostId)
    this.ownRelays.set(hostId, { url: own.url, hostRtt: own.rtt })
    void this.times.measure([{ id: 'own', url: own.url }])
    if (previous?.url !== own.url || previous?.hostRtt !== own.rtt) this.notify()
  }

  private regionsOf(hostId: string, message: RelayRegionsMessage): void {
    void this.devices.received(hostId, message).then((resolved) => {
      void this.times.measure(resolved)
      this.notify()
    })
  }

  /** The STUN servers of the verified list, as `host:port`. */
  stun(): string[] {
    return this.source.list?.stun ?? []
  }

  /** A peer to peer attempt ended, for the day's report. */
  punched(opened: boolean): void {
    this.stats?.punched(opened)
  }

  dialed(url: string, outcome: RelayAttempt): void {
    if (outcome === 'answered' || !this.isOfficialUrl(url)) return
    const id = this.idOf(url)
    if (id) this.stats?.connected(id, outcome === 'joined')
    if (outcome === 'unreachable') this.source.failed()
  }

  /** A region that drains is tried last for a while, and left by connecting again. */
  drained(url: string, leave: () => void): void {
    if (this.isOfficialUrl(url)) {
      this.devices.drain(url)
      this.source.failed()
    }
    leave()
  }

  private measurableOfficialRegions(): RelayRegion[] {
    const listed = this.devices.ownRegions()
    if (listed.some((region) => region.url === this.main)) return listed
    return [{ id: 'main', url: this.main }, ...listed]
  }

  private measurableTargets(): RelayRegion[] {
    const targets: RelayRegion[] = [...this.measurableOfficialRegions()]
    const seen = new Set(targets.map((region) => region.url))
    for (const own of this.ownRelays.values()) {
      if (seen.has(own.url)) continue
      seen.add(own.url)
      targets.push({ id: 'own', url: own.url })
    }
    return targets
  }

  private isOfficialRegion(region: RelayRegion): boolean {
    return region.id !== 'own' && this.isOfficialUrl(region.url)
  }

  private isOfficialUrl(url: string): boolean {
    return url === this.main || trustedRelay(url, this.main)
  }

  private officialUrlForId(id: string, hostId: string): string | null {
    const ranked = this.devices.ranked(hostId) ?? []
    const inRanked = ranked.find((region) => region.id === id)
    if (inRanked) return inRanked.url
    if (id === 'main') return this.main
    const listed = this.source.list?.regions.find(
      (region) => region.id === id && region.state === 'active' && !region.pin,
    )
    return listed?.url ?? null
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('A relay listener failed', error)
      }
    }
  }

  private offered(link: HostLink): boolean {
    const { state } = link
    return state.kind === 'connected' && state.welcome.features.includes(REGIONS_CHANNEL_FEATURE)
  }

  private preferMessage(): RelayPreferMessage | null {
    return this.relayOnly ? this.devices.prefer() : null
  }

  private sendPreference(link: HostLink): void {
    const prefer = this.preferMessage()
    if (prefer && this.offered(link)) link.send({ ...prefer })
  }

  private timesChanged(): void {
    const prefer = this.preferMessage()
    const key = prefer ? `${prefer.regions.join()} ${prefer.list.payload}` : ''
    if (key === this.sentPrefer) return
    this.sentPrefer = key
    for (const link of this.links.values()) this.sendPreference(link)
  }

  private idOf(url: string): string | null {
    const listed = this.source.list?.regions.find((region) => region.url === url)
    return listed?.id ?? (url === this.main ? 'main' : null)
  }

  private async readFeatures(): Promise<void> {
    if (Date.now() - this.featuresAt < FEATURES_MS) return
    try {
      const response = await fetch(`${this.main}${relayInfoPath()}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const info = response.ok ? parseRelayInfo(await response.json()) : null
      if (!info) return
      this.features = info.features
      this.featuresAt = Date.now()
    } catch {
      // Unread, as from a relay that does not answer this page: the regions it named stay in use.
    }
  }

  /** Sends the day before's report, once a day, to a main relay that takes it. */
  private async report(): Promise<void> {
    const token = await this.token()
    if (!token || !this.relayOnly || !this.features?.includes(REPORTS_FEATURE)) return
    const body = this.stats?.due('web')
    if (!body) return
    try {
      const response = await fetch(`${this.main}${reportsPath()}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (response.status < 500 && response.status !== 401 && response.status !== 429) {
        this.stats?.sent(body.day)
      }
    } catch {
      // Tried again within the hour.
    }
  }
}

/** The hello's features of the hosted web client, which reads `relay.regions`. */
export const HOSTED_FEATURES = [REGIONS_CHANNEL_FEATURE]
