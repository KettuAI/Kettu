// Each artifact version's HTML, one file per SHA-256 under `artifacts/content/` in the data folder.
// The thread worker writes and removes them in turn with the rows that name them, synchronously,
// since it owns the database; the host only reads them.

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const HASH = /^[0-9a-f]{64}$/
const FOLDER = /^[0-9a-f]{2}$/
const FILE = /^([0-9a-f]{64})\.html$/
const TEMP = /^[0-9a-f]{64}\.html\.[0-9a-f]+\.tmp$/
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])
const pause = new Int32Array(new SharedArrayBuffer(4))

export function contentHash(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex')
}

/** The file of a hash, in a folder named by its first two hex characters. */
export function contentPath(dir: string, hash: string): string {
  if (!HASH.test(hash)) throw new Error(`Not a content hash: ${hash}`)
  return path.join(dir, hash.slice(0, 2), `${hash}.html`)
}

function renameWithRetry(from: string, to: string): void {
  // On Windows a scanner or indexer can hold a new file open for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= 4 || !RETRYABLE.has(code)) throw error
      Atomics.wait(pause, 0, 0, 50 * (attempt + 1))
    }
  }
}

/**
 * Writes the HTML under its hash unless a file holds it already: to a temporary file, flushed to
 * disk, then renamed into place, so the file is whole whenever it exists.
 */
export function putContent(dir: string, hash: string, html: string): void {
  const file = contentPath(dir, hash)
  if (existsSync(file)) return
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const fd = openSync(temp, 'wx')
    try {
      writeFileSync(fd, html, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameWithRetry(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function removeIfEmpty(folder: string): void {
  try {
    rmdirSync(folder)
  } catch {
    // Not empty, or gone already.
  }
}

/** Removes the files of these hashes. */
export function removeContent(dir: string, hashes: Iterable<string>): void {
  for (const hash of hashes) {
    const file = contentPath(dir, hash)
    rmSync(file, { force: true })
    removeIfEmpty(path.dirname(file))
  }
}

/**
 * Removes every content file whose hash is not in `named`, and the temporary files a crash left;
 * files of other names are left alone. Returns how many it removed.
 */
export function sweepContent(dir: string, named: ReadonlySet<string>): number {
  let folders
  try {
    folders = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let removed = 0
  for (const folder of folders) {
    if (!folder.isDirectory() || !FOLDER.test(folder.name)) continue
    const at = path.join(dir, folder.name)
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const hash = FILE.exec(entry.name)?.[1]
      const keep = hash !== undefined && hash.startsWith(folder.name) && named.has(hash)
      if (keep || (hash === undefined && !TEMP.test(entry.name))) continue
      rmSync(path.join(at, entry.name), { force: true })
      removed++
    }
    removeIfEmpty(at)
  }
  return removed
}
