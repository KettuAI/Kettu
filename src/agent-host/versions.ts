// Semantic versions in npm's order, for the adapter and CLI versions the registry reports.

interface Version {
  major: number
  minor: number
  patch: number
  prerelease: (string | number)[]
}

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text)
  if (!match) return null
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  const prerelease = match[4]
    ? match[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : []
  if (prerelease.some((id) => typeof id === 'number' && !Number.isSafeInteger(id))) return null
  return { major, minor, patch, prerelease }
}

/** A plain `1.2.3` or `1.2.3-beta.1+build` version, nothing a shell could read more into. */
export function isVersion(text: unknown): text is string {
  return typeof text === 'string' && text.length <= 256 && parseVersion(text) !== null
}

function comparePrerelease(a: (string | number)[], b: (string | number)[]): number {
  // A release sorts above its own prereleases.
  if (a.length === 0 || b.length === 0) return b.length - a.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Below, at or above zero as `a` is older, the same or newer; non-versions count as oldest. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  return (
    x.major - y.major ||
    x.minor - y.minor ||
    x.patch - y.patch ||
    comparePrerelease(x.prerelease, y.prerelease)
  )
}

/**
 * Whether `version` is `checked` or newer. A version that is not semver, such as Junie's
 * `26.10.27 (3893.5)`, compares by its numbers in order; with none, only the same text holds.
 */
export function versionAtLeast(version: string | null | undefined, checked: string): boolean {
  if (!version) return false
  if (version === checked) return true
  if (isVersion(version) && isVersion(checked)) return compareVersions(version, checked) >= 0
  const numbers = (text: string): number[] => (text.match(/\d+/g) ?? []).map(Number)
  const a = numbers(version)
  const b = numbers(checked)
  if (a.length === 0 || b.length === 0) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/** The newest version in what `npm view --json` printed: one string, or an array of them. */
export function highestVersion(value: unknown): string | null {
  const candidates = Array.isArray(value) ? value : [value]
  let best: string | null = null
  for (const candidate of candidates) {
    if (isVersion(candidate) && (best === null || compareVersions(candidate, best) > 0)) {
      best = candidate
    }
  }
  return best
}
