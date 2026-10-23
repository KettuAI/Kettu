// The usage database: OverBench's record and the imported log rows, summed per quarter hour.
// node:sqlite is synchronous, so this runs in the usage worker, never on the host's event loop.

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import type { AgentId } from '@shared/thread'
import type { DayUsage, TokenParts, UsageSource, UsageSummary } from '@shared/usage'
import type { FileCursor, UsageRow } from './model'
import { keepsNewer } from './rows'

export const SCHEMA_VERSION = 1

/** Every time zone's offset is a multiple of 15 minutes, so a local day is a range of these. */
export const QUARTER_MS = 900_000

const SCHEMA = `
  CREATE TABLE usage (
    key         TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    session_id  TEXT,
    project     TEXT,
    model       TEXT NOT NULL,
    at          INTEGER NOT NULL,
    input       INTEGER NOT NULL,
    output      INTEGER NOT NULL,
    reasoning   INTEGER,
    cache_read  INTEGER NOT NULL,
    cache_write INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX usage_by_agent ON usage (source, agent_id);
  CREATE TABLE buckets (
    quarter     INTEGER NOT NULL,
    source      TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    model       TEXT NOT NULL,
    project     TEXT NOT NULL,
    rows        INTEGER NOT NULL,
    input       INTEGER NOT NULL,
    output      INTEGER NOT NULL,
    reasoning   INTEGER NOT NULL,
    cache_read  INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    PRIMARY KEY (quarter, source, agent_id, model, project)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE cursors (
    id        TEXT PRIMARY KEY,
    agent_id  TEXT NOT NULL,
    size      INTEGER NOT NULL,
    mtime_ns  INTEGER NOT NULL,
    offset    INTEGER NOT NULL,
    tail      INTEGER,
    state     TEXT,
    seen_at   INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX cursors_by_agent ON cursors (agent_id);
`

// SQLite's primary result codes, the low byte of node:sqlite's `errcode`.
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

export type UsageDbStatus = 'ok' | 'created' | 'recovered' | 'newer' | 'unavailable'
export type UsageDbLog = (level: 'info' | 'warn' | 'error', message: string) => void

/** Which source counts for each agent; an agent left out counts nothing. */
export type SourceMap = Partial<Record<AgentId, UsageSource>>

export type DbSummary = Omit<UsageSummary, 'sources' | 'first' | 'agents' | 'projects'> & {
  projects: Omit<UsageSummary['projects'][number], 'scratch'>[]
}

/** What one agent's rows from one source hold, for Settings and the page's first day. */
export interface SourceStats {
  agentId: AgentId
  source: UsageSource
  rows: number
  first: number
  last: number
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

const num = (value: SQLOutputValue | undefined): number => Number(value ?? 0)
const quarterOf = (at: number): number => Math.floor(at / QUARTER_MS)

function parts(row: Row): TokenParts {
  return {
    input: num(row.input),
    output: num(row.output),
    reasoning: num(row.reasoning),
    cacheRead: num(row.cache_read),
    cacheWrite: num(row.cache_write),
  }
}

const SUMS =
  'SUM(input) AS input, SUM(output) AS output, SUM(reasoning) AS reasoning, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write'

function prepareAll(db: DatabaseSync) {
  const sql = (text: string): StatementSync => db.prepare(text)
  const cursor = sql('SELECT * FROM cursors WHERE id = ?')
  // mtime_ns is past 2^53.
  cursor.setReadBigInts(true)
  return {
    cursor,
    row: sql('SELECT * FROM usage WHERE key = ?'),
    insertRow: sql(`
      INSERT INTO usage (key, source, agent_id, session_id, project, model, at, input, output,
        reasoning, cache_read, cache_write)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateRow: sql(`
      UPDATE usage SET session_id = ?, project = ?, model = ?, at = ?, input = ?, output = ?,
        reasoning = ?, cache_read = ?, cache_write = ?
      WHERE key = ?`),
    addBucket: sql(`
      INSERT INTO buckets (quarter, source, agent_id, model, project, rows, input, output,
        reasoning, cache_read, cache_write)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (quarter, source, agent_id, model, project) DO UPDATE SET
        rows = rows + excluded.rows,
        input = input + excluded.input,
        output = output + excluded.output,
        reasoning = reasoning + excluded.reasoning,
        cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write`),
    dropEmptyBucket: sql(
      `DELETE FROM buckets
      WHERE quarter = ? AND source = ? AND agent_id = ? AND model = ? AND project = ? AND rows <= 0`,
    ),
    putCursor: sql(`
      INSERT INTO cursors (id, agent_id, size, mtime_ns, offset, tail, state, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        agent_id = excluded.agent_id,
        size = excluded.size,
        mtime_ns = excluded.mtime_ns,
        offset = excluded.offset,
        tail = excluded.tail,
        state = excluded.state,
        seen_at = excluded.seen_at`),
    dayBuckets: sql(`
      SELECT quarter, agent_id, source, ${SUMS} FROM buckets
      WHERE quarter >= ? AND quarter < ? GROUP BY quarter, agent_id, source`),
    modelBuckets: sql(`
      SELECT agent_id, source, model, ${SUMS} FROM buckets
      WHERE quarter >= ? AND quarter < ? GROUP BY agent_id, source, model`),
    projectBuckets: sql(`
      SELECT agent_id, source, project, ${SUMS} FROM buckets
      WHERE quarter >= ? AND quarter < ? GROUP BY agent_id, source, project`),
    totals: sql(`
      SELECT agent_id, source, ${SUMS} FROM buckets
      WHERE quarter >= ? AND quarter < ? GROUP BY agent_id, source`),
    stats: sql(`
      SELECT agent_id, source, SUM(rows) AS rows, MIN(quarter) AS first, MAX(quarter) AS last
      FROM buckets GROUP BY agent_id, source`),
    deleteRows: sql('DELETE FROM usage WHERE source = ? AND agent_id = ?'),
    deleteBuckets: sql('DELETE FROM buckets WHERE source = ? AND agent_id = ?'),
    deleteCursors: sql('DELETE FROM cursors WHERE agent_id = ?'),
    deleteSourceRows: sql('DELETE FROM usage WHERE source = ?'),
    deleteSourceBuckets: sql('DELETE FROM buckets WHERE source = ?'),
  }
}

type Statements = ReturnType<typeof prepareAll>

export class UsageDb {
  private db: DatabaseSync | null = null
  private sql: Statements | null = null
  status: UsageDbStatus = 'ok'

  private constructor(
    private readonly file: string,
    private readonly log: UsageDbLog,
    private readonly now: () => number,
  ) {}

  /** Opens the file, creating it, or moving a damaged one aside and starting empty. */
  static open(file: string, log: UsageDbLog, now: () => number = Date.now): UsageDb {
    const store = new UsageDb(file, log, now)
    mkdirSync(path.dirname(file), { recursive: true })
    try {
      store.connect()
    } catch (error) {
      if (!isCorrupt(error)) throw error
      store.recover(error)
    }
    return store
  }

  get open(): boolean {
    return this.db !== null
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
          `${path.basename(this.file)} has schema version ${version}, newer than this app understands (${SCHEMA_VERSION}); usage is neither read nor written this run`,
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
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
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
      `${path.basename(this.file)} is damaged (${(error as Error).message}); it was moved to ${path.basename(target)} and usage starts empty`,
    )
    this.status = 'recovered'
    this.connect()
  }

  /** Runs `run`, turning damage into a fresh database; null while the database is not open. */
  private guard<T>(run: (sql: Statements, db: DatabaseSync) => T, fallback: T): T {
    const { sql, db } = this
    if (!sql || !db) return fallback
    try {
      return run(sql, db)
    } catch (error) {
      if (isCorrupt(error)) this.recover(error)
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

  private bucket(sql: Statements, row: UsageRow, sign: 1 | -1): void {
    const quarter = quarterOf(row.at)
    // A key column cannot be null; '' stands for no project.
    const project = row.project ?? ''
    sql.addBucket.run(
      quarter,
      row.source,
      row.agentId,
      row.model,
      project,
      sign,
      sign * row.input,
      sign * row.output,
      sign * (row.reasoning ?? 0),
      sign * row.cacheRead,
      sign * row.cacheWrite,
    )
    if (sign < 0) sql.dropEmptyBucket.run(quarter, row.source, row.agentId, row.model, project)
  }

  /**
   * Stores rows, adding each new one to its bucket and moving a grown one by the difference,
   * and the cursor they were read up to, in one transaction. Returns how many rows changed.
   */
  write(rows: readonly UsageRow[], cursor: FileCursor | null = null): number {
    return this.guard((sql, db) => {
      let changed = 0
      this.transaction(db, () => {
        for (const row of rows) {
          const stored = sql.row.get(row.key)
          if (!stored) {
            sql.insertRow.run(
              row.key,
              row.source,
              row.agentId,
              row.sessionId,
              row.project,
              row.model,
              row.at,
              row.input,
              row.output,
              row.reasoning,
              row.cacheRead,
              row.cacheWrite,
            )
            this.bucket(sql, row, 1)
            changed++
            continue
          }
          const previous = fromRow(stored)
          if (!keepsNewer(previous, row)) continue
          sql.updateRow.run(
            row.sessionId,
            row.project,
            row.model,
            row.at,
            row.input,
            row.output,
            row.reasoning,
            row.cacheRead,
            row.cacheWrite,
            row.key,
          )
          this.bucket(sql, previous, -1)
          this.bucket(sql, { ...row, source: previous.source, agentId: previous.agentId }, 1)
          changed++
        }
        if (cursor) {
          sql.putCursor.run(
            cursor.id,
            cursor.agentId,
            cursor.size,
            cursor.mtimeNs,
            cursor.offset,
            cursor.tail,
            cursor.state,
            this.now(),
          )
        }
      })
      return changed
    }, 0)
  }

  cursor(id: string): FileCursor | null {
    return this.guard((sql) => {
      const row = sql.cursor.get(id)
      if (!row) return null
      return {
        id: String(row.id),
        agentId: String(row.agent_id) as AgentId,
        size: num(row.size),
        mtimeNs: BigInt(row.mtime_ns as bigint),
        offset: num(row.offset),
        tail: row.tail === null ? null : num(row.tail),
        state: row.state === null ? null : String(row.state),
      }
    }, null)
  }

  /**
   * Sums per period and agent over `dayStarts`, local days or a day's hours (n periods take n + 1
   * ascending boundaries, each on a quarter hour), and per model and per project over [from, to).
   */
  summary(dayStarts: readonly number[], from: number, to: number, sources: SourceMap): DbSummary {
    return this.guard(
      (sql) => {
        const counts = (row: Row): boolean =>
          sources[String(row.agent_id) as AgentId] === String(row.source)
        const days = new Map<string, DayUsage>()
        if (dayStarts.length > 1) {
          const quarters = dayStarts.map(quarterOf)
          let day = 0
          const rows = sql.dayBuckets.all(quarters[0]!, quarters[quarters.length - 1]!)
          // Rows come grouped, not ordered; sorting keeps the walk over the days forward only.
          rows.sort((a, b) => num(a.quarter) - num(b.quarter))
          for (const row of rows) {
            if (!counts(row)) continue
            const quarter = num(row.quarter)
            while (day < quarters.length - 2 && quarter >= quarters[day + 1]!) day++
            const agentId = String(row.agent_id) as AgentId
            const key = `${day}\n${agentId}`
            const sum = days.get(key)
            if (sum) addParts(sum, parts(row))
            else days.set(key, { day, agentId, ...parts(row) })
          }
        }
        const models = sql.modelBuckets
          .all(quarterOf(from), quarterOf(to))
          .filter(counts)
          .map((row) => ({
            agentId: String(row.agent_id) as AgentId,
            model: String(row.model),
            ...parts(row),
          }))
        const projects = sql.projectBuckets
          .all(quarterOf(from), quarterOf(to))
          .filter(counts)
          .map((row) => ({
            agentId: String(row.agent_id) as AgentId,
            project: row.project === '' ? null : String(row.project),
            ...parts(row),
          }))
        return { days: [...days.values()], models, projects }
      },
      { days: [], models: [], projects: [] },
    )
  }

  /** Each agent's sums over [from, to), for the counted sources. */
  totals(from: number, to: number, sources: SourceMap): (TokenParts & { agentId: AgentId })[] {
    return this.guard(
      (sql) =>
        sql.totals
          .all(quarterOf(from), quarterOf(to))
          .filter((row) => sources[String(row.agent_id) as AgentId] === String(row.source))
          .map((row) => ({ agentId: String(row.agent_id) as AgentId, ...parts(row) })),
      [],
    )
  }

  stats(): SourceStats[] {
    return this.guard(
      (sql) =>
        sql.stats.all().map((row) => ({
          agentId: String(row.agent_id) as AgentId,
          source: String(row.source) as UsageSource,
          rows: num(row.rows),
          first: num(row.first) * QUARTER_MS,
          last: (num(row.last) + 1) * QUARTER_MS,
        })),
      [],
    )
  }

  /** Forgets an agent's imported rows and cursors, so the next scan reads its logs afresh. */
  removeLogs(agentId: AgentId): void {
    this.guard((sql, db) => {
      this.transaction(db, () => {
        sql.deleteRows.run('log', agentId)
        sql.deleteBuckets.run('log', agentId)
        sql.deleteCursors.run(agentId)
      })
    }, undefined)
  }

  /** Deletes OverBench's own record; the imported logs stay. */
  clearRecord(): void {
    this.guard((sql, db) => {
      this.transaction(db, () => {
        sql.deleteSourceRows.run('overbench')
        sql.deleteSourceBuckets.run('overbench')
      })
    }, undefined)
  }

  close(checkpoint = true): void {
    const db = this.db
    this.db = null
    this.sql = null
    if (!db) return
    try {
      if (checkpoint) db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }
  }
}

function addParts(sum: TokenParts, add: TokenParts): void {
  sum.input += add.input
  sum.output += add.output
  sum.reasoning += add.reasoning
  sum.cacheRead += add.cacheRead
  sum.cacheWrite += add.cacheWrite
}

function fromRow(row: Row): UsageRow {
  return {
    key: String(row.key),
    source: String(row.source) as UsageSource,
    agentId: String(row.agent_id) as AgentId,
    sessionId: row.session_id === null ? null : String(row.session_id),
    project: row.project === null ? null : String(row.project),
    model: String(row.model),
    at: num(row.at),
    input: num(row.input),
    output: num(row.output),
    reasoning: row.reasoning === null ? null : num(row.reasoning),
    cacheRead: num(row.cache_read),
    cacheWrite: num(row.cache_write),
  }
}
