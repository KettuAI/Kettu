// The update check for package agents: the newest adapter on npm and the CLI a fresh install of it
// carries, asked with the user's npm and the agent environment, so `.npmrc`, registry mirrors and
// the proxy apply as they do for the install.

import type { AgentUpdate } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { npmFailure, runNpm, type NpmOptions, type NpmRun } from './adapter-install'
import type { Env } from './find-command'
import { t } from './i18n'
import { compareVersions, highestVersion, isVersion } from './versions'

/**
 * An npm version range, as a dependency names it. It reaches npm's command line, through cmd.exe
 * for an `npm.cmd`, so only characters that mean nothing to cmd.exe inside double quotes pass.
 */
const RANGE = /^[0-9A-Za-z.+\-^~<>=| *]{1,200}$/

// npm's codes for a registry it could not reach.
const OFFLINE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/

export interface LatestOptions {
  npm: string
  /** The adapter's package. */
  package: string
  /** The versions an update may move to, as an npm range; the `latest` tag when not given. */
  range?: string
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
  return npmFailure(run.output) || `npm exited with code ${run.code}`
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
  if (run.error) throw new Error(`npm could not be started: ${run.error}`)
  const parsed = parseJson(run.stdout)
  if (run.code !== 0) throw new Error(viewFailure(run, parsed))
  return parsed
}

/**
 * The adapter version npm's `latest` tag names, and the newest CLI its dependency range allows,
 * which a fresh install takes; for a package that is the CLI itself, its own version. Rejects
 * with a reason the user can read.
 */
export async function fetchLatest(options: LatestOptions): Promise<AgentUpdate> {
  if (options.range !== undefined) return fetchInRange(options, options.range)
  const manifest = await view(options, [options.package, 'version', 'dependencies'])
  // With both fields npm prints an object; a version without dependencies prints the version.
  const version = isObject(manifest) ? manifest.version : manifest
  if (!isVersion(version))
    throw new Error(t('agent.update.noVersion', { package: options.package }))
  const { cli } = options
  if (cli?.package === options.package) return { adapterVersion: version, cliVersion: version }
  const dependencies = isObject(manifest) ? manifest.dependencies : undefined
  const range = cli && isObject(dependencies) ? dependencies[cli.package] : undefined
  if (!cli || typeof range !== 'string' || !RANGE.test(range)) {
    return { adapterVersion: version, cliVersion: null }
  }
  // One matching version prints its field as a string, several as an array.
  const value = await view(options, [`${cli.package}@${range}`, cli.field])
  return { adapterVersion: version, cliVersion: highestVersion(value) }
}

/**
 * The newest version in `range`, and the CLI it names in its own field when `cli` names the
 * package itself. npm prints one version's fields as an object, several versions as an array.
 */
async function fetchInRange(options: LatestOptions, range: string): Promise<AgentUpdate> {
  if (!RANGE.test(range)) throw new Error(t('agent.update.noVersion', { package: options.package }))
  const own = options.cli?.package === options.package ? options.cli.field : null
  const fields = own ? ['version', own] : ['version']
  const value = await view(options, [`${options.package}@${range}`, ...fields])
  const rows = (Array.isArray(value) ? value : [value]).flatMap((row: unknown) =>
    isObject(row)
      ? [{ version: row.version, cli: own ? row[own] : undefined }]
      : [{ version: row, cli: undefined }],
  )
  let best: { version: string; cli: unknown } | null = null
  for (const row of rows) {
    if (!isVersion(row.version)) continue
    if (!best || compareVersions(row.version, best.version) > 0) {
      best = { version: row.version, cli: row.cli }
    }
  }
  if (!best) throw new Error(t('agent.update.noVersion', { package: options.package }))
  return {
    adapterVersion: best.version,
    cliVersion: typeof best.cli === 'string' && isVersion(best.cli) ? best.cli : null,
  }
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
