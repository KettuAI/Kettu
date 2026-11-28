// The signed region list: the relays a client may use beside the main one, which the main relay
// orders for the client's location and a host and its devices forward to each other over the
// channel. A region at an IP address is taken only from a list that verifies against a built-in
// key, and its certificate only by the pin the list gives. From the list, a host picks the
// regions it signs in to, and a device ranks the host's regions by the round trip of the whole
// path. Imports nothing of Node.js, since browsers run it too.

import {
  MAX_REGIONS,
  RELAY_URL,
  decodeRelayBytes,
  relayOrigin,
  trustedRelay,
  verifyRelaySignature,
  type RelayRegion,
} from './relay'

/** The text the list's signature covers starts with this line, followed by the payload. */
export const REGION_LIST_CONTEXT = 'kettu-regions/1\n'

/** The keys a list may be signed with, the current and the next: raw Ed25519, base64url. */
export const REGION_KEYS: Readonly<Record<string, string>> = {
  r1: 'KzQciiotgrhYBuE9ORd809wCrytrmi_fp-zqZkpjS90',
  r2: 'IhKnOcq-e_NDb-mUBQywPg89-eHA5YXBAjwo4M06kIA',
}

/** Adds keys for a development relay: `id=key` pairs, comma separated. */
export const REGION_KEYS_ENV = 'KETTU_REGION_KEYS'

/** The most regions and STUN servers taken from one list. */
export const MAX_LISTED_REGIONS = 16
export const MAX_STUN = 8

/** How often a client asks for a new list, and how soon after the last read a failure may. */
export const REGIONS_CHECK_MS = 10 * 60_000
export const REGIONS_RETRY_GAP_MS = 30_000

/** A host signs in to this many of its own list's regions beside the main relay. */
export const OWN_REGIONS = 2
/** A device tells its host this many of its fastest regions. */
export const PREFERRED_REGIONS = 2
/** A host forgets a device's preferred regions this long after it last saw the device. */
export const PREFERENCE_TTL_MS = 30 * 24 * 60 * 60_000
/** A device measures its regions again this long after the last time. */
export const MEASURE_EVERY_MS = 4 * 60 * 60_000
/**
 * A region that said it drains is passed over this long. A region emptied for good is gone from
 * the list within a minute; one that drained to restart is used again soon after.
 */
export const DRAINED_MS = 2 * 60_000

/** The channel feature of hosts that send `relay.regions` and devices that read it. */
export const REGIONS_CHANNEL_FEATURE = 'relay-regions'

/** The list as the main relay answers it and the channel carries it. */
export interface SignedRegionList {
  /** The id of the key that signed it. */
  key: string
  /** The list itself: base64url of its UTF-8 JSON. */
  payload: string
  /** Ed25519 over REGION_LIST_CONTEXT followed by `payload` as sent, base64url. */
  signature: string
}

/** `probe` regions are only measured, never signed in to or connected through. */
export type RegionState = 'active' | 'probe'

export interface ListedRegion {
  id: string
  name: string
  /** 可选的多语言区域显示名映射（键为 BCP 47 语言标签，例如 `en`、`zh-CN`）。 */
  names?: Record<string, string>
  /** ISO 3166 country code, or null when the list gives none. */
  country: string | null
  /** The region's origin. */
  url: string
  /** The pin of a region at an IP address; null for a region under the main relay's domain. */
  pin: string | null
  state: RegionState
}

/** A list that verified. */
export interface RegionList {
  serial: number
  issuedAt: number
  /** Where the main relay placed the request the list was made for. */
  place: { country: string | null; asn: number | null }
  regions: ListedRegion[]
  /** STUN servers, `host:port`. */
  stun: string[]
}

const REGION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Whether `value` is a valid official relay region identifier. */
export const isRegionId = (value: unknown): value is string =>
  typeof value === 'string' && REGION_ID.test(value)

/**
 * Cross-platform relay preference model shared by desktop, web, and mobile clients.
 * Serialized as `'auto'`, `'official:<id>'`, or `'own:<origin>'`.
 */
export type RelayPreference =
  { kind: 'automatic' } | { kind: 'official'; id: string } | { kind: 'own'; origin: string }

function parseOwnPreferenceOrigin(raw: string): string | null {
  const origin = relayOrigin(raw)
  if (!origin) return null
  const parsed = URL.parse(raw)
  if (
    !parsed ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    return null
  }
  return origin
}

/** Parses a serialized relay preference (`'auto'`, `'official:<id>'`, `'own:<origin>'`). */
export function parseRelayPreference(raw: unknown): RelayPreference {
  if (typeof raw !== 'string') return { kind: 'automatic' }
  const value = raw.trim()
  if (value === '' || value === 'auto') return { kind: 'automatic' }
  if (value.startsWith('official:')) {
    const id = value.slice('official:'.length)
    return isRegionId(id) ? { kind: 'official', id } : { kind: 'automatic' }
  }
  if (value.startsWith('own:')) {
    const origin = parseOwnPreferenceOrigin(value.slice('own:'.length))
    return origin ? { kind: 'own', origin } : { kind: 'automatic' }
  }
  return { kind: 'automatic' }
}

/** Serializes a relay preference into its canonical cross-platform string representation. */
export function serializeRelayPreference(pref: RelayPreference): string {
  switch (pref.kind) {
    case 'automatic':
      return 'auto'
    case 'official':
      return isRegionId(pref.id) ? `official:${pref.id}` : 'auto'
    case 'own': {
      const origin = parseOwnPreferenceOrigin(pref.origin)
      return origin ? `own:${origin}` : 'auto'
    }
  }
}
const COUNTRY = /^[A-Z]{2}$/
const KEY_ID = /^[a-z0-9][a-z0-9-]{0,15}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
// C0 and C1 control characters and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const MAX_NAME = 64
const LOCALE_KEY = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/
const MAX_REGION_NAMES = 16

/** A region's name as its signed list gives it, the words a device shows for it. */
export const isRegionName = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME && !CONTROL.test(value)

/** 校验并解析可选的区域多语言名称映射：缺省或空对象返回 undefined，结构非法返回 null。 */
export function parseRegionNames(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined
  const fields = record(value)
  if (!fields) return null
  const entries = Object.entries(fields)
  if (entries.length > MAX_REGION_NAMES) return null
  const parsed: Record<string, string> = {}
  for (const [locale, label] of entries) {
    if (!LOCALE_KEY.test(locale) || !isRegionName(label)) return null
    parsed[locale] = label
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

/** 比较两份可选区域多语言名称映射是否完全一致，用于判断改名时是否需要刷新状态。 */
export function sameRegionNames(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  return keysA.every((key) => a[key] === b[key])
}

/** 根据当前界面语言从多语言映射中选择最匹配的区域展示名，未命中时回退默认名称。 */
export function localizedRegionName(
  name: string | undefined,
  names: Readonly<Record<string, string>> | undefined,
  language?: string | null,
): string | undefined {
  if (!names) return name
  const lookup = new Map<string, string>()
  for (const [locale, label] of Object.entries(names)) {
    lookup.set(locale.toLowerCase(), label)
  }
  const normalized = (language ?? '').trim().replace(/_/g, '-').toLowerCase()
  const candidates: string[] = []
  if (normalized) {
    candidates.push(normalized)
    if (
      normalized === 'zh-tw' ||
      normalized === 'zh-hk' ||
      normalized === 'zh-mo' ||
      normalized.startsWith('zh-hant')
    ) {
      candidates.push('zh-tw', 'zh-hk', 'zh-hant', 'zh-cn', 'zh-hans', 'zh')
    } else if (normalized === 'zh' || normalized.startsWith('zh-')) {
      candidates.push('zh-cn', 'zh-hans', 'zh')
    } else {
      const base = normalized.split('-')[0]
      if (base && base !== normalized) candidates.push(base)
    }
  }
  for (const candidate of candidates) {
    const matched = lookup.get(candidate)
    if (matched) return matched
  }
  return name
}

/** The longest payload taken: 16 regions and their names fit well within it. */
const MAX_PAYLOAD = 16 * 1024
const SHA256_BYTES = 32
const ED25519_KEY_BYTES = 32

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** The signed list's three fields, or null when it is not one; nothing is verified yet. */
export function parseSignedRegionList(value: unknown): SignedRegionList | null {
  const fields = record(value)
  if (!fields) return null
  const { key, payload, signature } = fields
  if (typeof key !== 'string' || !KEY_ID.test(key)) return null
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD || !BASE64URL.test(payload)) {
    return null
  }
  if (typeof signature !== 'string' || !BASE64URL.test(signature)) return null
  return { key, payload, signature }
}

/**
 * The keys a list from `main` may be signed with: the built-in ones, with those `KETTU_REGION_KEYS`
 * adds or replaces for a development relay; never for the project's relay, however it is written.
 */
export function regionKeys(main: string, extra: string | undefined): Record<string, string> {
  const keys: Record<string, string> = { ...REGION_KEYS }
  const host = URL.parse(main)?.hostname.replace(/\.$/, '')
  if (!host || host === URL.parse(RELAY_URL)!.hostname) return keys
  for (const pair of (extra ?? '').split(',')) {
    const [id, key] = pair.trim().split('=')
    if (id && key && KEY_ID.test(id) && decodeRelayBytes(key)?.length === ED25519_KEY_BYTES) {
      keys[id] = key
    }
  }
  return keys
}

/** Whether `hostname`, as a URL gives it, is an IPv4 or bracketed IPv6 address. */
export function isIpHost(hostname: string): boolean {
  return IPV4.test(hostname) || (hostname.startsWith('[') && hostname.endsWith(']'))
}

/** Whether a pin is one: the base64url of a SHA-256. */
export const isPin = (value: unknown): value is string =>
  typeof value === 'string' && decodeRelayBytes(value)?.length === SHA256_BYTES

/**
 * A region's origin, or null when it may not be used: with a pin, an https URL at an IP address
 * with its port given; without one, a relay under the main relay's parent domain, as before.
 */
export function regionOrigin(url: string, pin: string | null, main: string): string | null {
  const origin = relayOrigin(url)
  if (!origin) return null
  const parsed = URL.parse(origin)!
  if (pin === null) return trustedRelay(origin, main) ? origin : null
  if (parsed.protocol !== 'https:' || !isIpHost(parsed.hostname) || parsed.port === '') return null
  return origin
}

function parseRegion(value: unknown, main: string): ListedRegion | null {
  const fields = record(value)
  if (!fields) return null
  const { id, name, names, country, url, pin, state } = fields
  if (typeof id !== 'string' || !REGION_ID.test(id)) return null
  if (!isRegionName(name)) return null
  const parsedNames = parseRegionNames(names)
  if (parsedNames === null) return null
  if (country !== undefined && (typeof country !== 'string' || !COUNTRY.test(country))) return null
  if (state !== 'active' && state !== 'probe') return null
  if (pin !== undefined && !isPin(pin)) return null
  if (typeof url !== 'string') return null
  const origin = regionOrigin(url, pin ?? null, main)
  if (!origin) return null
  return {
    id,
    name,
    ...(parsedNames ? { names: parsedNames } : {}),
    country: country ?? null,
    url: origin,
    pin: pin ?? null,
    state,
  }
}

const STUN = /^(?:[a-z0-9.-]{1,253}|\[[0-9a-fA-F:.]{2,45}\]):(\d{1,5})$/

function parseStun(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = STUN.exec(value)
  if (!match) return null
  const port = Number(match[1])
  return port >= 1 && port <= 65535 ? value : null
}

/** The list a verified payload holds, or null when it is not one; bad regions are dropped. */
export function parseRegionPayload(value: unknown, main: string): RegionList | null {
  const fields = record(value)
  if (!fields || fields.v !== 1) return null
  const { serial, issuedAt, place, regions, stun } = fields
  if (!isCount(serial) || !isCount(issuedAt) || !Array.isArray(regions)) return null
  const where = record(place)
  const country = typeof where?.country === 'string' && COUNTRY.test(where.country)
  const kept: ListedRegion[] = []
  for (const entry of regions.slice(0, MAX_LISTED_REGIONS)) {
    const region = parseRegion(entry, main)
    if (!region) continue
    if (kept.some((other) => other.id === region.id || other.url === region.url)) continue
    kept.push(region)
  }
  return {
    serial,
    issuedAt,
    place: {
      country: country ? (where!.country as string) : null,
      asn: isCount(where?.asn) ? where.asn : null,
    },
    regions: kept,
    stun: Array.isArray(stun)
      ? stun
          .slice(0, MAX_STUN)
          .map(parseStun)
          .filter((entry): entry is string => entry !== null)
      : [],
  }
}

/**
 * The list a signed answer holds, when its key is one of `keys` and its signature verifies;
 * null for anything else. The serial is the caller's to compare.
 */
export async function verifyRegionList(
  value: unknown,
  main: string,
  keys: Readonly<Record<string, string>> = REGION_KEYS,
): Promise<RegionList | null> {
  const signed = parseSignedRegionList(value)
  if (!signed || !Object.hasOwn(keys, signed.key)) return null
  const key = decodeRelayBytes(keys[signed.key]!)
  const signature = decodeRelayBytes(signed.signature)
  const payload = decodeRelayBytes(signed.payload)
  if (!key || !signature || !payload) return null
  const text = new TextEncoder().encode(`${REGION_LIST_CONTEXT}${signed.payload}`)
  if (!(await verifyRelaySignature(key, signature, text))) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
  } catch {
    return null
  }
  return parseRegionPayload(parsed, main)
}

/**
 * The newest serial seen across every list, the main relay's and those forwarded: a list below
 * it is refused, one equal to it, as from another place, is taken.
 */
export class RegionSerial {
  private newest = -1

  get current(): number {
    return this.newest
  }

  /** Whether a list of `serial` may be taken, keeping it as the newest when it is. */
  take(serial: number): boolean {
    if (serial < this.newest) return false
    this.newest = serial
    return true
  }
}

/** 将签名清单中的区域转换为中继连接项，保留展示名称、多语言名称及裸 IP 节点所需的证书指纹。 */
export const asRelay = (region: ListedRegion): RelayRegion => ({
  id: region.id,
  url: region.url,
  name: region.name,
  ...(region.names ? { names: region.names } : {}),
  ...(region.pin ? { pin: region.pin } : {}),
})

export interface HostRegionsInput {
  /** The main relay's origin. */
  main: string
  /** The host's own list. */
  own: RegionList
  /** The regions the host's devices prefer, the device seen last first. */
  preferred: readonly ListedRegion[]
  /** Regions that said they drain, by origin: never signed in to again until the list changes. */
  draining?: ReadonlySet<string>
  /** Measured host-to-region round trip in milliseconds, used to rank automatic region picks. */
  hostRtt?: (region: ListedRegion) => number | null
  /** Explicit host-selected region ids; when non-empty, overrides automatic selection. */
  selected?: readonly string[] | null
}

/**
 * Where a host signs in: the main relay always, then either the explicitly selected active regions
 * in order (manual mode, up to MAX_REGIONS total), or the fastest OWN_REGIONS active regions of
 * its own list by measured hostRtt (falling back to list order) followed by those its devices
 * prefer, at most MAX_REGIONS in all.
 */
export function hostRegions(input: HostRegionsInput): RelayRegion[] {
  const { main, own, preferred, draining, hostRtt, selected } = input
  const listedMain = own.regions.find((region) => region.url === main)
  const picked: RelayRegion[] = [{ id: listedMain?.id ?? 'main', url: main }]
  const usable = (region: ListedRegion): boolean =>
    region.state === 'active' &&
    !draining?.has(region.url) &&
    !picked.some((kept) => kept.url === region.url || kept.id === region.id)
  if (selected && selected.length > 0) {
    for (const id of selected) {
      if (picked.length === MAX_REGIONS) break
      const region = own.regions.find((entry) => entry.id === id)
      if (region && usable(region)) picked.push(asRelay(region))
    }
    return picked
  }
  const ownCandidates = own.regions
    .map((region, order) => ({
      region,
      order,
      rtt: hostRtt ? hostRtt(region) : null,
    }))
    .filter(({ region }) => usable(region))
  if (hostRtt) {
    ownCandidates.sort((a, b) => {
      const x = a.rtt
      const y = b.rtt
      if (x !== null && y !== null && x !== y) return x - y
      if (x === null && y !== null) return 1
      if (x !== null && y === null) return -1
      return a.order - b.order
    })
  }
  let fromOwn = 0
  for (const { region } of ownCandidates) {
    if (fromOwn === OWN_REGIONS) break
    if (!usable(region)) continue
    picked.push(asRelay(region))
    fromOwn++
  }
  for (const region of preferred) {
    if (picked.length === MAX_REGIONS) break
    if (usable(region)) picked.push(asRelay(region))
  }
  return picked
}

/** A region a host is signed in to, with its leg: the host's round trip, null before the first. */
export interface HostLegRegion extends RelayRegion {
  hostRtt: number | null
}

/** A region a device may reach the host through, with the whole path's round trip when known. */
export interface RankedRegion extends RelayRegion {
  rtt: number | null
}

/**
 * The host's regions in the order to try them: by the device's leg plus the host's, those with
 * either unknown after those with both, in the host's order.
 */
export function rankRegions(
  regions: readonly HostLegRegion[],
  deviceRtt: (region: RelayRegion) => number | null,
): RankedRegion[] {
  const ranked = regions.map((region, order) => {
    const device = deviceRtt(region)
    const rtt = device === null || region.hostRtt === null ? null : device + region.hostRtt
    const entry: RankedRegion = { id: region.id, url: region.url, rtt }
    if (region.pin) entry.pin = region.pin
    return { entry, order }
  })
  ranked.sort((a, b) => {
    const x = a.entry.rtt
    const y = b.entry.rtt
    if (x !== null && y !== null && x !== y) return x - y
    if (x === null && y !== null) return 1
    if (x !== null && y === null) return -1
    return a.order - b.order
  })
  return ranked.map(({ entry }) => entry)
}

/** A device's fastest active regions by its own round trip, fastest first. */
export function fastestRegions(
  list: RegionList,
  deviceRtt: (region: ListedRegion) => number | null,
  options: { pinned: boolean },
): string[] {
  return list.regions
    .filter((region) => region.state === 'active' && (options.pinned || !region.pin))
    .map((region) => ({ id: region.id, rtt: deviceRtt(region) }))
    .filter((entry): entry is { id: string; rtt: number } => entry.rtt !== null)
    .sort((a, b) => a.rtt - b.rtt)
    .slice(0, PREFERRED_REGIONS)
    .map((entry) => entry.id)
}

/** Host to device: its signed list and the regions it is signed in to, with its leg to each. */
export interface RelayRegionsMessage {
  type: 'relay.regions'
  list: SignedRegionList
  regions: { id: string; rtt: number | null }[]
}

/** Host to device: the host's enabled own relay endpoint and measured host-to-relay RTT. */
export interface RelayOwnMessage {
  type: 'relay.own'
  own: { url: string; pin?: string; rtt: number | null } | null
}

/** Device to host: its fastest regions, and the list they are from. */
export interface RelayPreferMessage {
  type: 'relay.prefer'
  regions: string[]
  list: SignedRegionList
}

const isRtt = (value: unknown): value is number => isCount(value) && value <= 60_000

/** Parses a `relay.own` message from the host, or null when malformed. */
export function parseRelayOwn(value: unknown, main: string): RelayOwnMessage | null {
  const fields = record(value)
  if (fields?.type !== 'relay.own') return null
  if (fields.own === null) return { type: 'relay.own', own: null }
  const entry = record(fields.own)
  if (!entry || typeof entry.url !== 'string') return null
  const url = relayOrigin(entry.url)
  if (url !== entry.url || trustedRelay(url, main)) return null
  if (entry.rtt !== null && !isRtt(entry.rtt)) return null
  const pin =
    entry.pin === undefined
      ? undefined
      : isPin(entry.pin) && url.startsWith('https:')
        ? entry.pin
        : null
  if (pin === null) return null
  return {
    type: 'relay.own',
    own: {
      url,
      ...(pin !== undefined ? { pin } : {}),
      rtt: entry.rtt,
    },
  }
}

/** A `relay.regions` as a device reads it, or null when it is not one. */
export function parseRelayRegions(value: unknown): RelayRegionsMessage | null {
  const fields = record(value)
  if (fields?.type !== 'relay.regions' || !Array.isArray(fields.regions)) return null
  const list = parseSignedRegionList(fields.list)
  if (!list || fields.regions.length > MAX_REGIONS) return null
  const regions: RelayRegionsMessage['regions'] = []
  for (const entry of fields.regions) {
    const { id, rtt } = record(entry) ?? {}
    if (typeof id !== 'string' || !REGION_ID.test(id)) return null
    if (rtt !== null && !isRtt(rtt)) return null
    if (!regions.some((kept) => kept.id === id)) regions.push({ id, rtt })
  }
  return { type: 'relay.regions', list, regions }
}

/** A `relay.prefer` as a host reads it, or null when it is not one. */
export function parseRelayPrefer(value: unknown): RelayPreferMessage | null {
  const fields = record(value)
  if (fields?.type !== 'relay.prefer' || !Array.isArray(fields.regions)) return null
  const list = parseSignedRegionList(fields.list)
  if (!list || fields.regions.length > PREFERRED_REGIONS) return null
  const regions: string[] = []
  for (const id of fields.regions) {
    if (typeof id !== 'string' || !REGION_ID.test(id)) return null
    if (!regions.includes(id)) regions.push(id)
  }
  return { type: 'relay.prefer', regions, list }
}

/** The median and the 90th percentile of round trips, by nearest rank; null for none. */
export function percentiles(samples: readonly number[]): { median: number; p90: number } | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
  return { median: Math.round(rank(0.5)), p90: Math.round(rank(0.9)) }
}
