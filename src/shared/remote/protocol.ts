// What a device and the host say on the channel around the host protocol: the device's hello, the
// host's welcome, and why the host ends a connection. After the welcome, the channel's JSON
// messages are the host protocol's requests, responses and events, as a window's port carries them.

import type { Platform } from '../platform'

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
  /** Whether the device may use the host's terminal. */
  terminal: boolean
  /** Where the device may also connect directly, the owner's own first; none while it is off. */
  addresses: DirectAddress[]
}

/** The host's direct addresses again, sent to each welcomed device whenever they change. */
export interface Addresses {
  type: 'addresses'
  addresses: DirectAddress[]
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
  const { type, protocol, client } = value as Record<string, unknown>
  if (type !== 'hello' || typeof protocol !== 'object' || protocol === null) return null
  const { min, max } = protocol as Record<string, unknown>
  if (!isVersion(min) || !isVersion(max) || min > max) return null
  if (typeof client !== 'object' || client === null) return null
  const { kind, version, platform } = client as Record<string, unknown>
  if (!isClientField(kind) || !isClientField(version) || !isClientField(platform)) return null
  return { type, protocol: { min, max }, client: { kind, version, platform } }
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
