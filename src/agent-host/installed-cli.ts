// The Claude Code or Codex CLI the user installed, which an adapter runs instead of the copy it
// brings: found on PATH, resolved to a file that starts without a shell, asked its version and
// held against the oldest version the installed adapter runs.

import { open, readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentCliSource, InstalledCli } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { programFailure, runProgram, type ProgramOptions, type ProgramRun } from './adapter-install'
import { codexBinary, npmCodexEnv } from './codex-binary'
import { findCommand, getEnv, needsShell, type Env } from './find-command'
import { compareVersions } from './versions'

/** File access, injected so tests can lay out any platform's install. */
export interface CliFiles {
  isFile(file: string): Promise<boolean>
  realpath(file: string): Promise<string>
  /** The file's text, or its first `limit` bytes. */
  readText(file: string, limit?: number): Promise<string>
}

async function readHead(file: string, limit: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

export const CLI_FILES: CliFiles = {
  isFile: async (file) => (await stat(file).catch(() => null))?.isFile() ?? false,
  realpath: (file) => realpath(file),
  readText: (file, limit) => (limit === undefined ? readFile(file, 'utf8') : readHead(file, limit)),
}

// npm's and pnpm's shims are under 1 KB; a larger `.cmd` is not one of theirs.
const SHIM_LIMIT = 64 * 1024

/** The file an adapter runs for the user's CLI, and the variables that go with it. */
export interface ResolvedCli {
  path: string
  env: Record<string, string>
}

/** How a package agent's adapter can run a CLI the user installed. */
export interface AdapterCli {
  /** The command the user's CLI answers to on PATH. */
  command: string
  /** The variable the adapter reads to run it instead of its own. */
  variable: string
  /**
   * The adapter starts the CLI while it initializes, so a start that fails can be put down to the
   * CLI and tried again with the copy. Otherwise the CLI first runs with a session.
   */
  startsAtInitialize: boolean
  /**
   * The adapter pins one CLI version exactly, so the CLI version an update check finds for a new
   * adapter is also the oldest that adapter runs.
   */
  pinsVersion: boolean
  /** About how large the copy the adapter brings is, in MB, said before a start downloads it. */
  copyMegabytes: number
  /** The file that runs without a shell, or null when there is none. */
  resolve(found: string, platform: Platform, files: CliFiles): Promise<ResolvedCli | null>
  /** The oldest CLI the adapter installed in `dir` runs, or null when it names none. */
  minimum(dir: string, adapterPackage: string, files: CliFiles): Promise<string | null>
}

const VERSION_TEXT = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`
const FIRST_VERSION = new RegExp(String.raw`\bv?(${VERSION_TEXT})`)
const EXACT_VERSION = new RegExp(`^${VERSION_TEXT}$`)
// `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3` or `=1.2.3`, with an upper bound or none.
const LOWER_BOUND = new RegExp(
  String.raw`^\s*(?:\^|~|>=|=)?\s*v?(${VERSION_TEXT})(?:\s+<=?\s*v?${VERSION_TEXT})?\s*$`,
)

/** The first `x.y.z` in what `--version` printed, with or without a leading `v`. */
export function parseCliVersion(output: string): string | null {
  return FIRST_VERSION.exec(output)?.[1] ?? null
}

/** The lowest version a dependency range allows, or null for a range it cannot be read from. */
export function lowerBound(range: unknown): string | null {
  return typeof range === 'string' ? (LOWER_BOUND.exec(range)?.[1] ?? null) : null
}

/**
 * The program an npm or pnpm `.cmd` shim starts: the last path it quotes after `%dp0%\` or
 * `%~dp0\`, other than Node.js itself, taken from the shim's folder. Null for any other script.
 */
export function shimTarget(text: string, shim: string): string | null {
  const quoted = [...text.matchAll(/"%~?dp0%?\\([^"%]+)"/g)].map((match) => match[1] ?? '')
  const target = quoted
    .filter((file) => !/^node(?:\.exe)?$/i.test(path.win32.basename(file)))
    .at(-1)
  return target ? path.win32.resolve(path.win32.dirname(shim), target) : null
}

/** On Windows, an `.exe` as found or the target of a shim; elsewhere the path as found. */
async function startable(
  found: string,
  platform: Platform,
  files: CliFiles,
): Promise<string | null> {
  if (platform !== 'win32') return found
  const ext = path.win32.extname(found).toLowerCase()
  if (ext === '.exe' || ext === '.com') return found
  if (ext !== '.cmd' && ext !== '.bat') return null
  const text = await files.readText(found, SHIM_LIMIT).catch(() => null)
  const target = text === null ? null : shimTarget(text, found)
  return target && (await files.isFile(target)) ? target : null
}

function isWindowsProgram(file: string): boolean {
  return /\.(?:exe|com)$/i.test(file)
}

async function readManifest(
  files: CliFiles,
  file: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await files.readText(file))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export const CLAUDE_CLI: AdapterCli = {
  command: 'claude',
  variable: 'CLAUDE_CODE_EXECUTABLE',
  startsAtInitialize: false,
  pinsVersion: true,
  // The platform package on macOS arm64, measured 2026-10-22.
  copyMegabytes: 256,
  // The adapter also calls it with execFile, so on Windows it must be a program itself.
  resolve: async (found, platform, files) => {
    const file = await startable(found, platform, files)
    return file && (platform !== 'win32' || isWindowsProgram(file)) ? { path: file, env: {} } : null
  },
  // The adapter pins its SDK exactly, which names the one CLI it was built against.
  minimum: async (dir, _adapterPackage, files) => {
    const sdk = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')
    const version = (await readManifest(files, sdk))?.claudeCodeVersion
    return typeof version === 'string' && EXACT_VERSION.test(version) ? version : null
  },
}

export const CODEX_CLI: AdapterCli = {
  command: 'codex',
  variable: 'CODEX_PATH',
  startsAtInitialize: true,
  pinsVersion: false,
  // The platform package on macOS arm64, measured 2026-10-22.
  copyMegabytes: 318,
  resolve: async (found, platform, files) => {
    const file = await startable(found, platform, files)
    if (!file) return null
    // npm's codex.js only finds the platform's binary and starts it, so the adapter runs that.
    const real = await files.realpath(file).catch(() => file)
    const p = platform === 'win32' ? path.win32 : path.posix
    if (real.split(/[\\/]/).slice(-4).join('/') === '@openai/codex/bin/codex.js') {
      const root = p.dirname(p.dirname(real))
      const binary = await codexBinary(root, platform, null, files.isFile)
      if (binary) return { path: binary, env: npmCodexEnv(root) }
      // Off Windows codex.js runs by its shebang, and says itself what is missing.
      return platform === 'win32' ? null : { path: file, env: {} }
    }
    return platform !== 'win32' || isWindowsProgram(file) ? { path: file, env: {} } : null
  },
  minimum: async (dir, adapterPackage, files) => {
    const manifest = await readManifest(
      files,
      path.join(dir, 'node_modules', adapterPackage, 'package.json'),
    )
    const dependencies = manifest?.dependencies as Record<string, unknown> | undefined
    return lowerBound(dependencies?.['@openai/codex'])
  },
}

export type CliVersion = { version: string } | { error: string }
export type CliProbe = (program: string, env: Env) => Promise<CliVersion>

export interface CliVersionsOptions {
  platform: Platform
  timeoutMs?: number
  run?(options: ProgramOptions): Promise<ProgramRun>
  stat?(file: string): Promise<{ size: number; mtimeMs: number } | null>
}

/**
 * `<program> --version`, asked again only when the file changes, as a CLI that updates itself does.
 * A timeout, a start that failed or a signal is asked once more at once, since the first run of a
 * fresh binary can be slow while it is scanned. Failing the same way twice, it is kept like any
 * other answer, so a program that hangs costs one wait, not one per detection; failing another
 * way, it is not kept. `clear()` (Reload environment) asks again either way.
 */
export class CliVersions {
  private readonly answers = new Map<string, Promise<CliVersion>>()

  constructor(private readonly options: CliVersionsOptions) {}

  clear(): void {
    this.answers.clear()
  }

  async probe(program: string, env: Env): Promise<CliVersion> {
    const info = await (this.options.stat ?? ((file) => stat(file).catch(() => null)))(program)
    if (!info) return { error: `${program} was not found.` }
    const key = `${program}\0${info.size}\0${info.mtimeMs}`
    let answer = this.answers.get(key)
    if (!answer) {
      const asked: Promise<CliVersion> = this.ask(program, env).then(async (first) => {
        if (!first.transient) return first.answer
        const second = await this.ask(program, env)
        const kept = !second.transient || second.transient === first.transient
        if (!kept && this.answers.get(key) === asked) this.answers.delete(key)
        return second.answer
      })
      answer = asked
      this.answers.set(key, answer)
    }
    return answer
  }

  /** The answer, and how it failed when asking again might well answer otherwise. */
  private async ask(
    program: string,
    env: Env,
  ): Promise<{ answer: CliVersion; transient: 'timeout' | 'start' | 'signal' | null }> {
    const timeoutMs = this.options.timeoutMs ?? 10_000
    const name = path.basename(program).replace(/\.(?:exe|com)$/i, '')
    const result = await (this.options.run ?? runProgram)({
      program,
      args: ['--version'],
      cwd: os.homedir(),
      env,
      platform: this.options.platform,
      timeoutMs,
    })
    const failure = programFailure(name, result, timeoutMs)
    const transient = result.timedOut
      ? 'timeout'
      : result.error
        ? 'start'
        : result.signal || result.aborted
          ? 'signal'
          : null
    if (failure) return { answer: { error: failure }, transient }
    const version = parseCliVersion(result.stdout)
    const answer = version ? { version } : { error: `${name} --version printed no version.` }
    return { answer, transient: null }
  }
}

export interface FoundCli {
  installed: InstalledCli
  /** What the launch passes besides the variable. */
  env: Record<string, string>
}

export interface FindCliContext {
  platform: Platform
  env: Env
  isExecutable(file: string): Promise<boolean>
  files: CliFiles
  probe: CliProbe
}

function answered(
  found: Pick<InstalledCli, 'path' | 'variable'>,
  answer: CliVersion | null,
): InstalledCli {
  if (answer && 'error' in answer) {
    return { ...found, version: null, problem: { kind: 'failed', reason: answer.error } }
  }
  return { ...found, version: answer?.version ?? null, problem: null }
}

/** The user's CLI as the adapter would run it, with its version or why it cannot run. */
export async function findInstalledCli(
  cli: AdapterCli,
  ctx: FindCliContext,
): Promise<FoundCli | null> {
  const named = getEnv(ctx.env, cli.variable, ctx.platform)?.trim()
  if (named) {
    // A `.cmd` would need a shell to ask; the adapter still runs it as it likes.
    const answer = needsShell(named, ctx.platform) ? null : await ctx.probe(named, ctx.env)
    return { installed: answered({ path: named, variable: cli.variable }, answer), env: {} }
  }
  const found = await findCommand(cli.command, ctx)
  if (!found) return null
  const resolved = await cli.resolve(found, ctx.platform, ctx.files)
  if (!resolved) {
    return {
      installed: { path: found, version: null, variable: null, problem: { kind: 'unsupported' } },
      env: {},
    }
  }
  const answer = await ctx.probe(resolved.path, { ...ctx.env, ...resolved.env })
  return { installed: answered({ path: resolved.path, variable: null }, answer), env: resolved.env }
}

export interface CliDecision {
  runs: AgentCliSource
  installed: InstalledCli | null
}

/**
 * The installed program runs when the setting allows it, it answered its version, it meets the
 * adapter's minimum and no start with it failed. `minimum` is undefined before the adapter is
 * installed, when it is not known yet.
 */
export function decideCli(input: {
  prefer: AgentCliSource
  found: InstalledCli | null
  minimum: string | null | undefined
  failure: { path: string; reason: string } | null
}): CliDecision {
  const { found, minimum, failure } = input
  if (!found) return { runs: 'bundled', installed: null }
  let problem = found.problem
  if (!problem && failure?.path === found.path) {
    problem = { kind: 'failed', reason: failure.reason }
  }
  if (!problem && found.version && minimum !== undefined) {
    if (minimum === null) problem = { kind: 'no-minimum' }
    else if (compareVersions(found.version, minimum) < 0) problem = { kind: 'too-old', minimum }
  }
  const installed = { ...found, problem }
  // The adapter reads a variable the environment sets, whatever OverBench passes.
  if (found.variable) return { runs: 'installed', installed }
  return { runs: input.prefer === 'installed' && !problem ? 'installed' : 'bundled', installed }
}
