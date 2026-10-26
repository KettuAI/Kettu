// The themes folder in the data folder: every file read and checked in full, installing,
// replacing, removing, exporting and revealing them, and the chosen theme.

import { createHash, randomUUID } from 'node:crypto'
import { open, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import {
  BUILTIN_THEME_ID,
  parseColor,
  parseThemeFile,
  THEME_ID,
  THEME_MAX_BYTES,
  themeSlug,
  toHex,
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
import { safeName } from './artifacts/files'
import { t } from './i18n'
import { writeFileAtomic } from './json-file'
import { createLogger, describeError } from './log'

const log = createLogger('themes')

const JSON_FILTER = { name: 'JSON', extensions: ['json'] }
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

export interface ThemeStoreDeps {
  /** `themes/` in the data folder. */
  dir: string
  /** Makes `id` the setting; the change comes back through `choose`. */
  select(id: string): void
  /** After an install, a removal, a change found on disk or another theme chosen. */
  changed(state: ThemesState, chosen: Theme | null): void
}

/** Owns the themes folder; the setting, `appearance.colorTheme`, says which theme shows. */
export class ThemeStore {
  // A checked file that a `themes:install` answer offered to put in place of an installed theme.
  private pending: { token: string; id: string; text: string; ignored: string[] } | null = null

  constructor(
    private folder: ThemeFolder,
    private chosen: string,
    private readonly deps: ThemeStoreDeps,
  ) {
    this.logFailure()
  }

  state(): ThemesState {
    const { chosen, folder } = this
    const failure: ThemeLoadFailure | null =
      chosen === BUILTIN_THEME_ID || this.find(chosen)
        ? null
        : (folder.failed.get(chosen) ?? { code: 'missing' })
    return { installed: folder.installed, chosen, failed: failure && { id: chosen, failure } }
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

  /** `themes:install`: asks for a file, checks it and installs it, or names what it would replace. */
  async install(window: BrowserWindow | null): Promise<ThemeInstallResult> {
    this.pending = null
    const options: Electron.OpenDialogOptions = {
      title: t('dialogs.installTheme'),
      properties: ['openFile', 'dontAddToRecent'],
      filters: [JSON_FILTER],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const [path] = result.filePaths
    if (result.canceled || !path) return { status: 'cancelled' }
    const read = await readThemeFile(path)
    if (!read.ok) return { status: 'failed', file: basename(path), error: read.error }
    const id = themeId(read.theme.name)
    this.folder = await readThemeFolder(this.deps.dir)
    const installed = this.find(id)
    if (installed || this.folder.failed.has(id)) {
      const token = randomUUID()
      this.pending = { token, id, text: read.text, ignored: read.ignored }
      return {
        status: 'conflict',
        token,
        name: read.theme.name,
        installedName: installed?.theme.name ?? id,
      }
    }
    return this.write(id, read.text, read.ignored)
  }

  /** `themes:replace`: installs the file the last `themes:install` answer named. */
  async replace(token: unknown): Promise<ThemeInstallResult> {
    const pending = this.pending
    if (!pending || token !== pending.token) throw new Error('No theme is waiting to be installed')
    this.pending = null
    return this.write(pending.id, pending.text, pending.ignored)
  }

  /** `themes:remove`: deletes the file; removing the chosen theme brings back the built-in one. */
  async remove(id: unknown): Promise<void> {
    const file = this.fileOf(id)
    await rm(file, { force: true })
    this.folder = await readThemeFolder(this.deps.dir)
    if (id === this.chosen) this.deps.select(BUILTIN_THEME_ID)
    else this.publish()
  }

  /** `themes:export`: checks the file the renderer built, then saves it where the user says. */
  async export(window: BrowserWindow | null, text: unknown): Promise<boolean> {
    if (typeof text !== 'string') throw new Error('A theme file must be text')
    const parsed = parseThemeFile(text)
    if (!parsed.ok) throw new Error(`Not a theme file: ${parsed.error.code}`)
    const options: Electron.SaveDialogOptions = {
      title: t('dialogs.exportTheme'),
      defaultPath: join(app.getPath('downloads'), `${safeName(parsed.theme.name, 'theme')}.json`),
      filters: [JSON_FILTER],
    }
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, text, 'utf8')
    return true
  }

  /** `themes:reveal`: selects the theme's file in the file manager. */
  reveal(id: unknown): void {
    shell.showItemInFolder(this.fileOf(id))
  }

  private find(id: string): InstalledTheme | undefined {
    return this.folder.installed.find((theme) => theme.id === id)
  }

  /** The file of a theme the folder holds, for an id from the renderer. */
  private fileOf(id: unknown): string {
    if (typeof id !== 'string' || !(this.find(id) || this.folder.failed.has(id))) {
      throw new Error('Not an installed theme')
    }
    return join(this.deps.dir, `${id}.json`)
  }

  private async write(id: string, text: string, ignored: string[]): Promise<ThemeInstallResult> {
    await writeFileAtomic(join(this.deps.dir, `${id}.json`), text)
    this.folder = await readThemeFolder(this.deps.dir)
    // Installing applies the theme: through the setting, unless it is the chosen one already.
    if (id === this.chosen) this.publish()
    else this.deps.select(id)
    return { status: 'installed', id, ignored }
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
 * A variant's window colors in hex, which Electron takes: its `bg-app` laid over white in light
 * and black in dark, and its `text-primary` over that; `fallback` for what it leaves out.
 */
export function windowColors(
  colors: ThemeColors,
  mode: ThemeMode,
  fallback: WindowColors,
): WindowColors {
  const color = (token: 'bg-app' | 'text-primary') => {
    const value = colors[token]
    return value === undefined ? null : parseColor(value)
  }
  const bg = color('bg-app')
  const background = bg ? toHex(bg, mode === 'light' ? WHITE : BLACK) : fallback.background
  const fg = color('text-primary')
  return { background, symbol: fg ? toHex(fg, parseColor(background)!) : fallback.symbol }
}
