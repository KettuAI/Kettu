// Scratch folders: the working directory of a session started with No project.

import { randomBytes } from 'node:crypto'
import { mkdir, realpath, rmdir } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { canonicalizePath, pathKey } from './paths'

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Hands out an empty folder of its own to each session without a project, under one root, as
 * the reference does for its No folder sessions. A folder is removed only while still empty, for
 * a prepared session that never received a message: it may hold what the agent wrote.
 */
export class ScratchFolders {
  private canonicalRoot: string | null = null

  constructor(
    private readonly root: string,
    private readonly platform: Platform,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Settles the root's canonical path, so `contains` can answer; creates nothing. */
  async ready(): Promise<void> {
    if (this.canonicalRoot !== null) return
    const parent = await canonicalizePath(path.dirname(this.root), this.platform, realpath)
    this.canonicalRoot = path.join(parent, path.basename(this.root))
  }

  /** A new empty folder, named after the day, as `scratch-2026-10-21-a3f9c2`; canonical. */
  async create(): Promise<string> {
    await this.ready()
    const root = this.canonicalRoot!
    await mkdir(root, { recursive: true, mode: 0o700 })
    const d = this.now()
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const folder = path.join(root, `scratch-${day}-${randomBytes(3).toString('hex')}`)
    await mkdir(folder, { mode: 0o700 })
    return folder
  }

  /** Removes a folder made for a session that went unused; one that is not empty stays. */
  async removeIfEmpty(folder: string): Promise<void> {
    if (!this.contains(folder)) return
    await rmdir(folder).catch(() => {})
  }

  /** Whether a canonical path is a scratch folder or inside one; false before `ready`. */
  contains(canonical: string): boolean {
    if (this.canonicalRoot === null) return false
    const root = pathKey(this.canonicalRoot, this.platform)
    const sep = this.platform === 'win32' ? '\\' : '/'
    return pathKey(canonical, this.platform).startsWith(root + sep)
  }
}
