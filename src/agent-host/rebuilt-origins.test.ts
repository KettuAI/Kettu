import { rm } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import type { ThreadItem } from './codex/protocol'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'
import { originOf } from './threads/origins'

// A host starts three times; a busy machine takes longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []
let dir: string | null = null

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  dir = null
})

const DEVICE = { id: 'a'.repeat(32), name: 'Phone' }
const OWN = 'Fix the login test'
const REMINDER = 'Your step is not reported yet.'
const OUTSIDE = 'Typed in a terminal'
const PHONE = 'Check the result'
const MESSAGE = 'Restart browser and check'
const FROM = { sessionId: 'sender', title: 'Review' }

const textOf = (entry: ThreadEntry): string | null =>
  entry.kind === 'user' && entry.content[0]?.type === 'text' ? entry.content[0].text : null

const users = (entries: ThreadEntry[]) =>
  entries.flatMap((entry) => (entry.kind === 'user' ? [[textOf(entry), originOf(entry)]] : []))

const said = (id: string, text: string): ThreadItem =>
  ({ type: 'userMessage', id, content: [{ type: 'text', text, text_elements: [] }] }) as ThreadItem

async function start(server: FakeAppServer): Promise<TestHost> {
  const host = await startTestHost({
    userDataPath: dir!,
    fakeAppServer: server,
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(host)
  return host
}

it('gives a thread rebuilt from the agent history back who sent each message, and keeps it', async () => {
  dir = await tempFolder('kettu-rebuilt-')
  const server = new FakeAppServer()
  const started = new Map<string, { threadId: string; turnId: string }>()
  server.on('turn/start', (params, self) => {
    const turnId = self.nextTurnId()
    const text = (params.input as { text?: string }[])[0]?.text
    if (text) started.set(text, { threadId: params.threadId as string, turnId })
    return { turn: turn(turnId) }
  })
  const first = await start(server)
  const window = first.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: first.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  const phone: TestPort = first.connect(DEVICE)
  // Each message is one turn, ended before the next is sent.
  const send = async (text: string, go: () => Promise<unknown>) => {
    await go()
    await vi.waitFor(() => expect(started.has(text)).toBe(true))
    const { threadId, turnId } = started.get(text)!
    server.notify('turn/completed', { threadId, turn: turn(turnId, 'completed') })
    await window.until(
      () =>
        window.entries(id).some((entry) => textOf(entry) === text) &&
        window.summary(id)?.status === 'ready',
    )
  }
  const prompt = (port: TestPort, text: string) => () =>
    port.request('sessions.prompt', { sessionId: id, content: [{ type: 'text', text }] })
  await send(OWN, prompt(window, OWN))
  await send(REMINDER, () => first.host.sessions.sendFromKettu(id, REMINDER))
  await send(PHONE, prompt(phone, PHONE))
  await send(MESSAGE, () => first.host.sessions.sendFromTool(id, MESSAGE, FROM, false))
  const threadId = started.get(OWN)!.threadId
  await first.stop()
  hosts.splice(0)

  // Nothing of the thread is stored any more, so it comes back from the agent's own history,
  // which also holds a message written outside Kettu.
  const raw = new DatabaseSync(path.join(dir, 'state', 'threads.db'))
  raw.exec('PRAGMA foreign_keys = ON')
  raw.prepare('DELETE FROM threads WHERE session_id = ?').run(id)
  raw.close()
  const history = new FakeAppServer()
  history.history.set(
    threadId,
    [said('i1', OWN), said('i2', REMINDER), said('i3', OUTSIDE), said('i4', PHONE)]
      .concat(said('i5', MESSAGE))
      .map((item, i) => ({ turnId: `turn-${i + 1}`, item })),
  )
  const second = await start(history)
  const reopened = second.connect()
  await reopened.open(id)
  const expected = [
    [OWN, null],
    [REMINDER, { kettu: true }],
    [OUTSIDE, null],
    [PHONE, { device: expect.objectContaining({ name: 'Phone' }) }],
    [MESSAGE, { from: FROM }],
  ]
  await vi.waitFor(() => expect(users(reopened.entries(id))).toEqual(expected))
  await second.stop()
  hosts.splice(0)

  // What the rebuild put back is stored with the thread.
  const third = await start(new FakeAppServer())
  const opened = await third.connect().open(id)
  expect(users(opened.entries)).toEqual(expected)
})
