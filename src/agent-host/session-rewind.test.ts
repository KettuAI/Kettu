import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import type { HostedDriver } from './driver'
import { OpenCodeConnection } from './opencode/connection'
import type { ServerEvent } from './opencode/protocol'
import { ServerError } from './opencode/server'
import { FakeServer, recorded, rootOf } from './opencode/testing'
import { FakeAppServer, FakeRpcError, threadResponse, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

// A host starts more than once; a busy machine takes longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []
let dir: string | null = null

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  dir = null
})

const textOf = (entry: ThreadEntry): string | null =>
  entry.kind === 'user' && entry.content[0]?.type === 'text' ? entry.content[0].text : null

const said = (entries: ThreadEntry[]) => entries.flatMap((entry) => textOf(entry) ?? [])

/** A Codex app-server whose turns are found by their prompt, and which cuts a thread on revert. */
function appServer() {
  const server = new FakeAppServer()
  const started = new Map<string, { threadId: string; turnId: string }>()
  server.on('turn/start', (params, self) => {
    const turnId = self.nextTurnId()
    const text = (params.input as { text?: string }[])[0]?.text
    if (text) started.set(text, { threadId: params.threadId as string, turnId })
    return { turn: turn(turnId) }
  })
  server.on('thread/turns/list', (params) => ({
    data: [...started.values()]
      .filter((sent) => sent.threadId === params.threadId)
      .map((sent) => turn(sent.turnId, 'completed')),
    nextCursor: null,
  }))
  server.on('thread/revert', (params) => {
    const order = [...started]
    const at = order.findIndex(([, sent]) => sent.turnId === params.beforeTurnId)
    for (const [text] of order.slice(at)) started.delete(text)
    return { thread: threadResponse(params.threadId as string).thread }
  })
  return { server, started }
}

async function start(server: FakeAppServer): Promise<TestHost> {
  const host = await startTestHost({
    ...(dir ? { userDataPath: dir } : {}),
    fakeAppServer: server,
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(host)
  return host
}

/** A Codex session with a turn for each of `texts`, each ended before the next is sent. */
async function session(texts: string[]) {
  const { server, started } = appServer()
  const host = await start(server)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  const send = async (text: string) => {
    await window.request('sessions.queue', { sessionId: id, content: [{ type: 'text', text }] })
    await vi.waitFor(() => expect(started.has(text)).toBe(true))
    const { threadId, turnId } = started.get(text)!
    server.notify('turn/completed', { threadId, turn: turn(turnId, 'completed') })
    await window.until(
      () => said(window.entries(id)).includes(text) && window.summary(id)?.status === 'ready',
    )
  }
  for (const text of texts) await send(text)
  return { server, started, host, window, id, send }
}

const entryOf = (window: TestPort, id: string, text: string): ThreadEntry =>
  window.entries(id).find((entry) => textOf(entry) === text)!

it('sets the turns from an edited message aside and cuts the agent there at the next send', async () => {
  const { server, started, window, id, send } = await session(['one', 'two', 'three'])
  const two = entryOf(window, id, 'two')
  const turnOfTwo = started.get('two')!.turnId
  // The agent's own id for each prompt is kept with its message, for a cut that finds it.
  expect(two).toMatchObject({ agentRef: turnOfTwo })
  const before = window.entries(id).map((entry) => entry.id)

  const { content } = await window.request('sessions.rewind', {
    sessionId: id,
    entryId: two.id,
    draft: [],
  })
  expect(content).toEqual([{ type: 'text', text: 'two' }])
  await window.until(() => !said(window.entries(id)).includes('two'))
  expect(window.entries(id).map((entry) => entry.id)).toEqual(
    before.slice(0, before.indexOf(two.id)),
  )
  expect(window.thread(id).session.rewound).toEqual({ turns: 2 })
  // Until the next send only Kettu holds the turns aside; the agent still has them.
  expect(server.sent('thread/revert')).toEqual([])

  await send('two again')
  expect(server.sent('thread/revert')).toEqual([
    { threadId: started.get('one')!.threadId, beforeTurnId: turnOfTwo },
  ])
  const methods = server.requests.map((request) => request.method)
  // Codex reverts only a loaded thread: the session is resumed with its own options first.
  const resumed = methods.indexOf('thread/resume', methods.lastIndexOf('thread/unsubscribe'))
  const reverted = methods.lastIndexOf('thread/revert')
  expect(resumed).toBeGreaterThan(-1)
  expect(reverted).toBeGreaterThan(resumed)
  expect(methods.lastIndexOf('turn/start')).toBeGreaterThan(reverted)
  expect(said(window.entries(id))).toEqual(['one', 'two again'])
  expect(window.thread(id).session.rewound).toBeNull()
})

it('puts the set-aside turns back as they were, also after a restart', async () => {
  dir = await tempFolder('kettu-rewind-')
  const { server, host, window, id } = await session(['one', 'two'])
  const before = window.entries(id)
  const two = entryOf(window, id, 'two')
  const draft = [{ type: 'text' as const, text: 'half written' }]
  await window.request('sessions.rewind', { sessionId: id, entryId: two.id, draft })
  await host.stop()
  hosts.splice(0)

  const again = await start(appServer().server)
  const reopened = again.connect()
  const opened = await reopened.open(id)
  expect(said(opened.entries)).toEqual(['one'])
  expect(opened.session.rewound).toEqual({ turns: 1 })
  expect(await reopened.request('sessions.putBack', { sessionId: id })).toEqual({ draft })
  await reopened.until(() => said(reopened.entries(id)).includes('two'))
  expect(reopened.entries(id)).toEqual(before)
  expect(reopened.thread(id).session.rewound).toBeNull()
  expect(server.sent('thread/revert')).toEqual([])
  await again.stop()
  hosts.splice(0)

  const third = await start(appServer().server)
  const stored = await third.connect().open(id)
  expect(stored.entries).toEqual(before)
  expect(stored.session.rewound).toBeUndefined()
})

it('loses nothing when the agent cannot cut its session, and puts the turns back', async () => {
  const { server, started, window, id } = await session(['one', 'two'])
  server.on('thread/revert', () => {
    throw new FakeRpcError(-32603, 'revert failed')
  })
  const two = entryOf(window, id, 'two')
  await window.request('sessions.rewind', { sessionId: id, entryId: two.id, draft: [] })
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'two again' }],
  })
  await window.untilEntry(id, (entry) => entry.kind === 'notice' && entry.severity === 'error')
  const notice = window.entries(id).find((entry) => entry.kind === 'notice')
  expect(notice).toMatchObject({ description: expect.stringContaining('revert failed') })
  expect(started.has('two again')).toBe(false)
  expect(window.thread(id).session.rewound).toEqual({ turns: 1 })

  await window.request('sessions.putBack', { sessionId: id })
  await window.until(() => said(window.entries(id)).includes('two'))
  expect(said(window.entries(id))).toEqual(['one', 'two', 'two again'])
})

it('refuses a message of an older thread its agent cannot cut', async () => {
  dir = await tempFolder('kettu-rewind-')
  const { host, window, id } = await session(['one'])
  const one = entryOf(window, id, 'one')
  await host.stop()
  hosts.splice(0)

  // The thread is asked as the session attaches again, here for its next message.
  const { server, started } = appServer()
  server.on('thread/read', (params) => ({
    thread: { ...threadResponse(params.threadId as string).thread, historyMode: 'legacy' },
  }))
  const again = await start(server)
  const reopened = again.connect()
  await reopened.open(id)
  await reopened.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'two' }],
  })
  await vi.waitFor(() => expect(started.has('two')).toBe(true))
  await reopened.until(() => reopened.thread(id).session.noRewind === true)
  await expect(
    reopened.request('sessions.rewind', { sessionId: id, entryId: one.id, draft: [] }),
  ).rejects.toMatchObject({ code: 'restricted' })
})

/**
 * OpenCode through its own server, scripted: each prompt becomes a user message with an id of its
 * own, and the revert it stages, clears and commits is recorded with the prompts it drops.
 */
function openCode() {
  const server = new FakeServer()
  const prompts: { id: string; text: string }[] = []
  server.on('POST', /\/prompt$/, ({ path, body }) => {
    const sessionId = path.split('/')[3]!
    const message = { id: `msg_u${prompts.length + 1}`, text: (body as { text: string }).text }
    prompts.push(message)
    const events = recorded('turn')
    const turn = JSON.parse(
      JSON.stringify(events).replaceAll(rootOf(events), sessionId),
    ) as ServerEvent[]
    queueMicrotask(() => server.push(...turn))
    return { data: { id: message.id, sessionID: sessionId, type: 'user' } }
  })
  let staged: string | null = null
  server.on('GET', /^\/api\/session\/ses_[^/]+$/, ({ path }) => {
    const info = server.info(path.split('/')[3]!)
    return { data: staged ? { ...info, revert: { messageID: staged } } : info }
  })
  server.on('POST', /\/revert\/stage$/, ({ body }) => {
    staged = (body as { messageID: string }).messageID
    return { data: { messageID: staged } }
  })
  server.on('DELETE', /\/revert$/, () => {
    staged = null
  })
  server.on('POST', /\/revert\/commit$/, () => {
    const at = prompts.findIndex((prompt) => prompt.id === staged)
    if (at >= 0) prompts.splice(at)
    staged = null
  })
  const driver: HostedDriver = {
    kind: 'hosted',
    connect: (context) =>
      new OpenCodeConnection(context, async () => ({
        api: server.api,
        version: '2.3.2',
        exited: new Promise<void>(() => {}),
        stop: () => {},
      })),
  }
  return { server, prompts, driver }
}

it('goes back in an OpenCode session with its files, puts them back, and commits at the next send', async () => {
  const { server, prompts, driver } = openCode()
  const host = await startTestHost({
    fakeAs: ['opencode'],
    programVersions: { opencode: '2.3.2' },
    drivers: { 'opencode-server': driver },
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'opencode',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  const send = async (text: string) => {
    await window.request('sessions.queue', { sessionId: id, content: [{ type: 'text', text }] })
    await window.until(
      () => said(window.entries(id)).includes(text) && window.summary(id)?.status === 'ready',
    )
  }
  await send('one')
  await send('two')
  // The button shows for OpenCode, and its confirmation says the files go back too.
  const [status] = (await window.request('agents.list', undefined)).filter(
    (agent) => agent.id === 'opencode',
  )
  expect(status?.capabilities).toMatchObject({ rewind: true, rewindFiles: true })
  const two = entryOf(window, id, 'two')
  expect(two).toMatchObject({ agentRef: 'msg_u2' })
  const reverts = () =>
    server.posts(/\/revert/).map((sent) => `${sent.method} ${sent.path.split('/').pop()}`)

  // The revert is staged as the edit goes back, so OpenCode takes the files back at once.
  await window.request('sessions.rewind', { sessionId: id, entryId: two.id, draft: [] })
  expect(server.posts(/\/revert\/stage$/).map((sent) => sent.body)).toEqual([
    { messageID: 'msg_u2', files: true },
  ])
  expect(said(window.entries(id))).toEqual(['one'])

  // Put back clears it, which returns the files, and nothing is committed.
  await window.request('sessions.putBack', { sessionId: id })
  await window.until(() => said(window.entries(id)).includes('two'))
  expect(reverts()).toEqual(['POST stage', 'DELETE revert'])

  // Going back again and sending commits the revert before the new message goes.
  await window.request('sessions.rewind', { sessionId: id, entryId: two.id, draft: [] })
  await send('two again')
  expect(reverts()).toEqual(['POST stage', 'DELETE revert', 'POST stage', 'POST commit'])
  const order = server.sent.map((sent) => sent.path)
  expect(order.findLastIndex((path) => path.endsWith('/prompt'))).toBeGreaterThan(
    order.findLastIndex((path) => path.endsWith('/revert/commit')),
  )
  expect(prompts.map((prompt) => prompt.text.split('\n').at(-1))).toEqual(['one', 'two again'])
  expect(said(window.entries(id))).toEqual(['one', 'two again'])
  expect(window.thread(id).session.rewound).toBeNull()
})

it('keeps an OpenCode session as it was when its revert cannot be staged', async () => {
  const { server, driver } = openCode()
  server.on('POST', /\/revert\/stage$/, () => {
    throw new ServerError(409, 'SessionBusyError', 'Session is busy')
  })
  const host = await startTestHost({
    fakeAs: ['opencode'],
    programVersions: { opencode: '2.3.2' },
    drivers: { 'opencode-server': driver },
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'opencode',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'one' }],
  })
  await window.until(
    () => said(window.entries(id)).includes('one') && window.summary(id)?.status === 'ready',
  )
  const one = entryOf(window, id, 'one')
  await expect(
    window.request('sessions.rewind', { sessionId: id, entryId: one.id, draft: [] }),
  ).rejects.toMatchObject({ message: 'Session is busy' })
  expect(said(window.entries(id))).toEqual(['one'])
  expect(window.thread(id).session.rewound ?? null).toBeNull()
})
