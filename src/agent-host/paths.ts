// Project paths: canonicalization and comparison by the platform's rules.

import path from 'node:path'
import type { Platform } from '@shared/platform'

function api(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

// realpath on Windows can return the extended-length forms; the rest of the app uses plain paths.
function stripWindowsPrefix(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`
  if (value.startsWith('\\\\?\\')) return value.slice(4)
  return value
}

function trimTrailingSeparators(value: string, platform: Platform): string {
  const p = api(platform)
  const root = p.parse(value).root
  let end = value.length
  while (end > root.length && (value[end - 1] === p.sep || value[end - 1] === '/')) end--
  return value.slice(0, end)
}

/**
 * A fully qualified path. On Windows that is a drive path (`C:\x`) or a UNC path; a path
 * rooted without a drive (`\x`) depends on the process's current drive, so it is refused.
 */
export function isAbsolutePath(value: string, platform: Platform): boolean {
  if (platform !== 'win32') return path.posix.isAbsolute(value)
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value)
}

/**
 * The canonical form of an absolute path: resolved, then `realpath` so symlinks, `..` and
 * the on-disk case (on case-insensitive volumes) are settled. Rejects when it does not exist.
 */
export async function canonicalizePath(
  value: string,
  platform: Platform,
  realpath: (value: string) => Promise<string>,
): Promise<string> {
  if (!isAbsolutePath(value, platform)) throw new Error(`Not an absolute path: ${value}`)
  const resolved = api(platform).resolve(value)
  const real = await realpath(resolved)
  return trimTrailingSeparators(platform === 'win32' ? stripWindowsPrefix(real) : real, platform)
}

/**
 * A key that is equal for two canonical paths naming the same folder. Windows compares
 * case-insensitively, including drive letters and UNC hosts; macOS and Linux compare
 * exactly, because `realpath` already returned the on-disk case.
 */
export function pathKey(value: string, platform: Platform): string {
  const p = api(platform)
  if (platform === 'win32') {
    const normalized = p.normalize(stripWindowsPrefix(value).replace(/\//g, '\\'))
    return trimTrailingSeparators(normalized, platform).toLowerCase()
  }
  return trimTrailingSeparators(p.normalize(value), platform)
}

export function samePath(a: string, b: string, platform: Platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform)
}

/** The folder name, used as the project's default name. */
export function folderName(value: string, platform: Platform): string {
  const p = api(platform)
  const base = p.basename(value)
  return base || p.parse(value).root.replace(/[\\/]+$/, '') || value
}
