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

/** Sandbox shell modes: default web/canvas, strict capability isolation, and built-in viewer. */
export type SandboxFrameMode = 'default' | 'strict' | 'viewer'

/** Static sandbox shell paths for hosted and relay web clients (without .html suffix). */
export const SANDBOX_FRAME_PATHS: Readonly<Record<SandboxFrameMode, string>> = {
  default: '/_kettu/frame',
  strict: '/_kettu/frame-strict',
  viewer: '/_kettu/frame-viewer',
}

/** Static asset path prefix for built-in typed viewers (document and slides). */
export const SANDBOX_VIEWER_PREFIX = '/_kettu/viewer/'

const SANDBOX_DIRECTIVE =
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals'

/**
 * Isolated HTTP Content-Security-Policy for sandbox shell pages in hosted/relay web clients.
 * Enforces an opaque origin without allow-same-origin and avoids inheriting the host page's CSP.
 */
export function sandboxFrameCsp(mode: SandboxFrameMode): string {
  if (mode === 'viewer') {
    return [
      SANDBOX_DIRECTIVE,
      "frame-ancestors 'self'",
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      'img-src data: blob:',
      'media-src data: blob:',
      'connect-src data: blob:',
      "form-action 'none'",
      "base-uri 'none'",
    ].join('; ')
  }
  const cdns = mode === 'strict' ? '' : ` ${ARTIFACT_CDNS.join(' ')}`
  return [
    SANDBOX_DIRECTIVE,
    "frame-ancestors 'self'",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: data:${cdns}`,
    `style-src 'unsafe-inline' blob: data:${cdns}`,
    `font-src data: blob:${cdns}`,
    `img-src data: blob:${cdns}`,
    'media-src data: blob:',
    `connect-src data: blob:${cdns}`,
    'worker-src blob:',
    'frame-src blob: data:',
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/**
 * Minimal static sandbox shell HTML that waits for the parent window to deliver assembled HTML
 * and a read-only VFS MessagePort matching the URL fragment nonce.
 */
export const SANDBOX_SHELL_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><script>',
  '(()=>{const n=location.hash.slice(1);const f=e=>{',
  'if(e.source!==parent||parent===window)return;',
  'const d=e.data;if(!d||d.kettuSandbox!=="render"||d.nonce!==n)return;',
  'removeEventListener("message",f);',
  'window.__kettuVfsPort=e.ports[0]||null;',
  'window.__kettuSandboxNonce=n;',
  'document.open();document.write(d.html);document.close();',
  '};addEventListener("message",f);',
  'if(parent&&parent!==window)parent.postMessage({kettuSandbox:"ready",nonce:n},"*");',
  '})();',
  '</script></head><body></body></html>',
].join('')
