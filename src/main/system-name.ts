import { readFile } from 'node:fs/promises'
import os from 'node:os'
import type { Platform } from '@shared/platform'

/** A `PRETTY_NAME` line's value, quoted or bare. */
function prettyName(text: string): string | null {
  const line = /^PRETTY_NAME=(.*)$/m.exec(text)?.[1]?.trim()
  if (!line) return null
  const quoted = /^(["'])(.*)\1$/.exec(line)
  return (quoted?.[2] ?? line) || null
}

/** The system and its version, as a host lists this computer among its devices. */
export function systemRelease(
  platform: Platform,
  version: string,
  osRelease: string | null,
): string {
  if (platform === 'darwin') return `macOS ${version}`
  if (platform === 'win32') return `Windows ${version}`
  const release = platform === 'linux' && osRelease ? prettyName(osRelease) : null
  // A distribution's name carries its version; the kernel stands in when there is none.
  return release ?? `${platform === 'linux' ? 'Linux' : platform} ${version}`
}

/** The system as a bug report names it: the system and its version, then the architecture. */
export function systemName(
  platform: Platform,
  version: string,
  arch: string,
  osRelease: string | null,
): string {
  return `${systemRelease(platform, version, osRelease)} (${arch})`
}

let osReleaseForRun: Promise<string | null> | null = null

/** The system's name, read once per run: a Linux distribution's name comes from its os-release. */
export async function systemNameForRun(): Promise<string> {
  osReleaseForRun ??= readOsRelease()
  return systemName(
    process.platform,
    process.getSystemVersion(),
    process.arch,
    await osReleaseForRun,
  )
}

/** The system and its version, read once per run like `systemNameForRun`. */
export async function systemReleaseForRun(): Promise<string> {
  osReleaseForRun ??= readOsRelease()
  return systemRelease(process.platform, process.getSystemVersion(), await osReleaseForRun)
}

/** The macOS version in a SystemVersion.plist, or null when it names none. */
export function productVersion(plist: string): string | null {
  return /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() || null
}

/**
 * `systemNameForRun` under Node.js, which has no `process.getSystemVersion`: macOS's version from
 * its SystemVersion.plist, and the kernel's elsewhere, where a distribution names its own.
 */
export async function nodeSystemNameForRun(): Promise<string> {
  osReleaseForRun ??= readOsRelease()
  const plist =
    process.platform === 'darwin'
      ? await readFile('/System/Library/CoreServices/SystemVersion.plist', 'utf8').catch(() => '')
      : ''
  const version = productVersion(plist) ?? os.release()
  return systemName(process.platform, version, process.arch, await osReleaseForRun)
}

async function readOsRelease(): Promise<string | null> {
  let osRelease: string | null = null
  if (process.platform === 'linux') {
    for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
      try {
        osRelease = await readFile(path, 'utf8')
        break
      } catch {
        // The next location, or the kernel's version.
      }
    }
  }
  return osRelease
}
