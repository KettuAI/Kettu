// Pairing with a host of the same Kettu account without a code: the relay lists the account's
// hosts, the device runs Noise IK with the discovery prologue to the listed key, and both sides
// show a six-digit code built from a commit-then-reveal exchange. The device's user confirms the
// code matches, which catches a relay that listed a key of its own; the host's owner adds the
// device, which shows they control the host and want it. Imports nothing of Node.js.

import type { Platform } from '../platform'
import { isDeviceField, isDeviceModel, isDeviceName } from './device'
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
  parseHostRelay,
  type HostRelay,
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

/**
 * The device's first message on the channel: the SHA-256 of its nonce, in base64url, and the
 * batch of computers it connects to at once, when it connects to several.
 */
export interface PairCommit {
  type: 'pair-commit'
  commit: string
  group?: PairGroup
}

/**
 * Several computers connected to with one code: `id` is 16 random bytes in base64url, `hosts` the
 * relay ids of every computer in the batch, sorted, each host's own among them.
 */
export interface PairGroup {
  id: string
  hosts: string[]
}

export const MIN_GROUP_HOSTS = 2
export const MAX_GROUP_HOSTS = 16
const GROUP_ID_BYTES = 16

/** What both sides of one exchange hold that the code is made of, each in base64url. */
export interface PairTranscript {
  hash: string
  hostNonce: string
  deviceNonce: string
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
  /**
   * The desktop app or the daemon, as the account's client of the same name says; absent when
   * none does. Only a desktop app can be let use the computer that connects to it.
   */
  kind?: 'desktop' | 'daemon'
}

/**
 * One of the account's computers that the relay does not offer to connect to, and why: `added`,
 * already a known host here; `remote_off`, signed in and used in the last 5 minutes but not
 * listed, so remote access is off there or it is hidden from the account's devices; `offline`,
 * used longer ago. The ones to connect to are `hosts`.
 */
export interface AccountComputer {
  name: string
  /** Its system as a host names it, or empty when only its system's name is known. */
  platform: Platform | ''
  state: 'added' | 'remote_off' | 'offline'
  /** `offline`: when the account service last saw it, in Unix milliseconds. */
  lastSeenAt?: number
}

/**
 * A client of the account that may use this computer once remote access is on, which the
 * desktop app asks about once while it is off.
 */
export interface RemoteOffer {
  /** The client's sign-in at the account service. */
  clientId: string
  name: string
  kind: 'ios' | 'web' | 'desktop' | 'daemon'
}

/** How recently a computer the relay does not list used the account to count as on. */
export const RECENTLY_USED_MS = 5 * 60_000

/** The account's computers listed at most, beside those to connect to. */
export const MAX_ACCOUNT_COMPUTERS = 200

/** What listing the account's hosts gives. */
export type DiscoveredHosts =
  /** `computers`: the account's other computers, absent where the account service was not read. */
  | { state: 'ok'; hosts: DiscoveredHost[]; computers?: AccountComputer[] }
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
      /** The device's user confirmed the code; Add waits for it. */
      deviceConfirmed: boolean
      /** For the code of a batch, which an approver holding every request of it works out. */
      transcript: PairTranscript
      group?: PairGroup
    }
  /** `answeredOn`: the paired device whose answer counted, absent when the host's own did. */
  | { state: 'closed'; reason: DiscoveryEnd; answeredOn?: string }

/** A discovery request's progress, to every window of the host. */
export interface DiscoveryRequestEvent {
  requestId: number
  request: DiscoveryRequestState
}

const CODE_CONTEXT = new TextEncoder().encode('kettu-pair-code/1')
const GROUP_CODE_CONTEXT = new TextEncoder().encode('kettu-pair-code-group/1')

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
  return sixDigits([CODE_CONTEXT, handshakeHash, hostNonce, deviceNonce])
}

/** One computer's part of a batch's code: its relay id and its exchange's transcript. */
export interface GroupCodePart {
  relayId: string
  hash: Uint8Array
  hostNonce: Uint8Array
  deviceNonce: Uint8Array
}

/**
 * The code of a batch: as one computer's, over its own context and, in the batch's order, each
 * computer's relay id in ASCII, handshake hash and both nonces.
 */
export async function groupPairCode(parts: readonly GroupCodePart[]): Promise<string> {
  return sixDigits([
    GROUP_CODE_CONTEXT,
    ...parts.flatMap((part) => [
      new TextEncoder().encode(part.relayId),
      part.hash,
      part.hostNonce,
      part.deviceNonce,
    ]),
  ])
}

/** A batch's code from the transcripts the hosts reported, in `hosts` order; null if one is bad. */
export async function groupCodeOf(
  hosts: readonly string[],
  transcripts: ReadonlyMap<string, PairTranscript>,
): Promise<string | null> {
  const parts: GroupCodePart[] = []
  for (const relayId of hosts) {
    const transcript = transcripts.get(relayId)
    const hash = transcript && decodeRelayBytes(transcript.hash)
    const hostNonce = transcript && decodeRelayBytes(transcript.hostNonce)
    const deviceNonce = transcript && decodeRelayBytes(transcript.deviceNonce)
    if (!hash || !hostNonce || !deviceNonce) return null
    parts.push({ relayId, hash, hostNonce, deviceNonce })
  }
  return groupPairCode(parts)
}

/** SHA-256 over the parts; its first four bytes as a big-endian number, modulo a million. */
async function sixDigits(parts: readonly Uint8Array[]): Promise<string> {
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

/** A new batch of the computers with these relay ids. */
export function newPairGroup(relayIds: readonly string[]): PairGroup {
  const id = encodeRelayBytes(crypto.getRandomValues(new Uint8Array(GROUP_ID_BYTES)))
  return { id, hosts: [...new Set(relayIds)].sort() }
}

/** A batch as a device sends it, or null: an id of 16 bytes and 2 to 16 sorted relay ids. */
export function parsePairGroup(value: unknown): PairGroup | null {
  if (!only(value, ['id', 'hosts'])) return null
  const { id, hosts } = value
  if (typeof id !== 'string' || decodeRelayBytes(id)?.length !== GROUP_ID_BYTES) return null
  if (!Array.isArray(hosts) || hosts.length < MIN_GROUP_HOSTS) return null
  if (hosts.length > MAX_GROUP_HOSTS || !hosts.every(isRelayHostId)) return null
  for (let i = 1; i < hosts.length; i++) {
    if ((hosts[i - 1] as string) >= (hosts[i] as string)) return null
  }
  return { id, hosts: [...(hosts as string[])] }
}

/** A transcript as a host sends it, or null when one of its parts is not 32 bytes. */
export function parseTranscript(value: unknown): PairTranscript | null {
  if (!only(value, ['hash', 'hostNonce', 'deviceNonce'])) return null
  const { hash, hostNonce, deviceNonce } = value
  return isNonce(hash) && isNonce(hostNonce) && isNonce(deviceNonce)
    ? { hash, hostNonce, deviceNonce }
    : null
}

/** Whether the object has exactly these keys. */
function only(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const own = Object.keys(value)
  return own.length === keys.length && own.every((key) => keys.includes(key))
}

export function parsePairCommit(value: unknown): PairCommit | null {
  const keys = typeof value === 'object' && value !== null && 'group' in value ? ['group'] : []
  if (!only(value, ['type', 'commit', ...keys]) || value.type !== 'pair-commit') return null
  if (!isNonce(value.commit)) return null
  if (keys.length === 0) return { type: 'pair-commit', commit: value.commit }
  const group = parsePairGroup(value.group)
  return group ? { type: 'pair-commit', commit: value.commit, group } : null
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
  | { code: string; transcript: PairTranscript; channel: DeviceChannel }
  /** The host's closing reason, or null when it said none or broke the exchange. */
  | { closing: ClosingReason | null }

/**
 * Commits to a nonce, reads the host's, reveals its own and works out the code. Anything out of
 * order ends the connection. The commit goes before the host's nonce is seen, so whoever sits in
 * the middle cannot try nonces until the codes match.
 */
export async function deviceDiscovery(
  channel: DeviceChannel,
  group?: PairGroup,
): Promise<DeviceDiscovery> {
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
        const hostNonce = decodeRelayBytes(answer.nonce)!
        const code = await pairCode(channel.handshakeHash, hostNonce, nonce)
        const transcript: PairTranscript = {
          hash: encodeRelayBytes(channel.handshakeHash),
          hostNonce: answer.nonce,
          deviceNonce: encodeRelayBytes(nonce),
        }
        const onMessage = (listener: (value: unknown) => void): void => {
          next = listener
          for (const value of later.splice(0)) listener(value)
        }
        resolve({ code, transcript, channel: { ...channel, onMessage } })
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
    const first: PairCommit = { type: 'pair-commit', commit, ...(group ? { group } : {}) }
    channel.send(first).catch(fail)
  })
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

/** A system's name, as the account service has it from a client, as a host's platform. */
export function platformOfSystem(system: string): Platform | '' {
  if (/mac|darwin/i.test(system)) return 'darwin'
  if (/windows/i.test(system)) return 'win32'
  if (/linux|ubuntu|debian|fedora|arch/i.test(system)) return 'linux'
  return ''
}

/**
 * Every computer of the account beside this one, from what the relay lists and the account
 * service's signed-in clients: one row each, matched by name, the relay's offer to connect first,
 * then the known hosts, then the rest by how recently they used the account.
 */
export function accountComputers(input: {
  listed: DiscoveredHost[]
  known: { id: string; name: string; platform: Platform; account?: string | null }[]
  clients: { kind: string; name: string; os: string; lastUsedAt: number; current: boolean }[]
  account: string
  now: number
}): AccountComputer[] {
  const computers: AccountComputer[] = []
  const named = new Set(input.listed.map((host) => host.name))
  const clients = input.clients.filter(
    (client) => !client.current && (client.kind === 'desktop' || client.kind === 'daemon'),
  )
  const signedIn = new Set(clients.map((client) => client.name))
  for (const host of input.known) {
    // Another account's host is folded away, not listed here.
    if (host.account !== undefined && host.account !== null && host.account !== input.account) {
      continue
    }
    if (host.account !== input.account && !signedIn.has(host.name)) continue
    if (named.has(host.name)) continue
    named.add(host.name)
    computers.push({ name: host.name, platform: host.platform, state: 'added' })
  }
  for (const client of clients) {
    if (named.has(client.name)) continue
    named.add(client.name)
    const platform = platformOfSystem(client.os)
    computers.push(
      input.now - client.lastUsedAt <= RECENTLY_USED_MS
        ? { name: client.name, platform, state: 'remote_off' }
        : { name: client.name, platform, state: 'offline', lastSeenAt: client.lastUsedAt },
    )
  }
  return computers.slice(0, MAX_ACCOUNT_COMPUTERS)
}

const COMPUTER_STATES: readonly string[] = ['added', 'remote_off', 'offline']

function parseComputer(value: unknown): AccountComputer | null {
  if (typeof value !== 'object' || value === null) return null
  const { name, platform, state, lastSeenAt } = value as Record<string, unknown>
  if (!isText(name, 100) || !COMPUTER_STATES.includes(state as string)) return null
  if (platform !== '' && !isText(platform, 32)) return null
  if (lastSeenAt !== undefined && !Number.isSafeInteger(lastSeenAt)) return null
  return {
    name,
    platform: platform as Platform | '',
    state: state as AccountComputer['state'],
    ...(typeof lastSeenAt === 'number' ? { lastSeenAt } : {}),
  }
}

/** What `hosts:discover` answered, checked where it crosses a process; null if not one. */
export function parseDiscoveredHosts(value: unknown): DiscoveredHosts | null {
  if (typeof value !== 'object' || value === null) return null
  const { state, hosts, computers } = value as Record<string, unknown>
  if (state === 'signed_out' || state === 'unavailable') return { state }
  if (state !== 'ok' || !Array.isArray(hosts) || hosts.length > MAX_LISTED_HOSTS) return null
  const kept: DiscoveredHost[] = []
  for (const entry of hosts) {
    if (typeof entry !== 'object' || entry === null) return null
    const { relayId, publicKey, name, platform, kind } = entry as Record<string, unknown>
    if (!isRelayHostId(relayId) || !isText(publicKey, 64) || !isText(name, MAX_PROFILE_NAME)) {
      return null
    }
    if (!isText(platform, 32)) return null
    kept.push({
      relayId,
      publicKey,
      name,
      platform: platform as Platform,
      ...(kind === 'desktop' || kind === 'daemon' ? { kind } : {}),
    })
  }
  if (computers === undefined) return { state, hosts: kept }
  if (!Array.isArray(computers) || computers.length > MAX_ACCOUNT_COMPUTERS) return null
  const others = computers.map(parseComputer)
  if (others.some((computer) => computer === null)) return null
  return { state, hosts: kept, computers: others as AccountComputer[] }
}

const ENDS: readonly string[] = ['added', 'rejected', 'cancelled', 'expired', 'stopped']

const MAX_ANSWERED_ON = 100

/** A discovery request's event, checked where it crosses a process; null if not one. */
export function parseDiscoveryEvent(value: unknown): DiscoveryRequestEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const { requestId, request } = value as Record<string, unknown>
  if (!Number.isSafeInteger(requestId) || (requestId as number) < 1) return null
  if (typeof request !== 'object' || request === null) return null
  const fields = request as Record<string, unknown>
  if (fields.state === 'closed') {
    const { reason, answeredOn } = fields
    if (!ENDS.includes(reason as string)) return null
    if (answeredOn !== undefined && !isText(answeredOn, MAX_ANSWERED_ON)) return null
    return {
      requestId: requestId as number,
      request: {
        state: 'closed',
        reason: reason as DiscoveryEnd,
        ...(answeredOn === undefined ? {} : { answeredOn }),
      },
    }
  }
  if (fields.state !== 'confirm') return null
  const { device, code, startedAt, expiresAt, deviceConfirmed } = fields
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null
  if (typeof deviceConfirmed !== 'boolean') return null
  const transcript = parseTranscript(fields.transcript)
  if (!transcript) return null
  const group = fields.group === undefined ? undefined : parsePairGroup(fields.group)
  if (group === null) return null
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
      deviceConfirmed,
      transcript,
      ...(group ? { group } : {}),
    },
  }
}

/**
 * The welcome's feature of a host that takes `remote.addReverseHost`: a desktop app, whose own
 * client can be given another computer as a host. A daemon has no client and leaves it out.
 */
export const REVERSE_HOST_FEATURE = 'reverse-host'

/**
 * `remote.addReverseHost`'s params: the connecting computer's own host, which the host it was
 * just added to keeps as a host of its own client.
 */
export interface ReverseHost {
  relayId: string
  /** Its X25519 public key, in base64, as a known host keeps it. */
  publicKey: string
  name: string
  platform: Platform
  /** The relays it signs in to, each an origin. */
  relays: string[]
  /**
   * The certificate pin of the first relay, base64url, for the owner's own relay at an IP address,
   * as a pairing code carries it.
   */
  pin?: string
  /** Kettu's version on it. */
  version: string
}

/** What a desktop host answers: its own client's device key, in base64, with its name and system. */
export interface ReverseGrant {
  deviceKey: string
  name: string
  platform: string
}

const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/

/** `remote.addReverseHost`'s params as a device sends them, or null when they are not ones. */
export function parseReverseHost(value: unknown): ReverseHost | null {
  const pinned = typeof value === 'object' && value !== null && 'pin' in value ? ['pin'] : []
  const keys = ['relayId', 'publicKey', 'name', 'platform', 'relays', 'version', ...pinned]
  if (!only(value, keys)) return null
  const { relayId, publicKey, name, platform, relays, version, pin } = value
  if (!isRelayHostId(relayId) || typeof publicKey !== 'string' || !BASE64_KEY.test(publicKey)) {
    return null
  }
  if (!isText(name, MAX_PROFILE_NAME) || name.trim() !== name) return null
  if (!isText(platform, 32) || !/^[a-z0-9]+$/.test(platform) || !isText(version, 64)) return null
  if (!Array.isArray(relays) || relays.length === 0) return null
  const relay = parseHostRelay({ id: relayId, urls: relays, ...(pinned.length ? { pin } : {}) })
  if (!relay || relay.urls.length !== relays.length) return null
  // A pin that is not 32 bytes for an https relay is dropped there, which ends it here.
  if (pinned.length && relay.pin !== pin) return null
  return {
    relayId,
    publicKey,
    name,
    platform: platform as Platform,
    relays: relay.urls,
    ...(relay.pin ? { pin: relay.pin } : {}),
    version,
  }
}

/** The relay a reverse host is reached through, as a known host keeps it. */
export function reverseHostRelay(host: ReverseHost): HostRelay {
  return { id: host.relayId, urls: host.relays, ...(host.pin ? { pin: host.pin } : {}) }
}

/** A desktop host's answer, or null when it is not one. */
export function parseReverseGrant(value: unknown): ReverseGrant | null {
  if (!only(value, ['deviceKey', 'name', 'platform'])) return null
  const { deviceKey, name, platform } = value
  if (typeof deviceKey !== 'string' || !BASE64_KEY.test(deviceKey)) return null
  if (!isDeviceName(name) || !isDeviceField(platform)) return null
  return { deviceKey, name, platform }
}
