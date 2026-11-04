import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startThreadService } from '../threads/service'
import { ThreadStoreError, type ThreadStore } from '../threads/store'
import { ArtifactStore } from './store'
import { ArtifactTools, type Caller } from './tools'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

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
  return {
    artifact: (name: string, params: unknown) =>
      new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, { resolve, reject })
        handle({ id, op: 'artifact', call: { name, params } as never })
      }),
  } as unknown as ThreadStore
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-artifact-tools-'))
  work = path.join(dir, 'work')
  mkdirSync(path.join(work, 'assets'), { recursive: true })
  writeFileSync(path.join(work, 'assets', 'logo.png'), PNG)
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
  it('make an artifact of several files, inline and read from the working directory', async () => {
    const html = '<link rel="stylesheet" href="styles/app.css"><img src="assets/logo.png">'
    const id = await create({
      html,
      files: [
        { path: 'styles/app.css', content: 'img{width:10px}' },
        { path: 'assets/logo.png', source: 'assets/logo.png' },
        { path: 'app.js', source: path.join(work, 'app.js') },
      ],
    })
    const { value } = await call('read_artifact', { id })
    expect(value.files).toEqual([
      { path: 'app.js', size: 14, type: 'text/javascript; charset=utf-8' },
      { path: 'assets/logo.png', size: PNG.length, type: 'image/png' },
      { path: 'index.html', size: html.length, type: 'text/html; charset=utf-8' },
      { path: 'styles/app.css', size: 15, type: 'text/css; charset=utf-8' },
    ])
    expect(value.text).toContain('styles/app.css')
    const image = await call('read_artifact', { id, path: 'assets/logo.png' })
    expect(image.value.text).toBeNull()
    const css = await call('read_artifact', { id, path: 'styles/app.css' })
    expect(css.value.text).toBe('img{width:10px}')
  })

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

  it('refuse an artifact without index.html, or with two paths that differ only in case', async () => {
    const without = await call('create_artifact', {
      title: 'Report',
      files: [{ path: 'page.html', content: '<p>hi</p>' }],
    })
    expect(without.error?.code).toBe('invalid')
    const clash = await call('create_artifact', {
      title: 'Report',
      html: '<p>hi</p>',
      files: [
        { path: 'Logo.svg', content: '<svg/>' },
        { path: 'logo.svg', content: '<svg/>' },
      ],
    })
    expect(clash.error?.message).toContain('differ only in case')
    expect(await count()).toBe(0)
  })

  it('refuse an HTML file that is not UTF-8, and a file over the inline limit', async () => {
    writeFileSync(path.join(work, 'latin1.html'), Buffer.from([0x3c, 0x70, 0x3e, 0xe9]))
    const latin = await call('create_artifact', {
      title: 'Report',
      files: [{ path: 'index.html', source: 'latin1.html' }],
    })
    expect(latin.error?.message).toContain('UTF-8')
    const large = await call('create_artifact', {
      title: 'Report',
      html: 'x'.repeat(5 * 1024 * 1024 + 1),
    })
    expect(large.error?.code).toBe('too_large')
    expect(await count()).toBe(0)
  })

  it('update the files named and keep the rest, with edits on the text the files left', async () => {
    const id = await create({
      html: '<link href="a.css">',
      files: [
        { path: 'a.css', content: 'p{color:red}' },
        { path: 'old.js', content: '1' },
        { path: 'logo.png', source: 'assets/logo.png' },
      ],
    })
    const { error, value } = await call('update_artifact', {
      id,
      base_version: 1,
      files: [
        { path: 'old.js', remove: true },
        { path: 'b.css', content: 'p{margin:0}' },
      ],
      edits: [
        { old_text: 'a.css', new_text: 'b.css' },
        { path: 'b.css', old_text: 'margin:0', new_text: 'margin:1px' },
      ],
    })
    expect(error).toBeNull()
    expect(value.version).toBe(2)
    const read = await call('read_artifact', { id })
    expect((read.value.files as { path: string }[]).map((f) => f.path)).toEqual([
      'a.css',
      'b.css',
      'index.html',
      'logo.png',
    ])
    expect(read.value.text).toBe('<link href="b.css">')
    const b = await call('read_artifact', { id, path: 'b.css' })
    expect(b.value.text).toBe('p{margin:1px}')
    const before = await call('read_artifact', { id, version: 1, path: 'old.js' })
    expect(before.value.text).toBe('1')
  })

  it('change nothing when one part of an update fails', async () => {
    const id = await create({ html: '<p>one</p>', files: [{ path: 'a.css', content: 'p{}' }] })
    const failures = [
      { files: [{ path: 'b.css', content: 'x' }], edits: [{ old_text: 'two', new_text: '2' }] },
      { files: [{ path: 'index.html', remove: true }] },
      { files: [{ path: 'gone.css', remove: true }] },
      { files: [{ path: 'x.png', source: '../secret.txt' }] },
      { edits: [{ path: 'missing.css', old_text: 'p', new_text: 'q' }] },
    ]
    for (const change of failures) {
      const { error } = await call('update_artifact', { id, base_version: 1, ...change })
      expect(error).not.toBeNull()
    }
    const { value } = await call('read_artifact', { id })
    expect(value.head).toBe(1)
    const stale = await call('update_artifact', { id, base_version: 2, html: '<p>two</p>' })
    expect(stale.error?.code).toBe('conflict')
  })

  it('read a long text in parts', async () => {
    const id = await create({ html: 'abcdefghij' })
    const first = await call('read_artifact', { id, limit: 4 })
    expect(first.value).toMatchObject({ text: 'abcd', offset: 0, next_offset: 4 })
    const last = await call('read_artifact', { id, offset: 8, limit: 4 })
    expect(last.value).toMatchObject({ text: 'ij', offset: 8, next_offset: null })
    const missing = await call('read_artifact', { id, path: 'nope.css' })
    expect(missing.error?.code).toBe('not_found')
  })
})
