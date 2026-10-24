// Reads a file the user chose to import as an artifact: its HTML, its title and its pages.

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { ARTIFACT_TITLE_CHARS } from '@shared/artifacts'
import { countPages } from './pages'
import { HTML_BYTES } from './tools'

export type ImportRead =
  | { html: string; title: string; pages: number }
  | { failed: 'too_large' | 'not_utf8' | 'unreadable' }

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
 * An artifact's title for a file: its `<title>`, else the file name without its extension, else
 * "Untitled"; 1 to 120 code points, as the service allows.
 */
export function importTitle(html: string, file: string): string {
  const named = clip(pageTitle(html))
  if (named !== '') return named
  const base = clip(path.parse(file).name.replace(/\s+/g, ' ').trim())
  return base !== '' ? base : 'Untitled'
}

/** The file as an artifact would hold it, or why it cannot be one. */
export async function readImport(file: string): Promise<ImportRead> {
  let bytes: Buffer
  try {
    const info = await stat(file)
    if (!info.isFile()) return { failed: 'unreadable' }
    if (info.size > HTML_BYTES) return { failed: 'too_large' }
    bytes = await readFile(file)
  } catch {
    return { failed: 'unreadable' }
  }
  // The file may have grown since the stat.
  if (bytes.length > HTML_BYTES) return { failed: 'too_large' }
  let html: string
  try {
    // The decoder drops a leading BOM.
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { failed: 'not_utf8' }
  }
  return { html, title: importTitle(html, file), pages: countPages(html) }
}
