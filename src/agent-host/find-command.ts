// Finding executables on PATH, the way the platform's shell does, without spawning one.

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'

export type Env = Record<string, string | undefined>

/** Reads an environment variable; names are case-insensitive on Windows. */
export function getEnv(env: Env, name: string, platform: Platform): string | undefined {
  if (platform !== 'win32') return env[name]
  if (env[name] !== undefined) return env[name]
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) return value
  }
  return undefined
}

/** Removes every case variant of a name on Windows, the exact name elsewhere. */
export function deleteEnv(env: Env, name: string, platform: Platform): void {
  if (platform !== 'win32') {
    delete env[name]
    return
  }
  const upper = name.toUpperCase()
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) delete env[key]
  }
}

export function pathEntries(env: Env, platform: Platform): string[] {
  const value = getEnv(env, 'PATH', platform) ?? ''
  const separator = platform === 'win32' ? ';' : ':'
  return value
    .split(separator)
    .map((entry) => (platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry))
    .filter((entry) => entry !== '')
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

function pathExtensions(env: Env): string[] {
  const value = getEnv(env, 'PATHEXT', 'win32') || DEFAULT_PATHEXT
  return value
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.startsWith('.'))
}

/** The names to try for `command` in one directory. */
export function candidateNames(command: string, env: Env, platform: Platform): string[] {
  if (platform !== 'win32') return [command]
  const extensions = pathExtensions(env)
  const ext = path.win32.extname(command).toLowerCase()
  const hasKnownExt = ext !== '' && extensions.some((known) => known.toLowerCase() === ext)
  return hasKnownExt ? [command] : extensions.map((known) => command + known.toLowerCase())
}

export interface FindCommandOptions {
  platform: Platform
  env: Env
  /** Whether a file exists and can be executed; injected so tests run on any OS. */
  isExecutable(file: string): Promise<boolean>
}

/**
 * Resolves a command to an absolute path: a path is checked as is, a bare name is looked
 * up on PATH, trying each PATHEXT extension on Windows. The current directory is never
 * searched, unlike cmd.exe, so a project folder cannot shadow `npx`.
 */
export async function findCommand(
  command: string,
  options: FindCommandOptions,
): Promise<string | null> {
  const { platform, env } = options
  const p = platform === 'win32' ? path.win32 : path.posix
  const names = candidateNames(command, env, platform)
  if (p.isAbsolute(command)) {
    for (const name of names) if (await options.isExecutable(name)) return name
    return null
  }
  if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) return null
  for (const dir of pathEntries(env, platform)) {
    if (!p.isAbsolute(dir)) continue
    for (const name of names) {
      const file = p.join(dir, name)
      if (await options.isExecutable(file)) return file
    }
  }
  return null
}

/** A regular file that the user may execute; on Windows the extension decides, so any file. */
export async function isExecutableFile(file: string, platform: Platform): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false
    if (platform !== 'win32') await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Node.js refuses to spawn these without a shell (CVE-2024-27980). */
export function needsShell(file: string, platform: Platform): boolean {
  if (platform !== 'win32') return false
  const ext = path.win32.extname(file).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}
