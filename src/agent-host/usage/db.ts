// The usage database: Kettu's record and the imported log rows, summed per quarter hour.
// node:sqlite is synchronous, so this runs in the usage worker, never on the host's event loop.

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import type { AgentId } from '@shared/thread'
import type { DayUsage, TokenParts, UsageSource, UsageSummary } from '@shared/usage'
import { PRICES, type FileCursor, type UsageRow } from './model'
import { keepsNewer } from './rows'

export const SCHEMA_VERSION = 2

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
    cache_write INTEGER NOT NULL,
    cache_write_1h INTEGER NOT NULL,
    turn        INTEGER NOT NULL
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
    cache_write_1h INTEGER NOT NULL,
    turns       INTEGER NOT NULL,
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

// Version 1 kept no split of the cache writes and no turns. Claude Code's rows are dropped, since
// its reader is the one that fills the hour's cache writes, and Kettu's buckets are rebuilt
// from its rows so their turns match.
const UPGRADE_1 = `
  ALTER TABLE usage ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usage ADD COLUMN turn INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE buckets ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE buckets ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;
  DELETE FROM usage WHERE source = 'log' AND agent_id = 'claude-code';
  DELETE FROM buckets WHERE source = 'log' AND agent_id = 'claude-code';
  DELETE FROM cursors WHERE agent_id = 'claude-code';
  UPDATE usage SET turn = 1 WHERE key IN (
    SELECT MIN(key) FROM usage WHERE source = 'kettu'
    GROUP BY substr(key, 1, length(key) - length(model))
  );
  DELETE FROM buckets WHERE source = 'kettu';
  INSERT INTO buckets (quarter, source, agent_id, model, project, rows, input, output, reasoning,
    cache_read, cache_write, cache_write_1h, turns)
  SELECT CAST(at / ${QUARTER_MS} AS INTEGER), source, agent_id, model, COALESCE(project, ''),
    COUNT(*), SUM(input), SUM(output), COALESCE(SUM(reasoning), 0), SUM(cache_read),
    SUM(cache_write), SUM(cache_write_1h), SUM(turn)
  FROM usage WHERE source = 'kettu'
  GROUP BY CAST(at / ${QUARTER_MS} AS INTEGER), source, agent_id, model, COALESCE(project, '');
`

/** The price list the queries join, in a temporary table of this connection. */
function fillPrices(db: DatabaseSync): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS prices (
    model TEXT PRIMARY KEY,
    input REAL NOT NULL,
    output REAL NOT NULL,
    cache_read REAL NOT NULL,
    cache_write REAL NOT NULL,
    cache_write_1h REAL
  )`)
  const insert = db.prepare(`
    INSERT OR REPLACE INTO prices (model, input, output, cache_read, cache_write, cache_write_1h)
    VALUES (?, ?, ?, ?, ?, ?)`)
  for (const [model, price] of Object.entries(PRICES.models)) {
    insert.run(
      model,
      price.input,
      price.output,
      price.cacheRead,
      price.cacheWrite,
      price.cacheWrite1h ?? null,
    )
  }
}

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
    requests: num(row.requests),
    turns: num(row.turns),
    // A sum over unpriced rows only is NULL: no model in it had a price.
    cost: row.cost === null || row.cost === undefined ? null : num(row.cost),
    unpricedTokens: num(row.unpriced_tokens),
    cacheSaved: num(row.cache_saved),
  }
}

/** A price matches a row's model by its name, or by the name without a stored trailing date. */
const PRICE_JOIN = `
  LEFT JOIN temp.prices AS p ON p.model = b.model
  LEFT JOIN temp.prices AS pd ON p.model IS NULL
    AND pd.model = CASE
      WHEN b.model GLOB '*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
      THEN substr(b.model, 1, length(b.model) - 9)
    END`
const INPUT_PRICE = 'COALESCE(p.input, pd.input)'
const OUTPUT_PRICE = 'COALESCE(p.output, pd.output)'
const READ_PRICE = 'COALESCE(p.cache_read, pd.cache_read)'
const WRITE_PRICE = 'COALESCE(p.cache_write, pd.cache_write)'
const HOUR_PRICE = `COALESCE(p.cache_write_1h, pd.cache_write_1h, ${WRITE_PRICE})`
const PRICED = 'COALESCE(p.model, pd.model) IS NOT NULL'

const SUMS = `
  SUM(b.rows) AS requests,
  SUM(b.turns) AS turns,
  SUM(b.input) AS input,
  SUM(b.output) AS output,
  SUM(b.reasoning) AS reasoning,
  SUM(b.cache_read) AS cache_read,
  SUM(b.cache_write) AS cache_write,
  SUM(CASE WHEN ${PRICED} THEN
    b.input * ${INPUT_PRICE}
    + (b.output + b.reasoning) * ${OUTPUT_PRICE}
    + b.cache_read * ${READ_PRICE}
    + (b.cache_write - b.cache_write_1h) * ${WRITE_PRICE}
    + b.cache_write_1h * ${HOUR_PRICE}
    ELSE NULL END) AS cost,
  SUM(CASE WHEN ${PRICED} THEN 0
    ELSE b.input + b.output + b.reasoning + b.cache_read + b.cache_write END) AS unpriced_tokens,
  SUM(CASE WHEN ${PRICED} THEN b.cache_read * (${INPUT_PRICE} - ${READ_PRICE}) ELSE 0 END)
    AS cache_saved`

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
        reasoning, cache_read, cache_write, cache_write_1h, turn)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateRow: sql(`
      UPDATE usage SET session_id = ?, project = ?, model = ?, at = ?, input = ?, output = ?,
        reasoning = ?, cache_read = ?, cache_write = ?, cache_write_1h = ?, turn = ?
      WHERE key = ?`),
    addBucket: sql(`
      INSERT INTO buckets (quarter, source, agent_id, model, project, rows, input, output,
        reasoning, cache_read, cache_write, cache_write_1h, turns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (quarter, source, agent_id, model, project) DO UPDATE SET
        rows = rows + excluded.rows,
        input = input + excluded.input,
        output = output + excluded.output,
        reasoning = reasoning + excluded.reasoning,
        cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write,
        cache_write_1h = cache_write_1h + excluded.cache_write_1h,
        turns = turns + excluded.turns`),
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
      SELECT b.quarter, b.agent_id, b.source, b.model, ${SUMS} FROM buckets b ${PRICE_JOIN}
      WHERE b.quarter >= ? AND b.quarter < ?
      GROUP BY b.quarter, b.agent_id, b.source, b.model`),
    modelBuckets: sql(`
      SELECT b.agent_id, b.source, b.model, ${SUMS} FROM buckets b ${PRICE_JOIN}
      WHERE b.quarter >= ? AND b.quarter < ?
      GROUP BY b.agent_id, b.source, b.model`),
    projectBuckets: sql(`
      SELECT b.agent_id, b.source, b.project, b.model, ${SUMS} FROM buckets b ${PRICE_JOIN}
      WHERE b.quarter >= ? AND b.quarter < ?
      GROUP BY b.agent_id, b.source, b.project, b.model`),
    totals: sql(`
      SELECT b.agent_id, b.source, b.model, ${SUMS} FROM buckets b ${PRICE_JOIN}
      WHERE b.quarter >= ? AND b.quarter < ?
      GROUP BY b.agent_id, b.source, b.model`),
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
      } else if (version < SCHEMA_VERSION) {
        this.upgrade(db, version)
      }
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
      fillPrices(db)
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

  /** Brings an older file to `SCHEMA_VERSION` in one transaction. */
  private upgrade(db: DatabaseSync, from: number): void {
    db.exec('BEGIN')
    try {
      if (from === 1) db.exec(UPGRADE_1)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
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
      sign * row.cacheWrite1h,
      sign * row.turn,
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
              row.cacheWrite1h,
              row.turn,
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
            row.cacheWrite1h,
            row.turn,
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
        const projects = new Map<string, Omit<DbSummary['projects'][number], 'scratch'>>()
        for (const row of sql.projectBuckets.all(quarterOf(from), quarterOf(to)).filter(counts)) {
          const agentId = String(row.agent_id) as AgentId
          const project = row.project === '' ? null : String(row.project)
          const key = `${agentId}\n${project ?? ''}`
          const sum = projects.get(key)
          if (sum) addParts(sum, parts(row))
          else projects.set(key, { agentId, project, ...parts(row) })
        }
        return {
          days: [...days.values()],
          models,
          projects: [...projects.values()],
          pricesAsOf: PRICES.asOf,
        }
      },
      { days: [], models: [], projects: [], pricesAsOf: PRICES.asOf },
    )
  }

  /** Each agent's sums over [from, to), for the counted sources. */
  totals(from: number, to: number, sources: SourceMap): (TokenParts & { agentId: AgentId })[] {
    return this.guard((sql) => {
      const agents = new Map<AgentId, TokenParts & { agentId: AgentId }>()
      for (const row of sql.totals
        .all(quarterOf(from), quarterOf(to))
        .filter((row) => sources[String(row.agent_id) as AgentId] === String(row.source))) {
        const agentId = String(row.agent_id) as AgentId
        const sum = agents.get(agentId)
        if (sum) addParts(sum, parts(row))
        else agents.set(agentId, { agentId, ...parts(row) })
      }
      return [...agents.values()]
    }, [])
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

  /** Deletes Kettu's own record; the imported logs stay. */
  clearRecord(): void {
    this.guard((sql, db) => {
      this.transaction(db, () => {
        sql.deleteSourceRows.run('kettu')
        sql.deleteSourceBuckets.run('kettu')
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
  sum.requests += add.requests
  sum.turns += add.turns
  sum.unpricedTokens += add.unpricedTokens
  sum.cacheSaved += add.cacheSaved
  // Priced groups add up; the sum stays null while every group it holds is unpriced.
  if (add.cost !== null) sum.cost = (sum.cost ?? 0) + add.cost
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
    cacheWrite1h: num(row.cache_write_1h),
    turn: num(row.turn),
  }
}
