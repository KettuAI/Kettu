import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QUARTER_MS, UsageDb } from './db'
import type { UsageRow } from './model'

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
    ...changes,
  }
}

const day = (i: number) => T0 + i * DAY
const all = { 'claude-code': 'log', codex: 'log', opencode: 'overbench' } as const

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
      },
    ])
  })

  it('moves a grown row by the difference, also into another quarter', () => {
    db.write([row('a', { output: 5 })])
    expect(db.write([row('a', { output: 3 })])).toBe(0)
    expect(db.write([row('a', { output: 40, at: T0 + DAY + 60_000, project: null })])).toBe(1)
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
      row('c', { at: day(1) + 2_000, source: 'overbench' }),
      row('d', { at: day(2) + 1_000, agentId: 'opencode', source: 'overbench', reasoning: 7 }),
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
    expect(db.totals(day(0), day(3), { 'claude-code': 'overbench' })).toEqual([
      {
        agentId: 'claude-code',
        input: 10,
        output: 20,
        reasoning: 0,
        cacheRead: 100,
        cacheWrite: 5,
      },
    ])
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
    db.write([row('a'), row('b', { source: 'overbench' })], {
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
    expect(db.stats().map((s) => s.source)).toEqual(['overbench'])
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
