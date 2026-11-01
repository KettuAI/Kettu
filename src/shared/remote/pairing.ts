// Pairing codes: what a code carries to the device, as the fragment of a link, and how the host
// reports a code's progress to whoever opened Add device. The fragment never reaches a server.

import type { PairedDevice } from './device'
import type { DirectAddress } from './protocol'

export const PAIRING_VERSION = 1

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

const KEY_BYTES = 32
const HEADER_BYTES = 1 + KEY_BYTES + PAIRING_SECRET_BYTES
const MAX_HOST_BYTES = 253

export interface PairingPayload {
  version: number
  /** The host's X25519 public key, which the device's handshake is encrypted to. */
  hostKey: Uint8Array
  secret: Uint8Array
  /** Where the device may connect directly. */
  addresses: DirectAddress[]
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
 * The payload as bytes in base64url: the version, the host's key and the secret, then each
 * address as its length, its host in ASCII and its port in two bytes, big-endian.
 */
export function encodePairing(payload: PairingPayload): string {
  if (payload.hostKey.length !== KEY_BYTES || payload.secret.length !== PAIRING_SECRET_BYTES) {
    throw new RangeError('A pairing code takes a 32-byte key and a 32-byte secret')
  }
  const addresses = payload.addresses.slice(0, MAX_PAIRING_ADDRESSES)
  const hosts = addresses.map(({ host }) => new TextEncoder().encode(host))
  const length = HEADER_BYTES + hosts.reduce((sum, host) => sum + 3 + host.length, 0)
  const bytes = new Uint8Array(length)
  bytes[0] = payload.version
  bytes.set(payload.hostKey, 1)
  bytes.set(payload.secret, 1 + KEY_BYTES)
  let offset = HEADER_BYTES
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

/** The payload, or null when the text is not a code of this version. */
export function decodePairing(text: string): PairingPayload | null {
  const bytes = fromBase64Url(text)
  if (!bytes || bytes.length < HEADER_BYTES || bytes[0] !== PAIRING_VERSION) return null
  const addresses: DirectAddress[] = []
  let offset = HEADER_BYTES
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
    version: PAIRING_VERSION,
    hostKey: bytes.slice(1, 1 + KEY_BYTES),
    secret: bytes.slice(1 + KEY_BYTES, HEADER_BYTES),
    addresses,
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
