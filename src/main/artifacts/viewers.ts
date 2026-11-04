// The type viewers' built files, which every typed artifact's origin serves under its reserved
// prefix. Read once; a request names a file only by its place in that list.

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '../log'

const log = createLogger('artifacts')

export class ViewerFiles {
  private files: Promise<Map<string, string>> | null = null

  /** `root` is the viewers' build folder, out/viewers. */
  constructor(private readonly root: string) {}

  /** The file at `relative`, `/`-separated under the viewers' folder, or null. */
  async find(relative: string): Promise<string | null> {
    return (await this.read()).get(relative) ?? null
  }

  /** Every file, by its path under the viewers' folder. */
  async all(): Promise<{ path: string; file: string }[]> {
    return [...(await this.read())].map(([path, file]) => ({ path, file }))
  }

  private read(): Promise<Map<string, string>> {
    this.files ??= list(this.root).catch((error: NodeJS.ErrnoException) => {
      log.error(`Cannot read the artifact viewers: ${error.message}`)
      this.files = null
      return new Map()
    })
    return this.files
  }
}

async function list(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    files.set(path.relative(root, file).split(path.sep).join('/'), file)
  }
  return files
}
