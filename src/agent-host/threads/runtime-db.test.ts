import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeCall, RuntimeCalls } from '../artifacts/runtime/calls'
import { schemaAt, SCHEMA_VERSION, ThreadDb, ThreadDbError } from './db'

const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'
const OTHER = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D4'
const dirs: string[] = []
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-runtime-db-'))
  dirs.push(dir)
  return path.join(dir, 'state', 'threads.db')
}

function open(file = tempFile()): ThreadDb {
  return ThreadDb.open(
    file,
    () => {},
    () => 0,
    path.join(path.dirname(file), 'content'),
  )
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function call<K extends keyof RuntimeCalls>(
  db: ThreadDb,
  name: K,
  params: RuntimeCalls[K]['params'],
): RuntimeCalls[K]['result'] {
  return db.runtime({ name, params } as RuntimeCall) as RuntimeCalls[K]['result']
}

function create(db: ThreadDb, id = ID, capabilities?: string[]): void {
  db.createArtifact({
    id,
    project: '/p',
    sessionId: 's1',
    title: 'Board',
    files: [{ path: 'index.html', data: bytes('<p>v1</p>') }],
    pages: 0,
    note: null,
    at: 1,
    ...(capabilities ? { declaration: { capabilities, runtime: 1 } } : {}),
  })
}

function put(
  db: ThreadDb,
  docId: string,
  value: unknown,
  extra: Partial<RuntimeCalls['dataPut']['params']> = {},
) {
  return call(db, 'dataPut', {
    id: ID,
    project: null,
    collection: 'todos',
    docId,
    mode: 'set',
    json: JSON.stringify(value),
    baseVersion: null,
    docLimit: 1024,
    limit: 4096,
    at: 5,
    ...extra,
  })
}

function failure(run: () => unknown): ThreadDbError {
  try {
    run()
  } catch (error) {
    if (error instanceof ThreadDbError) return error
    throw error
  }
  throw new Error('It did not fail')
}

describe("the thread database's runtime tables", () => {
  it('keeps what each version declares: new, written, kept by a write, restored', () => {
    const db = open()
    create(db, ID, ['db', 'files'])
    const latest = () => call(db, 'declaration', { id: ID, project: null, version: null })
    expect(latest()).toMatchObject({ head: 1, capabilities: ['db', 'files'], runtime: 1 })
    db.writeArtifact({
      id: ID,
      project: null,
      baseVersion: 1,
      changes: [{ path: 'index.html', data: bytes('<p>v2</p>') }],
      pages: 0,
      author: null,
      note: null,
      at: 2,
    })
    expect(latest()).toMatchObject({ head: 2, capabilities: ['db', 'files'] })
    db.writeArtifact({
      id: ID,
      project: null,
      baseVersion: 2,
      changes: [],
      pages: 0,
      author: 's1',
      note: null,
      at: 3,
      declaration: { capabilities: [], runtime: 1 },
    })
    expect(latest()).toMatchObject({ head: 3, capabilities: [] })
    db.restoreArtifact({
      id: ID,
      project: null,
      version: 1,
      baseVersion: 3,
      author: null,
      note: null,
      at: 4,
    })
    expect(latest()).toMatchObject({ head: 4, capabilities: ['db', 'files'] })
    expect(call(db, 'declaration', { id: ID, project: null, version: 3 }).capabilities).toEqual([])
    expect(
      failure(() => call(db, 'declaration', { id: ID, project: '/q', version: null })).code,
    ).toBe('not_found')
    db.close()
  })

  it('stores documents with versions that only grow, and refuses a stale base', () => {
    const db = open()
    create(db)
    const first = put(db, 'a', { text: 'milk', done: false }, { baseVersion: 0 })
    expect(first).toMatchObject({ id: 'a', version: 1, value: { text: 'milk', done: false } })
    expect(failure(() => put(db, 'a', { text: 'eggs' }, { baseVersion: 0 })).code).toBe('conflict')
    const stale = failure(() => put(db, 'a', { text: 'eggs' }, { baseVersion: 7 }))
    expect(stale.code).toBe('conflict')
    expect(stale.data).toEqual({ version: 1, deleted: false })
    const merged = put(db, 'a', { done: true }, { mode: 'merge', baseVersion: 1 })
    expect(merged).toMatchObject({ version: 2, value: { text: 'milk', done: true } })
    expect(
      call(db, 'dataDelete', {
        id: ID,
        project: null,
        collection: 'todos',
        docId: 'a',
        baseVersion: 2,
      }),
    ).toEqual({
      deleted: true,
    })
    // Made again, it never takes a version it had before.
    expect(put(db, 'a', { text: 'bread' }).version).toBe(3)
    expect(failure(() => put(db, 'b', { x: 1 }, { mode: 'merge' })).code).toBe('not_found')
    expect(failure(() => put(db, 'a', [1], { mode: 'merge' })).code).toBe('invalid')
    db.close()
  })

  it("holds each document and the artifact's data to their limits", () => {
    const db = open()
    create(db)
    const small = { limit: 3500 }
    expect(failure(() => put(db, 'big', 'x'.repeat(2000))).code).toBe('too_large')
    put(db, 'a', 'x'.repeat(1000), small)
    put(db, 'b', 'x'.repeat(1000), small)
    put(db, 'c', 'x'.repeat(1000), small)
    expect(failure(() => put(db, 'd', 'x'.repeat(1000), small)).code).toBe('too_large')
    // Rewriting a document counts its new size in place of the old.
    put(db, 'c', 'x'.repeat(1010), small)
    call(db, 'dataDelete', {
      id: ID,
      project: null,
      collection: 'todos',
      docId: 'a',
      baseVersion: null,
    })
    put(db, 'd', 'x'.repeat(1000), small)
    expect(call(db, 'dataCollections', { id: ID, project: null })).toEqual({
      collections: [{ name: 'todos', count: 3 }],
      bytes: 1002 + 1012 + 1002,
    })
    db.close()
  })

  it('lists by id a page at a time and queries with filters, order and limit', () => {
    const db = open()
    create(db)
    const rows = [
      { id: 'a', due: 3, done: false, owner: { name: 'li' } },
      { id: 'b', due: 1, done: true, owner: { name: 'mo' } },
      { id: 'c', due: 2, done: false, owner: null },
      { id: 'd', due: 5, done: false, owner: { name: 'li' } },
    ]
    for (const row of rows) put(db, row.id, row)
    const page = call(db, 'dataList', {
      id: ID,
      project: null,
      collection: 'todos',
      after: null,
      limit: 2,
    })
    expect(page.docs.map((d) => d.id)).toEqual(['a', 'b'])
    expect(page.next).toBe('b')
    const rest = call(db, 'dataList', {
      id: ID,
      project: null,
      collection: 'todos',
      after: 'b',
      limit: 2,
    })
    expect(rest).toMatchObject({ next: null })
    expect(rest.docs.map((d) => d.id)).toEqual(['c', 'd'])
    const query = (params: Partial<RuntimeCalls['dataQuery']['params']>) =>
      call(db, 'dataQuery', {
        id: ID,
        project: null,
        collection: 'todos',
        where: [],
        orderBy: null,
        limit: 10,
        ...params,
      }).map((d) => d.id)
    expect(
      query({
        where: [
          { field: 'done', op: '==', value: false },
          { field: 'due', op: '<', value: 5 },
        ],
        orderBy: { field: 'due', direction: 'asc' },
      }),
    ).toEqual(['c', 'a'])
    expect(query({ where: [{ field: 'owner.name', op: '==', value: 'li' }] })).toEqual(['a', 'd'])
    expect(query({ where: [{ field: 'owner', op: '==', value: null }] })).toEqual(['c'])
    expect(query({ orderBy: { field: 'due', direction: 'desc' }, limit: 2 })).toEqual(['d', 'a'])
    // A field that names SQL is only a path that matches nothing.
    expect(query({ where: [{ field: "x') OR 1=1 --", op: '==', value: 1 }] })).toEqual([])
    db.close()
  })

  it('keeps data out of reach while the artifact is deleted, and removes it with the artifact', () => {
    const db = open()
    create(db)
    create(db, OTHER)
    put(db, 'a', 1)
    call(db, 'consentGrant', { id: ID, capability: 'files', at: 1 })
    db.deleteArtifact({ id: ID, project: null, at: 10 })
    expect(
      failure(() => call(db, 'dataGet', { id: ID, project: null, collection: 'todos', docId: 'a' }))
        .code,
    ).toBe('deleted')
    expect(call(db, 'consents', undefined)).toEqual([])
    db.undeleteArtifact(ID)
    expect(
      call(db, 'dataGet', { id: ID, project: null, collection: 'todos', docId: 'a' })?.value,
    ).toBe(1)
    expect(call(db, 'consents', undefined)).toEqual([
      { id: ID, title: 'Board', project: '/p', capabilities: ['files'] },
    ])
    db.deleteArtifact({ id: ID, project: null, at: 10 })
    db.eraseArtifact(ID)
    create(db)
    expect(
      call(db, 'dataGet', { id: ID, project: null, collection: 'todos', docId: 'a' }),
    ).toBeNull()
    expect(call(db, 'consentOf', { id: ID })).toEqual([])
    db.close()
  })

  it('remembers consents per artifact until they are revoked', () => {
    const db = open()
    create(db)
    call(db, 'consentGrant', { id: ID, capability: 'sample', at: 1 })
    call(db, 'consentGrant', { id: ID, capability: 'files', at: 2 })
    call(db, 'consentGrant', { id: ID, capability: 'files', at: 3 })
    expect(call(db, 'consentOf', { id: ID })).toEqual(['files', 'sample'])
    expect(call(db, 'consentRevoke', { id: ID })).toEqual({ changed: true })
    expect(call(db, 'consentOf', { id: ID })).toEqual([])
    expect(call(db, 'consentRevoke', { id: ID })).toEqual({ changed: false })
    expect(
      failure(() => call(db, 'consentGrant', { id: OTHER, capability: 'files', at: 1 })).code,
    ).toBe('not_found')
    db.close()
  })

  it('adds the tables to a database of version 5, whose versions declare nothing', () => {
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
        'INSERT INTO artifact_versions (artifact_id, n, size, pages, author, note, created_at) VALUES (?, 1, 1, 0, NULL, NULL, 1)',
      )
      .run(ID)
    raw.close()
    const db = open(file)
    expect(db.status).toBe('ok')
    expect(call(db, 'declaration', { id: ID, project: null, version: null })).toMatchObject({
      capabilities: [],
      runtime: 1,
    })
    expect(put(db, 'a', { ok: true }).version).toBe(1)
    db.close()
    const check = new DatabaseSync(file)
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(SCHEMA_VERSION)
    check.close()
  })
})
