// Installs the pinned ACP adapters from npm into the data directory, once per version, so a
// launch runs `node <entry>` with no registry round trip.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { spawnArguments } from './agent-process'
import { needsShell, type Env } from './find-command'
import { t } from './i18n'
import { processControl } from './process-tree'
import { TextRing } from './ring'

export const INSTALLED_FILE = 'installed.json'
const PARTIAL_PREFIX = '.partial-'

/** Every word is a constant, so an `npm.cmd` may run through cmd.exe. */
export const NPM_INSTALL_ARGS = [
  'install',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--no-update-notifier',
  '--loglevel=http',
] as const

export interface InstalledRecord {
  package: string
  version: string
  node: string | null
  npm: string | null
  installedAt: number
}

export interface InstalledAdapter {
  version: string
  dir: string
  /** The absolute path to the package's bin entry. */
  entry: string
}

function isRecord(value: unknown): value is InstalledRecord {
  const r = value as InstalledRecord | null
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.package === 'string' &&
    typeof r.version === 'string' &&
    typeof r.installedAt === 'number'
  )
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** The package's `bin`: its only entry, or the one named after the package without its scope. */
export async function binEntry(dir: string, packageName: string): Promise<string | null> {
  const packageDir = path.join(dir, 'node_modules', packageName)
  const manifest = (await readJson(path.join(packageDir, 'package.json'))) as {
    bin?: string | Record<string, string>
  } | null
  const bin = manifest?.bin
  let relative: string | undefined
  if (typeof bin === 'string') relative = bin
  else if (bin && typeof bin === 'object') {
    const entries = Object.values(bin)
    relative = entries.length === 1 ? entries[0] : bin[packageName.replace(/^@[^/]+\//, '')]
  }
  if (typeof relative !== 'string') return null
  const entry = path.resolve(packageDir, relative)
  const inside = path.relative(packageDir, entry)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null
  return (await isFile(entry)) ? entry : null
}

/** The installed version, if its directory is complete and holds this package. */
export async function findInstalled(
  root: string,
  agentId: string,
  packageName: string,
  version: string,
): Promise<InstalledAdapter | null> {
  const dir = path.join(root, agentId, version)
  const record = await readJson(path.join(dir, INSTALLED_FILE))
  if (!isRecord(record) || record.package !== packageName || record.version !== version) {
    return null
  }
  const entry = await binEntry(dir, packageName)
  return entry ? { version, dir, entry } : null
}

/** Installed versions of the package, newest first. */
export async function listInstalled(
  root: string,
  agentId: string,
  packageName: string,
): Promise<InstalledAdapter[]> {
  let names: string[]
  try {
    names = await readdir(path.join(root, agentId))
  } catch {
    return []
  }
  const found = await Promise.all(
    names
      .filter((name) => !name.startsWith(PARTIAL_PREFIX))
      .map((name) => findInstalled(root, agentId, packageName, name)),
  )
  return found
    .filter((adapter) => adapter !== null)
    .sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }))
}

/** Deletes every version directory but `keep`; returns the versions removed. */
export async function removeOtherVersions(
  root: string,
  agentId: string,
  keep: string,
): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(path.join(root, agentId))
  } catch {
    return []
  }
  const others = names.filter((name) => name !== keep && !name.startsWith(PARTIAL_PREFIX))
  await Promise.all(
    others.map((name) => rm(path.join(root, agentId, name), { recursive: true, force: true })),
  )
  return others
}

/** What an install recorded, for diagnostics. */
export async function readInstallFiles(
  dir: string,
): Promise<{ installed: unknown; lock: unknown }> {
  const [installed, lock] = await Promise.all([
    readJson(path.join(dir, INSTALLED_FILE)),
    readJson(path.join(dir, 'package-lock.json')),
  ])
  return { installed, lock }
}

/** Deletes one installed version, for a reinstall. */
export async function removeVersion(root: string, agentId: string, version: string): Promise<void> {
  await rm(path.join(root, agentId, version), { recursive: true, force: true })
}

export interface NpmRun {
  code: number | null
  signal: string | null
  /** Set when the process could not be started at all. */
  error?: string
  timedOut: boolean
  aborted: boolean
  output: TextRing
  stdout: string
}

export interface NpmOptions {
  npm: string
  args: readonly string[]
  cwd: string
  env: Env
  platform: Platform
  timeoutMs: number
  signal?: AbortSignal
  onOutput?(text: string): void
}

/** Ends npm and whatever it started: its process group on macOS and Linux, its tree on Windows. */
function stopTree(pid: number, platform: Platform, exited: Promise<unknown>): void {
  if (platform === 'win32') {
    void processControl(platform).taskkill([pid])
    return
  }
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pid, name)
    } catch {
      // Already gone.
    }
  }
  signal('SIGTERM')
  const timer = setTimeout(() => signal('SIGKILL'), 3_000)
  void exited.then(() => clearTimeout(timer))
}

export function runNpm(options: NpmOptions): Promise<NpmRun> {
  const { platform } = options
  const { file, args, shell } = spawnArguments({
    command: options.npm,
    args: [...options.args],
    env: {},
    shell: needsShell(options.npm, platform),
    display: { command: options.npm, args: [...options.args], env: {} },
  })
  const output = new TextRing(16 * 1024)
  let stdout = ''
  let timedOut = false
  let aborted = false
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ code: null, signal: null, timedOut, aborted: true, output, stdout })
      return
    }
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      windowsHide: true,
      shell,
    })
    const exited = new Promise<void>((done) => child.once('close', () => done()))
    const take = (text: string): void => {
      output.push(text)
      options.onOutput?.(text)
    }
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text
      take(text)
    })
    child.stderr.setEncoding('utf8').on('data', take)
    const stop = (): void => {
      if (child.pid) stopTree(child.pid, platform, exited)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    const onAbort = (): void => {
      aborted = true
      stop()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (run: Omit<NpmRun, 'timedOut' | 'aborted' | 'output' | 'stdout'>): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ ...run, timedOut, aborted, output, stdout })
    }
    child.once('error', (error) => {
      if (!child.pid) finish({ code: null, signal: null, error: error.message })
    })
    child.once('close', (code, signal) => finish({ code, signal }))
  })
}

/** npm's own error lines, else its last lines. */
export function npmFailure(output: TextRing): string {
  const lines = output.lastLines(40)
  const errors = lines.filter((line) => /^npm (error|ERR!)/.test(line))
  return (errors.length > 0 ? errors.slice(-3) : lines.slice(-3)).join(' ')
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Windows may hold a fresh file open for a moment, for a virus scan; npm retries the same way. */
async function renameWithRetry(from: string, to: string, platform: Platform): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (platform !== 'win32' || !RETRYABLE.has(code) || attempt >= 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
    }
  }
}

/** Partial directories older than this belong to no install still running. */
async function removeStalePartials(dir: string, olderThanMs: number): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((name) => name.startsWith(PARTIAL_PREFIX))
      .map(async (name) => {
        const full = path.join(dir, name)
        const info = await stat(full).catch(() => null)
        if (info && Date.now() - info.mtimeMs > olderThanMs) {
          await rm(full, { recursive: true, force: true })
        }
      }),
  )
}

export interface InstallOptions {
  /** `<userData>/agents`. */
  root: string
  agentId: string
  package: string
  version: string
  /** What `package.json` asks npm for: the version, or a local tarball in tests. */
  spec?: string
  npm: string
  nodeVersion: string | null
  platform: Platform
  env: Env
  timeoutMs: number
  signal?: AbortSignal
  onOutput?(text: string): void
}

/**
 * Installs one version in a partial directory and renames it into place once complete, so a
 * version directory is either whole or absent.
 */
export async function installAdapter(options: InstallOptions): Promise<InstalledAdapter> {
  const { root, agentId, platform } = options
  const agentDir = path.join(root, agentId)
  await mkdir(agentDir, { recursive: true })
  await removeStalePartials(agentDir, options.timeoutMs)
  const partial = path.join(agentDir, `${PARTIAL_PREFIX}${randomBytes(6).toString('hex')}`)
  await mkdir(partial)
  const run = (args: readonly string[], timeoutMs: number, progress: boolean): Promise<NpmRun> =>
    runNpm({
      npm: options.npm,
      args,
      cwd: partial,
      env: options.env,
      platform,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(progress && options.onOutput ? { onOutput: options.onOutput } : {}),
    })
  try {
    const probe = await run(['--version'], 30_000, false)
    if (probe.aborted) throw new Error(t('agent.installStopped'))
    if (probe.error) throw new Error(`npm could not be started: ${probe.error}`)
    const npmVersion = probe.code === 0 ? probe.stdout.trim() || null : null
    await writeFile(
      path.join(partial, 'package.json'),
      `${JSON.stringify(
        {
          name: `overbench-${agentId}`,
          private: true,
          dependencies: { [options.package]: options.spec ?? options.version },
        },
        null,
        2,
      )}\n`,
    )
    const result = await run(NPM_INSTALL_ARGS, options.timeoutMs, true)
    if (result.aborted) throw new Error(t('agent.installStopped'))
    if (result.timedOut) {
      const ms = options.timeoutMs
      const limit = ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${ms / 1000} s`
      throw new Error(`npm did not finish within ${limit}.`)
    }
    if (result.error) throw new Error(`npm could not be started: ${result.error}`)
    if (result.code !== 0) {
      const how = result.signal
        ? `was stopped by ${result.signal}`
        : `exited with code ${result.code}`
      throw new Error(`npm ${how}. ${npmFailure(result.output)}`.trim())
    }
    if (!(await binEntry(partial, options.package))) {
      throw new Error(`${options.package} was installed without a program to run.`)
    }
    const record: InstalledRecord = {
      package: options.package,
      version: options.version,
      node: options.nodeVersion,
      npm: npmVersion,
      installedAt: Date.now(),
    }
    await writeFile(path.join(partial, INSTALLED_FILE), `${JSON.stringify(record, null, 2)}\n`)
    const target = path.join(agentDir, options.version)
    try {
      await renameWithRetry(partial, target, platform)
    } catch (error) {
      // Another instance finished the same version first; an incomplete one is replaced.
      const existing = await findInstalled(root, agentId, options.package, options.version)
      if (existing) {
        await rm(partial, { recursive: true, force: true })
        return existing
      }
      if (!(await stat(target).catch(() => null))) throw error
      await rm(target, { recursive: true, force: true })
      await renameWithRetry(partial, target, platform)
    }
    const installed = await findInstalled(root, agentId, options.package, options.version)
    if (!installed) throw new Error(`${options.package} ${options.version} is incomplete on disk.`)
    return installed
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
