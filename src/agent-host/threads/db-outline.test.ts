// The message outline's reads and titles, and their migration from schema version 3.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { SCHEMA_VERSION, ThreadDb } from './db'
import type { PositionedEntry, ThreadHead } from './model'

const head: ThreadHead = { agentId: 'claude-code', acpSessionId: 'acp-1' }
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function databaseFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-outline-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'state'))
  return path.join(dir, 'state', 'threads.db')
}

const open = (file = databaseFile()): ThreadDb => ThreadDb.open(file, () => {})

const user = (id: string, text: string, steered = false): ThreadEntry => ({
  kind: 'user',
  id,
  content: [{ type: 'text', text }],
  ...(steered ? { steered } : {}),
})
const agent = (id: string): ThreadEntry => ({
  kind: 'agent',
  id,
  markdown: id,
  attachments: [],
  streaming: false,
})
const turnEnd = (id: string): ThreadEntry => ({
  kind: 'turn_end',
  id,
  stopReason: 'end_turn',
  durationMs: 1,
})

const positioned = (entries: ThreadEntry[]): PositionedEntry[] =>
  entries.map((entry, pos) => ({ pos, entry }))

const THREAD = positioned([
  user('u0', 'Fix the login\nIt fails on Safari'),
  agent('a0'),
  user('u1', 'Also Chrome', true),
  agent('a1'),
  turnEnd('e0'),
  {
    kind: 'user',
    id: 'u2',
    content: [
      {
        type: 'ref',
        ref: {
          kind: 'attachment',
          attachment: {
            id: 'x',
            type: 'file',
            name: 'notes.md',
            uri: null,
            mimeType: null,
          },
        },
      },
    ],
  } as ThreadEntry,
  agent('a2'),
  turnEnd('e1'),
])

describe('the message outline in the thread database', () => {
  it('lists the user messages with their text, steered ones and attachments included', () => {
    const db = open()
    expect(db.outline('s1')).toBeNull()
    db.write('s1', { head, entries: THREAD })
    expect(db.outline('s1')!.entries).toEqual([
      { pos: 0, entryId: 'u0', text: 'Fix the login\nIt fails on Safari', title: null },
      { pos: 2, entryId: 'u1', text: 'Also Chrome', title: null },
      { pos: 5, entryId: 'u2', text: 'notes.md', title: null },
    ])
    db.close()
  })

  it('cuts the text it reads to 500 characters', () => {
    const db = open()
    db.write('s1', { head, entries: positioned([user('u0', 'x'.repeat(800))]) })
    expect(db.outline('s1')!.entries[0]!.text).toHaveLength(500)
    db.close()
  })

  it('stores titles, keeps them through a whole write and drops them with the session', () => {
    const file = databaseFile()
    const db = open(file)
    expect(db.setOutlineTitles('s1', [{ pos: 0, title: 'Nothing here' }])).toBe(false)
    db.write('s1', { head, entries: THREAD })
    expect(
      db.setOutlineTitles('s1', [
        { pos: 0, title: 'Login fails on Safari' },
        { pos: 2, title: 'Chrome too' },
      ]),
    ).toBe(true)
    expect(db.outline('s1')!.entries.map((e) => e.title)).toEqual([
      'Login fails on Safari',
      'Chrome too',
      null,
    ])

    // A replay writes the thread whole; a title whose position no longer holds a message goes.
    const replayed = THREAD.filter(({ pos }) => pos !== 2).map(({ entry }, pos) => ({
      pos,
      entry,
    }))
    db.write('s1', { head, replace: true, entries: replayed })
    expect(db.outline('s1')!.entries).toMatchObject([
      { pos: 0, entryId: 'u0', title: 'Login fails on Safari' },
      { pos: 4, entryId: 'u2', title: null },
    ])

    db.remove(['s1'])
    expect(db.outline('s1')).toBeNull()
    db.close()
    const raw = new DatabaseSync(file)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM outline_titles').get()!.n).toBe(0)
    raw.close()
  })

  it('reads a page back to the turn of a position, uncut', () => {
    const db = open()
    db.write('s1', { head, entries: THREAD })
    // Position 2 is a steered message inside the turn that position 0 opened.
    const page = db.page('s1', 5, 2)!
    expect(page.entries.map((e) => e.id)).toEqual(['u0', 'a0', 'u1', 'a1', 'e0'])
    expect(page.older).toBeNull()
    db.close()
  })

  it('migrates a version 3 database, keeping its threads', () => {
    const file = databaseFile()
    const first = open(file)
    first.write('s1', { head, entries: THREAD })
    first.close()
    const raw = new DatabaseSync(file)
    raw.exec('DROP TABLE outline_titles')
    raw.exec('PRAGMA user_version = 3')
    raw.close()

    const migrated = open(file)
    expect(migrated.status).toBe('ok')
    expect(migrated.outline('s1')!.entries).toHaveLength(3)
    expect(migrated.setOutlineTitles('s1', [{ pos: 0, title: 'Login' }])).toBe(true)
    migrated.close()
    const check = new DatabaseSync(file)
    expect(Number(check.prepare('PRAGMA user_version').get()!.user_version)).toBe(SCHEMA_VERSION)
    check.close()
  })
})
