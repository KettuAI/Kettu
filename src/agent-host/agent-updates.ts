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
  /** The package and `package.json` field that name the CLI the adapter carries. */
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

/** Why `npm view` failed, in the user's terms where OverBench knows them. */
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
 * which a fresh install takes. Rejects with a reason the user can read.
 */
export async function fetchLatest(options: LatestOptions): Promise<AgentUpdate> {
  const manifest = await view(options, [options.package, 'version', 'dependencies'])
  // With both fields npm prints an object; a version without dependencies prints the version.
  const version = isObject(manifest) ? manifest.version : manifest
  if (!isVersion(version))
    throw new Error(t('agent.update.noVersion', { package: options.package }))
  const { cli } = options
  const dependencies = isObject(manifest) ? manifest.dependencies : undefined
  const range = cli && isObject(dependencies) ? dependencies[cli.package] : undefined
  if (!cli || typeof range !== 'string' || !RANGE.test(range)) {
    return { adapterVersion: version, cliVersion: null }
  }
  // One matching version prints its field as a string, several as an array.
  const value = await view(options, [`${cli.package}@${range}`, cli.field])
  return { adapterVersion: version, cliVersion: highestVersion(value) }
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
