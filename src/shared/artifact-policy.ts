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

const CDNS = ARTIFACT_CDNS.join(' ')

/** Its own origin, `data:`, `blob:` and the CDNs. */
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

/** The features no artifact gets. */
export const ARTIFACT_PERMISSIONS_POLICY = POWERFUL_FEATURES.map((feature) => `${feature}=()`).join(
  ', ',
)
