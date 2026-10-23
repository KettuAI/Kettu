// Many cases follow cc-switch's tests, https://github.com/farion1231/cc-switch/blob/7da2553/src-tauri/src/services/session_usage_opencode.rs
// Copyright (c) 2025 Jason Young. MIT License.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UsageRow } from '../model'
import { memoryContext, type MemoryContext } from '../testing'
import { opencodeReader } from './opencode'

let home: string
const open: DatabaseSync[] = []
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'usage-opencode-'))
})
afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close()
  rmSync(home, { recursive: true, force: true })
})

const defaultFile = (): string => path.join(home, '.local', 'share', 'opencode', 'opencode.db')
// The database is a real file in a temporary folder, so paths follow the platform the tests run on.
const context = (env: Record<string, string> = {}): MemoryContext =>
  memoryContext({ env, home, platform: process.platform })

let tick = 0
/** Moves the file's time on, since two writes in a test can land in one tick. */
function touch(file: string): void {
  tick += 10
  const time = new Date(Date.now() + tick * 1000)
  utimesSync(file, time, time)
}

const SCHEMA_2 = `
  CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  );
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
`
const SCHEMA_1 = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
`

interface MessageOptions {
  /** The 2.x `type` column; 1.x keeps the role in the data. */
  type?: string
  created?: number
  updated?: number
}

/** An OpenCode database in the 2.x layout, the 1.x one, or both. */
class Fixture {
  readonly db: DatabaseSync
  private seq = 0

  constructor(
    readonly file: string,
    readonly layouts: (1 | 2)[] = [2],
    wal = false,
  ) {
    mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    open.push(this.db)
    if (wal) this.db.exec('PRAGMA journal_mode = WAL')
    for (const layout of layouts) this.db.exec(layout === 2 ? SCHEMA_2 : SCHEMA_1)
  }

  private tables(layout: 1 | 2): { sessions: string; messages: string } {
    return layout === 2
      ? { sessions: 'session_v2', messages: 'session_message' }
      : { sessions: 'session', messages: 'message' }
  }

  session(id: string, updated = 1, layout = this.layouts[0]!): this {
    this.db
      .prepare(
        `INSERT INTO ${this.tables(layout).sessions} (id, directory, time_created, time_updated)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, `/work/${id}`, updated, updated)
    return this
  }

  message(
    session: string,
    id: string,
    data: unknown,
    options: MessageOptions = {},
    layout = this.layouts[0]!,
  ): this {
    const json = typeof data === 'string' ? data : JSON.stringify(data)
    const created = options.created ?? 1
    const updated = options.updated ?? created
    const { messages } = this.tables(layout)
    if (layout === 2) {
      this.db
        .prepare(`INSERT INTO ${messages} VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, session, options.type ?? 'assistant', this.seq++, created, updated, json)
    } else {
      this.db
        .prepare(`INSERT INTO ${messages} VALUES (?, ?, ?, ?, ?)`)
        .run(id, session, created, updated, json)
    }
    return this
  }

  update(id: string, data: unknown, updated: number | null, layout = this.layouts[0]!): this {
    const { messages } = this.tables(layout)
    if (updated === null) {
      this.db.prepare(`UPDATE ${messages} SET data = ? WHERE id = ?`).run(JSON.stringify(data), id)
    } else {
      this.db
        .prepare(`UPDATE ${messages} SET data = ?, time_updated = ? WHERE id = ?`)
        .run(JSON.stringify(data), updated, id)
    }
    return this
  }
}

/** A 2.x assistant message that has finished. */
function done(
  input: number,
  output: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    model: { id: 'm', providerID: 'p' },
    time: { created: 1000, completed: 2000 },
    ...extra,
  }
}

const key = (session: string, message: string): string => `opencode:${session}:${message}`
const sorted = (ctx: MemoryContext): string[] => [...ctx.rows.keys()].sort()

/** Imports one message from a fresh database and returns its row, if it counts. */
async function importOne(
  data: unknown,
  options: MessageOptions & { layout?: 1 | 2 } = {},
): Promise<UsageRow | undefined> {
  const layout = options.layout ?? 2
  new Fixture(defaultFile(), [layout]).session('s1').message('s1', 'm1', data, options)
  const ctx = context()
  await opencodeReader.scan(ctx)
  return ctx.rows.get(key('s1', 'm1'))
}

describe('opencodeReader.locations', () => {
  it('defaults to the XDG data folder under the home directory on every platform', () => {
    expect(opencodeReader.locations({}, home)).toEqual([defaultFile()])
  })

  it('honors XDG_DATA_HOME, and OPENCODE_DB over it', () => {
    const xdg = path.join(home, 'data')
    expect(opencodeReader.locations({ XDG_DATA_HOME: xdg }, home)).toEqual([
      path.join(xdg, 'opencode', 'opencode.db'),
    ])
    const custom = path.join(home, 'custom.db')
    expect(opencodeReader.locations({ XDG_DATA_HOME: xdg, OPENCODE_DB: custom }, home)).toEqual([
      custom,
    ])
  })

  it('takes a relative OPENCODE_DB from the data folder, as OpenCode does', () => {
    expect(opencodeReader.locations({ OPENCODE_DB: 'other.db' }, home)).toEqual([
      path.join(home, '.local', 'share', 'opencode', 'other.db'),
    ])
  })

  it('ignores blank variables and has no file for an in-memory database', () => {
    expect(opencodeReader.locations({ OPENCODE_DB: ' ', XDG_DATA_HOME: '' }, home)).toEqual([
      defaultFile(),
    ])
    expect(opencodeReader.locations({ OPENCODE_DB: ':memory:' }, home)).toEqual([])
  })
})

describe('opencodeReader.scan', () => {
  it('resolves false when the database does not exist', async () => {
    const ctx = context()
    expect(await opencodeReader.scan(ctx)).toBe(false)
    expect(ctx.planned).toEqual({ files: 0, bytes: 0 })
    expect(await opencodeReader.scan(context({ OPENCODE_DB: ':memory:' }))).toBe(false)
  })

  it('reads a completed 2.x assistant message into a row', async () => {
    const fixture = new Fixture(defaultFile()).session('ses_1').message('ses_1', 'msg_1', {
      tokens: { input: 1200, output: 300, reasoning: 45, cache: { read: 9000, write: 500 } },
      model: { id: 'anthropic/claude-sonnet-4-5-20250929', providerID: 'openrouter' },
      time: { created: 1792678338050, streamed: 1792678339591, completed: 1792678339592 },
    })
    const ctx = context()
    expect(await opencodeReader.scan(ctx)).toBe(true)
    expect([...ctx.rows.values()]).toEqual([
      {
        key: 'opencode:ses_1:msg_1',
        source: 'log',
        agentId: 'opencode',
        sessionId: 'ses_1',
        project: '/work/ses_1',
        model: 'claude-sonnet-4-5',
        at: 1792678338050,
        input: 1200,
        output: 300,
        reasoning: 45,
        cacheRead: 9000,
        cacheWrite: 500,
      },
    ])
    const size = statSync(fixture.file).size
    expect(ctx.planned).toEqual({ files: 1, bytes: size })
    expect(ctx.doneBytes).toBe(size)
  })

  it('skips other message types, messages without tokens or counts, and malformed data', async () => {
    new Fixture(defaultFile())
      .session('s1')
      .message('s1', 'user', done(1, 0), { type: 'user' })
      .message('s1', 'idle', done(1, 0), { type: 'idle' })
      .message(
        's1',
        'switch',
        { model: { id: 'm' }, time: { created: 1 } },
        { type: 'model-switched' },
      )
      .message('s1', 'no-tokens', { model: { id: 'm' }, time: { created: 1, completed: 2 } })
      .message('s1', 'zero', done(0, 0))
      .message('s1', 'malformed', '{"tokens": {"input": 5')
      .message('s1', 'ok', done(10, 1))
    const ctx = context()
    await opencodeReader.scan(ctx)
    expect(sorted(ctx)).toEqual([key('s1', 'ok')])
  })

  it('counts an incomplete message once it is complete, holding its session until then', async () => {
    const fixture = new Fixture(defaultFile())
      .session('s1', 10)
      .message('s1', 'done', done(1000, 200), { updated: 10 })
      .message('s1', 'wip', { tokens: { input: 500, output: 0 }, time: { created: 3 } })
    const ctx = context()
    await opencodeReader.scan(ctx)
    expect(sorted(ctx)).toEqual([key('s1', 'done')])
    const held = ctx.cursors.get(`${fixture.file}#s1`)
    expect(held?.state).toBeNull()

    fixture.update('wip', done(500, 80, { time: { created: 3, completed: 4 } }), 20)
    touch(fixture.file)
    await opencodeReader.scan(ctx)
    expect(sorted(ctx)).toEqual([key('s1', 'done'), key('s1', 'wip')])
    expect(ctx.rows.get(key('s1', 'wip'))?.output).toBe(80)
    expect(ctx.cursors.get(`${fixture.file}#s1`)?.state).toBe(JSON.stringify({ updated: 20 }))
  })

  it('reads a held session again even when its own times did not move', async () => {
    const fixture = new Fixture(defaultFile())
      .session('s1', 10)
      .message('s1', 'wip', { tokens: { input: 500, output: 0 }, time: { created: 3 } })
    const ctx = context()
    await opencodeReader.scan(ctx)
    expect(ctx.rows.size).toBe(0)

    fixture.update('wip', done(500, 80), null)
    touch(fixture.file)
    await opencodeReader.scan(ctx)
    expect(sorted(ctx)).toEqual([key('s1', 'wip')])
  })

  it('counts compactions that completed or failed, and waits for a pending one', async () => {
    // cc-switch's test_query_assistant_messages_v2_includes_completed_compaction.
    const flash = { id: 'deepseek-v4.1-flash' }
    new Fixture(defaultFile())
      .session('s1')
      .message(
        's1',
        'c1',
        {
          status: 'completed',
          tokens: { input: 741, output: 2604 },
          model: flash,
          time: { created: 10 },
        },
        { type: 'compaction' },
      )
      .message(
        's1',
        'c2',
        {
          status: 'pending',
          tokens: { input: 100, output: 0 },
          model: flash,
          time: { created: 11 },
        },
        { type: 'compaction' },
      )
      .message(
        's1',
        'c3',
        {
          status: 'failed',
          tokens: { input: 300, output: 0 },
          model: flash,
          time: { created: 12 },
        },
        { type: 'compaction' },
      )
      .message('s1', 'a1', done(1000, 200, { time: { created: 13, completed: 14 } }))
    const ctx = context()
    await opencodeReader.scan(ctx)
    expect(sorted(ctx)).toEqual([key('s1', 'a1'), key('s1', 'c1'), key('s1', 'c3')])
    expect(ctx.rows.get(key('s1', 'c1'))).toMatchObject({
      input: 741,
      model: 'deepseek-v4.1-flash',
    })
    expect(ctx.rows.get(key('s1', 'c3'))?.input).toBe(300)
    // The pending compaction holds the session.
    expect(ctx.cursors.get(`${defaultFile()}#s1`)?.state).toBeNull()
  })

  it('reads the 1.x tables, assistant messages only', async () => {
    new Fixture(defaultFile(), [1])
      .session('s1')
      .message('s1', 'u1', { role: 'user', tokens: { input: 1, output: 0 }, time: { created: 1 } })
      .message('s1', 'a1', {
        role: 'assistant',
        tokens: { input: 3272, output: 383, reasoning: 419, cache: { write: 0, read: 52480 } },
        modelID: 'deepseek-v4-pro',
        providerID: 'deepseek',
        time: { created: 1779755333700, completed: 1779755350639 },
      })
    const ctx = context()
    await opencodeReader.scan(ctx)
    expect(sorted(ctx)).toEqual([key('s1', 'a1')])
    expect(ctx.rows.get(key('s1', 'a1'))).toMatchObject({
      sessionId: 's1',
      project: '/work/s1',
      model: 'deepseek-v4-pro',
      at: 1779755333700,
    })
  })

  it('ignores the 1.x tables when the 2.x ones exist', async () => {
    // cc-switch's test_detect_schema_prefers_v2_when_present.
    new Fixture(defaultFile(), [2, 1])
      .session('old', 1, 1)
      .message('old', 'v1', { role: 'assistant', ...done(7, 7) }, {}, 1)
      .session('new', 1, 2)
      .message('new', 'v2', done(9, 9), {}, 2)
    const ctx = context()
    await opencodeReader.scan(ctx)
    expect(sorted(ctx)).toEqual([key('new', 'v2')])
  })

  it('takes a session as changed when any of its messages was written after it', async () => {
    // cc-switch's test_query_sessions_uses_message_update_watermark, in both layouts.
    for (const layout of [1, 2] as const) {
      const file = path.join(home, `watermark-${layout}.db`)
      new Fixture(file, [layout]).session('s1', 100).message(
        's1',
        'm1',
        { role: 'assistant', ...done(1, 1) },
        {
          created: 90,
          updated: 200,
        },
      )
      const ctx = context({ OPENCODE_DB: file })
      await opencodeReader.scan(ctx)
      expect(ctx.cursors.get(`${file}#s1`)?.state).toBe(JSON.stringify({ updated: 200 }))
    }
  })

  it('skips an unchanged database, and unchanged sessions in a changed one', async () => {
    const fixture = new Fixture(defaultFile())
      .session('a', 10)
      .message('a', 'a1', done(1, 1), { updated: 10 })
      .session('b', 10)
      .message('b', 'b1', done(2, 2), { updated: 10 })
    const ctx = context()
    await opencodeReader.scan(ctx)
    expect(ctx.planned.files).toBe(1)

    await opencodeReader.scan(ctx)
    expect(ctx.planned.files).toBe(1)

    // a1 grows without its time moving, so session a is not read again; b gains a message.
    fixture.update('a1', done(1, 50), null)
    fixture.message('b', 'b2', done(3, 3), { updated: 20 })
    touch(fixture.file)
    await opencodeReader.scan(ctx)
    expect(ctx.planned.files).toBe(2)
    expect(ctx.rows.get(key('a', 'a1'))?.output).toBe(1)
    expect(sorted(ctx)).toEqual([key('a', 'a1'), key('b', 'b1'), key('b', 'b2')])
  })

  it('sees changes still in the WAL, and ignores the empty WAL a read-only open leaves', async () => {
    const fixture = new Fixture(defaultFile(), [2], true)
      .session('s1', 10)
      .message('s1', 'm1', done(1, 1), { updated: 10 })
    const wal = `${fixture.file}-wal`
    expect(statSync(wal).size).toBeGreaterThan(0)
    const ctx = context()
    await opencodeReader.scan(ctx)
    expect(sorted(ctx)).toEqual([key('s1', 'm1')])

    fixture.message('s1', 'm2', done(2, 2), { updated: 20 })
    touch(wal)
    await opencodeReader.scan(ctx)
    expect(sorted(ctx)).toEqual([key('s1', 'm1'), key('s1', 'm2')])

    // Closing checkpoints the WAL into the file and removes it; reading leaves an empty one.
    fixture.db.close()
    expect(existsSync(wal)).toBe(false)
    const fresh = context()
    await opencodeReader.scan(fresh)
    expect(statSync(wal).size).toBe(0)
    await opencodeReader.scan(fresh)
    expect(fresh.planned.files).toBe(1)
  })

  it('retries a busy database at the next scan without moving its cursor', async () => {
    const fixture = new Fixture(defaultFile()).session('s1').message('s1', 'm1', done(1, 1))
    fixture.db.exec('BEGIN EXCLUSIVE')
    fixture.db.exec(`UPDATE session_v2 SET directory = '/elsewhere'`)
    const ctx = context()
    expect(await opencodeReader.scan(ctx)).toBe(true)
    expect(ctx.rows.size).toBe(0)
    expect(ctx.cursors.size).toBe(0)
    expect(ctx.logs).toEqual([{ level: 'info', message: expect.stringContaining('busy') }])
    expect(ctx.doneBytes).toBe(ctx.planned.bytes)

    fixture.db.exec('ROLLBACK')
    await opencodeReader.scan(ctx)
    expect(sorted(ctx)).toEqual([key('s1', 'm1')])
  })

  it('honors OPENCODE_DB and XDG_DATA_HOME', async () => {
    const custom = path.join(home, 'elsewhere', 'custom.db')
    new Fixture(custom).session('s1').message('s1', 'm1', done(1, 1))
    const byFile = context({ OPENCODE_DB: custom })
    expect(await opencodeReader.scan(byFile)).toBe(true)
    expect(byFile.rows.size).toBe(1)

    const xdg = path.join(home, 'xdg')
    new Fixture(path.join(xdg, 'opencode', 'opencode.db'))
      .session('s2')
      .message('s2', 'm2', done(1, 1))
    const byFolder = context({ XDG_DATA_HOME: xdg })
    expect(await opencodeReader.scan(byFolder)).toBe(true)
    expect(sorted(byFolder)).toEqual([key('s2', 'm2')])
  })

  it('stops when the scan is cancelled', async () => {
    new Fixture(defaultFile()).session('s1').message('s1', 'm1', done(1, 1))
    const controller = new AbortController()
    controller.abort()
    const ctx = memoryContext({ home, signal: controller.signal })
    await expect(opencodeReader.scan(ctx)).rejects.toThrow()
    expect(ctx.rows.size).toBe(0)
  })
})

describe('opencode token counts', () => {
  // Ported from cc-switch's parse_message_data tests; latency and cost are not read here.
  it('reads every count, keeping reasoning apart from output', async () => {
    const row = await importOne(
      {
        role: 'assistant',
        cost: 0.0023113,
        tokens: {
          total: 56554,
          input: 3272,
          output: 383,
          reasoning: 419,
          cache: { write: 0, read: 52480 },
        },
        modelID: 'deepseek-v4-pro',
        providerID: 'deepseek',
        time: { created: 1779755333700, completed: 1779755350639 },
      },
      { layout: 1 },
    )
    expect(row).toMatchObject({
      input: 3272,
      output: 383,
      reasoning: 419,
      cacheRead: 52480,
      cacheWrite: 0,
      model: 'deepseek-v4-pro',
      at: 1779755333700,
    })
  })

  it('reads missing cache and reasoning counts as zero', async () => {
    const row = await importOne(
      {
        role: 'assistant',
        cost: 0,
        tokens: { input: 1000, output: 200 },
        modelID: 'mimo-v2.5-pro',
        time: { created: 1779755333700, completed: 1779755333800 },
      },
      { layout: 1 },
    )
    expect(row).toMatchObject({
      input: 1000,
      output: 200,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('skips a message whose counts are all zero', async () => {
    const row = await importOne({
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      model: { id: 'test' },
      time: { created: 1, completed: 2 },
    })
    expect(row).toBeUndefined()
  })

  it('reads the 2.x model object', async () => {
    const row = await importOne({
      agent: 'build',
      cost: 0.00143667,
      tokens: { input: 1373, output: 96, reasoning: 0, cache: { read: 391040, write: 0 } },
      model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'max' },
      time: { created: 1789945285532, streamed: 1789945288379, completed: 1789945288526 },
    })
    expect(row).toMatchObject({
      model: 'deepseek-v4.1-flash',
      input: 1373,
      cacheRead: 391040,
      at: 1789945285532,
    })
  })

  it('reads a model given as a string', async () => {
    const row = await importOne({
      tokens: { input: 10, output: 1 },
      model: 'some-model',
      time: { created: 1, completed: 2 },
    })
    expect(row?.model).toBe('some-model')
  })

  it('goes by the 2.x type column, not a role in the data', async () => {
    const row = await importOne({ role: 'user', ...done(100, 0) })
    expect(row?.input).toBe(100)
  })

  it('falls back to the row time without time.created, and to no model', async () => {
    const row = await importOne(
      { tokens: { input: 5, output: 5 }, time: { completed: 2 } },
      { created: 1792423191728 },
    )
    expect(row).toMatchObject({ at: 1792423191728, model: '' })
  })

  it('reads negative or fractional counts as zero', async () => {
    const row = await importOne(done(-5, 7.5, { tokens: { input: -5, output: 7.5, reasoning: 3 } }))
    expect(row).toMatchObject({ input: 0, output: 0, reasoning: 3 })
  })
})
