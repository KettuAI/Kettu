// GitHub repositories as the skills come from them: a repository or folder URL read into the
// tarball to fetch, the tarball read in memory with the commit it was made from, and its entries
// checked before any is written: no link, nothing outside its folder, and bounded in count and size.

import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'

const gunzip = promisify(gunzipCallback)

/** A repository, or one folder in it at a ref, on github.com. */
export interface GithubSource {
  owner: string
  repo: string
  ref: string | null // null for the default branch
  path: string // '' for the whole repository
}

const NAME = /^[A-Za-z0-9_.-]+$/

/**
 * `https://github.com/<owner>/<repo>`, optionally `/tree/<ref>/<path>`, as a source; null for
 * anything else. A ref with a slash in it cannot be told from the path, so the first part is the ref.
 */
export function githubSource(text: string): GithubSource | null {
  const url = URL.parse(text.trim())
  if (!url || url.protocol !== 'https:' || url.hostname !== 'github.com') return null
  if (url.username || url.password || url.port) return null
  const parts = url.pathname.split('/').filter((part) => part !== '')
  const [owner, rawRepo, kind, ref, ...rest] = parts.map((part) => decodeURIComponent(part))
  const repo = rawRepo?.replace(/\.git$/, '')
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo) || repo === '.' || repo === '..') {
    return null
  }
  if (kind === undefined) return { owner, repo, ref: null, path: '' }
  if ((kind !== 'tree' && kind !== 'blob') || !ref || !/^[A-Za-z0-9_.\-/]+$/.test(ref)) return null
  const path = rest.join('/')
  if (rest.some((part) => part === '..' || part === '.' || part.includes('\\'))) return null
  // A link to the SKILL.md itself names its folder.
  return { owner, repo, ref, path: kind === 'blob' ? rest.slice(0, -1).join('/') : path }
}

export function tarballUrl(source: GithubSource): string {
  const ref = source.ref ?? 'HEAD'
  return `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${ref.split('/').map(encodeURIComponent).join('/')}`
}

export interface TarLimits {
  /** Of the compressed download. */
  downloadBytes: number
  /** Of the archive once unpacked, in memory. */
  unpackedBytes: number
  timeoutMs: number
}

/** A file of the archive, by its path inside the repository. */
export interface TarFile {
  path: string
  data: Buffer
  mode: number
}

export interface Tarball {
  commit: string | null
  files: TarFile[]
  /** The repository paths of entries that are links, which are never written. */
  links: string[]
}

/** Downloads a tarball, refusing one larger than the limit. */
export async function downloadTarball(
  url: string,
  limits: TarLimits,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const signal = AbortSignal.timeout(limits.timeoutMs)
  let response: Response
  try {
    response = await fetcher(url, { signal, redirect: 'follow' })
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`GitHub did not answer within ${limits.timeoutMs / 1000} s`, { cause: error })
    }
    throw new Error(`Could not reach GitHub: ${(error as Error).message}`, { cause: error })
  }
  if (response.status === 404) {
    void response.body?.cancel()
    throw new Error('GitHub has no such repository or ref, or it is private')
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel()
    throw new Error(`GitHub answered ${response.status}`)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limits.downloadBytes) {
        void reader.cancel()
        throw new Error(`The repository is larger than ${mb(limits.downloadBytes)} MB`)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`GitHub did not answer within ${limits.timeoutMs / 1000} s`, { cause: error })
    }
    throw error
  }
  return Buffer.concat(chunks)
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

/** The commit a GitHub tarball's pax global header names in its `comment`. */
export function tarCommit(tar: Buffer): string | null {
  if (tar.length < 512 || tar[156] !== 0x67) return null
  const size = parseInt(tar.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim(), 8)
  if (!Number.isSafeInteger(size) || size <= 0 || 512 + size > tar.length) return null
  const records = tar.subarray(512, 512 + size).toString('utf8')
  const match = /(?:^|\n)\d+ comment=([0-9a-f]{40})\n/.exec(records)
  return match ? match[1]! : null
}

/**
 * The path of an entry inside the repository, without the archive's top folder; null when it is
 * absolute, climbs out, or holds what no file system on Kettu's platforms takes.
 */
export function entryPath(name: string): string | null {
  const parts = name.replace(/\/+$/, '').split('/')
  if (parts.length < 2 || parts[0] === '' || name.includes('\\') || name.includes('\0')) return null
  const inner = parts.slice(1)
  for (const part of inner) {
    if (part === '' || part === '.' || part === '..') return null
    if (/[<>:"|?*\p{Cc}]/u.test(part) || /[. ]$/.test(part)) return null
  }
  return inner.join('/')
}

interface DecompressEntry {
  path: string
  type: string
  data?: Buffer
  mode?: number
}

type DecompressBuffer = (input: Buffer) => Promise<DecompressEntry[]>

async function loadDecompress(): Promise<DecompressBuffer> {
  const module = (await import('decompress')) as unknown as { default?: unknown }
  return (module.default ?? module) as DecompressBuffer
}

/** Unpacks a `.tar.gz` in memory and checks each entry; throws when it is past the limits. */
export async function readTarball(
  gz: Buffer,
  limits: Pick<TarLimits, 'unpackedBytes'>,
  decompress?: DecompressBuffer,
): Promise<Tarball> {
  let tar: Buffer
  try {
    tar = await gunzip(gz, { maxOutputLength: limits.unpackedBytes })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`The repository is larger than ${mb(limits.unpackedBytes)} MB unpacked`, {
        cause: error,
      })
    }
    throw new Error(`The download is not a tarball: ${(error as Error).message}`, { cause: error })
  }
  const entries = await (decompress ?? (await loadDecompress()))(tar)
  return checkedEntries(entries, tarCommit(tar))
}

/** The archive's files under safe paths; any entry with an unsafe path refuses the whole archive. */
export function checkedEntries(
  entries: readonly DecompressEntry[],
  commit: string | null,
): Tarball {
  const files: TarFile[] = []
  const links: string[] = []
  for (const entry of entries) {
    if (entry.type === 'directory') continue
    const path = entryPath(entry.path)
    if (path === null) {
      // The top folder itself names no path inside the repository.
      if (!entry.path.replace(/\/+$/, '').includes('/') && entry.type !== 'file') continue
      throw new Error(`The archive holds an unsafe path: ${entry.path}`)
    }
    if (entry.type === 'symlink' || entry.type === 'link') {
      links.push(path)
      continue
    }
    if (entry.type !== 'file') continue
    files.push({ path, data: entry.data ?? Buffer.alloc(0), mode: entry.mode ?? 0o644 })
  }
  return { commit, files, links }
}

export interface FolderLimits {
  files: number
  bytes: number
}

/**
 * The files of one folder of the archive, by their paths inside it. Throws when the folder holds a
 * link or is past the limits.
 */
export function folderFiles(tarball: Tarball, folder: string, limits: FolderLimits): TarFile[] {
  const prefix = folder === '' ? '' : `${folder}/`
  const link = tarball.links.find((path) => path.startsWith(prefix))
  if (link !== undefined)
    throw new Error(`The skill holds a link, which Kettu does not copy: ${link}`)
  const files = tarball.files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
  if (files.length > limits.files) {
    throw new Error(`The skill holds more than ${limits.files} files`)
  }
  const bytes = files.reduce((sum, file) => sum + file.data.length, 0)
  if (bytes > limits.bytes) throw new Error(`The skill is larger than ${mb(limits.bytes)} MB`)
  return files
}
