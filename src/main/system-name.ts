import { readFile } from 'node:fs/promises'
import type { Platform } from '@shared/platform'

/** A `PRETTY_NAME` line's value, quoted or bare. */
function prettyName(text: string): string | null {
  const line = /^PRETTY_NAME=(.*)$/m.exec(text)?.[1]?.trim()
  if (!line) return null
  const quoted = /^(["'])(.*)\1$/.exec(line)
  return (quoted?.[2] ?? line) || null
}

/** The system as a bug report names it: the system and its version, then the architecture. */
export function systemName(
  platform: Platform,
  version: string,
  arch: string,
  osRelease: string | null,
): string {
  let system: string
  if (platform === 'darwin') {
    system = `macOS ${version}`
  } else if (platform === 'win32') {
    system = `Windows ${version}`
  } else {
    const release = platform === 'linux' && osRelease ? prettyName(osRelease) : null
    // A distribution's name carries its version; the kernel stands in when there is none.
    system = release ?? `${platform === 'linux' ? 'Linux' : platform} ${version}`
  }
  return `${system} (${arch})`
}

let forRun: Promise<string> | null = null

/** The system's name, read once per run: a Linux distribution's name comes from its os-release. */
export function systemNameForRun(): Promise<string> {
  forRun ??= readSystemName()
  return forRun
}

async function readSystemName(): Promise<string> {
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
  return systemName(process.platform, process.getSystemVersion(), process.arch, osRelease)
}
