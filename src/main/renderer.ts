import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'

/** Where the renderer loads from: the dev server in development, else the built index.html. */
export type RendererEntry = { kind: 'dev-server'; url: string } | { kind: 'file'; path: string }

const devServerUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
const entry: RendererEntry = devServerUrl
  ? { kind: 'dev-server', url: devServerUrl }
  : { kind: 'file', path: join(__dirname, '../renderer/index.html') }

export function loadRenderer(window: BrowserWindow): Promise<void> {
  return entry.kind === 'dev-server' ? window.loadURL(entry.url) : window.loadFile(entry.path)
}

/** Whether a URL belongs to the app's own renderer, as opposed to remote content. */
export function isRendererUrl(url: string | undefined): boolean {
  return matchesRendererEntry(url, entry)
}

/**
 * Whether `url` is the renderer entry, ignoring its query and hash: on the dev server's origin,
 * or the very file loadRenderer loads. Every file shares one origin, so a file must match by path.
 */
export function matchesRendererEntry(
  url: string | undefined,
  entry: RendererEntry,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const parsed = url ? URL.parse(url) : null
  if (!parsed) return false
  if (entry.kind === 'dev-server') {
    const origin = URL.parse(entry.url)?.origin
    // Opaque origins, such as those of file: and data: URLs, all serialize to 'null'.
    return origin !== undefined && origin !== 'null' && parsed.origin === origin
  }
  if (parsed.protocol !== 'file:') return false
  const windows = platform === 'win32'
  // Chromium keeps a '%' that starts no escape as a literal '%'; decodeURIComponent throws on it.
  parsed.pathname = parsed.pathname.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
  let path: string
  try {
    // Comparing decoded paths keeps Chromium's and Node's different escaping out of the match.
    // It throws on an encoded separator and, off Windows, on any host but localhost.
    path = fileURLToPath(parsed, { windows })
  } catch {
    return false
  }
  // Windows paths ignore ASCII case; Chromium upper-cases the drive letter and lower-cases the host.
  return windows ? foldAscii(path) === foldAscii(entry.path) : path === entry.path
}

// Not toLowerCase: it also folds non-ASCII letters, such as U+212A to "k", which NTFS keeps apart.
function foldAscii(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}
