// Pairing with a host of the same Kettu account without a code: the relay lists the account's
// hosts, the device runs Noise IK with the discovery prologue to the listed key, and both sides
// show a six-digit code built from a commit-then-reveal exchange. The device's user confirms the
// code matches, which catches a relay that listed a key of its own; the host's owner adds the
// device, which shows they control the host and want it. Imports nothing of Node.js.

import type { Platform } from '../platform'
import { isDeviceModel, isDeviceName } from './device'
import type { DeviceChannel } from './device-channel'
import type { PairingDevice } from './pairing'
import { currentPrimitives } from './primitives'
import { parseClosing, type ClosingReason } from './protocol'
import {
  MAX_LISTED_HOSTS,
  MAX_PROFILE_NAME,
  decodeRelayBytes,
  encodeRelayBytes,
  isRelayHostId,
} from './relay'

/** Binds a discovery handshake apart from a paired device's and a code's. */
export const DISCOVER_PROLOGUE = new TextEncoder().encode('kettu-channel/1 discover')

/** How long the host's owner and the device's user have to answer. */
export const DISCOVERY_ASK_MS = 2 * 60_000

/** Requests rejected or voided in a row before the host takes none for a while. */
export const DISCOVERY_STRIKES = 3

/** How long a host takes no discovery request after DISCOVERY_STRIKES. */
export const DISCOVERY_COOLDOWN_MS = 10 * 60_000

/** The bytes of each side's random nonce. */
export const DISCOVERY_NONCE_BYTES = 32

/** The device's first message on the channel: the SHA-256 of its nonce, in base64url. */
export interface PairCommit {
  type: 'pair-commit'
  commit: string
}

/** The host's answer to the commit: its nonce, in base64url. */
export interface PairNonce {
  type: 'pair-nonce'
  nonce: string
}

/** The device's nonce, in base64url, after which both sides know the code. */
export interface PairReveal {
  type: 'pair-reveal'
  nonce: string
}

/** The device's user saw the same code on both screens. */
export interface PairConfirm {
  type: 'pair-confirm'
}

export type DiscoveryMessage = PairCommit | PairNonce | PairReveal | PairConfirm

/** A host of the account, as this computer may pair with it; paired ones and itself left out. */
export interface DiscoveredHost {
  /** The host's id on the relay. */
  relayId: string
  /** Its X25519 public key, in base64, as a known host keeps it. */
  publicKey: string
  name: string
  platform: Platform
}

/** What listing the account's hosts gives. */
export type DiscoveredHosts =
  | { state: 'ok'; hosts: DiscoveredHost[] }
  /** No Kettu sign-in, so no relay to ask. */
  | { state: 'signed_out' }
  /** No relay answered. */
  | { state: 'unavailable' }

/** Why a discovery request ended on the host. */
export type DiscoveryEnd =
  | 'added'
  | 'rejected'
  /** The device's user cancelled, said the codes differ, or its connection ended. */
  | 'cancelled'
  | 'expired'
  /** Remote access stopped, or discovery was turned off. */
  | 'stopped'

/** A discovery request as the host's owner sees it. */
export type DiscoveryRequestState =
  | {
      state: 'confirm'
      device: PairingDevice
      code: string
      startedAt: number
      expiresAt: number
    }
  | { state: 'closed'; reason: DiscoveryEnd }

/** A discovery request's progress, to every window of the host. */
export interface DiscoveryRequestEvent {
  requestId: number
  request: DiscoveryRequestState
}

const CODE_CONTEXT = new TextEncoder().encode('kettu-pair-code/1')

const isNonce = (value: unknown): value is string =>
  typeof value === 'string' && decodeRelayBytes(value)?.length === DISCOVERY_NONCE_BYTES

/** A new nonce for one side of the exchange. */
export function discoveryNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(DISCOVERY_NONCE_BYTES))
}

/** The device's commit to its nonce: its SHA-256, in base64url. */
export async function pairCommit(nonce: Uint8Array): Promise<string> {
  return encodeRelayBytes(await currentPrimitives().sha256(nonce))
}

/**
 * The code both screens show: the first four bytes of SHA-256 over the context, the handshake's
 * hash and both nonces, as a big-endian number, modulo a million, in six digits.
 */
export async function pairCode(
  handshakeHash: Uint8Array,
  hostNonce: Uint8Array,
  deviceNonce: Uint8Array,
): Promise<string> {
  const parts = [CODE_CONTEXT, handshakeHash, hostNonce, deviceNonce]
  const input = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    input.set(part, offset)
    offset += part.length
  }
  const digest = await currentPrimitives().sha256(input)
  const number = new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0)
  return String(number % 1_000_000).padStart(6, '0')
}

/** Whether the object has exactly these keys. */
function only(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const own = Object.keys(value)
  return own.length === keys.length && own.every((key) => keys.includes(key))
}

export function parsePairCommit(value: unknown): PairCommit | null {
  if (!only(value, ['type', 'commit']) || value.type !== 'pair-commit') return null
  return isNonce(value.commit) ? { type: 'pair-commit', commit: value.commit } : null
}

export function parsePairNonce(value: unknown): PairNonce | null {
  if (!only(value, ['type', 'nonce']) || value.type !== 'pair-nonce') return null
  return isNonce(value.nonce) ? { type: 'pair-nonce', nonce: value.nonce } : null
}

export function parsePairReveal(value: unknown): PairReveal | null {
  if (!only(value, ['type', 'nonce']) || value.type !== 'pair-reveal') return null
  return isNonce(value.nonce) ? { type: 'pair-reveal', nonce: value.nonce } : null
}

export function parsePairConfirm(value: unknown): PairConfirm | null {
  return only(value, ['type']) && value.type === 'pair-confirm' ? { type: 'pair-confirm' } : null
}

/** Whether the revealed nonce is the one the commit named. */
export async function revealMatches(commit: string, nonce: Uint8Array): Promise<boolean> {
  const expected = decodeRelayBytes(commit)
  const actual = await currentPrimitives().sha256(nonce)
  if (!expected || expected.length !== actual.length) return false
  let difference = 0
  for (let i = 0; i < actual.length; i++) difference |= expected[i]! ^ actual[i]!
  return difference === 0
}

/** The device's side once the handshake is done: the code, or why the host ended it. */
export type DeviceDiscovery =
  /** `channel`: the same channel, its messages after the nonce passed on to the next listener. */
  | { code: string; channel: DeviceChannel }
  /** The host's closing reason, or null when it said none or broke the exchange. */
  | { closing: ClosingReason | null }

/**
 * Commits to a nonce, reads the host's, reveals its own and works out the code. Anything out of
 * order ends the connection. The commit goes before the host's nonce is seen, so whoever sits in
 * the middle cannot try nonces until the codes match.
 */
export async function deviceDiscovery(channel: DeviceChannel): Promise<DeviceDiscovery> {
  const nonce = discoveryNonce()
  const commit = await pairCommit(nonce)
  return new Promise((resolve) => {
    let done = false
    let closing: ClosingReason | null = null
    const later: unknown[] = []
    let next: ((value: unknown) => void) | null = null
    const fail = (): void => {
      if (done) return
      done = true
      channel.close()
      resolve({ closing })
    }
    channel.onMessage((value) => {
      if (done) {
        if (next) next(value)
        else later.push(value)
        return
      }
      const closed = parseClosing(value)
      if (closed) {
        closing = closed.reason
        return
      }
      const answer = parsePairNonce(value)
      if (!answer) return fail()
      done = true
      void (async () => {
        const reveal: PairReveal = { type: 'pair-reveal', nonce: encodeRelayBytes(nonce) }
        await channel.send(reveal)
        const code = await pairCode(channel.handshakeHash, decodeRelayBytes(answer.nonce)!, nonce)
        const onMessage = (listener: (value: unknown) => void): void => {
          next = listener
          for (const value of later.splice(0)) listener(value)
        }
        resolve({ code, channel: { ...channel, onMessage } })
      })().catch(() => {
        channel.close()
        resolve({ closing: null })
      })
    })
    void channel.closed.then(() => {
      if (done) return
      done = true
      resolve({ closing })
    })
    const first: PairCommit = { type: 'pair-commit', commit }
    channel.send(first).catch(fail)
  })
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

/** What `hosts:discover` answered, checked where it crosses a process; null if not one. */
export function parseDiscoveredHosts(value: unknown): DiscoveredHosts | null {
  if (typeof value !== 'object' || value === null) return null
  const { state, hosts } = value as Record<string, unknown>
  if (state === 'signed_out' || state === 'unavailable') return { state }
  if (state !== 'ok' || !Array.isArray(hosts) || hosts.length > MAX_LISTED_HOSTS) return null
  const kept: DiscoveredHost[] = []
  for (const entry of hosts) {
    if (typeof entry !== 'object' || entry === null) return null
    const { relayId, publicKey, name, platform } = entry as Record<string, unknown>
    if (!isRelayHostId(relayId) || !isText(publicKey, 64) || !isText(name, MAX_PROFILE_NAME)) {
      return null
    }
    if (!isText(platform, 32)) return null
    kept.push({ relayId, publicKey, name, platform: platform as Platform })
  }
  return { state, hosts: kept }
}

const ENDS: readonly string[] = ['added', 'rejected', 'cancelled', 'expired', 'stopped']

/** A discovery request's event, checked where it crosses a process; null if not one. */
export function parseDiscoveryEvent(value: unknown): DiscoveryRequestEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const { requestId, request } = value as Record<string, unknown>
  if (!Number.isSafeInteger(requestId) || (requestId as number) < 1) return null
  if (typeof request !== 'object' || request === null) return null
  const fields = request as Record<string, unknown>
  if (fields.state === 'closed') {
    return ENDS.includes(fields.reason as string)
      ? {
          requestId: requestId as number,
          request: { state: 'closed', reason: fields.reason as DiscoveryEnd },
        }
      : null
  }
  if (fields.state !== 'confirm') return null
  const { device, code, startedAt, expiresAt } = fields
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(expiresAt)) return null
  if (typeof device !== 'object' || device === null) return null
  const { name, model, kind, platform, known } = device as Record<string, unknown>
  if (!isDeviceName(name) || !isDeviceModel(model)) return null
  if (!isText(kind, 64) || !isText(platform, 64) || typeof known !== 'boolean') return null
  return {
    requestId: requestId as number,
    request: {
      state: 'confirm',
      device: { name, model, kind, platform, known },
      code,
      startedAt: startedAt as number,
      expiresAt: expiresAt as number,
    },
  }
}
