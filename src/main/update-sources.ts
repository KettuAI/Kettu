// Where updates come from and what makes any of those places safe to use: a list of sources that
// Kettu's download service signs, with GitHub always last, and a release key's signature on every
// update file, which the app checks whichever source served it.

import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { RELEASES_URL } from '@shared/updates'
import KEYS from './update-keys.json'

/** Kettu's download service, laid out as GitHub's releases. */
export const DOWNLOADS_URL = 'https://download.kettu.sh'
export const SOURCES_URL = `${DOWNLOADS_URL}/sources.json`

/** A base URL laid out as GitHub's releases: `latest/download/<file>`, `download/v<version>/<file>`. */
export interface UpdateSource {
  id: string
  url: string
}

export interface SourceList {
  serial: number
  sources: UpdateSource[] // in the order to try them, GitHub last
  connectTimeoutSeconds: number
  stallSeconds: number // a download without progress for this long moves on to the next source
}

/** The list as the service signs it and app-state.json keeps it. */
export interface SignedSourceList {
  payload: string // base64url of the list's JSON
  signature: string // base64url of the Ed25519 signature over the payload's bytes
}

/** Automatic tries the list's sources in order; GitHub only never reaches the download service. */
export type SourceChoice = 'auto' | 'github'

export const GITHUB_SOURCE: UpdateSource = { id: 'github', url: RELEASES_URL }

export const BUILT_IN_SOURCES: SourceList = {
  serial: 0,
  sources: [{ id: 'kettu', url: DOWNLOADS_URL }, GITHUB_SOURCE],
  connectTimeoutSeconds: 10,
  stallSeconds: 15,
}

/** A signature under either key is accepted, so a key can be replaced without stranding anyone. */
export const RELEASE_KEYS: readonly string[] = [KEYS.release.current, KEYS.release.next]
export const SOURCES_KEYS: readonly string[] = [KEYS.sources.current, KEYS.sources.next]

const MAX_SOURCES = 8
const MAX_LIST_LENGTH = 64 * 1024
const MAX_URL_LENGTH = 2048
const SOURCE_ID = /^[a-z0-9-]{1,32}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
// 64 bytes in standard base64, then the one newline readers ignore.
const SIGNATURE_FILE = /^([A-Za-z0-9+/]{86}==)\n?$/

const publicKeys = new Map<string, KeyObject>()

function publicKey(raw: string): KeyObject {
  let key = publicKeys.get(raw)
  if (!key) {
    const x = Buffer.from(raw, 'base64').toString('base64url')
    key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
    publicKeys.set(raw, key)
  }
  return key
}

/** Whether `signature` is an Ed25519 signature of `message` under one of `keys` (raw, base64). */
export function verifySignature(
  message: Uint8Array,
  signature: Uint8Array,
  keys: readonly string[],
): boolean {
  if (signature.length !== 64) return false
  return keys.some((raw) => {
    try {
      return verify(null, message, publicKey(raw), signature)
    } catch {
      return false
    }
  })
}

/** Whether `signatureFile`, a `<name>.sig` as the release uploads it, signs the update file `file`. */
export function verifyUpdateFile(
  file: Uint8Array,
  signatureFile: Uint8Array,
  keys: readonly string[] = RELEASE_KEYS,
): boolean {
  const match = SIGNATURE_FILE.exec(Buffer.from(signatureFile).toString('latin1'))
  return !!match && verifySignature(file, Buffer.from(match[1], 'base64'), keys)
}

function sameUrl(a: string, b: string): boolean {
  const left = URL.parse(a)
  const right = URL.parse(b)
  return !!left && !!right && left.origin + left.pathname === right.origin + right.pathname
}

/** The sources in order with GitHub's moved, or added, to the end, so no list can drop it. */
export function withGitHubLast(sources: readonly UpdateSource[]): UpdateSource[] {
  return [...sources.filter((source) => !sameUrl(source.url, GITHUB_SOURCE.url)), GITHUB_SOURCE]
}

function sourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null
  // Anything the parser would quietly change or drop makes the URL other than it reads.
  if (/[\s\\?#]|\p{Cc}/u.test(value) || value.endsWith('/')) return null
  const url = URL.parse(value)
  if (!url || url.protocol !== 'https:' || !url.hostname) return null
  if (url.username || url.password || url.search || url.hash) return null
  return value
}

const isTimeout = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 120

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readList(document: unknown): SourceList | string {
  if (!isRecord(document)) return 'the list is not an object'
  const { serial, sources, connectTimeoutSeconds, stallSeconds } = document
  if (!Number.isSafeInteger(serial) || (serial as number) < 1) {
    return 'its serial is not a positive integer'
  }
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > MAX_SOURCES) {
    return `it lists no sources or more than ${MAX_SOURCES}`
  }
  const read: UpdateSource[] = []
  for (const source of sources) {
    if (!isRecord(source) || typeof source.id !== 'string' || !SOURCE_ID.test(source.id)) {
      return 'a source has no valid id'
    }
    const url = sourceUrl(source.url)
    if (!url) return `source ${source.id} has no https URL without a query, fragment or credentials`
    read.push({ id: source.id, url })
  }
  if (!isTimeout(connectTimeoutSeconds) || !isTimeout(stallSeconds)) {
    return 'its timeouts are not whole seconds from 1 to 120'
  }
  return {
    serial: serial as number,
    sources: withGitHubLast(read),
    connectTimeoutSeconds,
    stallSeconds,
  }
}

export type SourceListResult =
  { ok: true; list: SourceList; signed: SignedSourceList } | { ok: false; reason: string }

/**
 * The list in a signed envelope, as the service sends it and the app keeps it, when its signature
 * holds under one of `keys`, its serial is not below `minSerial` and it keeps every rule.
 */
export function verifySourceList(
  envelope: unknown,
  minSerial: number,
  keys: readonly string[] = SOURCES_KEYS,
): SourceListResult {
  if (!isRecord(envelope)) return { ok: false, reason: 'it is not a signed list' }
  const { payload, signature } = envelope
  if (
    typeof payload !== 'string' ||
    typeof signature !== 'string' ||
    payload.length > MAX_LIST_LENGTH ||
    !BASE64URL.test(payload) ||
    !BASE64URL.test(signature)
  ) {
    return { ok: false, reason: 'it is not a signed list' }
  }
  const bytes = Buffer.from(payload, 'base64url')
  if (!verifySignature(bytes, Buffer.from(signature, 'base64url'), keys)) {
    return { ok: false, reason: 'its signature does not hold' }
  }
  let document: unknown
  try {
    document = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { ok: false, reason: 'its list is not JSON' }
  }
  const list = readList(document)
  if (typeof list === 'string') return { ok: false, reason: list }
  if (list.serial < minSerial) {
    return { ok: false, reason: `its serial ${list.serial} is older than ${minSerial}` }
  }
  return { ok: true, list, signed: { payload, signature } }
}

/** The body of `sources.json`, checked as `verifySourceList` checks the envelope it holds. */
export function parseSourceList(
  body: string,
  minSerial: number,
  keys: readonly string[] = SOURCES_KEYS,
): SourceListResult {
  if (body.length > MAX_LIST_LENGTH * 2) return { ok: false, reason: 'it is too long' }
  let envelope: unknown
  try {
    envelope = JSON.parse(body)
  } catch {
    return { ok: false, reason: 'it is not JSON' }
  }
  return verifySourceList(envelope, minSerial, keys)
}

/** The sources of one check, in order, from the one that answered it to the last. */
export class SourceRun {
  private index: number

  constructor(
    readonly sources: readonly UpdateSource[],
    private readonly start: number,
    readonly stallMs: number,
  ) {
    this.index = start
  }

  static githubOnly(stallMs: number): SourceRun {
    return new SourceRun([GITHUB_SOURCE], 0, stallMs)
  }

  get current(): UpdateSource {
    return this.sources[this.index]!
  }

  get githubOnly(): boolean {
    return this.sources.length === 1 && this.current === GITHUB_SOURCE
  }

  /** Moves on to the next source; null when this was the last. */
  next(): UpdateSource | null {
    if (this.index + 1 >= this.sources.length) return null
    this.index++
    return this.current
  }

  /** The same sources from the one that answered the check, for another download. */
  again(): SourceRun {
    return new SourceRun(this.sources, this.start, this.stallMs)
  }
}

export function latestFileUrl(source: UpdateSource, name: string): string {
  return `${source.url}/latest/download/${encodeURIComponent(name)}`
}

export function releaseFileUrl(source: UpdateSource, version: string, name: string): string {
  return `${source.url}/download/v${encodeURIComponent(version)}/${encodeURIComponent(name)}`
}

/** What the updater's requests say they are, which tells the service an update from a download. */
export function updaterUserAgent(version: string, platform: string, arch: string): string {
  return `Kettu/${version} (${platform}; ${arch})`
}

/** A check that no source could answer; `githubUnreachable` when GitHub, the only one, did not. */
export class SourcesFailed extends Error {
  constructor(
    message: string,
    readonly githubUnreachable: boolean,
  ) {
    super(message)
    this.name = 'SourcesFailed'
  }
}
