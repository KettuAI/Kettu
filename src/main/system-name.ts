import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { platformName, type Platform } from '@shared/platform'
import { MAX_DEVICE_FIELD } from '@shared/remote/device'

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
  const trimmed = version.trim()
  if (platform === 'darwin') return trimmed ? `macOS ${trimmed}` : 'macOS'
  if (platform === 'win32') return trimmed ? `Windows ${trimmed}` : 'Windows'
  const release = platform === 'linux' && osRelease ? prettyName(osRelease) : null
  // A distribution's name carries its version; the kernel stands in when there is none.
  if (release) return release
  const name = platform === 'linux' ? 'Linux' : platform
  return trimmed ? `${name} ${trimmed}` : name
}

/**
 * The canonical device platform sent in hello and pairing requests: `systemRelease`, normalized
 * and capped to `MAX_DEVICE_FIELD` so long Linux `PRETTY_NAME` values still pass validation.
 */
export function devicePlatform(
  platform: Platform,
  version: string,
  osRelease: string | null,
): string {
  const formatted = platformName(systemRelease(platform, version, osRelease))
  const capped = formatted.slice(0, MAX_DEVICE_FIELD).trim()
  return capped || platformName(platform) || platform
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

/** The canonical device platform for this run, read once per run like `systemReleaseForRun`. */
export async function devicePlatformForRun(): Promise<string> {
  osReleaseForRun ??= readOsRelease()
  return devicePlatform(process.platform, process.getSystemVersion(), await osReleaseForRun)
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
  return systemName(
    process.platform,
    await nodeSystemVersion(),
    process.arch,
    await osReleaseForRun,
  )
}

/** `systemReleaseForRun` under Node.js, read the same way as `nodeSystemNameForRun`. */
export async function nodeSystemReleaseForRun(): Promise<string> {
  osReleaseForRun ??= readOsRelease()
  return systemRelease(process.platform, await nodeSystemVersion(), await osReleaseForRun)
}

async function nodeSystemVersion(): Promise<string> {
  const plist =
    process.platform === 'darwin'
      ? await readFile('/System/Library/CoreServices/SystemVersion.plist', 'utf8').catch(() => '')
      : ''
  return productVersion(plist) ?? os.release()
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
