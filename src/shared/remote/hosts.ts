// Other hosts this computer connects to as a device: what it keeps of each, how each connection
// is doing, and how pasting a pairing link into Add host goes. The remote host owns the list.

import type { Platform } from '../platform'
import { parseDirectAddress } from './address'
import { DEVICE_ID, isDeviceName } from './device'
import type { DirectAddress } from './protocol'

/** How long pairing waits for a finished handshake before the host counts as unreachable. */
export const PAIR_HOST_TIMEOUT_MS = 15_000

/** Where the list is kept in the data folder; main reads it at launch to know whether to start. */
export const HOSTS_FILE = ['remote', 'hosts.json'] as const

/** The most addresses kept for one host: as many as a welcome may carry. */
export const MAX_HOST_ADDRESSES = 64

/** A host this computer was added to. */
export interface KnownHost {
  /** The first 16 bytes of the host's X25519 public key's SHA-256, in hex, as hosts derive ids. */
  id: string
  /** Its X25519 public key, in base64. */
  publicKey: string
  name: string
  platform: Platform
  /** Kettu's version on the host. */
  version: string
  /** Where it is tried, all at once: the code's, then each welcome's and addresses message's. */
  addresses: DirectAddress[]
  /** This computer's name on the host. */
  deviceName: string
  addedAt: number
  /** When a connection last opened or ended; while one is open, when it opened. */
  lastOnlineAt: number | null
  /** The host removed this computer, which connects to it no more. */
  removed: boolean
}

/** Why main could not change a host: renaming needs it online, and the rest need it listed. */
export type HostChangeFailure = 'not_connected' | 'unknown_host'

/** Why a host is not tried again: removed for good, or until one side's Kettu is updated. */
export type HostStop = 'removed' | 'update_client' | 'update_host'

export type HostConnection =
  /** Trying the addresses, until the first try since the host was last online settles. */
  | { state: 'connecting' }
  /** Welcomed, through the address whose handshake finished first. */
  | { state: 'online'; address: DirectAddress }
  /** Not reached; tried again with backoff. */
  | { state: 'offline' }
  | { state: 'stopped'; reason: HostStop }

export interface HostStatus extends KnownHost {
  connection: HostConnection
}

/** Settings › Hosts as main puts it together. */
export interface HostsStatus {
  /** This computer, first in the list. */
  self: { name: string; platform: Platform; version: string; model: string }
  /** The known hosts, or null until the remote host first reports them. */
  hosts: HostStatus[] | null
  /** The device key is kept in a file only the user can read, without the system's encryption. */
  plainTextKey: boolean
  /** The system cannot decrypt the device key, so no host is connected. */
  keyFailed: boolean
}

/** Why pasting a link added no host. */
export type HostPairingFailure =
  /** The host ended the handshake: the code expired, was used, or a new one replaced it. */
  | 'void'
  /** The host's owner did not add this computer. */
  | 'rejected'
  /** No handshake finished within 15 seconds. */
  | 'unreachable'
  | 'update_client'
  | 'update_host'

/** How pairing with a host goes, for the Add host that pasted its link. */
export type HostPairingState =
  | { state: 'connecting' }
  /** The secret checked out; the host's owner decides. */
  | { state: 'confirm' }
  | { state: 'added'; host: HostStatus }
  | { state: 'failed'; reason: HostPairingFailure }

/** What main answers to a pasted link: a pairing under an id, or why it never started. */
export type HostPairStart =
  | { kind: 'pairing'; pairId: number }
  /** Not a pairing link, or not all of one. */
  | { kind: 'invalid' }
  /** This computer's own code. */
  | { kind: 'self' }
  /** The device key cannot be read. */
  | { kind: 'unavailable' }

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

/** A known host as it is kept and reported, or null when the value is not one. */
export function parseKnownHost(value: unknown): KnownHost | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !DEVICE_ID.test(v.id)) return null
  if (!isText(v.publicKey, 64) || !isText(v.name, 256)) return null
  if (!isText(v.platform, 64) || !isText(v.version, 64)) return null
  if (!isDeviceName(v.deviceName) || !isTime(v.addedAt)) return null
  if (!(v.lastOnlineAt === null || isTime(v.lastOnlineAt))) return null
  if (!Array.isArray(v.addresses) || v.addresses.length > MAX_HOST_ADDRESSES) return null
  const addresses = v.addresses.map(parseDirectAddress)
  if (addresses.some((address) => address === null)) return null
  return {
    id: v.id,
    publicKey: v.publicKey,
    name: v.name,
    platform: v.platform as Platform,
    version: v.version,
    addresses: addresses as DirectAddress[],
    deviceName: v.deviceName,
    addedAt: v.addedAt,
    lastOnlineAt: v.lastOnlineAt,
    removed: v.removed === true,
  }
}

const STOPS: readonly string[] = ['removed', 'update_client', 'update_host']

function parseConnection(value: unknown): HostConnection | null {
  if (typeof value !== 'object' || value === null) return null
  const { state, address, reason } = value as Record<string, unknown>
  if (state === 'connecting' || state === 'offline') return { state }
  if (state === 'online') {
    const parsed = parseDirectAddress(address)
    return parsed ? { state, address: parsed } : null
  }
  if (state === 'stopped' && STOPS.includes(reason as string)) {
    return { state, reason: reason as HostStop }
  }
  return null
}

/** A host's status as the remote host reports it, checked where it crosses a process. */
export function parseHostStatus(value: unknown): HostStatus | null {
  const host = parseKnownHost(value)
  const connection = parseConnection((value as { connection?: unknown } | null)?.connection)
  return host && connection ? { ...host, connection } : null
}

const FAILURES: readonly string[] = [
  'void',
  'rejected',
  'unreachable',
  'update_client',
  'update_host',
]

/** A pairing state as the remote host reports it, checked where it crosses a process. */
export function parseHostPairingState(value: unknown): HostPairingState | null {
  if (typeof value !== 'object' || value === null) return null
  const { state, host, reason } = value as Record<string, unknown>
  if (state === 'connecting' || state === 'confirm') return { state }
  if (state === 'added') {
    const parsed = parseHostStatus(host)
    return parsed ? { state, host: parsed } : null
  }
  if (state === 'failed' && FAILURES.includes(reason as string)) {
    return { state, reason: reason as HostPairingFailure }
  }
  return null
}
