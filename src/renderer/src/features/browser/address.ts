// What the address field accepts. A bare address gets https, except on a local dev host, which
// gets http; a scheme the browser never opens is refused.

const NEVER = /^(file|javascript|data|blob|chrome|devtools|view-source|about):/i
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** Hosts a project's dev server runs on, which the pane opens over plain http. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test')
  )
}

function hostOf(address: string): string {
  const authority = address.split(/[/?#]/, 1)[0] ?? ''
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    return end === -1 ? authority : authority.slice(0, end + 1)
  }
  return authority.split(':')[0] ?? ''
}

/** The address to load for what the user typed, or null when it is not an address. */
export function normalizeAddress(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  if (NEVER.test(text)) return null
  const explicit = SCHEME.test(text)
  if (explicit) return parse(text)
  const scheme = isLocalHost(hostOf(text)) ? 'http://' : 'https://'
  return parse(scheme + text)
}

function parse(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname) return null
    return parsed.href
  } catch {
    return null
  }
}

/** The address as the field shows it, without its scheme: "example.com/a?b=1". */
export function addressText(url: string): string | null {
  const parts = addressParts(url)
  return parts ? parts.host + parts.rest : null
}

/** The host, which the field draws in the primary color, and everything after it. */
export function addressParts(url: string): { host: string; rest: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return { host: parsed.host, rest: `${parsed.pathname}${parsed.search}${parsed.hash}` }
  } catch {
    return null
  }
}
