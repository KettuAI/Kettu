import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, UsageDb } from './db'

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
