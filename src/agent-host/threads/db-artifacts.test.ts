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
import { contentHash, contentPath, putContent } from '../artifacts/content'
import type { ArtifactCalls } from '../artifacts/model'
import { SCHEMA_VERSION, ThreadDb } from './db'
import { EMPTY_SESSION } from './model'

const dirs: string[] = []
const logs: { level: string; message: string }[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  logs.length = 0
})

function setup(): { db: ThreadDb; file: string; content: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-artifacts-'))
  dirs.push(dir)
  const file = path.join(dir, 'state', 'threads.db')
  const content = path.join(dir, 'artifacts', 'content')
  const db = ThreadDb.open(
    file,
    (level, message) => logs.push({ level, message }),
    () => 0,
    content,
  )
  return { db, file, content }
}

type Create = ArtifactCalls['create']['params']
type Write = ArtifactCalls['write']['params']
type Restore = ArtifactCalls['restore']['params']

function create(db: ThreadDb, change: Partial<Create> = {}): { version: number } {
  return db.createArtifact({
    id: 'art_a',
    project: '/p',
    sessionId: 's1',
    title: 'Report',
    html: '<p>one</p>',
    pages: 1,
    note: null,
    at: 10,
    ...change,
  })
}

function write(db: ThreadDb, change: Partial<Write> = {}): { version: number } {
  return db.writeArtifact({
    id: 'art_a',
    project: null,
    baseVersion: 1,
    html: '<p>two</p>',
    pages: 1,
    author: 's1',
    note: null,
    at: 20,
    ...change,
  })
}

function restore(db: ThreadDb, change: Partial<Restore> = {}): { version: number } {
  return db.restoreArtifact({
    id: 'art_a',
    project: null,
    version: 1,
    baseVersion: 2,
    author: null,
    note: null,
    at: 30,
    ...change,
  })
}

const refused = (code: string, data?: { version: number; deleted: boolean }) =>
  expect.objectContaining(data ? { code, data } : { code })

const html = (content: string, hash: string): string =>
  readFileSync(contentPath(content, hash), 'utf8')

describe('artifacts in the thread database', () => {
  it('creates an artifact at version 1 with its HTML in a file named by its hash', () => {
    const { db, content } = setup()
    expect(create(db, { note: 'First draft' })).toEqual({ version: 1 })
    const { artifact, version } = db.getArtifact({ id: 'art_a', version: null, project: null })
    expect(artifact).toEqual({
      id: 'art_a',
      project: '/p',
      title: 'Report',
      head: 1,
      sessionId: 's1',
      createdAt: 10,
      updatedAt: 10,
      deletedAt: null,
    })
    const hash = contentHash('<p>one</p>')
    expect(version).toEqual({
      version: 1,
      hash,
      size: 10,
      pages: 1,
      author: 's1',
      note: 'First draft',
      createdAt: 10,
    })
    expect(path.relative(content, contentPath(content, hash))).toBe(
      path.join(hash.slice(0, 2), `${hash}.html`),
    )
    expect(html(content, hash)).toBe('<p>one</p>')
    db.close()
  })

  it('numbers versions one above the latest and never changes an earlier one', () => {
    const { db, content } = setup()
    create(db)
    expect(write(db, { html: '<p>twö</p>', pages: 3, note: 'Second' })).toEqual({
      version: 2,
    })
    expect(write(db, { baseVersion: 2, html: '<p>three</p>', at: 25 })).toEqual({ version: 3 })

    const first = db.getArtifact({ id: 'art_a', version: 1, project: null }).version
    expect(html(content, first.hash)).toBe('<p>one</p>')
    const second = db.getArtifact({ id: 'art_a', version: 2, project: null }).version
    expect(second).toMatchObject({ size: 11, pages: 3, note: 'Second', createdAt: 20 })
    const latest = db.getArtifact({ id: 'art_a', version: null, project: null })
    expect(latest.artifact).toMatchObject({ head: 3, updatedAt: 25 })
    expect(latest.version.version).toBe(3)
    expect(db.artifactVersions({ id: 'art_a', project: null }).map((v) => v.version)).toEqual([
      3, 2, 1,
    ])
    expect(() => db.getArtifact({ id: 'art_a', version: 4, project: null })).toThrow(
      refused('not_found'),
    )
    db.close()
  })

  it('refuses a version from a stale base with the latest number, and changes nothing', () => {
    const { db, content } = setup()
    create(db)
    write(db)
    expect(() => write(db, { baseVersion: 1, html: '<p>lost</p>' })).toThrow(
      refused('conflict', { version: 2, deleted: false }),
    )
    expect(() => restore(db, { baseVersion: 1 })).toThrow(
      refused('conflict', { version: 2, deleted: false }),
    )
    expect(db.getArtifact({ id: 'art_a', version: null, project: null }).artifact.head).toBe(2)
    expect(existsSync(contentPath(content, contentHash('<p>lost</p>')))).toBe(false)
    db.close()
  })

  it('restores a version as the newest, sharing its file', () => {
    const { db, content } = setup()
    create(db)
    write(db)
    expect(restore(db)).toEqual({ version: 3 })
    const restored = db.getArtifact({ id: 'art_a', version: null, project: null })
    const first = db.getArtifact({ id: 'art_a', version: 1, project: null }).version
    expect(restored.version).toMatchObject({ hash: first.hash, author: null, createdAt: 30 })
    expect(restored.artifact.updatedAt).toBe(30)
    expect(html(content, restored.version.hash)).toBe('<p>one</p>')
    expect(() => restore(db, { version: 9, baseVersion: 3 })).toThrow(refused('not_found'))
    db.close()
  })

  it('writes the same HTML to one file', () => {
    const { db, content } = setup()
    create(db)
    create(db, { id: 'art_b' })
    write(db, { html: '<p>one</p>' })
    const hash = contentHash('<p>one</p>')
    const folder = path.dirname(contentPath(content, hash))
    const versions = db.artifactVersions({ id: 'art_a', project: null })
    expect(versions.map((v) => v.hash)).toEqual([hash, hash])
    expect(readdirNames(folder)).toEqual([`${hash}.html`])
    db.close()
  })

  it('keeps the title out of the versions', () => {
    const { db } = setup()
    create(db)
    db.renameArtifact({ id: 'art_a', project: null, title: 'Traffic report' })
    const { artifact } = db.getArtifact({ id: 'art_a', version: null, project: null })
    expect(artifact).toMatchObject({ title: 'Traffic report', head: 1, updatedAt: 10 })
    expect(db.artifactVersions({ id: 'art_a', project: null })).toHaveLength(1)
    db.close()
  })

  it("reaches only a session's own project, outside Recently deleted", () => {
    const { db } = setup()
    create(db, { id: 'art_a', project: '/p', at: 10 })
    create(db, { id: 'art_b', project: '/q', at: 20 })
    create(db, { id: 'art_c', project: '/p', at: 30 })
    expect(db.listArtifacts({ project: '/p' }).map((a) => a.id)).toEqual(['art_c', 'art_a'])
    expect(db.listArtifacts({ project: null, deleted: false }).map((a) => a.id)).toEqual([
      'art_c',
      'art_b',
      'art_a',
    ])

    const elsewhere = { id: 'art_b', project: '/p' }
    expect(() => db.getArtifact({ ...elsewhere, version: null })).toThrow(refused('not_found'))
    expect(() => db.artifactVersions(elsewhere)).toThrow(refused('not_found'))
    expect(() => write(db, elsewhere)).toThrow(refused('not_found'))
    expect(() => restore(db, { ...elsewhere, baseVersion: 1 })).toThrow(refused('not_found'))
    expect(() => db.renameArtifact({ ...elsewhere, title: 'Mine' })).toThrow(refused('not_found'))
    expect(() => db.deleteArtifact({ ...elsewhere, at: 40 })).toThrow(refused('not_found'))
    expect(db.getArtifact({ id: 'art_b', version: null, project: null }).artifact.title).toBe(
      'Report',
    )

    expect(write(db, { id: 'art_a', project: '/p' })).toEqual({ version: 2 })
    db.deleteArtifact({ id: 'art_a', project: '/p', at: 50 })
    expect(db.listArtifacts({ project: '/p' }).map((a) => a.id)).toEqual(['art_c'])
    const inProject = { id: 'art_a', project: '/p' }
    const deleted = refused('deleted', { version: 2, deleted: true })
    expect(() => db.getArtifact({ ...inProject, version: null })).toThrow(deleted)
    expect(() => db.artifactVersions(inProject)).toThrow(deleted)
    expect(() => db.renameArtifact({ ...inProject, title: 'Back' })).toThrow(deleted)
    db.close()
  })

  it('moves deleted artifacts to Recently deleted and back', () => {
    const { db } = setup()
    create(db, { id: 'art_a', at: 10 })
    create(db, { id: 'art_b', at: 20 })
    create(db, { id: 'art_c', at: 30 })
    expect(db.deleteArtifact({ id: 'art_a', project: null, at: 40 })).toEqual({
      deletedAt: 40,
      changed: true,
    })
    expect(db.deleteArtifact({ id: 'art_c', project: null, at: 50 })).toEqual({
      deletedAt: 50,
      changed: true,
    })
    // A second delete keeps the time it went, so its 30 days do not start again.
    expect(db.deleteArtifact({ id: 'art_a', project: '/p', at: 60 })).toEqual({
      deletedAt: 40,
      changed: false,
    })

    expect(db.listArtifacts({ project: null, deleted: false }).map((a) => a.id)).toEqual(['art_b'])
    expect(db.listArtifacts({ project: null, deleted: true })).toEqual([
      expect.objectContaining({ id: 'art_c', deletedAt: 50 }),
      expect.objectContaining({ id: 'art_a', deletedAt: 40 }),
    ])
    // The user still reads and renames what is in Recently deleted, but makes no versions there.
    expect(db.getArtifact({ id: 'art_a', version: null, project: null }).artifact.deletedAt).toBe(
      40,
    )
    db.renameArtifact({ id: 'art_a', project: null, title: 'Old report' })
    expect(() => write(db)).toThrow(refused('deleted', { version: 1, deleted: true }))

    expect(db.undeleteArtifact('art_a')).toEqual({ changed: true })
    expect(db.undeleteArtifact('art_a')).toEqual({ changed: false })
    expect(db.listArtifacts({ project: '/p' }).map((a) => [a.id, a.title])).toEqual([
      ['art_b', 'Report'],
      ['art_a', 'Old report'],
    ])
    expect(write(db)).toEqual({ version: 2 })
    expect(() => db.undeleteArtifact('art_z')).toThrow(refused('not_found'))
    db.close()
  })

  it('lists an artifact under the session of its latest version, or its creator', () => {
    const { db } = setup()
    create(db, { sessionId: 's1' })
    expect(db.listArtifacts({ project: '/p' })[0]).toEqual({
      id: 'art_a',
      title: 'Report',
      project: '/p',
      sessionId: 's1',
      version: 1,
      pages: 1,
      size: 10,
      updatedAt: 10,
      deletedAt: null,
    })
    write(db, { author: 's2', html: '<p>2</p>', pages: 4 })
    expect(db.listArtifacts({ project: '/p' })[0]).toMatchObject({
      sessionId: 's2',
      version: 2,
      pages: 4,
      size: 8,
      updatedAt: 20,
    })
    restore(db, { author: null })
    expect(db.listArtifacts({ project: '/p' })[0]).toMatchObject({ sessionId: 's1', version: 3 })
    db.close()
  })

  it('erases an artifact in Recently deleted with the files only it names', () => {
    const { db, content } = setup()
    create(db, { id: 'art_a', html: '<p>shared</p>' })
    write(db, { html: '<p>own</p>' })
    create(db, { id: 'art_b', html: '<p>shared</p>' })
    expect(() => db.eraseArtifact('art_a')).toThrow(
      refused('conflict', { version: 2, deleted: false }),
    )
    db.deleteArtifact({ id: 'art_a', project: null, at: 30 })
    db.eraseArtifact('art_a')
    expect(() => db.getArtifact({ id: 'art_a', version: null, project: null })).toThrow(
      refused('not_found'),
    )
    expect(existsSync(contentPath(content, contentHash('<p>own</p>')))).toBe(false)
    expect(html(content, contentHash('<p>shared</p>'))).toBe('<p>shared</p>')
    db.close()
  })

  it('purges what was deleted more than 30 days ago, then every file no version names', () => {
    const { db, content } = setup()
    create(db, { id: 'art_old', html: '<p>old</p>' })
    write(db, { id: 'art_old', html: '<p>old 2</p>' })
    create(db, { id: 'art_new', html: '<p>new</p>' })
    create(db, { id: 'art_live', html: '<p>live</p>' })
    db.deleteArtifact({ id: 'art_old', project: null, at: 100 })
    db.deleteArtifact({ id: 'art_new', project: null, at: 200 })
    // What a crash can leave: a file whose row never committed, and a temporary file.
    putContent(content, contentHash('<p>orphan</p>'), '<p>orphan</p>')
    const temp = `${contentPath(content, contentHash('<p>live</p>'))}.0a1b2c3d.tmp`
    writeFileSync(temp, '<p>li')
    const foreign = path.join(path.dirname(temp), 'notes.txt')
    writeFileSync(foreign, 'not ours')

    expect(db.purgeArtifacts(200)).toEqual({ artifacts: 1, files: 4 })
    expect(db.listArtifacts({ project: null, deleted: true }).map((a) => a.id)).toEqual(['art_new'])
    for (const gone of ['<p>old</p>', '<p>old 2</p>', '<p>orphan</p>']) {
      expect(existsSync(contentPath(content, contentHash(gone)))).toBe(false)
    }
    expect(existsSync(temp)).toBe(false)
    expect(existsSync(foreign)).toBe(true)
    expect(html(content, contentHash('<p>new</p>'))).toBe('<p>new</p>')
    expect(html(content, contentHash('<p>live</p>'))).toBe('<p>live</p>')
    expect(db.purgeArtifacts(200)).toEqual({ artifacts: 0, files: 0 })
    db.close()
  })

  it('keeps the artifacts of a session whose thread is deleted', () => {
    const { db } = setup()
    db.write('s1', {
      head: { agentId: 'fake-agent', acpSessionId: 'acp-1' },
      entries: [{ pos: 0, entry: notice('n0') }],
    })
    create(db, { sessionId: 's1' })
    db.remove(['s1'])
    expect(db.page('s1', null)).toBeNull()
    expect(db.listArtifacts({ project: '/p' })).toEqual([
      expect.objectContaining({ id: 'art_a', sessionId: 's1' }),
    ])
    db.close()
  })

  it('writes no artifact without a content folder, and touches nothing in a newer database', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-artifacts-'))
    dirs.push(dir)
    const file = path.join(dir, 'threads.db')
    const bare = ThreadDb.open(file, () => {})
    expect(() => create(bare)).toThrow(refused('unavailable'))
    expect(bare.listArtifacts({ project: '/p' })).toEqual([])
    bare.close()

    const raw = new DatabaseSync(file)
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()
    const content = path.join(dir, 'content')
    putContent(content, contentHash('<p>kept</p>'), '<p>kept</p>')
    const newer = ThreadDb.open(file, () => {}, Date.now, content)
    expect(newer.status).toBe('newer')
    expect(() => newer.listArtifacts({ project: '/p' })).toThrow(refused('unavailable'))
    expect(() => create(newer)).toThrow(refused('unavailable'))
    expect(newer.purgeArtifacts(Number.MAX_SAFE_INTEGER)).toEqual({ artifacts: 0, files: 0 })
    expect(html(content, contentHash('<p>kept</p>'))).toBe('<p>kept</p>')
    newer.close()
  })
})

// Version 1 as it shipped, before artifacts, for the migration from it.
const SCHEMA_V1 = `
  CREATE TABLE threads (
    session_id     TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL,
    acp_session_id TEXT NOT NULL,
    session_json   TEXT NOT NULL,
    next_pos       INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE entries (
    session_id TEXT NOT NULL REFERENCES threads (session_id) ON DELETE CASCADE,
    pos        INTEGER NOT NULL,
    turn       INTEGER NOT NULL,
    entry_id   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    json       TEXT NOT NULL,
    PRIMARY KEY (session_id, pos)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX entries_by_id ON entries (session_id, entry_id);
  CREATE INDEX entries_by_kind ON entries (session_id, kind, pos);
  CREATE TABLE blobs (
    session_id TEXT NOT NULL REFERENCES threads (session_id) ON DELETE CASCADE,
    hash       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    PRIMARY KEY (session_id, hash)
  ) STRICT, WITHOUT ROWID;
`

function notice(id: string): ThreadEntry {
  return { kind: 'notice', id, severity: 'info', title: id }
}

function readdirNames(folder: string): string[] {
  return readdirSync(folder).sort()
}

function tables(file: string): { version: number; names: string[] } {
  const raw = new DatabaseSync(file)
  const version = Number(raw.prepare('PRAGMA user_version').get()!.user_version)
  const names = raw
    .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !name.startsWith('sqlite_'))
  raw.close()
  return { version, names }
}

const ALL_TABLES = [
  'artifact_versions',
  'artifacts',
  'artifacts_by_project',
  'blobs',
  'entries',
  'entries_by_id',
  'entries_by_kind',
  'threads',
]

describe('the thread database schema', () => {
  it('creates the artifact tables in a new database', () => {
    const { db, file } = setup()
    expect(db.status).toBe('created')
    db.close()
    expect(tables(file)).toEqual({ version: 2, names: ALL_TABLES })
  })

  it('migrates a version 1 database, keeping its threads, to empty artifact tables', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-artifacts-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'state'))
    const file = path.join(dir, 'state', 'threads.db')
    const raw = new DatabaseSync(file)
    raw.exec('PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL;')
    raw.exec(`BEGIN; ${SCHEMA_V1} PRAGMA user_version = 1; COMMIT;`)
    raw
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)')
      .run('s1', 'fake-agent', 'acp-1', JSON.stringify(EMPTY_SESSION), 1, 5)
    raw
      .prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)')
      .run('s1', 0, 0, 'n0', 'notice', JSON.stringify(notice('n0')))
    raw.close()

    const content = path.join(dir, 'artifacts', 'content')
    const db = ThreadDb.open(
      file,
      (level, message) => logs.push({ level, message }),
      () => 0,
      content,
    )
    expect(db.status).toBe('ok')
    expect(logs).toContainEqual({
      level: 'info',
      message: 'Migrated threads.db from schema version 1',
    })
    expect(db.page('s1', null)!.entries).toEqual([notice('n0')])
    expect(db.listArtifacts({ project: null, deleted: false })).toEqual([])
    expect(db.listArtifacts({ project: null, deleted: true })).toEqual([])
    create(db)
    db.close()
    expect(tables(file)).toEqual({ version: 2, names: ALL_TABLES })

    const again = ThreadDb.open(
      file,
      () => {},
      () => 0,
      content,
    )
    expect(again.status).toBe('ok')
    expect(again.listArtifacts({ project: '/p' }).map((a) => a.id)).toEqual(['art_a'])
    again.close()
  })
})
