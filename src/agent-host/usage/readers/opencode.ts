// OpenCode's usage from its SQLite database, opened read-only while OpenCode may be writing it:
// one row per completed assistant or compaction message.
// Ported from cc-switch, https://github.com/farion1231/cc-switch/blob/7da2553/src-tauri/src/services/session_usage_opencode.rs
// Copyright (c) 2025 Jason Young. MIT License.

import type { BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import type { Platform } from '@shared/platform'
import { unchanged } from '../lines'
import {
  normalizeModel,
  type FileCursor,
  type LogReader,
  type ScanContext,
  type UsageRow,
} from '../model'

const AGENT_ID = 'opencode'
/** Outlasts OpenCode's own write transactions, which are short. */
const BUSY_TIMEOUT_MS = 1000
// SQLite's primary result codes, the low byte of node:sqlite's `errcode`.
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

interface Layout {
  sessions: string
  messages: string
  /** OpenCode 2 marks a message's kind in a `type` column; 1.x keeps `role` in its data. */
  typed: boolean
}

// OpenCode 2 copies the 1.x tables into its own and stops writing them, so they are read only
// when the 2.x ones are missing.
const LAYOUT_2: Layout = { sessions: 'session_v2', messages: 'session_message', typed: true }
const LAYOUT_1: Layout = { sessions: 'session', messages: 'message', typed: false }

type Row = Record<string, SQLOutputValue>

interface Session {
  id: string
  directory: string | null
  /** The latest `time_updated` of the session and its messages, in ms. */
  updated: number
}

function pathModule(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The database as OpenCode resolves it: `OPENCODE_DB` is taken from its data folder. */
function databasePath(env: ScanContext['env'], home: string, platform: Platform): string | null {
  const p = pathModule(platform)
  const variable = (name: string): string | null => {
    const value = env[name]
    return value && value.trim() !== '' ? value : null
  }
  // A relative XDG_DATA_HOME is taken from the home directory, where agents are spawned.
  const xdg = variable('XDG_DATA_HOME')
  const data = p.join(xdg ? p.resolve(home, xdg) : p.join(home, '.local', 'share'), 'opencode')
  const file = variable('OPENCODE_DB') ?? 'opencode.db'
  return file === ':memory:' ? null : p.resolve(data, file)
}

async function statOf(file: string): Promise<BigIntStats | null> {
  try {
    return await stat(file, { bigint: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

interface Change {
  size: number
  mtimeNs: bigint
  /** The database and its WAL, for progress. */
  bytes: number
}

/** The stat of whichever of the database and its WAL was written last. */
async function changeOf(file: string): Promise<Change | null> {
  const db = await statOf(file)
  if (!db?.isFile()) return null
  const wal = await statOf(`${file}-wal`)
  // An empty WAL holds no change; a read-only open creates one when OpenCode is not running.
  const newer = wal && wal.size > 0n && wal.mtimeNs > db.mtimeNs ? wal : db
  return {
    size: Number(newer.size),
    mtimeNs: newer.mtimeNs,
    bytes: Number(db.size + (wal?.size ?? 0n)),
  }
}

function isBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode
  if (typeof errcode !== 'number') return false
  const code = errcode & 0xff
  return code === SQLITE_BUSY || code === SQLITE_LOCKED
}

function layoutOf(db: DatabaseSync): Layout | null {
  const tables = new Set(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name),
  )
  for (const layout of [LAYOUT_2, LAYOUT_1]) {
    if (tables.has(layout.sessions) && tables.has(layout.messages)) return layout
  }
  return null
}

const text = (value: SQLOutputValue | undefined): string | null =>
  typeof value === 'string' ? value : null
const integer = (value: SQLOutputValue | undefined): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null
const count = (value: SQLOutputValue | undefined): number => Math.max(0, integer(value) ?? 0)

function sessionsOf(db: DatabaseSync, layout: Layout): Session[] {
  // A message can be written after its session's own time_updated.
  const rows = db
    .prepare(
      `SELECT s.id, s.directory,
         MAX(s.time_updated, COALESCE(MAX(m.time_updated), s.time_updated)) AS updated
       FROM ${layout.sessions} s
       LEFT JOIN ${layout.messages} m ON m.session_id = s.id
       GROUP BY s.id`,
    )
    .all()
  const sessions: Session[] = []
  for (const row of rows) {
    const id = text(row.id)
    if (id)
      sessions.push({ id, directory: text(row.directory), updated: integer(row.updated) ?? 0 })
  }
  return sessions
}

// Only these fields leave SQLite, never the message's content. `json_valid` comes first so a
// malformed row is skipped instead of failing the query.
function messageQuery(layout: Layout): string {
  return `
    SELECT id, ${layout.typed ? 'type' : 'NULL'} AS type, time_created,
      json_extract(data, '$.role') AS role,
      json_type(data, '$.tokens') AS tokens,
      json_extract(data, '$.tokens.input') AS input,
      json_extract(data, '$.tokens.output') AS output,
      json_extract(data, '$.tokens.reasoning') AS reasoning,
      json_extract(data, '$.tokens.cache.read') AS cache_read,
      json_extract(data, '$.tokens.cache.write') AS cache_write,
      json_extract(data, '$.time.created') AS created,
      json_extract(data, '$.time.completed') AS completed,
      json_extract(data, '$.status') AS status,
      json_extract(data, '$.modelID') AS model_id,
      CASE json_type(data, '$.model')
        WHEN 'text' THEN json_extract(data, '$.model')
        WHEN 'object' THEN json_extract(data, '$.model.id')
      END AS model
    FROM ${layout.messages}
    WHERE session_id = ?${layout.typed ? ` AND type IN ('assistant', 'compaction')` : ''}
      AND json_valid(data)`
}

/** A compaction ends with a status, whether it worked or not; anything else with a time. */
function isComplete(message: Row): boolean {
  if (message.type === 'compaction') {
    return message.status === 'completed' || message.status === 'failed'
  }
  return message.completed !== null && message.completed !== undefined
}

function rowOf(session: Session, message: Row): UsageRow | null {
  const id = text(message.id)
  if (!id) return null
  const input = count(message.input)
  const output = count(message.output)
  const reasoning = count(message.reasoning)
  const cacheRead = count(message.cache_read)
  const cacheWrite = count(message.cache_write)
  if (input + output + reasoning + cacheRead + cacheWrite === 0) return null
  const created = integer(message.created)
  return {
    key: `opencode:${session.id}:${id}`,
    source: 'log',
    agentId: AGENT_ID,
    sessionId: session.id,
    project: session.directory,
    // 1.x names the model in `modelID`; 2.x in `model`, an object with an `id` or a string.
    model: normalizeModel(text(message.model_id) ?? text(message.model)),
    at: created !== null && created > 0 ? created : (integer(message.time_created) ?? 0),
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    cacheWrite1h: 0,
    turn: 0,
  }
}

function readSession(
  statement: StatementSync,
  layout: Layout,
  session: Session,
): { rows: UsageRow[]; incomplete: boolean } {
  const rows: UsageRow[] = []
  let incomplete = false
  for (const message of statement.all(session.id)) {
    if (!layout.typed && message.role !== 'assistant') continue
    if (message.tokens === null) continue
    // Its counts are still growing; the session is read again once it is done.
    if (!isComplete(message)) {
      incomplete = true
      continue
    }
    const row = rowOf(session, message)
    if (row) rows.push(row)
  }
  return { rows, incomplete }
}

function readWatermark(cursor: FileCursor | null): number | null {
  if (!cursor?.state) return null
  try {
    const updated = (JSON.parse(cursor.state) as { updated?: unknown } | null)?.updated
    return typeof updated === 'number' ? updated : null
  } catch {
    return null
  }
}

const cursorOf = (id: string, state: string | null): FileCursor => ({
  id,
  agentId: AGENT_ID,
  size: 0,
  mtimeNs: 0n,
  offset: 0,
  tail: null,
  state,
})

/** Reads the sessions that changed; resolves false when one of them could not be read. */
function readDatabase(file: string, context: ScanContext): boolean {
  const db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const layout = layoutOf(db)
    if (!layout) return true
    const messages = db.prepare(messageQuery(layout))
    let complete = true
    for (const session of sessionsOf(db, layout)) {
      context.signal.throwIfAborted()
      const id = `${file}#${session.id}`
      const cursor = context.cursor(id)
      const read = readWatermark(cursor)
      if (read !== null && session.updated <= read) continue
      let found: ReturnType<typeof readSession>
      try {
        found = readSession(messages, layout, session)
      } catch (error) {
        if (isBusy(error)) throw error
        context.log('warn', `Session ${session.id} could not be read: ${(error as Error).message}`)
        complete = false
        continue
      }
      const before = cursor?.state ?? null
      const state = found.incomplete ? before : JSON.stringify({ updated: session.updated })
      if (found.rows.length > 0 || state !== before) context.commit(found.rows, cursorOf(id, state))
    }
    return complete
  } finally {
    db.close()
  }
}

async function scan(context: ScanContext): Promise<boolean> {
  const file = databasePath(context.env, context.home, context.platform)
  if (!file) return false
  const change = await changeOf(file)
  if (!change) return false
  if (unchanged(context.cursor(file), change.size, change.mtimeNs)) return true
  context.signal.throwIfAborted()
  context.plan(1, change.bytes)
  try {
    if (readDatabase(file, context)) {
      context.commit([], { ...cursorOf(file, null), size: change.size, mtimeNs: change.mtimeNs })
    }
  } catch (error) {
    if (!isBusy(error)) throw error
    context.log('info', `The database is busy; it is read again at the next scan`)
  } finally {
    context.done(change.bytes)
  }
  return true
}

export const opencodeReader: LogReader = {
  agentId: AGENT_ID,
  locations(env, home) {
    const file = databasePath(env, home, process.platform)
    return file ? [file] : []
  },
  scan,
}
