// What an artifact's page may load and use, wherever it runs: on the desktop's artifact origins and
// in the frame the direct port serves the web client.

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

function policy(cdns: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:${cdns}`,
    `style-src 'self' 'unsafe-inline'${cdns}`,
    `font-src 'self' data:${cdns}`,
    `img-src 'self' data: blob:${cdns}`,
    "media-src 'self' data: blob:",
    `connect-src 'self'${cdns}`,
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "form-action 'none'",
    "base-uri 'self'",
  ].join('; ')
}

/** Its own origin, `data:`, `blob:` and the CDNs. */
export const ARTIFACT_CSP = policy(` ${ARTIFACT_CDNS.join(' ')}`)

/**
 * For an artifact whose latest version declares a capability that reads what is outside it: its
 * own origin, `data:` and `blob:`, so nothing it reads can leave in a URL.
 */
export const ARTIFACT_STRICT_CSP = policy('')

/** The policy of an artifact's pages, strict or with the CDNs. */
export function artifactCsp(strict: boolean): string {
  return strict ? ARTIFACT_STRICT_CSP : ARTIFACT_CSP
}

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

/** The features no artifact gets. */
export const ARTIFACT_PERMISSIONS_POLICY = POWERFUL_FEATURES.map((feature) => `${feature}=()`).join(
  ', ',
)
