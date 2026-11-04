// Reads what the user chose to import as an artifact, an HTML file or a folder with an
// `index.html`: its files, its title and its pages.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  ARTIFACT_ENTRY,
  ARTIFACT_PATH_CHARS,
  artifactPathProblem,
  caseClash,
  DISK_FILE_BYTES,
  isHtmlPath,
  VERSION_BYTES,
  VERSION_FILES,
} from '@shared/artifact-files'
import { ARTIFACT_TITLE_CHARS, type ArtifactImportFailure } from '@shared/artifacts'
import { countPages } from './pages'

export type ImportRead =
  | { files: { path: string; data: Uint8Array }[]; title: string; pages: number }
  | { failed: Exclude<ArtifactImportFailure, 'unavailable'> }

/** The entries a folder's walk looks at, files and folders, before it gives up. */
const MAX_ENTRIES = 10_000

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g,
    (all, dec, hex, name) => {
      if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? all
      const code = dec !== undefined ? Number(dec) : parseInt(hex, 16)
      // Zero, surrogates and anything past Unicode are not characters.
      if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return all
      return String.fromCodePoint(code)
    },
  )
}

/** The text of the first `<title>` element, tidied; empty when there is none. */
function pageTitle(html: string): string {
  const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(html)
  return match ? decodeEntities(match[1]!).replace(/\s+/g, ' ').trim() : ''
}

/** The first `ARTIFACT_TITLE_CHARS` code points of `text`. */
function clip(text: string): string {
  return Array.from(text).slice(0, ARTIFACT_TITLE_CHARS).join('').trim()
}

/**
 * An artifact's title for a file or folder: its page's `<title>`, else `name`, the file's name
 * without its extension or the folder's, else "Untitled"; 1 to 120 code points, as the service
 * allows.
 */
export function importTitle(html: string, name: string): string {
  const named = clip(pageTitle(html))
  if (named !== '') return named
  const base = clip(name.replace(/\s+/g, ' ').trim())
  return base !== '' ? base : 'Untitled'
}

function text(bytes: Uint8Array): string | null {
  try {
    // The decoder drops a leading BOM.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** What the user chose as an artifact would hold it, or why it cannot be one. */
export async function readImport(chosen: string): Promise<ImportRead> {
  let info
  try {
    info = await stat(chosen)
  } catch {
    return { failed: 'unreadable' }
  }
  if (info.isDirectory()) return readFolder(chosen)
  if (!info.isFile()) return { failed: 'unreadable' }
  if (info.size > DISK_FILE_BYTES) return { failed: 'too_large' }
  let bytes: Buffer
  try {
    bytes = await readFile(chosen)
  } catch {
    return { failed: 'unreadable' }
  }
  // The file may have grown since the stat.
  if (bytes.length > DISK_FILE_BYTES) return { failed: 'too_large' }
  const html = text(bytes)
  if (html === null) return { failed: 'not_utf8' }
  return {
    files: [{ path: ARTIFACT_ENTRY, data: bytes }],
    title: importTitle(html, path.parse(chosen).name),
    pages: countPages(html),
  }
}

interface Found {
  path: string
  file: string
}

/**
 * The files under `root` by their paths in the artifact, skipping hidden ones, symbolic links
 * and anything else that is not a file or a folder; or why they cannot be an artifact's.
 */
async function listFolder(root: string): Promise<Found[] | { failed: 'too_many' | 'bad_name' }> {
  const found: Found[] = []
  let entries = 0
  const walk = async (dir: string, prefix: string): Promise<'too_many' | 'bad_name' | null> => {
    if (prefix.length > ARTIFACT_PATH_CHARS) return 'bad_name'
    const listed = await readdir(dir, { withFileTypes: true })
    listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of listed) {
      if (entry.name.startsWith('.')) continue
      if (++entries > MAX_ENTRIES) return 'too_many'
      const at = `${prefix}${entry.name}`
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const failed = await walk(file, `${at}/`)
        if (failed) return failed
      } else if (entry.isFile()) {
        if (artifactPathProblem(at) !== null) return 'bad_name'
        if (found.length >= VERSION_FILES) return 'too_many'
        found.push({ path: at, file })
      }
    }
    return null
  }
  const failed = await walk(root, '')
  if (failed) return { failed }
  return caseClash(found.map((f) => f.path)) ? { failed: 'bad_name' } : found
}

async function readFolder(root: string): Promise<ImportRead> {
  let listed
  try {
    listed = await listFolder(root)
  } catch {
    return { failed: 'unreadable' }
  }
  if (!Array.isArray(listed)) return listed
  if (!listed.some((f) => f.path === ARTIFACT_ENTRY)) return { failed: 'no_index' }
  const files: { path: string; data: Uint8Array }[] = []
  let total = 0
  let html = ''
  for (const { path: at, file } of listed) {
    let bytes: Buffer
    try {
      const info = await stat(file)
      if (info.size > DISK_FILE_BYTES || total + info.size > VERSION_BYTES) {
        return { failed: 'too_large' }
      }
      bytes = await readFile(file)
    } catch {
      return { failed: 'unreadable' }
    }
    total += bytes.length
    if (bytes.length > DISK_FILE_BYTES || total > VERSION_BYTES) return { failed: 'too_large' }
    if (isHtmlPath(at)) {
      const decoded = text(bytes)
      if (decoded === null) return { failed: 'not_utf8' }
      if (at === ARTIFACT_ENTRY) html = decoded
    }
    files.push({ path: at, data: bytes })
  }
  return { files, title: importTitle(html, path.basename(root)), pages: countPages(html) }
}
