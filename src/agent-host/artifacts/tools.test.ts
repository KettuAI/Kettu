import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { ARTIFACT_KEEP_DELETED_MS } from '@shared/artifacts'
import { inThreadWorker } from '../testing/thread-worker'
import { ThreadStore } from '../threads/store'
import { ArtifactStore, type ArtifactActivity } from './store'
import {
  applyEdits,
  ArtifactTools,
  HTML_BYTES,
  TOOLS,
  WRITES_PER_MINUTE,
  type Caller,
} from './tools'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const A: Caller = { sessionId: 'session-a', project: '/projects/a' }
const B: Caller = { sessionId: 'session-b', project: '/projects/b' }
const MISSING = 'art_00000000000000000000000000'
const CANVAS =
  '<body><section data-page="One" data-page-size="390x844">1</section>' +
  '<section data-page="Two">2</section></body>'

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-artifact-tools-'))
  const contentDir = path.join(dir, 'artifacts', 'content')
  const log = (): void => {}
  const threads = new ThreadStore({
    file: path.join(dir, 'state', 'threads.db'),
    contentDir,
    createWorker: inThreadWorker,
    log,
  })
  const clock = { now: Date.UTC(2026, 9, 23, 12) }
  const events = { changed: 0, activity: [] as ArtifactActivity[] }
  const store = new ArtifactStore({
    threads,
    contentDir,
    log,
    now: () => clock.now,
    changed: () => events.changed++,
    version: () => {},
    activity: (_ports, activity) => events.activity.push(activity),
  })
  const titles = new Map<string, string | null>([
    [A.sessionId, 'Design the sign-in'],
    [B.sessionId, null],
  ])
  const running = new Set<string>()
  const tools = new ArtifactTools({
    store,
    sessionTitle: (sessionId) => titles.get(sessionId),
    turnRunning: (sessionId) => running.has(sessionId),
    now: () => clock.now,
  })
  cleanups.push(async () => {
    await threads.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const call = async (caller: Caller, name: string, args: unknown) => {
    const result = await tools.call(caller, name, args)
    return {
      result,
      text: (result.content[0] as { text: string }).text,
      value: result.structuredContent as Record<string, unknown>,
    }
  }
  const create = async (caller = A, args: Record<string, unknown> = {}) => {
    const { value } = await call(caller, 'create_artifact', {
      title: 'Sign in',
      html: '<p>v1</p>',
      ...args,
    })
    return value.id as string
  }
  return { store, tools, call, create, clock, events, titles, running }
}

function refused(result: CallToolResult, code: string): void {
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toEqual({ code })
}

describe('the artifacts tools', () => {
  it('declare their schemas and annotations, every error code included in the output', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      'create_artifact',
      'read_artifact',
      'update_artifact',
      'list_artifacts',
      'delete_artifact',
      'list_artifact_versions',
      'restore_artifact_version',
    ])
    const readOnly = TOOLS.filter((tool) => tool.annotations?.readOnlyHint).map((t) => t.name)
    expect(readOnly).toEqual(['read_artifact', 'list_artifacts', 'list_artifact_versions'])
    const destructive = TOOLS.filter((tool) => tool.annotations?.destructiveHint)
    expect(destructive.map((tool) => tool.name)).toEqual(['delete_artifact'])
    for (const tool of TOOLS) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(tool.outputSchema).toMatchObject({ type: 'object' })
      expect(tool.annotations?.openWorldHint).toBe(false)
    }
    expect(TOOLS[0]!.description).toContain('data-page-size')
  })

  it('create an artifact in the session project, counting its pages', async () => {
    const { call, store } = setup()
    const { result, text, value } = await call(A, 'create_artifact', {
      title: 'Sign in options',
      html: CANVAS,
      note: 'First draft',
    })
    expect(result.isError).toBeUndefined()
    expect(value).toEqual({ id: expect.stringMatching(/^art_/), version: 1, pages: 2 })
    expect(text).toBe(`Created ${String(value.id)} version 1, a canvas of 2 pages.`)
    const read = await store.read(String(value.id))
    expect(read.artifact).toMatchObject({ project: A.project, sessionId: A.sessionId })
    expect(read.version).toMatchObject({ pages: 2, note: 'First draft', author: A.sessionId })

    const single = await call(A, 'create_artifact', { title: 'Report', html: '<p>hi</p>' })
    expect(single.text).toMatch(/version 1, a single page\.$/)
  })

  it('refuse arguments outside the schemas', async () => {
    const { call, create } = setup()
    const cases: [string, unknown][] = [
      ['create_artifact', { html: '<p></p>' }],
      ['create_artifact', { title: '', html: '<p></p>' }],
      ['create_artifact', { title: '   ', html: '<p></p>' }],
      ['create_artifact', { title: 'x'.repeat(121), html: '<p></p>' }],
      ['create_artifact', { title: 'T', html: '<p></p>', note: 'n'.repeat(201) }],
      ['create_artifact', { title: 'T', html: 42 }],
      ['create_artifact', { title: 'T', html: '<p></p>', base_version: 1 }],
      ['create_artifact', ['not', 'an', 'object']],
      ['read_artifact', { id: 'art_lowercase' }],
      ['read_artifact', { id: MISSING, version: 0 }],
      ['read_artifact', { id: MISSING, version: 1.5 }],
      ['list_artifacts', { limit: 0 }],
      ['list_artifacts', { limit: 201 }],
      ['list_artifacts', { query: 'q'.repeat(201) }],
      ['restore_artifact_version', { id: MISSING, version: 1 }],
    ]
    for (const [name, args] of cases) refused((await call(A, name, args)).result, 'invalid')
    const id = await create()
    const updates: unknown[] = [
      { id },
      { id, base_version: 1, html: '<p></p>', edits: [{ old_text: 'a', new_text: 'b' }] },
      { id, base_version: 1, html: '<p></p>', title: 'Both' },
      { id, html: '<p>no base</p>' },
      { id, base_version: 1, edits: [] },
      { id, base_version: 1, edits: [{ old_text: '', new_text: 'x' }] },
      { id, base_version: 1, edits: [{ old_text: 'v1', new_text: 'x', extra: 1 }] },
      { id, base_version: 1, edits: [{ old_text: 'v1' }] },
      {
        id,
        base_version: 1,
        edits: Array.from({ length: 51 }, () => ({ old_text: 'v1', new_text: 'v1' })),
      },
    ]
    for (const args of updates) {
      const { result, text } = await call(A, 'update_artifact', args)
      refused(result, 'invalid')
      expect(text.length).toBeGreaterThan(0)
    }
  })

  it('keep the HTML within 5 MiB of UTF-8', async () => {
    const { call, create } = setup()
    const big = 'é'.repeat(HTML_BYTES / 2 + 1)
    const { result, text } = await call(A, 'create_artifact', { title: 'Big', html: big })
    refused(result, 'too_large')
    expect(text).toBe(
      'The HTML is 5.0 MiB; an artifact holds at most 5 MiB. Move images to a CDN or shrink them.',
    )
    const exact = await call(A, 'create_artifact', { title: 'Full', html: 'x'.repeat(HTML_BYTES) })
    expect(exact.result.isError).toBeUndefined()

    const id = await create(A, { html: 'x'.repeat(HTML_BYTES - 10) + 'MARK' })
    const grown = await call(A, 'update_artifact', {
      id,
      base_version: 1,
      edits: [{ old_text: 'MARK', new_text: 'y'.repeat(4 * 1024 * 1024) }],
    })
    refused(grown.result, 'too_large')
    expect(grown.text).toMatch(/^The HTML is 9\.0 MiB/)
  })

  it('read the latest version or the one asked for', async () => {
    const { call, create, clock } = setup()
    const id = await create(A, { html: CANVAS })
    clock.now += 60_000
    await call(A, 'update_artifact', { id, base_version: 1, html: '<p>two</p>' })
    const latest = await call(A, 'read_artifact', { id })
    expect(latest.value).toEqual({
      id,
      title: 'Sign in',
      version: 2,
      head: 2,
      pages: 0,
      updated_at: new Date(clock.now).toISOString(),
      html: '<p>two</p>',
    })
    expect(latest.text).toBe(`${id}, "Sign in", version 2 of 2, a single page.`)
    const first = await call(A, 'read_artifact', { id, version: 1 })
    expect(first.value).toMatchObject({ version: 1, head: 2, pages: 2, html: CANVAS })

    const missing = await call(A, 'read_artifact', { id, version: 9 })
    refused(missing.result, 'not_found')
    expect(missing.text).toBe(
      `${id} has no version 9; its latest is 2. list_artifact_versions shows them.`,
    )
  })

  it('reach only the session project: another project has no such artifact', async () => {
    const { call, create, store } = setup()
    const id = await create(A)
    const text = `No artifact ${id} in this project. list_artifacts shows the ones you can use.`
    for (const [name, args] of [
      ['read_artifact', { id }],
      ['read_artifact', { id, version: 1 }],
      ['update_artifact', { id, base_version: 1, html: '<p>B</p>' }],
      ['update_artifact', { id, title: 'Taken' }],
      ['delete_artifact', { id }],
      ['list_artifact_versions', { id }],
      ['restore_artifact_version', { id, version: 1, base_version: 1 }],
    ] as const) {
      const { result, text: said } = await call(B, name, args)
      refused(result, 'not_found')
      expect(said).toBe(text)
    }
    expect((await call(B, 'list_artifacts', {})).value).toEqual({ artifacts: [] })
    expect((await store.read(id)).artifact).toMatchObject({ title: 'Sign in', head: 1 })
  })

  it('update from the latest version only, so no change is lost', async () => {
    const { call, create, store } = setup()
    const id = await create()
    const first = await call(A, 'update_artifact', {
      id,
      base_version: 1,
      html: CANVAS,
      note: 'Two pages',
    })
    expect(first.value).toEqual({ id, version: 2, pages: 2 })
    expect(first.text).toBe(`Updated ${id} to version 2, a canvas of 2 pages.`)
    for (const args of [
      { id, base_version: 1, html: '<p>stale</p>' },
      { id, base_version: 1, edits: [{ old_text: 'One', new_text: 'Uno' }] },
      { id, version: 1, base_version: 1 },
    ]) {
      const name = 'version' in args ? 'restore_artifact_version' : 'update_artifact'
      const { result, text } = await call(A, name, args)
      refused(result, 'conflict')
      expect(text).toBe(`${id} is at version 2. Read it again and apply your change to version 2.`)
    }
    expect((await store.read(id)).version.version).toBe(2)
  })

  it('apply edits in order, each to exactly one place, or none of them', async () => {
    const { call, create, store } = setup()
    const id = await create(A, { html: '<h1>Title</h1><p>one</p><p>two</p><p>one</p>' })
    const done = await call(A, 'update_artifact', {
      id,
      base_version: 1,
      edits: [
        { old_text: '<h1>Title</h1>', new_text: '<h1>New</h1><p>three</p>' },
        { old_text: '<p>three</p>', new_text: '<p>3</p>' },
      ],
    })
    expect(done.value).toEqual({ id, version: 2, pages: 0 })
    expect((await store.read(id)).html).toBe('<h1>New</h1><p>3</p><p>one</p><p>two</p><p>one</p>')

    const twice = await call(A, 'update_artifact', {
      id,
      base_version: 2,
      edits: [
        { old_text: '<p>two</p>', new_text: '<p>2</p>' },
        { old_text: '<p>one</p>', new_text: '<p>1</p>' },
      ],
    })
    refused(twice.result, 'edit_not_found')
    expect(twice.text).toBe(
      'Edit 2: old_text occurs 2 times. Include more of the surrounding text.',
    )

    const gone = await call(A, 'update_artifact', {
      id,
      base_version: 2,
      edits: [
        { old_text: '<p>two</p>', new_text: '<p>2</p>' },
        { old_text: '<p>two</p>', new_text: '<p>again</p>' },
      ],
    })
    refused(gone.result, 'edit_not_found')
    expect(gone.text).toBe(
      'Edit 2: old_text does not occur in the HTML as the edits before it left it. ' +
        'Read the artifact again and copy the text exactly.',
    )
    expect((await store.read(id)).version.version).toBe(2)
  })

  it('count overlapping and repeated occurrences of an edit', () => {
    expect(() => applyEdits('aaa', [{ oldText: 'aa', newText: 'b' }])).toThrow(/occurs 2 times/)
    expect(() => applyEdits('x x x', [{ oldText: 'x', newText: 'y' }])).toThrow(/occurs 3 times/)
    expect(applyEdits('$1 and $&', [{ oldText: '$1', newText: '$&$`' }])).toBe('$&$` and $&')
  })

  it('rename with a title alone, which makes no version', async () => {
    const { call, create, store } = setup()
    const id = await create(A, { html: CANVAS })
    const renamed = await call(A, 'update_artifact', { id, title: 'Sign in, final' })
    expect(renamed.value).toEqual({ id, version: 1, pages: 2 })
    expect(renamed.text).toBe(`Renamed ${id} to "Sign in, final"; it stays at version 1.`)
    const read = await store.read(id)
    expect(read.artifact).toMatchObject({ title: 'Sign in, final', head: 1 })
    refused((await call(A, 'update_artifact', { id, title: ' ' })).result, 'invalid')
  })

  it('list the project newest first, by title, without Recently deleted', async () => {
    const { call, create, clock } = setup()
    const first = await create(A, { title: 'Café menu' })
    clock.now += 1000
    const second = await create(A, { title: 'Dashboard', html: CANVAS })
    clock.now += 1000
    const third = await create(A, { title: 'Old report' })
    await create(B, { title: 'Café elsewhere' })
    await call(A, 'delete_artifact', { id: third })

    const all = await call(A, 'list_artifacts', {})
    expect(all.value).toEqual({
      artifacts: [
        {
          id: second,
          title: 'Dashboard',
          version: 1,
          pages: 2,
          updated_at: new Date(clock.now - 1000).toISOString(),
          session: 'Design the sign-in',
        },
        {
          id: first,
          title: 'Café menu',
          version: 1,
          pages: 0,
          updated_at: new Date(clock.now - 2000).toISOString(),
          session: 'Design the sign-in',
        },
      ],
    })
    expect(all.text).toBe('2 artifacts, newest first.')
    const cafe = await call(A, 'list_artifacts', { query: 'CAFE' })
    expect((cafe.value.artifacts as { id: string }[]).map((a) => a.id)).toEqual([first])
    const limited = await call(A, 'list_artifacts', { limit: 1 })
    expect((limited.value.artifacts as { id: string }[]).map((a) => a.id)).toEqual([second])
    expect(limited.text).toBe('2 artifacts; the newest 1 are listed.')
    const none = await call(A, 'list_artifacts', { query: 'nothing' })
    expect(none.text).toBe('No artifact title in this project matches "nothing".')
  })

  it('list 50 by default and 200 at most', async () => {
    const { call, create } = setup()
    for (let i = 0; i < 51; i++) await create(B, { title: `Page ${i}` })
    const listed = await call(B, 'list_artifacts', {})
    expect((listed.value.artifacts as unknown[]).length).toBe(50)
    const more = await call(B, 'list_artifacts', { limit: 200 })
    expect((more.value.artifacts as unknown[]).length).toBe(51)
  })

  it('name the session or the user, and a session OverBench no longer has', async () => {
    const { call, create, store, titles } = setup()
    const id = await create(B)
    await store.write({ id, baseVersion: 1, html: '<p>u</p>', pages: 0, author: null, note: 'Me' })
    await call(B, 'restore_artifact_version', { id, version: 1, base_version: 2 })
    expect((await call(B, 'list_artifacts', {})).value).toMatchObject({
      artifacts: [{ session: 'Untitled session' }],
    })
    titles.delete(B.sessionId)
    const versions = await call(B, 'list_artifact_versions', { id })
    expect(versions.value).toEqual({
      versions: [
        expect.objectContaining({ version: 3, author: 'Deleted session', note: null }),
        expect.objectContaining({ version: 2, author: 'user', note: 'Me', size: 8 }),
        expect.objectContaining({ version: 1, author: 'Deleted session', size: 9 }),
      ],
    })
    expect(versions.text).toBe(`${id} has 3 versions, newest first.`)
  })

  it('delete to Recently deleted, which ends what a session can do with it', async () => {
    const { call, create, clock } = setup()
    const id = await create()
    const deleted = await call(A, 'delete_artifact', { id })
    const purgeAt = new Date(clock.now + ARTIFACT_KEEP_DELETED_MS).toISOString()
    expect(deleted.value).toEqual({ id, purge_at: purgeAt })
    expect(deleted.text).toBe(
      `Moved ${id} to Recently deleted; the user can restore it until ${purgeAt}.`,
    )
    clock.now += 5000
    expect((await call(A, 'delete_artifact', { id })).value).toEqual({ id, purge_at: purgeAt })
    const text = `${id} was deleted. The user can restore it in OverBench.`
    for (const [name, args] of [
      ['read_artifact', { id }],
      ['update_artifact', { id, base_version: 1, html: '<p></p>' }],
      ['update_artifact', { id, title: 'Back' }],
      ['list_artifact_versions', { id }],
      ['restore_artifact_version', { id, version: 1, base_version: 1 }],
    ] as const) {
      const result = await call(A, name, args)
      refused(result.result, 'deleted')
      expect(result.text).toBe(text)
    }
    refused((await call(A, 'read_artifact', { id: MISSING })).result, 'not_found')
  })

  it('restore an earlier version as the newest', async () => {
    const { call, create, store } = setup()
    const id = await create(A, { html: CANVAS })
    await call(A, 'update_artifact', { id, base_version: 1, html: '<p>two</p>' })
    const restored = await call(A, 'restore_artifact_version', { id, version: 1, base_version: 2 })
    expect(restored.value).toEqual({ id, version: 3 })
    expect(restored.text).toBe(`Restored version 1 of ${id} as version 3.`)
    const read = await store.read(id)
    expect(read).toMatchObject({ html: CANVAS, version: { pages: 2, author: A.sessionId } })
    const missing = await call(A, 'restore_artifact_version', { id, version: 7, base_version: 3 })
    refused(missing.result, 'not_found')
    expect(missing.text).toMatch(/has no version 7; its latest is 3/)
  })

  it('take 60 writes a minute from each session', async () => {
    const { call, create, clock } = setup()
    const id = await create(A)
    for (let i = 1; i < WRITES_PER_MINUTE; i++) {
      clock.now += 100
      const { result } = await call(A, 'update_artifact', { id, title: `Name ${i}` })
      expect(result.isError).toBeUndefined()
    }
    clock.now += 100
    const limited = await call(A, 'update_artifact', { id, base_version: 1, html: '<p>x</p>' })
    refused(limited.result, 'rate_limited')
    expect(limited.text).toBe('Too many changes in a minute. Wait 54 s.')
    refused((await call(A, 'delete_artifact', { id })).result, 'rate_limited')
    // Reading is not writing, and another session has a minute of its own.
    expect((await call(A, 'read_artifact', { id })).result.isError).toBeUndefined()
    expect((await call(B, 'list_artifacts', {})).result.isError).toBeUndefined()
    await create(B)
    clock.now += 54_000
    const later = await call(A, 'update_artifact', { id, base_version: 1, html: '<p>x</p>' })
    expect(later.value).toEqual({ id, version: 2, pages: 0 })
  })

  it('count what a running turn writes as editing, until the turn ends', async () => {
    const { call, create, store, running, events } = setup()
    const idle = await create(A)
    expect((await store.list({ project: A.project }))[0]!.editing).toEqual([])

    running.add(A.sessionId)
    const id = await create(A)
    await store.watch(id, 'port-1')
    await call(A, 'update_artifact', { id, base_version: 1, html: '<p>2</p>' })
    await call(A, 'update_artifact', { id: idle, title: 'Renamed' })
    const listed = await store.list({ project: A.project })
    expect(Object.fromEntries(listed.map((a) => [a.id, a.editing]))).toEqual({
      [id]: [A.sessionId],
      [idle]: [A.sessionId],
    })
    expect(events.activity.at(-1)).toEqual({ id, viewers: 1, editing: [A.sessionId] })

    const changed = events.changed
    store.stopEditing(A.sessionId)
    expect(events.activity.at(-1)).toEqual({ id, viewers: 1, editing: [] })
    expect(events.changed).toBe(changed + 1)
    expect((await store.list({ project: A.project })).every((a) => a.editing.length === 0)).toBe(
      true,
    )
    store.stopEditing(A.sessionId)
    expect(events.changed).toBe(changed + 1)
  })
})
