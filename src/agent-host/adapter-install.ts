// Installs the ACP adapters from npm into the data directory, once per version or update, so a
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
import { compareVersions } from './versions'

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

/** Leaves out the platform packages that hold the adapter's own CLI, its only optional ones. */
export const OMIT_CLI_ARG = '--omit=optional'

export interface InstalledRecord {
  package: string
  version: string
  node: string | null
  npm: string | null
  installedAt: number
  withoutCli?: true
}

/** An install is named by its `installed.json`, not its directory, so one version can have two. */
export interface InstalledAdapter {
  version: string
  dir: string
  /** The absolute path to the package's bin entry. */
  entry: string
  installedAt: number
  /** Installed without the CLI it brings, which the user's own CLI replaces. */
  withoutCli?: true
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

/** The install in `dir`, if it is complete and holds this package. */
export async function readInstall(
  dir: string,
  packageName: string,
): Promise<InstalledAdapter | null> {
  const record = await readJson(path.join(dir, INSTALLED_FILE))
  if (!isRecord(record) || record.package !== packageName) return null
  const entry = await binEntry(dir, packageName)
  if (!entry) return null
  const install = { version: record.version, dir, entry, installedAt: record.installedAt }
  return record.withoutCli === true ? { ...install, withoutCli: true } : install
}

/** Older first: by version, then by install time, so a later install of one version wins. */
export function compareInstalls(a: InstalledAdapter, b: InstalledAdapter): number {
  return compareVersions(a.version, b.version) || a.installedAt - b.installedAt
}

async function installDirs(root: string, agentId: string): Promise<string[]> {
  try {
    const names = await readdir(path.join(root, agentId))
    return names.filter((name) => !name.startsWith(PARTIAL_PREFIX))
  } catch {
    return []
  }
}

/** Installed versions of the package, newest first. */
export async function listInstalled(
  root: string,
  agentId: string,
  packageName: string,
): Promise<InstalledAdapter[]> {
  const names = await installDirs(root, agentId)
  const found = await Promise.all(
    names.map((name) => readInstall(path.join(root, agentId, name), packageName)),
  )
  return found.filter((adapter) => adapter !== null).sort((a, b) => compareInstalls(b, a))
}

/**
 * Deletes the installs older than `keep`, and directories that hold no complete install; returns
 * the directory names removed. A newer install, such as an update that finished meanwhile, stays.
 */
export async function removeOlderInstalls(
  root: string,
  agentId: string,
  packageName: string,
  keep: InstalledAdapter,
): Promise<string[]> {
  const names = (await installDirs(root, agentId)).filter(
    (name) => path.join(root, agentId, name) !== keep.dir,
  )
  const older = await Promise.all(
    names.map(async (name) => {
      const install = await readInstall(path.join(root, agentId, name), packageName)
      return !install || compareInstalls(install, keep) < 0 ? name : null
    }),
  )
  const removed = older.filter((name) => name !== null)
  await Promise.all(
    removed.map((name) => rm(path.join(root, agentId, name), { recursive: true, force: true })),
  )
  return removed
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

/** Deletes one install, for a reinstall. */
export async function removeInstall(dir: string): Promise<void> {
  await removeTree(dir)
}

/**
 * Deletes a directory npm just wrote to. On Windows a virus scan or npm's own child may hold a
 * file for a moment, so EBUSY and EPERM are retried, as for the rename below.
 */
export async function removeTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

export interface ProgramRun {
  code: number | null
  signal: string | null
  /** Set when the process could not be started at all. */
  error?: string
  timedOut: boolean
  aborted: boolean
  output: TextRing
  stdout: string
}

export type NpmRun = ProgramRun

export interface ProgramOptions {
  /** An absolute path; its arguments are constants, so a `.cmd` may run through cmd.exe. */
  program: string
  args: readonly string[]
  cwd: string
  env: Env
  platform: Platform
  timeoutMs: number
  signal?: AbortSignal
  onOutput?(text: string): void
}

export interface NpmOptions extends Omit<ProgramOptions, 'program'> {
  npm: string
}

/** Ends a program and what it started: its group on macOS and Linux, its tree on Windows. */
function stopTree(pid: number, platform: Platform, exited: Promise<unknown>): void {
  if (platform === 'win32') {
    void processControl(platform)
      .taskkill([pid])
      .catch(() => {})
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

/** Runs a tool such as npm or brew to its end, its time limit, or the signal's abort. */
export function runProgram(options: ProgramOptions): Promise<ProgramRun> {
  const { platform } = options
  const { file, args, shell } = spawnArguments({
    command: options.program,
    args: [...options.args],
    env: {},
    shell: needsShell(options.program, platform),
    display: { command: options.program, args: [...options.args], env: {} },
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
    const finish = (run: Omit<ProgramRun, 'timedOut' | 'aborted' | 'output' | 'stdout'>): void => {
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

export function runNpm(options: NpmOptions): Promise<NpmRun> {
  const { npm, ...rest } = options
  return runProgram({ ...rest, program: npm })
}

/** npm's own error lines, else the last lines of any tool's output. */
export function npmFailure(output: TextRing): string {
  const lines = output.lastLines(40)
  const errors = lines.filter((line) => /^npm (error|ERR!)/.test(line))
  return (errors.length > 0 ? errors.slice(-3) : lines.slice(-3)).join(' ')
}

/** Why a run did not succeed, or null when it exited with 0; the tool's part stays in English. */
export function programFailure(name: string, run: ProgramRun, timeoutMs: number): string | null {
  if (run.aborted) return t('agent.installStopped')
  if (run.timedOut) {
    const limit =
      timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${timeoutMs / 1000} s`
    return `${name} did not finish within ${limit}.`
  }
  if (run.error) return `${name} could not be started: ${run.error}`
  if (run.code === 0) return null
  const how = run.signal ? `was stopped by ${run.signal}` : `exited with code ${run.code}`
  return `${name} ${how}. ${npmFailure(run.output)}`.trim()
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
  /**
   * Installs beside an existing install of the same version, in `<version>~<installedAt>`, as an
   * update does when a fresh install of the version brings a newer CLI.
   */
  alongside?: boolean
  /** Leaves out the CLI the adapter brings, since the user's own runs instead. */
  withoutCli?: boolean
}

/**
 * Installs one version in a partial directory and renames it into place once complete, so an
 * install directory is either whole or absent.
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
    const args = options.withoutCli ? [...NPM_INSTALL_ARGS, OMIT_CLI_ARG] : NPM_INSTALL_ARGS
    const result = await run(args, options.timeoutMs, true)
    const failure = programFailure('npm', result, options.timeoutMs)
    if (failure) throw new Error(failure)
    if (!(await binEntry(partial, options.package))) {
      throw new Error(`${options.package} was installed without a program to run.`)
    }
    const record: InstalledRecord = {
      package: options.package,
      version: options.version,
      node: options.nodeVersion,
      npm: npmVersion,
      installedAt: Date.now(),
      ...(options.withoutCli ? { withoutCli: true as const } : {}),
    }
    await writeFile(path.join(partial, INSTALLED_FILE), `${JSON.stringify(record, null, 2)}\n`)
    let target = path.join(agentDir, options.version)
    if (options.alongside && (await stat(target).catch(() => null))) {
      target = path.join(agentDir, `${options.version}~${record.installedAt}`)
      await renameWithRetry(partial, target, platform)
    } else {
      try {
        await renameWithRetry(partial, target, platform)
      } catch (error) {
        // Another instance finished the same version first; an incomplete one is replaced.
        const existing = await readInstall(target, options.package)
        if (existing?.version === options.version) {
          await removeTree(partial)
          return existing
        }
        if (!(await stat(target).catch(() => null))) throw error
        await removeTree(target)
        await renameWithRetry(partial, target, platform)
      }
    }
    const installed = await readInstall(target, options.package)
    if (installed?.version !== options.version) {
      throw new Error(`${options.package} ${options.version} is incomplete on disk.`)
    }
    return installed
  } catch (error) {
    // A partial left behind anyway goes with the stale ones at a later install.
    await removeTree(partial).catch(() => {})
    throw error
  }
}
