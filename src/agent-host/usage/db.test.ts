import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, UsageDb } from './db'
import { priceFor } from './model'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-usage-'))
  dirs.push(dir)
  return path.join(dir, 'state', 'usage.db')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the usage database's upgrade to version 3", () => {
  it("takes the cache out of the input of Kettu's rows for agents that held it there", () => {
    const file = tempFile()
    UsageDb.open(file, () => {}).close()
    const raw = new DatabaseSync(file)
    const insert = raw.prepare(
      `INSERT INTO usage (key, source, agent_id, session_id, project, model, at, input, output,
        reasoning, cache_read, cache_write, cache_write_1h, turn)
      VALUES (?, ?, ?, 's', '/p', 'm', 0, ?, 10, NULL, ?, ?, 0, 1)`,
    )
    const rows: [string, string, string, number, number, number, number][] = [
      // key, source, agent, input as stored, cache read, cache write, input after
      ['pi', 'kettu', 'pi', 1_584_482, 1_402_752, 0, 181_730],
      ['dsh', 'kettu', 'deepseek~work', 1500, 300, 0, 1200],
      ['cline', 'kettu', 'cline', 100, 60, 5, 35],
      ['gemini', 'kettu', 'gemini', 3150, 3000, 0, 150],
      ['qoder', 'kettu', 'qoder-cn~cn', 3150, 3000, 50, 100],
      ['pi-plain', 'kettu', 'pi', 100, 0, 0, 100],
      // An input under its cache never held it.
      ['pi-apart', 'kettu', 'pi', 10, 300, 0, 10],
      ['claude', 'kettu', 'claude-code', 8, 80_289, 85_417, 8],
      ['codex', 'log', 'codex', 100, 3000, 0, 100],
      ['picky', 'kettu', 'pinata', 1500, 300, 0, 1500],
    ]
    for (const [key, source, agent, input, read, write] of rows) {
      insert.run(key, source, agent, input, read, write)
    }
    raw.exec('PRAGMA user_version = 2')
    raw.close()

    const db = UsageDb.open(file, () => {})
    expect(db.status).toBe('ok')
    db.close()
    const check = new DatabaseSync(file)
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(SCHEMA_VERSION)
    const input = (key: string) =>
      (check.prepare('SELECT input FROM usage WHERE key = ?').get(key) as { input: number }).input
    for (const [key, , , , , , after] of rows) expect(input(key), key).toBe(after)
    const bucket = (agent: string) =>
      check
        .prepare("SELECT input, cache_read FROM buckets WHERE source = 'kettu' AND agent_id = ?")
        .get(agent)
    expect(bucket('pi')).toEqual({ input: 181_730 + 100 + 10, cache_read: 1_402_752 + 300 })
    expect(bucket('claude-code')).toEqual({ input: 8, cache_read: 80_289 })
    check.close()
  })
})

describe('priceFor variant matching', () => {
  it('strips reasoning effort and routing suffixes and falls back to -preview', () => {
    expect(priceFor('gemini-4-argon-high')).toEqual(priceFor('gemini-4-argon'))
    expect(priceFor('claude-opus-5-5-max')).toEqual(priceFor('claude-opus-5-5'))
    expect(priceFor('gemini-3.8-flash-n')).toEqual(priceFor('gemini-3.8-flash'))
    expect(priceFor('gemini-3.7-flash-tiered')).toEqual(priceFor('gemini-3.7-flash'))
    expect(priceFor('gemini-3-flash-a')).toEqual(priceFor('gemini-3-flash-preview'))
    expect(priceFor('non-existent-model-xyz')).toBeNull()
  })
})

describe('the usage database upgrade to version 4 and reported log costs', () => {
  it('migrates v3 tables cleanly and preserves existing bucket figures', () => {
    const file = tempFile()
    UsageDb.open(file, () => {}).close()
    const raw = new DatabaseSync(file)
    raw.exec(`
      DROP TABLE usage;
      DROP TABLE buckets;
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
      INSERT INTO usage VALUES (
        'k1', 'log', 'claude-code', 's1', '/p', 'claude-opus-5-5', 900000,
        1000, 200, NULL, 500, 0, 0, 0
      );
      INSERT INTO buckets VALUES (
        1, 'log', 'claude-code', 'claude-opus-5-5', '/p', 1, 1000, 200, 0, 500, 0, 0, 0
      );
      PRAGMA user_version = 3;
    `)
    raw.close()

    const db = UsageDb.open(file, () => {})
    try {
      expect(db.status).toBe('ok')
      const [total] = db.totals(0, 1_800_000, { 'claude-code': 'log' })
      expect(total).toMatchObject({
        agentId: 'claude-code',
        requests: 1,
        input: 1000,
        output: 200,
        cacheRead: 500,
      })
      expect(total!.cost).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('uses confirmed log cost when present and falls back to price list or unpriced otherwise', () => {
    const file = tempFile()
    const db = UsageDb.open(file, () => {})
    try {
      const at = Date.parse('2026-11-20T10:00:00.000Z')
      db.write([
        // Unlisted model with confirmed cost from Pi log.
        {
          key: 'pi:priced-custom',
          source: 'log',
          agentId: 'pi',
          sessionId: 's1',
          project: '/repo',
          model: 'custom-unlisted-model',
          at,
          input: 1000,
          output: 200,
          reasoning: null,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          turn: 0,
          cost: 0.042,
        },
        // Same model and quarter without log cost should count as unpriced tokens.
        {
          key: 'pi:unpriced-custom',
          source: 'log',
          agentId: 'pi',
          sessionId: 's1',
          project: '/repo',
          model: 'custom-unlisted-model',
          at,
          input: 500,
          output: 100,
          reasoning: null,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          turn: 0,
          cost: null,
        },
      ])

      const [total] = db.totals(
        Date.parse('2026-11-20T00:00:00.000Z'),
        Date.parse('2026-11-21T00:00:00.000Z'),
        { pi: 'log' },
      )
      expect(total).toMatchObject({
        agentId: 'pi',
        requests: 2,
        input: 1500,
        output: 300,
        unpricedTokens: 600,
      })
      expect(total!.cost).toBeCloseTo(0.042, 10)
    } finally {
      db.close()
    }
  })
})

describe('UsageDb.sessionTurnUsage', () => {
  it('groups Kettu rows by turnEntryId with colon-containing IDs and ignores other sessions or logs', () => {
    const file = tempFile()
    const db = UsageDb.open(file, () => {})
    const at = Date.parse('2026-11-26T12:00:00.000Z')
    try {
      db.write([
        {
          key: 'ob:s1:e:4:claude-sonnet-4-6',
          source: 'kettu',
          agentId: 'claude-code',
          sessionId: 'acp-1',
          project: '/repo',
          model: 'claude-sonnet-4-6',
          at,
          input: 1000,
          output: 400,
          reasoning: null,
          cacheRead: 8000,
          cacheWrite: 1000,
          cacheWrite1h: 0,
          turn: 1,
        },
        {
          key: 'ob:s1:e:4:claude-haiku-4-5',
          source: 'kettu',
          agentId: 'claude-code',
          sessionId: 'acp-1',
          project: '/repo',
          model: 'claude-haiku-4-5',
          at,
          input: 200,
          output: 100,
          reasoning: null,
          cacheRead: 500,
          cacheWrite: 0,
          cacheWrite1h: 0,
          turn: 0,
        },
        {
          key: 'ob:s1:e:9:unknown-custom-model',
          source: 'kettu',
          agentId: 'claude-code',
          sessionId: 'acp-1',
          project: '/repo',
          model: 'unknown-custom-model',
          at: at + 1000,
          input: 600,
          output: 200,
          reasoning: null,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          turn: 1,
        },
        // Different session with shared prefix must not bleed into s1.
        {
          key: 'ob:s10:e:4:claude-sonnet-4-6',
          source: 'kettu',
          agentId: 'claude-code',
          sessionId: 'acp-10',
          project: '/repo',
          model: 'claude-sonnet-4-6',
          at,
          input: 9999,
          output: 9999,
          reasoning: null,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          turn: 1,
        },
        // Imported log rows must not be matched even if a key starts similarly.
        {
          key: 'claude:msg-1',
          source: 'log',
          agentId: 'claude-code',
          sessionId: 'acp-1',
          project: '/repo',
          model: 'claude-sonnet-4-6',
          at,
          input: 500,
          output: 100,
          reasoning: null,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          turn: 0,
        },
      ])

      const byTurn = db.sessionTurnUsage('s1')
      expect(Object.keys(byTurn).sort()).toEqual(['e:4', 'e:9'])
      expect(byTurn['e:4']!.models).toHaveLength(2)
      expect(byTurn['e:4']!.models.map((m) => m.model)).toContain('claude-sonnet-4-6')
      expect(byTurn['e:4']!.models.map((m) => m.model)).toContain('claude-haiku-4-5')
      expect(byTurn['e:4']!.costUsd).toBeGreaterThan(0)
      expect(byTurn['e:9']!.costUsd).toBeNull()
      expect(byTurn['e:9']!.models).toEqual([
        {
          model: 'unknown-custom-model',
          input: 600,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: null,
        },
      ])
    } finally {
      db.close()
    }
  })
})
