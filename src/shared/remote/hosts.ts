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

/** The longest SSH address kept, as long as a host name may be. */
export const MAX_SSH_TARGET = 255

/**
 * How a host added over SSH is reached: the address the user typed, which their SSH config
 * resolves, and the port its daemon takes channels on, on that machine's loopback alone.
 */
export interface SshRoute {
  target: string
  port: number
}

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
  /** Added over SSH: reached through it alone, never at `addresses`. */
  ssh?: SshRoute
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

/** Why adding a machine over SSH added no host. */
export type SshAddFailure =
  /** No `ssh` program on this computer. */
  | 'ssh_missing'
  /** The machine did not answer, or its name did not resolve. */
  | 'ssh_unreachable'
  /** It refused every key and method this computer offered. */
  | 'ssh_auth'
  /** Its host key is not in the user's known hosts yet. */
  | 'ssh_host_unknown'
  /** Its host key differs from the one the user's known hosts hold. */
  | 'ssh_host_changed'
  /** Its SSH server does not forward connections, which the channel needs. */
  | 'ssh_forwarding'
  /** Its system or processor has no daemon package; the detail names them. */
  | 'ssh_unsupported'
  /** The install script failed; the detail is the end of its output. */
  | 'ssh_install'
  /** The daemon is installed but not running. */
  | 'ssh_not_running'
  /** Anything else; the detail is the end of what ssh said. */
  | 'ssh_failed'

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
  | SshAddFailure

/** Where adding a machine over SSH is, in order; installing or updating only when needed. */
export type SshStep =
  | { step: 'connecting' }
  | { step: 'installing'; version: string }
  | { step: 'updating'; from: string; to: string }
  | { step: 'adding' }
  /** The encrypted channel, through SSH to the daemon. */
  | { step: 'opening' }

/** How pairing with a host goes, for the Add host that pasted its link or typed its SSH address. */
export type HostPairingState =
  | { state: 'connecting' }
  /** The secret checked out; the host's owner decides. */
  | { state: 'confirm' }
  | ({ state: 'ssh' } & SshStep)
  | { state: 'added'; host: HostStatus }
  /** `detail`: output to show beside the reason, as the end of a failed install's. */
  | { state: 'failed'; reason: HostPairingFailure; detail?: string }

/** What main answers to a pasted link or an SSH address: a pairing under an id, or why not. */
export type HostPairStart =
  | { kind: 'pairing'; pairId: number }
  /** Not a pairing link, or not all of one; not an SSH address. */
  | { kind: 'invalid' }
  /** This computer's own code. */
  | { kind: 'self' }
  /** The device key cannot be read. */
  | { kind: 'unavailable' }

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

/**
 * An SSH address as typed, trimmed: `user@host`, a host, or an alias of the user's SSH config;
 * null when ssh would read it as an option, or it holds a space or a control character.
 */
export function parseSshTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const target = value.trim()
  if (!target || target.length > MAX_SSH_TARGET || target.startsWith('-')) return null
  // eslint-disable-next-line no-control-regex
  return /[\s\u0000-\u001f\u007f]/.test(target) ? null : target
}

function parseSshRoute(value: unknown): SshRoute | null {
  if (typeof value !== 'object' || value === null) return null
  const { target, port } = value as Record<string, unknown>
  const parsed = parseSshTarget(target)
  if (parsed === null || parsed !== target || !Number.isSafeInteger(port)) return null
  return (port as number) >= 1 && (port as number) <= 65535
    ? { target: parsed, port: port as number }
    : null
}

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
  const ssh = v.ssh === undefined ? undefined : parseSshRoute(v.ssh)
  if (ssh === null) return null
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
    ...(ssh ? { ssh } : {}),
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
  'ssh_missing',
  'ssh_unreachable',
  'ssh_auth',
  'ssh_host_unknown',
  'ssh_host_changed',
  'ssh_forwarding',
  'ssh_unsupported',
  'ssh_install',
  'ssh_not_running',
  'ssh_failed',
]

/** The most of a failure's detail kept, as the last lines of an install's output. */
export const MAX_FAILURE_DETAIL = 4096

const isVersionText = (value: unknown): value is string => isText(value, 64)

function parseSshStep(value: Record<string, unknown>): SshStep | null {
  const { step, version, from, to } = value
  if (step === 'connecting' || step === 'adding' || step === 'opening') return { step }
  if (step === 'installing') return isVersionText(version) ? { step, version } : null
  if (step === 'updating') {
    return isVersionText(from) && isVersionText(to) ? { step, from, to } : null
  }
  return null
}

/** A pairing state as the remote host reports it, checked where it crosses a process. */
export function parseHostPairingState(value: unknown): HostPairingState | null {
  if (typeof value !== 'object' || value === null) return null
  const fields = value as Record<string, unknown>
  const { state, host, reason, detail } = fields
  if (state === 'connecting' || state === 'confirm') return { state }
  if (state === 'ssh') {
    const step = parseSshStep(fields)
    return step ? { state, ...step } : null
  }
  if (state === 'added') {
    const parsed = parseHostStatus(host)
    return parsed ? { state, host: parsed } : null
  }
  if (state === 'failed' && FAILURES.includes(reason as string)) {
    const failed = { state, reason: reason as HostPairingFailure } as const
    return typeof detail === 'string' && detail.length > 0
      ? { ...failed, detail: detail.slice(-MAX_FAILURE_DETAIL) }
      : failed
  }
  return null
}
