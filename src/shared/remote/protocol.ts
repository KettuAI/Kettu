// What a device and the host say on the channel around the host protocol: the device's hello, the
// host's welcome, the device's name, and why the host ends a connection. After the welcome, the
// channel's other JSON messages are the host protocol's requests, responses and events, as a
// window's port carries them.

import type { Platform } from '../platform'
import { parseDirectAddress } from './address'
import { DEVICE_ID, isDeviceModel, normalizeDeviceName } from './device'

/**
 * The newest protocol version this side speaks; one number covers every change on the channel.
 * Version 3 added keeping the connection alive with `ping` and `pong` (see keepalive.ts).
 */
export const PROTOCOL_VERSION = 3

/** The oldest version this side still speaks, raised only by a change an older side cannot read. */
export const MIN_PROTOCOL_VERSION = 1

/**
 * The first version whose device sessions outlive their connection: the hello may resume one, the
 * device acknowledges what it applies and asks for a pace, the host may ask it to resync, and a
 * `session.patches` batch may merge several, saying the first seq it covers in `from`.
 */
export const RESUME_VERSION = 2

/** How long the host keeps a device session after its connection drops, for the device to resume. */
export const RESUME_MS = 60_000

/** The pace a device in the background asks for: a batch of patches a second. */
export const BACKGROUND_PACE_MS = 1000

/** The longest pace a device may ask for. */
export const MAX_PACE_MS = 10_000

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
  /**
   * From version 2, the session to take over: the token of the welcome that started or last
   * resumed it, and how many of the host's messages the device received on it since.
   */
  resume?: ResumeRequest
}

export interface ResumeRequest {
  token: string
  received: number
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
  /**
   * From version 2, the token the device's next hello names to resume this session: it works once,
   * while the session lasts, which is up to RESUME_MS after its connection drops.
   */
  resume?: string
  /**
   * From version 2, present when the hello's session was resumed: the id of the last request the
   * host read on it. The device sends again the requests it sent after that one; anything else
   * the host sent and the device did not receive follows the welcome.
   */
  resumed?: { request: number }
}

/**
 * From version 2, the device has applied the first `received` of the host's messages on its
 * session, its JSON and its stream bytes alike; the host keeps the rest until it says so.
 */
export interface Ack {
  type: 'ack'
  received: number
}

/** From version 2, how many milliseconds the host waits between batches of patches it sends. */
export interface Pace {
  type: 'pace'
  ms: number
}

/**
 * From version 2, the host dropped session patches for the device, which fell too far behind: the
 * device fetches the snapshots of the sessions it shows again.
 */
export interface Resync {
  type: 'resync'
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

/**
 * The device's port to the terminal host ended on the terminal host's side, as when it stopped or
 * restarted; sent once for each such port, never for one the host closed itself. `ids` are the
 * terminals the device had created or attached on it, possibly none, which stream no more. The
 * device's next `terminals.*` request opens a new port.
 */
export interface TerminalsRestarted {
  type: 'terminals.restarted'
  ids: string[]
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

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A resume token: base64url, no longer than this. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/

function isClientField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CLIENT_FIELD
}

/** A hello as the host reads it, or null when it is not one. */
export function parseHello(value: unknown): Hello | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, protocol, client, device, resume } = value as Record<string, unknown>
  if (type !== 'hello' || typeof protocol !== 'object' || protocol === null) return null
  const { min, max } = protocol as Record<string, unknown>
  if (!isVersion(min) || !isVersion(max) || min > max) return null
  if (typeof client !== 'object' || client === null) return null
  const { kind, version, platform } = client as Record<string, unknown>
  if (!isClientField(kind) || !isClientField(version) || !isClientField(platform)) return null
  const hello: Hello = { type, protocol: { min, max }, client: { kind, version, platform } }
  const pairing = parsePairingDevice(device)
  if (pairing) hello.device = pairing
  const resuming = parseResume(resume)
  if (resuming) hello.resume = resuming
  return hello
}

function parseResume(value: unknown): ResumeRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const { token, received } = value as Record<string, unknown>
  return typeof token === 'string' && TOKEN.test(token) && isCount(received)
    ? { token, received }
    : null
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
  const { type, protocol, host, features, device, terminal, addresses, resume, resumed } =
    value as Record<string, unknown>
  if (type !== 'welcome' || !isVersion(protocol)) return null
  if (protocol < MIN_PROTOCOL_VERSION || protocol > PROTOCOL_VERSION) return null
  if (typeof host !== 'object' || host === null) return null
  const { name, platform, version } = host as Record<string, unknown>
  if (!isHostField(name) || !isClientField(platform) || !isClientField(version)) return null
  if (typeof device !== 'object' || device === null) return null
  const { id, name: deviceName } = device as Record<string, unknown>
  const kept = normalizeDeviceName(deviceName)
  if (typeof id !== 'string' || !DEVICE_ID.test(id) || !kept) return null
  const welcome: Welcome = {
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
  if (protocol < RESUME_VERSION) return welcome
  if (typeof resume === 'string' && TOKEN.test(resume)) welcome.resume = resume
  const request = (resumed as { request?: unknown } | null | undefined)?.request
  if (isCount(request)) welcome.resumed = { request }
  return welcome
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
