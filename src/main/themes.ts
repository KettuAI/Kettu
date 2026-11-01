// The themes folder in the data folder: every file read and checked in full, installing from a
// file or the catalog, replacing and removing them, and the chosen theme. The desktop app's dialogs
// for it are in theme-dialogs.ts, so the daemon keeps themes too.

import { createHash, randomUUID } from 'node:crypto'
import { open, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { HostThemes } from '@shared/remote/host-admin'
import {
  BUILTIN_THEME_ID,
  parseColor,
  parseThemeFile,
  THEME_ID,
  THEME_MAX_BYTES,
  themeField,
  themeSlug,
  toHex,
  type CatalogInstallResult,
  type CatalogState,
  type CatalogTheme,
  type InstalledTheme,
  type Rgba,
  type Theme,
  type ThemeColors,
  type ThemeFileError,
  type ThemeInstallResult,
  type ThemeLoadFailure,
  type ThemeMode,
  type ThemesState,
} from '@shared/themes'
import { readJsonFile, writeFileAtomic } from './json-file'
import { createLogger, describeError } from './log'
import type { ThemeCatalog } from './theme-catalog'
import { compareVersions } from './update-state'

const log = createLogger('themes')

// Fatal, so a file that is not UTF-8 is refused rather than read with replacement characters.
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** The id a theme's name gives, or `theme-` and a hash of the name when no ASCII is left. */
export function themeId(name: string): string {
  return themeSlug(name) || `theme-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
}

export type ThemeReadResult =
  | { ok: true; theme: Theme; ignored: string[]; text: string }
  | { ok: false; error: ThemeFileError | { code: 'unreadable' } }

/** The file's bytes, or null when it holds more than `max`. */
async function readCapped(path: string, max: number): Promise<Buffer | null> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(max + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return length > max ? null : buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

/** Reads a theme file and checks all of it; `text` is what an install writes. */
export async function readThemeFile(path: string): Promise<ThemeReadResult> {
  let data: Buffer | null
  try {
    data = await readCapped(path, THEME_MAX_BYTES)
  } catch (error) {
    log.warn(`Could not read ${path}: ${describeError(error)}`)
    return { ok: false, error: { code: 'unreadable' } }
  }
  if (!data) return { ok: false, error: { code: 'too-large' } }
  return checkThemeBytes(data)
}

/** Checks a theme file's text as a device sent it, held to a file's size. */
export function checkThemeText(text: string): ThemeReadResult {
  const data = Buffer.from(text, 'utf8')
  if (data.length > THEME_MAX_BYTES) return { ok: false, error: { code: 'too-large' } }
  return checkThemeBytes(data)
}

/** Checks a theme file's bytes, from disk or the catalog. */
function checkThemeBytes(
  data: Buffer,
): Exclude<ThemeReadResult, { ok: false }> | { ok: false; error: ThemeFileError } {
  let text: string
  try {
    text = UTF8.decode(data)
  } catch {
    return { ok: false, error: { code: 'not-json' } }
  }
  const result = parseThemeFile(text)
  return result.ok ? { ...result, text } : result
}

function describeFailure(failure: ThemeLoadFailure): string {
  if (failure.code !== 'invalid') return failure.code
  const { error } = failure
  if ('path' in error) return `${error.code} (${error.path})`
  if ('variant' in error) return `${error.code} (${error.variant})`
  return error.code
}

/** What the folder holds: the themes that pass the check, by name, and why the others fail. */
export interface ThemeFolder {
  installed: InstalledTheme[]
  failed: Map<string, ThemeLoadFailure>
}

/** Reads every `<id>.json` in the folder; a missing folder holds no themes. */
export async function readThemeFolder(dir: string): Promise<ThemeFolder> {
  const folder: ThemeFolder = { installed: [], failed: new Map() }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read ${dir}: ${describeError(error)}`)
    }
    return folder
  }
  const ids = names.flatMap((name) => {
    if (!name.endsWith('.json')) return []
    const id = name.slice(0, -'.json'.length)
    if (THEME_ID.test(id) && id !== BUILTIN_THEME_ID) return [id]
    log.warn(`Skipped themes/${name}: its name is not a theme id`)
    return []
  })
  const results = await Promise.all(ids.map((id) => readThemeFile(join(dir, `${id}.json`))))
  ids.forEach((id, i) => {
    const result = results[i]!
    if (result.ok) {
      folder.installed.push({ id, theme: result.theme, ignored: result.ignored })
      return
    }
    const failure: ThemeLoadFailure =
      result.error.code === 'unreadable'
        ? { code: 'unreadable' }
        : { code: 'invalid', error: result.error }
    folder.failed.set(id, failure)
    log.warn(`Skipped themes/${id}.json: ${describeFailure(failure)}`)
  })
  folder.installed.sort(
    (a, b) => a.theme.name.localeCompare(b.theme.name) || a.id.localeCompare(b.id),
  )
  return folder
}

const snapshot = (folder: ThemeFolder) => JSON.stringify([folder.installed, [...folder.failed]])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Which installed themes came from the catalog, by id, and the version each was installed at. */
export type ThemeSources = Map<string, string>

/** Reads `theme-sources.json`; a missing or unreadable file counts every theme as a file theme. */
export async function readThemeSources(path: string): Promise<ThemeSources> {
  const sources: ThemeSources = new Map()
  const read = await readJsonFile(path)
  if (read.kind === 'unreadable') log.warn(`theme-sources.json is unreadable: ${read.reason}`)
  if (read.kind !== 'ok') return sources
  const { value } = read
  if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['catalog'])) {
    log.warn('theme-sources.json is invalid; every theme counts as installed from a file')
    return sources
  }
  for (const [id, version] of Object.entries(value['catalog'])) {
    const checked = themeField('version', version)
    if (THEME_ID.test(id) && checked !== null) sources.set(id, checked)
  }
  return sources
}

export interface ThemeStoreDeps {
  /** `themes/` in the data folder. */
  dir: string
  /** `theme-sources.json` in the data folder, beside `themes/`. */
  sourcesFile: string
  catalog: ThemeCatalog
  /** Makes `id` the setting; the change comes back through `choose`. */
  select(id: string): void
  /** After an install, a removal, a change found on disk or another theme chosen. */
  changed(state: ThemesState, chosen: Theme | null): void
}

/** Makes an installed theme the one that shows: the setting's, or a device's own. */
export type ThemeSelect = (id: string) => void

/** Owns the themes folder; the setting, `appearance.colorTheme`, says which theme shows. */
export class ThemeStore {
  // A checked file that an install answer offered to put in place of an installed theme, with the
  // catalog version it comes at, if it comes from the catalog.
  private pending: {
    token: string
    id: string
    text: string
    ignored: string[]
    catalog?: string
    select: ThemeSelect
  } | null = null
  // Changes to the folder, one at a time, so two installs never write the same file at once.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private folder: ThemeFolder,
    private sources: ThemeSources,
    private chosen: string,
    private readonly deps: ThemeStoreDeps,
  ) {
    this.logFailure()
  }

  state(): ThemesState {
    const { chosen, folder, sources } = this
    const failure: ThemeLoadFailure | null =
      chosen === BUILTIN_THEME_ID || this.find(chosen)
        ? null
        : (folder.failed.get(chosen) ?? { code: 'missing' })
    const installed = folder.installed.map((theme) => {
      const catalog = sources.get(theme.id)
      return catalog === undefined ? theme : { ...theme, catalog }
    })
    return { installed, chosen, failed: failure && { id: chosen, failure } }
  }

  /** What a device lists: every theme the folder holds, whichever one this host shows. */
  hostThemes(): HostThemes {
    const failed = [...this.folder.failed].map(([id, failure]) => ({ id, failure }))
    return { installed: this.state().installed, failed }
  }

  /** The chosen theme, or null while the built-in one shows. */
  chosenTheme(): Theme | null {
    return this.find(this.chosen)?.theme ?? null
  }

  /** The setting changed, perhaps to another theme. */
  choose(id: string): void {
    if (id === this.chosen) return
    this.chosen = id
    this.logFailure()
    this.publish()
  }

  /** `themes:get`: reads the folder again, so a file changed by hand shows. */
  async refresh(): Promise<ThemesState> {
    const before = snapshot(this.folder)
    this.folder = await readThemeFolder(this.deps.dir)
    if (snapshot(this.folder) !== before) this.publish()
    return this.state()
  }

  /**
   * Installs a checked file, or names the installed theme it would replace; `file` names it in a
   * failure. Installing shows the theme through `select`, a device's own when a device installs it.
   */
  async add(
    file: string,
    read: ThemeReadResult,
    select: ThemeSelect = this.deps.select,
  ): Promise<ThemeInstallResult> {
    this.pending = null
    if (!read.ok) return { status: 'failed', file, error: read.error }
    const id = themeId(read.theme.name)
    this.folder = await readThemeFolder(this.deps.dir)
    const installed = this.find(id)
    if (installed || this.folder.failed.has(id)) {
      const token = randomUUID()
      this.pending = { token, id, text: read.text, ignored: read.ignored, select }
      return {
        status: 'conflict',
        token,
        name: read.theme.name,
        installedName: installed?.theme.name ?? id,
      }
    }
    return this.write(id, read.text, read.ignored, undefined, true, select)
  }

  /** `themes:replace`: installs the file the last install answer named. */
  async replace(token: unknown): Promise<ThemeInstallResult> {
    const pending = this.pending
    if (!pending || token !== pending.token) throw new Error('No theme is waiting to be installed')
    this.pending = null
    return this.write(
      pending.id,
      pending.text,
      pending.ignored,
      pending.catalog,
      true,
      pending.select,
    )
  }

  /**
   * `themes:catalog`: the catalog's themes and what installing each does, from the index read when
   * `refresh` is set or the first time, otherwise from the one read last.
   */
  async catalog(refresh: unknown): Promise<CatalogState> {
    const index = await this.deps.catalog.index(refresh === true)
    if (!index.ok) return { status: index.error }
    const themes = index.entries.map(({ id, name, author, version, license, preview }) => {
      const installedAt = this.find(id) && this.sources.get(id)
      const action: CatalogTheme['action'] = !installedAt
        ? 'install'
        : compareVersions(version, installedAt) > 0
          ? 'update'
          : 'installed'
      return { id, name, author, version, license, preview, action }
    })
    themes.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    return { status: 'ok', themes }
  }

  /**
   * `themes:install-catalog`: downloads a theme the last index lists and installs it. A theme
   * installed from the catalog is replaced without asking, and an update keeps the chosen theme;
   * one installed from a file is named for `themes:replace` first.
   */
  async installCatalog(
    id: unknown,
    select: ThemeSelect = this.deps.select,
  ): Promise<CatalogInstallResult> {
    this.pending = null
    const entry = typeof id === 'string' ? this.deps.catalog.find(id) : undefined
    if (!entry) throw new Error('Not a theme in the catalog')
    const data = await this.deps.catalog.download(entry)
    if (!Buffer.isBuffer(data)) return { status: 'failed', error: data }
    const read = checkThemeBytes(data)
    if (!read.ok) return { status: 'failed', error: read.error }
    if (themeId(read.theme.name) !== entry.id)
      return { status: 'failed', error: { code: 'mismatch' } }
    this.folder = await readThemeFolder(this.deps.dir)
    const installed = this.find(entry.id)
    const fromCatalog = installed && this.sources.has(entry.id)
    if ((installed || this.folder.failed.has(entry.id)) && !fromCatalog) {
      const token = randomUUID()
      this.pending = {
        token,
        id: entry.id,
        text: read.text,
        ignored: read.ignored,
        catalog: entry.version,
        select,
      }
      return {
        status: 'conflict',
        token,
        name: read.theme.name,
        installedName: installed?.theme.name ?? entry.id,
      }
    }
    return this.write(entry.id, read.text, read.ignored, entry.version, !fromCatalog, select)
  }

  /** `themes:remove`: deletes the file; removing the chosen theme brings back the built-in one. */
  async remove(id: unknown): Promise<void> {
    const file = this.fileOf(id)
    await this.serial(async () => {
      await rm(file, { force: true })
      this.folder = await readThemeFolder(this.deps.dir)
      await this.record(basename(file, '.json'), undefined)
    })
    if (id === this.chosen) this.deps.select(BUILTIN_THEME_ID)
    else this.publish()
  }

  /** The name of the theme in a file the renderer built to export, checked in full. */
  exportName(text: unknown): string {
    if (typeof text !== 'string') throw new Error('A theme file must be text')
    const parsed = parseThemeFile(text)
    if (!parsed.ok) throw new Error(`Not a theme file: ${parsed.error.code}`)
    return parsed.theme.name
  }

  private find(id: string): InstalledTheme | undefined {
    return this.folder.installed.find((theme) => theme.id === id)
  }

  /** The file of a theme the folder holds, for an id from a window or a device. */
  fileOf(id: unknown): string {
    if (typeof id !== 'string' || !(this.find(id) || this.folder.failed.has(id))) {
      throw new Error('Not an installed theme')
    }
    return join(this.deps.dir, `${id}.json`)
  }

  /**
   * Installs a checked file and records where it came from: the catalog at `catalog`, or a file.
   * Installing applies the theme unless `choose` is false, as for an update from the catalog.
   */
  private async write(
    id: string,
    text: string,
    ignored: string[],
    catalog?: string,
    choose = true,
    select: ThemeSelect = this.deps.select,
  ): Promise<{ status: 'installed'; id: string; ignored: string[] }> {
    await this.serial(async () => {
      await writeFileAtomic(join(this.deps.dir, `${id}.json`), text)
      this.folder = await readThemeFolder(this.deps.dir)
      await this.record(id, catalog)
    })
    if (choose && select !== this.deps.select) {
      select(id)
      this.publish()
    } else if (choose && id !== this.chosen) {
      // Through the setting, unless the theme is the chosen one already.
      select(id)
    } else this.publish()
    return { status: 'installed', id, ignored }
  }

  /** Records the catalog version a theme was installed at, or drops its record when undefined. */
  private async record(id: string, catalog: string | undefined): Promise<void> {
    if (catalog === this.sources.get(id)) return
    if (catalog === undefined) this.sources.delete(id)
    else this.sources.set(id, catalog)
    // Records of themes no longer installed go with this write.
    const kept = [...this.sources].filter(([key]) => this.find(key) || this.folder.failed.has(key))
    this.sources = new Map(kept)
    const data = { version: 1, catalog: Object.fromEntries(kept) }
    await writeFileAtomic(this.deps.sourcesFile, `${JSON.stringify(data, null, 2)}\n`)
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private publish(): void {
    this.deps.changed(this.state(), this.chosenTheme())
  }

  private logFailure(): void {
    const { failed } = this.state()
    if (failed) {
      log.warn(`The theme ${failed.id} could not load (${describeFailure(failed.failure)})`)
    }
  }
}

export interface WindowColors {
  background: string
  symbol: string
}

const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 }
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }

/**
 * A variant's window colors in hex, which Electron takes: its desk, `bg-sidebar`, laid over white
 * in light and black in dark, and its `text-primary` over that; `fallback` for what it leaves out.
 */
export function windowColors(
  colors: ThemeColors,
  mode: ThemeMode,
  fallback: WindowColors,
): WindowColors {
  const color = (token: 'bg-sidebar' | 'text-primary') => {
    const value = colors[token]
    return value === undefined ? null : parseColor(value)
  }
  const bg = color('bg-sidebar')
  const background = bg ? toHex(bg, mode === 'light' ? WHITE : BLACK) : fallback.background
  const fg = color('text-primary')
  return { background, symbol: fg ? toHex(fg, parseColor(background)!) : fallback.symbol }
}
