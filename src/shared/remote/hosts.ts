// Other hosts this computer connects to as a device: what it keeps of each, how each connection
// is doing, and how pasting a pairing link into Add host goes. The remote host owns the list.

import type { Platform } from '../platform'
import { parseDirectAddress } from './address'
import { DEVICE_ID, isDeviceName } from './device'
import type { DirectAddress } from './protocol'
import { parseHostRelay, relayOrigin, type HostRelay } from './relay'
import { isRegionName } from './relay-regions'

/** How long pairing waits for a finished handshake before the host counts as unreachable. */
export const PAIR_HOST_TIMEOUT_MS = 15_000

/** Where the list is kept in the data folder; main reads it at launch to know whether to start. */
export const HOSTS_FILE = ['remote', 'hosts.json'] as const

/** The most addresses kept for one host: as many as a welcome may carry. */
export const MAX_HOST_ADDRESSES = 64

/** The longest SSH address kept, as long as a host name may be. */
export const MAX_SSH_TARGET = 255

/** The longest key file path kept. */
export const MAX_IDENTITY_FILE = 1024

/**
 * How ssh reaches a machine: the address the user typed or the alias their SSH config names,
 * and, for an address typed by hand, the SSH server's port and the key file ssh is to use alone.
 */
export interface SshAddress {
  target: string
  /** Passed to ssh as `-p`, over the config's `Port`. */
  sshPort?: number
  /** An absolute path, passed to ssh as `-i` with `IdentitiesOnly=yes`; only ssh reads it. */
  identityFile?: string
}

/** How a host added over SSH is reached, and the port its daemon takes channels on there. */
export interface SshRoute extends SshAddress {
  /** On that machine's loopback alone. */
  port: number
}

/** The most machines Add host lists from the user's SSH config. */
export const MAX_SSH_CONFIG_HOSTS = 200

/** A machine of the user's SSH config, as `ssh -G` resolves its alias. */
export interface SshConfigHost {
  alias: string
  user: string
  hostname: string
  port: number
  /** The jump hosts it is reached through, as the config writes them. */
  proxyJump?: string
  /** The known host whose SSH address is this alias. */
  hostId?: string
}

/** The machines of the user's SSH config Add host may add, or why there are none to show. */
export type SshConfigHosts =
  | { state: 'ok'; hosts: SshConfigHost[] }
  /** No ssh program to resolve the aliases with. */
  | { state: 'failed'; reason: 'ssh_missing' }
  /** A file of the config, at `path`, could not be read; `detail` is the system's error. */
  | { state: 'failed'; reason: 'unreadable'; path: string; detail: string }

/** Whether two SSH addresses log in to the same place, which reaches one daemon. */
export const sameSshAddress = (a: SshAddress, b: SshAddress): boolean =>
  a.target === b.target && a.sshPort === b.sshPort

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
  /**
   * The host's id on the Kettu relay and its relays, from the pairing code or a welcome; absent
   * for a host that never said, which is reached directly alone.
   */
  relay?: HostRelay
}

/** Why main could not change a host: renaming needs it online, and the rest need it listed. */
export type HostChangeFailure = 'not_connected' | 'unknown_host'

/** Why a host is not tried again: removed for good, or until one side's Kettu is updated. */
export type HostStop = 'removed' | 'update_client' | 'update_host'

export type HostConnection =
  /** Trying the addresses, until the first try since the host was last online settles. */
  | { state: 'connecting' }
  /**
   * Welcomed, through the address whose handshake finished first, or through the relay at
   * `relay`, in the `region` its signed list names or, with `own`, the relay the host's owner runs;
   * `terminal` while its owner allows devices the terminal.
   */
  | { state: 'online'; address: DirectAddress; terminal?: true }
  | { state: 'online'; relay: string; region?: string; own?: true; terminal?: true }
  /** Not reached; tried again with backoff. `relay` says what the relay answered, if anything. */
  | { state: 'offline'; relay?: RelayProblem }
  | { state: 'stopped'; reason: HostStop }

export interface HostStatus extends KnownHost {
  connection: HostConnection
}

/**
 * Why the relay did not reach a host that has one: every relay said it is not signed in, none
 * answered, this computer is signed in to another account than the host's, or to none.
 */
export type RelayProblem = 'host_offline' | 'unreachable' | 'wrong_account' | 'signed_out'

const RELAY_PROBLEMS: readonly string[] = [
  'host_offline',
  'unreachable',
  'wrong_account',
  'signed_out',
]

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
  /** The install script failed, or no place served signed checksums; the detail says why. */
  | 'ssh_install'
  /** The daemon is installed but not running. */
  | 'ssh_not_running'
  /** Anything else; the detail is the end of what ssh said. */
  | 'ssh_failed'

/** What the page of a host added over SSH does to it over SSH. */
export type SshManageAction =
  /** Installs this computer's version there, as adding does, and connects again. */
  | { kind: 'update' }
  /** Reaches it at another address, once the daemon there has its key. */
  | { kind: 'address'; address: SshAddress }
  /** Uninstalls Kettu there, its sessions and settings too with `data`, then forgets it here. */
  | { kind: 'uninstall'; data: boolean }
  /** Tries it at once, not waiting for the next try; settles once the try did. */
  | { kind: 'reconnect' }

/** Why an action on a host added over SSH did not happen. */
export type SshManageFailure =
  | SshAddFailure
  /** Not known here, or not added over SSH. */
  | 'unknown_host'
  /** Another action on it is under way. */
  | 'busy'
  /** The daemon at the address has another key, or there is none: it is another machine. */
  | 'other_host'
  /** The install script did not install `kettu` there, at `detail`, which was left alone. */
  | 'uninstall_foreign'
  /** A daemon runs there outside its service; only the service was removed. */
  | 'uninstall_running'
  /** The uninstall script failed; the detail is the end of its output. */
  | 'uninstall_failed'

export type SshManageResult =
  { ok: true } | { ok: false; reason: SshManageFailure; detail?: string }

const MANAGE_FAILURES: readonly string[] = [
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
  'unknown_host',
  'busy',
  'other_host',
  'uninstall_foreign',
  'uninstall_running',
  'uninstall_failed',
]

/** An action's result as it crosses a process, or null when it is not one. */
export function parseSshManageResult(value: unknown): SshManageResult | null {
  if (typeof value !== 'object' || value === null) return null
  const { ok, reason, detail } = value as Record<string, unknown>
  if (ok === true) return { ok }
  if (ok !== false || !MANAGE_FAILURES.includes(reason as string)) return null
  const failed = { ok, reason: reason as SshManageFailure } as const
  return typeof detail === 'string' && detail.length > 0
    ? { ...failed, detail: detail.slice(-MAX_FAILURE_DETAIL) }
    : failed
}

/** An action as it crosses a process, its address checked, or null when it is not one. */
export function parseSshManageAction(value: unknown): SshManageAction | null {
  if (typeof value !== 'object' || value === null) return null
  const { kind, address, data } = value as Record<string, unknown>
  if (kind === 'update' || kind === 'reconnect') return { kind }
  if (kind === 'uninstall') return typeof data === 'boolean' ? { kind, data } : null
  if (kind !== 'address') return null
  const parsed = parseSshAddress(address)
  return parsed ? { kind, address: parsed } : null
}

/** Why pasting a link added no host. */
export type HostPairingFailure =
  /** The host ended the handshake: the code expired, was used, or a new one replaced it. */
  | 'void'
  /** The host's owner did not add this computer. */
  | 'rejected'
  /** No handshake finished within 15 seconds. */
  | 'unreachable'
  /** The relay joins only devices signed in to the host's account, which this computer is not. */
  | 'wrong_account'
  /** The code reaches its host only through the relay, which needs a Kettu sign-in. */
  | 'signed_out'
  | 'update_client'
  | 'update_host'
  /** The host of the account is asking its owner about another device. */
  | 'busy'
  /** The host of the account turned down too many requests and takes none for a while. */
  | 'cooling_down'
  /** The host of the account is not on the relay, or no longer lets devices find it. */
  | 'host_offline'
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
  /**
   * Pairing with a host of the account: both screens show `code`; `matched` once this computer's
   * user said it is the same, while the host's owner still decides.
   */
  | { state: 'compare'; code: string; matched: boolean }
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

const isPort = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65535

/** An SSH server's port as typed or kept, 1 to 65535; null otherwise. */
export function parseSshPort(value: unknown): number | null {
  return isPort(value) ? value : null
}

/**
 * A key file's path as chosen or kept: absolute, on POSIX or Windows, and free of control
 * characters, so it reaches ssh as one argument it reads as a file; null otherwise.
 */
export function parseIdentityFile(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTITY_FILE) {
    return null
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
    ? value
    : null
}

/**
 * An SSH address with its options, as it crosses a process: the target as typed, trimmed, and
 * each option absent or valid; null when any part is not.
 */
export function parseSshAddress(value: unknown): SshAddress | null {
  if (typeof value !== 'object' || value === null) return null
  const { target, sshPort, identityFile } = value as Record<string, unknown>
  const parsed = parseSshTarget(target)
  if (parsed === null) return null
  const port = sshPort === undefined ? undefined : parseSshPort(sshPort)
  const file = identityFile === undefined ? undefined : parseIdentityFile(identityFile)
  if (port === null || file === null) return null
  return {
    target: parsed,
    ...(port === undefined ? {} : { sshPort: port }),
    ...(file === undefined ? {} : { identityFile: file }),
  }
}

function parseSshRoute(value: unknown): SshRoute | null {
  if (typeof value !== 'object' || value === null) return null
  const { target, port } = value as Record<string, unknown>
  const address = parseSshAddress(value)
  if (address === null || address.target !== target || !isPort(port)) return null
  return { ...address, port }
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
  const relay = v.relay === undefined ? undefined : parseHostRelay(v.relay)
  if (relay === null) return null
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
    ...(relay ? { relay } : {}),
  }
}

const STOPS: readonly string[] = ['removed', 'update_client', 'update_host']

function parseConnection(value: unknown): HostConnection | null {
  if (typeof value !== 'object' || value === null) return null
  const { state, address, relay, region, own, reason, terminal } = value as Record<string, unknown>
  if (state === 'connecting') return { state }
  if (state === 'offline') {
    return RELAY_PROBLEMS.includes(relay as string)
      ? { state, relay: relay as RelayProblem }
      : { state }
  }
  if (state === 'online') {
    const extra = terminal === true ? { terminal: true as const } : {}
    if (typeof relay === 'string') {
      if (relayOrigin(relay) !== relay) return null
      if (own === true) return { state, relay, own: true, ...extra }
      return { state, relay, ...(isRegionName(region) ? { region } : {}), ...extra }
    }
    const parsed = parseDirectAddress(address)
    return parsed ? { state, address: parsed, ...extra } : null
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
  'wrong_account',
  'signed_out',
  'update_client',
  'update_host',
  'busy',
  'cooling_down',
  'host_offline',
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
  if (state === 'compare') {
    const { code, matched } = fields
    return typeof code === 'string' && /^\d{6}$/.test(code) && typeof matched === 'boolean'
      ? { state, code, matched }
      : null
  }
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
