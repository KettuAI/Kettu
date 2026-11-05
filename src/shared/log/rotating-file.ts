// A log file that rotates by size: `name.log`, then `name.1.log` up to `name.<files-1>.log`.
// Writes are buffered and appended in order off the caller's thread; flushSync is for exit.

import fs from 'node:fs'
import path from 'node:path'

const FLUSH_DELAY_MS = 500
// A buffer this large is written at once instead of waiting for the delay.
const FLUSH_BYTES = 64 * 1024

export interface RotatingFileOptions {
  dir: string
  name: string
  maxBytes: number
  files: number
  /** After each rotation, as when the folder may need pruning. */
  onRotate?: () => void
}

export class RotatingFile {
  private handle: fs.promises.FileHandle | null = null
  private size = 0
  private pending: string[] = []
  private pendingBytes = 0
  private timer: NodeJS.Timeout | null = null
  private chain: Promise<void> = Promise.resolve()
  private closed = false
  private failed = false

  constructor(private readonly options: RotatingFileOptions) {}

  get path(): string {
    return this.fileAt(0)
  }

  write(text: string, urgent = false): void {
    if (this.closed || this.failed) return
    this.pending.push(text)
    this.pendingBytes += text.length
    if (urgent || this.pendingBytes >= FLUSH_BYTES) {
      void this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS)
      this.timer.unref?.()
    }
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.chain = this.chain.then(() => this.drain())
    return this.chain
  }

  /** Writes what is buffered before the process ends; only for exit and fatal errors. */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending.length === 0 || this.failed) return
    const data = this.take()
    try {
      if (this.handle) fs.writeSync(this.handle.fd, data)
      else fs.appendFileSync(this.path, data)
    } catch {
      // Nothing is left to report it to.
    }
  }

  async close(): Promise<void> {
    await this.flush()
    this.closed = true
    const handle = this.handle
    this.handle = null
    await handle?.close().catch(() => undefined)
  }

  private take(): string {
    const data = this.pending.join('')
    this.pending = []
    this.pendingBytes = 0
    return data
  }

  private async drain(): Promise<void> {
    if (this.pending.length === 0 || this.failed) return
    const data = this.take()
    try {
      if (!this.handle) await this.open()
      const bytes = Buffer.byteLength(data)
      if (this.size > 0 && this.size + bytes > this.options.maxBytes) await this.rotate()
      await this.handle!.write(data)
      this.size += bytes
    } catch {
      // A folder that cannot be written stops this file; the app runs on without it.
      this.failed = true
    }
  }

  private async open(): Promise<void> {
    await fs.promises.mkdir(this.options.dir, { recursive: true })
    this.handle = await fs.promises.open(this.path, 'a')
    this.size = (await this.handle.stat()).size
  }

  private async rotate(): Promise<void> {
    await this.handle?.close()
    this.handle = null
    const last = this.options.files - 1
    await fs.promises.rm(this.fileAt(last), { force: true })
    for (let index = last - 1; index >= 0; index--) {
      await fs.promises.rename(this.fileAt(index), this.fileAt(index + 1)).catch(() => undefined)
    }
    await this.open()
    this.options.onRotate?.()
  }

  private fileAt(index: number): string {
    const suffix = index === 0 ? '' : `.${index}`
    return path.join(this.options.dir, `${this.options.name}${suffix}.log`)
  }
}

export interface PruneOptions {
  now: number
  maxAgeMs: number
  /** Files whose name starts with this prefix, the detailed records, get `verboseAgeMs`. */
  verbosePrefix: string
  verboseAgeMs: number
  maxFolderBytes: number
}

/** Removes log files past their age, then the oldest until the folder is within its size. */
export async function pruneLogFolder(dir: string, options: PruneOptions): Promise<void> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return
  }
  const files: { file: string; mtime: number; size: number }[] = []
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    const file = path.join(dir, name)
    const stat = await fs.promises.stat(file).catch(() => null)
    if (!stat?.isFile()) continue
    const maxAge = name.startsWith(options.verbosePrefix) ? options.verboseAgeMs : options.maxAgeMs
    if (options.now - stat.mtimeMs > maxAge) {
      await fs.promises.rm(file, { force: true }).catch(() => undefined)
    } else {
      files.push({ file, mtime: stat.mtimeMs, size: stat.size })
    }
  }
  let total = files.reduce((sum, entry) => sum + entry.size, 0)
  files.sort((a, b) => a.mtime - b.mtime)
  for (const entry of files) {
    if (total <= options.maxFolderBytes) break
    // A file another process holds open may refuse on Windows; the next pass tries again.
    const removed = await fs.promises.rm(entry.file, { force: true }).then(
      () => true,
      () => false,
    )
    if (removed) total -= entry.size
  }
}
