import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { UsageSource } from '@shared/usage'
import { UsageDb } from './db'
import type { UsageRow } from './model'

const dirs: string[] = []
const dbs: UsageDb[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function openDb(): UsageDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-usage-db-'))
  dirs.push(dir)
  const db = UsageDb.open(path.join(dir, 'usage.db'), () => {})
  dbs.push(db)
  return db
}

let keys = 0
function row(at: string, input: number, source: UsageSource = 'kettu'): UsageRow {
  return {
    key: `row-${keys++}`,
    source,
    agentId: 'claude-code',
    sessionId: 's',
    project: null,
    model: 'claude-test',
    at: Date.parse(at),
    input,
    output: 0,
    reasoning: null,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    turn: 1,
  }
}

const at = Date.parse
const byHour = (clock: { hour: number; input: number }[]) =>
  Object.fromEntries(clock.map((h) => [h.hour, h.input]))

describe('UsageDb.summary by hour of the day', () => {
  it('counts each quarter into the local hour of its zone, the repeated hour into one', () => {
    const db = openDb()
    db.write([
      // 9:30 on summer time (UTC-4), then 1:30 twice across the change back, then 9:10 (UTC-5).
      row('2026-10-31T13:30:00Z', 1),
      row('2026-11-01T05:30:00Z', 10),
      row('2026-11-01T06:30:00Z', 100),
      row('2026-11-02T14:10:00Z', 1000),
      // Before the range, and from a source that does not count.
      row('2026-10-30T13:30:00Z', 10_000),
      row('2026-11-02T14:20:00Z', 100_000, 'log'),
    ])
    const summary = db.summary(
      [],
      0,
      0,
      { 'claude-code': 'kettu' },
      {
        from: at('2026-10-31T04:00:00Z'),
        to: at('2026-11-03T05:00:00Z'),
        zones: [
          { from: at('2026-10-31T04:00:00Z'), offset: -240 },
          { from: at('2026-11-01T06:00:00Z'), offset: -300 },
        ],
      },
    )
    expect(byHour(summary.clock)).toEqual({ 9: 1001, 1: 110 })
    expect(summary.clock.every((h) => h.agentId === 'claude-code')).toBe(true)
  })

  it('wraps an offset east of UTC into the next day', () => {
    const db = openDb()
    db.write([row('2026-11-02T20:00:00Z', 5), row('2026-11-02T18:29:00Z', 7)])
    const summary = db.summary(
      [],
      0,
      0,
      { 'claude-code': 'kettu' },
      {
        from: at('2026-11-01T00:00:00Z'),
        to: at('2026-11-04T00:00:00Z'),
        zones: [{ from: at('2026-11-01T00:00:00Z'), offset: 330 }],
      },
    )
    expect(byHour(summary.clock)).toEqual({ 1: 5, 23: 7 })
  })

  it('sums nothing by hour unless asked', () => {
    const db = openDb()
    db.write([row('2026-11-02T20:00:00Z', 5)])
    const summary = db.summary([], 0, Date.parse('2027-01-01'), { 'claude-code': 'kettu' })
    expect(summary.clock).toEqual([])
    expect(summary.models).toHaveLength(1)
  })
})
