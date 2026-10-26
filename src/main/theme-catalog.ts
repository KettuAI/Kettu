// The online theme catalog, the public repository overbench/themes: its index, read and checked,
// and the theme files it lists, downloaded and checked against the index's SHA-256.

import { createHash } from 'node:crypto'
import {
  BUILTIN_THEME_ID,
  parseColor,
  plainText,
  PREVIEW_TOKENS,
  THEME_ID,
  THEME_MAX_BYTES,
  THEME_MODES,
  themeField,
  type CatalogInstallError,
  type ThemeColors,
  type ThemeMode,
} from '@shared/themes'
import { createLogger, describeError } from './log'

const log = createLogger('themes')

export const CATALOG_URL = 'https://raw.githubusercontent.com/overbench/themes/main/'
const CATALOG_FORMAT = 1
const INDEX_MAX_BYTES = 1024 * 1024
const TIMEOUT_MS = 15_000
const MAX_LICENSE = 64
const MAX_COLOR = 100
const SHA256 = /^[0-9a-f]{64}$/
const UTF8 = new TextDecoder('utf-8', { fatal: true })

export interface CatalogEntry {
  id: string
  name: string
  author: string
  version: string
  license: string
  /** `themes/<id>.json`, under CATALOG_URL. */
  file: string
  sha256: string
  preview: Record<ThemeMode, ThemeColors>
}

export type CatalogIndex =
  { ok: true; entries: CatalogEntry[] } | { ok: false; error: 'invalid' | 'newer-format' }

export type CatalogFetch = (url: string, init: RequestInit) => Promise<Response>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The preview's colors that are colors, of the tokens a tile draws; anything else is dropped. */
function previewOf(value: unknown): Record<ThemeMode, ThemeColors> {
  const preview: Record<ThemeMode, ThemeColors> = { light: {}, dark: {} }
  if (!isRecord(value)) return preview
  for (const mode of THEME_MODES) {
    const colors = value[mode]
    if (!isRecord(colors)) continue
    for (const token of PREVIEW_TOKENS) {
      const color = colors[token]
      if (typeof color === 'string' && color.length <= MAX_COLOR && parseColor(color)) {
        preview[mode][token] = color.trim()
      }
    }
  }
  return preview
}

function entryOf(value: unknown): CatalogEntry | null {
  if (!isRecord(value)) return null
  const { id, file, sha256 } = value
  if (typeof id !== 'string' || !THEME_ID.test(id) || id === BUILTIN_THEME_ID) return null
  const name = themeField('name', value['name'])
  const author = themeField('author', value['author'])
  const version = themeField('version', value['version'])
  const license = plainText(value['license'], MAX_LICENSE)
  if (name === null || author === null || version === null || license === null) return null
  if (file !== `themes/${id}.json` || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    return null
  }
  return { id, name, author, version, license, file, sha256, preview: previewOf(value['preview']) }
}

/** Reads the index; an entry that fails its checks, or repeats an id, is skipped. */
export function parseCatalogIndex(text: string): CatalogIndex {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'invalid' }
  }
  if (!isRecord(raw) || !Array.isArray(raw['themes'])) return { ok: false, error: 'invalid' }
  const format = raw['overbenchCatalog']
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) {
    return { ok: false, error: 'invalid' }
  }
  if (format > CATALOG_FORMAT) return { ok: false, error: 'newer-format' }
  const entries: CatalogEntry[] = []
  raw['themes'].forEach((value: unknown, i) => {
    const entry = entryOf(value)
    if (entry && !entries.some((other) => other.id === entry.id)) entries.push(entry)
    else log.warn(`Skipped entry ${i} of the theme catalog`)
  })
  return { ok: true, entries }
}

/** The body's bytes, or null once it holds more than `max`. */
export async function readBody(response: Response, max: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks, length)
    length += value.byteLength
    if (length > max) {
      void reader.cancel()
      return null
    }
    chunks.push(value)
  }
}

/** Reads the catalog: the index when the dialog asks, and the files it lists on an install. */
export class ThemeCatalog {
  private entries: CatalogEntry[] | null = null

  constructor(private readonly fetch: CatalogFetch) {}

  /** The index, read from GitHub when `refresh` is set or nothing was read yet. */
  async index(refresh: boolean): Promise<CatalogIndex | { ok: false; error: 'unreachable' }> {
    if (!refresh && this.entries) return { ok: true, entries: this.entries }
    this.entries = null
    const data = await this.get('index.json', INDEX_MAX_BYTES)
    if (data === 'unreachable') return { ok: false, error: 'unreachable' }
    if (data === 'too-large') return { ok: false, error: 'invalid' }
    let text: string
    try {
      text = UTF8.decode(data)
    } catch {
      return { ok: false, error: 'invalid' }
    }
    const index = parseCatalogIndex(text)
    if (index.ok) this.entries = index.entries
    else log.warn(`The theme catalog's index is ${index.error}`)
    return index
  }

  /** An entry of the index read last. */
  find(id: string): CatalogEntry | undefined {
    return this.entries?.find((entry) => entry.id === id)
  }

  /** An entry's file, once its bytes match the entry's SHA-256. */
  async download(entry: CatalogEntry): Promise<Buffer | CatalogInstallError> {
    const data = await this.get(entry.file, THEME_MAX_BYTES)
    if (data === 'unreachable') return { code: 'unreachable' }
    if (data === 'too-large') return { code: 'too-large' }
    if (createHash('sha256').update(data).digest('hex') !== entry.sha256) {
      log.warn(`${entry.file} does not match the SHA-256 in the theme catalog`)
      return { code: 'mismatch' }
    }
    return data
  }

  private async get(path: string, max: number): Promise<Buffer | 'unreachable' | 'too-large'> {
    const url = new URL(path, CATALOG_URL).href
    try {
      // Revalidates what the session cached; the timeout covers reading the body too.
      const response = await this.fetch(url, {
        cache: 'no-cache',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        void response.body?.cancel()
        log.warn(`${url} answered ${response.status}`)
        return 'unreachable'
      }
      return (await readBody(response, max)) ?? 'too-large'
    } catch (error) {
      log.warn(`Could not read ${url}: ${describeError(error)}`)
      return 'unreachable'
    }
  }
}
