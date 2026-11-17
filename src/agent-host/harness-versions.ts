// Which version of a harness Kettu installs: the ACP Registry's for a harness it lists, inside the
// range the catalog accepts, else the version bundled with the app, which the release run writes
// from the Registry beside the versions Kettu keeps itself. Which install a start runs follows
// from it: the version wanted, the one that ran before while that is not installed, and never one
// that failed to start in place of the one before it.

import type { Platform } from '@shared/platform'
import { archiveKey, type ArchiveEntry } from './binary-install'
import type { AgentDefinition } from './catalog'
import bundledFile from './harness-versions.json'
import {
  followsRegistry,
  parseRegistry,
  registryRelease,
  type RegistryAgents,
  type RegistryRelease,
} from './registry'
import { compareVersions, isVersion } from './versions'

/** A version Kettu keeps itself, for a harness the Registry does not list as Kettu installs it. */
export interface KettuRelease {
  version: string
  /** Each platform's file by `<platform>-<arch>`, for a harness installed from an archive. */
  archives?: Record<string, ArchiveEntry>
}

/** The versions bundled with the app. */
export interface BundledVersions {
  /** The Registry's listing as the release run read it. */
  registry: RegistryAgents
  /** By harness id. */
  kettu: ReadonlyMap<string, KettuRelease>
}

/** A release Kettu can install, and whether the Registry's listing or the bundled one gave it. */
export type TargetRelease = RegistryRelease & { source: 'registry' | 'bundled' }

type VersionDef = Pick<AgentDefinition, 'id' | 'registryId' | 'launch' | 'installs'>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SHA256 = /^[0-9a-f]{64}$/i

function archiveOf(value: unknown): ArchiveEntry | null {
  if (!isObject(value)) return null
  const { url, sha256, cmd, args, bare } = value
  if (typeof url !== 'string' || !url.startsWith('https://')) return null
  if (typeof cmd !== 'string' || cmd === '') return null
  if (sha256 !== undefined && (typeof sha256 !== 'string' || !SHA256.test(sha256))) return null
  const list = args === undefined ? [] : args
  if (!Array.isArray(list) || !list.every((arg) => typeof arg === 'string')) return null
  return {
    url,
    ...(typeof sha256 === 'string' ? { sha256: sha256.toLowerCase() } : {}),
    cmd,
    ...(list.length > 0 ? { args: list } : {}),
    ...(bare === true ? { bare: true as const } : {}),
  }
}

/** The bundled versions as the release run wrote them; what does not parse is left out. */
export function parseBundled(data: unknown): BundledVersions {
  const file = isObject(data) ? data : {}
  const kettu = new Map<string, KettuRelease>()
  for (const [id, entry] of Object.entries(isObject(file.kettu) ? file.kettu : {})) {
    if (!isObject(entry) || !isVersion(entry.version)) continue
    if (entry.archives === undefined) {
      kettu.set(id, { version: entry.version })
      continue
    }
    if (!isObject(entry.archives)) continue
    const archives: Record<string, ArchiveEntry> = {}
    for (const [key, value] of Object.entries(entry.archives)) {
      const archive = archiveOf(value)
      if (archive) archives[key] = archive
    }
    kettu.set(id, { version: entry.version, archives })
  }
  return { registry: parseRegistry(file.registry) ?? new Map(), kettu }
}

/** The versions this build bundles. */
export const BUNDLED: BundledVersions = parseBundled(bundledFile)

/** The oldest version the catalog accepts for the harness, when it names one. */
export function minimumOf(def: VersionDef): string | undefined {
  const { launch } = def
  if (launch.kind === 'package' || launch.kind === 'uvx') return launch.minimum
  return def.installs?.archive?.minimum
}

/** Whether a version is one the catalog accepts for the harness. */
export function inRange(def: VersionDef, version: string): boolean {
  const minimum = minimumOf(def)
  return !minimum || compareVersions(version, minimum) >= 0
}

/** The release `kettu` names, as the harness installs it on this platform. */
function kettuRelease(
  def: VersionDef,
  own: KettuRelease,
  platform: Platform,
  arch: string,
): RegistryRelease | null {
  switch (def.launch.kind) {
    case 'package':
      return { kind: 'package', version: own.version }
    case 'uvx':
      return { kind: 'uvx', version: own.version }
    case 'binary': {
      const entry = own.archives?.[archiveKey(platform, arch)]
      return entry ? { kind: 'archive', version: own.version, entry } : null
    }
    case 'node-script':
      return null
  }
}

/** The bundled release of a harness Kettu installs, or null when none fits this platform. */
export function bundledRelease(
  def: VersionDef,
  bundled: BundledVersions,
  platform: Platform,
  arch: string,
): TargetRelease | null {
  const own = bundled.kettu.get(def.id)
  const found = own
    ? kettuRelease(def, own, platform, arch)
    : followsRegistry(def)
      ? registryRelease(bundled.registry, def, platform, arch, { unhashed: true })
      : null
  if (!found || 'reason' in found || !inRange(def, found.version)) return null
  return { ...found, source: 'bundled' }
}

/**
 * The release the listing gives a harness that follows the Registry, or why it gives none: an
 * entry the checks refuse, or a version outside the catalog's range.
 */
export function listedRelease(
  def: VersionDef,
  listing: RegistryAgents,
  platform: Platform,
  arch: string,
): RegistryRelease | { reason: string } {
  const found = registryRelease(listing, def, platform, arch, { unhashed: true })
  if ('reason' in found) return found
  const minimum = minimumOf(def)
  if (!inRange(def, found.version)) {
    return { reason: `the registry lists ${def.registryId} at ${found.version}, below ${minimum}` }
  }
  return found
}

/**
 * The version a harness that follows the Registry moves to: the listing's when it passes the
 * checks and fits the catalog's range, else the bundled one. Null for the other harnesses.
 */
export function targetRelease(
  def: VersionDef,
  listing: RegistryAgents | null,
  bundled: BundledVersions,
  platform: Platform,
  arch: string,
): TargetRelease | null {
  if (!followsRegistry(def)) return null
  const found = listing ? listedRelease(def, listing, platform, arch) : null
  if (found && !('reason' in found)) return { ...found, source: 'registry' }
  return bundledRelease(def, bundled, platform, arch)
}

/** Which installed version a start runs, as the agent manager works it out for detection. */
export interface VersionChoice {
  /** The version a start runs once it is installed, and the one a first install takes. */
  wanted: string
  /**
   * The versions are the vendor's own, so `wanted` is the bundled version, the oldest that runs,
   * and the newest install from it up runs, an update the user installed included.
   */
  floor?: true
  /** The oldest version the catalog accepts. */
  minimum?: string
  /** A new version that failed to start in place of the one before it; it runs no more. */
  failed?: string
  /** The version that last started, which runs while `wanted` is not installed. */
  ran?: string
}

interface Install {
  version: string
  installedAt: number
}

const same = (a: string, b: string | undefined): boolean =>
  b !== undefined && compareVersions(a, b) === 0

/**
 * The installs a start may run, the one it runs first: the wanted version, then the one that ran
 * before, then the newest. With `floor`, only those from the floor up run, and `below` is the
 * newest under it, which runs when the floor's own install fails.
 */
export function orderInstalls<T extends Install>(
  installs: readonly T[],
  choice: VersionChoice,
): { runs: T[]; below: T | null } {
  const newest = (a: T, b: T): number =>
    compareVersions(b.version, a.version) || b.installedAt - a.installedAt
  const usable = installs.filter(
    (install) =>
      !same(install.version, choice.failed) &&
      (!choice.minimum || compareVersions(install.version, choice.minimum) >= 0),
  )
  if (choice.floor) {
    const sorted = usable.toSorted(newest)
    const from = (install: T): number => compareVersions(install.version, choice.wanted)
    return {
      runs: sorted.filter((install) => from(install) >= 0),
      below: sorted.find((install) => from(install) < 0) ?? null,
    }
  }
  const rank = (install: T): number =>
    same(install.version, choice.wanted) ? 0 : same(install.version, choice.ran) ? 1 : 2
  return { runs: usable.toSorted((a, b) => rank(a) - rank(b) || newest(a, b)), below: null }
}

/**
 * The installs to delete once `current` runs: those installed before it, but the latest of
 * another version, which a failed start of a later one falls back to. One installed after it,
 * such as an update that finished meanwhile, stays.
 */
export function staleInstalls<T extends Install & { dir: string }>(
  installs: readonly T[],
  current: T,
): T[] {
  const earlier = installs.filter(
    (install) => install.dir !== current.dir && install.installedAt <= current.installedAt,
  )
  const previous = earlier
    .filter((install) => !same(install.version, current.version))
    .toSorted((a, b) => b.installedAt - a.installedAt)[0]
  return earlier.filter((install) => install !== previous)
}
