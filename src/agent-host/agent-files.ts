// Files an agent keeps for a session in a folder of its own, outside the project, such as the plan
// agy writes in Plan mode. A client reads them only from that session's own folder, never through a
// link out of it, and never writes them.

import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { harnessOf, type AgentId } from '@shared/agents'
import type { FileContent } from '@shared/files'
import type { Platform } from '@shared/platform'
import { HostError, invalidParams, notFound } from './errors'
import { t } from './i18n'
import { isAbsolutePath, isInside } from './paths'

// An agent's id of its session as one folder's name: no separator, and not `.` or `..`.
const SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The folder `agentId`'s agent keeps the files of its session `agentSessionId` in, or null. */
export function agentFolder(
  agentId: AgentId,
  agentSessionId: string,
  homeDir: string,
  platform: Platform,
): string | null {
  if (!SESSION_SEGMENT.test(agentSessionId)) return null
  const paths = platform === 'win32' ? path.win32 : path.posix
  switch (harnessOf(agentId)) {
    // agy 1.5.9 keeps a session's plan, walkthrough and notes in its brain folder.
    case 'antigravity':
      return paths.join(homeDir, '.gemini', 'antigravity-cli', 'brain', agentSessionId)
    default:
      return null
  }
}

export interface AgentFilesDeps {
  platform: Platform
  homeDir: string
  /**
   * The session's agent, that agent's id of it and the agent's own folder it was started in, or
   * null for a session Kettu does not hold.
   */
  session(
    sessionId: string,
  ): { agentId: AgentId; agentSessionId: string; configDir: string | null } | null
  /** Reads the regular file at `real`, a real path allowed here, under the name `shown`. */
  read(real: string, shown: string): Promise<FileContent>
}

export class AgentFiles {
  constructor(private readonly deps: AgentFilesDeps) {}

  /** The folder of the session's own files, or null when its agent keeps none or it is not held. */
  folder(sessionId: string): string | null {
    const session = this.deps.session(sessionId)
    if (!session) return null
    // An added agy agent's process takes its own folder for the home folder.
    return agentFolder(
      session.agentId,
      session.agentSessionId,
      session.configDir ?? this.deps.homeDir,
      this.deps.platform,
    )
  }

  /**
   * The file at the absolute `file`, which must lie in the session's own folder both as written
   * and at its real path. Never media, since nothing grants it, and never editable.
   */
  async read(sessionId: string, file: string): Promise<FileContent> {
    const { platform } = this.deps
    if (file.includes('\0')) throw invalidParams('path contains a NUL character')
    if (!isAbsolutePath(file, platform)) throw invalidParams('path must be an absolute path')
    if (!this.deps.session(sessionId)) throw notFound(t('session.notFound'))
    const folder = this.folder(sessionId)
    const refused = new HostError('forbidden', t('agentFile.foreign', { file }))
    if (folder === null) throw refused
    const base = await realpath(folder).catch(() => null)
    // Nothing is looked up for a path outside the folder, so no other file's presence shows.
    if (!isInside(file, folder, platform) && !(base !== null && isInside(file, base, platform))) {
      throw refused
    }
    if (base === null) throw notFound(t('agentFile.missing', { file }))
    let real: string
    try {
      real = await realpath(file)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound(t('agentFile.missing', { file }))
      throw error
    }
    if (!isInside(real, base, platform)) throw refused
    const content = await this.deps.read(real, file)
    return content.kind === 'text' ? { ...content, editable: false } : content
  }
}
