// Notifications a host sends a paired browser as Web Push (RFC 8030), with no server of the
// project's between them. Each browser subscribes with a VAPID key pair of its own (RFC 8292) and
// hands the subscription with the pair's private key to every host it can reach, over the channel,
// so one subscription serves them all. A host encrypts each push to the subscription (RFC 8291)
// and signs its content with its Ed25519 key, so the service worker shows only what a host it
// paired with sent, never what another host that holds the same subscription makes up. Imports
// nothing of Node.js, so any side can run it.
//
// The payload, as the browser hands it to the service worker once it decrypted the push, is text,
// since Chrome hands a worker no payload that is not UTF-8:
//
//   payload = "1." || base64url(S) || "." || B
//   B       = the content, UTF-8 JSON, as push.ts's PushContent
//   S       = Ed25519 signature, 64 bytes, over "kettu-web-push/1\n" || P || B, P being the
//             subscription's P-256 public key, 65 bytes, so a signature fits this browser alone

import type { PushContent } from './push'
import { decodeRelayBytes, encodeRelayBytes, verifyRelaySignature, type RelayKey } from './relay'

/** The welcome's feature of a host that takes a browser's Web Push subscription. */
export const WEB_PUSH_FEATURE = 'web-push'

/** What the signature inside a payload starts with. */
export const WEB_PUSH_CONTEXT = 'kettu-web-push/1'

const PAYLOAD_PREFIX = '1.'
/** A signature of 64 bytes in base64url, unpadded. */
const SIGNATURE_CHARS = 86

/**
 * The longest payload a host sends: the 4096 bytes every push service takes (RFC 8030), less the
 * 86 of the encryption's header, its 16-byte tag and the delimiter of its one record.
 */
export const MAX_WEB_PUSH_PAYLOAD = 4096 - 86 - 16 - 1

/** An uncompressed P-256 public key: 0x04, then its x and y of 32 bytes each. */
const P256_PUBLIC_BYTES = 65
const P256_PRIVATE_BYTES = 32
const AUTH_BYTES = 16
const MAX_ENDPOINT = 2048
/** The longest sealed copy of a subscription's secrets the host stores, in base64url. */
const MAX_SEALED_SECRETS = 512

/**
 * The push services of the browsers Kettu supports: Chrome's, Firefox's, Safari's and Edge's. The
 * host posts to these alone, so a subscription cannot point it at any other address.
 */
const PUSH_SERVICES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
]

/** A browser's subscription as it hands it to a host, every key in base64url. */
export interface WebPushSubscription {
  endpoint: string
  /** The subscription's P-256 public key, which pushes are encrypted to. */
  p256dh: string
  /** Its authentication secret, 16 bytes. */
  auth: string
  /** The VAPID pair it subscribed with: the public key raw, the private key's 32 bytes. */
  vapid: { publicKey: string; privateKey: string }
}

/**
 * A subscription as the host keeps it with the device: what is no secret as it is, and the
 * authentication secret and VAPID private key sealed with a key only the host has.
 */
export interface StoredWebPush {
  endpoint: string
  p256dh: string
  vapidKey: string
  sealed: string
}

/** The host withdrew notifications of these tags, which the page closes if they still show. */
export interface NotificationsWithdrawn {
  type: 'notifications.withdrawn'
  tags: string[]
}

/** The most tags a withdrawal names. */
export const MAX_WITHDRAWN = 200

const BASE64URL = /^[A-Za-z0-9_-]*$/
const TAG = /^[A-Za-z0-9_-]{1,64}$/

function bytesOf(value: unknown, length: number): Uint8Array | null {
  const bytes = typeof value === 'string' ? decodeRelayBytes(value) : null
  return bytes?.length === length ? bytes : null
}

const isP256Public = (value: unknown): boolean => bytesOf(value, P256_PUBLIC_BYTES)?.[0] === 0x04

/** Whether a push endpoint is an https address of one of the push services. */
export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT) return false
  const url = URL.parse(value)
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  return PUSH_SERVICES.some((service) => host === service || host.endsWith(`.${service}`))
}

/** A subscription as a browser sends it, or null when it is not one. */
export function parseWebPushSubscription(value: unknown): WebPushSubscription | null {
  if (typeof value !== 'object' || value === null) return null
  const { endpoint, p256dh, auth, vapid } = value as Record<string, unknown>
  if (!isPushEndpoint(endpoint) || !isP256Public(p256dh) || !bytesOf(auth, AUTH_BYTES)) return null
  if (typeof vapid !== 'object' || vapid === null) return null
  const { publicKey, privateKey } = vapid as Record<string, unknown>
  if (!isP256Public(publicKey) || !bytesOf(privateKey, P256_PRIVATE_BYTES)) return null
  return {
    endpoint,
    p256dh: p256dh as string,
    auth: auth as string,
    vapid: { publicKey: publicKey as string, privateKey: privateKey as string },
  }
}

/** A subscription as the host stored it, or null when it is not one. */
export function parseStoredWebPush(value: unknown): StoredWebPush | null {
  if (typeof value !== 'object' || value === null) return null
  const { endpoint, p256dh, vapidKey, sealed } = value as Record<string, unknown>
  if (!isPushEndpoint(endpoint) || !isP256Public(p256dh) || !isP256Public(vapidKey)) return null
  if (typeof sealed !== 'string' || sealed.length === 0 || sealed.length > MAX_SEALED_SECRETS) {
    return null
  }
  if (!BASE64URL.test(sealed)) return null
  return { endpoint, p256dh: p256dh as string, vapidKey: vapidKey as string, sealed }
}

/** A withdrawal as the host sends it, or null when the message is not one. */
export function parseWithdrawn(message: Record<string, unknown>): string[] | null {
  if (message.type !== 'notifications.withdrawn' || !Array.isArray(message.tags)) return null
  return message.tags
    .slice(0, MAX_WITHDRAWN)
    .filter((tag): tag is string => typeof tag === 'string' && TAG.test(tag))
}

const encoder = new TextEncoder()

function signedText(p256dh: Uint8Array, body: Uint8Array): Uint8Array {
  const context = encoder.encode(`${WEB_PUSH_CONTEXT}\n`)
  const out = new Uint8Array(context.length + p256dh.length + body.length)
  out.set(context)
  out.set(p256dh, context.length)
  out.set(body, context.length + p256dh.length)
  return out
}

/** The payload of a push: the content signed with the host's key for the subscription's key. */
export async function signWebPush(
  content: PushContent,
  p256dh: Uint8Array,
  hostKey: RelayKey,
): Promise<Uint8Array> {
  const text = JSON.stringify(content)
  const signature = await hostKey.sign(signedText(p256dh, encoder.encode(text)))
  return encoder.encode(`${PAYLOAD_PREFIX}${encodeRelayBytes(signature)}.${text}`)
}

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200

const isText = (value: unknown, max: number): boolean =>
  value === undefined || (typeof value === 'string' && value.length <= max)

/** The alert kinds a push shows; withdrawals and Live Activities never come as Web Push. */
export type WebPushContent = PushContent &
  (
    | { kind: 'permission' | 'turn-ended' | 'error' | 'routine-ended'; sessionId: string }
    | { kind: 'routine-paused'; agentId: string }
  )

function parseContent(value: unknown): WebPushContent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const content = value as Record<string, unknown>
  if (content.v !== 1 || !isId(content.host) || typeof content.hostName !== 'string') return null
  if (typeof content.at !== 'number' || typeof content.tag !== 'string') return null
  if (!TAG.test(content.tag) || !isText(content.title, 400) || !isText(content.body, 1200)) {
    return null
  }
  switch (content.kind) {
    case 'permission':
    case 'turn-ended':
    case 'error':
    case 'routine-ended':
      return isId(content.sessionId) ? (content as WebPushContent) : null
    case 'routine-paused':
      return isId(content.agentId) ? (content as WebPushContent) : null
    default:
      return null
  }
}

/**
 * A payload's content once its signature checks out against the key of the host it names; null
 * when the payload is not one, names a host `hostKey` does not know, or was not signed by it.
 */
export async function openWebPush(
  payload: Uint8Array,
  p256dh: Uint8Array,
  hostKey: (hostId: string) => Uint8Array | null,
): Promise<WebPushContent | null> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch {
    return null
  }
  const start = PAYLOAD_PREFIX.length + SIGNATURE_CHARS
  if (!text.startsWith(PAYLOAD_PREFIX) || text[start] !== '.') return null
  const signature = decodeRelayBytes(text.slice(PAYLOAD_PREFIX.length, start))
  const body = text.slice(start + 1)
  let content: WebPushContent | null
  try {
    content = parseContent(JSON.parse(body))
  } catch {
    return null
  }
  const key = content && hostKey(content.host)
  if (!content || !key || !signature) return null
  const signed = signedText(p256dh, encoder.encode(body))
  return (await verifyRelaySignature(key, signature, signed)) ? content : null
}
