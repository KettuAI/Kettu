// What each way of installing a harness brings, which the install window shows before anything
// runs: the package, archive or vendor command, its version, where it downloads from, the folder it
// goes into, its size when npm or the Registry gave it, and what it needs. Also which installs a
// session start may still run without the user's click.

import path from 'node:path'
import type {
  InstallDetails,
  InstallNeed,
  InstallOffer,
  InstallRoute,
  InstallSource,
} from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { routeFolder, type InstallPlan } from './binary-install'
import type { AdapterPlan, AgentDefinition } from './catalog'
import { followsRegistry } from './registry'
import { satisfiesNode, type NodeProbe } from './shell-env'

/** npm's configuration as `npm config get` printed it, by key; keys not set are left out. */
export type NpmConfig = ReadonlyMap<string, string>

export interface OfferInput {
  def: AgentDefinition
  platform: Platform
  home: string
  /** `~/.kettu/harnesses`, where Kettu keeps the harnesses it installs. */
  root: string
  /** The vendor's routes and the Registry's archive, as detection found them. */
  plans: readonly InstallPlan[]
  /**
   * Kettu's own copy of the harness's npm or uvx package, as a first install takes it, and the
   * package's own size when npm gave it; null for a harness Kettu installs no package of.
   */
  copy: { version: string; bytes: number | null } | null
  node: NodeProbe
  /** uv's `uvx` is on PATH. */
  uv: boolean
  /** Null when npm is missing or its configuration could not be read. */
  npm: NpmConfig | null
}

/** A scoped package's scope, such as `@moonshot-ai`; null for an unscoped one. */
function scopeOf(name: string): string | null {
  return name.startsWith('@') && name.includes('/') ? name.slice(0, name.indexOf('/')) : null
}

/** The keys `npm config get` answers for these packages: the registry, each scope's, the prefix. */
export function npmConfigKeys(packages: readonly string[]): string[] {
  const scopes = packages.flatMap((name) => {
    const scope = scopeOf(name)
    return scope ? [`${scope}:registry`] : []
  })
  return [...new Set(['registry', 'prefix', ...scopes])]
}

/** `npm config get` with several keys prints `key=value` lines, and `undefined` for one not set. */
export function parseNpmConfig(text: string): NpmConfig {
  const config = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const value = line.slice(at + 1).trim()
    if (value !== '' && value !== 'undefined' && value !== 'null') {
      config.set(line.slice(0, at).trim(), value)
    }
  }
  return config
}

/** The registry npm installs a package from: its scope's when the configuration names one. */
function npmSource(npm: NpmConfig | null, name: string): InstallSource {
  const scope = scopeOf(name)
  const registry = (scope ? npm?.get(`${scope}:registry`) : undefined) ?? npm?.get('registry')
  return { kind: 'npm', registry: registry ?? null }
}

function nodeNeed(def: AgentDefinition, node: NodeProbe): InstallNeed {
  const required = def.requiresNode ?? null
  const found = node.nodeVersion
  return {
    kind: 'node',
    minimum: required ? (/^>=\s*(\S+)$/.exec(required)?.[1] ?? null) : null,
    found,
    ok: !!node.nodePath && !!found && (!required || satisfiesNode(found, required)),
  }
}

const npmNeed = (node: NodeProbe): InstallNeed => ({ kind: 'npm', ok: !!node.npmPath })

/** Kettu's own copy of the npm or uvx package, which goes into `<root>/<harness>`. */
function copyRoute(input: OfferInput): InstallRoute | null {
  const { def, copy } = input
  const { launch } = def
  if (!copy) return null
  if (launch.kind === 'uvx') {
    return {
      id: 'copy',
      command: null,
      available: false,
      firstStart: true,
      details: {
        what: { kind: 'uvx', name: launch.package },
        version: copy.version,
        source: { kind: 'pypi' },
        folder: null,
        size: null,
        needs: [{ kind: 'uv', ok: input.uv }],
      },
    }
  }
  if (launch.kind !== 'package') return null
  const p = input.platform === 'win32' ? path.win32 : path.posix
  return {
    id: 'copy',
    command: null,
    available: true,
    details: {
      what: { kind: 'npm', name: launch.package },
      version: copy.version,
      source: npmSource(input.npm, launch.package),
      folder: p.join(input.root, def.id),
      size: copy.bytes === null ? null : { bytes: copy.bytes, packageOnly: true },
      needs: [...(launch.library ? [] : [nodeNeed(def, input.node)]), npmNeed(input.node)],
    },
  }
}

/** One of the vendor's routes, or the Registry's archive, which Kettu installs into its folder. */
function planRoute(input: OfferInput, plan: InstallPlan): InstallRoute {
  const { def, platform } = input
  const installs = def.installs ?? {}
  const p = platform === 'win32' ? path.win32 : path.posix
  const base = { id: plan.id, command: plan.command, available: plan.available }
  if (plan.id === 'archive' && plan.archive) {
    const { url } = plan.archive
    return {
      ...base,
      details: {
        what: { kind: 'archive', name: plan.label },
        version: plan.archive.version,
        source: followsRegistry(def) ? { kind: 'registry', url } : { kind: 'vendor', url },
        folder: p.join(input.root, def.id),
        size: null,
        needs: [],
      },
    }
  }
  const folder = routeFolder(plan, installs, {
    platform,
    home: input.home,
    npmPrefix: input.npm?.get('prefix') ?? null,
  })
  const { launch } = def
  // The vendor's global npm install of the package Kettu's copy is, which runs on the same Node.js.
  const samePackage = launch.kind === 'package' && installs.npm === launch.package
  const details: Omit<InstallDetails, 'source' | 'needs'> = {
    what: { kind: 'command' },
    version: null,
    folder,
    size: null,
  }
  switch (plan.id) {
    case 'npm':
      return {
        ...base,
        details: {
          ...details,
          source: npmSource(input.npm, installs.npm ?? ''),
          needs: [...(samePackage ? [nodeNeed(def, input.node)] : []), npmNeed(input.node)],
        },
      }
    case 'brew':
      return { ...base, details: { ...details, source: { kind: 'brew' }, needs: [] } }
    case 'winget':
      return { ...base, details: { ...details, source: { kind: 'winget' }, needs: [] } }
    default:
      return {
        ...base,
        details: {
          ...details,
          source: { kind: 'vendor', url: installs.script ?? plan.command },
          needs: [],
        },
      }
  }
}

/** The ways to install the harness, the recommended first: Kettu's own copy, then the vendor's. */
export function installOffer(input: OfferInput): InstallOffer {
  const copy = copyRoute(input)
  const { guide } = input.def.install
  return {
    routes: [...(copy ? [copy] : []), ...input.plans.map((plan) => planRoute(input, plan))],
    ...(guide ? { guide } : {}),
  }
}

/**
 * Whether a session start installs Kettu's copy of a package harness before it runs: only Claude
 * Code's SDK, which runs the user's own `claude`, and the version wanted beside an older copy,
 * which it falls back to. A copy that is missing is installed only from the install window.
 */
export function installsOnStart(def: AgentDefinition, adapter: AdapterPlan | null): boolean {
  if (!adapter) return false
  return !!def.cli || !!adapter.fallback
}
