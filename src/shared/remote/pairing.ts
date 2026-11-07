// Pairing codes: what a code carries to the device, as the fragment of a link, and how the host
// reports a code's progress to whoever opened Add device. The fragment never reaches a server.

import type { PairedDevice } from './device'
import type { DirectAddress } from './protocol'
import { relayIdBytes, relayOrigin, base32 } from './relay'

/**
 * The newest version of a code: 2 adds the host's relay id and relays, and is made only while the
 * host uses the relay, so a code without them stays readable by devices that know only 1.
 */
export const PAIRING_VERSION = 2

/** The version of a code without the relay. */
export const DIRECT_PAIRING_VERSION = 1

/** The page that opens a code, in the app where it is installed or in the web client. */
export const PAIRING_URL = 'https://kettu.sh/pair'

/** The secret's bytes, mixed into the handshake as Noise IKpsk1's pre-shared key. */
export const PAIRING_SECRET_BYTES = 32

/** How long a code takes devices. */
export const PAIRING_TTL_MS = 5 * 60_000

/** The failed handshakes that void a code. */
export const PAIRING_ATTEMPTS = 5

/** The most addresses a code carries, so its QR code stays easy to scan. */
export const MAX_PAIRING_ADDRESSES = 16

/** The most relays a code carries. */
export const MAX_PAIRING_RELAYS = 4

const KEY_BYTES = 32
const HEADER_BYTES = 1 + KEY_BYTES + PAIRING_SECRET_BYTES
const RELAY_ID_BYTES = 16
const MAX_HOST_BYTES = 253
const MAX_RELAY_BYTES = 255

export interface PairingPayload {
  version: number
  /** The host's X25519 public key, which the device's handshake is encrypted to. */
  hostKey: Uint8Array
  secret: Uint8Array
  /** Where the device may connect directly. */
  addresses: DirectAddress[]
  /** From version 2: the host's id on the relay and the relays it is signed in to, in order. */
  relay?: PairingRelay
}

export interface PairingRelay {
  id: string
  /** Each relay's origin, the main one first. */
  urls: string[]
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

// Hosts are IP addresses or ASCII host names; their full check is the settings', which a host
// runs on its own addresses before a code carries them.
const HOST_CHARS = /^[A-Za-z0-9.:_-]+$/

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * The payload as bytes in base64url: the version, the host's key and the secret; from version 2
 * the relay id's 16 bytes, the number of relays and each as its length and its origin in ASCII;
 * then each address as its length, its host in ASCII and its port in two bytes, big-endian.
 */
export function encodePairing(payload: PairingPayload): string {
  if (payload.hostKey.length !== KEY_BYTES || payload.secret.length !== PAIRING_SECRET_BYTES) {
    throw new RangeError('A pairing code takes a 32-byte key and a 32-byte secret')
  }
  const relay = payload.relay ? relayPart(payload.relay) : null
  const addresses = payload.addresses.slice(0, MAX_PAIRING_ADDRESSES)
  const hosts = addresses.map(({ host }) => new TextEncoder().encode(host))
  const length =
    HEADER_BYTES + (relay?.length ?? 0) + hosts.reduce((sum, host) => sum + 3 + host.length, 0)
  const bytes = new Uint8Array(length)
  bytes[0] = relay ? PAIRING_VERSION : DIRECT_PAIRING_VERSION
  bytes.set(payload.hostKey, 1)
  bytes.set(payload.secret, 1 + KEY_BYTES)
  let offset = HEADER_BYTES
  if (relay) {
    bytes.set(relay, offset)
    offset += relay.length
  }
  addresses.forEach(({ host, port }, i) => {
    const encoded = hosts[i]!
    if (encoded.length === 0 || encoded.length > MAX_HOST_BYTES || !HOST_CHARS.test(host)) {
      throw new RangeError(`"${host}" is not a host a pairing code can carry`)
    }
    if (!isPort(port)) throw new RangeError(`${port} is not a port`)
    bytes[offset] = encoded.length
    bytes.set(encoded, offset + 1)
    offset += 1 + encoded.length
    bytes[offset] = port >> 8
    bytes[offset + 1] = port & 0xff
    offset += 2
  })
  return toBase64Url(bytes)
}

/** The relay's part of a version 2 code. */
function relayPart(relay: PairingRelay): Uint8Array {
  const id = relayIdBytes(relay.id)
  if (!id) throw new RangeError(`"${relay.id}" is not a relay id`)
  const urls = relay.urls.slice(0, MAX_PAIRING_RELAYS).map((url) => {
    if (relayOrigin(url) !== url) throw new RangeError(`"${url}" is not a relay origin`)
    const encoded = new TextEncoder().encode(url)
    if (encoded.length > MAX_RELAY_BYTES) throw new RangeError(`"${url}" is too long`)
    return encoded
  })
  const bytes = new Uint8Array(
    RELAY_ID_BYTES + 1 + urls.reduce((sum, url) => sum + 1 + url.length, 0),
  )
  bytes.set(id, 0)
  bytes[RELAY_ID_BYTES] = urls.length
  let offset = RELAY_ID_BYTES + 1
  for (const url of urls) {
    bytes[offset] = url.length
    bytes.set(url, offset + 1)
    offset += 1 + url.length
  }
  return bytes
}

/** The payload, or null when the text is not a code of a version this side reads. */
export function decodePairing(text: string): PairingPayload | null {
  const bytes = fromBase64Url(text)
  if (!bytes || bytes.length < HEADER_BYTES) return null
  const version = bytes[0]
  if (version !== DIRECT_PAIRING_VERSION && version !== PAIRING_VERSION) return null
  let offset = HEADER_BYTES
  let relay: PairingRelay | undefined
  if (version === PAIRING_VERSION) {
    if (offset + RELAY_ID_BYTES + 1 > bytes.length) return null
    const id = base32(bytes.subarray(offset, offset + RELAY_ID_BYTES))
    offset += RELAY_ID_BYTES
    const count = bytes[offset]!
    offset += 1
    if (count > MAX_PAIRING_RELAYS) return null
    const urls: string[] = []
    for (let i = 0; i < count; i++) {
      const length = bytes[offset]
      if (!length || offset + 1 + length > bytes.length) return null
      const url = String.fromCharCode(...bytes.subarray(offset + 1, offset + 1 + length))
      offset += 1 + length
      if (relayOrigin(url) !== url) return null
      urls.push(url)
    }
    relay = { id, urls }
  }
  const addresses: DirectAddress[] = []
  while (offset < bytes.length) {
    const length = bytes[offset]!
    if (length === 0 || offset + 1 + length + 2 > bytes.length) return null
    const host = String.fromCharCode(...bytes.subarray(offset + 1, offset + 1 + length))
    offset += 1 + length
    const port = (bytes[offset]! << 8) | bytes[offset + 1]!
    offset += 2
    if (!HOST_CHARS.test(host) || !isPort(port)) return null
    if (addresses.length === MAX_PAIRING_ADDRESSES) return null
    addresses.push({ host, port })
  }
  return {
    version,
    hostKey: bytes.slice(1, 1 + KEY_BYTES),
    secret: bytes.slice(1 + KEY_BYTES, HEADER_BYTES),
    addresses,
    ...(relay ? { relay } : {}),
  }
}

/** The link a code is shown as, its payload all in the fragment. */
export function pairingLink(payload: PairingPayload): string {
  return `${PAIRING_URL}#${encodePairing(payload)}`
}

/** The payload of a pairing link, or null when the text is not one. */
export function parsePairingLink(link: string): PairingPayload | null {
  const at = link.indexOf('#')
  if (at < 0 || link.slice(0, at) !== PAIRING_URL) return null
  return decodePairing(link.slice(at + 1))
}

/** The path of the web client's pairing page on a host, the code in its fragment. */
export const BROWSER_PAIRING_PATH = '/pair'

/**
 * The link a browser opens a code with: the web client the host serves at one of its addresses.
 * Null for an address a browser cannot open, such as an IPv6 one with a zone.
 */
export function browserPairingLink(address: DirectAddress, payload: PairingPayload): string | null {
  if (address.host.includes('%')) return null
  const host = address.host.includes(':') ? `[${address.host}]` : address.host
  return `http://${host}:${address.port}${BROWSER_PAIRING_PATH}#${encodePairing(payload)}`
}

/**
 * The payload of a link a browser was given: a browser link to any host's web client, or the
 * app's link, which carries the same code.
 */
export function parseBrowserPairingLink(link: string): PairingPayload | null {
  const text = link.trim()
  const app = parsePairingLink(text)
  if (app) return app
  const url = URL.parse(text)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
  if (url.pathname !== BROWSER_PAIRING_PATH || url.hash.length < 2) return null
  return decodePairing(url.hash.slice(1))
}

/**
 * Why a code no longer takes devices: its five minutes ran out, five handshakes failed, the owner
 * rejected the device, Add device closed, another Add device opened, or remote access stopped.
 */
export type PairingEnd = 'expired' | 'attempts' | 'rejected' | 'closed' | 'replaced' | 'stopped'

/** The device whose secret checked out, as its hello describes it. */
export interface PairingDevice {
  name: string
  model: string
  kind: string
  platform: string
  /** Its key is a paired device's already, which adding replaces. */
  known: boolean
}

/** A code's progress, for whoever opened Add device. */
export type PairingState =
  | { state: 'waiting'; link: string; expiresAt: number }
  | { state: 'confirm'; device: PairingDevice }
  | { state: 'added'; device: PairedDevice }
  | { state: 'void'; reason: PairingEnd }

const PAIRING_ENDS: readonly string[] = [
  'expired',
  'attempts',
  'rejected',
  'closed',
  'replaced',
  'stopped',
]

/** A pairing state as a host reports it, checked where it crosses a process. */
export function isPairingState(value: unknown): value is PairingState {
  if (typeof value !== 'object' || value === null) return false
  const pairing = value as Record<string, unknown>
  switch (pairing.state) {
    case 'waiting':
      return typeof pairing.link === 'string' && typeof pairing.expiresAt === 'number'
    case 'confirm': {
      const device = pairing.device as Record<string, unknown> | null
      return (
        typeof device === 'object' &&
        device !== null &&
        ['name', 'model', 'kind', 'platform'].every((key) => typeof device[key] === 'string') &&
        typeof device.known === 'boolean'
      )
    }
    case 'added':
      return typeof (pairing.device as { id?: unknown } | null)?.id === 'string'
    case 'void':
      return PAIRING_ENDS.includes(pairing.reason as string)
    default:
      return false
  }
}
