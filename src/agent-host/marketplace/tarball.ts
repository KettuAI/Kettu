// GitHub repositories as the skills come from them: a repository or folder URL read into the
// tarball to fetch, the tarball read in memory with the commit it was made from, and its entries
// checked before any is written: no link, nothing outside its folder, and bounded in count and size.

import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'
import { LocalizedError } from '../localized-error'

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

/** What GitHub says of a branch's commit: the one it is at, unchanged since `etag`, or nothing. */
export type BranchHead =
  | { kind: 'commit'; commit: string; etag: string | null }
  | { kind: 'unchanged' }
  | { kind: 'unknown'; reason: string }

const HEAD_TIMEOUT_MS = 15_000

/**
 * The commit a branch is at, from GitHub's API. Unauthenticated it allows 60 requests an hour, so
 * the last answer's ETag goes back with the next; a refusal or any failure says nothing, and the
 * caller then downloads the tarball instead.
 */
export async function branchHead(
  source: { owner: string; repo: string; branch: string },
  etag: string | null,
  fetcher: typeof fetch = fetch,
): Promise<BranchHead> {
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.branch)}`
  let response: Response
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      headers: {
        accept: 'application/vnd.github.sha',
        'user-agent': 'Kettu',
        'x-github-api-version': '2022-11-28',
        ...(etag ? { 'if-none-match': etag } : {}),
      },
    })
  } catch (error) {
    return { kind: 'unknown', reason: (error as Error).message }
  }
  if (response.status === 304) return { kind: 'unchanged' }
  if (!response.ok) {
    void response.body?.cancel()
    return { kind: 'unknown', reason: `GitHub answered ${response.status}` }
  }
  const commit = (await response.text().catch(() => '')).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) return { kind: 'unknown', reason: 'GitHub sent no commit' }
  return { kind: 'commit', commit, etag: response.headers.get('etag') }
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
      throw new LocalizedError(
        { key: 'marketSkills.github.timeout', params: { seconds: limits.timeoutMs / 1000 } },
        { cause: error },
      )
    }
    throw new LocalizedError(
      { key: 'marketSkills.github.unreachable', params: { reason: (error as Error).message } },
      { cause: error },
    )
  }
  if (response.status === 404) {
    void response.body?.cancel()
    throw new LocalizedError({ key: 'marketSkills.github.notFound' })
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel()
    throw new LocalizedError({
      key: 'marketSkills.github.status',
      params: { status: response.status },
    })
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
        throw new LocalizedError({
          key: 'marketSkills.github.tooLarge',
          params: { mb: mb(limits.downloadBytes) },
        })
      }
      chunks.push(value)
    }
  } catch (error) {
    if (signal.aborted) {
      throw new LocalizedError(
        { key: 'marketSkills.github.timeout', params: { seconds: limits.timeoutMs / 1000 } },
        { cause: error },
      )
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
      throw new LocalizedError(
        { key: 'marketSkills.github.unpackedTooLarge', params: { mb: mb(limits.unpackedBytes) } },
        { cause: error },
      )
    }
    throw new LocalizedError(
      { key: 'marketSkills.github.notTarball', params: { reason: (error as Error).message } },
      { cause: error },
    )
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
      throw new LocalizedError({
        key: 'marketSkills.github.unsafePath',
        params: { path: entry.path },
      })
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
  if (link !== undefined) {
    throw new LocalizedError({ key: 'marketSkills.link', params: { path: link } })
  }
  const files = tarball.files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
  if (files.length > limits.files) {
    throw new LocalizedError({ key: 'marketSkills.tooManyFiles', params: { count: limits.files } })
  }
  const bytes = files.reduce((sum, file) => sum + file.data.length, 0)
  if (bytes > limits.bytes) {
    throw new LocalizedError({ key: 'marketSkills.tooLarge', params: { mb: mb(limits.bytes) } })
  }
  return files
}
