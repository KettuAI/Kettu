// The ACP Registry's listing, which the versions of the harnesses Kettu installs follow: the npm
// packages, uvx packages and release archives it lists. Only what the registry's schema allows is
// taken, and an update's archive only with the SHA-256 its download is checked against.

import type { Platform } from '@shared/platform'
import { archiveKey, type ArchiveEntry } from './binary-install'
import type { AgentDefinition } from './catalog'
import { t } from './i18n'

/** The listing, at the address the registry's documentation gives clients. */
export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

/** The listing is under 100 KB; one far larger is not it. */
const MAX_BYTES = 4 * 1024 * 1024

/**
 * The schema's stable version. It names the install's folder and reaches uvx's command line, so
 * nothing else passes.
 */
const STABLE_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/
const SHA256 = /^[0-9a-f]{64}$/i
/** The archive formats the schema names; any other download is the program itself. */
const ARCHIVE_FILE = /\.(?:zip|tar\.gz|tgz|tar\.bz2|tbz2)$/i
/** A uvx package as the registry writes it: the name, then `==` or `@` and the version. */
const UVX_PACKAGE = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:(?:==|@)(.+))?$/
/** An npm package as the registry writes it: the name, with its scope, then `@` and the version. */
const NPM_PACKAGE = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@(.+))?$/

/** The listing's agents by id, as the registry wrote them. */
export type RegistryAgents = ReadonlyMap<string, unknown>

/**
 * A harness's release in the registry, as Kettu installs it. An archive's SHA-256 is missing only
 * where a first install was asked for, which records the hash it measures instead.
 */
export type RegistryRelease =
  | { kind: 'archive'; version: string; entry: ArchiveEntry }
  | { kind: 'uvx'; version: string }
  | { kind: 'package'; version: string }

type RegistryDef = Pick<AgentDefinition, 'registryId' | 'launch' | 'installs'>

/**
 * Whether Kettu's own install of the harness comes from the registry, so its versions follow the
 * registry: an npm package, a uvx package or a release archive, unless it is the vendor's own.
 */
export function followsRegistry(def: RegistryDef): boolean {
  const { launch } = def
  if (launch.kind === 'uvx') return true
  if (launch.kind === 'package') return !launch.fromVendor
  const archive = def.installs?.archive
  return launch.kind === 'binary' && !!archive && !archive.fromVendor
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The listing's agents by id; null for anything that is not a listing. */
export function parseRegistry(data: unknown): RegistryAgents | null {
  if (!isObject(data) || !Array.isArray(data.agents)) return null
  const agents = new Map<string, unknown>()
  for (const agent of data.agents) {
    if (isObject(agent) && typeof agent.id === 'string') agents.set(agent.id, agent)
  }
  return agents
}

/** The PyPI name in its normal form, which tells `minion_code` and `minion-code` alike. */
function pypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return []
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

function fileName(url: string): string {
  return new URL(url).pathname.split('/').pop() ?? ''
}

/**
 * The release the registry lists for the harness on this platform, or why it offers none, in
 * English for the diagnostics. An archive without a SHA-256 passes only with `unhashed`.
 */
export function registryRelease(
  agents: RegistryAgents,
  def: RegistryDef,
  platform: Platform,
  arch: string,
  options: { unhashed?: boolean } = {},
): RegistryRelease | { reason: string } {
  const agent = agents.get(def.registryId)
  if (!isObject(agent)) return { reason: `the registry does not list ${def.registryId}` }
  const { version } = agent
  if (typeof version !== 'string' || !STABLE_VERSION.test(version)) {
    return { reason: `the registry lists ${def.registryId} at no plain version` }
  }
  const distribution = isObject(agent.distribution) ? agent.distribution : {}
  if (def.launch.kind === 'uvx') {
    const uvx = isObject(distribution.uvx) ? distribution.uvx : null
    const match = typeof uvx?.package === 'string' ? UVX_PACKAGE.exec(uvx.package) : null
    if (!match) return { reason: `the registry lists ${def.registryId} as no uvx package` }
    const [, name = '', pinned = version] = match
    if (pypiName(name) !== pypiName(def.launch.package)) {
      return { reason: `the registry lists ${def.registryId} as ${name}` }
    }
    if (!STABLE_VERSION.test(pinned)) {
      return { reason: `the registry lists ${name} at no plain version` }
    }
    return { kind: 'uvx', version: pinned }
  }
  if (def.launch.kind === 'package') {
    const npx = isObject(distribution.npx) ? distribution.npx : null
    const match = typeof npx?.package === 'string' ? NPM_PACKAGE.exec(npx.package) : null
    if (!match) return { reason: `the registry lists ${def.registryId} as no npm package` }
    const [, name = '', pinned = version] = match
    if (name !== def.launch.package) {
      return { reason: `the registry lists ${def.registryId} as ${name}` }
    }
    if (!STABLE_VERSION.test(pinned)) {
      return { reason: `the registry lists ${name} at no plain version` }
    }
    return { kind: 'package', version: pinned }
  }
  if (def.launch.kind !== 'binary') {
    return { reason: `${def.registryId} is not installed from the registry` }
  }
  const key = archiveKey(platform, arch)
  const binary = isObject(distribution.binary) ? distribution.binary : {}
  const target = binary[key]
  if (!isObject(target)) return { reason: `the registry lists no ${key} archive` }
  const { archive: url, cmd, sha256 } = target
  const args = stringList(target.args)
  if (typeof url !== 'string' || !isHttps(url)) {
    return { reason: `the ${key} archive is not downloaded over https` }
  }
  const hashed = typeof sha256 === 'string' && SHA256.test(sha256)
  if (!hashed && (sha256 !== undefined || !options.unhashed)) {
    return { reason: `the registry gives no SHA-256 for the ${key} archive` }
  }
  if (typeof cmd !== 'string' || cmd === '' || !args) {
    return { reason: `the registry names no program in the ${key} archive` }
  }
  return {
    kind: 'archive',
    version,
    entry: {
      url,
      ...(hashed ? { sha256: sha256.toLowerCase() } : {}),
      cmd,
      args,
      ...(ARCHIVE_FILE.test(fileName(url)) ? {} : { bare: true as const }),
    },
  }
}

/**
 * The listing cut to what Kettu reads of it, each agent's id, version and distribution, as Kettu
 * keeps it on disk for a start without the network.
 */
export function listingEntries(agents: RegistryAgents): unknown[] {
  const entries: unknown[] = []
  for (const [id, agent] of agents) {
    if (!isObject(agent)) continue
    const source = isObject(agent.distribution) ? agent.distribution : {}
    const distribution: Record<string, unknown> = {}
    for (const kind of ['npx', 'uvx'] as const) {
      const entry = source[kind]
      if (isObject(entry) && typeof entry.package === 'string') {
        distribution[kind] = { package: entry.package }
      }
    }
    if (isObject(source.binary)) {
      const binary: Record<string, unknown> = {}
      for (const [key, target] of Object.entries(source.binary)) {
        if (!isObject(target)) continue
        const { archive, cmd, args, sha256 } = target
        binary[key] = { archive, cmd, args, sha256 }
      }
      distribution.binary = binary
    }
    entries.push({ id, version: agent.version, distribution })
  }
  return entries
}

export interface RegistryFetchOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** The listing's address; the registry's own by default. */
  url?: string
}

/** The body, refused once it grows past `maxBytes`, what a listing can be by default. */
export async function readLimited(
  response: Response,
  maxBytes = MAX_BYTES,
): Promise<string | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** Reads the listing; rejects with a reason the user can read. */
export async function fetchRegistry(options: RegistryFetchOptions): Promise<RegistryAgents> {
  const url = options.url ?? REGISTRY_URL
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const failure = (): Error => {
    if (options.signal?.aborted) return new Error(t('agent.update.stopped'))
    if (timeout.aborted) {
      return new Error(
        t('agent.update.registryTimeout', { seconds: String(options.timeoutMs / 1000) }),
      )
    }
    return new Error(t('agent.update.registryOffline'))
  }
  let response: Response
  try {
    response = await fetch(url, { signal, redirect: 'follow' })
  } catch {
    throw failure()
  }
  if (!response.ok) {
    void response.body?.cancel()
    throw new Error(
      t('agent.binaryInstall.downloadFailed', { url, status: String(response.status) }),
    )
  }
  let text: string | null
  try {
    text = await readLimited(response)
  } catch {
    throw failure()
  }
  let agents: RegistryAgents | null
  try {
    agents = text === null ? null : parseRegistry(JSON.parse(text))
  } catch {
    agents = null
  }
  if (!agents) throw new Error(t('agent.update.registryUnreadable'))
  return agents
}
