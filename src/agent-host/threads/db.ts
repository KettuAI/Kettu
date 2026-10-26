// The thread database: every session's entries in one SQLite file, read a page at a time.
// node:sqlite is synchronous, so this runs in the thread worker, never on the host's event loop.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import { type ArtifactState, NO_SESSION } from '@shared/artifacts'
import { OUTLINE_TEXT } from '@shared/outline'
import { isRoutineRun, type RoutineRun } from '@shared/routines'
import { isThreadEntry, type ThreadEntry } from '@shared/thread'
import {
  contentHash,
  moveContent,
  putContent,
  removeContent,
  sweepContent,
} from '../artifacts/content'
import type {
  ArtifactCalls,
  ArtifactListing,
  ArtifactRecord,
  VersionRecord,
} from '../artifacts/model'
import type { RoutineCall, RoutineCalls, RoutineRunStats } from '../routines/calls'
import {
  attachmentBlobs,
  EMPTY_SESSION,
  INLINE_MEDIA_LIMIT,
  mapRefs,
  PAGE_ENTRIES,
  PAGE_LIMIT,
  parseStoredSession,
  turnOf,
  type OutlineRow,
  type PositionedEntry,
  type StoredBlob,
  type StoredOutline,
  type StoredSession,
  type StoredThread,
  type ThreadHead,
  type ThreadPage,
  type ThreadWrite,
} from './model'
import type { ThreadDbStatus, ThreadErrorCode } from './protocol'

export const SCHEMA_VERSION = 4

// `turn` is the position of the entry that opened the entry's turn, so a page that starts at a
// turn is one range of the primary key.
const THREADS = `
  CREATE TABLE threads (
    session_id     TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL,
    acp_session_id TEXT NOT NULL,
    session_json   TEXT NOT NULL,
    next_pos       INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE entries (
    session_id TEXT NOT NULL REFERENCES threads (session_id) ON DELETE CASCADE,
    pos        INTEGER NOT NULL,
    turn       INTEGER NOT NULL,
    entry_id   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    json       TEXT NOT NULL,
    PRIMARY KEY (session_id, pos)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX entries_by_id ON entries (session_id, entry_id);
  CREATE INDEX entries_by_kind ON entries (session_id, kind, pos);
  CREATE TABLE blobs (
    session_id TEXT NOT NULL REFERENCES threads (session_id) ON DELETE CASCADE,
    hash       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    PRIMARY KEY (session_id, hash)
  ) STRICT, WITHOUT ROWID;
`

// Artifacts do not reference threads, so deleting a session keeps its artifacts. `project` is the
// project's folder or the session's scratch folder; `hash` names the version's content file.
const ARTIFACTS = `
  CREATE TABLE artifacts (
    id         TEXT PRIMARY KEY,
    project    TEXT NOT NULL,
    title      TEXT NOT NULL,
    head       INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  ) STRICT;
  CREATE INDEX artifacts_by_project ON artifacts (project, updated_at);
  CREATE TABLE artifact_versions (
    artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    n           INTEGER NOT NULL,
    hash        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    pages       INTEGER NOT NULL,
    author      TEXT,
    note        TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, n)
  ) STRICT, WITHOUT ROWID;
`

// Runs do not reference threads, so a run keeps its record when its session is deleted.
const ROUTINE_RUNS = `
  CREATE TABLE routine_runs (
    routine_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    run_id     TEXT NOT NULL,
    session_id TEXT,
    status     TEXT NOT NULL,
    json       TEXT NOT NULL,
    PRIMARY KEY (routine_id, seq)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX routine_runs_by_id ON routine_runs (run_id);
`

// The message outline's titles, by the position of their user message.
const OUTLINE_TITLES = `
  CREATE TABLE outline_titles (
    session_id TEXT NOT NULL REFERENCES threads (session_id) ON DELETE CASCADE,
    pos        INTEGER NOT NULL,
    title      TEXT NOT NULL,
    PRIMARY KEY (session_id, pos)
  ) STRICT, WITHOUT ROWID;
`

/** What brings a database of the version before each key up to it; a new one runs them all. */
const MIGRATIONS: Record<number, string> = { 2: ARTIFACTS, 3: ROUTINE_RUNS, 4: OUTLINE_TITLES }

// SQLite's primary result codes, the low byte of node:sqlite's `errcode`.
const SQLITE_CORRUPT = 11
const SQLITE_CONSTRAINT = 19
const SQLITE_NOTADB = 26
// Above every position; SQLite compares it as a 64-bit integer.
const END = Number.MAX_SAFE_INTEGER
// The content refs that carry bytes, which a large one keeps in the blobs table.
const CARRIED_KINDS: ReadonlySet<string> = new Set(['image', 'audio', 'video'])

export type ThreadDbLog = (level: 'info' | 'warn' | 'error', message: string) => void

export class ThreadDbError extends Error {
  constructor(
    message: string,
    readonly code: ThreadErrorCode,
    readonly data?: ArtifactState,
  ) {
    super(message)
    this.name = 'ThreadDbError'
  }
}

function resultCode(error: unknown): number | null {
  const errcode = (error as { errcode?: unknown } | null)?.errcode
  return typeof errcode === 'number' ? errcode & 0xff : null
}

const isCorrupt = (error: unknown): boolean => {
  const code = resultCode(error)
  return code === SQLITE_CORRUPT || code === SQLITE_NOTADB
}

type Row = Record<string, SQLOutputValue>

// An artifact with its latest version; it shows under the session that made that version, or
// under its creator when the user made it.
const LISTING = `
  SELECT a.id, a.title, a.project, COALESCE(v.author, a.session_id) AS shown_under, a.head,
    v.pages, v.size, a.updated_at, a.deleted_at
  FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id AND v.n = a.head`

const optionalText = (value: SQLOutputValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value)

function artifactRecord(row: Row): ArtifactRecord {
  return {
    id: String(row.id),
    project: String(row.project),
    title: String(row.title),
    head: Number(row.head),
    sessionId: String(row.session_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  }
}

function versionRecord(row: Row): VersionRecord {
  return {
    version: Number(row.n),
    hash: String(row.hash),
    size: Number(row.size),
    pages: Number(row.pages),
    author: optionalText(row.author),
    note: optionalText(row.note),
    createdAt: Number(row.created_at),
  }
}

function listing(row: Row): ArtifactListing {
  return {
    id: String(row.id),
    title: String(row.title),
    project: String(row.project),
    sessionId: String(row.shown_under),
    version: Number(row.head),
    pages: Number(row.pages),
    size: Number(row.size),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  }
}

const stateOf = (artifact: ArtifactRecord): ArtifactState => ({
  version: artifact.head,
  deleted: artifact.deletedAt !== null,
})

function prepareAll(db: DatabaseSync) {
  const sql = (text: string): StatementSync => db.prepare(text)
  return {
    thread: sql(
      'SELECT agent_id, acp_session_id, session_json, next_pos FROM threads WHERE session_id = ?',
    ),
    pageStart: sql(`
      SELECT MIN(turn) AS start FROM (
        SELECT turn FROM entries WHERE session_id = ? AND pos < ? ORDER BY pos DESC LIMIT ?)`),
    pageFloor: sql(
      'SELECT pos FROM entries WHERE session_id = ? AND pos < ? ORDER BY pos DESC LIMIT 1 OFFSET ?',
    ),
    range: sql(
      'SELECT pos, json FROM entries WHERE session_id = ? AND pos >= ? AND pos < ? ORDER BY pos',
    ),
    previous: sql(
      'SELECT pos, kind, turn FROM entries WHERE session_id = ? AND pos < ? ORDER BY pos DESC LIMIT 1',
    ),
    latestPlan: sql(
      "SELECT pos, json FROM entries WHERE session_id = ? AND kind = 'plan' ORDER BY pos DESC LIMIT 1",
    ),
    byId: sql('SELECT pos FROM entries WHERE session_id = ? AND entry_id = ?'),
    turnFrom: sql(
      'SELECT turn FROM entries WHERE session_id = ? AND pos >= ? ORDER BY pos LIMIT 1',
    ),
    // A message's text as `outlineText` reads it, in two parts.
    userMessages: sql(`
      SELECT e.pos, e.entry_id, t.title,
        substr((SELECT group_concat(json_extract(part.value, '$.text'), char(10))
          FROM json_each(e.json, '$.content') AS part
          WHERE json_extract(part.value, '$.type') = 'text'), 1, ?2) AS text,
        (SELECT group_concat(COALESCE(
            json_extract(part.value, '$.ref.attachment.name'),
            json_extract(part.value, '$.ref.name')), ', ')
          FROM json_each(e.json, '$.content') AS part
          WHERE json_extract(part.value, '$.type') = 'ref') AS names
      FROM entries e LEFT JOIN outline_titles t ON t.session_id = e.session_id AND t.pos = e.pos
      WHERE e.session_id = ?1 AND e.kind = 'user' ORDER BY e.pos`),
    titles: sql('SELECT pos, title FROM outline_titles WHERE session_id = ?'),
    userAt: sql("SELECT 1 FROM entries WHERE session_id = ? AND pos = ? AND kind = 'user'"),
    putTitle: sql(`
      INSERT INTO outline_titles (session_id, pos, title) VALUES (?, ?, ?)
      ON CONFLICT (session_id, pos) DO UPDATE SET title = excluded.title`),
    insertEntry: sql(
      'INSERT INTO entries (session_id, pos, turn, entry_id, kind, json) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    updateEntry: sql('UPDATE entries SET json = ? WHERE session_id = ? AND pos = ?'),
    upsertThread: sql(`
      INSERT INTO threads (session_id, agent_id, acp_session_id, session_json, next_pos, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        acp_session_id = excluded.acp_session_id,
        session_json = excluded.session_json,
        next_pos = excluded.next_pos,
        updated_at = excluded.updated_at`),
    deleteThread: sql('DELETE FROM threads WHERE session_id = ?'),
    insertBlob: sql(
      'INSERT OR IGNORE INTO blobs (session_id, hash, mime, data) VALUES (?, ?, ?, ?)',
    ),
    blob: sql('SELECT mime, data FROM blobs WHERE session_id = ? AND hash = ?'),
    // `entries.json`, since json_each has a hidden column of that name.
    mentions: sql(`SELECT 1 FROM entries WHERE session_id = ?1 AND (
      (kind = 'agent' AND instr(json_extract(json, '$.markdown'), ?2) > 0)
      OR (kind = 'user' AND EXISTS (
        SELECT 1 FROM json_each(entries.json, '$.content') AS part
        WHERE json_extract(part.value, '$.type') = 'text'
          AND instr(json_extract(part.value, '$.text'), ?2) > 0
      ))
    ) LIMIT 1`),
    artifact: sql(
      'SELECT id, project, title, head, session_id, created_at, updated_at, deleted_at FROM artifacts WHERE id = ?',
    ),
    version: sql(
      'SELECT n, hash, size, pages, author, note, created_at FROM artifact_versions WHERE artifact_id = ? AND n = ?',
    ),
    versions: sql(
      'SELECT n, hash, size, pages, author, note, created_at FROM artifact_versions WHERE artifact_id = ? ORDER BY n DESC',
    ),
    listed: sql(`${LISTING} WHERE a.deleted_at IS NULL ORDER BY a.updated_at DESC, a.id DESC`),
    listedIn: sql(
      `${LISTING} WHERE a.project = ? AND a.deleted_at IS NULL ORDER BY a.updated_at DESC, a.id DESC`,
    ),
    listedDeleted: sql(
      `${LISTING} WHERE a.deleted_at IS NOT NULL ORDER BY a.deleted_at DESC, a.id DESC`,
    ),
    insertArtifact: sql(`
      INSERT INTO artifacts (id, project, title, head, session_id, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)`),
    insertVersion: sql(`
      INSERT INTO artifact_versions (artifact_id, n, hash, size, pages, author, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    setHead: sql('UPDATE artifacts SET head = ?, updated_at = ? WHERE id = ?'),
    setTitle: sql('UPDATE artifacts SET title = ? WHERE id = ?'),
    setDeleted: sql('UPDATE artifacts SET deleted_at = ? WHERE id = ?'),
    deleteArtifact: sql('DELETE FROM artifacts WHERE id = ?'),
    expire: sql('DELETE FROM artifacts WHERE deleted_at IS NOT NULL AND deleted_at < ?'),
    hashesOf: sql('SELECT DISTINCT hash FROM artifact_versions WHERE artifact_id = ?'),
    named: sql('SELECT 1 AS named FROM artifact_versions WHERE hash = ? LIMIT 1'),
    allHashes: sql('SELECT DISTINCT hash FROM artifact_versions'),
    runSeq: sql('SELECT seq FROM routine_runs WHERE run_id = ?'),
    lastSeq: sql('SELECT MAX(seq) AS seq FROM routine_runs WHERE routine_id = ?'),
    insertRun: sql(
      'INSERT INTO routine_runs (routine_id, seq, run_id, session_id, status, json) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    updateRun: sql('UPDATE routine_runs SET session_id = ?, status = ?, json = ? WHERE run_id = ?'),
    pageRuns: sql(
      'SELECT seq, json FROM routine_runs WHERE routine_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
    ),
    lastRun: sql('SELECT json FROM routine_runs WHERE routine_id = ? ORDER BY seq DESC LIMIT 1'),
    activeRun: sql(
      "SELECT json FROM routine_runs WHERE routine_id = ? AND status IN ('queued', 'starting', 'running', 'waiting') ORDER BY seq DESC LIMIT 1",
    ),
    activeRuns: sql(
      "SELECT json FROM routine_runs WHERE status IN ('queued', 'starting', 'running', 'waiting') ORDER BY routine_id, seq",
    ),
    sessionCount: sql(
      'SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ? AND session_id IS NOT NULL',
    ),
    unseenFailed: sql(
      "SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ? AND status IN ('failed', 'timed_out') AND json_extract(json, '$.seen') = 0",
    ),
    unseenEnded: sql(
      "SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ? AND status IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted') AND json_extract(json, '$.seen') = 0",
    ),
    beyond: sql(
      'SELECT run_id, session_id FROM routine_runs WHERE routine_id = ? AND session_id IS NOT NULL ORDER BY seq DESC LIMIT -1 OFFSET ?',
    ),
    runsOfSession: sql(
      'SELECT seq, run_id, routine_id, json FROM routine_runs WHERE session_id = ?',
    ),
    unseenRuns: sql(
      "SELECT seq, run_id, json FROM routine_runs WHERE routine_id = ? AND json_extract(json, '$.seen') = 0 AND status IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')",
    ),
    deleteRoutineRuns: sql('DELETE FROM routine_runs WHERE routine_id = ?'),
  }
}

type Statements = ReturnType<typeof prepareAll>

export class ThreadDb {
  private db: DatabaseSync | null = null
  private sql: Statements | null = null
  status: ThreadDbStatus = 'ok'
  /** False once the content folder could not follow a damaged database aside. */
  private sweeps = true

  private constructor(
    private readonly file: string,
    private readonly log: ThreadDbLog,
    private readonly now: () => number,
    private readonly contentDir: string | null,
  ) {}

  /**
   * Opens the file, creating it, or moving a damaged one aside and starting empty. Artifacts keep
   * their HTML in `contentDir`; without one, no artifact can be written.
   */
  static open(
    file: string,
    log: ThreadDbLog,
    now: () => number = Date.now,
    contentDir: string | null = null,
  ): ThreadDb {
    const store = new ThreadDb(file, log, now, contentDir)
    mkdirSync(path.dirname(file), { recursive: true })
    try {
      store.connect()
    } catch (error) {
      if (!isCorrupt(error)) throw error
      store.recover(error)
    }
    return store
  }

  private connect(): void {
    const db = new DatabaseSync(this.file)
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
      if (version > SCHEMA_VERSION) {
        db.close()
        this.status = 'newer'
        this.log(
          'warn',
          `${path.basename(this.file)} has schema version ${version}, newer than this app understands (${SCHEMA_VERSION}); threads and artifacts are neither read nor written this run`,
        )
        return
      }
      if (version === 0) {
        // auto_vacuum takes effect only before the first table exists.
        db.exec('PRAGMA auto_vacuum = INCREMENTAL')
        db.exec('PRAGMA journal_mode = WAL')
        const schema = [THREADS, ...Object.values(MIGRATIONS)].join('')
        db.exec(`BEGIN; ${schema} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`)
        if (this.status === 'ok') this.status = 'created'
      } else if (version < SCHEMA_VERSION) {
        let steps = ''
        for (let next = version + 1; next <= SCHEMA_VERSION; next++) steps += MIGRATIONS[next]
        db.exec(`BEGIN; ${steps} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`)
        this.log('info', `Migrated ${path.basename(this.file)} from schema version ${version}`)
      }
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')
      this.sql = prepareAll(db)
      this.db = db
    } catch (error) {
      try {
        db.close()
      } catch {
        // Closing a handle that failed to read anything can fail too; the first error matters.
      }
      throw error
    }
  }

  /** Moves the damaged file and its WAL aside, keeping them together, and starts empty. */
  private recover(error: unknown): void {
    try {
      this.close(false)
    } catch {
      // A damaged file may refuse to close cleanly; it is moved aside either way.
    }
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    const target = `${this.file}.corrupt-${stamp}`
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(this.file + suffix)) renameSync(this.file + suffix, target + suffix)
    }
    this.log(
      'error',
      `${path.basename(this.file)} is damaged (${(error as Error).message}); it was moved to ${path.basename(target)} and threads and artifacts start empty`,
    )
    // The HTML goes with the records that name it, or the next purge would sweep every file.
    if (this.contentDir) {
      const content = `${this.contentDir}.corrupt-${stamp}`
      try {
        if (moveContent(this.contentDir, content)) {
          this.log('error', `The artifacts' content was moved to ${path.basename(content)}`)
        }
      } catch (moveError) {
        this.sweeps = false
        this.log(
          'error',
          `The artifacts' content could not be moved aside (${(moveError as Error).message}); the purge leaves it alone this run`,
        )
      }
    }
    this.status = 'recovered'
    this.connect()
  }

  /**
   * Runs `run`, turning damage into a fresh database and SQLite's errors into ours; `fallback` is
   * the answer while the database is not open.
   */
  private guard<T>(run: (sql: Statements, db: DatabaseSync) => T, fallback: T): T {
    const { sql, db } = this
    if (!sql || !db) return fallback
    return this.attempt(sql, db, run)
  }

  /** As `guard`, for what has no answer without the database: it fails with `unavailable`. */
  private must<T>(run: (sql: Statements, db: DatabaseSync) => T): T {
    const { sql, db } = this
    if (!sql || !db) throw new ThreadDbError('The thread database is not open', 'unavailable')
    return this.attempt(sql, db, run)
  }

  private attempt<T>(
    sql: Statements,
    db: DatabaseSync,
    run: (sql: Statements, db: DatabaseSync) => T,
  ): T {
    try {
      return run(sql, db)
    } catch (error) {
      if (error instanceof ThreadDbError) throw error
      if (isCorrupt(error)) {
        this.recover(error)
        throw new ThreadDbError(
          `The thread database was damaged: ${(error as Error).message}`,
          'corrupt',
        )
      }
      if (resultCode(error) === SQLITE_CONSTRAINT) {
        throw new ThreadDbError((error as Error).message, 'conflict')
      }
      throw error
    }
  }

  private transaction<T>(db: DatabaseSync, run: () => T): T {
    db.exec('BEGIN')
    try {
      const result = run()
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  // Reading.

  private headOf(
    sql: Statements,
    sessionId: string,
  ): (ThreadHead & { session: StoredSession }) | null {
    const row = sql.thread.get(sessionId)
    if (!row) return null
    let session: StoredSession | null = null
    try {
      session = parseStoredSession(JSON.parse(String(row.session_json)))
    } catch {
      // Reported below with the session.
    }
    if (!session) {
      this.log('error', `The stored session view of ${sessionId} does not parse`)
      return null
    }
    return {
      agentId: String(row.agent_id) as ThreadHead['agentId'],
      acpSessionId: String(row.acp_session_id),
      session,
    }
  }

  /** An entry as stored, with its images put back; null when it does not parse. */
  private entryOf(sql: Statements, sessionId: string, row: Row): ThreadEntry | null {
    let value: unknown
    try {
      value = JSON.parse(String(row.json))
    } catch {
      value = null
    }
    if (typeof value === 'object' && value !== null) {
      value = mapRefs(value as Record<string, unknown>, (ref) => {
        if (typeof ref.blob !== 'string') return ref
        const blob = sql.blob.get(sessionId, ref.blob)
        if (!blob) {
          this.log('warn', `Media ${ref.blob} of session ${sessionId} is missing`)
          return { kind: 'unsupported', label: String(ref.mimeType) }
        }
        const restored: Record<string, unknown> = {
          ...ref,
          data: Buffer.from(blob.data as Uint8Array).toString('base64'),
        }
        delete restored.blob
        return restored
      })
    }
    if (isThreadEntry(value)) return value
    this.log('error', `Entry ${String(row.pos)} of session ${sessionId} does not parse`)
    return null
  }

  private entriesOf(sql: Statements, sessionId: string, rows: Row[]): ThreadEntry[] | null {
    const entries: ThreadEntry[] = []
    for (const row of rows) {
      const entry = this.entryOf(sql, sessionId, row)
      if (!entry) return null
      entries.push(entry)
    }
    return entries
  }

  private pageOf(
    sql: Statements,
    sessionId: string,
    from: number,
    before: number,
  ): ThreadPage | null {
    const head = this.headOf(sql, sessionId)
    if (!head) return null
    const entries = this.entriesOf(sql, sessionId, sql.range.all(sessionId, from, before))
    if (!entries) return null
    const older = sql.previous.get(sessionId, from) ? from : null
    let plan: ThreadPage['plan'] = null
    const latest = sql.latestPlan.get(sessionId)
    if (latest && Number(latest.pos) < from) {
      const entry = this.entryOf(sql, sessionId, latest)
      if (entry?.kind === 'plan') plan = entry
    }
    const { session, ...rest } = head
    return { head: rest, session, entries, from, older, plan }
  }

  /**
   * The page that ends below `before`, or the latest page when it is null: at least
   * `PAGE_ENTRIES` entries back to the start of their turn, cut at `PAGE_LIMIT`. With `reach`, it
   * goes back to the start of the turn holding that position instead, uncut. Null when the
   * session has no stored thread, or a part of it does not parse.
   */
  page(sessionId: string, before: number | null, reach: number | null = null): ThreadPage | null {
    return this.guard((sql) => {
      const bound = before ?? END
      if (reach !== null && reach < bound) {
        const turn = sql.turnFrom.get(sessionId, reach)?.turn
        const start = turn === undefined || turn === null ? reach : Math.min(Number(turn), reach)
        return this.pageOf(sql, sessionId, start, bound)
      }
      const start = sql.pageStart.get(sessionId, bound, PAGE_ENTRIES)?.start
      if (start === null || start === undefined) {
        const head = this.headOf(sql, sessionId)
        if (!head) return null
        const { session, ...rest } = head
        const end = before ?? Number(sql.thread.get(sessionId)?.next_pos ?? 0)
        return { head: rest, session, entries: [], from: end, older: null, plan: null }
      }
      let from = Number(start)
      const floor = sql.pageFloor.get(sessionId, bound, PAGE_LIMIT - 1)?.pos
      if (floor !== undefined && floor !== null && Number(floor) > from) from = Number(floor)
      return this.pageOf(sql, sessionId, from, bound)
    }, null)
  }

  /** Everything from `from` to the end, for a window the renderer holds already. */
  tail(sessionId: string, from: number): ThreadPage | null {
    return this.guard((sql) => this.pageOf(sql, sessionId, from, END), null)
  }

  /** The session's user messages with their titles, oldest first; null without a stored thread. */
  outline(sessionId: string): StoredOutline | null {
    return this.guard((sql) => {
      const head = this.headOf(sql, sessionId)
      if (!head) return null
      const entries: OutlineRow[] = sql.userMessages.all(sessionId, OUTLINE_TEXT).map((row) => ({
        pos: Number(row.pos),
        entryId: String(row.entry_id),
        text: optionalText(row.text) || (optionalText(row.names) ?? ''),
        title: optionalText(row.title),
      }))
      const { session, ...rest } = head
      return { head: rest, session, entries }
    }, null)
  }

  /** Stores the outline's titles of a session's messages; false when it has no stored thread. */
  setOutlineTitles(sessionId: string, titles: readonly { pos: number; title: string }[]): boolean {
    return this.guard(
      (sql, db) =>
        this.transaction(db, () => {
          if (!sql.thread.get(sessionId)) return false
          for (const { pos, title } of titles) sql.putTitle.run(sessionId, pos, title)
          return true
        }),
      false,
    )
  }

  /** The whole thread, for a session whose agent connects. */
  load(sessionId: string): StoredThread | null {
    return this.guard((sql) => {
      const head = this.headOf(sql, sessionId)
      if (!head) return null
      const entries: PositionedEntry[] = []
      for (const row of sql.range.all(sessionId, 0, END)) {
        const entry = this.entryOf(sql, sessionId, row)
        if (!entry) return null
        entries.push({ pos: Number(row.pos), entry })
      }
      const { session, ...rest } = head
      return { head: rest, session, entries }
    }, null)
  }

  // Writing.

  /** The entry's JSON, with large images, sounds and clips moved into the session's blobs. */
  private storedJson(sql: Statements, sessionId: string, entry: ThreadEntry): string {
    const stored = mapRefs(entry as unknown as Record<string, unknown>, (ref) => {
      if (
        !CARRIED_KINDS.has(String(ref.kind)) ||
        typeof ref.data !== 'string' ||
        ref.data.length <= INLINE_MEDIA_LIMIT
      ) {
        return ref
      }
      const bytes = Buffer.from(ref.data, 'base64')
      const hash = createHash('sha256').update(bytes).digest('hex')
      sql.insertBlob.run(sessionId, hash, String(ref.mimeType), bytes)
      const moved: Record<string, unknown> = { ...ref, blob: hash }
      delete moved.data
      return moved
    })
    return JSON.stringify(stored)
  }

  /**
   * Writes new and changed entries in one transaction. A changed entry must be stored at the
   * position given; when it is not, or a new one's position is taken, nothing changes and the
   * write fails with `conflict`.
   */
  write(sessionId: string, change: ThreadWrite): void {
    this.guard((sql, db) => {
      this.transaction(db, () => {
        // Writing whole drops the session's bytes with its rows; those its attachments name stay.
        const kept: StoredBlob[] = []
        // So do the outline's titles, whose positions keep their messages.
        let titles: Row[] = []
        if (change.replace) {
          for (const hash of attachmentBlobs(change.entries.map(({ entry }) => entry))) {
            const row = sql.blob.get(sessionId, hash)
            if (row) kept.push({ hash, mime: String(row.mime), data: row.data as Uint8Array })
          }
          titles = sql.titles.all(sessionId)
          sql.deleteThread.run(sessionId)
        }
        const stored = sql.thread.get(sessionId)
        let nextPos = Number(stored?.next_pos ?? 0)
        for (const { pos } of change.entries) nextPos = Math.max(nextPos, pos + 1)
        const session = change.session
          ? JSON.stringify(change.session)
          : stored
            ? String(stored.session_json)
            : JSON.stringify(EMPTY_SESSION)
        sql.upsertThread.run(
          sessionId,
          change.head.agentId,
          change.head.acpSessionId,
          session,
          nextPos,
          this.now(),
        )
        for (const blob of [...kept, ...(change.blobs ?? [])]) {
          sql.insertBlob.run(sessionId, blob.hash, blob.mime, blob.data)
        }
        const entries = [...change.entries].sort((a, b) => a.pos - b.pos)
        for (const { pos, entry } of entries) {
          const json = this.storedJson(sql, sessionId, entry)
          const known = sql.byId.get(sessionId, entry.id)
          if (known) {
            if (Number(known.pos) !== pos) {
              throw new ThreadDbError(
                `Entry ${entry.id} of session ${sessionId} is stored at ${String(known.pos)}, not ${pos}`,
                'conflict',
              )
            }
            sql.updateEntry.run(json, sessionId, pos)
            continue
          }
          const previous = sql.previous.get(sessionId, pos)
          const turn = turnOf(
            entry,
            pos,
            previous ? { kind: String(previous.kind), turn: Number(previous.turn) } : null,
          )
          sql.insertEntry.run(sessionId, pos, turn, entry.id, entry.kind, json)
        }
        for (const { pos, title } of titles) {
          if (sql.userAt.get(sessionId, pos)) sql.putTitle.run(sessionId, pos, title)
        }
      })
    }, undefined)
  }

  /** The bytes a session keeps under this hash, as for a sent attachment; null when none. */
  blob(sessionId: string, hash: string): StoredBlob | null {
    return this.guard((sql) => {
      const row = sql.blob.get(sessionId, hash)
      return row ? { hash, mime: String(row.mime), data: row.data as Uint8Array } : null
    }, null)
  }

  /**
   * Whether the text of an agent reply or a user message of the session holds `text`, as the
   * live thread tells it (`entryHolds`).
   */
  mentions(sessionId: string, text: string): boolean {
    return this.guard((sql) => sql.mentions.get(sessionId, text) !== undefined, false)
  }

  /** Drops the threads of these sessions, with their images, and returns the space. */
  remove(sessionIds: readonly string[]): void {
    this.guard((sql, db) => {
      this.transaction(db, () => {
        for (const sessionId of sessionIds) sql.deleteThread.run(sessionId)
      })
      db.exec('PRAGMA incremental_vacuum')
    }, undefined)
  }

  // Artifacts.

  /**
   * The artifact within `project`, or anywhere for null: another project's artifact does not
   * exist for a session. `live` refuses one in Recently deleted.
   */
  private artifactIn(
    sql: Statements,
    id: string,
    project: string | null,
    live: boolean,
  ): ArtifactRecord {
    const row = sql.artifact.get(id)
    const artifact = row ? artifactRecord(row) : null
    if (!artifact || (project !== null && artifact.project !== project)) {
      throw new ThreadDbError(`No artifact ${id}`, 'not_found')
    }
    if (live && artifact.deletedAt !== null) {
      throw new ThreadDbError(`${id} is in Recently deleted`, 'deleted', stateOf(artifact))
    }
    return artifact
  }

  /** Refuses a new version unless it starts from the latest. */
  private fromHead(artifact: ArtifactRecord, baseVersion: number): void {
    if (baseVersion === artifact.head) return
    throw new ThreadDbError(
      `${artifact.id} is at version ${artifact.head}, not ${baseVersion}`,
      'conflict',
      stateOf(artifact),
    )
  }

  /** Writes the HTML's file, unless it is there, and returns what its version row records. */
  private putHtml(html: string): { hash: string; size: number } {
    if (!this.contentDir) {
      throw new ThreadDbError('There is no folder for artifact content', 'unavailable')
    }
    const hash = contentHash(html)
    putContent(this.contentDir, hash, html)
    return { hash, size: Buffer.byteLength(html, 'utf8') }
  }

  listArtifacts(params: ArtifactCalls['list']['params']): ArtifactListing[] {
    return this.must((sql) => {
      const rows =
        params.project !== null
          ? sql.listedIn.all(params.project)
          : params.deleted
            ? sql.listedDeleted.all()
            : sql.listed.all()
      return rows.map(listing)
    })
  }

  getArtifact({
    id,
    version,
    project,
  }: ArtifactCalls['get']['params']): ArtifactCalls['get']['result'] {
    return this.must((sql) => {
      const artifact = this.artifactIn(sql, id, project, project !== null)
      const n = version ?? artifact.head
      const row = sql.version.get(id, n)
      if (!row) throw new ThreadDbError(`${id} has no version ${n}`, 'not_found')
      return { artifact, version: versionRecord(row) }
    })
  }

  artifactVersions({ id, project }: ArtifactCalls['versions']['params']): VersionRecord[] {
    return this.must((sql) => {
      this.artifactIn(sql, id, project, project !== null)
      return sql.versions.all(id).map(versionRecord)
    })
  }

  /**
   * Makes an artifact with its first version, written by the session that creates it, or by the
   * user when `sessionId` is NO_SESSION.
   */
  createArtifact(params: ArtifactCalls['create']['params']): { version: number } {
    return this.must((sql, db) =>
      this.transaction(db, () => {
        const { id, project, sessionId, title, pages, note, at } = params
        const { hash, size } = this.putHtml(params.html)
        sql.insertArtifact.run(id, project, title, sessionId, at, at)
        const author = sessionId === NO_SESSION ? null : sessionId
        sql.insertVersion.run(id, 1, hash, size, pages, author, note, at)
        return { version: 1 }
      }),
    )
  }

  writeArtifact(params: ArtifactCalls['write']['params']): { version: number } {
    return this.must((sql, db) =>
      this.transaction(db, () => {
        const artifact = this.artifactIn(sql, params.id, params.project, true)
        this.fromHead(artifact, params.baseVersion)
        const { hash, size } = this.putHtml(params.html)
        const n = artifact.head + 1
        const { pages, author, note, at } = params
        sql.insertVersion.run(artifact.id, n, hash, size, pages, author, note, at)
        sql.setHead.run(n, at, artifact.id)
        return { version: n }
      }),
    )
  }

  /** Writes an earlier version again as the newest; the two share one file. */
  restoreArtifact(params: ArtifactCalls['restore']['params']): { version: number } {
    return this.must((sql, db) =>
      this.transaction(db, () => {
        const artifact = this.artifactIn(sql, params.id, params.project, true)
        this.fromHead(artifact, params.baseVersion)
        const row = sql.version.get(artifact.id, params.version)
        if (!row) {
          throw new ThreadDbError(`${artifact.id} has no version ${params.version}`, 'not_found')
        }
        const restored = versionRecord(row)
        const n = artifact.head + 1
        const { author, note, at } = params
        sql.insertVersion.run(
          artifact.id,
          n,
          restored.hash,
          restored.size,
          restored.pages,
          author,
          note,
          at,
        )
        sql.setHead.run(n, at, artifact.id)
        return { version: n }
      }),
    )
  }

  /** The title is not versioned: renaming changes the artifact, not a version or its time. */
  renameArtifact({ id, project, title }: ArtifactCalls['rename']['params']): void {
    this.must((sql) => {
      this.artifactIn(sql, id, project, project !== null)
      sql.setTitle.run(title, id)
    })
  }

  deleteArtifact({
    id,
    project,
    at,
  }: ArtifactCalls['delete']['params']): ArtifactCalls['delete']['result'] {
    return this.must((sql) => {
      const artifact = this.artifactIn(sql, id, project, false)
      if (artifact.deletedAt !== null) return { deletedAt: artifact.deletedAt, changed: false }
      sql.setDeleted.run(at, id)
      return { deletedAt: at, changed: true }
    })
  }

  undeleteArtifact(id: string): { changed: boolean } {
    return this.must((sql) => {
      const artifact = this.artifactIn(sql, id, null, false)
      if (artifact.deletedAt === null) return { changed: false }
      sql.setDeleted.run(null, id)
      return { changed: true }
    })
  }

  /** Removes an artifact in Recently deleted with every version, and the files only it named. */
  eraseArtifact(id: string): void {
    this.must((sql, db) => {
      const artifact = this.artifactIn(sql, id, null, false)
      if (artifact.deletedAt === null) {
        throw new ThreadDbError(`${id} is not in Recently deleted`, 'conflict', stateOf(artifact))
      }
      const hashes = sql.hashesOf.all(id).map((row) => String(row.hash))
      sql.deleteArtifact.run(id)
      if (this.contentDir) {
        removeContent(
          this.contentDir,
          hashes.filter((hash) => !sql.named.get(hash)),
        )
      }
      db.exec('PRAGMA incremental_vacuum')
    })
  }

  /**
   * Removes the artifacts deleted before `before`, their versions by cascade, and then
   * every content file no version names, a crash's leftovers included. Does nothing while the
   * database is not open, since it cannot tell which files are named.
   */
  purgeArtifacts(before: number): { artifacts: number; files: number } {
    return this.guard(
      (sql, db) => {
        const artifacts = Number(sql.expire.run(before).changes)
        const named = new Set(sql.allHashes.all().map((row) => String(row.hash)))
        const files = this.contentDir && this.sweeps ? sweepContent(this.contentDir, named) : 0
        if (artifacts > 0) db.exec('PRAGMA incremental_vacuum')
        return { artifacts, files }
      },
      { artifacts: 0, files: 0 },
    )
  }

  /** Folds the WAL into the file and closes it; a later call does nothing. */
  // Routine runs.

  private runOf(json: unknown): RoutineRun | null {
    if (typeof json !== 'string') return null
    try {
      const value = JSON.parse(json) as unknown
      return isRoutineRun(value) ? value : null
    } catch {
      return null
    }
  }

  /** Adds the run with the routine's next seq, or updates it by its id. */
  routinePut({ routineId, run }: RoutineCalls['put']['params']): { seq: number } {
    return this.must((sql) => {
      const existing = sql.runSeq.get(run.id) as { seq: number } | undefined
      const json = JSON.stringify(run)
      if (existing) {
        sql.updateRun.run(run.sessionId, run.status, json, run.id)
        return { seq: Number(existing.seq) }
      }
      const last = sql.lastSeq.get(routineId) as { seq: number | null } | undefined
      const seq = Number(last?.seq ?? 0) + 1
      sql.insertRun.run(routineId, seq, run.id, run.sessionId, run.status, json)
      return { seq }
    })
  }

  routinePage({
    routineId,
    before,
    limit,
  }: RoutineCalls['page']['params']): RoutineCalls['page']['result'] {
    return this.must((sql) => {
      const rows = sql.pageRuns.all(routineId, before ?? END, limit + 1) as {
        seq: number
        json: string
      }[]
      const shown = rows.slice(0, limit)
      const runs = shown
        .map((row) => this.runOf(row.json))
        .filter((run): run is RoutineRun => run !== null)
      const older = rows.length > limit ? Number(shown[shown.length - 1]!.seq) : null
      return { runs, older }
    })
  }

  routineStats({ routineId }: RoutineCalls['stats']['params']): RoutineRunStats {
    return this.must((sql) => {
      const count = (row: unknown): number => Number((row as { n?: number })?.n ?? 0)
      const last = sql.lastRun.get(routineId) as { json: string } | undefined
      const active = sql.activeRun.get(routineId) as { json: string } | undefined
      return {
        sessions: count(sql.sessionCount.get(routineId)),
        unseenFailed: count(sql.unseenFailed.get(routineId)),
        unseenEnded: count(sql.unseenEnded.get(routineId)),
        last: last ? this.runOf(last.json) : null,
        active: active ? this.runOf(active.json) : null,
      }
    })
  }

  /** The runs with a session beyond the newest `keep`, oldest first. */
  routineBeyond({
    routineId,
    keep,
  }: RoutineCalls['beyond']['params']): RoutineCalls['beyond']['result'] {
    return this.must((sql) => {
      const rows = sql.beyond.all(routineId, keep) as { run_id: string; session_id: string }[]
      return rows
        .map((row) => ({ runId: String(row.run_id), sessionId: String(row.session_id) }))
        .reverse()
    })
  }

  routineActive(): RoutineCalls['active']['result'] {
    return this.guard((sql) => {
      const rows = sql.activeRuns.all() as { json: string }[]
      return rows
        .map((row) => this.runOf(row.json))
        .filter((run): run is RoutineRun => run !== null)
    }, [])
  }

  routineClearSession({
    sessionId,
  }: RoutineCalls['clearSession']['params']): RoutineCalls['clearSession']['result'] {
    return this.must((sql, db) =>
      this.transaction(db, () => {
        const rows = sql.runsOfSession.all(sessionId) as {
          seq: number
          run_id: string
          routine_id: string
          json: string
        }[]
        const updated: RoutineRun[] = []
        for (const row of rows) {
          const run = this.runOf(row.json)
          if (!run) continue
          const next: RoutineRun = { ...run, sessionId: null }
          sql.updateRun.run(null, next.status, JSON.stringify(next), next.id)
          updated.push(next)
        }
        return updated
      }),
    )
  }

  routineMarkSeen({ routineId }: RoutineCalls['markSeen']['params']): null {
    this.must((sql, db) =>
      this.transaction(db, () => {
        const rows = sql.unseenRuns.all(routineId) as {
          seq: number
          run_id: string
          json: string
        }[]
        for (const row of rows) {
          const run = this.runOf(row.json)
          if (!run || run.seen) continue
          const next: RoutineRun = { ...run, seen: true }
          sql.updateRun.run(next.sessionId, next.status, JSON.stringify(next), next.id)
        }
        return null
      }),
    )
    return null
  }

  routineRemove({ routineId }: RoutineCalls['remove']['params']): null {
    this.guard((sql, db) => {
      this.transaction(db, () => sql.deleteRoutineRuns.run(routineId))
      db.exec('PRAGMA incremental_vacuum')
    }, undefined)
    return null
  }

  /** One routine call, for the worker's `routine` op. */
  routine(call: RoutineCall): unknown {
    switch (call.name) {
      case 'put':
        return this.routinePut(call.params)
      case 'page':
        return this.routinePage(call.params)
      case 'stats':
        return this.routineStats(call.params)
      case 'beyond':
        return this.routineBeyond(call.params)
      case 'active':
        return this.routineActive()
      case 'clearSession':
        return this.routineClearSession(call.params)
      case 'markSeen':
        return this.routineMarkSeen(call.params)
      case 'remove':
        return this.routineRemove(call.params)
    }
  }

  close(checkpoint = true): void {
    const db = this.db
    this.db = null
    this.sql = null
    if (!db) return
    try {
      if (checkpoint) db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch (error) {
      this.log('warn', `Could not fold the thread database's WAL: ${(error as Error).message}`)
    }
    db.close()
  }
}
