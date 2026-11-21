// The update check for package agents: the newest adapter on npm and the CLI a fresh install of it
// carries, asked with the user's npm and the agent environment, so `.npmrc`, registry mirrors and
// the proxy apply as they do for the install.

import type { AgentUpdate } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import {
  npmFailure,
  programFailure,
  runNpm,
  runProgram,
  type NpmOptions,
  type NpmRun,
  type ProgramOptions,
  type ProgramRun,
} from './adapter-install'
import type { Env } from './find-command'
import { t } from './i18n'
import { compareVersions, highestVersion, isVersion } from './versions'

/**
 * An npm version range, as a dependency names it. It reaches npm's command line, through cmd.exe
 * for an `npm.cmd`, so only characters that mean nothing to cmd.exe inside double quotes pass.
 */
const RANGE = /^[0-9A-Za-z.+\-^~<>=| *]{1,200}$/

/** A dist-tag name, which reaches the same command line as a range does. */
const TAG = /^[0-9A-Za-z._-]{1,100}$/

// npm's codes for a registry it could not reach.
const OFFLINE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/

export interface LatestOptions {
  npm: string
  /** The adapter's package. */
  package: string
  /** The versions an update may move to, as an npm range; the `latest` tag when not given. */
  range?: string
  /** The dist-tag to read in place of `latest`, which a range, when given, takes precedence over. */
  tag?: string
  /**
   * The package and `package.json` field that name the CLI the adapter carries: a dependency's,
   * or the adapter's own field when it names the adapter's package.
   */
  cli: { package: string; field: string } | null
  env: Env
  platform: Platform
  cwd: string
  /** Per npm call. */
  timeoutMs: number
  signal?: AbortSignal
  run?(options: NpmOptions): Promise<NpmRun>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Why `npm view` failed, in the user's terms where Kettu knows them. */
function viewFailure(run: NpmRun, parsed: unknown): string {
  const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null
  const code = typeof error?.code === 'string' ? error.code : ''
  if (OFFLINE.test(code) || OFFLINE.test(run.output.toString())) return t('agent.update.offline')
  if (typeof error?.summary === 'string' && error.summary !== '') return error.summary
  return (
    npmFailure(run.output) || t('agent.program.exitedBare', { name: 'npm', code: String(run.code) })
  )
}

/** `npm view <words> --json`; undefined when npm printed nothing, as for a field none has. */
async function view(options: LatestOptions, words: string[]): Promise<unknown> {
  const run = await (options.run ?? runNpm)({
    npm: options.npm,
    // Without fetch retries an unreachable registry answers at once instead of at the time limit.
    args: ['view', ...words, '--json', '--no-update-notifier', '--fetch-retries=0'],
    cwd: options.cwd,
    env: options.env,
    platform: options.platform,
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (run.aborted) throw new Error(t('agent.update.stopped'))
  if (run.timedOut) {
    throw new Error(t('agent.update.timeout', { seconds: String(options.timeoutMs / 1000) }))
  }
  if (run.error) throw new Error(t('agent.program.notStarted', { name: 'npm', error: run.error }))
  const parsed = parseJson(run.stdout)
  if (run.code !== 0) throw new Error(viewFailure(run, parsed))
  return parsed
}

/** npm's field for the size of a version's own files, without its dependencies. */
const SIZE_FIELD = 'dist.unpackedSize'

/** What npm says of the version an update moves to, and its own size when npm gives it. */
export type LatestFound = AgentUpdate & { unpackedSize?: number }

function sizeOf(row: unknown): { unpackedSize?: number } {
  const size = isObject(row) ? row[SIZE_FIELD] : undefined
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? { unpackedSize: size } : {}
}

/**
 * The adapter version npm's `latest` tag, or the one given, names, and the newest CLI its
 * dependency range allows, which a fresh install takes; for a package that is the CLI itself, its
 * own version. Rejects with a reason the user can read.
 */
export async function fetchLatest(options: LatestOptions): Promise<LatestFound> {
  if (options.range !== undefined) return fetchInRange(options, options.range)
  if (options.tag !== undefined && !TAG.test(options.tag)) {
    throw new Error(t('agent.update.noVersion', { package: options.package }))
  }
  const spec = options.tag ? `${options.package}@${options.tag}` : options.package
  const manifest = await view(options, [spec, 'version', 'dependencies', SIZE_FIELD])
  // With several fields npm prints an object; a version without the others prints the version.
  const version = isObject(manifest) ? manifest.version : manifest
  if (!isVersion(version))
    throw new Error(t('agent.update.noVersion', { package: options.package }))
  const size = sizeOf(manifest)
  const { cli } = options
  if (cli?.package === options.package) {
    return { adapterVersion: version, cliVersion: version, ...size }
  }
  const dependencies = isObject(manifest) ? manifest.dependencies : undefined
  const range = cli && isObject(dependencies) ? dependencies[cli.package] : undefined
  if (!cli || typeof range !== 'string' || !RANGE.test(range)) {
    return { adapterVersion: version, cliVersion: null, ...size }
  }
  // One matching version prints its field as a string, several as an array.
  const value = await view(options, [`${cli.package}@${range}`, cli.field])
  return { adapterVersion: version, cliVersion: highestVersion(value), ...size }
}

/**
 * The newest version in `range`, and the CLI it names in its own field when `cli` names the
 * package itself. npm prints one version's fields as an object, several versions as an array.
 */
async function fetchInRange(options: LatestOptions, range: string): Promise<LatestFound> {
  if (!RANGE.test(range)) throw new Error(t('agent.update.noVersion', { package: options.package }))
  const own = options.cli?.package === options.package ? options.cli.field : null
  const fields = own ? ['version', own, SIZE_FIELD] : ['version', SIZE_FIELD]
  const value = await view(options, [`${options.package}@${range}`, ...fields])
  const rows = (Array.isArray(value) ? value : [value]).flatMap((row: unknown) =>
    isObject(row)
      ? [{ version: row.version, cli: own ? row[own] : undefined, size: sizeOf(row) }]
      : [{ version: row, cli: undefined, size: {} }],
  )
  let best: { version: string; cli: unknown; size: { unpackedSize?: number } } | null = null
  for (const row of rows) {
    if (!isVersion(row.version)) continue
    if (!best || compareVersions(row.version, best.version) > 0) {
      best = { version: row.version, cli: row.cli, size: row.size }
    }
  }
  if (!best) throw new Error(t('agent.update.noVersion', { package: options.package }))
  return {
    adapterVersion: best.version,
    cliVersion: typeof best.cli === 'string' && isVersion(best.cli) ? best.cli : null,
    ...best.size,
  }
}

export interface BrewLatestOptions {
  brew: string
  /** The formula, a tap's included, or the cask. */
  name: string
  cask: boolean
  env: Env
  platform: Platform
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  run?(options: ProgramOptions): Promise<ProgramRun>
}

/**
 * The version Homebrew would upgrade a formula or cask to, as `brew info --json=v2` prints it:
 * a formula's stable version, or a cask's version before any `,` build part. Null when it names
 * none.
 */
export function brewVersion(text: string, cask: boolean): string | null {
  const parsed = parseJson(text)
  if (!isObject(parsed)) return null
  const list = parsed[cask ? 'casks' : 'formulae']
  const entry: unknown = Array.isArray(list) ? list[0] : undefined
  if (!isObject(entry)) return null
  const raw = cask ? entry.version : isObject(entry.versions) ? entry.versions.stable : undefined
  const version = typeof raw === 'string' ? raw.split(',')[0] : undefined
  return isVersion(version) ? version : null
}

/**
 * The newest version of a formula or cask that Homebrew knows, read through the user's own brew,
 * which answers from its own copy of the formulae. Rejects with a reason the user can read.
 */
export async function fetchBrewLatest(options: BrewLatestOptions): Promise<string> {
  const args = ['info', '--json=v2', options.cask ? '--cask' : '--formula', options.name]
  const run = await (options.run ?? runProgram)({
    program: options.brew,
    args,
    cwd: options.cwd,
    env: options.env,
    platform: options.platform,
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (run.aborted) throw new Error(t('agent.update.stopped'))
  const failure = programFailure('brew', run, options.timeoutMs)
  if (failure) throw new Error(failure)
  const version = brewVersion(run.stdout, options.cask)
  if (!version) throw new Error(t('agent.update.noVersion', { package: options.name }))
  return version
}

/** The install a start runs, as the update decision sees it. */
export interface CurrentInstall {
  version: string
  cliVersion: string | null
}

/**
 * The update to offer: the latest adapter when it is newer than the install a start runs, or the
 * same adapter when a fresh install of it carries a newer CLI. Null when there is none, or when
 * nothing is installed yet, since the first install takes the pinned version.
 */
export function decideUpdate(
  latest: AgentUpdate | null,
  current: CurrentInstall | null,
): AgentUpdate | null {
  if (!latest || !current) return null
  const adapter = compareVersions(latest.adapterVersion, current.version)
  if (adapter > 0) return latest
  if (adapter < 0 || !latest.cliVersion || !current.cliVersion) return null
  return compareVersions(latest.cliVersion, current.cliVersion) > 0 ? latest : null
}
