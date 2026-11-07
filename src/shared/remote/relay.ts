// The Kettu relay as its clients speak it. A host keeps a control socket on every relay while it
// is signed in to a Kettu account: it proves it holds the Ed25519 key its id is derived from and
// sends its access token, and for each device that asks for it opens one more socket that the
// relay joins to the device's. From then on the relay passes binary messages unchanged, which are
// the channel's Noise messages, and answers the text `ping` with `pong` on any socket. It joins
// only devices signed in to the host's account; whether a device may connect is still the host's
// to decide inside the channel. Imports nothing of Node.js, since browsers run it too.

import { currentPrimitives } from './primitives'

/** The relay's protocol, which `GET /v1` names. */
export const RELAY_PROTOCOL = 1

/** The project's main relay, which lists the other regions. */
export const RELAY_URL = 'https://relay.kettu.sh'

/** Points a development run at another relay. */
export const RELAY_URL_ENV = 'KETTU_RELAY_URL'

/** The main relay: the project's, or the origin `KETTU_RELAY_URL` names; throws for one that is none. */
export function relayUrlFrom(value: string | undefined): string {
  const raw = value?.trim()
  if (!raw) return RELAY_URL
  const origin = relayOrigin(raw)
  if (!origin) throw new Error(`${RELAY_URL_ENV} must be an http or https origin`)
  return origin
}

/** The first line of the text a host signs. */
export const SIGN_IN_CONTEXT = 'kettu-relay/1'

/** The text a socket sends to be answered with `pong`. */
export const PING = 'ping'
export const PONG = 'pong'

/** A host's control socket has this long from the challenge to its sign-in. */
export const SIGN_IN_TIMEOUT_MS = 10_000
/** A device's socket has this long from opening to its `connect`. */
export const CONNECT_TIMEOUT_MS = 10_000
/** A host has this long from `incoming` to opening the accept socket. */
export const ACCEPT_TIMEOUT_MS = 10_000
/** How long past its expiry a host's access token is still taken, for clocks that drift. */
export const TOKEN_GRACE_MS = 5 * 60_000

/** The longest message the relay passes; a longer one closes the socket with 1009. */
export const MAX_RELAY_MESSAGE = 64 * 1024
/** Devices joined to one host at once. */
export const MAX_DEVICE_CONNECTIONS = 16
/** The most regions a client takes from one list. */
export const MAX_REGIONS = 8

/** A host's id on the relay: the first 16 bytes of its Ed25519 key's SHA-256, in base32. */
export const RELAY_HOST_ID = /^[a-z2-7]{26}$/

/** The one-time tokens of `incoming`, nonces and the like: base64url. */
const RELAY_TOKEN = /^[A-Za-z0-9_-]{16,128}$/

/** The longest Kettu access token a message carries. */
const MAX_ACCESS_TOKEN = 4096

const ED25519_KEY_BYTES = 32
const ED25519_SIGNATURE_BYTES = 64

/** How the relay closes a socket, each with the reason a client shows. */
export const RELAY_CLOSE = {
  /** A message that is malformed or out of turn. */
  malformed: 4400,
  /** A key that is not the id's, a signature that does not verify, or a lapsed token. */
  unauthorized: 4401,
  /** A device without a valid token, or signed in to another account than the host's. */
  forbidden: 4403,
  /** The host is not signed in, did not accept in time, or the accept token is not one. */
  offline: 4404,
  /** No sign-in or connect in time. */
  timeout: 4408,
  /** Another sign-in for the same id took this one's place. */
  replaced: 4409,
  /** A message over MAX_RELAY_MESSAGE. */
  tooBig: 1009,
  /** Too many connections, at once or in a minute. */
  tooMany: 4429,
} as const

export type RelayCloseCode = (typeof RELAY_CLOSE)[keyof typeof RELAY_CLOSE]

/** Why a relay closed a socket, as the clients' states name it. */
export type RelayRefusal =
  | 'malformed'
  | 'unauthorized'
  | 'forbidden'
  | 'offline'
  | 'timeout'
  | 'replaced'
  | 'too_big'
  | 'too_many'

const REFUSALS: Record<number, RelayRefusal> = {
  [RELAY_CLOSE.malformed]: 'malformed',
  [RELAY_CLOSE.unauthorized]: 'unauthorized',
  [RELAY_CLOSE.forbidden]: 'forbidden',
  [RELAY_CLOSE.offline]: 'offline',
  [RELAY_CLOSE.timeout]: 'timeout',
  [RELAY_CLOSE.replaced]: 'replaced',
  [RELAY_CLOSE.tooBig]: 'too_big',
  [RELAY_CLOSE.tooMany]: 'too_many',
}

/** The reason behind a close code, or null for a close that is not the relay's refusal. */
export function relayRefusal(code: number): RelayRefusal | null {
  return REFUSALS[code] ?? null
}

/** What the relay sends a host on its control socket. */
export type RelayToHost =
  | { type: 'challenge'; nonce: string }
  | { type: 'ready' }
  | { type: 'incoming'; token: string }
  | { type: 'replaced' }

/** What a host sends on its control socket. */
export type HostToRelay =
  | { type: 'sign-in'; publicKey: string; signature: string; token: string }
  | { type: 'token'; token: string }

/** What a device sends first, and what the relay answers once the host accepted. */
export type DeviceToRelay = { type: 'connect'; token: string }
export type RelayToDevice = { type: 'joined' }

/** A region `GET /v1` lists. */
export interface RelayRegion {
  id: string
  url: string
}

/** What `GET /v1` answers. */
export interface RelayInfo {
  relay: 'kettu'
  protocol: number
  regions: RelayRegion[]
}

function toBase64Url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export const encodeRelayBytes = toBase64Url
export const decodeRelayBytes = fromBase64Url

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32 in lowercase, without padding. */
export function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let text = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      text += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) text += BASE32[(value << (5 - bits)) & 31]
  return text
}

/** The relay id of a host's Ed25519 public key. */
export async function relayHostId(publicKey: Uint8Array): Promise<string> {
  if (publicKey.length !== ED25519_KEY_BYTES) throw new RangeError('An Ed25519 key is 32 bytes')
  const digest = await currentPrimitives().sha256(publicKey)
  return base32(digest.subarray(0, 16))
}

/** The 16 bytes behind a relay id, as a pairing code carries them; null for no id. */
export function relayIdBytes(id: string): Uint8Array | null {
  if (!RELAY_HOST_ID.test(id)) return null
  const bytes = new Uint8Array(16)
  let bits = 0
  let value = 0
  let at = 0
  for (const char of id) {
    value = (value << 5) | BASE32.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes[at++] = (value >>> (bits - 8)) & 0xff
      bits -= 8
    }
  }
  // The last character's two spare bits are zero in an id this side made.
  return (value & ((1 << bits) - 1)) === 0 ? bytes : null
}

/**
 * The text a host signs to sign in: the context, the relay's origin, its id and the relay's
 * nonce, one per line, so a signature cannot be replayed to another relay, id or challenge.
 */
export function signInText(origin: string, id: string, nonce: string): Uint8Array {
  return new TextEncoder().encode([SIGN_IN_CONTEXT, origin, id, nonce].join('\n'))
}

/** A relay's origin as the host signs it: the https or http origin of its URL. */
export function relayOrigin(url: string): string | null {
  const parsed = URL.parse(url)
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return null
  if (parsed.username || parsed.password) return null
  return parsed.origin
}

/** The WebSocket URL of a path on a relay, given by its origin. */
export function relaySocketUrl(origin: string, path: string): string {
  return `${origin.replace(/^http/, 'ws')}${path}`
}

export const relayInfoPath = (): string => '/v1'
export const hostSocketPath = (id: string): string => `/v1/hosts/${id}`
export const connectSocketPath = (id: string): string => `/v1/hosts/${id}/connect`
export const acceptSocketPath = (id: string, token: string): string =>
  `/v1/hosts/${id}/accept/${token}`

/**
 * Whether a relay named by a region list, a pairing code or a welcome is one the account's token
 * may be sent to: the main relay's host, or another host under the same parent domain, over the
 * same scheme. Anything else could take the token.
 */
export function trustedRelay(origin: string, main: string): boolean {
  const relay = URL.parse(origin)
  const ours = URL.parse(main)
  if (!relay || !ours || relay.protocol !== ours.protocol) return false
  if (relay.host === ours.host) return true
  const labels = ours.hostname.split('.')
  // A main relay on a name of its own, as localhost or an address, vouches for no other.
  if (labels.length < 3 || /^[0-9.]+$/.test(ours.hostname)) return false
  return relay.hostname.endsWith(`.${labels.slice(1).join('.')}`)
}

/** The relays to use, in order: the main one, then each region not the same. */
export function relayList(main: string, regions: readonly RelayRegion[]): RelayRegion[] {
  const origin = relayOrigin(main)
  if (!origin) return []
  const listed = regions.find((region) => relayOrigin(region.url) === origin)
  const list: RelayRegion[] = [{ id: listed?.id ?? 'main', url: origin }]
  for (const region of regions) {
    const url = relayOrigin(region.url)
    if (!url || !trustedRelay(url, origin) || list.some((kept) => kept.url === url)) continue
    list.push({ id: region.id, url })
    if (list.length === MAX_REGIONS) break
  }
  return list
}

const REGION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/** What `GET /v1` answered, or null when it is not a Kettu relay of this protocol. */
export function parseRelayInfo(value: unknown): RelayInfo | null {
  if (typeof value !== 'object' || value === null) return null
  const { relay, protocol, regions } = value as Record<string, unknown>
  if (relay !== 'kettu' || protocol !== RELAY_PROTOCOL || !Array.isArray(regions)) return null
  const kept: RelayRegion[] = []
  for (const region of regions.slice(0, MAX_REGIONS)) {
    const { id, url } = (region ?? {}) as Record<string, unknown>
    if (typeof id !== 'string' || !REGION_ID.test(id) || typeof url !== 'string') continue
    const origin = relayOrigin(url)
    if (origin) kept.push({ id, url: origin })
  }
  return { relay, protocol, regions: kept }
}

function parseJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length > MAX_RELAY_MESSAGE) return null
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const isRelayToken = (value: unknown): value is string =>
  typeof value === 'string' && RELAY_TOKEN.test(value)

const isAccessToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ACCESS_TOKEN

/** A text message from the relay on a host's control socket, or null when it is none. */
export function parseRelayToHost(text: unknown): RelayToHost | null {
  const message = parseJson(text)
  if (!message) return null
  switch (message.type) {
    case 'challenge':
      return isRelayToken(message.nonce) ? { type: 'challenge', nonce: message.nonce } : null
    case 'incoming':
      return isRelayToken(message.token) ? { type: 'incoming', token: message.token } : null
    case 'ready':
    case 'replaced':
      return { type: message.type }
    default:
      return null
  }
}

/** A text message from a host on its control socket, as the relay reads it. */
export function parseHostToRelay(text: unknown): HostToRelay | null {
  const message = parseJson(text)
  if (!message) return null
  if (message.type === 'token') {
    return isAccessToken(message.token) ? { type: 'token', token: message.token } : null
  }
  if (message.type !== 'sign-in') return null
  const { publicKey, signature, token } = message
  if (typeof publicKey !== 'string' || typeof signature !== 'string') return null
  if (decodeRelayBytes(publicKey)?.length !== ED25519_KEY_BYTES) return null
  if (decodeRelayBytes(signature)?.length !== ED25519_SIGNATURE_BYTES) return null
  if (!isAccessToken(token)) return null
  return { type: 'sign-in', publicKey, signature, token }
}

/** A device's first message, as the relay reads it. */
export function parseDeviceToRelay(text: unknown): DeviceToRelay | null {
  const message = parseJson(text)
  if (message?.type !== 'connect' || !isAccessToken(message.token)) return null
  return { type: 'connect', token: message.token }
}

/** Whether a text message from the relay on a device's socket is `joined`. */
export function isJoined(text: unknown): boolean {
  return parseJson(text)?.type === 'joined'
}

/** A one-time token or nonce for the relay to hand out: 32 random bytes in base64url. */
export function newRelayToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/** Where a host is on the relay: its id and its relays' origins in order. */
export interface HostRelay {
  id: string
  urls: string[]
}

/** A host's relay as a welcome or a stored host carries it, or null when it is not one. */
export function parseHostRelay(value: unknown): HostRelay | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, urls } = value as Record<string, unknown>
  if (typeof id !== 'string' || !RELAY_HOST_ID.test(id) || !Array.isArray(urls)) return null
  const kept = urls
    .slice(0, MAX_REGIONS)
    .filter((url): url is string => typeof url === 'string' && relayOrigin(url) === url)
  return { id, urls: kept }
}

export const isRelayHostId = (value: unknown): value is string =>
  typeof value === 'string' && RELAY_HOST_ID.test(value)

export const isRelayNonce = isRelayToken

const ED25519_PKCS8_PREFIX = Uint8Array.of(
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
)

/** A host's key for the relay: its public half, raw, and signing with the private one. */
export interface RelayKey {
  publicKey: Uint8Array
  sign(data: Uint8Array): Promise<Uint8Array>
}

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

/** The key whose private half is the 32-byte Ed25519 seed. */
export async function importRelayKey(seed: Uint8Array): Promise<RelayKey> {
  if (seed.length !== ED25519_KEY_BYTES) throw new RangeError('An Ed25519 seed is 32 bytes')
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length)
  pkcs8.set(ED25519_PKCS8_PREFIX)
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length)
  const privateKey = await crypto.subtle.importKey('pkcs8', buffer(pkcs8), 'Ed25519', true, [
    'sign',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicKey = decodeRelayBytes(jwk.x ?? '')
  if (publicKey?.length !== ED25519_KEY_BYTES) throw new Error('The key has no public half')
  return {
    publicKey,
    sign: async (data) =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, buffer(data))),
  }
}

/** A new Ed25519 seed. */
export async function newRelaySeed(): Promise<Uint8Array> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as {
    privateKey: Parameters<typeof crypto.subtle.exportKey>[1]
  }
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return pkcs8.slice(pkcs8.length - ED25519_KEY_BYTES)
}

/** Whether `signature` is the key's over `data`. */
export async function verifyRelaySignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== ED25519_KEY_BYTES || signature.length !== ED25519_SIGNATURE_BYTES) {
    return false
  }
  try {
    const key = await crypto.subtle.importKey('raw', buffer(publicKey), 'Ed25519', false, [
      'verify',
    ])
    return await crypto.subtle.verify('Ed25519', key, buffer(signature), buffer(data))
  } catch {
    return false
  }
}

/** A host's answer to a challenge from the relay at `origin`. */
export async function signInMessage(
  key: RelayKey,
  origin: string,
  id: string,
  nonce: string,
  token: string,
): Promise<HostToRelay> {
  const signature = await key.sign(signInText(origin, id, nonce))
  return {
    type: 'sign-in',
    publicKey: encodeRelayBytes(key.publicKey),
    signature: encodeRelayBytes(signature),
    token,
  }
}
