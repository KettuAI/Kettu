// One-shot manifest of user sessions interrupted when the desktop app restarts to install an update.

export const UPDATE_RESUME_FILE = 'update-resume.json'

/** Ignore records older than this so a failed update launched hours later never resumes old work. */
export const UPDATE_RESUME_MAX_AGE_MS = 30 * 60 * 1000

/** Tolerate minor wall-clock adjustments while rejecting far-future timestamps. */
export const UPDATE_RESUME_FUTURE_SKEW_MS = 60 * 1000

/** Bound the number of sessions processed at startup. */
export const UPDATE_RESUME_MAX_SESSIONS = 100

export interface UpdateResumeSession {
  sessionId: string
  /** True when the interrupted turn was blocked awaiting user approval or input. */
  waitingForUser: boolean
}

export interface UpdateResumeFile {
  version: 1
  createdAt: number
  fromVersion: string
  sessions: UpdateResumeSession[]
}

export function isUpdateResumeSession(value: unknown): value is UpdateResumeSession {
  if (typeof value !== 'object' || value === null) return false
  const { sessionId, waitingForUser } = value as Record<string, unknown>
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    sessionId.length <= 256 &&
    typeof waitingForUser === 'boolean'
  )
}

/** Deduplicates sessions by id; if any duplicate was waiting for the user, keep the safer flag. */
export function normalizeUpdateResumeSessions(
  sessions: readonly UpdateResumeSession[],
): UpdateResumeSession[] {
  const byId = new Map<string, UpdateResumeSession>()
  for (const item of sessions) {
    if (!isUpdateResumeSession(item)) continue
    const existing = byId.get(item.sessionId)
    if (existing) {
      if (item.waitingForUser) existing.waitingForUser = true
    } else if (byId.size < UPDATE_RESUME_MAX_SESSIONS) {
      byId.set(item.sessionId, {
        sessionId: item.sessionId,
        waitingForUser: item.waitingForUser,
      })
    }
  }
  return [...byId.values()]
}

/** Validates raw JSON read from `update-resume.json`; returns null when malformed. */
export function parseUpdateResumeFile(raw: unknown): UpdateResumeFile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { version, createdAt, fromVersion, sessions } = raw as Record<string, unknown>
  if (
    version !== 1 ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    createdAt <= 0 ||
    typeof fromVersion !== 'string' ||
    fromVersion.length > 256 ||
    !Array.isArray(sessions)
  ) {
    return null
  }
  const normalized = normalizeUpdateResumeSessions(sessions.filter(isUpdateResumeSession))
  return {
    version: 1,
    createdAt,
    fromVersion,
    sessions: normalized,
  }
}

/** Whether a parsed update-resume record is within its validity window. */
export function isFreshUpdateResume(
  file: Pick<UpdateResumeFile, 'createdAt'>,
  now = Date.now(),
  maxAgeMs = UPDATE_RESUME_MAX_AGE_MS,
): boolean {
  return file.createdAt <= now + UPDATE_RESUME_FUTURE_SKEW_MS && now - file.createdAt <= maxAgeMs
}
