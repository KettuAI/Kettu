import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION } from './threads/model'
import { ThreadDb, ThreadDbError } from './threads/db'
import { transaction } from './sqlite'

// Node 22.13 to 22.15 have no `isTransaction`; the databases must not rely on it.
vi.mock('node:sqlite', async (original) => {
  const sqlite = await original<typeof import('node:sqlite')>()
  class OldDatabaseSync {
    constructor(...args: ConstructorParameters<typeof sqlite.DatabaseSync>) {
      const db = new sqlite.DatabaseSync(...args)
      return new Proxy(db, {
        get(target, key) {
          if (key === 'isTransaction') return undefined
          const value: unknown = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }
  }
  return { ...sqlite, DatabaseSync: OldDatabaseSync }
})

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-sqlite-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('transaction', () => {
  it('runs on a Node without isTransaction', () => {
    const db = new DatabaseSync(':memory:')
    expect(db.isTransaction).toBeUndefined()
    db.close()
  })

  it('rolls back a failed run, so the next one starts', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    expect(() =>
      transaction(db, () => {
        db.exec('INSERT INTO t VALUES (1)')
        throw new Error('refused')
      }),
    ).toThrow('refused')
    expect(transaction(db, () => db.prepare('INSERT INTO t VALUES (2)').run().changes)).toBe(1)
    expect(db.prepare('SELECT id FROM t').all()).toEqual([{ id: 2 }])
    db.close()
  })

  it('throws the first error when SQLite already ended the transaction', () => {
    const db = new DatabaseSync(':memory:')
    expect(() =>
      transaction(db, () => {
        db.exec('ROLLBACK')
        throw new Error('first')
      }),
    ).toThrow('first')
    expect(transaction(db, () => 'next')).toBe('next')
    db.close()
  })

  it('keeps the thread database writable after a refused write', () => {
    const db = ThreadDb.open(
      path.join(tempDir(), 'threads.db'),
      () => {},
      () => 0,
    )
    const head = { agentId: 'claude-code', acpSessionId: 'acp-1' } as const
    const user = (id: string) => ({
      kind: 'user' as const,
      id,
      content: [{ type: 'text' as const, text: id }],
    })
    db.write('s1', { head, entries: [{ pos: 0, entry: user('u0') }] })
    expect(() =>
      db.write('s1', {
        head,
        session: { ...EMPTY_SESSION, title: 'changed' },
        entries: [{ pos: 5, entry: user('u0') }],
      }),
    ).toThrow(ThreadDbError)
    db.write('s1', { head, entries: [{ pos: 1, entry: user('u1') }] })
    expect(db.page('s1', null)!.entries.map((e) => e.id)).toEqual(['u0', 'u1'])
    db.close()
  })
})
