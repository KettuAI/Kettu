// The type viewers' built files, which every typed artifact's origin serves under its reserved
// prefix. Read once; a request names a file only by its place in that list.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '../log'

const log = createLogger('artifacts')

/** What the viewers' build lists in `parts.json`: see tools/build/viewer-parts.ts. */
interface ViewerParts {
  aliases: Record<string, string>
  viewers: Record<string, { files: string[]; languages: Record<string, string[]> }>
}

const PARTS_FILE = 'parts.json'

export class ViewerFiles {
  private files: Promise<Map<string, string>> | null = null
  private parts: Promise<ViewerParts | null> | null = null

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

  /**
   * The files the viewer `name` loads for content whose code names `languages`, as a fence does:
   * its own, and each language's grammar. Every file when the build lists none.
   */
  async forPage(
    name: string,
    languages: readonly string[],
  ): Promise<{ path: string; file: string }[]> {
    const [files, parts] = await Promise.all([this.read(), this.readParts()])
    const viewer = parts && Object.hasOwn(parts.viewers, name) ? parts.viewers[name]! : null
    if (!viewer) {
      log.warn(`The viewers' build lists no parts of ${name}; every viewer file goes with it`)
      return this.all()
    }
    const wanted = new Set(viewer.files)
    for (const language of languages) {
      const id = Object.hasOwn(parts!.aliases, language) ? parts!.aliases[language]! : language
      if (Object.hasOwn(viewer.languages, id))
        for (const part of viewer.languages[id]!) wanted.add(part)
    }
    return [...wanted].flatMap((part) => {
      const file = files.get(part)
      return file ? [{ path: part, file }] : []
    })
  }

  private readParts(): Promise<ViewerParts | null> {
    this.parts ??= readFile(path.join(this.root, PARTS_FILE), 'utf8').then(
      (text) => JSON.parse(text) as ViewerParts,
      (error: NodeJS.ErrnoException) => {
        log.warn(`Cannot read the viewers' ${PARTS_FILE}: ${error.message}`)
        return null
      },
    )
    return this.parts
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
