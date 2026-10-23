// Integration tests: the one-time removal of sessions left with no message, which New sub-session
// used to create before it opened New session.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from './storage'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { ThreadStore } from './threads/store'

let hosts: TestHost[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.reverse()) await host.stop()
  hosts = []
})

async function setup(options: Parameters<typeof startTestHost>[0] = {}) {
  const t = await startTestHost(options)
  hosts.push(t)
  return { t, port: t.connect() }
}

const indexFile = (dir: string) => path.join(dir, 'state', 'sessions.json')

interface Index {
  version: number
  sessions: SessionRecord[]
  emptySessionsRemovedAt?: number
}

const readIndex = async (dir: string) => JSON.parse(await readFile(indexFile(dir), 'utf8')) as Index

/**
 * Stops the host and starts another on its data, with the index as a version before the removal
 * left it: without the mark that it ran, and with `edit` applied to its sessions.
 */
async function launchAfterUpdate(
  first: TestHost,
  edit: (records: SessionRecord[]) => void = () => {},
) {
  await first.host.shutdown()
  const index = await readIndex(first.dir)
  delete index.emptySessionsRemovedAt
  edit(index.sessions)
  await writeFile(indexFile(first.dir), JSON.stringify(index))
  return setup({ userDataPath: first.dir })
}

async function relaunch(first: TestHost) {
  await first.host.shutdown()
  return setup({ userDataPath: first.dir })
}

async function create(t: TestHost, port: TestPort, parentId?: string): Promise<string> {
  const summary = await port.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: t.project,
    ...(parentId ? { parentId } : {}),
  })
  return summary.id
}

async function talk(port: TestPort, sessionId: string): Promise<void> {
  await port.open(sessionId)
  await port.request('sessions.prompt', {
    sessionId,
    content: [{ type: 'text', text: 'hello' }],
  })
  await port.untilEntry(sessionId, (entry) => entry.kind === 'turn_end')
  await port.untilStatus(sessionId, 'ready')
}

const removeEmpty = (port: TestPort, keep: string[] = []) =>
  port.request('sessions.removeEmpty', { keep })

async function listed(port: TestPort): Promise<string[]> {
  return (await port.request('sessions.list', {})).map((s) => s.id).sort()
}

const removedEvents = (port: TestPort) =>
  port.events.flatMap((e) => (e.type === 'session.removed' ? [e.sessionId] : []))

async function stored(t: TestHost, sessionId: string) {
  await t.host.threads!.flush()
  return t.host.threads!.load(sessionId)
}

const logged = (t: TestHost, text: string) =>
  t.host.diagnostics.logEntries().some((entry) => entry.message.includes(text))

describe('removing sessions with no message, once', () => {
  it('removes those with no message and no title of any kind, with their threads', async () => {
    const { t: first, port: before } = await setup()
    const empty = await create(first, before)
    const talked = await create(first, before)
    await talk(before, talked)
    const named = await create(first, before)
    await before.request('sessions.rename', { sessionId: named, title: 'Keep me' })
    const emptyChild = await create(first, before, talked)
    const emptyParent = await create(first, before)
    const emptyGrandchild = await create(first, before, emptyParent)
    const keptParent = await create(first, before)
    const usedChild = await create(first, before, keptParent)
    await talk(before, usedChild)
    // OverBench stored no thread of an imported session it has not opened yet.
    const imported = (
      await before.request('sessions.import', {
        agentId: 'fake-agent',
        projectPath: first.project,
        acpSessionId: 'history-3',
      })
    ).id

    // As an agent that sends no title, after a message with no text.
    const { t, port } = await launchAfterUpdate(first, (records) => {
      for (const record of records) if (record.id === talked) record.title = null
    })
    await removeEmpty(port)

    expect(await listed(port)).toEqual([talked, named, keptParent, usedChild, imported].sort())
    for (const id of [empty, emptyChild, emptyParent, emptyGrandchild]) {
      expect(await stored(t, id)).toBeNull()
    }
    expect(await stored(t, talked)).not.toBeNull()
    expect(logged(t, 'Removed 4 ')).toBe(true)
    await t.host.sessions.flush()
    expect((await readIndex(t.dir)).emptySessionsRemovedAt).toEqual(expect.any(Number))
    expect(t.launcher).toMatchObject({ launches: 0 })
  })

  it('keeps a session with a title, a draft, a queue, a notice, a stale thread or a subagent', async () => {
    const { t: first, port: before } = await setup()
    const [plain, titled, drafted, queued, noticed, stale, parent, subagent] = [
      await create(first, before),
      await create(first, before),
      await create(first, before),
      await create(first, before),
      await create(first, before),
      await create(first, before),
      await create(first, before),
      await create(first, before),
    ]
    const { t, port } = await launchAfterUpdate(first, (records) => {
      for (const record of records) {
        // As the agent may title a session before any message.
        if (record.id === titled) record.title = 'Set up the project'
        if (record.id === queued) {
          record.queue = [{ id: 'q1', content: [{ type: 'text', text: 'Then this' }], at: 1 }]
        }
        // A thread stored for another ACP session than the one the index names.
        if (record.id === stale) record.acpSessionId = 'fake-other-1'
        if (record.id === subagent) {
          record.origin = 'subagent'
          record.parentId = parent
        }
      }
    })
    // The agent's own notice, or one that says the agent holds history OverBench did not store.
    const head = (await stored(t, noticed))!.head
    await t.host.threads!.write(noticed, {
      head,
      entries: [{ pos: 0, entry: { kind: 'notice', id: 'n1', severity: 'info', title: 'Note' } }],
    })

    await removeEmpty(port, [drafted])
    expect(removedEvents(port)).toEqual([plain])
    expect(await listed(port)).toEqual(
      [titled, drafted, queued, noticed, stale, parent, subagent].sort(),
    )
  })

  it('keeps a session that is live, shown, watched, or new in this launch', async () => {
    const { t: first, port: before } = await setup()
    const live = await create(first, before)
    const shown = await create(first, before)
    const watched = await create(first, before)
    const idle = await create(first, before)
    const { t, port } = await launchAfterUpdate(first)
    await port.request('sessions.setConfigOption', {
      sessionId: live,
      optionId: 'mode',
      value: 'plan',
    })
    await port.request('sessions.show', { sessionId: shown })
    await port.request('sessions.watch', { sessionId: watched })
    // Closed, so it is no longer live, with its empty thread stored.
    const fresh = await create(t, port)
    await port.request('sessions.close', { sessionId: fresh })
    expect(await stored(t, fresh)).not.toBeNull()

    await removeEmpty(port)
    expect(removedEvents(port)).toEqual([idle])
    expect(await listed(port)).toEqual([live, shown, watched, fresh].sort())
  })

  it('keeps a session whose thread cannot be read, and still runs only once', async () => {
    const { t: first, port: before } = await setup()
    const unreadable = await create(first, before)
    const empty = await create(first, before)
    const page = ThreadStore.prototype.page
    vi.spyOn(ThreadStore.prototype, 'page').mockImplementation(function (
      this: ThreadStore,
      sessionId,
      ...rest
    ) {
      if (sessionId === unreadable) return Promise.reject(new Error('disk I/O error'))
      return page.call(this, sessionId, ...rest)
    })
    const { t: second, port: during } = await launchAfterUpdate(first)
    await removeEmpty(during)
    expect(await listed(during)).toEqual([unreadable])
    expect(await stored(second, empty)).toBeNull()
    await second.host.sessions.flush()
    expect((await readIndex(second.dir)).emptySessionsRemovedAt).toEqual(expect.any(Number))

    vi.restoreAllMocks()
    const { port } = await relaunch(second)
    await removeEmpty(port)
    expect(await listed(port)).toEqual([unreadable])
  })

  it('does nothing at a later launch', async () => {
    const { t: first, port: before } = await setup()
    await removeEmpty(before)
    const empty = await create(first, before)
    const { t, port } = await relaunch(first)
    await removeEmpty(port)
    expect(await listed(port)).toEqual([empty])
    expect(logged(t, 'Removed')).toBe(false)
  })

  it('does nothing with an index from a newer version, which it never writes', async () => {
    const { t: first, port: before } = await setup()
    await create(first, before)
    await first.host.shutdown()
    const index = await readIndex(first.dir)
    delete index.emptySessionsRemovedAt
    const newer = JSON.stringify({ ...index, version: 2 })
    await writeFile(indexFile(first.dir), newer)
    const { t, port } = await setup({ userDataPath: first.dir })
    await removeEmpty(port)
    await t.host.sessions.flush()
    expect(logged(t, 'Removed')).toBe(false)
    expect(await readFile(indexFile(t.dir), 'utf8')).toBe(newer)
  })

  it('keeps the threads while the index cannot be written, and tries again next time', async () => {
    const { t: first, port: before } = await setup()
    const empty = await create(first, before)
    // The atomic write goes through this name, so every write of the index fails.
    const tmp = `${indexFile(first.dir)}.tmp`
    const { t: second, port: during } = await launchAfterUpdate(first)
    await mkdir(tmp)
    await removeEmpty(during)
    expect(await stored(second, empty)).not.toBeNull()
    expect(logged(second, 'Could not write the index')).toBe(true)

    await second.host.shutdown()
    await rm(tmp, { recursive: true })
    expect((await readIndex(second.dir)).sessions.map((s) => s.id)).toEqual([empty])
    const { t, port } = await setup({ userDataPath: second.dir })
    await removeEmpty(port)
    expect(await listed(port)).toEqual([])
    expect(await stored(t, empty)).toBeNull()
  })
})
