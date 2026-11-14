import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'

/** Where the renderer loads from: the dev server in development, else the built index.html. */
export type RendererEntry = { kind: 'dev-server'; url: string } | { kind: 'file'; path: string }

/**
 * The renderer's pages: the main window's, the menu bar panel's, the page overlay's, and computer
 * use's overlay, the light and the label drawn over the desktop while Kettu is in the background.
 */
export type RendererPage = 'index' | 'tray' | 'overlay' | 'computer-overlay'

const PAGES: readonly RendererPage[] = ['index', 'tray', 'overlay', 'computer-overlay']

const devServerUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined

function entryOf(page: RendererPage): RendererEntry {
  if (!devServerUrl) return { kind: 'file', path: join(__dirname, `../renderer/${page}.html`) }
  if (page === 'index') return { kind: 'dev-server', url: devServerUrl }
  return { kind: 'dev-server', url: URL.parse(`${page}.html`, devServerUrl)?.href ?? devServerUrl }
}

const entries: Record<RendererPage, RendererEntry> = {
  index: entryOf('index'),
  tray: entryOf('tray'),
  overlay: entryOf('overlay'),
  'computer-overlay': entryOf('computer-overlay'),
}

/** The page the overlay over a browser page loads, and its address once loaded. */
export function overlayEntry(): RendererEntry & { url: string } {
  const entry = entries.overlay
  if (entry.kind === 'dev-server') return { ...entry }
  return { ...entry, url: pathToFileURL(entry.path).href }
}

export function loadRenderer(
  window: BrowserWindow,
  page: RendererPage = 'index',
  hash?: string,
): Promise<void> {
  const entry = entries[page]
  if (entry.kind === 'file') return window.loadFile(entry.path, hash ? { hash } : undefined)
  return window.loadURL(hash ? `${entry.url}#${hash}` : entry.url)
}

/**
 * Whether a URL is one of the app's own pages that may call main, as opposed to remote content.
 * The overlays are not: each speaks only over its own channels.
 */
export function isRendererUrl(url: string | undefined): boolean {
  const page = rendererPage(url)
  return page === 'index' || page === 'tray'
}

/**
 * Which of the renderer's pages a URL is, or null for anything else. On the dev server every page
 * shares one origin, so a page there is told by its path.
 */
export function rendererPage(url: string | undefined): RendererPage | null {
  if (entries.index.kind === 'file') {
    return PAGES.find((page) => matchesRendererEntry(url, entries[page])) ?? null
  }
  if (!matchesRendererEntry(url, entries.index)) return null
  const path = URL.parse(url!)?.pathname
  return PAGES.find((page) => page !== 'index' && path === `/${page}.html`) ?? 'index'
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
