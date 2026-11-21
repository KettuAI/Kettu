import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryWords } from '@shared/search-fold'
import { INDEX_FILE, SearchIndex } from './index'
import type { IndexedMessage } from './messages'

// Stands in for a SQLite built without FTS5, such as the one in Node.js 22.13 to 22.15: anything
// that names the trigram table or the module fails the way it does there.
const sqlite = vi.hoisted(() => ({ fts5: true }))

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  const check = (sql: string): void => {
    if (!sqlite.fts5 && /fts5|message_fts/i.test(sql)) {
      throw Object.assign(new Error('no such module: fts5'), { errcode: 1 })
    }
  }
  class Database extends actual.DatabaseSync {
    override exec(sql: string): void {
      check(sql)
      super.exec(sql)
    }
    override prepare(sql: string): ReturnType<typeof actual.DatabaseSync.prototype.prepare> {
      check(sql)
      return super.prepare(sql)
    }
  }
  return { ...actual, DatabaseSync: Database }
})

const dirs: string[] = []
const logs: { level: string; message: string }[] = []
const log = (level: 'info' | 'warn' | 'error', message: string): void => {
  logs.push({ level, message })
}

afterEach(() => {
  sqlite.fts5 = true
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  logs.length = 0
})

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-search-no-fts-'))
  dirs.push(dir)
  return path.join(dir, INDEX_FILE)
}

const message = (pos: number, text: string): IndexedMessage => ({
  pos,
  entryId: `e${pos}`,
  role: 'agent',
  text,
})

const find = (index: SearchIndex, query: string) =>
  index.find(queryWords(query)).map((c) => [c.sessionId, c.pos, c.matches])

const warnings = () => logs.filter((entry) => entry.level === 'warn')

describe('the search index where SQLite has no FTS5', () => {
  it('builds without the trigram index, scans every word and says so once', () => {
    sqlite.fts5 = false
    const file = tempFile()
    const index = SearchIndex.open(file, log)
    expect(index.hasFts).toBe(false)
    index.replace('s1', [message(0, 'a needle in a haystack'), message(1, 'only hay')], 5)
    expect(find(index, 'needle haystack')).toEqual([['s1', 0, 1]])
    expect(find(index, 'ne')).toEqual([['s1', 0, 1]])
    expect(index.findIn('s1', queryWords('hay'), 10).matches.map((m) => m.pos)).toEqual([0, 1])
    index.close()
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]!.message).toMatch(/no trigram index/)

    const again = SearchIndex.open(file, log)
    expect(again.hasFts).toBe(false)
    expect(find(again, 'needle')).toEqual([['s1', 0, 1]])
    again.close()
    expect(warnings()).toHaveLength(1)
  })

  it('builds a file made where FTS5 exists again, instead of failing on its triggers', () => {
    const file = tempFile()
    const made = SearchIndex.open(file, log)
    made.replace('s1', [message(0, 'text that was indexed')], 1)
    made.close()

    sqlite.fts5 = false
    const index = SearchIndex.open(file, log)
    expect(index.hasFts).toBe(false)
    index.replace('s1', [message(0, 'text that was indexed again')], 2)
    expect(find(index, 'indexed')).toEqual([['s1', 0, 1]])
    index.close()
    expect(warnings().length).toBeGreaterThan(0)
  })

  it('reads a file made where FTS5 exists by scanning its messages', () => {
    const file = tempFile()
    const made = SearchIndex.open(file, log)
    made.replace('s1', [message(0, 'text that was indexed')], 1)
    made.close()

    sqlite.fts5 = false
    const reader = SearchIndex.openReader(file, log)!
    expect(reader.hasFts).toBe(false)
    expect(find(reader, 'indexed')).toEqual([['s1', 0, 1]])
    reader.close()
  })
})
