// Notifications a host sends a paired iOS device while it is away, through a push gateway that
// hands them to Apple's push service. A device sets its push target and the notifications it wants
// over the channel, from protocol version 4. The host seals each notification to the device's
// X25519 key and signs it with its Ed25519 key, so only the device reads it and no other host can
// pass for this one; it signs each request to the gateway with the same key and sends its Kettu
// access token, so the gateway knows the host and its account. The gateway sees only the target,
// the size and the time. Imports nothing of Node.js, so any side can run it.
//
// The sealed envelope, in bytes:
//
//   envelope  = 0x01 || E || C
//   E         = a fresh X25519 public key, 32 bytes
//   shared    = X25519(e, D), D being the device's X25519 public key
//   okm       = HKDF-SHA256(ikm = shared, salt = E || D, info = "kettu-push-seal/1", 44 bytes)
//   C         = AES-256-GCM(key = okm[0..32], nonce = okm[32..44], aad = 0x01 || E, S || B)
//   B         = the content, UTF-8 JSON
//   S         = Ed25519 signature, 64 bytes, over "kettu-push-content/1\n" || D || E || B
//
// The content names the host by its id, which is the relay's: the first 16 bytes of the SHA-256
// of the host's Ed25519 public key in base32. A device checks S against the key the host gave it
// over the channel, which hashes to that id.

import { currentPrimitives, type KeyPair } from './primitives'
import { decodeRelayBytes, encodeRelayBytes, relayOrigin, type RelayKey } from './relay'

/** The first protocol version in which a device may ask the host for notifications. */
export const PUSH_VERSION = 4

/** The welcome's feature of a host that sends notifications through the push gateway. */
export const PUSH_FEATURE = 'push'

/** The project's push gateway. */
export const PUSH_URL = 'https://push.kettu.sh'

/** Points a development run at another push gateway. */
export const PUSH_URL_ENV = 'KETTU_PUSH_URL'

/** The push gateway: the project's, or the origin `KETTU_PUSH_URL` names; throws for one that is none. */
export function pushUrlFrom(value: string | undefined): string {
  const raw = value?.trim()
  if (!raw) return PUSH_URL
  const origin = relayOrigin(raw)
  if (!origin) throw new Error(`${PUSH_URL_ENV} must be an http or https origin`)
  return origin
}

/** Where a host posts a push on the gateway. */
export const PUSH_PATH = '/v1/push'

/** The headers of a push request beside `Authorization: Bearer <access token>`. */
export const HOST_KEY_HEADER = 'Kettu-Host-Key'
export const SIGNATURE_HEADER = 'Kettu-Signature'

/** The first line of the text a host signs for each request. */
export const REQUEST_CONTEXT = 'kettu-push-request/1'
/** HKDF's info for an envelope's key and nonce. */
export const SEAL_CONTEXT = 'kettu-push-seal/1'
/** What the signature inside an envelope starts with. */
export const CONTENT_CONTEXT = 'kettu-push-content/1'
/** What a notification's tag is hashed from first. */
export const TAG_CONTEXT = 'kettu-push-tag/1'

const SEAL_VERSION = 1
const KEY_BYTES = 32
const SIGNATURE_BYTES = 64
const TAG_BYTES = 16
const NONCE_BYTES = 12

/** How far a request's time may be from the gateway's clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000
/** The longest envelope a request carries, in base64url characters. */
export const MAX_SEALED = 3000
/** The longest request body the gateway reads. */
export const MAX_PUSH_BODY = 8192

/**
 * An APNs device token or Live Activity token: its bytes in lowercase hex. Device tokens are 32
 * bytes today, but Apple says they may grow.
 */
const APNS_TOKEN = /^(?:[0-9a-f]{2}){16,200}$/

/** The longest text a notification's title or body carries. */
export const MAX_PUSH_TITLE = 120
export const MAX_PUSH_BODY_TEXT = 400

export type ApnsEnvironment = 'production' | 'sandbox'

/** Where the host sends a device's notifications. */
export interface PushTarget {
  apns: { token: string; environment: ApnsEnvironment }
  /**
   * The Live Activity tokens: `start` starts one by push, `update` reaches the one running now,
   * which the device sends once the activity has it.
   */
  activity?: { start?: string; update?: string }
}

/** What a device wants to hear of this host. */
export interface NotificationChoices {
  /** A request waits for an answer. */
  permission: boolean
  /** A turn ended in a session that no device or window showed. */
  turnEnded: boolean
  /** A turn failed, a session could not start, or a routine's run failed. */
  errors: boolean
  /** A routine's run ended, or the routines paused near a plan limit. */
  routines: boolean
  /** Only while the user is not at the host, when the host can tell: the desktop app can. */
  onlyAway: boolean
  /** Titles and text; without them a notification says only which host needs the user. */
  details: boolean
  /** Sessions it hears nothing of. */
  muted: string[]
}

export const DEFAULT_CHOICES: NotificationChoices = {
  permission: true,
  turnEnded: true,
  errors: true,
  routines: false,
  onlyAway: true,
  details: true,
  muted: [],
}

/** The most sessions a device mutes. */
export const MAX_MUTED = 500

/** A device's notifications, as the host stores them with the device. */
export interface DevicePush {
  target: PushTarget | null
  choices: NotificationChoices
}

/** `notifications.set`: a new target, none (`null`), or the same (absent), and choices to change. */
export interface NotificationsUpdate {
  target?: PushTarget | null
  choices?: Partial<NotificationChoices>
}

/** What `notifications.get` and `notifications.set` answer. */
export interface NotificationsState {
  choices: NotificationChoices
  /** Whether a target is set, and which Live Activity tokens. */
  target: { apns: boolean; activityStart: boolean; activityUpdate: boolean }
  /** Whether the host is signed in to a Kettu account, which it needs to send any. */
  signedIn: boolean
  /** The host's id and its Ed25519 public key in base64url, which signs what it sends. */
  host: { id: string; key: string }
}

/** The channel requests a device makes of the remote host itself for its notifications. */
export const NOTIFICATIONS_GET = 'notifications.get'
export const NOTIFICATIONS_SET = 'notifications.set'

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200

const isApnsToken = (value: unknown): value is string =>
  typeof value === 'string' && APNS_TOKEN.test(value)

/** A target as a device sends it, or null when it is not one. */
export function parsePushTarget(value: unknown): PushTarget | null {
  if (typeof value !== 'object' || value === null) return null
  const { apns, activity } = value as Record<string, unknown>
  if (typeof apns !== 'object' || apns === null) return null
  const { token, environment } = apns as Record<string, unknown>
  if (!isApnsToken(token)) return null
  if (environment !== 'production' && environment !== 'sandbox') return null
  const target: PushTarget = { apns: { token, environment } }
  if (activity === undefined) return target
  if (typeof activity !== 'object' || activity === null) return null
  const { start, update } = activity as Record<string, unknown>
  if (start !== undefined && !isApnsToken(start)) return null
  if (update !== undefined && !isApnsToken(update)) return null
  if (start === undefined && update === undefined) return target
  target.activity = {
    ...(start === undefined ? {} : { start }),
    ...(update === undefined ? {} : { update }),
  }
  return target
}

const SWITCHES = [
  'permission',
  'turnEnded',
  'errors',
  'routines',
  'onlyAway',
  'details',
] as const satisfies readonly (keyof NotificationChoices)[]

/** Choices to change as a device sends them, or null when any of them is not one. */
export function parseChoices(value: unknown): Partial<NotificationChoices> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const given = value as Record<string, unknown>
  const choices: Partial<NotificationChoices> = {}
  for (const key of SWITCHES) {
    if (given[key] === undefined) continue
    if (typeof given[key] !== 'boolean') return null
    choices[key] = given[key]
  }
  if (given.muted !== undefined) {
    const { muted } = given
    if (!Array.isArray(muted) || muted.length > MAX_MUTED || !muted.every(isId)) return null
    choices.muted = [...new Set(muted)]
  }
  return choices
}

/** `notifications.set`'s params, or null when they are not ones. */
export function parseNotificationsUpdate(value: unknown): NotificationsUpdate | null {
  if (typeof value !== 'object' || value === null) return null
  const { target, choices } = value as Record<string, unknown>
  const update: NotificationsUpdate = {}
  if (target === null) update.target = null
  else if (target !== undefined) {
    const parsed = parsePushTarget(target)
    if (!parsed) return null
    update.target = parsed
  }
  if (choices !== undefined) {
    const parsed = parseChoices(choices)
    if (!parsed) return null
    update.choices = parsed
  }
  return update
}

/** A device's stored notifications, or null when they are not ones. */
export function parseDevicePush(value: unknown): DevicePush | null {
  if (typeof value !== 'object' || value === null) return null
  const { target, choices } = value as Record<string, unknown>
  const parsedTarget = target === null ? null : parsePushTarget(target)
  if (target !== null && !parsedTarget) return null
  const parsedChoices = parseChoices(choices)
  if (!parsedChoices) return null
  return { target: parsedTarget, choices: { ...DEFAULT_CHOICES, ...parsedChoices } }
}

/** The one-time answers a notification offers, by the agent's own names for them. */
export interface PushActions {
  allow: { optionId: string; label: string }
  deny?: { optionId: string; label: string }
}

/** What the host notifies about, as the sealed content says it. */
export type PushEvent =
  /** A request waits: `requestId` answers it with `permissions.respond`, `actions` when they fit. */
  | {
      kind: 'permission'
      sessionId: string
      requestId?: string
      actions?: PushActions
    }
  | { kind: 'turn-ended' | 'error' | 'routine-ended'; sessionId: string }
  /** An agent's routines paused near a plan limit; it opens the Routines page. */
  | { kind: 'routine-paused'; agentId: string }
  /** Removes the notification of the same tag, which no longer applies. */
  | { kind: 'withdraw'; sessionId?: string }
  /** A Live Activity's state: how many requests wait, and the session of the latest. */
  | { kind: 'waiting'; count: number; sessionId?: string }
  /** A Live Activity's attributes, fixed while it runs. */
  | { kind: 'activity' }

/** The content of an envelope, as UTF-8 JSON. */
export type PushContent = {
  v: 1
  /** The host's id. */
  host: string
  hostName: string
  /** When the host sent it, in ms since the epoch. */
  at: number
  /** The notification it replaces or withdraws: its APNs collapse id. */
  tag: string
  /** Present only while the device wants details. */
  title?: string
  body?: string
} & PushEvent

const encoder = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** HKDF-SHA256 (RFC 5869). */
async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const primitives = currentPrimitives()
  const prk = await primitives.hmacSha256(salt, ikm)
  const out = new Uint8Array(length)
  let previous: Uint8Array = new Uint8Array(0)
  for (let i = 1, at = 0; at < length; i++) {
    previous = await primitives.hmacSha256(prk, concat(previous, info, Uint8Array.of(i)))
    out.set(previous.subarray(0, Math.min(previous.length, length - at)), at)
    at += previous.length
  }
  return out
}

/** A notification's tag: what the device's notifications of one subject on this host share. */
export async function pushTag(
  devicePublicKey: Uint8Array,
  hostId: string,
  subject: string,
): Promise<string> {
  const data = concat(
    encoder.encode(`${TAG_CONTEXT}\n`),
    devicePublicKey,
    encoder.encode(`${hostId}\n${subject}`),
  )
  const digest = await currentPrimitives().sha256(data)
  return encodeRelayBytes(digest.subarray(0, TAG_BYTES))
}

function contentText(devicePublicKey: Uint8Array, ephemeral: Uint8Array, body: Uint8Array) {
  return concat(encoder.encode(`${CONTENT_CONTEXT}\n`), devicePublicKey, ephemeral, body)
}

async function envelopeKeys(shared: Uint8Array, ephemeral: Uint8Array, device: Uint8Array) {
  const okm = await hkdf(shared, concat(ephemeral, device), encoder.encode(SEAL_CONTEXT), 44)
  return {
    key: okm.subarray(0, KEY_BYTES),
    nonce: okm.subarray(KEY_BYTES, KEY_BYTES + NONCE_BYTES),
  }
}

/** Seals content to a device's X25519 key, signed with the host's key. */
export async function sealPush(
  content: PushContent,
  devicePublicKey: Uint8Array,
  hostKey: RelayKey,
  /** Only for test vectors: a fixed ephemeral key gives up forward secrecy. */
  ephemeral?: KeyPair,
): Promise<Uint8Array> {
  if (devicePublicKey.length !== KEY_BYTES) throw new RangeError('An X25519 key is 32 bytes')
  const primitives = currentPrimitives()
  const pair = ephemeral ?? (await primitives.generateKeyPair(false))
  const body = encoder.encode(JSON.stringify(content))
  const signature = await hostKey.sign(contentText(devicePublicKey, pair.publicKey, body))
  const shared = await primitives.dh(pair.privateKey, devicePublicKey)
  const { key, nonce } = await envelopeKeys(shared, pair.publicKey, devicePublicKey)
  const header = concat(Uint8Array.of(SEAL_VERSION), pair.publicKey)
  const cipher = await primitives.aesGcm(key)
  return concat(header, await cipher.seal(nonce, concat(signature, body), header))
}

/** An envelope opened by its device: the content's bytes, its signature and what it was signed with. */
export interface OpenedPush {
  body: Uint8Array
  signature: Uint8Array
  /** The text the signature is over. */
  signed: Uint8Array
}

/** Opens an envelope with the device's key; null when it is not one sealed to it. */
export async function openPush(envelope: Uint8Array, device: KeyPair): Promise<OpenedPush | null> {
  const minimum = 1 + KEY_BYTES + 16 + SIGNATURE_BYTES
  if (envelope.length < minimum || envelope[0] !== SEAL_VERSION) return null
  const header = envelope.subarray(0, 1 + KEY_BYTES)
  const ephemeral = envelope.subarray(1, 1 + KEY_BYTES)
  try {
    const primitives = currentPrimitives()
    const shared = await primitives.dh(device.privateKey, ephemeral)
    const { key, nonce } = await envelopeKeys(shared, ephemeral, device.publicKey)
    const cipher = await primitives.aesGcm(key)
    const plain = await cipher.open(nonce, envelope.subarray(header.length), header)
    const signature = plain.subarray(0, SIGNATURE_BYTES)
    const body = plain.subarray(SIGNATURE_BYTES)
    return { body, signature, signed: contentText(device.publicKey, ephemeral, body) }
  } catch {
    return null
  }
}

/** A request's body as the gateway reads it. */
export type PushRequest = {
  /** When the host sent it, in ms since the epoch. */
  time: number
  /** The APNs token: the device's for an alert or background push, a Live Activity's for one. */
  token: string
  environment: ApnsEnvironment
  push: GatewayPush
}

export type GatewayPush =
  /** A notification the device shows; `collapse` replaces an earlier one of the same tag. */
  | { type: 'alert'; sealed: string; collapse: string }
  /** A silent update for the app, as to withdraw a notification. */
  | { type: 'background'; sealed: string }
  /** Starts a Live Activity, its state and its fixed attributes each sealed. */
  | { type: 'liveactivity'; event: 'start'; sealed: string; attributes: string }
  | { type: 'liveactivity'; event: 'update' | 'end'; sealed: string }

/** Why the gateway refused a push, in the body of its answer: `{ "error": <reason> }`. */
export type PushRefusal =
  /** 400: the request is not one. */
  | 'malformed'
  /** 401: the key, the signature or the time does not check out. */
  | 'unauthorized'
  /** 403: the access token is not a signed-in account's. */
  | 'signed_out'
  /** 410: Apple no longer takes the token: the device or the activity is gone. */
  | 'unregistered'
  /** 413: the body is too long. */
  | 'too_big'
  /** 429: too many pushes from the account, the host or the address. */
  | 'too_many'
  /** 502: Apple refused or could not be reached; try again later. */
  | 'apns'
  /** 503: the gateway cannot check the account now; try again later. */
  | 'unavailable'

const BASE64URL = /^[A-Za-z0-9_-]+$/

const isSealed = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_SEALED && BASE64URL.test(value)

const COLLAPSE = /^[A-Za-z0-9_-]{1,64}$/

function parseGatewayPush(value: unknown): GatewayPush | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, sealed, collapse, event, attributes } = value as Record<string, unknown>
  if (!isSealed(sealed)) return null
  switch (type) {
    case 'alert':
      return typeof collapse === 'string' && COLLAPSE.test(collapse)
        ? { type, sealed, collapse }
        : null
    case 'background':
      return { type, sealed }
    case 'liveactivity':
      if (event === 'start')
        return isSealed(attributes) ? { type, event, sealed, attributes } : null
      return event === 'update' || event === 'end' ? { type, event, sealed } : null
    default:
      return null
  }
}

/** A request's body, as the gateway reads it; null when it is not one. */
export function parsePushRequest(text: unknown): PushRequest | null {
  if (typeof text !== 'string' || text.length > MAX_PUSH_BODY) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { time, token, environment, push } = value as Record<string, unknown>
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0) return null
  if (!isApnsToken(token)) return null
  if (environment !== 'production' && environment !== 'sandbox') return null
  const parsed = parseGatewayPush(push)
  return parsed ? { time, token, environment, push: parsed } : null
}

/**
 * The text a host signs for a request: the context, the gateway's origin, the host's id and the
 * request's body, one per line, so a signature fits only that body at that gateway.
 */
export function pushRequestText(origin: string, id: string, body: string): Uint8Array {
  return encoder.encode([REQUEST_CONTEXT, origin, id, body].join('\n'))
}

/** The headers of a request whose body is `body`, signed for the gateway at `origin`. */
export async function pushRequestHeaders(
  key: RelayKey,
  origin: string,
  id: string,
  body: string,
  accessToken: string,
): Promise<Record<string, string>> {
  const signature = await key.sign(pushRequestText(origin, id, body))
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    [HOST_KEY_HEADER]: encodeRelayBytes(key.publicKey),
    [SIGNATURE_HEADER]: encodeRelayBytes(signature),
  }
}

/** The bytes of an envelope in base64url, as a request carries it. */
export const encodeSealed = encodeRelayBytes
export const decodeSealed = decodeRelayBytes
