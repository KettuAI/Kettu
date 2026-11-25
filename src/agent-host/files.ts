// A project's files for the Files pane: listed, read and searched through git when the project
// is in a repository, and through a bounded walk of the folder when it is not.

import { createHash, randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import path from 'node:path'
import {
  FILE_LIST_LIMIT,
  FILE_MATCH_CHARS,
  FILE_READ_LIMIT,
  FILE_SEARCH_LIMIT,
  type DeviceFileContent,
  type FileContent,
  type FileList,
  type FileMatch,
  type FileSearch,
  type FileWritten,
  type FolderList,
} from '@shared/files'
import type { MediaFile, MediaGrant } from '@shared/media'
import type { Platform } from '@shared/platform'
import { HostError, invalidParams, notFound } from './errors'
import { commandFailureText, GIT_TIMEOUT_MS, type Exec, type ExecResult } from './git/exec'
import { t } from './i18n'
import { isAbsolutePath, pathKey } from './paths'

export interface FilesLimits {
  list: number
  read: number
  search: number
  matchChars: number
  /** Files the search reads when the project is not in a repository. */
  scanFiles: number
  /** Directory levels below the project the walk reads. */
  depth: number
  /** Empty folders the list names. */
  folders: number
  /** Entries read on disk to find empty folders among the ones git names untracked. */
  folderScan: number
}

const DEFAULT_LIMITS: FilesLimits = {
  list: FILE_LIST_LIMIT,
  read: FILE_READ_LIMIT,
  search: FILE_SEARCH_LIMIT,
  matchChars: FILE_MATCH_CHARS,
  scanFiles: 5_000,
  depth: 20,
  folders: 5_000,
  folderScan: 20_000,
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024
// The same prefix git looks at to call a file binary.
const BINARY_PROBE_BYTES = 8_000
const SCAN_BATCH = 16
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules'])
const EMPTY_SEARCH: FileSearch = { matches: [], truncated: false }
// Copies named after a taken name: `name copy.ext`, then `name copy 2.ext` and on.
const COPY_NAMES = 1_000
// Folders one `git check-ignore` is asked about, short of any command line's limit.
const IGNORE_BATCH = 100

export interface FilesServiceDeps {
  /** Runs git; it must give git the agent environment. */
  exec: Exec
  platform: Platform
  /** A grant on the media scheme for a file at its real path, or null when it is no media or document. */
  media(real: string, info: Stats): Promise<MediaGrant | null>
  /** The same file described as media or a document for a paired device, granting nothing. */
  describeMedia(real: string, info: Stats): Promise<Omit<MediaFile, 'path'> | null>
  /** Moves these absolute paths to the system's trash; throws when it could not. */
  trash(paths: string[]): Promise<void>
  /** Replaces the default limits, for tests. */
  limits?: Partial<FilesLimits>
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortedUnique(paths: string[]): string[] {
  paths.sort(byCodeUnit)
  return paths.filter((value, index) => index === 0 || value !== paths[index - 1])
}

/**
 * The output of a git command that succeeded; null when git cannot answer here, because it
 * is not installed or the folder is not in a repository; any other failure throws.
 */
function gitOutput(label: string, result: ExecResult): string | null {
  if (result.failure === 'not-found') return null
  if (result.failure === 'cwd-missing') throw notFound(t('files.projectMissing'))
  if (result.failure !== null) throw new HostError('git_error', commandFailureText(label, result))
  return result.code === 0 ? result.stdout : null
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** The text of `bytes`, and whether writing it back as UTF-8 gives the same bytes. */
function decode(bytes: Buffer): { text: string; editable: boolean } {
  try {
    return { text: utf8.decode(bytes), editable: true }
  } catch {
    return { text: bytes.toString('utf8'), editable: false }
  }
}

const versionOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

// Windows refuses to replace a file another program holds open; a write in place still works.
const RENAME_REFUSED: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)
}

export async function readBytes(handle: FileHandle, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return buffer.subarray(0, filled)
}

/** A line as a match shows it: without its line end and cut to `chars` characters. */
function cutLine(line: string, chars: number): string {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  if (text.length <= chars) return text
  // Do not leave half of a surrogate pair at the cut.
  const end = /[\uD800-\uDBFF]/.test(text[chars - 1] ?? '') ? chars - 1 : chars
  return text.slice(0, end)
}

/** Parses `git grep -z -n` output: `path NUL line NUL text LF`, in that order. */
function parseGrep(output: string, limit: number, chars: number): FileSearch {
  const matches: FileMatch[] = []
  let at = 0
  while (at < output.length) {
    const pathEnd = output.indexOf('\0', at)
    if (pathEnd < 0) break
    const lineEnd = output.indexOf('\0', pathEnd + 1)
    if (lineEnd < 0) break
    const textEnd = output.indexOf('\n', lineEnd + 1)
    // The output was cut inside this record.
    if (textEnd < 0) break
    if (matches.length >= limit) return { matches, truncated: true }
    matches.push({
      path: output.slice(at, pathEnd),
      line: Number(output.slice(pathEnd + 1, lineEnd)),
      text: cutLine(output.slice(lineEnd + 1, textEnd), chars),
    })
    at = textEnd + 1
  }
  return { matches, truncated: false }
}

/** The name of the `n`th copy of `name`: `a copy.ts`, `a copy 2.ts`; a folder keeps no extension. */
export function copyName(name: string, n: number, folder: boolean): string {
  const dot = folder ? -1 : name.lastIndexOf('.')
  // A leading dot starts a name such as `.env`, not an extension.
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  return `${stem} copy${n > 1 ? ` ${n}` : ''}${extension}`
}

const nameOf = (relative: string): string => relative.slice(relative.lastIndexOf('/') + 1)

const folderOf = (relative: string): string => {
  const slash = relative.lastIndexOf('/')
  return slash < 0 ? '' : relative.slice(0, slash)
}

const isGone = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export class FilesService {
  private readonly limits: FilesLimits
  private readonly paths: path.PlatformPath

  constructor(private readonly deps: FilesServiceDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits }
    this.paths = deps.platform === 'win32' ? path.win32 : path.posix
  }

  /** The files under `root`, relative and sorted. `root` is a canonical project path. */
  async list(root: string): Promise<FileList> {
    const [listed, deleted, untracked, excluded] = await Promise.all([
      this.git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
      this.git(root, ['ls-files', '-z', '--deleted']),
      // Untracked folders, each once as `name/` however much it holds, where empty ones may be.
      this.git(root, ['ls-files', '-z', '--others', '--directory', '--exclude-standard']),
      // An ignored folder once as `name/`, which git does not go into.
      this.git(root, [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--directory',
        '--exclude-standard',
      ]),
    ])
    const files = gitOutput('git ls-files', listed)
    const gone = gitOutput('git ls-files --deleted', deleted)
    const folders = gitOutput('git ls-files --directory', untracked)
    const ignored = gitOutput('git ls-files --ignored', excluded)
    if (files === null || gone === null || folders === null || ignored === null) {
      return this.walk(root, this.limits.list)
    }
    const missing = new Set(gone.split('\0'))
    // A nested repository is listed as a folder, with a trailing slash.
    const paths = sortedUnique(
      files.split('\0').filter((p) => p !== '' && !p.endsWith('/') && !missing.has(p)),
    )
    // A folder whose tracked files are all gone from disk is no untracked folder to git.
    const emptied = this.foldersWithout(gone.split('\0'), paths)
    const empty = await this.emptyFolders(root, [...folders.split('\0'), ...emptied])
    const truncated = paths.length > this.limits.list
    const kept = truncated ? paths.slice(0, this.limits.list) : paths
    // Git names the project's own folder when it ignores all of it, so nothing else is listed.
    if (ignored.split('\0').includes('./')) {
      const top = await this.realRoot(root)
      const own = await this.children(top, top, '')
      return {
        paths: kept,
        folders: empty,
        ignored: own.files,
        ignoredFolders: own.folders,
        truncated: truncated || own.truncated,
      }
    }
    const left = this.ignoredEntries(ignored, this.limits.list - kept.length)
    return {
      paths: kept,
      folders: empty,
      ignored: left.files,
      ignoredFolders: left.folders,
      truncated: truncated || left.truncated,
    }
  }

  /**
   * The ignored files and folders in `git ls-files --ignored --directory` output, at most `limit`
   * of them. Git also names, as `name/`, an untracked folder it went into because only ignored
   * entries are in it; that folder is no ignored one, and what it holds follows it in the output.
   */
  private ignoredEntries(
    output: string,
    limit: number,
  ): { files: string[]; folders: string[]; truncated: boolean } {
    const entries = sortedUnique(output.split('\0').filter((entry) => entry !== ''))
    const files: string[] = []
    const folders: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      const folder = entry.endsWith('/')
      if (folder && entries[i + 1]?.startsWith(entry)) continue
      if (files.length + folders.length >= limit) return { files, folders, truncated: true }
      if (folder) folders.push(entry.slice(0, -1))
      else files.push(entry)
    }
    return { files, folders, truncated: false }
  }

  /**
   * The outermost folders above the `deleted` paths that hold none of the sorted `paths`, as
   * `name/`, where what was deleted may have left empty folders.
   */
  private foldersWithout(deleted: string[], paths: readonly string[]): string[] {
    const folders = new Set<string>()
    for (const path of deleted) {
      for (let slash = path.indexOf('/'); slash > 0; slash = path.indexOf('/', slash + 1)) {
        const folder = path.slice(0, slash + 1)
        if (this.holdsListed(paths, folder)) continue
        folders.add(folder)
        break
      }
    }
    return [...folders]
  }

  /** Whether a path of the sorted `paths` starts with `prefix`. */
  private holdsListed(paths: readonly string[], prefix: string): boolean {
    let low = 0
    let high = paths.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (paths[mid]! < prefix) low = mid + 1
      else high = mid
    }
    return paths[low]?.startsWith(prefix) ?? false
  }

  /**
   * The folders empty on disk under git's untracked `candidates`, leaving out what git ignores
   * and nested repositories, whose files the list leaves out too.
   */
  private async emptyFolders(root: string, candidates: string[]): Promise<string[]> {
    const found: string[] = []
    let budget = this.limits.folderScan
    const full = () => budget <= 0 || found.length >= this.limits.folders
    const scan = async (folder: string, depth: number): Promise<void> => {
      let entries
      try {
        entries = await readdir(this.paths.join(root, folder), { withFileTypes: true })
      } catch {
        return
      }
      budget -= entries.length
      if (entries.length === 0) {
        found.push(folder)
        return
      }
      if (depth >= this.limits.depth || entries.some((entry) => entry.name === '.git')) return
      for (const entry of entries) {
        if (full()) return
        if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
          await scan(`${folder}/${entry.name}`, depth + 1)
        }
      }
    }
    for (const candidate of candidates) {
      if (full()) break
      const folder = candidate.endsWith('/') ? candidate.slice(0, -1) : ''
      if (folder !== '') await scan(folder, folder.split('/').length)
    }
    const ignored = new Set<string>()
    for (let from = 0; from < found.length; from += IGNORE_BATCH) {
      const batch = found.slice(from, from + IGNORE_BATCH)
      // `-z` takes only `--stdin`, so paths come one a line; one git cannot check is left out.
      const result = await this.git(root, ['check-ignore', '--', ...batch])
      if (result.failure !== null || (result.code !== 0 && result.code !== 1)) {
        for (const folder of batch) ignored.add(folder)
        continue
      }
      for (const line of result.stdout.split('\n')) ignored.add(line.replace(/\/$/, ''))
    }
    return sortedUnique(found.filter((folder) => !ignored.has(folder)))
  }

  /**
   * The files and folders directly in a folder of the project, sorted, leaving out `.git`. A link
   * to a file is a file; a link to a folder is a folder only while it stays in the project.
   */
  async listFolder(root: string, relativePath: string): Promise<FolderList> {
    const relative = this.editable(relativePath)
    return this.children(await this.realRoot(root), await this.folder(root, relative), relative)
  }

  /**
   * What `listFolder` gives for the folder at the real path `real`, '' being the project's own;
   * `top` is the project's real path.
   */
  private async children(top: string, real: string, relative: string): Promise<FolderList> {
    let entries
    try {
      entries = await readdir(real, { withFileTypes: true })
    } catch (error) {
      throw this.fsError(error, relative)
    }
    entries.sort((a, b) => byCodeUnit(a.name, b.name))
    const files: string[] = []
    const folders: string[] = []
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const kind = entry.isSymbolicLink()
        ? await this.linkKind(top, this.paths.join(real, entry.name))
        : entry.isDirectory()
          ? 'folder'
          : entry.isFile()
            ? 'file'
            : null
      if (kind === null) continue
      if (files.length + folders.length >= this.limits.list) {
        return { files, folders, truncated: true }
      }
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (kind === 'folder') folders.push(path)
      else files.push(path)
    }
    return { files, folders, truncated: false }
  }

  /** What a link leads to: a file, a folder in the project at `top`, or nothing to list. */
  private async linkKind(top: string, link: string): Promise<'file' | 'folder' | null> {
    try {
      const info = await stat(link)
      if (info.isFile()) return 'file'
      if (!info.isDirectory()) return null
      return this.within(top, await realpath(link)) ? 'folder' : null
    } catch {
      return null
    }
  }

  /**
   * A file's text, or its grant when it is media or a document, or why there is none.
   * `relativePath` uses `/` between segments. A file named as media is one only if its first
   * bytes say so; `asText` reads
   * it as any other file. A paired `device` gets media described instead of granted.
   */
  read(root: string, relativePath: string, asText?: boolean): Promise<FileContent>
  read(
    root: string,
    relativePath: string,
    asText: boolean | undefined,
    device: boolean,
  ): Promise<FileContent | DeviceFileContent>
  async read(
    root: string,
    relativePath: string,
    asText = false,
    device = false,
  ): Promise<FileContent | DeviceFileContent> {
    const relative = this.normalize(relativePath)
    const real = await this.resolveInside(root, relative)
    const info = await this.fileStat(real, relative)
    if (!asText && device) {
      const media = await this.deps.describeMedia(real, info)
      if (media) return { kind: 'media', path: relative, media }
    } else if (!asText) {
      const grant = await this.deps.media(real, info)
      if (grant) return { kind: 'media', path: relative, grant }
    }
    return this.content(real, relative, info)
  }

  /**
   * The regular file at `real`, a real path the caller has allowed, read as `read` reads a file
   * named as no media, under the name `shown`.
   */
  async readAllowed(real: string, shown: string): Promise<FileContent> {
    return this.content(real, shown, await this.fileStat(real, shown))
  }

  private async content(real: string, shown: string, info: Stats): Promise<FileContent> {
    const { size } = info
    if (size > this.limits.read) {
      return { kind: 'too-large', path: shown, size, limit: this.limits.read }
    }
    const bytes = await this.readFile(real, size)
    if (isBinary(bytes)) return { kind: 'binary', path: shown, size }
    return { kind: 'text', path: shown, size, ...decode(bytes), version: versionOf(bytes) }
  }

  /**
   * A file or folder of the project for an `@` mention, checked as `read` checks a path: its path
   * under `root`, as the project names it, and what it is.
   */
  async locate(
    root: string,
    relativePath: string,
  ): Promise<{ path: string; kind: 'file' | 'folder' }> {
    const relative = this.normalize(relativePath)
    const real = await this.resolveInside(root, relative)
    let info
    try {
      info = await stat(real)
    } catch (error) {
      throw this.fsError(error, relative)
    }
    if (!info.isFile() && !info.isDirectory()) {
      throw invalidParams(t('files.notFileOrFolder', { path: relative }))
    }
    return {
      path: this.paths.join(root, ...relative.split('/')),
      kind: info.isDirectory() ? 'folder' : 'file',
    }
  }

  /**
   * Replaces the text of a file that exists. With a `version`, the file must still have it, or
   * nothing is written and the answer is `conflict`; null writes regardless.
   */
  async write(
    root: string,
    relativePath: string,
    text: string,
    version: string | null,
  ): Promise<FileWritten> {
    const relative = this.normalize(relativePath)
    if (relative.split('/').includes('.git'))
      throw invalidParams(t('files.insideGit', { path: relative }))
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > this.limits.read) {
      throw invalidParams(t('files.textTooLarge', { bytes: this.limits.read }))
    }
    const real = await this.resolveInside(root, relative)
    const info = await this.fileStat(real, relative)
    if (version !== null) {
      const current = info.size > this.limits.read ? null : await this.readFile(real, info.size)
      if (current === null || versionOf(current) !== version) {
        throw new HostError('conflict', t('files.changedSinceRead', { path: relative }))
      }
    }
    // A rename would leave the other names of a hard-linked file with the old text.
    if (info.nlink > 1) await this.writeInPlace(real, bytes)
    else await this.replace(real, bytes, info.mode)
    return { version: versionOf(bytes), size: bytes.length }
  }

  /** A new empty file or folder at `relativePath`, with the folders above it made when missing. */
  async create(root: string, relativePath: string, kind: 'file' | 'folder'): Promise<void> {
    const relative = this.editable(relativePath)
    const parent = await this.makeFolders(root, folderOf(relative))
    const target = this.paths.join(parent, nameOf(relative))
    try {
      if (kind === 'folder') await mkdir(target)
      else await (await open(target, 'wx', 0o666)).close()
    } catch (error) {
      throw this.taken(error, relative)
    }
  }

  /**
   * Moves the entry at `from` to `to`: a link itself, never what it points to. A name that only
   * changes case is the same entry on a file system that ignores case, and is renamed.
   */
  async rename(root: string, from: string, to: string): Promise<void> {
    const source = this.editable(from)
    const target = this.editable(to)
    if (source === target) return
    const real = await this.entry(root, source)
    const info = await this.entryStat(real, source)
    if (info.isDirectory() && target.startsWith(`${source}/`)) {
      throw invalidParams(t('files.moveIntoItself', { path: source }))
    }
    const parent = await this.makeFolders(root, folderOf(target))
    if (info.isDirectory() && this.within(real, parent)) {
      throw invalidParams(t('files.moveIntoItself', { path: source }))
    }
    const destination = this.paths.join(parent, nameOf(target))
    const there = await lstat(destination).catch((error: unknown) => {
      if (isGone(error)) return null
      throw error
    })
    // Only a change of case finds the entry itself there; another name of a hard link does not.
    const itself =
      there !== null &&
      there.ino === info.ino &&
      there.dev === info.dev &&
      nameOf(source).toLowerCase() === nameOf(target).toLowerCase()
    if (there && !itself)
      throw new HostError('conflict', t('files.alreadyExists', { path: target }))
    await rename(real, destination)
  }

  /**
   * Copies each of `relativePaths` into `folder` ('' for the project's own), naming a copy whose
   * name is taken there `name copy.ext`. Links are copied as links. The copies' paths, in order.
   */
  async copy(root: string, relativePaths: string[], folder: string): Promise<string[]> {
    const into = this.normalizeFolder(folder)
    if (into.split('/').includes('.git')) throw invalidParams(t('files.insideGit', { path: into }))
    const parent = await this.folder(root, into)
    const copies: string[] = []
    for (const relativePath of relativePaths) {
      const source = this.editable(relativePath)
      const real = await this.entry(root, source)
      const info = await this.entryStat(real, source)
      if (info.isDirectory() && this.within(real, parent)) {
        throw invalidParams(t('files.copyIntoItself', { path: source }))
      }
      const name = await this.freeName(parent, nameOf(source), info.isDirectory())
      await cp(real, this.paths.join(parent, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      })
      copies.push(into === '' ? name : `${into}/${name}`)
    }
    return copies
  }

  /** Moves each entry to the system's trash, or removes it for good; one already gone is skipped. */
  async delete(root: string, relativePaths: string[], permanently: boolean): Promise<void> {
    const entries: string[] = []
    for (const relativePath of relativePaths) {
      const relative = this.editable(relativePath)
      let real: string
      try {
        real = await this.entry(root, relative)
        await lstat(real)
      } catch (error) {
        if (error instanceof HostError && error.code === 'not_found') continue
        if (isGone(error)) continue
        throw error
      }
      entries.push(real)
    }
    if (entries.length === 0) return
    if (!permanently) return this.deps.trash(entries)
    for (const real of entries) await rm(real, { recursive: true, force: true })
  }

  /** Lines that contain `query`, ignoring case. The query is literal text, not a pattern. */
  async search(root: string, query: string): Promise<FileSearch> {
    if (query === '') throw invalidParams('query must not be empty')
    // Matching is by line, and git would take a line break as two patterns.
    if (/[\r\n]/.test(query)) return EMPTY_SEARCH
    const result = await this.git(root, [
      'grep',
      '-z',
      '-n',
      '-I',
      '-i',
      '-F',
      '--untracked',
      '--exclude-standard',
      '--no-color',
      '-e',
      query,
      '--',
    ])
    if (result.failure === 'max-buffer') {
      return {
        ...parseGrep(result.stdout, this.limits.search, this.limits.matchChars),
        truncated: true,
      }
    }
    // Without --full-name the paths are relative to `root`, which may be below the repository's top.
    if (result.failure === null && result.code === 1) return EMPTY_SEARCH
    const output = gitOutput('git grep', result)
    if (output === null) return this.scan(root, query)
    return parseGrep(output, this.limits.search, this.limits.matchChars)
  }

  private git(root: string, args: string[]): Promise<ExecResult> {
    return this.deps.exec('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    })
  }

  /** Breadth-first, so a cut at the limit keeps the shallow files. */
  private async walk(root: string, limit: number): Promise<FileList> {
    const paths: string[] = []
    const folders: string[] = []
    const result = (truncated: boolean): FileList => ({
      paths: sortedUnique(paths),
      folders: sortedUnique(folders),
      truncated,
    })
    let level = ['']
    for (let depth = 0; level.length > 0 && depth <= this.limits.depth; depth++) {
      const next: string[] = []
      for (const directory of level) {
        let entries
        try {
          entries = await readdir(this.paths.join(root, directory), { withFileTypes: true })
        } catch (error) {
          // Only the project folder itself must be readable.
          if (directory === '') throw this.fsError(error, root)
          continue
        }
        if (entries.length === 0 && directory !== '' && folders.length < this.limits.folders) {
          folders.push(directory)
        }
        for (const entry of entries) {
          const relative = directory === '' ? entry.name : `${directory}/${entry.name}`
          if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name)) next.push(relative)
            continue
          }
          // A symbolic link to a folder is not followed; one to a file is a file.
          const isFile =
            entry.isFile() || (entry.isSymbolicLink() && (await this.linksToFile(root, relative)))
          if (!isFile) continue
          if (paths.length >= limit) return result(true)
          paths.push(relative)
        }
      }
      level = next
    }
    return result(false)
  }

  private async linksToFile(root: string, relative: string): Promise<boolean> {
    try {
      return (await stat(this.paths.join(root, relative))).isFile()
    } catch {
      return false
    }
  }

  /** Search for a project that git cannot answer for: reads the walk's files one by one. */
  private async scan(root: string, query: string): Promise<FileSearch> {
    const { paths, truncated: partial } = await this.walk(root, this.limits.scanFiles)
    const needle = query.toLowerCase()
    const matches: FileMatch[] = []
    for (let from = 0; from < paths.length; from += SCAN_BATCH) {
      const batch = await Promise.all(
        paths.slice(from, from + SCAN_BATCH).map((file) => this.scanFile(root, file, needle)),
      )
      for (const found of batch) {
        for (const match of found) {
          if (matches.length >= this.limits.search) return { matches, truncated: true }
          matches.push(match)
        }
      }
    }
    return { matches, truncated: partial }
  }

  /** Up to one more match than the search limit, so the caller can tell it was exceeded. */
  private async scanFile(root: string, relative: string, needle: string): Promise<FileMatch[]> {
    let bytes: Buffer
    try {
      const real = await this.resolveInside(root, relative)
      const info = await stat(real)
      if (!info.isFile() || info.size > this.limits.read) return []
      bytes = await this.readFile(real, info.size)
    } catch {
      // Like grep, skip what cannot be read: it vanished, or it points out of the project.
      return []
    }
    if (isBinary(bytes)) return []
    const found: FileMatch[] = []
    const lines = bytes.toString('utf8').split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      if (!line.toLowerCase().includes(needle)) continue
      found.push({ path: relative, line: index + 1, text: cutLine(line, this.limits.matchChars) })
      if (found.length > this.limits.search) break
    }
    return found
  }

  /** The path as `/`-separated segments, or `invalid_params` when it could leave the project. */
  private normalize(value: string): string {
    const windows = this.deps.platform === 'win32'
    if (value.includes('\0')) throw invalidParams(t('files.pathNul'))
    if (
      isAbsolutePath(value, this.deps.platform) ||
      value.startsWith('/') ||
      (windows && value.startsWith('\\'))
    ) {
      throw invalidParams(t('files.pathNotRelative'))
    }
    const segments = value.split(windows ? /[\\/]/ : '/').filter((s) => s !== '' && s !== '.')
    if (segments.includes('..')) throw invalidParams(t('files.pathDotDot'))
    // A colon on Windows is a drive or an alternate data stream.
    if (windows && segments.some((segment) => segment.includes(':'))) {
      throw invalidParams(t('files.pathNotRelative'))
    }
    if (segments.length === 0) throw invalidParams(t('files.pathNoName'))
    return segments.join('/')
  }

  /** A path an operation may change: not the project itself and nothing in `.git`. */
  private editable(value: string): string {
    const relative = this.normalize(value)
    if (relative.split('/').includes('.git'))
      throw invalidParams(t('files.insideGit', { path: relative }))
    return relative
  }

  /** A folder's path as `normalize` gives it, with '' for the project's own. */
  private normalizeFolder(value: string): string {
    return value === '' || value === '.' ? '' : this.normalize(value)
  }

  /** The real path of a folder of the project, '' for the project itself. */
  private async folder(root: string, relative: string): Promise<string> {
    const real =
      relative === '' ? await this.realRoot(root) : await this.resolveInside(root, relative)
    const info = await stat(real).catch((error: unknown) => {
      throw this.fsError(error, relative)
    })
    if (!info.isDirectory()) throw invalidParams(t('files.notFolder', { path: relative }))
    return real
  }

  private async realRoot(root: string): Promise<string> {
    try {
      return await realpath(root)
    } catch (error) {
      throw this.fsError(error, root)
    }
  }

  /**
   * Where the entry at `relative` is, without following a link at its end: its folder's real
   * path, which must be in the project, and its own name.
   */
  private async entry(root: string, relative: string): Promise<string> {
    return this.paths.join(await this.folder(root, folderOf(relative)), nameOf(relative))
  }

  private async entryStat(real: string, relative: string): Promise<Stats> {
    try {
      return await lstat(real)
    } catch (error) {
      throw this.fsError(error, relative)
    }
  }

  /** The real path of `relative`, a folder of the project, making the folders that are missing. */
  private async makeFolders(root: string, relative: string): Promise<string> {
    const top = await this.realRoot(root)
    let real = top
    for (const segment of relative === '' ? [] : relative.split('/')) {
      const next = this.paths.join(real, segment)
      try {
        await mkdir(next)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
      }
      // What was there may be a link: it must lead to a folder in the project.
      real = await realpath(next)
      if (!this.within(top, real))
        throw invalidParams(t('files.outsideProject', { path: relative }))
      if (!(await stat(real)).isDirectory())
        throw invalidParams(t('files.notFolder', { path: relative }))
    }
    return real
  }

  /** `name`, or the first of its copy names that nothing in `folder` has. */
  private async freeName(folder: string, name: string, isFolder: boolean): Promise<string> {
    for (let n = 0; n <= COPY_NAMES; n++) {
      const candidate = n === 0 ? name : copyName(name, n, isFolder)
      try {
        await lstat(this.paths.join(folder, candidate))
      } catch (error) {
        if (isGone(error)) return candidate
        throw error
      }
    }
    throw new HostError('conflict', t('files.tooManyCopies', { name }))
  }

  /** Whether the real path `inner` is `outer` or inside it. */
  private within(outer: string, inner: string): boolean {
    const outerKey = pathKey(outer, this.deps.platform)
    const innerKey = pathKey(inner, this.deps.platform)
    const prefix = outerKey.endsWith(this.paths.sep) ? outerKey : outerKey + this.paths.sep
    return innerKey === outerKey || innerKey.startsWith(prefix)
  }

  private taken(error: unknown, relative: string): Error {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
      return new HostError('conflict', t('files.alreadyExists', { path: relative }))
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  /** The real path of `relative` under `root`; a symbolic link must not lead out of `root`. */
  private async resolveInside(root: string, relative: string): Promise<string> {
    let real: string
    try {
      real = await realpath(this.paths.resolve(root, relative))
    } catch (error) {
      throw this.fsError(error, relative)
    }
    const rootKey = pathKey(root, this.deps.platform)
    const prefix = rootKey.endsWith(this.paths.sep) ? rootKey : rootKey + this.paths.sep
    if (!pathKey(real, this.deps.platform).startsWith(prefix)) {
      throw invalidParams(t('files.outsideProject', { path: relative }))
    }
    return real
  }

  private async fileStat(real: string, relative: string): Promise<Stats> {
    let info
    try {
      info = await stat(real)
    } catch (error) {
      throw this.fsError(error, relative)
    }
    if (!info.isFile()) throw invalidParams(t('files.notFile', { path: relative }))
    return info
  }

  private async readFile(real: string, size: number): Promise<Buffer> {
    const handle = await open(real, 'r')
    try {
      return await readBytes(handle, size)
    } finally {
      await handle.close()
    }
  }

  /** Writes beside the file and renames over it, so a crash leaves one whole file or the other. */
  private async replace(real: string, bytes: Buffer, mode: number): Promise<void> {
    const temp = this.paths.join(
      this.paths.dirname(real),
      `.${this.paths.basename(real)}.${randomBytes(4).toString('hex')}.kettu-tmp`,
    )
    const handle = await open(temp, 'wx', mode & 0o7777)
    try {
      await handle.writeFile(bytes)
      // The mode given to open is reduced by the umask.
      await handle.chmod(mode & 0o7777)
      await handle.sync()
    } catch (error) {
      await handle.close()
      await unlink(temp).catch(() => {})
      throw error
    }
    await handle.close()
    try {
      await rename(temp, real)
    } catch (error) {
      await unlink(temp).catch(() => {})
      const code = (error as NodeJS.ErrnoException | undefined)?.code ?? ''
      if (this.deps.platform !== 'win32' || !RENAME_REFUSED.has(code)) throw error
      await this.writeInPlace(real, bytes)
    }
  }

  private async writeInPlace(real: string, bytes: Buffer): Promise<void> {
    const handle = await open(real, 'r+')
    try {
      await handle.truncate(0)
      await handle.write(bytes, 0, bytes.length, 0)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private fsError(error: unknown, subject: string): Error {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return notFound(t('files.notExist', { path: subject }))
    return error instanceof Error ? error : new Error(String(error))
  }
}
