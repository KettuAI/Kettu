// Listing the signed-in account's online computers from the Kettu relays and running one-click
// Noise IK discovery pairing with six-digit code confirmation in the hosted web client.
// Imports nothing of Node.js.

import type { Platform } from '@shared/platform'
import {
  HandshakeDropped,
  startDeviceChannel,
  type DeviceChannel,
} from '@shared/remote/device-channel'
import { DISCOVER_PROLOGUE, deviceDiscovery } from '@shared/remote/discovery'
import { PAIR_HOST_TIMEOUT_MS } from '@shared/remote/hosts'
import { awaitWelcome, hello } from '@shared/remote/link'
import type { KeyPair } from '@shared/remote/noise'
import type { Paired } from '@shared/remote/pair'
import { BROWSER_PAIRING_PATH } from '@shared/remote/pairing'
import type { ClosingReason, Hello } from '@shared/remote/protocol'
import {
  HOSTS_FEATURE,
  decodeRelayBytes,
  encodeRelayBytes,
  hostsPath,
  parseRelayHosts,
  parseRelayInfo,
  relayInfoPath,
  relayList,
  type RelayRegion,
} from '@shared/remote/relay'
import type { Transport } from '@shared/remote/transport'
import type { SystemLogoName } from '@renderer/components/system-logo'
import type { HostedHost } from './hosts'

const FETCH_TIMEOUT_MS = 15_000

/** Whether a paired host is folded away under another account than `accountId`. */
function isFolded(host: HostedHost, accountId: string): boolean {
  if (host.otherAccount) return true
  return host.account !== undefined && host.account !== null && host.account !== accountId
}

/** An online computer of the signed-in account that this browser may pair with in one click. */
export interface HostedDiscoveredHost {
  relayId: string
  /** The host's 32-byte X25519 public key. */
  hostKey: Uint8Array
  /** Base64url form of `hostKey`, as returned by relay `GET /v1/hosts`. */
  key: string
  name: string
  platform: Platform
  /** Relay origins that listed this host. */
  relays: string[]
}

/** Result of fetching the signed-in account's available computers from the relays. */
export type HostedDiscoveredHosts =
  | { state: 'ok'; hosts: HostedDiscoveredHost[] }
  | { state: 'signed_out' }
  | { state: 'unavailable' }

/** Why one-click discovery pairing did not finish. */
export type DiscoveryPairFailure =
  | 'void'
  | 'rejected'
  | 'unreachable'
  | 'wrong_account'
  | 'other_account'
  | 'signed_out'
  | 'host_offline'
  | 'busy'
  | 'cooling_down'
  | 'update_client'
  | 'update_host'

/** Progress of a one-click discovery pairing attempt. */
export type DiscoveryPairProgress =
  | { state: 'connecting' }
  | { state: 'compare'; code: string; matched: boolean }
  | { state: 'failed'; reason: DiscoveryPairFailure }

/** An in-flight one-click discovery pairing attempt. */
export interface DiscoveryPairSession {
  /** Confirm that both screens show the same six-digit code. */
  confirm(): void
  /** Cancel the attempt and close any open socket or channel. */
  cancel(): void
  /** Resolves with the welcomed connection once both sides confirm, or null on cancel/failure. */
  readonly done: Promise<Paired | null>
}

export type FetchRelayJson = (
  url: string,
  token?: string | null,
  signal?: AbortSignal,
) => Promise<{ status: number; body: unknown }>

export interface ListAccountHostsOptions {
  /** Main relay origin, e.g. `https://relay.kettu.sh`. */
  main: string
  /** Bearer token for the relays (relay token when supported, else account access token). */
  token(): Promise<string | null>
  /** Filters relay origins to those allowed to receive the token from `token()`. */
  allowed(urls: string[]): string[]
  /** Computers already paired in this browser for the signed-in account. */
  paired: readonly HostedHost[]
  /** Signed-in Kettu account id, used to ignore hosts folded under another account. */
  accountId: string
  /** Whether the account is still signed in when `token()` returns null (e.g. offline). */
  isSignedIn?(): boolean
  /** Called when a relay answers 401 so the account client can re-check session validity. */
  onUnauthorized?(): void
  fetchJson?: FetchRelayJson
  signal?: AbortSignal
}

/** Whether the hosted web client should open the pairing page instead of the paired app. */
export function shouldShowHostedPairing(
  pathname: string,
  hasHost: boolean,
  hasDevice: boolean,
): boolean {
  return pathname === BROWSER_PAIRING_PATH || !hasHost || !hasDevice
}

/** Display name for a computer's platform identifier. */
export function platformDisplayName(platform: string): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  if (platform === 'ios') return 'iOS'
  if (platform === 'ipados') return 'iPadOS'
  return platform
}

/** System logo name for a computer's platform identifier, or null when generic. */
export function platformLogoName(platform: string): SystemLogoName | null {
  switch (platform) {
    case 'darwin':
    case 'ios':
    case 'ipados':
      return 'apple'
    case 'win32':
      return 'windows'
    case 'linux':
      return 'linux'
    default:
      return null
  }
}

const RETRYABLE_FAILURES: ReadonlySet<DiscoveryPairFailure> = new Set([
  'void',
  'rejected',
  'unreachable',
  'busy',
  'host_offline',
])

/** Whether offering an immediate Try again action makes sense for this discovery failure. */
export function canRetryDiscoveryFailure(reason: DiscoveryPairFailure): boolean {
  return RETRYABLE_FAILURES.has(reason)
}

/** Maps a host closing reason during discovery to a user-facing discovery pairing failure. */
export function discoveryFailure(reason: ClosingReason | null): DiscoveryPairFailure {
  switch (reason) {
    case 'rejected':
    case 'busy':
    case 'cooling_down':
    case 'update_client':
    case 'update_host':
    case 'other_account':
      return reason
    case 'remote_off':
    case 'stopping':
    case 'unavailable':
      return 'host_offline'
    default:
      return 'void'
  }
}

async function fetchRelayJsonDefault(
  url: string,
  token?: string | null,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      cache: 'no-store',
      signal: controller.signal,
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Fetches online computers of the signed-in account across the allowed Kettu relays, merges
 * duplicate entries by relay id, and filters out computers already paired in this browser.
 */
export async function listAccountHosts(
  options: ListAccountHostsOptions,
): Promise<HostedDiscoveredHosts> {
  const fetchJson = options.fetchJson ?? fetchRelayJsonDefault
  let regions: RelayRegion[] = []
  try {
    const { status, body } = await fetchJson(
      `${options.main}${relayInfoPath()}`,
      null,
      options.signal,
    )
    const info = status === 200 ? parseRelayInfo(body) : null
    if (info && !info.features.includes(HOSTS_FEATURE)) return { state: 'unavailable' }
    if (info) regions = info.regions
  } catch {
    if (options.signal?.aborted) return { state: 'unavailable' }
    // Fall back to querying the main relay directly.
  }

  if (options.signal?.aborted) return { state: 'unavailable' }
  const token = await options.token()
  if (options.signal?.aborted) return { state: 'unavailable' }
  if (!token) {
    return options.isSignedIn?.() ? { state: 'unavailable' } : { state: 'signed_out' }
  }

  const listedRelays = relayList(options.main, regions).map((region) => region.url)
  const relays = options.allowed(listedRelays)
  if (relays.length === 0) return { state: 'unavailable' }

  const answers = await Promise.all(
    relays.map(async (url) => {
      try {
        const { status, body } = await fetchJson(`${url}${hostsPath()}`, token, options.signal)
        if (status === 401) return 'unauthorized' as const
        return status === 200 ? parseRelayHosts(body) : null
      } catch {
        return null
      }
    }),
  )
  if (options.signal?.aborted) return { state: 'unavailable' }

  if (!answers.some(Array.isArray)) {
    if (answers.includes('unauthorized')) {
      options.onUnauthorized?.()
      return { state: 'signed_out' }
    }
    return { state: 'unavailable' }
  }

  const activePaired = options.paired.filter((host) => !isFolded(host, options.accountId))
  const pairedIds = new Set(activePaired.map((host) => host.relay.id))
  const pairedKeys = new Set(activePaired.map((host) => encodeRelayBytes(host.hostKey)))

  const byId = new Map<string, HostedDiscoveredHost>()
  answers.forEach((answer, index) => {
    if (!Array.isArray(answer)) return
    const relay = relays[index]!
    for (const entry of answer) {
      const kept = byId.get(entry.id)
      if (kept) {
        if (!kept.relays.includes(relay)) kept.relays.push(relay)
        continue
      }
      if (pairedIds.has(entry.id) || pairedKeys.has(entry.key)) continue
      const hostKey = decodeRelayBytes(entry.key)
      if (!hostKey) continue
      byId.set(entry.id, {
        relayId: entry.id,
        hostKey,
        key: entry.key,
        name: entry.name,
        platform: entry.platform as Platform,
        relays: [relay],
      })
    }
  })

  return { state: 'ok', hosts: [...byId.values()] }
}

export interface DiscoveryPairOptions {
  host: HostedDiscoveredHost
  /** Opens a relay transport to the target host; honors `signal` for cancellation. */
  dial(signal: AbortSignal): Promise<Transport>
  key: KeyPair
  client: Hello['client']
  device: NonNullable<Hello['device']>
  account?: string | null
  /** Extra hello features beyond the base web link's own, such as `relay.regions`. */
  features?: string[]
  /** Maps a dial error to a discovery failure; defaults to `unreachable`. */
  dialFailure?(error: unknown): DiscoveryPairFailure | null
  /** Maximum milliseconds to wait for the Noise handshake to finish. */
  handshakeTimeoutMs?: number
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Runs the standard `kettu-channel/1 discover` Noise IK handshake and commit-reveal six-digit code
 * exchange with a computer listed by the relay. Resolves with the welcomed `Paired` connection
 * once both sides confirm, or `null` if cancelled or failed.
 */
export function pairDiscoveredHost(
  options: DiscoveryPairOptions,
  progress: (state: DiscoveryPairProgress) => void,
): DiscoveryPairSession {
  const aborting = new AbortController()
  let cancelled = false
  let settled = false
  let matched = false
  let code: string | null = null
  let transport: Transport | null = null
  let activeChannel: DeviceChannel | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
  }

  const closeAll = (): void => {
    clearTimer()
    activeChannel?.close()
    transport?.close()
  }

  const fail = (reason: DiscoveryPairFailure): null => {
    if (settled) return null
    settled = true
    closeAll()
    if (!cancelled) progress({ state: 'failed', reason })
    return null
  }

  const run = async (): Promise<Paired | null> => {
    progress({ state: 'connecting' })

    try {
      transport = await options.dial(aborting.signal)
    } catch (error) {
      if (cancelled || aborting.signal.aborted || isAbortError(error)) {
        settled = true
        return null
      }
      return fail(options.dialFailure?.(error) ?? 'unreachable')
    }

    if (cancelled || settled) {
      transport.close()
      settled = true
      return null
    }

    let channel: DeviceChannel
    try {
      const { opened } = await startDeviceChannel({
        transport,
        hostKey: options.host.hostKey,
        key: options.key,
        prologue: DISCOVER_PROLOGUE,
        hello: null,
      })
      const timeoutMs = options.handshakeTimeoutMs ?? PAIR_HOST_TIMEOUT_MS
      let timedOut = false
      handshakeTimer = setTimeout(() => {
        timedOut = true
        transport?.close()
      }, timeoutMs)
      try {
        channel = await opened
      } catch (error) {
        clearTimer()
        if (cancelled || aborting.signal.aborted) {
          settled = true
          return null
        }
        if (timedOut) return fail('unreachable')
        if (error instanceof HandshakeDropped) return fail('host_offline')
        return fail('unreachable')
      }
      clearTimer()
    } catch {
      clearTimer()
      if (cancelled || aborting.signal.aborted) {
        settled = true
        return null
      }
      return fail('unreachable')
    }

    activeChannel = channel
    if (cancelled || settled) {
      closeAll()
      settled = true
      return null
    }

    const exchange = await deviceDiscovery(channel)
    if (cancelled || settled) {
      if ('channel' in exchange) exchange.channel.close()
      else closeAll()
      settled = true
      return null
    }
    if (!('code' in exchange)) return fail(discoveryFailure(exchange.closing))

    activeChannel = exchange.channel
    code = exchange.code

    const waiting = awaitWelcome({ channel: exchange.channel, transport }, null)
    const baseHello = hello(options.client, options.device, options.account)
    const firstHello: Hello =
      options.features && options.features.length > 0
        ? { ...baseHello, features: [...(baseHello.features ?? []), ...options.features] }
        : baseHello

    try {
      await exchange.channel.send(firstHello)
    } catch {
      if (cancelled || settled) {
        settled = true
        return null
      }
      return fail('unreachable')
    }

    if (cancelled || settled) {
      closeAll()
      settled = true
      return null
    }

    progress({ state: 'compare', code, matched: false })

    const answer = await waiting
    if (cancelled || settled) {
      closeAll()
      settled = true
      return null
    }
    if ('welcome' in answer) {
      settled = true
      return {
        opened: { channel: exchange.channel, transport },
        welcome: answer.welcome,
        later: answer.later,
      }
    }
    return fail(discoveryFailure(answer.closing))
  }

  const done = run()

  return {
    confirm: () => {
      if (settled || cancelled || matched || code === null || !activeChannel) return
      matched = true
      progress({ state: 'compare', code, matched: true })
      activeChannel.send({ type: 'pair-confirm' }).catch(() => {
        if (!settled && !cancelled) fail('unreachable')
      })
    },
    cancel: () => {
      if (settled || cancelled) return
      cancelled = true
      settled = true
      aborting.abort()
      closeAll()
    },
    done,
  }
}
