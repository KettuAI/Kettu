/** The values of Node.js's `process.platform`, usable where Node.js types are not. */
export type Platform =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32'

/** System logo family derived from a host or device platform string. */
export type PlatformFamily = 'apple' | 'windows' | 'linux' | 'android'

const OS_NAMES: Readonly<Record<string, string>> = {
  ios: 'iOS',
  ipados: 'iPadOS',
  android: 'Android',
  darwin: 'macOS',
  macos: 'macOS',
  win32: 'Windows',
  windows: 'Windows',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  cros: 'ChromeOS',
  web: 'Web',
}

// Earlier web clients sent hardware labels ("Mac", "iPhone", "iPad") instead of OS names.
// Only normalize them when standalone so values like "Mac OS X" or "iPhone 17" stay intact.
const LEGACY_EXACT_NAMES: Readonly<Record<string, string>> = {
  iphone: 'iOS',
  ipad: 'iPadOS',
  mac: 'macOS',
}

const LINUX_DISTROS: ReadonlySet<string> = new Set([
  'alpine',
  'almalinux',
  'arch',
  'bazzite',
  'cachyos',
  'centos',
  'debian',
  'deepin',
  'elementary',
  'endeavouros',
  'fedora',
  'garuda',
  'gentoo',
  'kali',
  'kubuntu',
  'lubuntu',
  'mageia',
  'manjaro',
  'mint',
  'nixos',
  'nobara',
  'opensuse',
  'pop!_os',
  'raspbian',
  'rhel',
  'rocky',
  'slackware',
  'solus',
  'steamos',
  'suse',
  'ubuntu',
  'void',
  'xubuntu',
  'zorin',
])

/**
 * Human-readable OS name for a host or device platform value, keeping any OS version.
 * Handles canonical values ("macOS 27.0.1", "iOS 26.1", "Android 15", "Web") as well as
 * raw `process.platform` and legacy client values ("ios", "android 15", "darwin", "Mac").
 */
export function platformName(platform: Platform | string): string {
  const trimmed = platform.trim()
  if (trimmed === '') return ''
  const match = /^(\S+)(?:\s+(.+))?$/.exec(trimmed)
  if (!match) return trimmed
  const head = match[1]!.toLowerCase()
  const rest = match[2]?.trim() ?? ''
  const named = OS_NAMES[head]
  if (named) return rest ? `${named} ${rest}` : named
  if (!rest) {
    const legacy = LEGACY_EXACT_NAMES[head]
    if (legacy) return legacy
  }
  return trimmed
}

/** The logo family a host or device platform names, or null when none applies. */
export function platformFamily(platform: Platform | string): PlatformFamily | null {
  const canonical = platformName(platform)
  if (canonical === '') return null
  const lower = canonical.toLowerCase()
  const head = lower.split(/\s+/, 1)[0] ?? ''
  if (head === 'ios' || head === 'ipados' || head === 'macos' || lower.startsWith('mac os')) {
    return 'apple'
  }
  if (head === 'windows') return 'windows'
  if (head === 'android') return 'android'
  if (
    head === 'linux' ||
    /\blinux\b/.test(lower) ||
    lower.startsWith('red hat') ||
    LINUX_DISTROS.has(head)
  ) {
    return 'linux'
  }
  return null
}
