import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startThreadService } from '../threads/service'
import { ThreadStoreError, type ThreadStore } from '../threads/store'
import { ArtifactStore } from './store'
import { ArtifactTools, type Caller } from './tools'

let dir: string
let work: string
let tools: ArtifactTools
let store: ArtifactStore
let caller: Caller

/** The thread service in this thread, answering as the worker would. */
function threadsAt(folder: string): ThreadStore {
  const pending = new Map<number, { resolve(value: unknown): void; reject(e: unknown): void }>()
  let next = 0
  const handle = startThreadService(
    { file: path.join(folder, 'threads.db'), contentDir: path.join(folder, 'content') },
    (reply) => {
      if (reply.type !== 'result' && reply.type !== 'error') return
      const waiting = pending.get(reply.id)
      pending.delete(reply.id)
      if (reply.type === 'result') waiting?.resolve(reply.value)
      else waiting?.reject(new ThreadStoreError(reply.message, reply.code, reply.data))
    },
  )
  const ask =
    (op: 'artifact' | 'runtime') =>
    (name: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, { resolve, reject })
        handle({ id, op, call: { name, params } as never })
      })
  return { artifact: ask('artifact'), runtime: ask('runtime') } as unknown as ThreadStore
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-artifact-tools-'))
  work = path.join(dir, 'work')
  mkdirSync(path.join(work, 'assets'), { recursive: true })
  writeFileSync(path.join(work, 'app.js'), 'console.log(1)')
  writeFileSync(path.join(dir, 'secret.txt'), 'secret')
  store = new ArtifactStore({
    threads: threadsAt(dir),
    contentDir: path.join(dir, 'content'),
    log: () => {},
    changed: () => {},
    version: () => {},
    activity: () => {},
  })
  tools = new ArtifactTools({ store, sessionTitle: () => 'Session', runningTurn: () => null })
  caller = { sessionId: 's1', project: work }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function call(name: string, input: unknown) {
  const result = await tools.call(caller, name, input)
  return {
    error: result.isError ? (result.structuredContent as { code: string; message: string }) : null,
    value: result.structuredContent as Record<string, unknown>,
  }
}

async function create(input: Record<string, unknown>): Promise<string> {
  const { error, value } = await call('create_artifact', { title: 'Report', ...input })
  expect(error).toBeNull()
  return value.id as string
}

async function count(): Promise<number> {
  return (await store.list({ project: work })).length
}

describe('the artifact tools', () => {
  it.each([
    ['a path out of it', '../secret.txt'],
    ['an absolute path out of it', '__SECRET__'],
    ['a link inside that points out', 'leak.txt'],
    ['a folder', 'assets'],
    ['a file that is not there', 'missing.png'],
  ])('refuse a source that is %s, and make nothing', async (_, source) => {
    symlinkSync(path.join(dir, 'secret.txt'), path.join(work, 'leak.txt'))
    const given = source === '__SECRET__' ? path.join(dir, 'secret.txt') : source
    const { error } = await call('create_artifact', {
      title: 'Report',
      files: [
        { path: 'index.html', content: '<p>hi</p>' },
        { path: 'data.txt', source: given },
      ],
    })
    expect(error?.code).toBe('invalid')
    expect(await count()).toBe(0)
  })

  it('take a link inside the working directory that stays inside it', async () => {
    symlinkSync(path.join(work, 'app.js'), path.join(work, 'alias.js'))
    const id = await create({ html: '<p>hi</p>', files: [{ path: 'a.js', source: 'alias.js' }] })
    const { value } = await call('read_artifact', { id, path: 'a.js' })
    expect(value.text).toBe('console.log(1)')
  })

  it.each([
    ['_kettu/runtime.js', 'Kettu keeps'],
    ['_kettuish.css', 'Kettu keeps'],
    ['/abs.css', 'relative'],
    ['a/../b.css', '..'],
    ['a\\b.css', 'backslash'],
    ['a//b.css', 'empty segment'],
    ['what?.css', 'backslash'],
  ])('refuse the path %s', async (bad, says) => {
    const { error } = await call('create_artifact', {
      title: 'Report',
      files: [
        { path: 'index.html', content: '<p>hi</p>' },
        { path: bad, content: 'x' },
      ],
    })
    expect(error?.code).toBe('invalid')
    expect(error?.message).toContain(says)
    expect(await count()).toBe(0)
  })
})

describe("the host's records of an artifact", () => {
  it('compares any two of its versions from their stored files', async () => {
    const id = await create({ html: '<p>1</p>', files: [{ path: 'a.css', content: 'a' }] })
    for (const [base, html] of [
      [1, '<p>2</p>'],
      [2, '<p>3</p>'],
    ] as const) {
      const { error } = await call('update_artifact', { id, base_version: base, html })
      expect(error).toBeNull()
    }
    expect(await store.changes(id, 1, 3)).toEqual({ kind: 'files', paths: ['index.html'] })
    expect(await store.changes(id, 3, 1)).toEqual({ kind: 'files', paths: ['index.html'] })
    await expect(store.changes(id, 1, 9)).rejects.toMatchObject({ reason: 'not_found' })
    // Another project's session reaches none of it.
    await expect(store.changes(id, 1, 2, { project: '/elsewhere' })).rejects.toMatchObject({
      reason: 'not_found',
    })
  })
})

describe('the links in the artifact tools results', () => {
  const page = (id: string, file: string, x: number) => ({
    id,
    canvas: 'c1',
    name: id.toUpperCase(),
    file,
    x,
    y: 0,
    width: 390,
    height: 844,
    locked: false,
  })

  it('name every frame on create and read, and the frames a version changed on update', async () => {
    const doc = {
      format: 1,
      canvases: [{ id: 'c1', name: 'Home' }],
      pages: [page('pa', 'a.html', 0), page('pb', 'b.html', 500)],
      notes: [],
    }
    const { error, value } = await call('create_artifact', {
      title: 'App',
      files: [
        { path: 'canvas.json', content: JSON.stringify(doc) },
        { path: 'a.html', content: '<p>a</p>' },
        { path: 'b.html', content: '<p>b</p>' },
      ],
    })
    expect(error).toBeNull()
    const id = value.id as string
    expect(value.link).toBe(`kettu://artifact/${id}`)
    expect(value.places).toEqual([
      { kind: 'frame', name: 'Home · PA', link: `kettu://artifact/${id}/frame/pa` },
      { kind: 'frame', name: 'Home · PB', link: `kettu://artifact/${id}/frame/pb` },
    ])
    expect(value.places_more).toBe(0)
    expect((await call('read_artifact', { id })).value.places).toHaveLength(2)
    const updated = await call('update_artifact', {
      id,
      base_version: 1,
      files: [{ path: 'b.html', content: '<p>b2</p>' }],
    })
    expect(updated.value.places).toEqual([
      { kind: 'frame', name: 'Home · PB', link: `kettu://artifact/${id}/frame/pb` },
    ])
  })

  it("name a document's sections", async () => {
    const { value } = await call('create_artifact_from_type', {
      type: 'document',
      title: 'Plan',
      files: [{ path: 'document.md', content: '# Plan\n\nText.\n\n## Risks\n\nNone.\n' }],
    })
    const id = value.id as string
    expect(value.places).toEqual([
      { kind: 'section', name: 'Plan', link: `kettu://artifact/${id}/section/plan` },
      { kind: 'section', name: 'Risks', link: `kettu://artifact/${id}/section/risks` },
    ])
  })
})
