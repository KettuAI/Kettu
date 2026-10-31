// What a device and the host say on the channel around the host protocol: the device's hello, the
// host's welcome, the device's name, and why the host ends a connection. After the welcome, the
// channel's other JSON messages are the host protocol's requests, responses and events, as a
// window's port carries them.

import type { Platform } from '../platform'
import { parseDirectAddress } from './address'
import { DEVICE_ID, isDeviceModel, normalizeDeviceName } from './device'

/** The newest protocol version this side speaks; one number covers every change on the channel. */
export const PROTOCOL_VERSION = 1

/** The oldest version this side still speaks, raised only by a change an older side cannot read. */
export const MIN_PROTOCOL_VERSION = 1

export interface ProtocolRange {
  min: number
  max: number
}

const MAX_CLIENT_FIELD = 64

/**
 * The device's first message once the handshake is done, and its only one until the host answers.
 * Unknown fields are ignored.
 */
export interface Hello {
  type: 'hello'
  protocol: ProtocolRange
  client: {
    /** `ios`, `web` or `desktop`. */
    kind: string
    version: string
    platform: string
  }
  /** While pairing: the name the device suggests for itself and its model, as "iPhone 17 Pro". */
  device?: { name: string; model: string }
}

/** A direct address the device may also try. */
export interface DirectAddress {
  host: string
  port: number
}

/** The host's answer to a hello it can serve; the host protocol follows it. */
export interface Welcome {
  type: 'welcome'
  /** The version both sides speak from here on. */
  protocol: number
  host: { name: string; platform: Platform; version: string }
  /** What the host offers beyond the base protocol. */
  features: string[]
  /** Who this device is on the host: the owner, for every paired device. */
  role: 'owner'
  /** The device as the host knows it, with the name the owner may have given it when pairing. */
  device: { id: string; name: string }
  /** Whether the device may use the host's terminal; a `terminal` message says when it changes. */
  terminal: boolean
  /** Where the device may also connect directly, the owner's own first; none while it is off. */
  addresses: DirectAddress[]
}

/** The host's direct addresses again, sent to each welcomed device whenever they change. */
export interface Addresses {
  type: 'addresses'
  addresses: DirectAddress[]
}

/**
 * The owner allowed devices the host's terminal or stopped allowing it, sent to each welcomed
 * device. Once it is not allowed, the device's terminals are closed; they keep running on the host.
 */
export interface TerminalAccess {
  type: 'terminal'
  allowed: boolean
}

/** The device renames itself, once welcomed. */
export interface Rename {
  type: 'rename'
  name: string
}

/** The device's name changed, by the owner or by the device itself. */
export interface Renamed {
  type: 'renamed'
  name: string
}

export type ClosingReason =
  /** The device speaks only versions older than the host's oldest: update the app. */
  | 'update_client'
  /** The device speaks only versions newer than the host's newest: update Kettu on the host. */
  | 'update_host'
  /** The device broke the protocol, as with a malformed hello. */
  | 'invalid'
  /** The device was removed from the host. */
  | 'removed'
  /** The owner did not add the device that paired with the code; the code is void. */
  | 'rejected'
  /** The owner turned remote access off. */
  | 'remote_off'
  /** Kettu on the host is quitting or restarting. */
  | 'stopping'
  /** The host cannot run sessions now, as while its agent host restarts; connect again. */
  | 'unavailable'

/** The host's last message on a connection, saying why it ends. */
export interface Closing {
  type: 'closing'
  reason: ClosingReason
}

const OURS: ProtocolRange = { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION }

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isClientField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CLIENT_FIELD
}

/** A hello as the host reads it, or null when it is not one. */
export function parseHello(value: unknown): Hello | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, protocol, client, device } = value as Record<string, unknown>
  if (type !== 'hello' || typeof protocol !== 'object' || protocol === null) return null
  const { min, max } = protocol as Record<string, unknown>
  if (!isVersion(min) || !isVersion(max) || min > max) return null
  if (typeof client !== 'object' || client === null) return null
  const { kind, version, platform } = client as Record<string, unknown>
  if (!isClientField(kind) || !isClientField(version) || !isClientField(platform)) return null
  const hello: Hello = { type, protocol: { min, max }, client: { kind, version, platform } }
  const pairing = parsePairingDevice(device)
  if (pairing) hello.device = pairing
  return hello
}

/** The name and model a pairing device sends, or null when they are not there or not valid. */
function parsePairingDevice(value: unknown): Hello['device'] | null {
  if (typeof value !== 'object' || value === null) return null
  const { name, model } = value as Record<string, unknown>
  const kept = normalizeDeviceName(name)
  return kept && isDeviceModel(model) ? { name: kept, model } : null
}

const CLOSING_REASONS: readonly string[] = [
  'update_client',
  'update_host',
  'invalid',
  'removed',
  'rejected',
  'remote_off',
  'stopping',
  'unavailable',
]

/** A closing as the device reads it, or null when the value is not one. */
export function parseClosing(value: unknown): Closing | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, reason } = value as Record<string, unknown>
  if (type !== 'closing' || !CLOSING_REASONS.includes(reason as string)) return null
  return { type, reason: reason as ClosingReason }
}

const MAX_HOST_FIELD = 256
/** The most addresses a device keeps from one welcome or addresses message. */
export const MAX_WELCOME_ADDRESSES = 64

function isHostField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_HOST_FIELD
}

/** The addresses of a welcome or addresses message that are ones, the rest dropped. */
export function parseAddresses(value: unknown): DirectAddress[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_WELCOME_ADDRESSES)
    .map(parseDirectAddress)
    .filter((address): address is DirectAddress => address !== null)
}

/**
 * A welcome as the device reads it, with the fields it uses, or null when the value is not one
 * or speaks a version this side does not.
 */
export function parseWelcome(value: unknown): Welcome | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, protocol, host, features, device, terminal, addresses } = value as Record<
    string,
    unknown
  >
  if (type !== 'welcome' || !isVersion(protocol)) return null
  if (protocol < MIN_PROTOCOL_VERSION || protocol > PROTOCOL_VERSION) return null
  if (typeof host !== 'object' || host === null) return null
  const { name, platform, version } = host as Record<string, unknown>
  if (!isHostField(name) || !isClientField(platform) || !isClientField(version)) return null
  if (typeof device !== 'object' || device === null) return null
  const { id, name: deviceName } = device as Record<string, unknown>
  const kept = normalizeDeviceName(deviceName)
  if (typeof id !== 'string' || !DEVICE_ID.test(id) || !kept) return null
  return {
    type,
    protocol,
    host: { name, platform: platform as Platform, version },
    features: Array.isArray(features)
      ? features.filter((feature): feature is string => typeof feature === 'string')
      : [],
    role: 'owner',
    device: { id, name: kept },
    terminal: terminal === true,
    addresses: parseAddresses(addresses),
  }
}

/** The newest version both sides speak, or which side has to be updated when there is none. */
export function negotiate(
  theirs: ProtocolRange,
  ours: ProtocolRange = OURS,
): number | 'update_client' | 'update_host' {
  if (theirs.max < ours.min) return 'update_client'
  if (theirs.min > ours.max) return 'update_host'
  return Math.min(theirs.max, ours.max)
}
