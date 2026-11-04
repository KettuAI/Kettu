import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { contentHash, contentPath } from '../artifacts/content'
import { schemaAt, SCHEMA_VERSION, ThreadDb, ThreadDbError } from './db'
import {
  EMPTY_SESSION,
  INLINE_MEDIA_LIMIT,
  PAGE_ENTRIES,
  PAGE_LIMIT,
  type PositionedEntry,
  type ThreadHead,
} from './model'

const head: ThreadHead = { agentId: 'claude-code', acpSessionId: 'acp-1' }
const dirs: string[] = []
const logs: { level: string; message: string }[] = []

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-threads-'))
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

  it('keeps large images apart, once per session, and puts them back when read', () => {
    const file = tempFile()
    const db = open(file)
    const big = Buffer.alloc(INLINE_MEDIA_LIMIT, 7).toString('base64')
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

  it('keeps large sounds and clips apart as it does images, with their kind and size', () => {
    const file = tempFile()
    const db = open(file)
    const big = Buffer.alloc(INLINE_MEDIA_LIMIT, 3).toString('base64')
    const size = Buffer.byteLength(big, 'base64')
    const reply: ThreadEntry = {
      kind: 'agent',
      id: 'a',
      markdown: 'Here',
      attachments: [
        { kind: 'audio', mimeType: 'audio/wav', data: big, size, name: null },
        { kind: 'video', mimeType: 'video/mp4', data: 'AAAA', size: 3, name: 'clip.mp4' },
      ],
      streaming: false,
    }
    const call: ThreadEntry = {
      ...(tool('t1') as Extract<ThreadEntry, { kind: 'tool' }>),
      content: [
        {
          type: 'ref',
          ref: { kind: 'video', mimeType: 'video/webm', data: big, size, name: 'demo.webm' },
        },
      ],
    }
    db.write('s1', { head, entries: [reply, call].map((entry, pos) => ({ pos, entry })) })
    expect(db.page('s1', null)!.entries).toEqual([reply, call])
    db.close()

    const raw = new DatabaseSync(file)
    // The same bytes once, whatever kind each ref says they are.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM blobs').get()!.n).toBe(1)
    const json = String(raw.prepare("SELECT json FROM entries WHERE entry_id = 'a'").get()!.json)
    raw.close()
    expect(json).not.toContain(big.slice(0, 64))
    expect(JSON.parse(json).attachments[0]).toEqual({
      kind: 'audio',
      mimeType: 'audio/wav',
      size,
      name: null,
      blob: expect.any(String),
    })
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

  it('tells whether an agent or user entry holds a text, as written', () => {
    const db = open()
    const shot = 'C:\\Users\\me\\Application Support\\"shot".png'
    const reply: ThreadEntry = {
      kind: 'agent',
      id: 'a',
      markdown: `Saved:\n\n![shot](${shot})`,
      attachments: [{ kind: 'link', uri: 'file:///tmp/linked.png', name: 'linked.png' }],
      streaming: false,
    }
    db.write('s1', {
      head,
      entries: [
        { pos: 0, entry: user('look at ~/a b.png') },
        { pos: 1, entry: reply },
      ],
    })
    db.write('s2', { head, entries: [{ pos: 0, entry: tool('/tmp/x.png') }] })
    expect(db.mentions('s1', shot)).toBe(true)
    expect(db.mentions('s1', '~/a b.png')).toBe(true)
    expect(db.mentions('s1', '/tmp/y.png')).toBe(false)
    // Only the text of a reply or a message, as the live thread looks.
    expect(db.mentions('s1', '/tmp/linked.png')).toBe(false)
    expect(db.mentions('s1', '"kind"')).toBe(false)
    // A tool call's text is not where a reply names its files.
    expect(db.mentions('s2', '/tmp/x.png')).toBe(false)
    expect(db.mentions('missing', shot)).toBe(false)
    db.close()
  })

  it('removes threads with their images', () => {
    const file = tempFile()
    const db = open(file)
    const big = Buffer.alloc(INLINE_MEDIA_LIMIT, 1).toString('base64')
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

describe("the thread database's artifacts", () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
  const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

  function withContent(file = tempFile()): { db: ThreadDb; content: string } {
    const content = path.join(path.dirname(file), 'content')
    const db = ThreadDb.open(
      file,
      (level, message) => logs.push({ level, message }),
      () => 0,
      content,
    )
    return { db, content }
  }

  function create(db: ThreadDb, files: Record<string, string>): void {
    db.createArtifact({
      id: ID,
      project: '/p',
      sessionId: 's1',
      title: 'Report',
      files: Object.entries(files).map(([path, text]) => ({ path, data: bytes(text) })),
      pages: 0,
      note: null,
      at: 1,
    })
  }

  const pathsOf = (db: ThreadDb, version: number | null = null): Record<string, string> =>
    Object.fromEntries(
      db.getArtifact({ id: ID, version, project: null }).files.map((f) => [f.path, f.hash]),
    )

  it('keeps a version as its paths, each naming the content file of its bytes', () => {
    const { db, content } = withContent()
    create(db, { 'index.html': '<p>hi</p>', 'styles/app.css': 'p{}' })
    const { version, files } = db.getArtifact({ id: ID, version: null, project: null })
    expect(files.map((f) => f.path)).toEqual(['index.html', 'styles/app.css'])
    expect(version.size).toBe(9 + 3)
    for (const f of files) {
      expect(f.hash).toBe(contentHash(bytes(f.path === 'index.html' ? '<p>hi</p>' : 'p{}')))
      expect(readFileSync(contentPath(content, f.hash), 'utf8')).toBe(
        f.path === 'index.html' ? '<p>hi</p>' : 'p{}',
      )
    }
    db.close()
  })

  it('writes a version from the latest, keeping the files it does not change', () => {
    const { db } = withContent()
    create(db, { 'index.html': 'a', 'app.js': 'b', 'old.css': 'c' })
    const before = pathsOf(db)
    db.writeArtifact({
      id: ID,
      project: '/p',
      baseVersion: 1,
      changes: [
        { path: 'app.js', data: bytes('b2') },
        { path: 'old.css', data: null },
        { path: 'img/logo.svg', data: bytes('<svg/>') },
      ],
      pages: 0,
      author: 's1',
      note: null,
      at: 2,
    })
    const after = pathsOf(db)
    expect(Object.keys(after)).toEqual(['app.js', 'img/logo.svg', 'index.html'])
    expect(after['index.html']).toBe(before['index.html'])
    expect(after['app.js']).toBe(contentHash(bytes('b2')))
    expect(pathsOf(db, 1)).toEqual(before)
    expect(() =>
      db.writeArtifact({
        id: ID,
        project: '/p',
        baseVersion: 1,
        changes: [{ path: 'app.js', data: bytes('b3') }],
        pages: 0,
        author: 's1',
        note: null,
        at: 3,
      }),
    ).toThrow(ThreadDbError)
    expect(db.getArtifact({ id: ID, version: null, project: null }).artifact.head).toBe(2)
    db.close()
  })

  it('refuses a version without its entry page, and records nothing of it', () => {
    const { db } = withContent()
    create(db, { 'index.html': 'a' })
    expect(() =>
      db.writeArtifact({
        id: ID,
        project: '/p',
        baseVersion: 1,
        changes: [{ path: 'index.html', data: null }],
        pages: 0,
        author: 's1',
        note: null,
        at: 2,
      }),
    ).toThrow(/index\.html/)
    expect(db.getArtifact({ id: ID, version: null, project: null }).artifact.head).toBe(1)
    db.close()
  })

  it('restores a version with all its files', () => {
    const { db } = withContent()
    create(db, { 'index.html': 'a', 'app.js': 'b' })
    db.writeArtifact({
      id: ID,
      project: null,
      baseVersion: 1,
      changes: [{ path: 'app.js', data: null }],
      pages: 0,
      author: null,
      note: null,
      at: 2,
    })
    db.restoreArtifact({
      id: ID,
      project: null,
      version: 1,
      baseVersion: 2,
      author: null,
      note: null,
      at: 3,
    })
    expect(pathsOf(db, 3)).toEqual(pathsOf(db, 1))
    expect(db.getArtifact({ id: ID, version: 3, project: null }).version.size).toBe(2)
    db.close()
  })

  it('removes only the content files no version names when it erases and purges', () => {
    const { db, content } = withContent()
    create(db, { 'index.html': 'shared', 'only.css': 'mine' })
    db.createArtifact({
      id: 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D4',
      project: '/p',
      sessionId: 's1',
      title: 'Other',
      files: [{ path: 'index.html', data: bytes('shared') }],
      pages: 0,
      note: null,
      at: 1,
    })
    const stray = contentPath(content, contentHash(bytes('stray')))
    mkdirSync(path.dirname(stray), { recursive: true })
    writeFileSync(stray, 'stray')
    db.deleteArtifact({ id: ID, project: null, at: 2 })
    db.eraseArtifact(ID)
    expect(existsSync(contentPath(content, contentHash(bytes('shared'))))).toBe(true)
    expect(existsSync(contentPath(content, contentHash(bytes('mine'))))).toBe(false)
    expect(existsSync(stray)).toBe(true)
    expect(db.purgeArtifacts(0)).toEqual({ artifacts: 0, files: 1 })
    expect(existsSync(stray)).toBe(false)
    expect(existsSync(contentPath(content, contentHash(bytes('shared'))))).toBe(true)
    db.close()
  })

  it('records the type and format of each version of a typed artifact', () => {
    const { db } = withContent()
    db.createArtifact({
      id: ID,
      project: '/p',
      sessionId: 's1',
      title: 'Doc',
      files: [{ path: 'document.md', data: bytes('# A') }],
      pages: 1,
      note: null,
      at: 1,
      type: { name: 'document', format: 1 },
    })
    expect(db.getArtifact({ id: ID, version: null, project: null }).type).toEqual({
      name: 'document',
      format: 1,
    })
    expect(db.listArtifacts({ project: null, deleted: false })[0]!.type).toBe('document')
    db.writeArtifact({
      id: ID,
      project: null,
      baseVersion: 1,
      changes: [{ path: 'document.md', data: bytes('# B') }],
      pages: 1,
      author: null,
      note: null,
      at: 2,
      type: { name: 'document', format: 2 },
    })
    expect(db.getArtifact({ id: ID, version: 2, project: null }).type).toEqual({
      name: 'document',
      format: 2,
    })
    db.restoreArtifact({
      id: ID,
      project: null,
      version: 1,
      baseVersion: 2,
      author: null,
      note: null,
      at: 3,
    })
    expect(db.getArtifact({ id: ID, version: 3, project: null }).type).toEqual({
      name: 'document',
      format: 1,
    })
    db.close()
  })

  it('keeps an artifact of the type it was made from, or of none', () => {
    const { db } = withContent()
    db.createArtifact({
      id: ID,
      project: '/p',
      sessionId: 's1',
      title: 'Deck',
      files: [{ path: 'slides.json', data: bytes('{}') }],
      pages: 1,
      note: null,
      at: 1,
      type: { name: 'slides', format: 1 },
    })
    const write = (type: { name: 'document' | 'slides'; format: number } | null) =>
      db.writeArtifact({
        id: ID,
        project: null,
        baseVersion: 1,
        changes: [{ path: 'slides.json', data: bytes('{"a":1}') }],
        pages: 1,
        author: null,
        note: null,
        at: 2,
        type,
      })
    expect(() => write(null)).toThrow(/is a slides, not plain/)
    expect(() => write({ name: 'document', format: 1 })).toThrow(/is a slides, not a document/)
    expect(db.getArtifact({ id: ID, version: null, project: null }).artifact.head).toBe(1)
    const plain = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D4'
    db.createArtifact({
      id: plain,
      project: '/p',
      sessionId: 's1',
      title: 'Page',
      files: [{ path: 'index.html', data: bytes('<p>') }],
      pages: 0,
      note: null,
      at: 1,
    })
    expect(db.getArtifact({ id: plain, version: null, project: null }).type).toBeNull()
    expect(() =>
      db.writeArtifact({
        id: plain,
        project: null,
        baseVersion: 1,
        changes: [{ path: 'index.html', data: bytes('<p>2') }],
        pages: 0,
        author: null,
        note: null,
        at: 2,
        type: { name: 'document', format: 1 },
      }),
    ).toThrow(/is plain, not a document/)
    db.close()
  })

  it('keeps the artifacts of a database before types as plain ones', () => {
    const file = tempFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const raw = new DatabaseSync(file)
    raw.exec(`BEGIN; ${schemaAt(5)} PRAGMA user_version = 5; COMMIT;`)
    raw
      .prepare(
        'INSERT INTO artifacts (id, project, title, head, session_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 1)',
      )
      .run(ID, '/p', 'Old', 's1')
    raw
      .prepare(
        "INSERT INTO artifact_versions (artifact_id, n, size, pages, author, note, created_at) VALUES (?, 1, 3, 0, 's1', NULL, 1)",
      )
      .run(ID)
    raw
      .prepare(
        "INSERT INTO artifact_files (artifact_id, n, path, hash, size) VALUES (?, 1, 'index.html', ?, 3)",
      )
      .run(ID, contentHash(bytes('<p>')))
    raw.close()
    const { db } = withContent(file)
    expect(db.status).toBe('ok')
    expect(db.getArtifact({ id: ID, version: 1, project: null }).type).toBeNull()
    expect(db.listArtifacts({ project: null, deleted: false })[0]!.type).toBeNull()
    db.close()
    const check = new DatabaseSync(file)
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(SCHEMA_VERSION)
    expect(
      check.prepare("SELECT name FROM sqlite_master WHERE name = 'artifact_types'").get(),
    ).toBeDefined()
    check.close()
  })

  it('makes each version of a database before files an index.html of its one file', () => {
    const file = tempFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const content = path.join(path.dirname(file), 'content')
    const pages = ['<h1>v1</h1>', '<h1>v2</h1>']
    const raw = new DatabaseSync(file)
    raw.exec(`BEGIN; ${schemaAt(4)} PRAGMA user_version = 4; COMMIT;`)
    raw
      .prepare(
        'INSERT INTO artifacts (id, project, title, head, session_id, created_at, updated_at) VALUES (?, ?, ?, 2, ?, 1, 2)',
      )
      .run(ID, '/p', 'Old', 's1')
    pages.forEach((html, i) => {
      const hash = contentHash(bytes(html))
      raw
        .prepare(
          'INSERT INTO artifact_versions (artifact_id, n, hash, size, pages, author, note, created_at) VALUES (?, ?, ?, ?, 0, ?, NULL, ?)',
        )
        .run(ID, i + 1, hash, html.length, 's1', i + 1)
      mkdirSync(path.dirname(contentPath(content, hash)), { recursive: true })
      writeFileSync(contentPath(content, hash), html)
    })
    raw.close()
    const { db } = withContent(file)
    expect(db.status).toBe('ok')
    for (const [i, html] of pages.entries()) {
      const found = db.getArtifact({ id: ID, version: i + 1, project: null })
      expect(found.files).toEqual([
        { path: 'index.html', hash: contentHash(bytes(html)), size: html.length },
      ])
      expect(found.version.size).toBe(html.length)
    }
    expect(db.purgeArtifacts(0).files).toBe(0)
    for (const html of pages) {
      expect(readFileSync(contentPath(content, contentHash(bytes(html))), 'utf8')).toBe(html)
    }
    db.close()
    const check = new DatabaseSync(file)
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(SCHEMA_VERSION)
    const columns = check.prepare('PRAGMA table_info(artifact_versions)').all()
    expect(columns.map((c) => c.name)).not.toContain('hash')
    check.close()
  })
})
