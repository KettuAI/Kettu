import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPending } from '@shared/artifact-comments'
import { startThreadService } from '../threads/service'
import { ThreadStoreError, type ThreadStore } from '../threads/store'
import { ArtifactStore } from './store'
import { ArtifactTools, type Caller } from './tools'
import { ArtifactTypes } from './types/registry'
import { writeContent } from './types/writes'

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

describe('the pieces an agent holds while its turn writes', () => {
  let turn: object | null
  let held: unknown[]

  beforeEach(() => {
    turn = {}
    held = []
    store = new ArtifactStore({
      threads: threadsAt(dir),
      contentDir: path.join(dir, 'content'),
      log: () => {},
      changed: () => {},
      version: () => {},
      activity: (_, activity) => held.push(activity.sessions.map((s) => s.held ?? [])),
      canvasQuietMs: 60_000,
    })
    tools = new ArtifactTools({ store, sessionTitle: () => 'Session', runningTurn: () => turn })
  })

  /** Ends the turn, which lets go of what it held, and starts the next one. */
  function nextTurn(): void {
    store.stopUsing('s1')
    turn = {}
  }

  const page = (id: string, file: string) => ({
    id,
    canvas: 'c1',
    name: id,
    file,
    x: 0,
    y: 0,
    width: 390,
    height: 844,
    locked: false,
  })

  it("refuses the user's edits of a frame the turn wrote, and lets the rest and comments be", async () => {
    const doc = {
      format: 1,
      canvases: [{ id: 'c1', name: 'Home' }],
      pages: [page('pa', 'a.html'), page('pb', 'b.html')],
      notes: [],
    }
    const id = await create({
      files: [
        { path: 'canvas.json', content: JSON.stringify(doc) },
        { path: 'a.html', content: '<p>a</p>' },
        { path: 'b.html', content: '<p>b</p>' },
      ],
    })
    // A new artifact is the turn's whole.
    expect(store.held(id)).toEqual([{ sessionId: 's1', pieces: [{ kind: 'whole' }] }])
    await expect(
      store.canvases.apply(id, [{ op: 'set', id: 'pa', key: 'x', value: 9 }], 'c', 1),
    ).rejects.toMatchObject({ reason: 'conflict' })
    nextTurn()
    expect(store.held(id)).toEqual([])

    const { error } = await call('update_artifact', {
      id,
      base_version: 1,
      files: [{ path: 'b.html', content: '<p>b2</p>' }],
    })
    expect(error).toBeNull()
    expect(store.held(id)).toEqual([
      { sessionId: 's1', pieces: [{ kind: 'frame', id: 'pb', file: 'b.html' }] },
    ])
    const refused = { reason: 'conflict', state: { version: 2, held: [{ sessionId: 's1' }] } }
    await expect(
      store.editElement({
        id,
        baseVersion: 2,
        path: 'b.html',
        offset: 0,
        change: { style: null, text: 'x' },
      }),
    ).rejects.toMatchObject(refused)
    await expect(
      store.canvases.apply(id, [{ op: 'remove', id: 'pb' }], 'c', 2),
    ).rejects.toMatchObject(refused)
    // Removing the sheet would remove the held frame with it.
    await expect(
      store.canvases.apply(id, [{ op: 'remove', id: 'c1' }], 'c', 3),
    ).rejects.toMatchObject(refused)
    // The frame the turn did not write stays the user's.
    await expect(
      store.canvases.apply(id, [{ op: 'set', id: 'pa', key: 'x', value: 9 }], 'c', 4),
    ).resolves.toMatchObject({ seq: expect.any(Number) })
    const anchor = { version: 2, path: 'b.html', page: null, offset: null, tag: null, text: '' }
    await expect(
      store.addThread(id, {
        anchor: { ...anchor, missing: false },
        author: { person: 'owner', session: null },
        body: 'Nice',
      }),
    ).resolves.toMatchObject({ comments: [{ body: 'Nice' }] })

    nextTurn()
    await expect(
      store.canvases.apply(id, [{ op: 'remove', id: 'pb' }], 'c', 5),
    ).resolves.toMatchObject({ seq: expect.any(Number) })
  })

  it("refuses the user's edits of a section the turn wrote, by what the edit changes", async () => {
    const types = new ArtifactTypes()
    const { value } = await call('create_artifact_from_type', {
      type: 'document',
      title: 'Plan',
      files: [{ path: 'document.md', content: '# Plan\n\nText.\n\n## Risks\n\nNone.\n' }],
    })
    const id = value.id as string
    nextTurn()
    await store.watch(id, 'port')
    const { error } = await call('update_artifact', {
      id,
      base_version: 1,
      files: [{ path: 'document.md', content: '# Plan\n\nText.\n\n## Risks\n\nSome.\n' }],
    })
    expect(error).toBeNull()
    expect(store.held(id)[0]?.pieces).toEqual([{ kind: 'section', slug: 'risks' }])
    expect(held.at(-1)).toEqual([[{ kind: 'section', slug: 'risks' }]])

    await expect(
      writeContent(store, types, {
        id,
        baseVersion: 2,
        text: '# Plan\n\nText.\n\n## Risks\n\nMany.\n',
      }),
    ).rejects.toMatchObject({ reason: 'conflict', english: expect.stringContaining('turn') })
    await expect(
      writeContent(store, types, {
        id,
        baseVersion: 2,
        text: '# Plan\n\nMore text.\n\n## Risks\n\nSome.\n',
      }),
    ).resolves.toEqual({ version: 3 })
  })

  it('holds the slides a turn wrote, one removed from the end included', async () => {
    const types = new ArtifactTypes()
    const deck = (...titles: string[]) =>
      JSON.stringify({ slides: titles.map((title) => ({ layout: 'title', title })) })
    const { value, error } = await call('create_artifact_from_type', {
      type: 'slides',
      title: 'Deck',
      files: [{ path: 'slides.json', content: deck('A', 'B', 'C') }],
    })
    expect(error).toBeNull()
    const id = value.id as string
    nextTurn()
    await call('update_artifact', {
      id,
      base_version: 1,
      files: [{ path: 'slides.json', content: deck('A', 'B', 'C2') }],
    })
    expect(store.held(id)[0]?.pieces).toEqual([{ kind: 'slide', number: 3 }])
    await expect(
      writeContent(store, types, { id, baseVersion: 2, text: deck('A', 'B') }),
    ).rejects.toMatchObject({ reason: 'conflict' })
    await expect(
      writeContent(store, types, { id, baseVersion: 2, text: deck('A2', 'B', 'C2') }),
    ).resolves.toEqual({ version: 3 })
  })
})

describe('pinning a thread again', () => {
  it('keeps the thread with its new anchor, found again from then on', async () => {
    const id = await create({ html: '<h1>Title</h1><p>Body</p>' })
    const anchor = {
      version: 1,
      path: 'index.html',
      page: null,
      offset: null,
      tag: null,
      text: '',
      missing: false,
    }
    const thread = await store.addThread(id, {
      anchor,
      author: { person: 'owner', session: null },
      body: 'Shorter',
    })
    const placed = await store.repin(id, thread.id, {
      ...anchor,
      offset: 0,
      tag: 'h1',
      text: 'Title',
      missing: true,
    })
    expect(placed.anchor).toMatchObject({ offset: 0, tag: 'h1', missing: false })
    const [kept] = await store.threads(id)
    expect(kept).toMatchObject({ id: thread.id, anchor: { offset: 0, tag: 'h1', missing: false } })
    expect(kept?.comments).toHaveLength(1)
    await expect(store.repin(id, 'thr_01J9Z3K4V5W6X7Y8Z9A0B1C2D3', anchor)).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('a thread whose element a version removed', () => {
  it('is looked for again in each new version, and placed once the element is back', async () => {
    const id = await create({ html: '<h1>Title</h1><p>Body</p>' })
    const thread = await store.addThread(id, {
      anchor: {
        version: 1,
        path: 'index.html',
        page: null,
        offset: 14,
        tag: 'p',
        text: 'Body',
        missing: false,
      },
      author: { person: 'owner', session: null },
      body: 'Shorter',
    })
    await call('update_artifact', { id, base_version: 1, html: '<h1>Title</h1>' })
    const [gone] = await store.threads(id)
    expect(gone?.anchor).toMatchObject({ version: 2, missing: true })

    // A version that still lacks the element is recorded once, not on every read.
    await call('update_artifact', { id, base_version: 2, html: '<h1>Other</h1>' })
    await store.threads(id)
    const calls: string[] = []
    const threads = (store as unknown as { deps: { threads: ThreadStore } }).deps.threads
    const artifact = threads.artifact
    threads.artifact = ((name: string, params: unknown) => {
      calls.push(name)
      return artifact(name as never, params as never)
    }) as ThreadStore['artifact']
    const [still] = await store.threads(id)
    expect(still?.anchor).toMatchObject({ version: 3, missing: true })
    expect(calls).not.toContain('reanchor')

    await store.restore({ id, version: 1, baseVersion: 3, author: null })
    const [back] = await store.threads(id)
    expect(back).toMatchObject({
      id: thread.id,
      anchor: { version: 4, offset: 14, tag: 'p', text: 'Body', missing: false },
    })
    const [stored] = await store.threads(id)
    expect(stored?.anchor).toMatchObject({ version: 4, offset: 14, missing: false })
  })
})

describe('a thread in a frame the canvas no longer lists', () => {
  it('is marked removed though the file stays, and placed once the frame is back', async () => {
    const page = (id: string, file: string) => ({
      id,
      canvas: 'c1',
      name: id,
      file,
      x: 0,
      y: 0,
      width: 390,
      height: 844,
      locked: false,
    })
    const doc = {
      format: 1,
      canvases: [{ id: 'c1', name: 'Home' }],
      pages: [page('pa', 'a.html'), page('pb', 'b.html')],
      notes: [],
    }
    const id = await create({
      files: [
        { path: 'canvas.json', content: JSON.stringify(doc) },
        { path: 'a.html', content: '<p>a</p>' },
        { path: 'b.html', content: '<h1>B</h1><p>Body</p>' },
      ],
    })
    const anchor = { version: 1, page: null, missing: false }
    const author = { person: 'owner' as const, session: null }
    const inB = await store.addThread(id, {
      anchor: { ...anchor, path: 'b.html', offset: 10, tag: 'p', text: 'Body' },
      author,
      body: 'Shorter',
    })
    const inA = await store.addThread(id, {
      anchor: { ...anchor, path: 'a.html', offset: 0, tag: 'p', text: 'a' },
      author,
      body: 'Longer',
    })
    const removed = await call('update_artifact', {
      id,
      base_version: 1,
      canvas: [{ op: 'remove', id: 'pb' }],
    })
    expect(removed.error).toBeNull()
    const found = await store.get(id)
    expect(found.files.map((f) => f.path)).toContain('b.html')

    const gone = await store.threads(id)
    expect(gone.find((t) => t.id === inB.id)?.anchor).toMatchObject({ version: 2, missing: true })
    expect(gone.find((t) => t.id === inA.id)?.anchor).toMatchObject({
      version: 2,
      offset: 0,
      missing: false,
    })

    await store.restore({ id, version: 1, baseVersion: 2, author: null })
    const back = await store.threads(id)
    expect(back.find((t) => t.id === inB.id)?.anchor).toMatchObject({
      version: 3,
      offset: 10,
      missing: false,
    })
  })
})

describe('reopening a resolved thread', () => {
  it('clears sent metadata so it is pending again even when its original element is gone', async () => {
    const id = await create({ html: '<h1>Title</h1><p>Body</p>' })
    const thread = await store.addThread(id, {
      anchor: {
        version: 1,
        path: 'index.html',
        page: null,
        offset: 14,
        tag: 'p',
        text: 'Body',
        missing: false,
      },
      author: { person: 'owner', session: null },
      body: 'Tighten this paragraph',
    })
    await store.markSent(id, [thread.id], caller.sessionId)
    expect(
      (await call('reply_comment', { id, thread: thread.id, text: 'Updated' })).error,
    ).toBeNull()
    expect((await call('resolve_comment', { id, thread: thread.id })).error).toBeNull()

    // An HTML edit removes the original paragraph so the anchor becomes missing.
    await call('update_artifact', { id, base_version: 1, html: '<h1>Title</h1>' })
    const [resolvedGone] = await store.threads(id)
    expect(resolvedGone).toMatchObject({
      id: thread.id,
      anchor: { version: 2, missing: true },
      sentTo: caller.sessionId,
    })
    expect(resolvedGone?.resolvedAt).not.toBeNull()
    expect(resolvedGone?.sentAt).not.toBeNull()
    expect(isPending(resolvedGone!)).toBe(false)

    // Reopening clears sentAt and sentTo so the user can send it again immediately.
    const reopened = await store.resolve(id, thread.id, false)
    expect(reopened).toMatchObject({
      id: thread.id,
      resolvedAt: null,
      sentAt: null,
      sentTo: null,
      anchor: { version: 2, missing: true },
    })
    expect(isPending(reopened)).toBe(true)

    const [stored] = await store.threads(id)
    expect(stored).toMatchObject({ resolvedAt: null, sentAt: null, sentTo: null })
    expect(isPending(stored!)).toBe(true)
  })
})
