// What the address field accepts. A bare address gets https, except on a local dev host, which
// gets http; a scheme the browser never opens is refused.

const NEVER = /^(file|javascript|data|blob|chrome|devtools|view-source|about):/i
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const NON_PORT_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d{1,5}(?:[/?#]|$))/i
const IPV4_HOST = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/
const DOMAIN_TLD = /^(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$/i

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

function parseHttpUrl(url: string | null): URL | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname) return null
    return parsed
  } catch {
    return null
  }
}

function parse(url: string): string | null {
  return parseHttpUrl(url)?.href ?? null
}

/** The address as the field shows it, without its scheme: "example.com/a?b=1". */
export function addressText(url: string): string | null {
  const parts = addressParts(url)
  return parts ? parts.host + parts.rest : null
}

/** The host, which the field draws in the primary color, and everything after it. */
export function addressParts(url: string): { host: string; rest: string } | null {
  const parsed = parseHttpUrl(url)
  if (!parsed) return null
  return { host: parsed.host, rest: `${parsed.pathname}${parsed.search}${parsed.hash}` }
}

function hasExplicitScheme(text: string): boolean {
  return SCHEME.test(text) || NEVER.test(text) || NON_PORT_SCHEME.test(text)
}

function isIpv4(hostname: string): boolean {
  if (!IPV4_HOST.test(hostname)) return false
  return hostname.split('.').every((octet) => Number(octet) <= 255)
}

function isUnambiguousBareHost(rawHost: string, parsedHost: string): boolean {
  if (isLocalHost(rawHost)) return true
  if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
    return parsedHost.startsWith('[') && parsedHost.endsWith(']')
  }
  if (isIpv4(rawHost)) return parsedHost === rawHost
  if (!rawHost.includes('.') || rawHost.startsWith('.') || rawHost.endsWith('.')) return false
  if (rawHost.includes('..')) return false
  const tld = parsedHost.split('.').at(-1) ?? ''
  return parsedHost.includes('.') && DOMAIN_TLD.test(tld)
}

export function copiedAddress(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  pageUrl: string | null,
): string | null {
  const end = Math.min(selectionEnd, value.length)
  if (selectionStart !== 0 || end <= 0) return null

  const selected = value.slice(0, end)
  const trimmed = selected.trim()
  if (!trimmed || hasExplicitScheme(trimmed)) return null

  const page = parseHttpUrl(pageUrl)
  if (page) {
    const shown = `${page.host}${page.pathname}${page.search}${page.hash}`
    if (value === shown) {
      if (end < page.host.length) return null
      return `${page.protocol}//${selected}`
    }
  }

  if (end !== value.length) return null
  if (selected !== trimmed) return null
  if (/^[/\\?#@.]/.test(trimmed) || /\s/.test(trimmed)) return null

  const authority = trimmed.split(/[/?#]/, 1)[0] ?? ''
  if (!authority || authority.includes('@')) return null

  const rawHost = hostOf(trimmed)
  if (!rawHost) return null

  if (page && authority.toLowerCase() === page.host) {
    const candidate = parseHttpUrl(`${page.protocol}//${trimmed}`)
    if (candidate && candidate.username === '' && candidate.password === '') {
      return candidate.href
    }
  }

  const parsed = parseHttpUrl(normalizeAddress(trimmed))
  if (!parsed || parsed.username !== '' || parsed.password !== '') return null
  if (!isUnambiguousBareHost(rawHost, parsed.hostname)) return null
  return parsed.href
}

const ESCAPED_NON_ASCII = /(?:%[89a-f][0-9a-f])+/gi
// Controls, format characters such as direction marks, unassigned code points, and spaces.
const HIDDEN = /[\p{C}\p{Z}]/u

/**
 * The path, query and fragment for reading: each run of escaped non-ASCII bytes shown as its
 * characters. Escaped ASCII, a run that is not UTF-8, and hidden characters stay escaped.
 */
export function readableRest(rest: string): string {
  return rest.replace(ESCAPED_NON_ASCII, (run) => {
    let text: string
    try {
      text = decodeURIComponent(run)
    } catch {
      return run
    }
    const shown = Array.from(text, (char) => (HIDDEN.test(char) ? encodeURIComponent(char) : char))
    return shown.join('')
  })
}
