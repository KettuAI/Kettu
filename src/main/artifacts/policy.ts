// What an artifact's page may load: its own origin, `data:`, `blob:` and a fixed list of CDNs. The
// policy goes out as a header, and main's request filter holds the same line on its own. See
// docs/design/artifacts.md#network-policy.

import type { ProxyConfig } from 'electron'
import { ARTIFACT_SCHEME, artifactHost } from './origins'

/** The service's instructions name the same list. */
export const ARTIFACT_CDNS = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://esm.sh',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
] as const

const CDN_HOSTS: ReadonlySet<string> = new Set(ARTIFACT_CDNS.map((origin) => new URL(origin).host))

const CDNS = ARTIFACT_CDNS.join(' ')

export const ARTIFACT_CSP = [
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${CDNS}`,
  `style-src 'self' 'unsafe-inline' ${CDNS}`,
  `font-src 'self' data: ${CDNS}`,
  `img-src 'self' data: blob: ${CDNS}`,
  "media-src 'self' data: blob:",
  `connect-src 'self' ${CDNS}`,
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ')

const POWERFUL_FEATURES = [
  'camera',
  'microphone',
  'geolocation',
  'display-capture',
  'usb',
  'serial',
  'hid',
  'bluetooth',
  'midi',
  'payment',
  'clipboard-read',
  'clipboard-write',
  'fullscreen',
]

/**
 * The proxy of the session the windows use. Main's request filter stops a page's requests to other
 * hosts, but WebRTC's connections never pass it: with WebRTC kept off UDP, they all come here, to a
 * port nothing listens on, which refuses them. The CDNs, loopback and the spellchecker's
 * dictionaries, which Linux downloads, go direct. See docs/design/artifacts.md#network-policy.
 */
export const WINDOW_PROXY: ProxyConfig = {
  mode: 'fixed_servers',
  proxyRules: 'http://127.0.0.1:9',
  proxyBypassRules: [...CDN_HOSTS, 'localhost', '127.0.0.1', '[::1]', '*.gvt1.com'].join(','),
}

/** The headers of every response on an artifact origin. */
export function artifactHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': ARTIFACT_CSP,
    'Permissions-Policy': POWERFUL_FEATURES.map((feature) => `${feature}=()`).join(', '),
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  }
}

/** Whether a page on the artifact origin `host` may request `url`, whatever its policy says. */
export function mayRequest(host: string, url: string): boolean {
  const parsed = URL.parse(url)
  if (!parsed) return false
  switch (parsed.protocol) {
    case 'data:':
    case 'blob:':
      return true
    case `${ARTIFACT_SCHEME}:`:
      return artifactHost(url) === host
    case 'https:':
      // URL drops the default port, so a CDN on any other port has a host of its own.
      return CDN_HOSTS.has(parsed.host) && parsed.username === '' && parsed.password === ''
    default:
      return false
  }
}
