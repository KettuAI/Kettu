import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARTIFACT_KEEP_DELETED_MS } from '@shared/artifacts'
import { inThreadWorker } from '../testing/thread-worker'
import { ThreadStore } from '../threads/store'
import { ArtifactError, ArtifactStore, type ArtifactActivity } from './store'

const DAY = 24 * 60 * 60 * 1000
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function setup(purgeEveryMs?: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-artifact-store-'))
  const contentDir = path.join(dir, 'artifacts', 'content')
  const logs: { level: string; message: string }[] = []
  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    logs.push({ level, message })
  }
  const threads = new ThreadStore({
    file: path.join(dir, 'state', 'threads.db'),
    contentDir,
    createWorker: inThreadWorker,
    log,
  })
  const clock = { now: 1_000 }
  const events = {
    changed: 0,
    versions: [] as { ports: string[]; id: string; version: number }[],
    activity: [] as { ports: string[]; activity: ArtifactActivity }[],
  }
  const store = new ArtifactStore({
    threads,
    contentDir,
    log,
    now: () => clock.now,
    changed: () => events.changed++,
    version: (ports, id, version) => events.versions.push({ ports: [...ports], id, version }),
    activity: (ports, activity) => events.activity.push({ ports: [...ports], activity }),
    ...(purgeEveryMs ? { purgeEveryMs } : {}),
  })
  cleanups.push(async () => {
    store.stop()
    await threads.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const create = (project = '/p', html = '<p>one</p>') =>
    store.create({ project, sessionId: 's1', title: 'Report', html, pages: 1, note: null })
  return { store, threads, contentDir, clock, events, logs, create }
}

describe('the artifact store', () => {
  it('creates, reads and lists artifacts, and says when the list changed', async () => {
    const { store, events, create } = setup()
    const { id, version } = await create()
    expect(id).toMatch(/^art_/)
    expect(version).toBe(1)
    expect(events.changed).toBe(1)

    const read = await store.read(id)
    expect(read.html).toBe('<p>one</p>')
    expect(read.artifact).toMatchObject({ id, title: 'Report', project: '/p', head: 1 })
    expect(read.version).toMatchObject({ version: 1, author: 's1', createdAt: 1_000 })
    expect(await store.list()).toEqual([
      {
        id,
        title: 'Report',
        project: '/p',
        sessionId: 's1',
        version: 1,
        pages: 1,
        size: 10,
        updatedAt: 1_000,
        deletedAt: null,
        editing: [],
      },
    ])
    expect(await store.list({ project: '/q' })).toEqual([])
    const content = await store.content(id)
    expect(content.version).toBe(1)
    expect(existsSync(content.path)).toBe(true)
  })

  it('tells the watching ports of each new version, and counts every watch as a viewer', async () => {
    const { store, events, create, clock } = setup()
    const { id } = await create()
    await store.watch(id, 'port-1')
    await store.watch(id, 'port-1')
    await store.watch(id, 'port-2')
    expect(events.activity.at(-1)).toEqual({
      ports: ['port-1', 'port-2'],
      activity: { id, viewers: 3, editing: [] },
    })

    clock.now = 2_000
    expect(
      await store.write({
        id,
        baseVersion: 1,
        html: '<p>two</p>',
        pages: 2,
        author: 's2',
        note: 'More',
        project: '/p',
      }),
    ).toEqual({ version: 2 })
    expect(await store.restore({ id, version: 1, baseVersion: 2, author: null })).toEqual({
      version: 3,
    })
    expect(events.versions).toEqual([
      { ports: ['port-1', 'port-2'], id, version: 2 },
      { ports: ['port-1', 'port-2'], id, version: 3 },
    ])
    expect((await store.versions(id)).map((v) => [v.version, v.author])).toEqual([
      [3, null],
      [2, 's2'],
      [1, 's1'],
    ])

    store.unwatch(id, 'port-1')
    expect(events.activity.at(-1)!.activity.viewers).toBe(2)
    store.portClosed('port-1')
    expect(events.activity.at(-1)).toEqual({
      ports: ['port-2'],
      activity: { id, viewers: 1, editing: [] },
    })
    const sent = events.activity.length
    store.unwatch(id, 'port-1')
    store.portClosed('port-2')
    expect(events.activity).toHaveLength(sent)
  })

  it('refuses to watch an artifact that does not exist', async () => {
    const { store, events } = setup()
    await expect(store.watch('art_00000000000000000000000000', 'port-1')).rejects.toMatchObject({
      reason: 'not_found',
      code: 'not_found',
    })
    expect(events.activity).toEqual([])
  })

  it("refuses what is out of a session's reach or stale, with the state it found", async () => {
    const { store, create } = setup()
    const { id } = await create('/p')
    const stale = store.write({
      id,
      baseVersion: 0,
      html: '<p>x</p>',
      pages: 1,
      author: 's1',
      note: null,
    })
    await expect(stale).rejects.toBeInstanceOf(ArtifactError)
    await expect(stale).rejects.toMatchObject({
      reason: 'conflict',
      code: 'conflict',
      data: { version: 1, deleted: false },
    })
    await expect(store.read(id, { project: '/q' })).rejects.toMatchObject({ code: 'not_found' })

    const { purgeAt } = await store.delete(id, { project: '/p' })
    expect(purgeAt).toBe(1_000 + ARTIFACT_KEEP_DELETED_MS)
    await expect(store.read(id, { project: '/p' })).rejects.toMatchObject({
      reason: 'deleted',
      code: 'conflict',
      data: { version: 1, deleted: true },
    })
    expect((await store.read(id)).artifact.deletedAt).toBe(1_000)
    expect(await store.list({ project: '/p' })).toEqual([])
    expect((await store.list({ deleted: true })).map((a) => a.id)).toEqual([id])
  })

  it('renames, deletes, brings back and erases, changing the list each time', async () => {
    const { store, events, create } = setup()
    const { id } = await create()
    await store.rename(id, 'Traffic report')
    await store.delete(id)
    await store.delete(id)
    await store.undelete(id)
    await store.undelete(id)
    expect(events.changed).toBe(4)
    await expect(store.erase(id)).rejects.toMatchObject({
      reason: 'conflict',
      data: { version: 1, deleted: false },
    })
    await store.delete(id)
    await store.erase(id)
    expect(events.changed).toBe(6)
    await expect(store.read(id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('purges at start and every interval what has been deleted for 30 days', async () => {
    const { store, events, create, clock, logs } = setup(20)
    const { id } = await create('/p', '<p>gone</p>')
    const kept = await create('/p', '<p>kept</p>')
    const later = await create('/p', '<p>later</p>')
    await store.delete(id)
    await store.delete(kept.id)
    clock.now += 31 * DAY
    await store.undelete(kept.id)
    await store.delete(later.id)
    const before = events.changed

    store.start()
    await vi.waitFor(() => expect(events.changed).toBe(before + 1))
    expect((await store.list({ deleted: true })).map((a) => a.id)).toEqual([later.id])
    expect(logs).toContainEqual({
      level: 'info',
      message: 'Purged 1 artifacts and 1 content files',
    })

    clock.now += 31 * DAY
    await vi.waitFor(() => expect(events.changed).toBe(before + 2))
    expect(await store.list({ deleted: true })).toEqual([])
    expect((await store.list()).map((a) => a.id)).toEqual([kept.id])
    expect((await store.read(kept.id)).html).toBe('<p>kept</p>')
  })
})
