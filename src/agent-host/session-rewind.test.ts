import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { ClineConnection } from './cline/connection'
import { METHOD as CLINE_METHOD } from './cline/protocol'
import type { HostedDriver, HostedSpawnOptions } from './driver'
import { OpenCodeConnection } from './opencode/connection'
import type { ServerEvent } from './opencode/protocol'
import { ServerError } from './opencode/server'
import { FakeServer, recorded, rootOf } from './opencode/testing'
import { PiConnection } from './pi/connection'
import { readJsonLines } from './pi/jsonl'
import type { PiEntry } from './pi/protocol'
import { folderName } from './pi/session-files'
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

/** Scripted Pi RPC driver backing real JSONL session files and native `fork` rewinds. */
function scriptedPi(options: { failFork?: boolean } = {}) {
  const sessions = new Map<string, { file: string; entries: PiEntry[]; leafId: string | null }>()
  let nextSession = 1
  let nextEntry = 1
  let nextTs = 1_795_200_000_000
  const forked: { from: string; entryId: string; into: string }[] = []

  const writeSessionFile = async (file: string, id: string, cwd: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() })}\n`,
    )
  }

  const spawn = (spawnOptions: HostedSpawnOptions): ChildProcess => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => {
        if (child.exitCode === null) {
          child.exitCode = 0
          stdout.end()
          child.emit('exit', 0, null)
        }
        return true
      },
    })
    const { args } = spawnOptions
    const cwd = spawnOptions.cwd ?? ''
    const sessionDir = args.includes('--session-dir')
      ? args[args.indexOf('--session-dir') + 1]!
      : path.join(cwd, '.pi-sessions', folderName(cwd))
    const sessionArg = args.includes('--session') ? args[args.indexOf('--session') + 1]! : null
    const idArg = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1]! : null

    let currentId =
      idArg ??
      (sessionArg ? path.basename(sessionArg, '.jsonl').split('_').pop()! : `pi-s-${nextSession++}`)
    let currentFile =
      sessionArg ?? path.join(sessionDir, `2026-11-27T00-00-00-000Z_${currentId}.jsonl`)
    if (!sessions.has(currentId)) {
      const modelEntry: PiEntry = {
        type: 'model_change',
        id: `m${nextEntry++}`,
        parentId: null,
      }
      sessions.set(currentId, { file: currentFile, entries: [modelEntry], leafId: modelEntry.id })
    }

    const send = (record: unknown): void => void stdout.write(`${JSON.stringify(record)}\n`)
    const model = { provider: 'example', id: 'small', name: 'Small', contextWindow: 128_000 }

    void readJsonLines(stdin, {
      record: (raw) => {
        const cmd = raw as Record<string, unknown> & { id?: string; type: string }
        const ok = (data?: unknown) =>
          send({
            id: cmd.id,
            type: 'response',
            command: cmd.type,
            success: true,
            ...(data === undefined ? {} : { data }),
          })
        const fail = (error: string) =>
          send({ id: cmd.id, type: 'response', command: cmd.type, success: false, error })
        const cur = sessions.get(currentId)!
        switch (cmd.type) {
          case 'get_state':
            ok({
              model,
              thinkingLevel: 'high',
              isStreaming: false,
              sessionId: currentId,
              sessionFile: currentFile,
              autoCompactionEnabled: true,
              messageCount: cur.entries.length,
            })
            break
          case 'get_available_models':
            ok({ models: [model] })
            break
          case 'get_available_thinking_levels':
            ok({ levels: ['low', 'high'] })
            break
          case 'get_commands':
            ok({ commands: [] })
            break
          case 'get_session_stats':
            ok({ contextUsage: { tokens: 100, contextWindow: 128_000, percent: 0.1 } })
            break
          case 'get_entries':
            ok({ entries: [...cur.entries], leafId: cur.leafId })
            break
          case 'set_session_name':
            ok()
            break
          case 'fork': {
            if (options.failFork) {
              fail('fork rejected by hook')
              break
            }
            const entryId = String(cmd.entryId)
            const idx = cur.entries.findIndex((entry) => entry.id === entryId)
            if (idx < 0) {
              fail(`Unknown entry ${entryId}`)
              break
            }
            const kept = cur.entries.slice(0, idx)
            const newId = `pi-s-${nextSession++}`
            const newFile = path.join(sessionDir, `2026-11-27T00-00-00-000Z_${newId}.jsonl`)
            sessions.set(newId, { file: newFile, entries: kept, leafId: kept.at(-1)?.id ?? null })
            forked.push({ from: currentId, entryId, into: newId })
            currentId = newId
            currentFile = newFile
            void writeSessionFile(newFile, newId, cwd).then(() =>
              ok({ text: '', cancelled: false }),
            )
            break
          }
          case 'prompt': {
            const text = String(cmd.message ?? '')
            const ts = nextTs++
            const userEntry: PiEntry = {
              type: 'message',
              id: `u${nextEntry++}`,
              parentId: cur.leafId,
              message: { role: 'user', content: [{ type: 'text', text }], timestamp: ts },
            }
            const replyTs = nextTs++
            const replyEntry: PiEntry = {
              type: 'message',
              id: `a${nextEntry++}`,
              parentId: userEntry.id,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: `echo:${text.split('\n').at(-1)}` }],
                timestamp: replyTs,
                stopReason: 'stop',
              },
            }
            cur.entries.push(userEntry, replyEntry)
            cur.leafId = replyEntry.id
            void writeSessionFile(currentFile, currentId, cwd).then(() => {
              ok({ disposition: 'started' })
              send({ type: 'agent_start' })
              send({ type: 'message_start', message: userEntry.message })
              send({ type: 'message_end', message: userEntry.message })
              send({ type: 'message_start', message: replyEntry.message })
              send({ type: 'message_end', message: replyEntry.message })
              send({ type: 'agent_settled', aborted: false })
            })
            break
          }
          default:
            ok()
        }
      },
      garbage: () => {},
    }).then(() => child.kill())
    spawnOptions.signal?.addEventListener('abort', () => child.kill())
    return child as unknown as ChildProcess
  }

  const driver: HostedDriver = {
    kind: 'hosted',
    connect: (context) =>
      new PiConnection({
        ...context,
        cliVersion: '1.5.2',
        spawn,
      }),
  }
  return { driver, sessions, forked }
}

it('rewinds a Pi session via native fork, supports putBack and first-message reset, and leaves files untouched', async () => {
  const pi = scriptedPi()
  const host = await startTestHost({
    fakeAs: ['pi'],
    protocols: { pi: 'pi-rpc' },
    programVersions: { pi: '1.5.2' },
    drivers: { 'pi-rpc': pi.driver },
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'pi',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  const [status] = (await window.request('agents.list', undefined)).filter(
    (agent) => agent.id === 'pi',
  )
  expect(status?.capabilities.rewind).toBe(true)
  expect(status?.capabilities.rewindFiles).toBeUndefined()

  const send = async (text: string) => {
    await window.request('sessions.queue', { sessionId: id, content: [{ type: 'text', text }] })
    await window.until(
      () => said(window.entries(id)).includes(text) && window.summary(id)?.status === 'ready',
    )
  }
  await send('first')
  await send('second')
  const originalSessionId = window.thread(id).session.acpSessionId!
  const two = entryOf(window, id, 'second')
  expect(two).toMatchObject({ agentRef: expect.stringMatching(/^ts:\d+$/) })

  // Rewind sets turns aside without touching Pi yet; putBack restores them cleanly.
  await window.request('sessions.rewind', { sessionId: id, entryId: two.id, draft: [] })
  expect(said(window.entries(id))).toEqual(['first'])
  expect(pi.forked).toEqual([])
  await window.request('sessions.putBack', { sessionId: id })
  await window.until(() => said(window.entries(id)).includes('second'))
  expect(pi.forked).toEqual([])

  // Rewind again and send the edited prompt: Pi forks before 'second' into a new native session.
  await window.request('sessions.rewind', { sessionId: id, entryId: two.id, draft: [] })
  await send('second edited')
  expect(pi.forked).toHaveLength(1)
  expect(pi.forked[0]!.from).toBe(originalSessionId)
  const forkedSessionId = window.thread(id).session.acpSessionId!
  expect(forkedSessionId).toBe(pi.forked[0]!.into)
  expect(forkedSessionId).not.toBe(originalSessionId)
  // The forked Pi branch kept 'first' and its reply, dropped 'second', and appended 'second edited'.
  const forkedUsers = pi.sessions
    .get(forkedSessionId)!
    .entries.filter((entry) => entry.message?.role === 'user')
    .map((entry) =>
      Array.isArray(entry.message?.content) && entry.message.content[0]?.type === 'text'
        ? entry.message.content[0].text.split('\n').at(-1)
        : '',
    )
  expect(forkedUsers).toEqual(['first', 'second edited'])
  expect(said(window.entries(id))).toEqual(['first', 'second edited'])

  // Editing the first message resets to an empty native session without creating an empty fork.
  const first = entryOf(window, id, 'first')
  await window.request('sessions.rewind', { sessionId: id, entryId: first.id, draft: [] })
  await send('brand new first')
  expect(pi.forked).toHaveLength(1)
  expect(window.thread(id).session.acpSessionId).not.toBe(forkedSessionId)
  expect(said(window.entries(id))).toEqual(['brand new first'])
})

it('preserves set-aside turns for putBack when Pi native fork fails', async () => {
  const pi = scriptedPi({ failFork: true })
  const host = await startTestHost({
    fakeAs: ['pi'],
    protocols: { pi: 'pi-rpc' },
    programVersions: { pi: '1.5.2' },
    drivers: { 'pi-rpc': pi.driver },
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'pi',
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
  const two = entryOf(window, id, 'two')
  await window.request('sessions.rewind', { sessionId: id, entryId: two.id, draft: [] })
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'two retry' }],
  })
  await window.untilEntry(id, (entry) => entry.kind === 'notice' && entry.severity === 'error')
  expect(window.thread(id).session.rewound).toEqual({ turns: 1 })
  await window.request('sessions.putBack', { sessionId: id })
  await window.until(() => said(window.entries(id)).includes('two'))
})

/** Scripted Cline SDK host process for end-to-end SessionManager rewind verification. */
function scriptedCline() {
  const history = new Map<string, string[]>()
  const rewinds: { sessionId: string; ref: string | null; text: string; into: string }[] = []
  let nextFork = 1

  const spawn = (): ChildProcess => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => {
        if (child.exitCode === null) {
          child.exitCode = 0
          stdout.end()
          child.emit('exit', 0, null)
        }
        return true
      },
    })
    const send = (msg: unknown) => void stdout.write(`${JSON.stringify(msg)}\n`)
    const settings = {
      provider: 'anthropic',
      model: 'model-a',
      mode: 'act',
      thinking: false,
      autoApprove: true,
    }
    const providers = [{ id: 'anthropic', name: 'Anthropic', ready: true, oauth: false }]
    const models = [{ id: 'model-a', name: 'Model A', reasoning: false, images: true }]
    createInterface({ input: stdin }).on('line', (line) => {
      const msg = JSON.parse(line) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
      }
      if (!msg.method) return
      const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result })
      const params = msg.params ?? {}
      switch (msg.method) {
        case CLINE_METHOD.hello:
          reply({ core: '0.2.0', providers, provider: 'anthropic' })
          break
        case CLINE_METHOD.open:
          reply({ stored: params.resume === true, settings, providers, models })
          break
        case CLINE_METHOD.prompt: {
          const sid = String(params.sessionId)
          const text = String(params.text ?? '')
          const list = history.get(sid) ?? []
          list.push(text)
          history.set(sid, list)
          send({
            jsonrpc: '2.0',
            method: CLINE_METHOD.event,
            params: {
              sessionId: sid,
              event: { type: 'content_end', contentType: 'text', text: `reply:${text}` },
            },
          })
          reply({
            finishReason: 'completed',
            model: 'model-a',
            userRef: String(list.length),
            usage: null,
          })
          break
        }
        case CLINE_METHOD.rewind: {
          const sid = String(params.sessionId)
          const list = history.get(sid) ?? []
          const ref = (params.ref as string | null) ?? null
          const idx = ref
            ? Number.parseInt(ref, 10) - 1
            : list.findIndex((t) => t.includes(String(params.text)))
          if (idx <= 0) {
            rewinds.push({ sessionId: sid, ref, text: String(params.text), into: '' })
            reply({ sessionId: '' })
          } else {
            const newId = `cline_fork_${nextFork++}`
            history.set(newId, list.slice(0, idx))
            rewinds.push({ sessionId: sid, ref, text: String(params.text), into: newId })
            reply({ sessionId: newId })
          }
          break
        }
        default:
          reply({})
      }
    })
    return child as unknown as ChildProcess
  }

  const driver: HostedDriver = {
    kind: 'hosted',
    connect: (context) =>
      new ClineConnection({
        ...context,
        clineHostPath: '/fake/cline-host.js',
        spec: {
          ...context.spec,
          args: ['/fake/cline/bin/cline', '--acp'],
        },
        spawn,
      }),
  }
  return { driver, history, rewinds }
}

it('rewinds a Cline SDK session into a trimmed fork without reverting files', async () => {
  const cline = scriptedCline()
  const host = await startTestHost({
    fakeAs: ['cline'],
    protocols: { cline: 'cline-sdk' },
    installedVersions: { cline: '3.0.74' },
    drivers: { 'cline-sdk': cline.driver },
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'cline',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  const [status] = (await window.request('agents.list', undefined)).filter(
    (agent) => agent.id === 'cline',
  )
  expect(status?.capabilities.rewind).toBe(true)
  expect(status?.capabilities.rewindFiles).toBeUndefined()

  const send = async (text: string) => {
    await window.request('sessions.queue', { sessionId: id, content: [{ type: 'text', text }] })
    await window.until(
      () => said(window.entries(id)).includes(text) && window.summary(id)?.status === 'ready',
    )
  }
  await send('first')
  await send('second')
  const two = entryOf(window, id, 'second')
  expect(two).toMatchObject({ agentRef: '2' })

  await window.request('sessions.rewind', { sessionId: id, entryId: two.id, draft: [] })
  await send('second revised')
  expect(cline.rewinds).toHaveLength(1)
  expect(cline.rewinds[0]!.into).toBe('cline_fork_1')
  expect(cline.history.get('cline_fork_1')).toEqual(['first', 'second revised'])
  expect(said(window.entries(id))).toEqual(['first', 'second revised'])
})

it('keeps rewind hidden and restricted for drivers without native rewind support', async () => {
  const host = await startTestHost({ sessionTimings: { checkpointMs: 10 } })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  const [status] = (await window.request('agents.list', undefined)).filter(
    (agent) => agent.id === 'fake-agent',
  )
  expect(status?.capabilities.rewind).toBeUndefined()

  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'hello' }],
  })
  await window.until(
    () => said(window.entries(id)).includes('hello') && window.summary(id)?.status === 'ready',
  )
  const hello = entryOf(window, id, 'hello')
  await expect(
    window.request('sessions.rewind', { sessionId: id, entryId: hello.id, draft: [] }),
  ).rejects.toMatchObject({ code: 'restricted' })
})
