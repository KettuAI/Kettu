// Watches a project's folder while a window or device shows its files, and tells it when what the
// Files pane lists or shows may have changed on disk: inside git or outside it, after an agent's
// edit or another program's.

import { watch as fsWatch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { FileList } from '@shared/files'
import type { Platform } from '@shared/platform'
import type { WatchFn } from './git/watch'
import { pathKey } from './paths'

export interface FilesWatchesOptions {
  platform: Platform
  /** Tells a port that the project it named `projectPath` changed on disk. */
  changed(portId: string, projectPath: string): void
  log(level: 'warn', message: string): void
  /** One recursive watcher for the whole folder, else one per listed folder; by platform. */
  recursive?: boolean
  /** Quiet time before a change is reported. */
  debounceMs?: number
  /** A project's changes are reported at most once in this long, however steadily they come. */
  intervalMs?: number
  /** Folders watched one by one, where each needs a watcher of its own. */
  folderLimit?: number
  watch?: WatchFn
}

const DEBOUNCE_MS = 150
const INTERVAL_MS = 1000
// Shallow first, well inside Linux's default inotify watch limit.
const FOLDER_LIMIT = 2000

interface Watched {
  root: string
  /** The path each port named the project by. */
  ports: Map<string, string>
  watch: FolderWatch
}

/** The projects ports watch, each with one watch of its folder shared by every port. */
export class FilesWatches {
  private readonly projects = new Map<string, Watched>()

  constructor(private readonly options: FilesWatchesOptions) {}

  /** Starts telling the port about `root`, a canonical project path, which it named `named`. */
  add(root: string, portId: string, named: string): void {
    const key = pathKey(root, this.options.platform)
    let project = this.projects.get(key)
    if (!project) {
      project = { root, ports: new Map(), watch: this.start(key, root) }
      this.projects.set(key, project)
    } else if (!project.watch.alive) {
      project.watch.close()
      project.watch = this.start(key, root, project.watch)
    }
    project.ports.set(portId, named)
  }

  remove(root: string, portId: string): void {
    const key = pathKey(root, this.options.platform)
    const project = this.projects.get(key)
    if (!project?.ports.delete(portId) || project.ports.size > 0) return
    project.watch.close()
    this.projects.delete(key)
  }

  dropPort(portId: string): void {
    for (const project of [...this.projects.values()]) this.remove(project.root, portId)
  }

  /** What `files.list` gave for `root`, which tells the folders the tree shows. */
  listed(root: string, list: FileList): void {
    this.projects.get(pathKey(root, this.options.platform))?.watch.listed(list)
  }

  /** A folder read on its own, as an ignored one opened in the tree or one a file was read from. */
  read(root: string, folder: string): void {
    this.projects.get(pathKey(root, this.options.platform))?.watch.read(folder)
  }

  /** A file read for its tab, whose folder then counts wherever it is in the tree. */
  opened(root: string, file: string): void {
    this.read(root, file.split(/[\\/]/).filter(Boolean).slice(0, -1).join('/'))
  }

  stop(): void {
    for (const project of this.projects.values()) project.watch.close()
    this.projects.clear()
  }

  private start(key: string, root: string, before?: FolderWatch): FolderWatch {
    const { platform } = this.options
    const watch = new FolderWatch({
      root,
      recursive: this.options.recursive ?? (platform === 'darwin' || platform === 'win32'),
      debounceMs: this.options.debounceMs ?? DEBOUNCE_MS,
      intervalMs: this.options.intervalMs ?? INTERVAL_MS,
      folderLimit: this.options.folderLimit ?? FOLDER_LIMIT,
      watch: this.options.watch ?? (fsWatch as unknown as WatchFn),
      onChange: () => {
        const project = this.projects.get(key)
        if (!project) return
        for (const [portId, named] of project.ports) this.options.changed(portId, named)
      },
      onError: (error) =>
        this.options.log('warn', `Watching the files of ${root} failed: ${error.message}`),
    })
    if (before) watch.takeFrom(before)
    return watch
  }
}

interface FolderWatchOptions {
  root: string
  recursive: boolean
  debounceMs: number
  intervalMs: number
  folderLimit: number
  watch: WatchFn
  onChange(): void
  onError(error: Error): void
}

/** One project folder's watchers and the rules for which of their changes count. */
class FolderWatch {
  private readonly watchers = new Map<string, FSWatcher>()
  private recursive: boolean
  private closed = false
  private dead = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private burstStart = 0
  private lastFired = 0
  /** Folders the last list leaves unread, as a whole: ignored ones. */
  private ignored = new Set<string>()
  /** Folders the last list names or holds files in; null until a list arrives. */
  private listedFolders: Set<string> | null = null
  /** Folders read on their own, whose direct entries count wherever they are. */
  private readonly readFolders = new Set<string>()

  constructor(private readonly options: FolderWatchOptions) {
    this.recursive = options.recursive
    if (this.recursive) {
      try {
        this.add('', true)
        return
      } catch {
        // Recursive watching is not available here; each folder gets its own watcher.
        this.recursive = false
      }
    }
    this.reconcile()
  }

  get alive(): boolean {
    return !this.dead && !this.closed
  }

  /** Takes over what a watch that failed knew of the folder. */
  takeFrom(before: FolderWatch): void {
    this.ignored = before.ignored
    this.listedFolders = before.listedFolders
    for (const folder of before.readFolders) this.readFolders.add(folder)
    if (!this.recursive) this.reconcile()
  }

  listed(list: FileList): void {
    this.ignored = new Set(list.ignoredFolders ?? [])
    const folders = new Set<string>()
    const addParents = (entry: string): void => {
      for (
        let slash = entry.lastIndexOf('/');
        slash > 0;
        slash = entry.lastIndexOf('/', slash - 1)
      ) {
        const folder = entry.slice(0, slash)
        if (folders.has(folder)) return
        folders.add(folder)
      }
    }
    for (const file of list.paths) addParents(file)
    for (const file of list.ignored ?? []) addParents(file)
    for (const folder of list.ignoredFolders ?? []) addParents(folder)
    for (const folder of list.folders) {
      folders.add(folder)
      addParents(folder)
    }
    this.listedFolders = folders
    if (!this.recursive) this.reconcile()
  }

  read(folder: string): void {
    const normal = folder.split(/[\\/]/).filter(Boolean).join('/')
    if (this.readFolders.has(normal)) return
    this.readFolders.add(normal)
    if (!this.recursive) this.reconcile()
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  /** Whether a change to the entry at `relative` can change what the tree lists or shows. */
  private counts(relative: string): boolean {
    const segments = relative.split(/[\\/]/).filter((s) => s !== '' && s !== '.')
    return segments.length === 0 || this.shows(segments.slice(0, -1))
  }

  /** Whether the tree shows what is directly in the folder of these segments. */
  private shows(folder: string[]): boolean {
    if (folder.includes('.git')) return false
    if (this.readFolders.has(folder.join('/'))) return true
    if (folder.includes('node_modules')) return false
    let prefix = ''
    for (const segment of folder) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`
      if (this.ignored.has(prefix)) return false
    }
    return true
  }

  /** In a watcher per folder: the folders the tree shows, shallow first, as many as allowed. */
  private wanted(): string[] {
    const candidates = new Set<string>([''])
    for (const folder of this.listedFolders ?? []) candidates.add(folder)
    for (const folder of this.readFolders) candidates.add(folder)
    const shown = [...candidates].filter((folder) =>
      this.shows(folder === '' ? [] : folder.split('/')),
    )
    const depth = (folder: string) => (folder === '' ? 0 : folder.split('/').length)
    shown.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
    return shown.slice(0, this.options.folderLimit)
  }

  private reconcile(): void {
    if (this.closed || this.dead) return
    const wanted = new Set(this.wanted())
    for (const [folder, watcher] of this.watchers) {
      if (wanted.has(folder)) continue
      watcher.close()
      this.watchers.delete(folder)
    }
    for (const folder of wanted) {
      if (this.watchers.has(folder)) continue
      try {
        this.add(folder, false)
      } catch (error) {
        // Only the project's own folder must be watchable; one gone shows in the next list.
        if (folder === '') this.fail(error)
      }
    }
  }

  private add(folder: string, recursive: boolean): void {
    const at = folder === '' ? this.options.root : path.join(this.options.root, folder)
    const watcher = this.options.watch(at, { recursive, persistent: false }, (_event, name) => {
      const entry = name === null ? null : name.toString()
      if (entry === null || entry === '') return this.trigger()
      if (this.counts(folder === '' ? entry : `${folder}/${entry}`)) this.trigger()
    })
    watcher.on('error', (error: Error) => {
      watcher.close()
      if (this.watchers.get(folder) === watcher) this.watchers.delete(folder)
      if (folder === '') this.fail(error)
      else this.trigger()
    })
    this.watchers.set(folder, watcher)
  }

  private fail(error: unknown): void {
    this.dead = true
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.options.onError(error instanceof Error ? error : new Error(String(error)))
    // What the folder holds now is read once more, so the pane shows it, or why it cannot.
    this.trigger()
  }

  private trigger(): void {
    if (this.closed) return
    const now = Date.now()
    if (this.timer === null) this.burstStart = now
    else clearTimeout(this.timer)
    const { debounceMs, intervalMs } = this.options
    const due = Math.max(
      Math.min(now + debounceMs, this.burstStart + intervalMs),
      this.lastFired + intervalMs,
    )
    this.timer = setTimeout(() => this.fire(), Math.max(0, due - now))
    this.timer.unref()
  }

  private fire(): void {
    this.timer = null
    if (this.closed) return
    this.lastFired = Date.now()
    this.options.onChange()
  }
}
