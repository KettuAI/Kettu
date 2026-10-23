import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { SCHEMA_VERSION, ThreadDb, ThreadDbError } from './db'
import {
  EMPTY_SESSION,
  INLINE_IMAGE_LIMIT,
  PAGE_ENTRIES,
  PAGE_LIMIT,
  type PositionedEntry,
  type ThreadHead,
} from './model'

const head: ThreadHead = { agentId: 'claude-code', acpSessionId: 'acp-1' }
const dirs: string[] = []
const logs: { level: string; message: string }[] = []

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-threads-'))
  dirs.push(dir)
  return path.join(dir, 'state', 'threads.db')
}

function open(file = tempFile()): ThreadDb {
  return ThreadDb.open(
    file,
    (level, message) => logs.push({ level, message }),
    () => 0,
  )
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  logs.length = 0
})

const user = (id: string, steered?: boolean): ThreadEntry => ({
  kind: 'user',
  id,
  content: [{ type: 'text', text: id }],
  ...(steered ? { steered } : {}),
})
const agent = (id: string): ThreadEntry => ({
  kind: 'agent',
  id,
  markdown: id,
  attachments: [],
  streaming: false,
})
const tool = (id: string): ThreadEntry => ({
  kind: 'tool',
  id,
  title: id,
  toolKind: 'read',
  status: 'completed',
  content: [],
  locations: [],
  permission: null,
  permissionResult: null,
})
const turnEnd = (id: string): ThreadEntry => ({
  kind: 'turn_end',
  id,
  stopReason: 'end_turn',
  durationMs: 1,
})

/** Turns of a prompt, `tools` tool calls, an answer and a turn end, positioned from 0. */
function turns(count: number, tools: number): PositionedEntry[] {
  const out: PositionedEntry[] = []
  for (let t = 0; t < count; t++) {
    out.push({ pos: out.length, entry: user(`u${t}`) })
    for (let i = 0; i < tools; i++) out.push({ pos: out.length, entry: tool(`t${t}.${i}`) })
    out.push({ pos: out.length, entry: agent(`a${t}`) })
    out.push({ pos: out.length, entry: turnEnd(`end${t}`) })
  }
  return out
}

const ids = (entries: readonly ThreadEntry[]): string[] => entries.map((e) => e.id)

describe('the thread database', () => {
  it('creates its schema once and keeps threads across a reopen', () => {
    const file = tempFile()
    const db = open(file)
    expect(db.status).toBe('created')
    db.write('s1', { head, session: { ...EMPTY_SESSION, title: 'Hi' }, entries: turns(1, 1) })
    db.close()

    const again = open(file)
    expect(again.status).toBe('ok')
    const page = again.page('s1', null)!
    expect(page.head).toEqual(head)
    expect(page.session.title).toBe('Hi')
    expect(ids(page.entries)).toEqual(['u0', 't0.0', 'a0', 'end0'])
    expect(page).toMatchObject({ from: 0, older: null, plan: null })
    again.close()
  })

  it('answers null for a session with no thread', () => {
    const db = open()
    expect(db.page('nope', null)).toBeNull()
    expect(db.tail('nope', 0)).toBeNull()
    expect(db.load('nope')).toBeNull()
    db.close()
  })

  it('reads the latest page back to the start of its turn, then the pages before it', () => {
    const db = open()
    const all = turns(40, 5) // 8 entries a turn, 320 in all
    db.write('s1', { head, entries: all })

    const latest = db.page('s1', null)!
    expect(latest.entries.length).toBeGreaterThanOrEqual(PAGE_ENTRIES)
    expect(latest.entries[0]!.kind).toBe('user')
    expect(latest.entries.at(-1)!.id).toBe('end39')
    expect(latest.from).toBe(all.length - latest.entries.length)
    expect(latest.older).toBe(latest.from)

    // Walking back covers every entry once, in order, and every page starts a turn.
    const seen: ThreadEntry[] = [...latest.entries]
    let cursor = latest.older
    while (cursor !== null) {
      const page = db.page('s1', cursor)!
      expect(page.entries[0]!.kind).toBe('user')
      expect(page.from + page.entries.length).toBe(cursor)
      seen.unshift(...page.entries)
      cursor = page.older
    }
    expect(ids(seen)).toEqual(ids(all.map((p) => p.entry)))
    db.close()
  })

  it('cuts a turn longer than the page limit', () => {
    const db = open()
    const all = turns(1, PAGE_LIMIT + 100)
    db.write('s1', { head, entries: all })
    const latest = db.page('s1', null)!
    expect(latest.entries).toHaveLength(PAGE_LIMIT)
    expect(latest.older).toBe(all.length - PAGE_LIMIT)
    expect(ids(db.page('s1', latest.older)!.entries)).toEqual(
      ids(all.slice(0, all.length - PAGE_LIMIT).map((p) => p.entry)),
    )
    db.close()
  })

  it('starts turns at prompts of their own and after a turn ends', () => {
    const db = open()
    const notice: ThreadEntry = { kind: 'notice', id: 'n', severity: 'info', title: 'n' }
    const entries: ThreadEntry[] = [
      notice, // 0: before any prompt, turn 0
      user('u0'), // 1: opens turn 1
      user('steer', true), // 2: steered into turn 1
      agent('a0'), // 3
      turnEnd('end0'), // 4
      { kind: 'session_message', id: 'sm', senderId: null, content: [] }, // 5: opens turn 5
      agent('a1'), // 6
    ]
    db.write('s1', { head, entries: entries.map((entry, pos) => ({ pos, entry })) })
    db.close()
    const raw = new DatabaseSync(path.join(dirs[0]!, 'state', 'threads.db'))
    const rows = raw.prepare('SELECT pos, turn FROM entries ORDER BY pos').all()
    raw.close()
    expect(rows.map((r) => Number(r.turn))).toEqual([0, 1, 1, 1, 1, 5, 5])
  })

  it('updates an entry in place and appends new ones after it', () => {
    const db = open()
    db.write('s1', { head, entries: turns(1, 1) })
    const changed = { ...agent('a0'), markdown: 'longer answer' } as ThreadEntry
    db.write('s1', {
      head,
      entries: [
        { pos: 2, entry: changed },
        { pos: 4, entry: user('u1') },
      ],
    })
    const thread = db.load('s1')!
    expect(thread.entries.map((p) => [p.pos, p.entry.id])).toEqual([
      [0, 'u0'],
      [1, 't0.0'],
      [2, 'a0'],
      [3, 'end0'],
      [4, 'u1'],
    ])
    expect(thread.entries[2]!.entry).toEqual(changed)
    db.close()
  })

  it('refuses a write that moves an entry, and keeps what was stored', () => {
    const db = open()
    db.write('s1', { head, entries: turns(1, 1) })
    const write = (): void =>
      db.write('s1', {
        head,
        session: { ...EMPTY_SESSION, title: 'changed' },
        entries: [{ pos: 7, entry: user('u0') }],
      })
    expect(write).toThrow(ThreadDbError)
    expect(write).toThrow(expect.objectContaining({ code: 'conflict' }))
    // A new entry on a taken position conflicts too.
    expect(() => db.write('s1', { head, entries: [{ pos: 1, entry: user('other') }] })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    )
    const page = db.page('s1', null)!
    expect(page.session.title).toBeNull()
    expect(ids(page.entries)).toEqual(['u0', 't0.0', 'a0', 'end0'])
    db.close()
  })

  it('replaces a whole thread, as after a replay', () => {
    const db = open()
    db.write('s1', { head, entries: turns(3, 2) })
    db.write('s1', {
      head: { ...head, acpSessionId: 'acp-2' },
      replace: true,
      entries: [{ pos: 0, entry: user('fresh') }],
    })
    const page = db.page('s1', null)!
    expect(page.head.acpSessionId).toBe('acp-2')
    expect(ids(page.entries)).toEqual(['fresh'])
    db.close()
  })

  it('keeps the session view until a write brings a new one', () => {
    const db = open()
    const session = { ...EMPTY_SESSION, title: 'T', commands: [{ name: 'x', description: 'y' }] }
    db.write('s1', { head, session, entries: [] })
    db.write('s1', { head, entries: [{ pos: 0, entry: user('u0') }] })
    expect(db.page('s1', null)!.session).toEqual(session)
    db.close()
  })

  it('reads everything from a position with tail', () => {
    const db = open()
    db.write('s1', { head, entries: turns(3, 1) }) // 12 entries
    const tail = db.tail('s1', 4)!
    expect(ids(tail.entries)).toEqual(['u1', 't1.0', 'a1', 'end1', 'u2', 't2.0', 'a2', 'end2'])
    expect(tail).toMatchObject({ from: 4, older: 4 })
    expect(db.tail('s1', 0)!.older).toBeNull()
    db.close()
  })

  it('names the latest plan only when it lies before the page', () => {
    const db = open()
    const plan: ThreadEntry = {
      kind: 'plan',
      id: 'plan',
      items: [{ content: 'step', priority: 'high', status: 'in_progress' }],
    }
    const entries = [
      { pos: 0, entry: plan },
      ...turns(30, 2).map((p) => ({ ...p, pos: p.pos + 1 })),
    ]
    db.write('s1', { head, entries })
    const latest = db.page('s1', null)!
    expect(latest.plan).toEqual(plan)
    expect(db.page('s1', 3)!.plan).toBeNull()
    db.close()
  })

  it('keeps large images apart, once per session, and puts them back when read', () => {
    const file = tempFile()
    const db = open(file)
    const big = Buffer.alloc(INLINE_IMAGE_LIMIT, 7).toString('base64')
    const small = Buffer.from('tiny').toString('base64')
    const shot = (id: string, data: string): ThreadEntry => ({
      ...(tool(id) as Extract<ThreadEntry, { kind: 'tool' }>),
      content: [{ type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data } }],
    })
    const prompt: ThreadEntry = {
      kind: 'user',
      id: 'u',
      content: [{ type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: big } }],
    }
    const entries = [prompt, shot('t1', big), shot('t2', small)]
    db.write('s1', { head, entries: entries.map((entry, pos) => ({ pos, entry })) })
    expect(db.page('s1', null)!.entries).toEqual(entries)
    db.close()

    const raw = new DatabaseSync(file)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM blobs').get()!.n).toBe(1)
    const json = raw.prepare("SELECT json FROM entries WHERE entry_id = 't1'").get()!.json
    raw.close()
    expect(String(json)).not.toContain(big.slice(0, 64))
    expect(String(json)).toContain('"blob"')
  })

  it('keeps the bytes of sent attachments through a whole write that still names them', () => {
    const file = tempFile()
    const db = open(file)
    const hash = 'ab'.repeat(32)
    const data = new Uint8Array([1, 2, 3, 4])
    const sent: ThreadEntry = {
      kind: 'user',
      id: 'u',
      content: [
        { type: 'text', text: 'Look' },
        {
          type: 'ref',
          ref: {
            kind: 'attachment',
            attachment: {
              id: 'a1',
              type: 'image',
              name: 'Image 1',
              uri: null,
              mimeType: 'image/png',
              size: 4,
              sent: 'image',
              thumb: 'data:image/webp;base64,AAAA',
              blob: hash,
            },
          },
        },
      ],
    }
    // The bytes go in with the entry that names them, in the same write as the thread row.
    db.write('s1', {
      head,
      entries: [{ pos: 0, entry: sent }],
      blobs: [{ hash, mime: 'image/png', data }],
    })
    expect(db.blob('s1', hash)).toEqual({ hash, mime: 'image/png', data })
    expect(db.blob('s1', 'cd'.repeat(32))).toBeNull()
    expect(db.page('s1', null)!.entries).toEqual([sent])

    db.write('s1', {
      head,
      entries: [{ pos: 0, entry: sent }, ...turns(1, 0).map((e) => ({ ...e, pos: e.pos + 1 }))],
      replace: true,
    })
    expect(db.blob('s1', hash)?.data).toEqual(data)

    // A whole write without the entry drops its bytes, and so does removing the thread.
    db.write('s2', {
      head,
      entries: [{ pos: 0, entry: sent }],
      blobs: [{ hash, mime: 'image/png', data }],
    })
    db.write('s1', { head, entries: turns(1, 0), replace: true })
    expect(db.blob('s1', hash)).toBeNull()
    db.remove(['s2'])
    expect(db.blob('s2', hash)).toBeNull()
    db.close()
  })

  it('removes threads with their images', () => {
    const file = tempFile()
    const db = open(file)
    const big = Buffer.alloc(INLINE_IMAGE_LIMIT, 1).toString('base64')
    const image: ThreadEntry = {
      kind: 'agent',
      id: 'a',
      markdown: '',
      attachments: [{ kind: 'image', mimeType: 'image/png', data: big }],
      streaming: false,
    }
    db.write('s1', { head, entries: [{ pos: 0, entry: image }] })
    db.write('s2', { head, entries: turns(1, 1) })
    db.remove(['s1', 'missing'])
    expect(db.page('s1', null)).toBeNull()
    expect(db.page('s2', null)).not.toBeNull()
    db.close()
    const raw = new DatabaseSync(file)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM blobs').get()!.n).toBe(0)
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id = 's1'").get()!.n).toBe(
      0,
    )
    raw.close()
  })

  it('treats a thread with an entry that does not parse as not stored, and says so', () => {
    const file = tempFile()
    const db = open(file)
    db.write('s1', { head, entries: turns(1, 1) })
    db.close()
    const raw = new DatabaseSync(file)
    raw.prepare('UPDATE entries SET json = \'{"kind":"tool"}\' WHERE entry_id = \'t0.0\'').run()
    raw.close()
    const again = open(file)
    expect(again.page('s1', null)).toBeNull()
    expect(again.load('s1')).toBeNull()
    expect(logs.some((l) => l.level === 'error' && l.message.includes('s1'))).toBe(true)
    again.close()
  })

  it('moves a damaged file aside and starts empty', () => {
    const file = tempFile()
    open(file).close()
    writeFileSync(file, 'this is not a database, only text long enough to look like one'.repeat(80))
    const db = open(file)
    expect(db.status).toBe('recovered')
    expect(db.page('s1', null)).toBeNull()
    db.write('s1', { head, entries: turns(1, 0) })
    expect(db.page('s1', null)!.entries).toHaveLength(3)
    db.close()
    const files = readdirSync(path.dirname(file))
    expect(files).toContain('threads.db.corrupt-1970-01-01T00-00-00-000Z')
    expect(logs.some((l) => l.level === 'error' && l.message.includes('damaged'))).toBe(true)
  })

  it('leaves a database from a newer app alone', () => {
    const file = tempFile()
    open(file).close()
    const raw = new DatabaseSync(file)
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()
    const db = open(file)
    expect(db.status).toBe('newer')
    db.write('s1', { head, entries: turns(1, 0) })
    expect(db.page('s1', null)).toBeNull()
    db.close()
    const check = new DatabaseSync(file)
    expect(check.prepare('SELECT COUNT(*) AS n FROM threads').get()!.n).toBe(0)
    check.close()
  })
})
