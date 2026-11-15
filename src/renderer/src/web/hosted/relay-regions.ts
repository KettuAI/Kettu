// The hosted web client's relay regions. The relays get a relay token once the main relay takes
// them, else the access token, which then goes to the main relay alone. The main relay's signed
// list gives the regions, of which a browser uses only those under the main relay's domain, since
// it cannot check a certificate by a pin. This browser's leg to each is timed while the page is in
// front, each host's regions are ranked by the whole path, and the day is counted for the round
// trip report, sent once it is over.

import { AccountApi } from '@shared/account-api'
import {
  RELAY_TOKENS_FEATURE,
  REGIONS_FEATURE,
  REPORTS_FEATURE,
  parseRelayInfo,
  relayInfoPath,
  reportsPath,
  type HostRelay,
} from '@shared/remote/relay'
import type { RelayAttempt, RelayEndpoint } from '@shared/remote/relay-device'
import {
  REGIONS_CHANNEL_FEATURE,
  parseRelayRegions,
  type RelayPreferMessage,
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

const visible = (): boolean => document.visibilityState === 'visible'

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
  private sentPrefer = ''

  constructor(
    private readonly account: HostedAccount,
    private readonly main: string,
    accountUrl: string,
    keys: Readonly<Record<string, string>>,
  ) {
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
        void this.times.measure(this.devices.ownRegions(), true)
        this.timesChanged()
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
        if (rtt === null) this.stats?.connected(region.id, false)
        else this.stats?.sample(region.id, rtt)
      },
      changed: () => this.timesChanged(),
    })
    this.devices = new DeviceRegions({ source: this.source, times: this.times, pinned: false })
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
      void this.times.measure(this.devices.ownRegions())
      void this.report()
    }, TICK_MS)
    document.addEventListener('visibilitychange', () => {
      if (visible()) void this.times.measure(this.devices.ownRegions())
    })
    setTimeout(() => void this.report(), 60_000)
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
   * takes none or has not said; the main relay alone with the access token once it does.
   */
  allowed(urls: string[]): string[] {
    if (this.relayOnly || !this.features?.includes(RELAY_TOKENS_FEATURE)) return urls
    return urls.filter((url) => url === this.main)
  }

  /** A host's regions to try, ranked by the whole path, before those its welcome named. */
  endpoints(hostId: string, named: string[]): RelayEndpoint[] {
    const ranked = this.relayOnly ? (this.devices.ranked(hostId) ?? []) : []
    return [
      ...ranked.map(({ url }) => ({ url })),
      ...this.allowed(named)
        .filter((url) => !ranked.some((region) => region.url === url))
        .map((url) => ({ url })),
    ]
  }

  /** The link to a host: hears its regions, and tells it this browser's fastest. */
  attach(link: HostLink, host: HostRelay): void {
    this.links.set(host.id, link)
    // The link hands on what followed the welcome before it says it is connected; the host sends
    // its regions right after the welcome, so they wait for it.
    let early: RelayRegionsMessage | null = null
    link.onMessage((message) => {
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

  private regionsOf(hostId: string, message: RelayRegionsMessage): void {
    void this.devices.received(hostId, message).then((resolved) => this.times.measure(resolved))
  }

  dialed(url: string, outcome: RelayAttempt): void {
    if (outcome === 'answered') return
    const id = this.idOf(url)
    if (id) this.stats?.connected(id, outcome === 'joined')
    if (outcome === 'unreachable') this.source.failed()
  }

  drained(url: string): void {
    this.devices.drain(url)
    this.source.failed()
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
