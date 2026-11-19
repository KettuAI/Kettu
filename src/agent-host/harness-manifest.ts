// Kettu's harness compatibility manifest, which its download service signs: per harness, rules by
// Kettu version that name the version to recommend, the versions that work and those that do
// not. It holds only versions, ranges and hashes; what a harness is and where it comes from stay
// in the catalog. Ranges are npm's, matched as node-semver does with pre-releases included, the
// same way the service builds them.

import satisfies from 'semver/functions/satisfies'
import valid from 'semver/functions/valid'
import validRange from 'semver/ranges/valid'
import { verifySignature } from '../main/update-sources'
import KEYS from '../main/update-keys.json'
import { readLimited } from './registry'

export const MANIFEST_URL = 'https://download.kettu.sh/harnesses.json'

/** A signature under either key is accepted, so the key can be replaced without stranding anyone. */
export const MANIFEST_KEYS: readonly string[] = [KEYS.harnesses.current, KEYS.harnesses.next]

/** The manifest as the service signs it, and as Kettu bundles and keeps it. */
export interface SignedManifest {
  payload: string // base64url of the document's JSON
  signature: string // base64url of the Ed25519 signature over the payload's bytes
}

/** One rule of a harness, for the Kettu versions in `kettu`. */
export interface HarnessRule {
  kettu: string
  /** The versions that work, as a range; any when not given. */
  supported?: string
  recommended?: string
  /** Versions and ranges that do not work. */
  broken: string[]
  /** The versions whose preferred interface does not work, which run on the harness's other one. */
  fallback?: string
  /** An archive's SHA-256 by `<platform>-<arch>`, as the ACP Registry keys its archives. */
  sha256: Record<string, string>
}

export interface HarnessManifest {
  sequence: number
  updatedAt: string
  /** Per harness id, its rules in the order they are tried. */
  harnesses: ReadonlyMap<string, readonly HarnessRule[]>
}

export type ManifestResult =
  { ok: true; manifest: HarnessManifest; signed: SignedManifest } | { ok: false; reason: string }

const OPTIONS = { includePrerelease: true }
// A manifest takes a few kilobytes; one far larger is not it.
const MAX_PAYLOAD = 128 * 1024
const MAX_BODY = 2 * MAX_PAYLOAD
const BASE64URL = /^[A-Za-z0-9_-]+$/
const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const ARCHIVE_KEY = /^[a-z0-9]{1,16}-[a-z0-9_]{1,16}$/
const SHA256 = /^[0-9a-f]{64}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isVersion = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && valid(value) === value

const isRange = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && validRange(value, OPTIONS) !== null

/**
 * A rule as the manifest writes it, or null when any of its fields is not what it should be.
 * Fields it does not know are left out, so a later manifest's additions do not drop the rule.
 */
function readRule(value: unknown): HarnessRule | null {
  if (!isRecord(value) || !isRange(value.kettu)) return null
  const { supported, recommended, broken, sha256, fallback } = value
  if (supported !== undefined && !isRange(supported)) return null
  if (fallback !== undefined && !isRange(fallback)) return null
  if (recommended !== undefined && !isVersion(recommended)) return null
  if (broken !== undefined) {
    if (!Array.isArray(broken)) return null
    if (!broken.every((entry) => isVersion(entry) || isRange(entry))) return null
  }
  const hashes: Record<string, string> = {}
  if (sha256 !== undefined) {
    if (!isRecord(sha256)) return null
    for (const [key, hash] of Object.entries(sha256)) {
      if (!ARCHIVE_KEY.test(key) || typeof hash !== 'string' || !SHA256.test(hash)) return null
      hashes[key] = hash.toLowerCase()
    }
  }
  return {
    kettu: value.kettu,
    ...(supported !== undefined ? { supported } : {}),
    ...(recommended !== undefined ? { recommended } : {}),
    broken: (broken as string[] | undefined) ?? [],
    ...(fallback !== undefined ? { fallback } : {}),
    sha256: hashes,
  }
}

/** The document's harnesses; one whose rules do not all read is left out whole. */
function readDocument(document: unknown): HarnessManifest | string {
  if (!isRecord(document)) return 'it is not an object'
  const { sequence, updatedAt, harnesses } = document
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    return 'its sequence is not a positive integer'
  }
  if (typeof updatedAt !== 'string') return 'it has no updatedAt'
  if (!isRecord(harnesses)) return 'it has no harnesses'
  const read = new Map<string, HarnessRule[]>()
  for (const [id, rules] of Object.entries(harnesses)) {
    if (!HARNESS_ID.test(id) || !Array.isArray(rules)) continue
    const parsed = rules.map(readRule)
    if (parsed.every((rule) => rule !== null)) read.set(id, parsed)
  }
  return { sequence: sequence as number, updatedAt, harnesses: read }
}

/**
 * The manifest in a signed envelope, as the service sends it and Kettu keeps it, when its
 * signature holds under one of `keys` and its sequence is not below `minSequence`.
 */
export function verifyManifest(
  envelope: unknown,
  minSequence: number,
  keys: readonly string[] = MANIFEST_KEYS,
): ManifestResult {
  if (!isRecord(envelope)) return { ok: false, reason: 'it is not a signed manifest' }
  const { payload, signature } = envelope
  if (
    typeof payload !== 'string' ||
    typeof signature !== 'string' ||
    payload.length > MAX_PAYLOAD ||
    !BASE64URL.test(payload) ||
    !BASE64URL.test(signature)
  ) {
    return { ok: false, reason: 'it is not a signed manifest' }
  }
  const bytes = Buffer.from(payload, 'base64url')
  if (!verifySignature(bytes, Buffer.from(signature, 'base64url'), keys)) {
    return { ok: false, reason: 'its signature does not hold' }
  }
  let document: unknown
  try {
    document = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { ok: false, reason: 'its document is not JSON' }
  }
  const manifest = readDocument(document)
  if (typeof manifest === 'string') return { ok: false, reason: manifest }
  if (manifest.sequence < minSequence) {
    return {
      ok: false,
      reason: `its sequence ${manifest.sequence} is older than ${minSequence}`,
    }
  }
  return { ok: true, manifest, signed: { payload, signature } }
}

/** The body of `harnesses.json`, checked as `verifyManifest` checks the envelope it holds. */
export function parseManifest(
  body: string,
  minSequence: number,
  keys: readonly string[] = MANIFEST_KEYS,
): ManifestResult {
  if (body.length > MAX_BODY) return { ok: false, reason: 'it is too long' }
  let envelope: unknown
  try {
    envelope = JSON.parse(body)
  } catch {
    return { ok: false, reason: 'it is not JSON' }
  }
  return verifyManifest(envelope, minSequence, keys)
}

/** The rule of the harness that applies to this version of Kettu: the first whose range holds it. */
export function ruleFor(
  manifest: HarnessManifest | null,
  harnessId: string,
  kettuVersion: string,
): HarnessRule | null {
  const rules = manifest?.harnesses.get(harnessId)
  return rules?.find((rule) => satisfies(kettuVersion, rule.kettu, OPTIONS)) ?? null
}

/** Whether the rule marks the version as one that does not work. */
export function isBroken(rule: HarnessRule | null, version: string): boolean {
  return !!rule && rule.broken.some((entry) => satisfies(version, entry, OPTIONS))
}

/** Whether the version is one the rule says works: not broken, and in its range when it has one. */
export function usable(rule: HarnessRule | null, version: string): boolean {
  if (!rule) return true
  if (isBroken(rule, version)) return false
  return rule.supported === undefined || satisfies(version, rule.supported, OPTIONS)
}

/** Whether the rule holds the version back from the harness's preferred interface. */
export function heldBack(rule: HarnessRule | null, version: string): boolean {
  return rule?.fallback !== undefined && satisfies(version, rule.fallback, OPTIONS)
}

/** Whether the version satisfies an npm range, pre-releases included. */
export function inNpmRange(version: string, range: string): boolean {
  return satisfies(version, range, OPTIONS)
}

export interface ManifestFetchOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** What the request says it is, which tells the service the app from the daemon. */
  userAgent?: string
  /** The manifest's address; the service's own by default. */
  url?: string
}

/** Reads the manifest's body; rejects with a reason in English, for the diagnostics. */
export async function fetchManifest(options: ManifestFetchOptions): Promise<string> {
  const url = options.url ?? MANIFEST_URL
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(url, {
      signal,
      redirect: 'error',
      ...(options.userAgent ? { headers: { 'User-Agent': options.userAgent } } : {}),
    })
  } catch (error) {
    if (timeout.aborted) {
      throw new Error(`${url} did not answer within ${options.timeoutMs} ms`, { cause: error })
    }
    throw new Error(`${url} could not be reached: ${(error as Error).message}`, { cause: error })
  }
  if (!response.ok) {
    void response.body?.cancel()
    throw new Error(`${url} answered ${response.status}`)
  }
  const text = await readLimited(response, MAX_BODY)
  if (text === null) throw new Error(`${url} sent more than a manifest`)
  return text
}
