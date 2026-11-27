import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  normalizeUpdateResumeSessions,
  UPDATE_RESUME_FILE,
  type UpdateResumeFile,
  type UpdateResumeSession,
} from '@shared/update-resume'
import { writeFileAtomic } from './json-file'
import { createLogger } from './log'

const log = createLogger('update-resume')

export function updateResumePath(userDataPath: string): string {
  return join(userDataPath, UPDATE_RESUME_FILE)
}

/**
 * Atomically persists the list of running user sessions interrupted by an immediate update restart.
 * Clears any stale file instead when there are no sessions to resume.
 */
export async function saveUpdateResume(
  userDataPath: string,
  params: {
    fromVersion: string
    sessions: readonly UpdateResumeSession[]
    now?: number
  },
): Promise<boolean> {
  const sessions = normalizeUpdateResumeSessions(params.sessions)
  if (sessions.length === 0) {
    await clearUpdateResume(userDataPath)
    return false
  }
  const payload: UpdateResumeFile = {
    version: 1,
    createdAt: params.now ?? Date.now(),
    fromVersion: params.fromVersion,
    sessions,
  }
  await writeFileAtomic(updateResumePath(userDataPath), `${JSON.stringify(payload, null, 2)}\n`)
  log.info(
    `Recorded ${sessions.length} session(s) to resume after update from ${params.fromVersion}`,
  )
  return true
}

/** Removes any pending update-resume record so cancelled or normal exits never trigger recovery. */
export async function clearUpdateResume(userDataPath: string): Promise<void> {
  try {
    await rm(updateResumePath(userDataPath), { force: true })
  } catch (error) {
    log.warn(`Could not clear ${UPDATE_RESUME_FILE}: ${String(error)}`)
  }
}
