import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { describeError, type Logger } from './log'

export type JsonReadResult =
  { kind: 'missing' } | { kind: 'ok'; value: unknown } | { kind: 'unreadable'; reason: string }

/** Reads and parses a JSON file. A missing file is not an error; a malformed one is reported. */
export async function readJsonFile(path: string): Promise<JsonReadResult> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', reason: describeError(error) }
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) as unknown }
  } catch (error) {
    return { kind: 'unreadable', reason: `Invalid JSON: ${(error as Error).message}` }
  }
}

/** Moves a file that failed to parse or validate aside, as `<name>.corrupt-<timestamp>.json`. */
export async function quarantineFile(path: string, now = Date.now()): Promise<string> {
  const extension = extname(path)
  const target = join(dirname(path), `${basename(path, extension)}.corrupt-${now}${extension}`)
  await rename(path, target)
  return target
}

const RENAME_RETRIES = 5

/**
 * Writes through `<file>.tmp`, fsync and rename, so a crash mid-write keeps the previous file.
 * With `mode`, as 0o600 for a file only the user may read, the file has it before any data does.
 */
export async function writeFileAtomic(path: string, data: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  const handle = await open(temporary, 'w', mode)
  try {
    // A temporary file left by a crash keeps its own mode, which open does not change.
    if (mode !== undefined) await handle.chmod(mode)
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, path)
      return
    } catch (error) {
      // Windows refuses the rename while a scanner or indexer briefly holds the target open.
      const code = (error as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!transient || attempt >= RENAME_RETRIES) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

/** Debounces writes of one JSON file and serializes them, so only the latest value lands. */
export class JsonFileWriter {
  private pending: { value: unknown } | null = null
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null

  constructor(
    private readonly path: string,
    private readonly log: Logger,
    private readonly delayMs = 500,
  ) {}

  schedule(value: unknown): void {
    this.pending = { value }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, this.delayMs)
  }

  /** Writes a pending value at once and resolves when nothing is left to write. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.drain()
  }

  private async drain(): Promise<void> {
    while (this.running) await this.running
    if (!this.pending) return
    const { value } = this.pending
    this.pending = null
    this.running = writeFileAtomic(this.path, `${JSON.stringify(value, null, 2)}\n`)
      .catch((error: unknown) => this.log.error(`Could not write ${this.path}`, error))
      .finally(() => {
        this.running = null
      })
    await this.running
    if (this.pending && !this.timer) await this.drain()
  }
}
