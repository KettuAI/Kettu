// What the host does for a browser's Web Push with Node.js's own crypto: it encrypts each push to
// the subscription (RFC 8291, `aes128gcm` of RFC 8188 in one record), authorizes it at the push
// service with a VAPID token signed by the browser's own key (RFC 8292), and keeps the
// subscription's secrets sealed with a key derived from the host's identity key.

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto'
import { decodeRelayBytes, encodeRelayBytes } from '@shared/remote/relay'
import type { StoredWebPush, WebPushSubscription } from '@shared/remote/web-push'

const CURVE = 'prime256v1'
const SALT_BYTES = 16
const RECORD_SIZE = 4096
const KEY_BYTES = 16
const NONCE_BYTES = 12
const TAG_BYTES = 16
/** The last record's delimiter (RFC 8188). */
const LAST_RECORD = 0x02

/** Who runs the application server, which a push service may contact: the project. */
export const VAPID_SUBJECT = 'https://kettu.sh'
/** How long a VAPID token holds; RFC 8292 allows up to a day. */
const VAPID_LIFETIME_S = 12 * 60 * 60

const STORE_INFO = 'kettu-web-push-store/1'
const STORE_NONCE_BYTES = 12

const ascii = (text: string): Buffer => Buffer.from(text, 'latin1')

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length))

/** Fixed inputs that make an encryption repeatable, for test vectors alone. */
export interface FixedEncryption {
  salt: Uint8Array
  /** The application server's P-256 private key. */
  privateKey: Uint8Array
}

/**
 * A push's body: `plaintext` encrypted to the subscription's key and authentication secret, as one
 * record with the header's salt, record size and the application server's fresh public key.
 * Throws when `p256dh` is not a point on the curve.
 */
export function encryptWebPush(
  plaintext: Uint8Array,
  p256dh: Uint8Array,
  auth: Uint8Array,
  fixed?: FixedEncryption,
): Buffer {
  const ecdh = createECDH(CURVE)
  if (fixed) ecdh.setPrivateKey(fixed.privateKey)
  else ecdh.generateKeys()
  const serverPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(p256dh)
  const keyInfo = Buffer.concat([ascii('WebPush: info\0'), p256dh, serverPublic])
  const ikm = hkdf(shared, auth, keyInfo, 32)
  const salt = fixed ? Buffer.from(fixed.salt) : randomBytes(SALT_BYTES)
  const key = hkdf(ikm, salt, ascii('Content-Encoding: aes128gcm\0'), KEY_BYTES)
  const nonce = hkdf(ikm, salt, ascii('Content-Encoding: nonce\0'), NONCE_BYTES)
  const cipher = createCipheriv('aes-128-gcm', key, nonce)
  const sealed = Buffer.concat([
    cipher.update(plaintext),
    cipher.update(Uint8Array.of(LAST_RECORD)),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const header = Buffer.alloc(SALT_BYTES + 5)
  salt.copy(header)
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES)
  header[SALT_BYTES + 4] = serverPublic.length
  return Buffer.concat([header, serverPublic, sealed])
}

/** The P-256 key whose 32 private bytes are `privateKey` and whose public key is `publicKey`. */
function vapidKey(publicKey: Uint8Array, privateKey: Uint8Array) {
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: encodeRelayBytes(privateKey),
      x: encodeRelayBytes(publicKey.subarray(1, 33)),
      y: encodeRelayBytes(publicKey.subarray(33, 65)),
    },
    format: 'jwk',
  })
}

/** Whether the private key's public half is `publicKey`, so the pair a browser sent is one. */
export function isVapidPair(publicKey: Uint8Array, privateKey: Uint8Array): boolean {
  try {
    const ecdh = createECDH(CURVE)
    ecdh.setPrivateKey(privateKey)
    return ecdh.getPublicKey().equals(publicKey)
  } catch {
    return false
  }
}

/** Whether a subscription's keys are ones: its key a point on the curve, its VAPID pair a pair. */
export function isUsableSubscription(subscription: WebPushSubscription): boolean {
  const p256dh = decodeRelayBytes(subscription.p256dh)
  const publicKey = decodeRelayBytes(subscription.vapid.publicKey)
  const privateKey = decodeRelayBytes(subscription.vapid.privateKey)
  if (!p256dh || !publicKey || !privateKey || !isVapidPair(publicKey, privateKey)) return false
  try {
    const ecdh = createECDH(CURVE)
    ecdh.generateKeys()
    ecdh.computeSecret(p256dh)
    return true
  } catch {
    return false
  }
}

/** The `Authorization` header of a push to `endpoint`, valid for half a day from `now`. */
export function vapidAuthorization(
  endpoint: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  now: number,
): string {
  const part = (value: unknown): string => encodeRelayBytes(Buffer.from(JSON.stringify(value)))
  const header = part({ typ: 'JWT', alg: 'ES256' })
  const claims = part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + VAPID_LIFETIME_S,
    sub: VAPID_SUBJECT,
  })
  const signature = sign('sha256', ascii(`${header}.${claims}`), {
    key: vapidKey(publicKey, privateKey),
    dsaEncoding: 'ieee-p1363',
  })
  return `vapid t=${header}.${claims}.${encodeRelayBytes(signature)}, k=${encodeRelayBytes(publicKey)}`
}

/** The key the host seals subscriptions' secrets with, derived from its identity's private key. */
export function webPushStoreKey(identityPrivateKey: Uint8Array): Buffer {
  return hkdf(identityPrivateKey, new Uint8Array(0), ascii(STORE_INFO), 32)
}

/** A subscription's secrets as the host needs them to send. */
export interface WebPushSecrets {
  auth: Uint8Array
  vapidPrivateKey: Uint8Array
}

/** The sealed copy binds the device and the endpoint, so it opens for that subscription alone. */
const storeAad = (deviceId: string, endpoint: string): Buffer =>
  Buffer.from(`${deviceId}\n${endpoint}`)

/** The subscription as the host keeps it for `deviceId`, its secrets sealed with `storeKey`. */
export function storeWebPush(
  subscription: WebPushSubscription,
  deviceId: string,
  storeKey: Uint8Array,
): StoredWebPush {
  const nonce = randomBytes(STORE_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', storeKey, nonce)
  cipher.setAAD(storeAad(deviceId, subscription.endpoint))
  const secrets = JSON.stringify({ auth: subscription.auth, key: subscription.vapid.privateKey })
  const sealed = Buffer.concat([
    nonce,
    cipher.update(secrets, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return {
    endpoint: subscription.endpoint,
    p256dh: subscription.p256dh,
    vapidKey: subscription.vapid.publicKey,
    sealed: encodeRelayBytes(sealed),
  }
}

/** The secrets of a stored subscription, or null when they do not open with `storeKey`. */
export function openWebPushSecrets(
  stored: StoredWebPush,
  deviceId: string,
  storeKey: Uint8Array,
): WebPushSecrets | null {
  const sealed = decodeRelayBytes(stored.sealed)
  if (!sealed || sealed.length <= STORE_NONCE_BYTES + TAG_BYTES) return null
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      storeKey,
      sealed.subarray(0, STORE_NONCE_BYTES),
    )
    decipher.setAAD(storeAad(deviceId, stored.endpoint))
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
    const text = Buffer.concat([
      decipher.update(sealed.subarray(STORE_NONCE_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
    const { auth, key } = JSON.parse(text) as { auth?: unknown; key?: unknown }
    const authBytes = typeof auth === 'string' ? decodeRelayBytes(auth) : null
    const keyBytes = typeof key === 'string' ? decodeRelayBytes(key) : null
    if (authBytes?.length !== 16 || keyBytes?.length !== 32) return null
    return { auth: authBytes, vapidPrivateKey: keyBytes }
  } catch {
    return null
  }
}
