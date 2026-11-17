// Files Kettu reads for a session's agent, such as the file an edit request would change: only in
// the folder the session works in, read as the Files pane reads one, never through a link out of
// it.

import path from 'node:path'
import type { FileContent } from '@shared/files'
import type { Platform } from '@shared/platform'
import { isHostError } from './errors'
import { isAbsolutePath, isInside } from './paths'

export interface SessionFilesDeps {
  platform: Platform
  /** The folder the session works in, its worktree or its project; null for one Kettu does not hold. */
  folder(sessionId: string): string | null
  /** Reads `relative` in `folder` as text through the checked file access. */
  read(folder: string, relative: string): Promise<FileContent>
}

export class SessionFiles {
  constructor(private readonly deps: SessionFilesDeps) {}

  /**
   * The text of the file at the absolute `file`, which must lie in the session's folder; null when
   * it does not, is not there, is no file or is not valid UTF-8 text. Other failures throw.
   */
  async text(sessionId: string, file: string): Promise<string | null> {
    const { platform } = this.deps
    if (file.includes('\0') || !isAbsolutePath(file, platform)) return null
    const folder = this.deps.folder(sessionId)
    if (folder === null || !isInside(file, folder, platform)) return null
    const paths = platform === 'win32' ? path.win32 : path.posix
    const relative = paths.relative(folder, paths.resolve(file)).split(paths.sep).join('/')
    try {
      const content = await this.deps.read(folder, relative)
      return content.kind === 'text' && content.editable ? content.text : null
    } catch (error) {
      // The checked access refuses a path that leaves the folder, or names no file, as a host error.
      if (isHostError(error)) return null
      throw error
    }
  }
}
