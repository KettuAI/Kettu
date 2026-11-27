// A remark plugin that turns bare host:port addresses (IPv4, localhost, and bracketed IPv6)
// written in prose into http:// links without touching code, existing links, or invalid addresses.

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** A bare host:port match in plain text and the normalized http:// URL it resolves to. */
export interface BareHostLink {
  from: number
  to: number
  url: string
}

// Nodes whose contents stay literal rather than receiving prose autolinking.
const SKIP = new Set([
  'link',
  'linkReference',
  'inlineCode',
  'code',
  'html',
  'definition',
  'inlineMath',
  'math',
])

// Match IPv4, localhost (including *.localhost), or bracketed IPv6 followed by a port and an
// optional ASCII path/query/hash suffix. Lookbehind rejects schemes (`ws://`, `http:`), paths,
// userinfo (`user@`), dotted continuations (`1.2.3.4.5:80`), and identifier prefixes (`v1.2.3.4`).
// When no suffix follows, lookahead rejects trailing word chars, `@` userinfo tricks, port ranges
// (`:8000-8010`), Docker port mappings (`:8080:80`), and dotted continuations (`:80.1`).
const BARE_HOST_PORT =
  /(?<![A-Za-z0-9_.@/:=?&%#~+\\-])(?:(\d+)\.(\d+)\.(\d+)\.(\d+)|((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){0,8}localhost)|(\[[0-9A-Fa-f:.]{2,45}\])):(\d+)(?:([/?#][A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%{}|^]*)|(?![A-Za-z0-9_@\\-]|:\S|\.[A-Za-z0-9]))/gi

const OCTET = /^(?:0|[1-9]\d{0,2})$/
const PORT = /^[1-9]\d{0,4}$/
const SENTENCE_END = /[.,;:!?]/
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

function isValidOctet(value: string): boolean {
  return OCTET.test(value) && Number(value) <= 255
}

function isValidPort(value: string): boolean {
  return PORT.test(value) && Number(value) <= 65535
}

function countChar(text: string, char: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === char) count++
  }
  return count
}

/** Trims trailing sentence punctuation and unmatched closing brackets from a URL suffix. */
function trimSuffix(suffix: string): string {
  let end = suffix.length
  while (end > 0) {
    const last = suffix[end - 1]!
    const kept = suffix.slice(0, end)
    if (SENTENCE_END.test(last)) {
      end--
    } else if (last in OPENER && countChar(kept, OPENER[last]!) < countChar(kept, last)) {
      end--
    } else {
      return kept
    }
  }
  return ''
}

/** Finds bare IPv4/localhost/IPv6 host:port web addresses in plain text. */
export function findBareHostLinks(text: string): BareHostLink[] {
  const links: BareHostLink[] = []
  for (const match of text.matchAll(BARE_HOST_PORT)) {
    const [, o1, o2, o3, o4, localhostHost, ipv6Host, portStr, rawSuffix] = match
    if (!portStr || !isValidPort(portStr)) continue

    let host: string
    if (o1 !== undefined) {
      if (!isValidOctet(o1) || !isValidOctet(o2!) || !isValidOctet(o3!) || !isValidOctet(o4!)) {
        continue
      }
      host = `${o1}.${o2}.${o3}.${o4}`
    } else if (localhostHost !== undefined) {
      host = localhostHost
    } else if (ipv6Host !== undefined) {
      if (!ipv6Host.includes(':')) continue
      host = ipv6Host
    } else {
      continue
    }

    const suffix = rawSuffix ? trimSuffix(rawSuffix) : ''
    const written = `${host}:${portStr}${suffix}`
    const parsed = URL.parse(`http://${written}`)
    if (!parsed || parsed.protocol !== 'http:') continue
    if (parsed.username !== '' || parsed.password !== '') continue
    const expectedPort = portStr === '80' ? '' : portStr
    if (parsed.port !== expectedPort) continue
    if (o1 !== undefined && parsed.hostname !== host) continue
    if (localhostHost !== undefined && parsed.hostname !== host.toLowerCase()) continue
    if (
      ipv6Host !== undefined &&
      !(parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']'))
    ) {
      continue
    }

    links.push({ from: match.index, to: match.index + written.length, url: parsed.href })
  }
  return links
}

/** The normalized http:// URL when the whole string is one bare host:port address, else null. */
export function bareHostUrl(text: string): string | null {
  const [link] = findBareHostLinks(text)
  return link && link.from === 0 && link.to === text.length ? link.url : null
}

function split(text: string): MdNode[] | null {
  const found = findBareHostLinks(text)
  if (found.length === 0) return null
  const out: MdNode[] = []
  let last = 0
  for (const { from, to, url } of found) {
    if (from > last) out.push({ type: 'text', value: text.slice(last, from) })
    out.push({ type: 'link', url, children: [{ type: 'text', value: text.slice(from, to) }] })
    last = to
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

/** Turns bare host:port addresses in prose and Markdown link targets into http:// links. */
export function bareHostLinks() {
  const visit = (node: MdNode): void => {
    if (node.type === 'link' && node.url) {
      node.url = bareHostUrl(node.url) ?? node.url
    }
    if (!node.children || SKIP.has(node.type)) return
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text' && child.value) return split(child.value) ?? [child]
      visit(child)
      return [child]
    })
  }
  return visit
}

// remark-rehype percent-encodes `[` and `]` in link URLs via mdurl, turning valid IPv6 literals
// such as `http://[::1]:4173/` into `http://%5B::1%5D:4173/`, which `new URL()` and rehype-harden
// reject. Restore brackets only when the decoded address parses as a valid http(s) IPv6 URL.
const ENCODED_IPV6_HREF = /^(https?:\/\/)%5B([0-9A-Fa-f:.]{2,45})%5D((?::\d{1,5})?(?:[/?#].*)?)$/i

/** Restores percent-encoded IPv6 host brackets on anchor hrefs before rehype-harden validates them. */
export function restoreIpv6Hrefs() {
  const visit = (node: HastNode): void => {
    if (
      node.type === 'element' &&
      node.tagName === 'a' &&
      typeof node.properties?.href === 'string'
    ) {
      const match = ENCODED_IPV6_HREF.exec(node.properties.href)
      if (match) {
        const candidate = `${match[1]}[${match[2]}]${match[3]}`
        const parsed = URL.parse(candidate)
        if (
          parsed &&
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          parsed.username === '' &&
          parsed.password === '' &&
          parsed.hostname.startsWith('[') &&
          parsed.hostname.endsWith(']')
        ) {
          node.properties.href = parsed.href
        }
      }
    }
    node.children?.forEach(visit)
  }
  return visit
}
