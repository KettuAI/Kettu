// The thread database: every session's entries in one SQLite file, read a page at a time.
// node:sqlite is synchronous, so this runs in the thread worker, never on the host's event loop.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import { isThreadEntry, type ThreadEntry } from '@shared/thread'
import {
  attachmentBlobs,
  EMPTY_SESSION,
  INLINE_IMAGE_LIMIT,
  mapRefs,
  PAGE_ENTRIES,
  PAGE_LIMIT,
  parseStoredSession,
  turnOf,
  type PositionedEntry,
  type StoredBlob,
  type StoredSession,
  type StoredThread,
  type ThreadHead,
  type ThreadPage,
  type ThreadWrite,
} from './model'
import type { ThreadDbStatus, ThreadErrorCode } from './protocol'

export const SCHEMA_VERSION = 1

// `turn` is the position of the entry that opened the entry's turn, so a page that starts at a
// turn is one range of the primary key.
const SCHEMA = `
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

// SQLite's primary result codes, the low byte of node:sqlite's `errcode`.
const SQLITE_CORRUPT = 11
const SQLITE_CONSTRAINT = 19
const SQLITE_NOTADB = 26
// Above every position; SQLite compares it as a 64-bit integer.
const END = Number.MAX_SAFE_INTEGER

export type ThreadDbLog = (level: 'info' | 'warn' | 'error', message: string) => void

export class ThreadDbError extends Error {
  constructor(
    message: string,
    readonly code: ThreadErrorCode,
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
  }
}

type Statements = ReturnType<typeof prepareAll>

export class ThreadDb {
  private db: DatabaseSync | null = null
  private sql: Statements | null = null
  status: ThreadDbStatus = 'ok'

  private constructor(
    private readonly file: string,
    private readonly log: ThreadDbLog,
    private readonly now: () => number,
  ) {}

  /** Opens the file, creating it, or moving a damaged one aside and starting empty. */
  static open(file: string, log: ThreadDbLog, now: () => number = Date.now): ThreadDb {
    const store = new ThreadDb(file, log, now)
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
          `${path.basename(this.file)} has schema version ${version}, newer than this app understands (${SCHEMA_VERSION}); threads are neither read nor written this run`,
        )
        return
      }
      if (version === 0) {
        // auto_vacuum takes effect only before the first table exists.
        db.exec('PRAGMA auto_vacuum = INCREMENTAL')
        db.exec('PRAGMA journal_mode = WAL')
        db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`)
        if (this.status === 'ok') this.status = 'created'
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
      `${path.basename(this.file)} is damaged (${(error as Error).message}); it was moved to ${path.basename(target)} and threads start empty`,
    )
    this.status = 'recovered'
    this.connect()
  }

  /** Runs `run`, turning damage into a fresh database and SQLite's errors into ours. */
  private guard<T>(run: (sql: Statements, db: DatabaseSync) => T, fallback: T): T {
    const { sql, db } = this
    if (!sql || !db) return fallback
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

  private transaction(db: DatabaseSync, run: () => void): void {
    db.exec('BEGIN')
    try {
      run()
      db.exec('COMMIT')
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
          this.log('warn', `Image ${ref.blob} of session ${sessionId} is missing`)
          return { kind: 'unsupported', label: String(ref.mimeType) }
        }
        const data = Buffer.from(blob.data as Uint8Array).toString('base64')
        return { kind: 'image', mimeType: ref.mimeType, data }
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
   * `PAGE_ENTRIES` entries back to the start of their turn, cut at `PAGE_LIMIT`. Null when the
   * session has no stored thread, or a part of it does not parse.
   */
  page(sessionId: string, before: number | null): ThreadPage | null {
    return this.guard((sql) => {
      const bound = before ?? END
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

  /** The entry's JSON, with large images moved into the session's blobs. */
  private storedJson(sql: Statements, sessionId: string, entry: ThreadEntry): string {
    const stored = mapRefs(entry as unknown as Record<string, unknown>, (ref) => {
      if (
        ref.kind !== 'image' ||
        typeof ref.data !== 'string' ||
        ref.data.length <= INLINE_IMAGE_LIMIT
      ) {
        return ref
      }
      const bytes = Buffer.from(ref.data, 'base64')
      const hash = createHash('sha256').update(bytes).digest('hex')
      sql.insertBlob.run(sessionId, hash, String(ref.mimeType), bytes)
      return { kind: 'image', mimeType: ref.mimeType, blob: hash }
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
        if (change.replace) {
          for (const hash of attachmentBlobs(change.entries.map(({ entry }) => entry))) {
            const row = sql.blob.get(sessionId, hash)
            if (row) kept.push({ hash, mime: String(row.mime), data: row.data as Uint8Array })
          }
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

  /** Drops the threads of these sessions, with their images, and returns the space. */
  remove(sessionIds: readonly string[]): void {
    this.guard((sql, db) => {
      this.transaction(db, () => {
        for (const sessionId of sessionIds) sql.deleteThread.run(sessionId)
      })
      db.exec('PRAGMA incremental_vacuum')
    }, undefined)
  }

  /** Folds the WAL into the file and closes it; a later call does nothing. */
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
