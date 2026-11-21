// The CLI the user installed (Claude Code's, Codex's, Antigravity's `agy`, or the command of an npm
// package harness): found on PATH, resolved to a file that starts without a shell, asked its
// version and held against the oldest that runs.

import { open, readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { InstalledCli } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { programFailure, runProgram, type ProgramOptions, type ProgramRun } from './adapter-install'
import { codexBinary, npmCodexEnv } from './codex-binary'
import { findCommand, findCommands, getEnv, needsShell, type Env } from './find-command'
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
  /** The program that runs `path`, a script, such as Node.js; none when `path` runs by itself. */
  runner?: string
}

/** The user's CLI a harness runs: passed to its SDK, or run itself. */
export interface AdapterCli {
  /** The command the user's CLI answers to on PATH. */
  command: string
  /**
   * The variable that names the program, which the user's environment may set to decide alone;
   * none for a CLI whose vendor has no such variable.
   */
  variable?: string
  /**
   * Where its vendor's installer puts it, looked in after PATH, as for an install the shell
   * profiles add to PATH only in new shells.
   */
  installedAt?(env: Env, platform: Platform): string[]
  /**
   * The SDK pins one CLI version exactly, so the CLI version an update check finds for a new SDK
   * is also the oldest that SDK runs.
   */
  pinsVersion: boolean
  /**
   * The file that runs without a shell, or null when there is none. `node` is the user's Node.js,
   * for a script that runs on it.
   */
  resolve(
    found: string,
    platform: Platform,
    files: CliFiles,
    node: string | null,
  ): Promise<ResolvedCli | null>
  /** The oldest CLI the SDK installed in `dir` runs, or null when it names none. */
  minimum?(dir: string, adapterPackage: string, files: CliFiles): Promise<string | null>
  /** The oldest version that runs, for a harness that runs the CLI itself. */
  oldest?: string
}

const VERSION_TEXT = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`
const FIRST_VERSION = new RegExp(String.raw`\bv?(${VERSION_TEXT})`)
const EXACT_VERSION = new RegExp(`^${VERSION_TEXT}$`)

/** The first `x.y.z` in what `--version` printed, with or without a leading `v`. */
export function parseCliVersion(output: string): string | null {
  return FIRST_VERSION.exec(output)?.[1] ?? null
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

/** `~/.local/bin/<command>` off Windows, from the home folder the environment names. */
function localBin(env: Env, platform: Platform, command: string): string {
  const home = getEnv(env, 'HOME', platform) ?? os.homedir()
  return path.posix.join(home, '.local', 'bin', command)
}

// Its install script puts `claude` in `~/.local/bin`, or `%USERPROFILE%\.local\bin` on Windows.
export const CLAUDE_CLI: AdapterCli = {
  command: 'claude',
  variable: 'CLAUDE_CODE_EXECUTABLE',
  pinsVersion: true,
  installedAt: (env, platform) => {
    if (platform !== 'win32') return [localBin(env, platform, 'claude')]
    const profile = getEnv(env, 'USERPROFILE', platform)
    return profile ? [path.win32.join(profile, '.local', 'bin', 'claude')] : []
  },
  // The SDK spawns it as a program, so on Windows it must be one itself.
  resolve: async (found, platform, files) => {
    const file = await startable(found, platform, files)
    return file && (platform !== 'win32' || isWindowsProgram(file)) ? { path: file, env: {} } : null
  },
  // The SDK names the one CLI it was built against.
  minimum: async (dir, _adapterPackage, files) => {
    const sdk = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')
    const version = (await readManifest(files, sdk))?.claudeCodeVersion
    return typeof version === 'string' && EXACT_VERSION.test(version) ? version : null
  },
}

// Its install scripts put `codex` in `~/.local/bin` by default, and in
// `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` on Windows.
export const CODEX_CLI: AdapterCli = {
  command: 'codex',
  variable: 'CODEX_PATH',
  pinsVersion: false,
  // The app-server protocol the mapping is written against.
  oldest: '0.166.0',
  installedAt: (env, platform) => {
    if (platform !== 'win32') return [localBin(env, platform, 'codex')]
    const local = getEnv(env, 'LOCALAPPDATA', platform)
    return local ? [path.win32.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex')] : []
  },
  resolve: async (found, platform, files) => {
    const file = await startable(found, platform, files)
    if (!file) return null
    // npm's codex.js only finds the platform's binary and starts it, so Kettu runs that.
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
}

// The Antigravity CLI's own ACP mode, `agy acp`. Its installer puts `agy` in `~/.local/bin`, or in
// `%LOCALAPPDATA%\agy\bin` on Windows, and adds that folder to PATH in the shell profiles.
export const AGY_CLI: AdapterCli = {
  command: 'agy',
  pinsVersion: false,
  // The version whose ACP mode was checked: session folders, sign-in, options and MCP.
  oldest: '1.5.9',
  resolve: async (found, platform, files) => {
    const file = await startable(found, platform, files)
    return file && (platform !== 'win32' || isWindowsProgram(file)) ? { path: file, env: {} } : null
  },
  installedAt: (env, platform) => {
    if (platform === 'win32') {
      const local = getEnv(env, 'LOCALAPPDATA', platform)
      return local ? [path.win32.join(local, 'agy', 'bin', 'agy')] : []
    }
    return [localBin(env, platform, 'agy')]
  },
}

// OpenCode 2, which Kettu reads providers and accounts from through its native API; OpenCode 1
// has none of it. The oldest is the version that was checked. The program runs as found, a `.cmd`
// shim on Windows included, since Kettu starts it through the shell as it always did.
export const OPENCODE_CLI: AdapterCli = {
  command: 'opencode',
  pinsVersion: false,
  oldest: '2.0.32',
  resolve: async (found) => ({ path: found, env: {} }),
  // Its install script adds the folder to PATH in the shell profiles, which only new shells read.
  installedAt: (env, platform) => {
    if (platform === 'win32') return []
    const home = getEnv(env, 'HOME', platform) ?? os.homedir()
    return [path.posix.join(home, '.opencode', 'bin', 'opencode')]
  },
}

/**
 * The user's own install of the command an npm package harness publishes, such as DeepSeek
 * Harness's `dsh`: off Windows as found, which runs by its shebang. On Windows an `.exe`, or the
 * file an npm or pnpm shim starts, a script running on the Node.js beside the shim as the shim
 * would, else on the user's. `installedAt` is where its vendor's installer puts it off Windows,
 * from the home folder.
 */
export function packageCli(command: string, installedAt: readonly string[] = []): AdapterCli {
  return {
    command,
    pinsVersion: false,
    resolve: async (found, platform, files, node) => {
      const file = await startable(found, platform, files)
      if (!file || platform !== 'win32' || isWindowsProgram(file)) {
        return file ? { path: file, env: {} } : null
      }
      const beside = path.win32.join(path.win32.dirname(found), 'node.exe')
      const runner = (await files.isFile(beside)) ? beside : node
      return runner ? { path: file, env: {}, runner } : null
    },
    ...(installedAt.length > 0
      ? {
          installedAt: (env: Env, platform: Platform) => {
            if (platform === 'win32') return []
            const home = getEnv(env, 'HOME', platform) ?? os.homedir()
            return installedAt.map((file) => path.posix.join(home, file))
          },
        }
      : {}),
  }
}

export type CliVersion = { version: string } | { error: string }
/** Asks `<program> <words> --version`; `words` name the script a runner such as Node.js runs. */
export type CliProbe = (program: string, env: Env, words?: readonly string[]) => Promise<CliVersion>

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

  async probe(program: string, env: Env, words: readonly string[] = []): Promise<CliVersion> {
    // A script changes, not the runner that runs it.
    const file = words.at(-1) ?? program
    const info = await (this.options.stat ?? ((file) => stat(file).catch(() => null)))(file)
    if (!info) return { error: `${file} was not found.` }
    const key = [program, ...words, info.size, info.mtimeMs].join('\0')
    let answer = this.answers.get(key)
    if (!answer) {
      const asked: Promise<CliVersion> = this.ask(program, words, env).then(async (first) => {
        if (!first.transient) return first.answer
        const second = await this.ask(program, words, env)
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
    words: readonly string[],
    env: Env,
  ): Promise<{ answer: CliVersion; transient: 'timeout' | 'start' | 'signal' | null }> {
    const timeoutMs = this.options.timeoutMs ?? 10_000
    const name = path.basename(words.at(-1) ?? program).replace(/\.(?:exe|com)$/i, '')
    const result = await (this.options.run ?? runProgram)({
      program,
      args: [...words, '--version'],
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
  /** The program that runs the CLI, a script, such as Node.js. */
  runner?: string
}

export interface FindCliContext {
  platform: Platform
  env: Env
  /** The program picked in Settings, which stands in for the one on PATH. */
  binaryOverride?: string | null
  /** The user's Node.js, which runs a script the CLI resolves to. */
  node?: { nodePath: string | null }
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

/** The programs of the CLI's command: each on PATH in order, then where its installer puts it. */
async function* candidates(cli: AdapterCli, ctx: FindCliContext): AsyncGenerator<string> {
  yield* findCommands(cli.command, ctx)
  for (const file of cli.installedAt?.(ctx.env, ctx.platform) ?? []) {
    const found = await findCommand(file, ctx)
    if (found) yield found
  }
}

/**
 * The user's CLI as the adapter would run it, with its version or why it cannot run. The program
 * the environment names or the one picked in Settings is the only one; otherwise the first program
 * found that is `usable`, by default one whose version it says, else the first found, which says
 * why none runs. Programs after the first usable one are never asked.
 */
export async function findInstalledCli(
  cli: AdapterCli,
  ctx: FindCliContext,
  usable: (found: FoundCli) => boolean | Promise<boolean> = (found) => !found.installed.problem,
): Promise<FoundCli | null> {
  const named = cli.variable ? getEnv(ctx.env, cli.variable, ctx.platform)?.trim() : undefined
  if (cli.variable && named) {
    // A `.cmd` would need a shell to ask; the adapter still runs it as it likes.
    const answer = needsShell(named, ctx.platform) ? null : await ctx.probe(named, ctx.env)
    return { installed: answered({ path: named, variable: cli.variable }, answer), env: {} }
  }
  const chosen = ctx.binaryOverride
  if (chosen) {
    const found = await findCommand(chosen, ctx)
    return found ? askCli(cli, found, ctx) : null
  }
  const seen = new Set<string>()
  let first: FoundCli | null = null
  for await (const found of candidates(cli, ctx)) {
    const key = ctx.platform === 'win32' ? found.toLowerCase() : found
    if (seen.has(key)) continue
    seen.add(key)
    const asked = await askCli(cli, found, ctx)
    if (await usable(asked)) return asked
    first ??= asked
  }
  return first
}

/** The program found as the adapter would run it, asked its version. */
async function askCli(cli: AdapterCli, found: string, ctx: FindCliContext): Promise<FoundCli> {
  const resolved = await cli.resolve(found, ctx.platform, ctx.files, ctx.node?.nodePath ?? null)
  if (!resolved) {
    return {
      installed: { path: found, version: null, variable: null, problem: { kind: 'unsupported' } },
      env: {},
    }
  }
  const { runner } = resolved
  const env = { ...ctx.env, ...resolved.env }
  const answer = runner
    ? await ctx.probe(runner, env, [resolved.path])
    : await ctx.probe(resolved.path, env)
  return {
    installed: answered({ path: resolved.path, variable: null }, answer),
    env: resolved.env,
    ...(runner ? { runner } : {}),
  }
}

/**
 * The user's CLI with why it cannot run: its own problem, or a version below `minimum`. `minimum` is
 * unknown (null or undefined) before the SDK that names it is installed, or when it names none.
 */
export function checkCli(found: InstalledCli, minimum: string | null | undefined): InstalledCli {
  if (found.problem || !found.version || minimum == null) return found
  if (compareVersions(found.version, minimum) < 0) {
    return { ...found, problem: { kind: 'too-old', minimum } }
  }
  return found
}
