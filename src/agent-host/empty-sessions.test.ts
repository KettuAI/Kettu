// Integration tests: the one-time removal of sessions left with no message, which New sub-session
// used to create before it opened New session.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionRecord } from './storage'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

let hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.reverse()) await host.stop()
  hosts = []
})

async function setup(options: Parameters<typeof startTestHost>[0] = {}) {
  const t = await startTestHost(options)
  hosts.push(t)
  return { t, port: t.connect() }
}

const indexFile = (dir: string) => path.join(dir, 'state', 'sessions.json')

/**
 * Stops the host and starts another on its data, with the index as a build before the removal
 * left it: without the mark that it ran, and with `edit` applied to its sessions.
 */
async function launchAfterUpdate(
  first: TestHost,
  edit: (records: SessionRecord[]) => void = () => {},
) {
  await first.host.shutdown()
  const file = JSON.parse(await readFile(indexFile(first.dir), 'utf8')) as {
    sessions: SessionRecord[]
    emptySessionsRemovedAt?: number
  }
  delete file.emptySessionsRemovedAt
  edit(file.sessions)
  await writeFile(indexFile(first.dir), JSON.stringify(file))
  return setup({ userDataPath: first.dir })
}

async function relaunch(first: TestHost, options: Parameters<typeof startTestHost>[0] = {}) {
  await first.host.shutdown()
  return setup({ ...options, userDataPath: first.dir })
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

async function listed(port: TestPort): Promise<string[]> {
  return (await port.request('sessions.list', {})).map((s) => s.id).sort()
}

describe('removing sessions with no message, once', () => {
  it('removes those with no message and no title of the user, and their threads', async () => {
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
    await t.host.sessions.removeEmptyOnce()

    expect(await listed(port)).toEqual([talked, named, keptParent, usedChild, imported].sort())
    await t.host.threads!.flush()
    for (const id of [empty, emptyChild, emptyParent, emptyGrandchild]) {
      expect(await t.host.threads!.load(id)).toBeNull()
    }
    expect(await t.host.threads!.load(talked)).not.toBeNull()
    expect(t.host.diagnostics.logEntries()).toContainEqual(
      expect.objectContaining({ level: 'info', message: expect.stringContaining('Removed 4 ') }),
    )
    await t.host.sessions.flush()
    const file = JSON.parse(await readFile(indexFile(t.dir), 'utf8')) as Record<string, unknown>
    expect(file.emptySessionsRemovedAt).toEqual(expect.any(Number))
    expect(t.launcher).toMatchObject({ launches: 0 })
  })

  it('does nothing at the launches after', async () => {
    const { t: first } = await setup()
    const { t: second, port: during } = await relaunch(first)
    const empty = await create(second, during)
    const { t, port } = await relaunch(second)
    await t.host.sessions.removeEmptyOnce()
    expect(await listed(port)).toEqual([empty])
  })

  it('keeps a session that is live, shown, watched, or new in this launch', async () => {
    const { t: first, port: before } = await setup()
    const live = await create(first, before)
    const shown = await create(first, before)
    const watched = await create(first, before)
    const idle = await create(first, before)
    // The mark that the removal ran is already there, so it waits for the call below.
    const { t, port } = await relaunch(first)
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
    await t.host.threads!.flush()
    expect(await t.host.threads!.load(fresh)).not.toBeNull()

    await t.host.sessions.removeEmpty()
    const removed = port.events.flatMap((e) => (e.type === 'session.removed' ? [e.sessionId] : []))
    expect(removed).toEqual([idle])
    expect(await listed(port)).toEqual([live, shown, watched, fresh].sort())
  })
})
