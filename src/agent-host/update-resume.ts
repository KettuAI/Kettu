import { randomUUID } from 'node:crypto'
import { readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  isFreshUpdateResume,
  parseUpdateResumeFile,
  UPDATE_RESUME_FILE,
  UPDATE_RESUME_MAX_AGE_MS,
  type UpdateResumeFile,
} from '@shared/update-resume'
import type { LogFn } from './storage'

/**
 * Atomically claims and deletes `update-resume.json` so each update restart triggers recovery at
 * most once even if startup crashes or restarts before recovery finishes.
 */
export async function consumeUpdateResume(
  userDataPath: string,
  options: {
    now?: number
    maxAgeMs?: number
    log?: LogFn
  } = {},
): Promise<UpdateResumeFile | null> {
  const file = path.join(userDataPath, UPDATE_RESUME_FILE)
  const claimed = `${file}.consuming-${process.pid}-${randomUUID()}`
  try {
    await rename(file, claimed)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    options.log?.('warn', `Could not claim ${UPDATE_RESUME_FILE}: ${(error as Error).message}`)
    await rm(file, { force: true }).catch(() => {})
    return null
  }

  let text: string
  try {
    text = await readFile(claimed, 'utf8')
  } catch (error) {
    options.log?.('warn', `Could not read ${UPDATE_RESUME_FILE}: ${(error as Error).message}`)
    return null
  } finally {
    await rm(claimed, { force: true }).catch(() => {})
  }

  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (error) {
    options.log?.(
      'warn',
      `Ignoring invalid JSON in ${UPDATE_RESUME_FILE}: ${(error as Error).message}`,
    )
    return null
  }

  const parsed = parseUpdateResumeFile(raw)
  if (!parsed) {
    options.log?.('warn', `Ignoring malformed ${UPDATE_RESUME_FILE}`)
    return null
  }

  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? UPDATE_RESUME_MAX_AGE_MS
  if (!isFreshUpdateResume(parsed, now, maxAgeMs)) {
    options.log?.(
      'info',
      `Ignoring stale ${UPDATE_RESUME_FILE} created at ${new Date(parsed.createdAt).toISOString()}`,
    )
    return null
  }

  if (parsed.sessions.length === 0) return null
  return parsed
}
