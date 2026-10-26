// A project's files for the Files pane: listed, read and searched through git when the project
// is in a repository, and through a bounded walk of the folder when it is not.

import { createHash, randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { open, readdir, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import {
  FILE_LIST_LIMIT,
  FILE_MATCH_CHARS,
  FILE_READ_LIMIT,
  FILE_SEARCH_LIMIT,
  type FileContent,
  type FileList,
  type FileMatch,
  type FileSearch,
  type FileWritten,
} from '@shared/files'
import type { MediaGrant } from '@shared/media'
import type { Platform } from '@shared/platform'
import { HostError, invalidParams, notFound } from './errors'
import { describeFailure, GIT_TIMEOUT_MS, type Exec, type ExecResult } from './git/exec'
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
}

const DEFAULT_LIMITS: FilesLimits = {
  list: FILE_LIST_LIMIT,
  read: FILE_READ_LIMIT,
  search: FILE_SEARCH_LIMIT,
  matchChars: FILE_MATCH_CHARS,
  scanFiles: 5_000,
  depth: 20,
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024
// The same prefix git looks at to call a file binary.
const BINARY_PROBE_BYTES = 8_000
const SCAN_BATCH = 16
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules'])
const EMPTY_SEARCH: FileSearch = { matches: [], truncated: false }

export interface FilesServiceDeps {
  /** Runs git; it must give git the agent environment. */
  exec: Exec
  platform: Platform
  /** A grant on the media scheme for a file at its real path, or null when it is no media. */
  media(real: string, info: Stats): Promise<MediaGrant | null>
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
  if (result.failure === 'cwd-missing') throw notFound('The project folder does not exist')
  if (result.failure !== null)
    throw new HostError('git_error', `${label}: ${describeFailure(result)}`)
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

export class FilesService {
  private readonly limits: FilesLimits
  private readonly paths: path.PlatformPath

  constructor(private readonly deps: FilesServiceDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits }
    this.paths = deps.platform === 'win32' ? path.win32 : path.posix
  }

  /** The files under `root`, relative and sorted. `root` is a canonical project path. */
  async list(root: string): Promise<FileList> {
    const [listed, deleted] = await Promise.all([
      this.git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
      this.git(root, ['ls-files', '-z', '--deleted']),
    ])
    const files = gitOutput('git ls-files', listed)
    const gone = gitOutput('git ls-files --deleted', deleted)
    if (files === null || gone === null) return this.walk(root, this.limits.list)
    const missing = new Set(gone.split('\0'))
    // A nested repository is listed as a folder, with a trailing slash.
    const paths = sortedUnique(
      files.split('\0').filter((p) => p !== '' && !p.endsWith('/') && !missing.has(p)),
    )
    if (paths.length <= this.limits.list) return { paths, truncated: false }
    return { paths: paths.slice(0, this.limits.list), truncated: true }
  }

  /**
   * A file's text, or its grant when it is media, or why there is none. `relativePath` uses `/`
   * between segments. A file named as media is one only if its first bytes say so; `asText` reads
   * it as any other file.
   */
  async read(root: string, relativePath: string, asText = false): Promise<FileContent> {
    const relative = this.normalize(relativePath)
    const real = await this.resolveInside(root, relative)
    const info = await this.fileStat(real, relative)
    const grant = asText ? null : await this.deps.media(real, info)
    if (grant) return { kind: 'media', path: relative, grant }
    const { size } = info
    if (size > this.limits.read) {
      return { kind: 'too-large', path: relative, size, limit: this.limits.read }
    }
    const bytes = await this.readFile(real, size)
    if (isBinary(bytes)) return { kind: 'binary', path: relative, size }
    return { kind: 'text', path: relative, size, ...decode(bytes), version: versionOf(bytes) }
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
      throw invalidParams(`${relative} is not a file or a folder`)
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
    if (relative.split('/').includes('.git')) throw invalidParams(`${relative} is inside .git`)
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > this.limits.read) {
      throw invalidParams(`The text is larger than ${this.limits.read} bytes`)
    }
    const real = await this.resolveInside(root, relative)
    const info = await this.fileStat(real, relative)
    if (version !== null) {
      const current = info.size > this.limits.read ? null : await this.readFile(real, info.size)
      if (current === null || versionOf(current) !== version) {
        throw new HostError('conflict', `${relative} changed since it was read`)
      }
    }
    // A rename would leave the other names of a hard-linked file with the old text.
    if (info.nlink > 1) await this.writeInPlace(real, bytes)
    else await this.replace(real, bytes, info.mode)
    return { version: versionOf(bytes), size: bytes.length }
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
          if (paths.length >= limit) return { paths: sortedUnique(paths), truncated: true }
          paths.push(relative)
        }
      }
      level = next
    }
    return { paths: sortedUnique(paths), truncated: false }
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
    if (value.includes('\0')) throw invalidParams('path contains a NUL character')
    if (
      isAbsolutePath(value, this.deps.platform) ||
      value.startsWith('/') ||
      (windows && value.startsWith('\\'))
    ) {
      throw invalidParams('path must be relative to the project')
    }
    const segments = value.split(windows ? /[\\/]/ : '/').filter((s) => s !== '' && s !== '.')
    if (segments.includes('..')) throw invalidParams('path must not contain ..')
    // A colon on Windows is a drive or an alternate data stream.
    if (windows && segments.some((segment) => segment.includes(':'))) {
      throw invalidParams('path must be relative to the project')
    }
    if (segments.length === 0) throw invalidParams('path must name a file')
    return segments.join('/')
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
      throw invalidParams(`${relative} is outside the project`)
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
    if (!info.isFile()) throw invalidParams(`${relative} is not a file`)
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
      `.${this.paths.basename(real)}.${randomBytes(4).toString('hex')}.overbench-tmp`,
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
    if (code === 'ENOENT' || code === 'ENOTDIR') return notFound(`${subject} does not exist`)
    return error instanceof Error ? error : new Error(String(error))
  }
}
