// The code editors a session's menu opens its folder or a file in: the known ones installed on
// this computer, then the apps the user chose. Main keeps every app's path; the page names an
// editor only by its id.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app, dialog, nativeImage, type BrowserWindow } from 'electron'
import type { EditorApp, EditorList } from '@shared/editors'
import type { Platform } from '@shared/platform'
import { findCommand, isExecutableFile, type Env } from '../agent-host/find-command'
import { t } from './i18n'
import { JsonFileWriter, readJsonFile } from './json-file'
import { createLogger } from './log'

const log = createLogger('editors')

interface KnownEditor {
  id: string
  name: string
  /** The URL scheme the app registers, which finds it wherever it is installed (macOS, Windows). */
  scheme?: string
  /** Its bundle's names in /Applications or ~/Applications, without `.app` (macOS). */
  bundles: string[]
  /** The command it puts on PATH (Linux). */
  command?: string
}

/** In the order the menu lists them. */
export const KNOWN_EDITORS: readonly KnownEditor[] = [
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    scheme: 'vscode',
    bundles: ['Visual Studio Code'],
    command: 'code',
  },
  {
    id: 'vscode-insiders',
    name: 'VS Code Insiders',
    scheme: 'vscode-insiders',
    bundles: ['Visual Studio Code - Insiders'],
    command: 'code-insiders',
  },
  { id: 'cursor', name: 'Cursor', scheme: 'cursor', bundles: ['Cursor'], command: 'cursor' },
  {
    id: 'windsurf',
    name: 'Windsurf',
    scheme: 'windsurf',
    bundles: ['Windsurf'],
    command: 'windsurf',
  },
  { id: 'zed', name: 'Zed', scheme: 'zed', bundles: ['Zed'], command: 'zed' },
  {
    id: 'sublime-text',
    name: 'Sublime Text',
    scheme: 'subl',
    bundles: ['Sublime Text'],
    command: 'subl',
  },
  { id: 'xcode', name: 'Xcode', bundles: ['Xcode'] },
  { id: 'nova', name: 'Nova', bundles: ['Nova'] },
  { id: 'bbedit', name: 'BBEdit', bundles: ['BBEdit'] },
  { id: 'textmate', name: 'TextMate', bundles: ['TextMate'] },
  {
    id: 'intellij-idea',
    name: 'IntelliJ IDEA',
    // The Toolbox names the bundle after the edition.
    bundles: [
      'IntelliJ IDEA',
      'IntelliJ IDEA Ultimate',
      'IntelliJ IDEA CE',
      'IntelliJ IDEA Community Edition',
    ],
    command: 'idea',
  },
  { id: 'webstorm', name: 'WebStorm', bundles: ['WebStorm'], command: 'webstorm' },
  {
    id: 'pycharm',
    name: 'PyCharm',
    bundles: ['PyCharm', 'PyCharm Professional Edition', 'PyCharm CE', 'PyCharm Community Edition'],
    command: 'pycharm',
  },
  { id: 'goland', name: 'GoLand', bundles: ['GoLand'], command: 'goland' },
  { id: 'rustrover', name: 'RustRover', bundles: ['RustRover'], command: 'rustrover' },
  { id: 'android-studio', name: 'Android Studio', bundles: ['Android Studio'] },
  { id: 'fleet', name: 'Fleet', bundles: ['Fleet'] },
]

const PATH_MAX_CHARS = 4_096
const ID_MAX_CHARS = 256
const NAME_MAX_CHARS = 256
const MAX_CUSTOM = 10
const DETECTION_TTL_MS = 60_000
const OPEN_TIMEOUT_MS = 15_000
const CUSTOM_PREFIX = 'custom:'

/** An editor found or chosen, with the program that starts it, which never leaves main. */
interface Editor {
  id: string
  name: string
  /** The `.app` bundle on macOS, the `.exe` on Windows, the command's file on Linux. */
  program: string
}

/** What editors.json holds. */
interface EditorsState {
  last: string | null
  /** The apps the user chose, most recent first. */
  custom: { id: string; name: string; path: string }[]
}

export type PathKind = 'file' | 'directory' | null

export interface EditorsOptions {
  /** `<userData>/editors.json`. */
  file: string
  platform?: Platform
  home?: string
  env?: Env
  /** What is at a path: a file, a folder, or null for nothing or anything else. */
  kind?(file: string): Promise<PathKind>
  /** Whether a file is a program the user may run. */
  isExecutable?(file: string): Promise<boolean>
  /** Starts `program` on `target`, resolving once it started. */
  launch?(program: string, target: string): Promise<void>
  now?(): number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pathApi(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

export async function pathKind(file: string): Promise<PathKind> {
  try {
    const info = await stat(file)
    if (info.isDirectory()) return 'directory'
    return info.isFile() ? 'file' : null
  } catch {
    return null
  }
}

/** A chosen app's id, the same for its path on every run; Windows paths ignore case. */
export function customId(program: string, platform: Platform): string {
  const key = platform === 'win32' ? program.toLowerCase() : program
  return `${CUSTOM_PREFIX}${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
}

function appName(program: string, platform: Platform): string {
  const base = pathApi(platform).basename(program)
  const extension = platform === 'darwin' ? '.app' : platform === 'win32' ? '.exe' : ''
  const named = extension !== '' && base.toLowerCase().endsWith(extension)
  return named && base.length > extension.length ? base.slice(0, -extension.length) : base
}

/** editors.json as read: entries that are not what main wrote are dropped. */
function parseState(raw: unknown, platform: Platform): EditorsState {
  const state: EditorsState = { last: null, custom: [] }
  if (typeof raw !== 'object' || raw === null) return state
  const { last, custom } = raw as Record<string, unknown>
  if (typeof last === 'string' && last.length > 0 && last.length <= ID_MAX_CHARS) state.last = last
  if (!Array.isArray(custom)) return state
  for (const item of custom) {
    if (state.custom.length === MAX_CUSTOM) break
    if (typeof item !== 'object' || item === null) continue
    const { name, path: program } = item as Record<string, unknown>
    if (
      typeof program !== 'string' ||
      program.length > PATH_MAX_CHARS ||
      program.includes('\0') ||
      !pathApi(platform).isAbsolute(program)
    ) {
      continue
    }
    const id = customId(program, platform)
    if (state.custom.some((known) => known.id === id)) continue
    const shown =
      typeof name === 'string' && name.length > 0 && name.length <= NAME_MAX_CHARS
        ? name
        : appName(program, platform)
    state.custom.push({ id, name: shown, path: program })
  }
  return state
}

async function appForScheme(scheme: string): Promise<string | null> {
  try {
    const info = await app.getApplicationInfoForProtocol(`${scheme}://`)
    return info.path || null
  } catch {
    return null // no app registers the scheme
  }
}

/** Main's environment, without what makes another Electron app run as Node.js or as Kettu. */
function launchEnv(env: Env): Env {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const name = key.toUpperCase()
      return !name.startsWith('ELECTRON_') && name !== 'CHROME_DESKTOP'
    }),
  )
}

function defaultLaunch(
  platform: Platform,
  env: Env,
): (program: string, target: string) => Promise<void> {
  if (platform === 'darwin') {
    return (program, target) =>
      new Promise((resolve, reject) => {
        execFile(
          '/usr/bin/open',
          ['-a', program, target],
          { timeout: OPEN_TIMEOUT_MS },
          (error, _stdout, stderr) => {
            if (error) reject(new Error(String(stderr).trim() || error.message))
            else resolve()
          },
        )
      })
  }
  return (program, target) =>
    new Promise((resolve, reject) => {
      const child = spawn(program, [target], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: launchEnv(env),
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
}

export class Editors {
  private readonly platform: Platform
  private readonly home: string
  private readonly env: Env
  private readonly kind: (file: string) => Promise<PathKind>
  private readonly isExecutable: (file: string) => Promise<boolean>
  private readonly launch: (program: string, target: string) => Promise<void>
  private readonly now: () => number
  private readonly writer: JsonFileWriter
  private state: Promise<EditorsState> | null = null
  private detected: { at: number; editors: Promise<Editor[]> } | null = null
  /** Each app's icon, by its path, for the app's life. */
  private readonly icons = new Map<string, Promise<string | null>>()

  constructor(private readonly options: EditorsOptions) {
    this.platform = options.platform ?? process.platform
    this.home = options.home ?? os.homedir()
    this.env = options.env ?? process.env
    this.kind = options.kind ?? pathKind
    this.isExecutable = options.isExecutable ?? ((file) => isExecutableFile(file, this.platform))
    this.launch = options.launch ?? defaultLaunch(this.platform, this.env)
    this.now = options.now ?? Date.now
    this.writer = new JsonFileWriter(options.file, log, 0)
  }

  async list(): Promise<EditorList> {
    const [editors, state] = await Promise.all([this.installed(), this.load()])
    return {
      editors: await Promise.all(editors.map((editor) => this.shown(editor))),
      last: editors.some((editor) => editor.id === state.last) ? state.last : null,
    }
  }

  /** Opens a file or folder in a listed editor, which becomes the last one. */
  async open(editorId: unknown, target: unknown): Promise<void> {
    if (typeof editorId !== 'string' || editorId.length === 0 || editorId.length > ID_MAX_CHARS) {
      throw new Error(`An editor id must be a string of 1 to ${ID_MAX_CHARS} characters`)
    }
    const file = await this.target(target)
    const editor = (await this.installed()).find((item) => item.id === editorId)
    if (!editor) throw new Error(`Unknown editor "${editorId}"`)
    await this.start(editor, file)
    await this.update((state) => ({ ...state, last: editor.id }))
  }

  /**
   * Asks for an app and opens a file or folder in it. An app the known editors do not list is
   * remembered, so `list` offers it after them. Null when the dialog was cancelled.
   */
  async choose(window: BrowserWindow | null, target: unknown): Promise<EditorApp | null> {
    const file = await this.target(target)
    const programs = t('dialogs.programs')
    const options: Electron.OpenDialogOptions = {
      title: t('dialogs.chooseEditor'),
      properties: ['openFile', 'dontAddToRecent'],
      ...(this.platform === 'darwin'
        ? { defaultPath: '/Applications', filters: [{ name: programs, extensions: ['app'] }] }
        : this.platform === 'win32'
          ? { filters: [{ name: programs, extensions: ['exe'] }] }
          : {}),
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const [picked] = result.filePaths
    if (result.canceled || !picked) return null
    if (!(await this.isApp(picked)))
      throw new Error(`"${picked}" is not an app that can be started`)

    const key = await this.canonical(picked)
    let editor: Editor | null = null
    for (const known of await this.knownEditors()) {
      if ((await this.canonical(known.program)) === key) {
        editor = known
        break
      }
    }
    const custom = editor === null
    const chosen = editor ?? {
      id: customId(picked, this.platform),
      name: appName(picked, this.platform),
      program: picked,
    }
    await this.start(chosen, file)
    await this.update((state) => ({
      last: chosen.id,
      custom: custom
        ? [
            { id: chosen.id, name: chosen.name, path: chosen.program },
            ...state.custom.filter((item) => item.id !== chosen.id),
          ].slice(0, MAX_CUSTOM)
        : state.custom,
    }))
    return this.shown(chosen)
  }

  /** Resolves once editors.json holds every change made so far. */
  async flush(): Promise<void> {
    await this.state
    await this.writer.flush()
  }

  /** The known editors installed, then the chosen apps still there, each once. */
  private async installed(): Promise<Editor[]> {
    const [known, state] = await Promise.all([this.knownEditors(), this.load()])
    const programs = new Set(known.map((editor) => editor.program))
    const custom = await Promise.all(
      state.custom.map(async (item) =>
        !programs.has(item.path) && (await this.isApp(item.path))
          ? { id: item.id, name: item.name, program: item.path }
          : null,
      ),
    )
    return [...known, ...custom.filter((editor) => editor !== null)]
  }

  private knownEditors(): Promise<Editor[]> {
    const now = this.now()
    if (!this.detected || now - this.detected.at >= DETECTION_TTL_MS) {
      this.detected = { at: now, editors: this.detect() }
    }
    return this.detected.editors
  }

  private async detect(): Promise<Editor[]> {
    const programs = await Promise.all(KNOWN_EDITORS.map((editor) => this.find(editor)))
    const seen = new Set<string>()
    const found: Editor[] = []
    KNOWN_EDITORS.forEach((editor, index) => {
      const program = programs[index]
      // Two schemes can lead to one app, which is listed once.
      if (!program || seen.has(program)) return
      seen.add(program)
      found.push({ id: editor.id, name: editor.name, program })
    })
    return found
  }

  /** Where a known editor is installed, or null when it is not. */
  private async find(editor: KnownEditor): Promise<string | null> {
    if (this.platform === 'darwin') {
      const registered = editor.scheme ? await appForScheme(editor.scheme) : null
      if (registered) return registered
      for (const folder of ['/Applications', path.posix.join(this.home, 'Applications')]) {
        for (const bundle of editor.bundles) {
          const file = path.posix.join(folder, `${bundle}.app`)
          if ((await this.kind(file)) === 'directory') return file
        }
      }
      return null
    }
    if (this.platform === 'win32') return editor.scheme ? appForScheme(editor.scheme) : null
    if (!editor.command) return null
    return findCommand(editor.command, {
      platform: this.platform,
      env: this.env,
      isExecutable: this.isExecutable,
    })
  }

  /** Whether a path is an app this system starts: a bundle, an `.exe`, or a program file. */
  private async isApp(file: string): Promise<boolean> {
    const extension = pathApi(this.platform).extname(file).toLowerCase()
    if (this.platform === 'darwin') {
      return extension === '.app' && (await this.kind(file)) === 'directory'
    }
    if (this.platform === 'win32') {
      return extension === '.exe' && (await this.kind(file)) === 'file'
    }
    return this.isExecutable(file)
  }

  private async canonical(file: string): Promise<string> {
    const real = await realpath(file).catch(() => pathApi(this.platform).resolve(file))
    return this.platform === 'win32' ? real.toLowerCase() : real
  }

  /** A path the page asks to open: untrusted input, so only an existing file or folder. */
  private async target(value: unknown): Promise<string> {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > PATH_MAX_CHARS ||
      value.includes('\0')
    ) {
      throw new Error(`A path to open must be a string of 1 to ${PATH_MAX_CHARS} characters`)
    }
    if (!path.isAbsolute(value)) throw new Error('A path to open must be absolute')
    if ((await this.kind(value)) === null) throw new Error(`"${value}" is not a file or folder`)
    return value
  }

  private async start(editor: Editor, file: string): Promise<void> {
    try {
      await this.launch(editor.program, file)
    } catch (error) {
      log.warn(`Could not open ${file} in ${editor.program}: ${messageOf(error)}`)
      throw new Error(`Could not open it in ${editor.name}: ${messageOf(error)}`, { cause: error })
    }
  }

  private async shown(editor: Editor): Promise<EditorApp> {
    return { id: editor.id, name: editor.name, icon: await this.icon(editor.program) }
  }

  private icon(program: string): Promise<string | null> {
    // Linux has no icon for a command, and GTK would give a file type's generic one.
    if (this.platform !== 'darwin' && this.platform !== 'win32') return Promise.resolve(null)
    let icon = this.icons.get(program)
    if (!icon) {
      // macOS's file icon is the generic one for every app; a thumbnail is the app's own.
      const read =
        this.platform === 'darwin'
          ? nativeImage.createThumbnailFromPath(program, { width: 32, height: 32 })
          : app.getFileIcon(program, { size: 'normal' })
      icon = read.then(
        (image) => (image.isEmpty() ? null : image.toDataURL()),
        (error: unknown) => {
          log.warn(`Could not read the icon of ${program}: ${messageOf(error)}`)
          return null
        },
      )
      this.icons.set(program, icon)
    }
    return icon
  }

  private load(): Promise<EditorsState> {
    this.state ??= readJsonFile(this.options.file).then((read) => {
      if (read.kind === 'ok') return parseState(read.value, this.platform)
      if (read.kind === 'unreadable') log.warn(`editors.json is unreadable: ${read.reason}`)
      return { last: null, custom: [] }
    })
    return this.state
  }

  /** Changes run in order, each on the state the one before left. */
  private update(change: (state: EditorsState) => EditorsState): Promise<EditorsState> {
    this.state = this.load().then((state) => {
      const next = change(state)
      this.writer.schedule(next)
      return next
    })
    return this.state
  }
}
