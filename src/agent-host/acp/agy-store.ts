// Per-session Antigravity (`agy`) app_data_dir resolution.
//
// `agy acp` runs with `--app-data-dir antigravity-cli` by default. Its `session/list` lists both
// CLI sessions (`app_data_dir = 'antigravity-cli'`) and IDE sessions (`app_data_dir = 'antigravity'`)
// via fallback import directories, while `session/load` (`LoadTrajectory`) only checks the active
// app_data_dir and silently resolves with 0 replayed message updates for trajectories living in
// another store. Resolving which app_data_dir owns a session lets Kettu spawn that session's worker
// with `--app-data-dir <dir>` without changing new sessions away from the default CLI store.

import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Platform } from '@shared/platform'

export const DEFAULT_AGY_APP_DATA_DIR = 'antigravity-cli'
export const IDE_AGY_APP_DATA_DIR = 'antigravity'
export const AGY_APP_DATA_DIR_FLAG = '--app-data-dir'

/**
 * Where the session router advertises supported value flags in `initialize._meta` (as `string[]`)
 * and where `session/load` / `session/resume` request per-session flag values (as `Record<string, string>`).
 */
export const SESSION_ARGS_META = 'sh.kettu/session-args'

/** Single safe path segment for a session id (no separators, no `.` or `..`). */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Single safe directory name for an agy `--app-data-dir` value (no path traversal or whitespace). */
const SAFE_APP_DATA_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TRAJECTORY_EXTENSIONS = ['.db', '.pb'] as const

export interface AgyConversationMeta {
  appDataDir: string | null
  stepCount: number | null
}

/** Whether `value` is a safe single path segment for an agy session id. */
export function isSafeAgySessionId(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..' && SAFE_SESSION_ID.test(value)
}

/** Whether `value` is a safe single directory name for `--app-data-dir`. */
export function isSafeAgyAppDataDir(value: unknown): value is string {
  return (
    typeof value === 'string' && value !== '.' && value !== '..' && SAFE_APP_DATA_DIR.test(value)
  )
}

/** Whether `initialize._meta` from the session router advertises `flag` as a supported value flag. */
export function offersSessionArg(meta: unknown, flag: string): boolean {
  const listed = (meta as Record<string, unknown> | null | undefined)?.[SESSION_ARGS_META]
  return Array.isArray(listed) && listed.includes(flag)
}

/** The `.gemini` root under `home`, using platform-appropriate path semantics when given. */
export function agyGeminiDir(home = os.homedir(), platform?: Platform): string {
  const paths = platform === 'win32' ? path.win32 : platform ? path.posix : path
  return paths.join(home, '.gemini')
}

/** Path to agy's `conversation_summaries.db` for a given `home` and `appDataDir`. */
export function agySummariesDbFile(
  home = os.homedir(),
  appDataDir = DEFAULT_AGY_APP_DATA_DIR,
): string {
  const dir = isSafeAgyAppDataDir(appDataDir) ? appDataDir : DEFAULT_AGY_APP_DATA_DIR
  return path.join(home, '.gemini', dir, 'conversation_summaries.db')
}

function trajectoryPaths(sessionId: string, appDataDir: string, home: string): string[] {
  if (!isSafeAgySessionId(sessionId) || !isSafeAgyAppDataDir(appDataDir)) return []
  const dir = path.join(home, '.gemini', appDataDir, 'conversations')
  return TRAJECTORY_EXTENSIONS.map((ext) => path.join(dir, `${sessionId}${ext}`))
}

/** Whether a `.db` or legacy `.pb` trajectory file exists for `sessionId` under `appDataDir`. */
export async function hasAgyTrajectory(
  sessionId: string,
  appDataDir: string,
  home = os.homedir(),
): Promise<boolean> {
  const candidates = trajectoryPaths(sessionId, appDataDir, home)
  for (const file of candidates) {
    try {
      if ((await stat(file)).isFile()) return true
    } catch {
      // Missing or unreadable candidate; check the next extension.
    }
  }
  return false
}

/** Synchronous variant of `hasAgyTrajectory` for synchronous path lookups. */
export function hasAgyTrajectorySync(
  sessionId: string,
  appDataDir: string,
  home = os.homedir(),
): boolean {
  const candidates = trajectoryPaths(sessionId, appDataDir, home)
  for (const file of candidates) {
    try {
      if (statSync(file).isFile()) return true
    } catch {
      // Missing or unreadable candidate; check the next extension.
    }
  }
  return false
}

function parseMetaRow(row: Record<string, unknown> | undefined): AgyConversationMeta | null {
  if (!row) return null
  const rawDir = typeof row.app_data_dir === 'string' ? row.app_data_dir.trim() : ''
  const appDataDir = isSafeAgyAppDataDir(rawDir) ? rawDir : null
  const rawSteps = row.step_count
  const stepCount =
    typeof rawSteps === 'number' && Number.isFinite(rawSteps) && rawSteps >= 0
      ? rawSteps
      : typeof rawSteps === 'bigint' && rawSteps >= 0n
        ? Number(rawSteps)
        : null
  return { appDataDir, stepCount }
}

/**
 * Reads `app_data_dir` and `step_count` for `sessionId` from agy's CLI summary database
 * (`<home>/.gemini/antigravity-cli/conversation_summaries.db`) in read-only mode.
 * Returns null when the file, table, column, or row is absent or unreadable.
 */
export async function readAgyConversationMeta(
  sessionId: string,
  home = os.homedir(),
): Promise<AgyConversationMeta | null> {
  if (!isSafeAgySessionId(sessionId)) return null
  const file = agySummariesDbFile(home, DEFAULT_AGY_APP_DATA_DIR)
  try {
    if (!(await stat(file)).isFile()) return null
  } catch {
    return null
  }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true, timeout: 0 })
    try {
      const row = db
        .prepare(
          'SELECT app_data_dir, step_count FROM conversation_summaries WHERE conversation_id = ? LIMIT 1',
        )
        .get(sessionId) as Record<string, unknown> | undefined
      return parseMetaRow(row)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/**
 * Resolves which `app_data_dir` owns an existing Antigravity session under `<home>/.gemini`.
 *
 * Precedence:
 * 1. Query `<home>/.gemini/antigravity-cli/conversation_summaries.db` for `app_data_dir`.
 * 2. Verify trajectory file presence (`.db` / `.pb`) under `<home>/.gemini/<appDataDir>/conversations/`.
 *    If the DB row points to a store without the trajectory file, check the fallback stores
 *    (`antigravity-cli`, then `antigravity`) on disk before trusting the DB value.
 * 3. When the DB is absent, locked, or has no `app_data_dir` for the session, fall back to
 *    checking trajectory presence under `antigravity-cli` then `antigravity`.
 */
export async function resolveAgyAppDataDir(
  sessionId: string,
  home = os.homedir(),
): Promise<string | null> {
  if (!isSafeAgySessionId(sessionId)) return null
  const meta = await readAgyConversationMeta(sessionId, home)
  const fromDb = meta?.appDataDir ?? null
  if (fromDb !== null) {
    if (await hasAgyTrajectory(sessionId, fromDb, home)) return fromDb
    if (
      fromDb !== DEFAULT_AGY_APP_DATA_DIR &&
      (await hasAgyTrajectory(sessionId, DEFAULT_AGY_APP_DATA_DIR, home))
    ) {
      return DEFAULT_AGY_APP_DATA_DIR
    }
    if (
      fromDb !== IDE_AGY_APP_DATA_DIR &&
      (await hasAgyTrajectory(sessionId, IDE_AGY_APP_DATA_DIR, home))
    ) {
      return IDE_AGY_APP_DATA_DIR
    }
    return fromDb
  }
  if (await hasAgyTrajectory(sessionId, DEFAULT_AGY_APP_DATA_DIR, home)) {
    return DEFAULT_AGY_APP_DATA_DIR
  }
  if (await hasAgyTrajectory(sessionId, IDE_AGY_APP_DATA_DIR, home)) {
    return IDE_AGY_APP_DATA_DIR
  }
  return null
}

/**
 * Synchronous filesystem check for an existing session's `app_data_dir`, used by synchronous path
 * lookups such as `AgentFiles.folder` without opening SQLite on the hot path.
 */
export function resolveAgyAppDataDirSync(sessionId: string, home = os.homedir()): string | null {
  if (!isSafeAgySessionId(sessionId)) return null
  if (hasAgyTrajectorySync(sessionId, DEFAULT_AGY_APP_DATA_DIR, home)) {
    return DEFAULT_AGY_APP_DATA_DIR
  }
  if (hasAgyTrajectorySync(sessionId, IDE_AGY_APP_DATA_DIR, home)) {
    return IDE_AGY_APP_DATA_DIR
  }
  return null
}

/**
 * Returns the non-default `--app-data-dir` value to pass when opening/resuming `sessionId`, or
 * `null` when `agy acp`'s default (`antigravity-cli`) should be used.
 */
export async function agyAppDataDirOverride(
  sessionId: string,
  home = os.homedir(),
): Promise<string | null> {
  const resolved = await resolveAgyAppDataDir(sessionId, home)
  if (resolved === null || resolved === DEFAULT_AGY_APP_DATA_DIR) return null
  return isSafeAgyAppDataDir(resolved) ? resolved : null
}
