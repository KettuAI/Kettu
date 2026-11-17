// Writes the harness versions a release bundles, src/agent-host/harness-versions.json: the ACP
// Registry's listing cut to what Kettu reads of it, each agent's version and distribution, beside
// `kettu`, the versions Kettu keeps itself for the harnesses the Registry does not list as Kettu
// installs them, which this tool leaves as they are, and `manifest`, Kettu's signed harness
// compatibility manifest as the download service sends it, checked with the app's own keys. The
// Release workflow runs it before the build, so every release starts new installs on the day's
// versions; run it again when a harness is added. A failed fetch keeps the committed part and
// warns in the run.

import { createPublicKey, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SOURCE = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
export const MANIFEST = 'https://download.kettu.sh/harnesses.json'
export const TARGET = resolve(import.meta.dirname, '../../src/agent-host/harness-versions.json')
const KEYS = resolve(import.meta.dirname, '../../src/main/update-keys.json')

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The fields of a value that are present, in this order. */
function pick(value, keys) {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((k) => [k, value[k]]),
  )
}

/**
 * One agent as Kettu reads it: its id, version and the packages or archives it ships as. The
 * Registry's own arguments and variables are left out, since each harness's launch has its own.
 *
 * @param {Record<string, any>} agent
 */
export function cutAgent(agent) {
  const source = isObject(agent.distribution) ? agent.distribution : {}
  const distribution = {}
  if (isObject(source.npx) && typeof source.npx.package === 'string') {
    distribution.npx = { package: source.npx.package }
  }
  if (isObject(source.uvx) && typeof source.uvx.package === 'string') {
    distribution.uvx = { package: source.uvx.package }
  }
  if (isObject(source.binary)) {
    distribution.binary = Object.fromEntries(
      Object.entries(source.binary)
        .filter(([, target]) => isObject(target))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, target]) => [key, pick(target, ['archive', 'cmd', 'args', 'sha256'])]),
    )
  }
  return { id: agent.id, version: agent.version, distribution }
}

/**
 * The bundled file from the Registry's listing, the versions Kettu keeps itself and the signed
 * manifest, when there is one.
 *
 * @param {{ agents: unknown[] }} listing
 * @param {Record<string, unknown>} kettu
 * @param {{ payload: string, signature: string } | null} [manifest]
 */
export function bundle(listing, kettu, manifest = null) {
  const agents = listing.agents
    .filter((agent) => isObject(agent) && typeof agent.id === 'string')
    .map(cutAgent)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { registry: { agents }, kettu, ...(manifest ? { manifest } : {}) }
}

/**
 * The sequence of a signed manifest whose Ed25519 signature holds under one of `keys` (raw, in
 * standard base64), or why it is not one, as the app checks it.
 *
 * @param {unknown} envelope
 * @param {readonly string[]} keys
 * @returns {{ sequence: number } | { reason: string }}
 */
export function manifestSequence(envelope, keys) {
  const base64url = /^[A-Za-z0-9_-]+$/
  if (
    !isObject(envelope) ||
    typeof envelope.payload !== 'string' ||
    typeof envelope.signature !== 'string' ||
    !base64url.test(envelope.payload) ||
    !base64url.test(envelope.signature)
  ) {
    return { reason: 'it is not a signed manifest' }
  }
  const payload = Buffer.from(envelope.payload, 'base64url')
  const signature = Buffer.from(envelope.signature, 'base64url')
  const signed = keys.some((raw) => {
    const x = Buffer.from(raw, 'base64').toString('base64url')
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
    return signature.length === 64 && verify(null, payload, key, signature)
  })
  if (!signed) return { reason: 'its signature does not hold under the app keys' }
  let document
  try {
    document = JSON.parse(payload.toString('utf8'))
  } catch {
    return { reason: 'its document is not JSON' }
  }
  if (!isObject(document) || !Number.isSafeInteger(document.sequence) || document.sequence < 1) {
    return { reason: 'its sequence is not a positive integer' }
  }
  return { sequence: document.sequence }
}

/**
 * The manifest to bundle: the service's, once its signature holds and its sequence is not older
 * than the committed one's, else the committed one.
 *
 * @param {unknown} current the committed manifest, if any
 */
async function readManifest(current) {
  const keys = JSON.parse(readFileSync(KEYS, 'utf8')).harnesses
  const accepted = [keys.current, keys.next]
  const committed = isObject(current) ? manifestSequence(current, accepted) : null
  const keep = committed && 'sequence' in committed ? current : null
  try {
    const response = await fetch(MANIFEST)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const envelope = await response.json()
    const read = manifestSequence(envelope, accepted)
    if ('reason' in read) throw new Error(read.reason)
    if (keep && read.sequence < committed.sequence) {
      throw new Error(`its sequence ${read.sequence} is older than ${committed.sequence}`)
    }
    console.log(`Bundling harness manifest ${read.sequence}`)
    return { payload: envelope.payload, signature: envelope.signature }
  } catch (error) {
    console.warn(
      `::warning::Could not take the harness manifest, keeping the committed one: ${error.message}`,
    )
    return keep
  }
}

/** Formats the file as the repository's Prettier settings do, so it passes the format check. */
async function format(text) {
  const prettier = await import('prettier')
  const options = (await prettier.resolveConfig(TARGET)) ?? {}
  return prettier.format(text, { ...options, filepath: TARGET })
}

async function main() {
  let current
  try {
    current = JSON.parse(readFileSync(TARGET, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read ${TARGET}: ${error.message}`, { cause: error })
  }
  let listing =
    isObject(current.registry) && Array.isArray(current.registry.agents)
      ? current.registry
      : { agents: [] }
  try {
    const response = await fetch(SOURCE)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const read = await response.json()
    if (!isObject(read) || !Array.isArray(read.agents)) throw new Error('no agents list')
    listing = read
  } catch (error) {
    console.warn(
      `::warning::Could not read the ACP Registry, keeping the committed Registry versions: ${error.message}`,
    )
  }
  const manifest = await readManifest(current.manifest)
  const next = bundle(listing, isObject(current.kettu) ? current.kettu : {}, manifest)
  writeFileSync(TARGET, await format(JSON.stringify(next, null, 2)))
  console.log(`Wrote the versions of ${next.registry.agents.length} Registry agents`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
