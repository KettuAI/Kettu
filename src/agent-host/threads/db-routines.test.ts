// The routine runs' table and its migration from schema version 2.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, ThreadDb } from './db'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function databaseFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-routine-runs-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'state'))
  return path.join(dir, 'state', 'threads.db')
}

function schema(file: string): { version: number; names: string[] } {
  const raw = new DatabaseSync(file)
  const version = Number(raw.prepare('PRAGMA user_version').get()!.user_version)
  const names = raw
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type IN ('table', 'index') AND name LIKE 'routine%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name))
  raw.close()
  return { version, names }
}

const ROUTINES = ['routine_runs', 'routine_runs_by_id']
const ROUTINE_ID = 'r-0123456789ab'

describe('the routine runs table', () => {
  it('creates it, empty, in a new database at the schema version', () => {
    const file = databaseFile()
    const db = ThreadDb.open(file, () => {})
    expect(db.status).toBe('created')
    expect(
      db.routine({ name: 'page', params: { routineId: ROUTINE_ID, before: null, limit: 10 } }),
    ).toEqual({
      runs: [],
      older: null,
    })
    db.close()
    expect(schema(file)).toEqual({ version: SCHEMA_VERSION, names: ROUTINES })
  })

  it('migrates a version 2 database to it, keeping its threads', () => {
    const file = databaseFile()
    const first = ThreadDb.open(file, () => {})
    first.close()

    // Version 2 is the schema before this table and the later ones; removing them and lowering the
    // version says so.
    const raw = new DatabaseSync(file)
    raw.exec('DROP TABLE routine_runs')
    raw.exec('DROP TABLE outline_titles')
    raw.exec('PRAGMA user_version = 2')
    raw.close()

    const logs: string[] = []
    const migrated = ThreadDb.open(file, (level, message) => {
      if (level === 'info') logs.push(message)
    })
    expect(migrated.status).toBe('ok')
    expect(logs).toContain('Migrated threads.db from schema version 2')
    expect(
      migrated.routine({
        name: 'page',
        params: { routineId: ROUTINE_ID, before: null, limit: 10 },
      }),
    ).toEqual({
      runs: [],
      older: null,
    })
    migrated.close()
    expect(schema(file)).toEqual({ version: SCHEMA_VERSION, names: ROUTINES })
  })
})
