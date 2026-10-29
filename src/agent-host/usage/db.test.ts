import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UsageFigures } from '@shared/usage'
import { QUARTER_MS, UsageDb } from './db'
import { PRICES, priceFor, type UsageRow } from './model'

let dir: string
let db: UsageDb
const logs: string[] = []

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'usage-db-'))
  logs.length = 0
  db = UsageDb.open(path.join(dir, 'usage.db'), (_, message) => logs.push(message))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 20)

function row(key: string, changes: Partial<UsageRow> = {}): UsageRow {
  return {
    key,
    source: 'log',
    agentId: 'claude-code',
    sessionId: 's1',
    project: '/p/a',
    model: 'claude-opus-5-5',
    at: T0 + 3_600_000,
    input: 10,
    output: 20,
    reasoning: null,
    cacheRead: 100,
    cacheWrite: 5,
    cacheWrite1h: 0,
    turn: 0,
    ...changes,
  }
}

/**
 * The figures a bucket group of `rows` carries, worked out apart from the SQL: requests are the
 * rows, turns their flags, and only the models with a price cost anything.
 */
function figuresOf(rows: UsageRow[]): UsageFigures {
  const figures: UsageFigures = {
    requests: rows.length,
    turns: rows.reduce((sum, row) => sum + row.turn, 0),
    cost: null,
    unpricedTokens: 0,
    cacheSaved: 0,
  }
  for (const row of rows) {
    const price = priceFor(row.model)
    if (!price) {
      figures.unpricedTokens +=
        row.input + row.output + (row.reasoning ?? 0) + row.cacheRead + row.cacheWrite
      continue
    }
    const hour = row.cacheWrite1h
    const cost =
      row.input * price.input +
      (row.output + (row.reasoning ?? 0)) * price.output +
      row.cacheRead * price.cacheRead +
      (row.cacheWrite - hour) * price.cacheWrite +
      hour * (price.cacheWrite1h ?? price.cacheWrite)
    figures.cost = (figures.cost ?? 0) + cost
    figures.cacheSaved += row.cacheRead * (price.input - price.cacheRead)
  }
  return figures
}

const day = (i: number) => T0 + i * DAY
const all = { 'claude-code': 'log', codex: 'log', opencode: 'kettu' } as const

describe('UsageDb', () => {
  it('creates the schema and reports it', () => {
    expect(db.status).toBe('created')
    expect(db.open).toBe(true)
  })

  it('adds a row once, whatever repeats it', () => {
    expect(db.write([row('a'), row('a')])).toBe(1)
    expect(db.write([row('a')])).toBe(0)
    const summary = db.summary([day(0), day(1)], day(0), day(1), all)
    expect(summary.days).toEqual([
      {
        day: 0,
        agentId: 'claude-code',
        input: 10,
        output: 20,
        reasoning: 0,
        cacheRead: 100,
        cacheWrite: 5,
        ...figuresOf([row('a')]),
      },
    ])
  })

  it('moves a grown row by the difference, also into another quarter', () => {
    db.write([row('a', { output: 5 })])
    expect(db.write([row('a', { output: 3 })])).toBe(0)
    expect(db.write([row('a', { output: 40, at: T0 + DAY + 60_000, project: null })])).toBe(1)
    const grown = row('a', { output: 40, at: T0 + DAY + 60_000, project: null })
    const summary = db.summary([day(0), day(1), day(2)], day(0), day(2), all)
    expect(summary.projects).toEqual([
      {
        agentId: 'claude-code',
        project: null,
        input: 10,
        output: 40,
        reasoning: 0,
        cacheRead: 100,
        cacheWrite: 5,
        ...figuresOf([grown]),
      },
    ])
    expect(summary.days).toEqual([
      {
        day: 1,
        agentId: 'claude-code',
        input: 10,
        output: 40,
        reasoning: 0,
        cacheRead: 100,
        cacheWrite: 5,
        ...figuresOf([grown]),
      },
    ])
    expect(db.stats()).toEqual([
      {
        agentId: 'claude-code',
        source: 'log',
        rows: 1,
        first: Math.floor((T0 + DAY + 60_000) / QUARTER_MS) * QUARTER_MS,
        last: (Math.floor((T0 + DAY + 60_000) / QUARTER_MS) + 1) * QUARTER_MS,
      },
    ])
  })

  it('keeps a cursor with its nanosecond time and state', () => {
    const mtimeNs = 1_792_697_066_123_456_789n
    db.write([], {
      id: '/logs/a.jsonl',
      agentId: 'codex',
      size: 120,
      mtimeNs,
      offset: 100,
      tail: 4_000_000_000,
      state: '{"n":3}',
    })
    expect(db.cursor('/logs/a.jsonl')).toEqual({
      id: '/logs/a.jsonl',
      agentId: 'codex',
      size: 120,
      mtimeNs,
      offset: 100,
      tail: 4_000_000_000,
      state: '{"n":3}',
    })
    expect(db.cursor('/logs/b.jsonl')).toBeNull()
  })

  it('sums per day, model and project for the counted source of each agent', () => {
    db.write([
      row('a', { at: day(0) + 1_000 }),
      row('b', { at: day(1) + 1_000, model: 'claude-fable-5-1', project: '/p/b' }),
      row('c', { at: day(1) + 2_000, source: 'kettu' }),
      row('d', { at: day(2) + 1_000, agentId: 'opencode', source: 'kettu', reasoning: 7 }),
      row('e', { at: day(5) }),
    ])
    const summary = db.summary([day(0), day(1), day(2), day(3)], day(1), day(3), all)
    expect(summary.days.map((d) => [d.day, d.agentId, d.output, d.reasoning])).toEqual([
      [0, 'claude-code', 20, 0],
      [1, 'claude-code', 20, 0],
      [2, 'opencode', 20, 7],
    ])
    expect(summary.models.map((m) => [m.agentId, m.model]).sort()).toEqual([
      ['claude-code', 'claude-fable-5-1'],
      ['opencode', 'claude-opus-5-5'],
    ])
    expect(summary.projects.map((p) => [p.agentId, p.project]).sort()).toEqual([
      ['claude-code', '/p/b'],
      ['opencode', '/p/a'],
    ])
    expect(db.totals(day(0), day(3), { 'claude-code': 'kettu' })).toEqual([
      {
        agentId: 'claude-code',
        input: 10,
        output: 20,
        reasoning: 0,
        cacheRead: 100,
        cacheWrite: 5,
        ...figuresOf([row('c', { at: day(1) + 2_000, source: 'kettu' })]),
      },
    ])
  })

  it('counts requests and turns, and prices a model by name or without its date', () => {
    const priced = row('p', {
      model: 'claude-opus-4-8',
      input: 1_000,
      output: 500,
      cacheRead: 2_000,
      cacheWrite: 300,
      cacheWrite1h: 100,
      turn: 1,
    })
    const dated = row('d', {
      model: 'claude-opus-4-8-20260101',
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      at: T0 + 7_200_000,
    })
    const unpriced = row('u', {
      model: 'no-such-model-xyz',
      input: 7,
      output: 8,
      cacheRead: 9,
      cacheWrite: 10,
      at: T0 + 10_800_000,
    })
    db.write([priced, dated, unpriced])
    const summary = db.summary([day(0), day(1)], T0, day(1), all)
    expect(summary.pricesAsOf).toBe(PRICES.asOf)
    expect(summary.days).toEqual([
      {
        day: 0,
        agentId: 'claude-code',
        input: 1_017,
        output: 528,
        reasoning: 0,
        cacheRead: 2_039,
        cacheWrite: 350,
        ...figuresOf([priced, dated, unpriced]),
      },
    ])
    const models = new Map(summary.models.map((model) => [model.model, model]))
    expect(models.get('claude-opus-4-8')).toMatchObject(figuresOf([priced]))
    expect(models.get('claude-opus-4-8-20260101')).toMatchObject(figuresOf([dated]))
    expect(models.get('no-such-model-xyz')).toMatchObject({
      requests: 1,
      turns: 0,
      cost: null,
      unpricedTokens: 34,
      cacheSaved: 0,
    })
    expect(db.totals(T0, day(1), all)).toEqual([
      {
        agentId: 'claude-code',
        input: 1_017,
        output: 528,
        reasoning: 0,
        cacheRead: 2_039,
        cacheWrite: 350,
        ...figuresOf([priced, dated, unpriced]),
      },
    ])
  })

  it('upgrades a version 1 file, keeping the logs it can and counting turns once', () => {
    const file = path.join(dir, 'usage-v1.db')
    upgradeFromV1(file)
    const upgraded = UsageDb.open(file, (_, message) => logs.push(message))
    try {
      expect(upgraded.status).toBe('ok')
      // Claude Code's logs are read again for the hour's cache writes; the other agents' stay.
      expect(upgraded.cursor('claude-file')).toBeNull()
      expect(upgraded.cursor('codex-file')).not.toBeNull()
      expect(
        upgraded
          .stats()
          .map((s) => [s.agentId, s.source, s.rows])
          .sort(),
      ).toEqual([
        ['claude-code', 'kettu', 3],
        ['codex', 'log', 1],
      ])
      const summary = upgraded.summary([day(0), day(1)], T0, day(1), {
        'claude-code': 'kettu',
        codex: 'log',
      })
      // Two turns: the first row by key carries each, whatever its model.
      expect(summary.days.find((d) => d.agentId === 'claude-code')).toMatchObject({
        requests: 3,
        turns: 2,
      })
      expect(summary.models.map((m) => [m.model, m.requests, m.turns]).sort()).toEqual([
        ['claude-fable-5-1', 1, 1],
        ['claude-opus-5-5', 2, 1],
        ['gpt-5.6-sol', 1, 0],
      ])
      expect(summary.models.find((m) => m.model === 'gpt-5.6-sol')?.output).toBe(42)
    } finally {
      upgraded.close()
    }
  })

  it('splits days at local boundaries that are not UTC midnights', () => {
    const offset = 5.75 * 3_600_000 // Nepal, UTC+05:45
    const start = T0 - offset
    db.write([
      row('a', { at: start - 1 }),
      row('b', { at: start }),
      row('c', { at: start + DAY - 1 }),
    ])
    const summary = db.summary([start, start + DAY], start, start + DAY, all)
    expect(summary.days).toHaveLength(1)
    expect(summary.days[0]!.output).toBe(40)
  })

  it("forgets an agent's logs and keeps the rest", () => {
    db.write([row('a'), row('b', { source: 'kettu' })], {
      id: 'x',
      agentId: 'claude-code',
      size: 1,
      mtimeNs: 1n,
      offset: 1,
      tail: null,
      state: null,
    })
    db.removeLogs('claude-code')
    expect(db.cursor('x')).toBeNull()
    expect(db.stats().map((s) => s.source)).toEqual(['kettu'])
    db.clearRecord()
    expect(db.stats()).toEqual([])
  })

  it('moves a damaged file aside and starts empty', () => {
    db.close()
    const file = path.join(dir, 'usage.db')
    writeFileSync(file, 'not a database at all, but long enough to have a header'.repeat(100))
    const reopened = UsageDb.open(file, (_, message) => logs.push(message))
    expect(reopened.status).toBe('recovered')
    expect(readdirSync(dir).some((name) => name.startsWith('usage.db.corrupt-'))).toBe(true)
    reopened.close()
  })

  it('leaves a newer schema alone', () => {
    db.close()
    const file = path.join(dir, 'usage.db')
    const raw = new DatabaseSync(file)
    raw.exec('PRAGMA user_version = 99')
    raw.close()
    const reopened = UsageDb.open(file, (_, message) => logs.push(message))
    expect(reopened.status).toBe('newer')
    expect(reopened.open).toBe(false)
    expect(reopened.write([row('a')])).toBe(0)
    reopened.close()
  })
})

/** A schema 1 file: Kettu's two turns over two models, and rows and buckets from both logs. */
function upgradeFromV1(file: string): void {
  const raw = new DatabaseSync(file)
  raw.exec(`
    CREATE TABLE usage (
      key TEXT PRIMARY KEY, source TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT,
      project TEXT, model TEXT NOT NULL, at INTEGER NOT NULL, input INTEGER NOT NULL,
      output INTEGER NOT NULL, reasoning INTEGER, cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX usage_by_agent ON usage (source, agent_id);
    CREATE TABLE buckets (
      quarter INTEGER NOT NULL, source TEXT NOT NULL, agent_id TEXT NOT NULL,
      model TEXT NOT NULL, project TEXT NOT NULL, rows INTEGER NOT NULL, input INTEGER NOT NULL,
      output INTEGER NOT NULL, reasoning INTEGER NOT NULL, cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      PRIMARY KEY (quarter, source, agent_id, model, project)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE cursors (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, size INTEGER NOT NULL,
      mtime_ns INTEGER NOT NULL, offset INTEGER NOT NULL, tail INTEGER, state TEXT,
      seen_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX cursors_by_agent ON cursors (agent_id);
    PRAGMA user_version = 1;
  `)
  const insert = raw.prepare(`
    INSERT INTO usage (key, source, agent_id, session_id, project, model, at, input, output,
      reasoning, cache_read, cache_write)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const usage = (
    key: string,
    source: string,
    agentId: string,
    model: string,
    at: number,
    output: number,
  ): void => {
    insert.run(key, source, agentId, 's1', '/p', model, at, 1, output, null, 0, 0)
  }
  usage('ob:s1:e:9:claude-opus-5-5', 'kettu', 'claude-code', 'claude-opus-5-5', T0 + 3_600_000, 1)
  usage('ob:s1:e:9:claude-fable-5-1', 'kettu', 'claude-code', 'claude-fable-5-1', T0 + 3_600_000, 1)
  usage('ob:s1:e:10:claude-opus-5-5', 'kettu', 'claude-code', 'claude-opus-5-5', T0 + 7_200_000, 1)
  usage('claude:msg_1', 'log', 'claude-code', 'claude-opus-4-8', T0 + 3_600_000, 5)
  usage('codex:x:1', 'log', 'codex', 'gpt-5.6-sol', T0 + 3_600_000, 42)
  const bucket = raw.prepare(`
    INSERT INTO buckets (quarter, source, agent_id, model, project, rows, input, output,
      reasoning, cache_read, cache_write)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const quarter = Math.floor((T0 + 3_600_000) / QUARTER_MS)
  bucket.run(quarter, 'log', 'claude-code', 'claude-opus-4-8', '/p', 1, 1, 5, 0, 0, 0)
  bucket.run(quarter, 'log', 'codex', 'gpt-5.6-sol', '/p', 1, 1, 42, 0, 0, 0)
  const cursor = raw.prepare(`
    INSERT INTO cursors (id, agent_id, size, mtime_ns, offset, tail, state, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  cursor.run('claude-file', 'claude-code', 1, 1, 1, null, null, 0)
  cursor.run('codex-file', 'codex', 1, 1, 1, null, null, 0)
  raw.close()
}
