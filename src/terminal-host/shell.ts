import { access, constants, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Platform } from '@shared/platform'

export interface ShellSpec {
  file: string
  args: string[]
  name: string // the program name, such as "zsh" or "pwsh"
}

export type Environment = Record<string, string | undefined>

/** Finds a program on PATH, returning its full path; injected so tests need no real PATH. */
export type FindOnPath = (program: string) => Promise<string | null>

function pathFor(platform: Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
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
 * The shell a new terminal runs: the program picked in Settings, else `$SHELL` as a login shell
 * on macOS and Linux, else pwsh when it is on PATH and Windows PowerShell otherwise.
 */
export async function resolveShell(
  platform: Platform,
  env: Environment,
  override: string | null,
  findOnPath: FindOnPath,
): Promise<ShellSpec> {
  const loginArgs = platform === 'win32' ? [] : ['-l']
  if (override) return { file: override, args: loginArgs, name: programName(override, platform) }
  if (platform === 'win32') {
    const pwsh = await findOnPath('pwsh.exe')
    const systemRoot = readEnv(env, 'SystemRoot', platform) ?? 'C:\\Windows'
    const file =
      pwsh ?? win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return { file, args: [], name: programName(file, platform) }
  }
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const shell = env.SHELL && posix.isAbsolute(env.SHELL) ? env.SHELL : fallback
  return { file: shell, args: loginArgs, name: programName(shell, platform) }
}

async function isFile(path: string, platform: Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    if (platform !== 'win32') await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Looks a program up on PATH as the platform's shell would, without running anything. */
export function pathLookup(env: Environment, platform: Platform): FindOnPath {
  const path = pathFor(platform)
  const entries = (readEnv(env, 'PATH', platform) ?? '')
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
  return async (program) => {
    for (const entry of entries) {
      const candidate = path.join(entry, program)
      if (await isFile(candidate, platform)) return candidate
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
  env.TERM_PROGRAM = 'OverBench'
  env.TERM_PROGRAM_VERSION = appVersion
  if (platform === 'darwin' && !env.LANG) env.LANG = 'en_US.UTF-8'
  return env
}
