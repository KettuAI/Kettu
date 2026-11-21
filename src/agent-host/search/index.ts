// The search index: the text of finished user messages and agent replies, kept in a file of its
// own beside the thread database. It is derived data: the file can be deleted and built again.
// node:sqlite is synchronous, so this runs in the thread workers, never on the host's event loop.

import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import { foldBulk } from '@shared/search-fold'
import { transaction } from '../sqlite'
import type { IndexedMessage } from './messages'
import { snippetOf } from './snippet'

/** The format of the tables; a newer format uses a file name of its own. */
export const INDEX_FORMAT = 1
export const INDEX_FILE = `search-${INDEX_FORMAT}.db`

// A word of fewer characters has no trigram, so it is matched by `instr` instead.
const TRIGRAM = 3

const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26
const SQLITE_CANTOPEN = 14

// `source` holds when each session's thread last changed as the index last saw it: the index of
// a session is current when that matches the thread database's own mark.
const TABLES = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
  CREATE TABLE source (session_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL) STRICT, WITHOUT ROWID;
  CREATE TABLE message (
    id         INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    pos        INTEGER NOT NULL,
    entry_id   TEXT NOT NULL,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    folded     TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX message_by_pos ON message (session_id, pos);
`

// The trigram index over the folded text, kept by the triggers as messages come and go.
const FTS = `
  CREATE VIRTUAL TABLE message_fts USING fts5(
    folded, content = 'message', content_rowid = 'id', tokenize = 'trigram');
  CREATE TRIGGER message_ai AFTER INSERT ON message BEGIN
    INSERT INTO message_fts (rowid, folded) VALUES (new.id, new.folded);
  END;
  CREATE TRIGGER message_ad AFTER DELETE ON message BEGIN
    INSERT INTO message_fts (message_fts, rowid, folded) VALUES ('delete', old.id, old.folded);
  END;
  CREATE TRIGGER message_au AFTER UPDATE ON message BEGIN
    INSERT INTO message_fts (message_fts, rowid, folded) VALUES ('delete', old.id, old.folded);
    INSERT INTO message_fts (rowid, folded) VALUES (new.id, new.folded);
  END;
`

type Row = Record<string, SQLOutputValue>
export type IndexLog = (level: 'info' | 'warn' | 'error', message: string) => void

/** A session with messages that hold every word of a search, and its latest such message. */
export interface Candidate {
  sessionId: string
  pos: number
  /** How many of its messages hold every word. */
  matches: number
  /** When its thread last changed, which orders candidates. */
  updatedAt: number
}

export interface SnippetPick {
  sessionId: string
  pos: number
}

export interface Snippet extends SnippetPick {
  entryId: string
  role: 'user' | 'agent'
  snippet: string
}

/** A message of one session that holds every word of a search. */
export interface SessionMatch {
  pos: number
  entryId: string
  role: 'user' | 'agent'
}

/** How far a build of the whole index has come: sessions done of the sessions it started with. */
export interface BuildProgress {
  done: number
  total: number
}

function resultCode(error: unknown): number | null {
  const errcode = (error as { errcode?: unknown } | null)?.errcode
  return typeof errcode === 'number' ? errcode & 0xff : null
}

/** Whether the file is damaged, or not an index of this format: it is built again. */
export function isIndexDamaged(error: unknown): boolean {
  const code = resultCode(error)
  return code === SQLITE_CORRUPT || code === SQLITE_NOTADB || error instanceof WrongIndexError
}

class WrongIndexError extends Error {}

/**
 * Whether this SQLite can run the trigram index a file already has. A file made by a Node.js
 * with FTS5 can be opened by one without (22.13 to 22.15): reads of the messages still work, but
 * every write fires a trigger into a module that is not there.
 */
function runsTrigram(db: DatabaseSync): boolean {
  try {
    db.prepare('SELECT 1 FROM message_fts LIMIT 0')
    return true
  } catch (error) {
    if (/no such (module|tokenizer)/i.test(message(error))) return false
    throw error
  }
}

/** An FTS5 phrase that matches `word` as it stands. */
const phrase = (word: string): string => `"${word.replace(/"/g, '""')}"`

export class SearchIndex {
  private readonly statements = new Map<string, StatementSync>()

  private constructor(
    private readonly db: DatabaseSync,
    /** Whether the trigram index exists; without it every word is matched by `instr`. */
    readonly hasFts: boolean,
  ) {}

  /**
   * Opens the index for writing, making it when there is none. A file that is damaged or of
   * another format is deleted and made again, which loses nothing: the index is derived.
   */
  static open(file: string, log: IndexLog, options: { fts?: boolean } = {}): SearchIndex {
    mkdirSync(path.dirname(file), { recursive: true })
    const fts = options.fts ?? true
    try {
      return SearchIndex.connect(file, log, fts)
    } catch (error) {
      if (!isIndexDamaged(error)) throw error
      log('warn', `Search index ${path.basename(file)} is unusable, built again: ${message(error)}`)
      SearchIndex.remove(file)
      return SearchIndex.connect(file, log, fts)
    }
  }

  /**
   * Opens the index for reading; null when there is no file, or it is not ready: the writer may
   * be making it, or it is damaged and the writer will make it again.
   */
  static openReader(file: string, log: IndexLog): SearchIndex | null {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(file, { readOnly: true })
      db.exec('PRAGMA busy_timeout = 5000')
      const { fts } = SearchIndex.readMeta(db)
      return new SearchIndex(db, fts && runsTrigram(db))
    } catch (error) {
      db?.close()
      if (resultCode(error) !== SQLITE_CANTOPEN) {
        log('info', `Search index is not readable yet: ${message(error)}`)
      }
      return null
    }
  }

  /** Deletes the file with its journal files. */
  static remove(file: string): void {
    for (const name of [file, `${file}-wal`, `${file}-shm`]) rmSync(name, { force: true })
  }

  private static readMeta(db: DatabaseSync): { fts: boolean } {
    let rows: Row[]
    try {
      rows = db.prepare('SELECT key, value FROM meta').all()
    } catch (error) {
      if (isIndexDamaged(error)) throw error
      throw new WrongIndexError(`no meta table: ${message(error)}`)
    }
    const meta = new Map(rows.map((row) => [String(row.key), String(row.value)]))
    if (meta.get('format') !== String(INDEX_FORMAT)) {
      throw new WrongIndexError(`format ${meta.get('format') ?? 'none'}, not ${INDEX_FORMAT}`)
    }
    return { fts: meta.get('fts') === '1' }
  }

  private static connect(file: string, log: IndexLog, withFts: boolean): SearchIndex {
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec('PRAGMA busy_timeout = 5000')
      const empty = db.prepare('SELECT count(*) AS n FROM sqlite_master').get()?.n === 0
      if (!empty) {
        const { fts } = SearchIndex.readMeta(db)
        if (fts && !runsTrigram(db)) {
          throw new WrongIndexError('its trigram index needs an FTS5 this SQLite does not have')
        }
        return new SearchIndex(db, fts)
      }
      db.exec('BEGIN')
      db.exec(TABLES)
      let fts = false
      try {
        if (withFts) db.exec(FTS)
        fts = withFts
      } catch (error) {
        log('warn', `Search index has no trigram index, words are scanned: ${message(error)}`)
      }
      const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      put.run('format', String(INDEX_FORMAT))
      put.run('fts', fts ? '1' : '0')
      db.exec('COMMIT')
      return new SearchIndex(db, fts)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close(): void {
    this.statements.clear()
    this.db.close()
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text)
    if (!statement) this.statements.set(text, (statement = this.db.prepare(text)))
    return statement
  }

  private transaction<T>(run: () => T): T {
    return transaction(this.db, run)
  }

  // Writing.

  private upsert(sessionId: string, messages: readonly IndexedMessage[]): void {
    const insert = this.sql(`
      INSERT INTO message (session_id, pos, entry_id, role, text, folded)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, pos) DO UPDATE SET
        entry_id = excluded.entry_id, role = excluded.role,
        text = excluded.text, folded = excluded.folded`)
    for (const { pos, entryId, role, text } of messages) {
      insert.run(sessionId, pos, entryId, role, text, foldBulk(text))
    }
  }

  /**
   * Applies what a write of a session changed: puts the messages at their positions and drops the
   * positions that hold none. The mark moves to `to` only when the session was current at `from`
   * (null for a session the write created), since otherwise changes before it are still missing.
   */
  apply(
    sessionId: string,
    changes: { upserts: readonly IndexedMessage[]; removed: readonly number[] },
    mark: { from: number | null; to: number },
  ): void {
    this.transaction(() => {
      this.upsert(sessionId, changes.upserts)
      const drop = this.sql('DELETE FROM message WHERE session_id = ? AND pos = ?')
      for (const pos of changes.removed) drop.run(sessionId, pos)
      if (mark.from === null) {
        this.sql(
          `INSERT INTO source (session_id, updated_at) VALUES (?, ?)
           ON CONFLICT (session_id) DO UPDATE SET updated_at = excluded.updated_at`,
        ).run(sessionId, mark.to)
      } else {
        this.sql('UPDATE source SET updated_at = ? WHERE session_id = ? AND updated_at = ?').run(
          mark.to,
          sessionId,
          mark.from,
        )
      }
    })
  }

  /** Replaces everything a session has with these messages, as after its thread was rewritten. */
  replace(sessionId: string, messages: readonly IndexedMessage[], updatedAt: number): void {
    this.transaction(() => {
      this.sql('DELETE FROM message WHERE session_id = ?').run(sessionId)
      this.upsert(sessionId, messages)
      this.setMark(sessionId, updatedAt)
    })
  }

  /** Drops a session's messages before they are read in again; its mark stays until then. */
  clear(sessionId: string): void {
    this.sql('DELETE FROM message WHERE session_id = ?').run(sessionId)
  }

  /** Puts messages read from the thread database, idempotently. */
  add(sessionId: string, messages: readonly IndexedMessage[]): void {
    this.transaction(() => this.upsert(sessionId, messages))
  }

  setMark(sessionId: string, updatedAt: number): void {
    this.sql(
      `INSERT INTO source (session_id, updated_at) VALUES (?, ?)
       ON CONFLICT (session_id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(sessionId, updatedAt)
  }

  remove(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return
    this.transaction(() => {
      const messages = this.sql('DELETE FROM message WHERE session_id = ?')
      const sources = this.sql('DELETE FROM source WHERE session_id = ?')
      for (const sessionId of sessionIds) {
        messages.run(sessionId)
        sources.run(sessionId)
      }
    })
  }

  /** When each indexed session's thread last changed, as the index saw it. */
  marks(): Map<string, number> {
    const rows = this.sql('SELECT session_id, updated_at FROM source').all()
    return new Map(rows.map((row) => [String(row.session_id), Number(row.updated_at)]))
  }

  mark(sessionId: string): number | null {
    const row = this.sql('SELECT updated_at FROM source WHERE session_id = ?').get(sessionId)
    return row ? Number(row.updated_at) : null
  }

  /** Records how far a build is, or that none is under way. */
  setBuild(progress: BuildProgress | null): void {
    this.transaction(() => {
      if (progress === null) {
        this.sql("DELETE FROM meta WHERE key IN ('build_done', 'build_total')").run()
        return
      }
      const put = this.sql(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      put.run('build_done', String(progress.done))
      put.run('build_total', String(progress.total))
    })
  }

  // Reading.

  /** The build under way, or null when the index is complete. */
  build(): BuildProgress | null {
    const rows = this.sql(
      "SELECT key, value FROM meta WHERE key IN ('build_done', 'build_total')",
    ).all()
    const meta = new Map(rows.map((row) => [String(row.key), Number(row.value)]))
    const done = meta.get('build_done')
    const total = meta.get('build_total')
    return done === undefined || total === undefined ? null : { done, total }
  }

  /**
   * The sessions with a message that holds every one of `words`, which are folded, most recently
   * changed first, each with its latest such message and how many hold them.
   */
  find(words: readonly string[]): Candidate[] {
    if (words.length === 0) return []
    const long = this.hasFts ? words.filter((word) => Array.from(word).length >= TRIGRAM) : []
    const short = words.filter((word) => !long.includes(word))
    const conditions: string[] = []
    const params: string[] = []
    if (long.length > 0) {
      conditions.push('id IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)')
      params.push(long.map(phrase).join(' AND '))
    }
    for (const word of short) {
      conditions.push('instr(folded, ?) > 0')
      params.push(word)
    }
    const rows = this.sql(
      `
      SELECT found.session_id, found.pos, found.matches, source.updated_at
      FROM (
        SELECT session_id, max(pos) AS pos, count(*) AS matches FROM message
        WHERE ${conditions.join(' AND ')} GROUP BY session_id
      ) AS found JOIN source ON source.session_id = found.session_id
      ORDER BY source.updated_at DESC`,
    ).all(...params)
    return rows.map((row: Row) => ({
      sessionId: String(row.session_id),
      pos: Number(row.pos),
      matches: Number(row.matches),
      updatedAt: Number(row.updated_at),
    }))
  }

  /**
   * The messages of one session that hold every one of `words`, which are folded, oldest first.
   * A session holds a few hundred thousand characters at most, so its rows are scanned with
   * `instr` instead of finding the words in the whole index first. With more than `limit`
   * messages the newest are kept and `capped` is true.
   */
  findIn(
    sessionId: string,
    words: readonly string[],
    limit: number,
  ): { matches: SessionMatch[]; capped: boolean } {
    if (words.length === 0) return { matches: [], capped: false }
    const conditions = words.map(() => 'instr(folded, ?) > 0').join(' AND ')
    const rows = this.sql(
      `SELECT pos, entry_id, role FROM message
       WHERE session_id = ? AND ${conditions} ORDER BY pos DESC LIMIT ?`,
    ).all(sessionId, ...words, limit + 1)
    const capped = rows.length > limit
    const matches = rows
      .slice(0, limit)
      .map((row: Row): SessionMatch => ({
        pos: Number(row.pos),
        entryId: String(row.entry_id),
        role: row.role === 'user' ? 'user' : 'agent',
      }))
      .reverse()
    return { matches, capped }
  }

  /** The text around the first of `words` in each of the messages picked. */
  snippets(words: readonly string[], picks: readonly SnippetPick[]): Snippet[] {
    const read = this.sql(
      'SELECT entry_id, role, text, folded FROM message WHERE session_id = ? AND pos = ?',
    )
    const out: Snippet[] = []
    for (const { sessionId, pos } of picks) {
      const row = read.get(sessionId, pos)
      if (!row) continue
      out.push({
        sessionId,
        pos,
        entryId: String(row.entry_id),
        role: row.role === 'user' ? 'user' : 'agent',
        snippet: snippetOf(String(row.text), String(row.folded), words[0]!),
      })
    }
    return out
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
