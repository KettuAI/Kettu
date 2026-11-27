import { spawn, type ChildProcess } from 'node:child_process'
import { access, constants, lstat, readlink, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { withLongPaths } from '@shared/git'
import type { Platform } from '@shared/platform'

export interface ShellSpec {
  file: string
  args: string[]
  name: string // the program name, such as "zsh" or "pwsh"
}

export type Environment = Record<string, string | undefined>

/** Finds a program on PATH, returning its full path; injected so tests need no real PATH. */
export type FindOnPath = (program: string) => Promise<string | null>

export type ShellLogLevel = 'info' | 'warn'

export type ShellLog = (
  level: ShellLogLevel,
  message: string,
  data?: Record<string, unknown>,
) => void

export interface FileStatsLike {
  isFile(): boolean
  isSymbolicLink(): boolean
  isDirectory(): boolean
  size?: number
}

export interface AliasProbeResult {
  ok: boolean
  detail?: string
  reason?: string
}

export type ProbeWindowsAlias = (candidate: string, program: string) => Promise<AliasProbeResult>

export interface PathLookupOptions {
  stat?: (path: string) => Promise<Pick<FileStatsLike, 'isFile' | 'size'>>
  lstat?: (path: string) => Promise<FileStatsLike>
  access?: (path: string, mode?: number) => Promise<void>
  readlink?: (path: string) => Promise<string>
  probeAlias?: ProbeWindowsAlias
  log?: ShellLog
}

export interface ProbeWindowsAliasOptions {
  timeoutMs?: number
  readlink?: (path: string) => Promise<string>
  spawn?: (
    file: string,
    args: string[],
    options: { stdio: ['ignore', 'pipe', 'pipe']; windowsHide: true },
  ) => Pick<ChildProcess, 'stdout' | 'stderr' | 'once' | 'kill'>
}

// Error codes Node.js/libuv surfaces when stat() follows a Windows App Execution Alias
// (IO_REPARSE_TAG_APPEXECLINK) whose target lives under ACL-protected WindowsApps storage.
const WINDOWS_ALIAS_STAT_ERRORS = new Set([
  'EACCES',
  'EPERM',
  'EISDIR',
  'UNKNOWN',
  'EINVAL',
  'ENOSYS',
])

const ALIAS_PROBE_TIMEOUT_MS = 3000
const ALIAS_PROBE_MAX_BYTES = 4096
const WINDOWS_STORE_REDIRECTOR_RE = /(?:^|[\\/])AppInstaller[^\\/]*Redirector\.exe$/i
const PWSH_NAME_RE = /^pwsh(?:-preview)?$/i

function pathFor(platform: Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const { code } = error as { code: unknown }
  return typeof code === 'string' ? code : undefined
}

function appendBounded(current: string, chunk: Buffer | string): string {
  if (current.length >= ALIAS_PROBE_MAX_BYTES) return current
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  return (current + text).slice(0, ALIAS_PROBE_MAX_BYTES)
}

function summarizeOutput(text: string): string {
  const compact = text.trim().replace(/\s+/g, ' ')
  return compact.length > 160 ? `${compact.slice(0, 160)}...` : compact
}

/** Reads an environment variable the way the platform does: case-insensitively on Windows. */
export function readEnv(env: Environment, key: string, platform: Platform): string | undefined {
  if (platform !== 'win32') return env[key]
  const match = Object.keys(env).find((name) => name.toUpperCase() === key.toUpperCase())
  return match === undefined ? undefined : env[match]
}

export function programName(file: string, platform: Platform): string {
  const base = pathFor(platform).basename(file)
  return platform === 'win32' ? base.replace(/\.(exe|com|cmd|bat)$/i, '') : base
}

/**
 * Whether `candidate` sits in a Windows App Execution Alias location: a `.exe` directly inside
 * `WindowsApps` or one package folder beneath it (`%LOCALAPPDATA%\Microsoft\WindowsApps`).
 */
export function isWindowsAppExecutionAliasPath(candidate: string): boolean {
  if (win32.extname(candidate).toLowerCase() !== '.exe') return false
  const segments = win32
    .dirname(candidate)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
  const parent = segments.at(-1)?.toLowerCase()
  const grandParent = segments.at(-2)?.toLowerCase()
  return parent === 'windowsapps' || grandParent === 'windowsapps'
}

/**
 * Verifies a Windows App Execution Alias is runnable without triggering a Microsoft Store prompt
 * or hanging. Passing `--version` avoids Store redirector UI (which only opens on zero arguments)
 * and exits immediately on PowerShell 7 without loading user profiles.
 */
export async function probeWindowsAppExecutionAlias(
  candidate: string,
  program: string,
  options: ProbeWindowsAliasOptions = {},
): Promise<AliasProbeResult> {
  const readlinkFn = options.readlink ?? readlink
  const target = await readlinkFn(candidate).catch(() => null)
  if (target && WINDOWS_STORE_REDIRECTOR_RE.test(target)) {
    return { ok: false, reason: 'Windows Store install redirector stub' }
  }

  const spawnFn = options.spawn ?? spawn
  const timeoutMs = options.timeoutMs ?? ALIAS_PROBE_TIMEOUT_MS
  const expectsPowerShell = PWSH_NAME_RE.test(programName(program || candidate, 'win32'))

  return new Promise<AliasProbeResult>((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child: Pick<ChildProcess, 'stdout' | 'stderr' | 'once' | 'kill'> | null = null
    let timer: NodeJS.Timeout | null = null

    const finish = (result: AliasProbeResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      timer = null
      resolve(result)
    }

    try {
      child = spawnFn(candidate, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, reason: (error as Error).message })
      return
    }

    timer = setTimeout(() => {
      try {
        child?.kill()
      } catch {
        // Ignore kill failures on already-exited processes.
      }
      finish({ ok: false, reason: `probe timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, chunk)
    })
    child.once('error', (error: Error) => {
      finish({ ok: false, reason: error.message })
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const out = summarizeOutput(stdout)
      const err = summarizeOutput(stderr)
      if (code === 0) {
        if (expectsPowerShell && !/\bPowerShell\b/i.test(out)) {
          finish({
            ok: false,
            reason: out ? `unexpected version output: ${out}` : 'empty version output',
          })
          return
        }
        finish({ ok: true, ...(out ? { detail: out } : {}) })
        return
      }
      const status = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      const detail = err || out
      finish({ ok: false, reason: detail ? `${status}: ${detail}` : status })
    })
  })
}

/**
 * The shell a new terminal runs: the program picked in Settings, else `$SHELL` as a login shell
 * on macOS and Linux, else pwsh when it is on PATH and Windows PowerShell otherwise.
 */
export async function resolveShell(
  platform: Platform,
  env: Environment,
  override: string | null,
  findOnPath: FindOnPath,
  log?: ShellLog,
): Promise<ShellSpec> {
  const loginArgs = platform === 'win32' ? [] : ['-l']
  if (override) return { file: override, args: loginArgs, name: programName(override, platform) }
  if (platform === 'win32') {
    const pwsh = await findOnPath('pwsh.exe')
    if (pwsh) {
      log?.('info', 'Resolved Windows default shell to pwsh.exe', { file: pwsh })
      return { file: pwsh, args: [], name: programName(pwsh, platform) }
    }
    const systemRoot = readEnv(env, 'SystemRoot', platform) ?? 'C:\\Windows'
    const file = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    log?.('info', 'Falling back to Windows PowerShell 5.1: pwsh.exe was not found on PATH', {
      file,
    })
    return { file, args: [], name: programName(file, platform) }
  }
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const shell = env.SHELL && posix.isAbsolute(env.SHELL) ? env.SHELL : fallback
  return { file: shell, args: loginArgs, name: programName(shell, platform) }
}

async function verifyWindowsAlias(
  candidate: string,
  program: string,
  statCode: string,
  probeAlias: ProbeWindowsAlias,
  log?: ShellLog,
): Promise<boolean> {
  const result: AliasProbeResult = await probeAlias(candidate, program).catch((error: unknown) => ({
    ok: false,
    reason: (error as Error).message,
  }))
  if (result.ok) {
    log?.('info', 'Verified Windows App Execution Alias', {
      candidate,
      statCode,
      ...(result.detail ? { detail: result.detail } : {}),
    })
    return true
  }
  log?.('warn', 'Skipped unusable Windows App Execution Alias', {
    candidate,
    statCode,
    reason: result.reason ?? 'probe failed',
  })
  return false
}

async function isRunnableCandidate(
  candidate: string,
  program: string,
  platform: Platform,
  options: PathLookupOptions,
): Promise<boolean> {
  const statFn = options.stat ?? stat
  const accessFn = options.access ?? access
  const lstatFn = options.lstat ?? lstat
  const probeAlias: ProbeWindowsAlias =
    options.probeAlias ??
    ((file, name) =>
      probeWindowsAppExecutionAlias(file, name, {
        ...(options.readlink ? { readlink: options.readlink } : {}),
      }))
  const { log } = options

  if (platform !== 'win32') {
    try {
      if (!(await statFn(candidate)).isFile()) return false
      await accessFn(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  let statError: unknown
  try {
    const info = await statFn(candidate)
    if (!info.isFile()) return false
    // A 0-byte .exe under WindowsApps is either an App Execution Alias surfaced by stat or a
    // placeholder/broken stub; probe it before accepting.
    if (info.size === 0 && isWindowsAppExecutionAliasPath(candidate)) {
      return await verifyWindowsAlias(candidate, program, 'stat-zero-byte', probeAlias, log)
    }
    return true
  } catch (error) {
    statError = error
  }

  const code = errorCode(statError)
  if (!code || !WINDOWS_ALIAS_STAT_ERRORS.has(code)) return false

  if (!isWindowsAppExecutionAliasPath(candidate)) {
    log?.('warn', 'Skipped unreadable Windows PATH candidate', { candidate, statCode: code })
    return false
  }

  let linkInfo: FileStatsLike
  try {
    linkInfo = await lstatFn(candidate)
  } catch (error) {
    log?.('warn', 'Skipped WindowsApps candidate: lstat failed', {
      candidate,
      statCode: code,
      lstatCode: errorCode(error) ?? (error as Error).message,
    })
    return false
  }

  if (linkInfo.isDirectory() || !linkInfo.isSymbolicLink()) {
    log?.('warn', 'Skipped WindowsApps candidate: not an App Execution Alias reparse point', {
      candidate,
      statCode: code,
      isDirectory: linkInfo.isDirectory(),
      isSymbolicLink: linkInfo.isSymbolicLink(),
    })
    return false
  }

  return await verifyWindowsAlias(candidate, program, code, probeAlias, log)
}

/**
 * Looks a program up on PATH as the platform's shell would. On Windows, handles Microsoft Store
 * App Execution Aliases whose `stat()` fails with EACCES by inspecting `lstat()` and verifying
 * the alias is runnable before returning it.
 */
export function pathLookup(
  env: Environment,
  platform: Platform,
  options: PathLookupOptions = {},
): FindOnPath {
  const path = pathFor(platform)
  const entries = (readEnv(env, 'PATH', platform) ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
  return async (program) => {
    for (const entry of entries) {
      const candidate = path.join(entry, program)
      if (await isRunnableCandidate(candidate, program, platform, options)) return candidate
    }
    return null
  }
}

/**
 * The environment of a shell: main's own without Electron's variables, plus what terminal
 * programs look for. LANG is set on macOS when unset, as it is for apps started from the Dock,
 * so programs print UTF-8.
 */
export function shellEnvironment(
  base: Environment,
  platform: Platform,
  appVersion: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.toUpperCase().startsWith('ELECTRON_')) continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Kettu'
  env.TERM_PROGRAM_VERSION = appVersion
  if (platform === 'darwin' && !env.LANG) env.LANG = 'en_US.UTF-8'
  return withLongPaths(env, platform)
}
