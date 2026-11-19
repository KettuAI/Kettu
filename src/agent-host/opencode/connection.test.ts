// What Kettu and OpenCode's server say to each other: sessions, turns, the requests that wait for
// the user, and what a dropped event stream leaves to catch up on. The server here is scripted,
// and sends the events OpenCode 2.3.2 sent for the same work.

import { afterEach, describe, expect, it } from 'vitest'
import { AgentRequestError, type McpServer, type PermissionAnswer } from '../connection'
import type { HostedContext } from '../driver'
import {
  OpenCodeConnection,
  formElicitation,
  mcpConfig,
  parseCommand,
  promptInput,
  questionAnswer,
} from './connection'
import type { FormInfo, MessageInfo, ServerEvent } from './protocol'
import { ServerError, type RunningServer, type ServerApi } from './server'
import { CWD, TestThread, recorded, rootOf, storedMessages } from './testing'

const MODEL = { id: 'deepseek-flash', providerID: 'deepseek' }
const SES = 'ses_1'

interface Sent {
  method: string
  path: string
  body: unknown
}

type Route = (sent: Sent) => unknown

/** A scripted server: it answers by the first route that matches, and sends what a test pushes. */
class FakeServer {
  readonly sent: Sent[] = []
  streams = 0
  private readonly routes: { method: string; path: RegExp; answer: Route }[] = []
  private emit: ((event: ServerEvent) => void) | null = null
  private end: (() => void) | null = null
  private sessions = 0

  constructor() {
    this.on('GET', /^\/api\/model\/default/, () => ({ data: MODEL }))
    this.on('GET', /^\/api\/model\?/, () => ({
      data: [
        {
          ...MODEL,
          name: 'DeepSeek Flash',
          variants: [{ id: 'low' }, { id: 'high' }],
          limit: { context: 1000 },
          settings: { apiKey: 'sk-never-kept' },
        },
        { id: 'gpt', providerID: 'openai', name: 'GPT', variants: [{ id: 'high' }] },
      ],
    }))
    this.on('GET', /^\/api\/agent\?/, () => ({
      data: [
        { id: 'build', name: 'Build', mode: 'primary' },
        { id: 'plan', name: 'Plan', mode: 'primary', description: 'Read-only' },
        { id: 'title', name: 'Title', mode: 'primary', hidden: true },
        { id: 'explore', name: 'Explore', mode: 'subagent' },
      ],
    }))
    this.on('GET', /^\/api\/command\?/, () => ({
      data: [{ name: 'review', description: 'review' }],
    }))
    this.on('POST', /^\/api\/session$/, () => ({ data: this.info(`ses_${++this.sessions}`) }))
    this.on('GET', /^\/api\/session\/active$/, () => ({ data: {} }))
    this.on('GET', /^\/api\/session\/[^/]+$/, ({ path }) => ({
      data: this.info(path.split('/')[3]!),
    }))
    this.on('GET', /\/instructions\/entries$/, () => ({ data: [] }))
    this.on('GET', /\/(permission|form)$/, () => ({ data: [] }))
    this.on('GET', /\/message\?/, () => ({ data: [], cursor: {} }))
    this.on('POST', /\/interrupt$/, () => ({ interrupted: true }))
  }

  info(id: string): Record<string, unknown> {
    return { id, time: { created: 1, updated: 2 }, location: { directory: CWD }, title: 'T' }
  }

  /** Answers a request, ahead of the routes set before. */
  on(method: string, path: RegExp, answer: Route): void {
    this.routes.unshift({ method, path, answer })
  }

  readonly api: ServerApi = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const sent = { method, path, body }
      this.sent.push(sent)
      const route = this.routes.find((item) => item.method === method && item.path.test(path))
      return (route ? route.answer(sent) : undefined) as T
    },
    events: (onEvent, signal) =>
      new Promise<void>((resolve) => {
        this.streams++
        this.emit = onEvent
        this.end = resolve
        signal.addEventListener('abort', () => resolve(), { once: true })
        queueMicrotask(() => onEvent({ type: 'server.connected', data: {} }))
      }),
  }

  push(...events: ServerEvent[]): void {
    for (const event of events) this.emit?.(event)
  }

  /** Ends the stream, as a server that dropped it does. */
  drop(): void {
    this.emit = null
    this.end?.()
  }

  posts(path: RegExp): Sent[] {
    return this.sent.filter((sent) => sent.method !== 'GET' && path.test(sent.path))
  }
}

/** A recorded stream as the session `sessionId` and its subagents would send it. */
function as(events: readonly ServerEvent[], sessionId: string): ServerEvent[] {
  const root = rootOf(events)
  return JSON.parse(JSON.stringify(events).replaceAll(root, sessionId)) as ServerEvent[]
}

interface Setup {
  server: FakeServer
  connection: OpenCodeConnection
  traffic: unknown[]
  log: string[]
}

const open: OpenCodeConnection[] = []

async function connect(server = new FakeServer()): Promise<Setup> {
  const traffic: unknown[] = []
  const log: string[] = []
  const context = {
    def: { id: 'opencode', name: 'OpenCode' },
    hooks: {
      traffic: (_direction: string, message: unknown) => traffic.push(message),
      account: () => {},
      ignored: () => {},
      log: (_level: string, message: string) => log.push(message),
    },
  } as unknown as HostedContext
  const running: RunningServer = {
    api: server.api,
    version: '2.3.2',
    exited: new Promise(() => {}),
    stop: () => {},
  }
  const connection = new OpenCodeConnection(context, async () => running)
  open.push(connection)
  await connection.initialize('0.0.0')
  return { server, connection, traffic, log }
}

async function session(setup: Setup, options = {}): Promise<{ id: string; thread: TestThread }> {
  const { sessionId } = await setup.connection.newSession(CWD, options)
  const thread = new TestThread(sessionId)
  setup.connection.register(sessionId, thread)
  return { id: sessionId, thread }
}

const text = (value: string) => [{ type: 'text' as const, text: value }]
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  for (const connection of open.splice(0)) connection.close()
})

describe('starting', () => {
  it('says what the server path can do, steering and forks at a message among it', async () => {
    const server = new FakeServer()
    const connection = new OpenCodeConnection(
      { hooks: {} } as unknown as HostedContext,
      async () => ({
        api: server.api,
        version: '2.3.2',
        exited: new Promise(() => {}),
        stop: () => {},
      }),
    )
    open.push(connection)
    const init = await connection.initialize('0.0.0')
    expect(init).toMatchObject({ name: 'OpenCode', version: '2.3.2' })
    expect(init.capabilities).toMatchObject({
      loadSession: true,
      resumeSession: true,
      forkSession: true,
      forkAtMessage: true,
      steering: true,
      ownTitles: 'sent',
      mcpHttp: true,
    })
    // The stream is open before anything is sent, since it replays nothing.
    expect(server.streams).toBe(1)
  })

  it('closes once the server exits', async () => {
    let exit = (): void => {}
    const server = new FakeServer()
    const connection = new OpenCodeConnection(
      { hooks: {} } as unknown as HostedContext,
      async () => ({
        api: server.api,
        version: '2.3.2',
        exited: new Promise<void>((resolve) => (exit = resolve)),
        stop: () => {},
      }),
    )
    await connection.initialize('0.0.0')
    exit()
    await connection.closed
    expect(connection.isClosed).toBe(true)
  })
})

describe('options', () => {
  it('lists a folder’s options without making a session, under the ids ACP gave them', async () => {
    const setup = await connect()
    const { sessionId, config } = await setup.connection.newSession(CWD, { hidden: 'options' })
    expect(setup.server.posts(/^\/api\/session$/)).toEqual([])
    expect(config.map((option) => [option.id, option.category, option.value])).toEqual([
      ['model', 'model', 'deepseek/deepseek-flash'],
      ['effort', 'thought_level', 'default'],
      ['mode', 'mode', 'build'],
    ])
    expect(config[0]!.choices).toEqual([
      { value: 'deepseek/deepseek-flash', name: 'deepseek/DeepSeek Flash' },
      { value: 'openai/gpt', name: 'openai/GPT' },
    ])
    expect(config[1]!.choices!.map((choice) => choice.value)).toEqual(['low', 'high', 'default'])
    expect(config[2]!.choices!.map((choice) => choice.value)).toEqual(['build', 'plan'])
    await setup.connection.removeHidden(sessionId, () => {})
    expect(setup.server.posts(/./)).toEqual([])
  })

  it('asks again while the server is still loading the folder', async () => {
    const setup = await connect()
    let tries = 0
    setup.server.on('GET', /^\/api\/agent\?/, () => {
      if (tries++ < 2) {
        throw new ServerError(503, null, 'Location plugins did not finish activating')
      }
      return { data: [{ id: 'build', name: 'Build', mode: 'primary' }] }
    })
    const { config } = await setup.connection.newSession(CWD, { hidden: 'options' })
    expect(tries).toBe(3)
    expect(config.at(-1)).toMatchObject({ id: 'mode', value: 'build' })
  }, 10_000)

  it('never keeps or records a provider’s settings', async () => {
    const setup = await connect()
    await session(setup)
    expect(JSON.stringify(setup.traffic)).not.toContain('sk-never-kept')
  })

  it('switches the model, keeping an effort the new model also has', async () => {
    const setup = await connect()
    const { id } = await session(setup)
    await setup.connection.setConfigOption(id, 'effort', 'high')
    const config = await setup.connection.setConfigOption(id, 'model', 'openai/gpt')
    expect(setup.server.posts(/\/model$/).map((sent) => sent.body)).toEqual([
      { model: { ...MODEL, variant: 'high' } },
      { model: { id: 'gpt', providerID: 'openai', variant: 'high' } },
    ])
    expect(config.map((option) => option.value)).toEqual(['openai/gpt', 'high', 'build'])
    await setup.connection.setConfigOption(id, 'effort', 'default')
    expect(setup.server.posts(/\/model$/).at(-1)!.body).toEqual({
      model: { id: 'gpt', providerID: 'openai' },
    })
    await setup.connection.setMode(id, 'plan')
    expect(setup.server.posts(/\/agent$/).map((sent) => sent.body)).toEqual([{ agent: 'plan' }])
  })

  it('refuses a value the folder does not offer, which the server would take', async () => {
    const setup = await connect()
    const { id } = await session(setup)
    await expect(setup.connection.setConfigOption(id, 'model', 'nope/nope')).rejects.toThrow(
      'No model nope/nope',
    )
    await expect(setup.connection.setConfigOption(id, 'effort', 'max')).rejects.toThrow()
    await expect(setup.connection.setConfigOption(id, 'mode', 'explore')).rejects.toThrow()
    expect(setup.server.posts(/\/(model|agent)$/)).toEqual([])
  })

  it('shows a choice OpenCode reports, and the session’s commands', async () => {
    const setup = await connect()
    const { id, thread } = await session(setup)
    expect(thread.state.session.commands.map((command) => command.name)).toEqual([
      'review',
      'compact',
    ])
    setup.server.push({
      type: 'session.model.selected',
      data: { sessionID: id, model: { id: 'gpt', providerID: 'openai', variant: 'high' } },
    })
    expect(thread.state.session.config.map((option) => option.value)).toEqual([
      'openai/gpt',
      'high',
      'build',
    ])
  })
})

describe('what Kettu adds to a session', () => {
  const KETTU: McpServer = {
    type: 'http',
    name: 'kettu',
    url: 'http://127.0.0.1:9/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer folder-token' }],
    prompt: 'Use Kettu’s tools.',
  }

  it('adds its MCP servers to the folder once, and keeps their tokens out of the records', async () => {
    const setup = await connect()
    await session(setup, { mcpServers: [KETTU] })
    await session(setup, { mcpServers: [KETTU] })
    const puts = setup.server.posts(/\/api\/experimental\/mcp\//)
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({
      method: 'PUT',
      path: '/api/experimental/mcp/kettu?location%5Bdirectory%5D=%2Fwork%2Fapp',
      body: {
        config: {
          type: 'remote',
          url: KETTU.url,
          headers: { Authorization: 'Bearer folder-token' },
          oauth: false,
        },
      },
    })
    expect(JSON.stringify(setup.traffic)).not.toContain('folder-token')
  })

  it('adds a server again once what it is given changes', async () => {
    const setup = await connect()
    await session(setup, { mcpServers: [KETTU] })
    await session(setup, {
      mcpServers: [{ ...KETTU, headers: [{ name: 'Authorization', value: 'Bearer other' }] }],
    })
    expect(setup.server.posts(/\/api\/experimental\/mcp\//)).toHaveLength(2)
  })

  it('names each kind of server as OpenCode configures it', () => {
    expect(
      mcpConfig({
        type: 'stdio',
        name: 'files',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'KEY', value: 'v' }],
      }),
    ).toEqual({ type: 'local', command: ['node', 'server.js'], environment: { KEY: 'v' } })
    expect(mcpConfig({ type: 'sse', name: 'old', url: 'http://x', headers: [] })).toBeNull()
  })

  it('puts its guide and memory in the session’s own instructions', async () => {
    const setup = await connect()
    const { id } = await session(setup, {
      mcpServers: [KETTU],
      memory: { text: '<kettu-memory>index</kettu-memory>' },
    })
    expect(setup.connection.ownInstructions).toBe(true)
    expect(setup.server.posts(/\/instructions\/entries\//)).toEqual([
      {
        method: 'PUT',
        path: `/api/experimental/session/${id}/instructions/entries/kettu`,
        body: { value: 'Use Kettu’s tools.\n\n<kettu-memory>index</kettu-memory>' },
      },
    ])
  })

  it('leaves instructions that have not changed alone when a session opens again', async () => {
    const setup = await connect()
    const value = 'Use Kettu’s tools.'
    setup.server.on('GET', /\/instructions\/entries$/, () => ({ data: [{ key: 'kettu', value }] }))
    await setup.connection.resumeSession(SES, CWD, { mcpServers: [KETTU] })
    expect(setup.server.posts(/\/instructions\/entries\//)).toEqual([])
    await setup.connection.resumeSession(SES, CWD, {
      mcpServers: [KETTU],
      memory: { text: 'new' },
    })
    expect(setup.server.posts(/\/instructions\/entries\//)).toHaveLength(1)
  })

  it('sends them ahead of the next prompt when the instructions cannot take them', async () => {
    const setup = await connect()
    setup.server.on('PUT', /\/instructions\/entries\//, () => {
      throw new ServerError(404, null, 'Not Found')
    })
    const { id } = await session(setup, { memory: { text: 'MEMORY' } })
    void setup.connection.prompt(id, text('hello')).catch(() => {})
    await settle()
    expect(setup.server.posts(/\/prompt$/)[0]!.body).toEqual({
      text: '<kettu-guide>\nMEMORY\n</kettu-guide>\n\nhello',
    })
  })

  it('adds nothing to a session it opens for itself', async () => {
    const setup = await connect()
    await setup.connection.newSession(CWD, {
      hidden: 'titles',
      mcpServers: [KETTU],
      memory: { text: 'MEMORY' },
    })
    expect(setup.server.posts(/mcp|instructions/)).toEqual([])
  })
})

describe('a turn', () => {
  it('ends when OpenCode’s loop does, with the tokens of each model it ran on', async () => {
    const setup = await connect()
    const { id, thread } = await session(setup)
    setup.server.on('POST', /\/prompt$/, () => {
      queueMicrotask(() => setup.server.push(...as(recorded('turn'), id)))
      return { data: {} }
    })
    const result = await setup.connection.prompt(id, text('Read note.txt'))
    expect(setup.server.posts(/\/prompt$/)[0]!.body).toEqual({ text: 'Read note.txt' })
    expect(result).toEqual({
      stopReason: 'end_turn',
      tokens: {
        total: 12446 + 49 + 256 + 119 + 47 + 38 + 12672,
        input: 12446 + 119,
        output: 49 + 47,
        thought: 38,
        cacheRead: 256 + 12672,
        cacheWrite: 0,
      },
      models: [{ model: 'deepseek/deepseek-flash', tokens: expect.any(Object) }],
    })
    expect(thread.lines.at(-1)).toMatch(/^agent 我快速想了一下/)
    expect(thread.state.session.usage?.size).toBe(1000)
  })

  it('fails with OpenCode’s own words', async () => {
    const setup = await connect()
    const { id } = await session(setup)
    setup.server.on('POST', /\/prompt$/, () => {
      queueMicrotask(() => setup.server.push(...as(recorded('failed'), id)))
      return { data: {} }
    })
    const error = await setup.connection.prompt(id, text('hi')).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentRequestError)
    expect(error).toMatchObject({
      kind: 'agent_error',
      message: 'Model unavailable: deepseek/does-not-exist',
      data: { type: 'provider.no-route' },
    })
  })

  it('ends as cancelled when the user stops it', async () => {
    const setup = await connect()
    const { id } = await session(setup)
    const events = as(recorded('interrupt'), id)
    const failed = events.findIndex((event) => event.type === 'session.tool.failed')
    setup.server.on('POST', /\/prompt$/, () => {
      queueMicrotask(() => setup.server.push(...events.slice(0, failed)))
      return { data: {} }
    })
    setup.server.on('POST', /\/interrupt$/, () => {
      queueMicrotask(() => setup.server.push(...events.slice(failed)))
      return { interrupted: true }
    })
    const turn = setup.connection.prompt(id, text('sleep'))
    await settle()
    await setup.connection.cancel(id)
    expect((await turn).stopReason).toBe('cancelled')
  })

  it('stops a prompt OpenCode took but had not started once it starts', async () => {
    const setup = await connect()
    const { id } = await session(setup)
    setup.server.on('POST', /\/interrupt$/, () => ({ interrupted: false }))
    void setup.connection.prompt(id, text('hi')).catch(() => {})
    await settle()
    await setup.connection.cancel(id)
    expect(setup.server.posts(/\/interrupt$/)).toHaveLength(1)
    setup.server.push({ type: 'session.execution.started', data: { sessionID: id } })
    expect(setup.server.posts(/\/interrupt$/)).toHaveLength(2)
  })

  it('refuses a second prompt while one runs, which the host queues itself', async () => {
    const setup = await connect()
    const { id } = await session(setup)
    void setup.connection.prompt(id, text('one')).catch(() => {})
    await settle()
    await expect(setup.connection.prompt(id, text('two'))).rejects.toThrow('already running')
  })

  it('fails every turn that runs when the connection closes', async () => {
    const setup = await connect()
    const { id } = await session(setup)
    const turn = setup.connection.prompt(id, text('one'))
    await settle()
    setup.connection.close()
    await expect(turn).rejects.toMatchObject({ kind: 'closed' })
  })

  it('runs a slash command through its own request, and anything else as a message', async () => {
    const setup = await connect()
    const { id } = await session(setup)
    const run = async (prompt: string): Promise<void> => {
      void setup.connection.prompt(id, text(prompt)).catch(() => {})
      await settle()
      setup.server.push(
        { type: 'session.execution.started', data: { sessionID: id } },
        { type: 'session.execution.succeeded', data: { sessionID: id } },
      )
      await settle()
    }
    await run('/compact')
    await run('/review the last commit')
    await run('/unknown thing')
    expect(
      setup.server.posts(/\/(compact|command|prompt)$/).map((sent) => [sent.path, sent.body]),
    ).toEqual([
      [`/api/session/${id}/compact`, {}],
      [`/api/session/${id}/command`, { name: 'review', text: 'the last commit' }],
      [`/api/session/${id}/prompt`, { text: '/unknown thing' }],
    ])
    expect(parseCommand('/review')).toEqual({ name: 'review', text: '' })
    expect(parseCommand('a /review')).toBeNull()
  })
})

describe('steering', () => {
  it('sends a message into the running turn, and asks for a prompt when none runs', async () => {
    const setup = await connect()
    const { id } = await session(setup)
    expect(await setup.connection.steer(id, text('now?'))).toBe('promptRequired')
    void setup.connection.prompt(id, text('work')).catch(() => {})
    await settle()
    setup.server.push({ type: 'session.execution.started', data: { sessionID: id } })
    expect(await setup.connection.steer(id, text('also this'))).toBe('injected')
    expect(setup.server.posts(/\/prompt$/).at(-1)!.body).toEqual({
      text: 'also this',
      delivery: 'steer',
    })
    // A command is a turn of its own.
    expect(await setup.connection.steer(id, text('/compact'))).toBe('promptRequired')
  })
})

describe('what a prompt carries', () => {
  const size = async (file: string): Promise<number | null> =>
    file.endsWith('huge.bin') ? 50_000_000 : file.endsWith('gone.txt') ? null : 10

  it('sends images and embedded text inline, and a file or folder by its address', async () => {
    const input = await promptInput(
      [
        { type: 'text', text: 'Look: ' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        {
          type: 'resource',
          resource: { uri: 'file:///work/app/paste.txt', mimeType: 'text/plain', text: 'hi' },
        },
        { type: 'resource_link', uri: 'file:///work/app/src', name: 'src' },
      ],
      size,
    )
    expect(input).toEqual({
      text: 'Look: ',
      files: [
        { uri: 'data:image/png;base64,AAAA', name: 'image.png', source: { type: 'inline' } },
        { uri: 'data:text/plain;base64,aGk=', name: 'paste.txt', source: { type: 'inline' } },
        { uri: 'file:///work/app/src', name: 'src' },
      ],
    })
  })

  it('names what OpenCode cannot attach in the text, for the agent to open itself', async () => {
    const input = await promptInput(
      [
        { type: 'text', text: 'See' },
        { type: 'resource_link', uri: 'https://example.com/page', name: 'page' },
        { type: 'resource_link', uri: 'file:///work/app/huge.bin', name: 'huge.bin' },
        { type: 'resource_link', uri: 'file:///work/app/gone.txt', name: 'gone.txt' },
      ],
      size,
    )
    expect(input).toEqual({
      text: 'See\n\n@https://example.com/page\n@/work/app/huge.bin\n@/work/app/gone.txt',
      files: [],
    })
  })

  it('sends a linked file OpenCode cannot read as its path instead', async () => {
    const setup = await connect()
    const { id } = await session(setup)
    let tries = 0
    setup.server.on('POST', /\/prompt$/, () => {
      if (tries++ === 0)
        throw new ServerError(400, 'InvalidRequestError', 'Unable to read attachment')
      return { data: {} }
    })
    void setup.connection
      .prompt(id, [
        { type: 'text', text: 'Read it' },
        { type: 'resource_link', uri: `file://${import.meta.filename}`, name: 'a.ts' },
      ])
      .catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 50))
    const bodies = setup.server.posts(/\/prompt$/).map((sent) => sent.body)
    expect(bodies).toEqual([
      { text: 'Read it', files: [{ uri: `file://${import.meta.filename}`, name: 'a.ts' }] },
      { text: `Read it\n\n@${import.meta.filename}` },
    ])
  })
})

describe('permission requests', () => {
  const start = async (answer: TestThread['answer']) => {
    const setup = await connect()
    const { id, thread } = await session(setup)
    thread.answer = answer
    const events = as(recorded('permission'), id)
    const asked = events.findIndex((event) => event.type === 'permission.asked')
    void setup.connection.prompt(id, text('run echo')).catch(() => {})
    await settle()
    setup.server.push(...events.slice(0, asked + 1))
    await settle()
    return { setup, id, thread }
  }

  it('asks on the call’s own row, with once, always for what OpenCode would save, and deny', async () => {
    const { setup, id, thread } = await start(() => ({ optionId: 'allow-always' }))
    expect(thread.asked[0]).toMatchObject({
      toolCallId: 'call_82300251e25b4459a6e980c4',
      toolEntryId: 't:call_82300251e25b4459a6e980c4',
      options: [
        { id: 'allow-once', kind: 'allow_once' },
        { id: 'allow-always', kind: 'allow_always', name: 'Always allow `echo *`' },
        { id: 'reject', kind: 'reject_once' },
      ],
    })
    expect(setup.server.posts(/\/permission\//)).toEqual([
      {
        method: 'POST',
        path: `/api/session/${id}/permission/per_1f47a368b001qWrmUbRm0YyF8E/reply`,
        body: { decision: 'always' },
      },
    ])
  })

  it('answers once, and denies with what the user wrote', async () => {
    const once = await start(() => ({ optionId: 'allow-once' }))
    expect(once.setup.server.posts(/\/permission\//)[0]!.body).toEqual({ decision: 'once' })
    const denied = await start(() => ({ optionId: 'reject', note: ' use ls instead ' }))
    expect(denied.setup.server.posts(/\/permission\//)[0]!.body).toEqual({
      decision: 'reject',
      message: 'use ls instead',
    })
    const dismissed = await start(() => 'cancelled')
    expect(dismissed.setup.server.posts(/\/permission\//)[0]!.body).toEqual({ decision: 'reject' })
  })

  it('takes the card back once the request is answered elsewhere or its turn ends', async () => {
    const { setup, id, thread } = await start(() => new Promise(() => {}))
    expect(thread.asked).toHaveLength(1)
    setup.server.push({ type: 'session.execution.interrupted', data: { sessionID: id } })
    await settle()
    expect(setup.server.posts(/\/permission\//)).toEqual([])
  })

  it('never approves for a session no thread shows', async () => {
    const setup = await connect()
    const { sessionId } = await setup.connection.newSession(CWD, { hidden: 'titles' })
    setup.server.push({
      type: 'permission.asked',
      data: { id: 'per_1', sessionID: sessionId, action: 'shell', resources: ['rm -rf /'] },
    })
    await settle()
    expect(setup.server.posts(/\/permission\//).map((sent) => sent.body)).toEqual([
      { decision: 'reject' },
    ])
  })
})

describe('questions', () => {
  const form = (): FormInfo =>
    (
      recorded('question').find((event) => event.type === 'form.created')!.data as {
        form: FormInfo
      }
    ).form

  it('asks a question form as one card on the call that asked', async () => {
    const setup = await connect()
    const { id, thread } = await session(setup)
    thread.answer = () => ({
      answers: [
        { question: 0, choices: [1] },
        { question: 1, choices: [0, 2], text: ' plum ' },
      ],
    })
    const events = as(recorded('question'), id)
    const created = events.findIndex((event) => event.type === 'form.created')
    void setup.connection.prompt(id, text('ask me')).catch(() => {})
    await settle()
    setup.server.push(...events.slice(0, created + 1))
    await settle()
    expect(thread.asked[0]).toMatchObject({
      toolEntryId: 't:call_90c9742ed55449c28df3d7f9',
      questions: [
        {
          header: 'Favorite color',
          question: 'Which color do you prefer?',
          multiSelect: false,
          allowsText: true,
          options: [
            { label: 'Red', description: 'Warm, bold tone' },
            { label: 'Green' },
            { label: 'Blue' },
          ],
        },
        { header: 'Favorite fruits', multiSelect: true },
      ],
    })
    expect(setup.server.posts(/\/form\//)).toEqual([
      {
        method: 'POST',
        path: `/api/session/${id}/form/frm_1f47b7f0400177aOnxjwvTtH2R/reply`,
        body: { answer: { q0: 'Green', q1: ['Apple', 'Kiwi', 'plum'] } },
      },
    ])
  })

  it('cancels the form when the card is dismissed or left without an answer', async () => {
    const dismissals: PermissionAnswer[] = ['cancelled', { answers: [] }]
    for (const answer of dismissals) {
      const setup = await connect()
      const { id, thread } = await session(setup)
      thread.answer = () => answer
      setup.server.push({ type: 'form.created', data: { form: { ...form(), sessionID: id } } })
      await settle()
      expect(setup.server.posts(/\/form\//)).toEqual([
        {
          method: 'DELETE',
          path: `/api/session/${id}/form/frm_1f47b7f0400177aOnxjwvTtH2R`,
          body: undefined,
        },
      ])
    }
  })

  it('answers the first question from a client that only picks an option', () => {
    expect(questionAnswer(form(), { optionId: 'answer:2' })).toEqual({ q0: 'Blue' })
    expect(questionAnswer(form(), { optionId: 'other' })).toBeNull()
  })

  it('shows any other form as fields to fill in, or a page to open', () => {
    const fields: FormInfo = {
      id: 'frm_1',
      sessionID: SES,
      title: 'Linear',
      fields: [
        { key: 'team', type: 'string', title: 'Team', required: true },
        { key: 'size', type: 'integer', minimum: 1 },
        { key: 'kind', type: 'string', options: [{ value: 'bug', label: 'Bug' }] },
        { key: 'secret', type: 'string', hidden: true },
      ],
    }
    expect(formElicitation(fields)).toEqual({
      kind: 'form',
      server: 'Linear',
      message: '',
      fields: [
        { key: 'team', title: 'Team', required: true, type: 'text' },
        { key: 'size', title: 'size', required: false, type: 'number', integer: true, minimum: 1 },
        {
          key: 'kind',
          title: 'kind',
          required: false,
          type: 'choice',
          choices: [{ value: 'bug', label: 'Bug' }],
        },
      ],
    })
    expect(
      formElicitation({
        ...fields,
        fields: [
          {
            key: 'page',
            type: 'external',
            url: 'https://example.com/auth',
            description: 'Sign in',
          },
        ],
      }),
    ).toEqual({
      kind: 'url',
      server: 'Linear',
      message: 'Sign in',
      url: 'https://example.com/auth',
    })
  })
})

describe('subagents', () => {
  it('shows a session OpenCode starts under one of Kettu’s as that session’s subagent', async () => {
    const setup = await connect()
    const { id, thread } = await session(setup)
    const events = as(recorded('subagent'), id)
    const child = 'ses_e0b81a6cfffeyRXjU50Wxzf0f7'
    void setup.connection.prompt(id, text('use a subagent'))
    await settle()
    const created = events.findIndex(
      (event) => event.type === 'session.created' && event !== events[0],
    )
    setup.server.push(...events.slice(1, created + 2))
    expect(thread.effects.filter((effect) => effect.kind === 'subagent')).toEqual([
      {
        kind: 'subagent',
        sessionId: child,
        title: 'Read note.txt content',
        canCancel: true,
        state: { kind: 'running' },
      },
      { kind: 'subagent', sessionId: child, description: 'explore' },
    ])
    expect(setup.connection.rootOf(child)).toBe(id)

    // Its own events wait for the thread the host gives it.
    setup.server.push(...events.slice(created + 2))
    const own = new TestThread(child)
    setup.connection.register(child, own)
    expect(own.lines.filter((line) => line.startsWith('tool'))).toEqual([
      "tool completed read Read file 'note.txt'",
      'tool completed execute od -c /work/app/note.txt && ls -l /work/app/note.txt',
    ])
    expect(thread.effects.filter((effect) => effect.kind === 'subagent').at(-1)).toEqual({
      kind: 'subagent',
      sessionId: child,
      state: {
        kind: 'idle',
        stopReason: 'end_turn',
        error: null,
        tokens: expect.objectContaining({ output: 49 + 68 + 60, thought: 73 }),
      },
    })
  })

  it('shows the turn OpenCode starts itself when the subagent reports', async () => {
    const setup = await connect()
    const { id, thread } = await session(setup)
    const turn = setup.connection.prompt(id, text('use a subagent'))
    await settle()
    setup.server.push(...as(recorded('subagent'), id).slice(1))
    expect((await turn).stopReason).toBe('end_turn')
    const turns = thread.effects.flatMap((effect) => (effect.kind === 'agentTurn' ? [effect] : []))
    expect(turns.map((effect) => effect.phase)).toEqual(['started', 'ended'])
    expect(turns[1]).toMatchObject({ result: { stopReason: 'end_turn' } })
  })

  it('ends a prompt that crosses such a turn together with it', async () => {
    const setup = await connect()
    const { id, thread } = await session(setup)
    setup.server.push({ type: 'session.execution.started', data: { sessionID: id } })
    const turn = setup.connection.prompt(id, text('and this'))
    await settle()
    setup.server.push({ type: 'session.execution.succeeded', data: { sessionID: id } })
    expect((await turn).stopReason).toBe('end_turn')
    expect(
      thread.effects.flatMap((effect) => (effect.kind === 'agentTurn' ? [effect.phase] : [])),
    ).toEqual(['started', 'joined'])
  })
})

describe('sessions OpenCode has', () => {
  it('opens one again, and reads one that is gone as gone', async () => {
    const setup = await connect()
    const { config } = await setup.connection.resumeSession(SES, CWD, {})
    expect(config.map((option) => option.id)).toEqual(['model', 'effort', 'mode'])
    setup.server.on('GET', /^\/api\/session\/ses_gone$/, () => {
      throw new ServerError(404, 'SessionNotFoundError', 'Session not found: ses_gone')
    })
    await expect(setup.connection.resumeSession('ses_gone', CWD, {})).rejects.toMatchObject({
      kind: 'agent_error',
      code: -32002,
    })
  })

  it('replays the history of one Kettu has no thread for, page by page', async () => {
    const setup = await connect()
    const messages = storedMessages('tools')
    setup.server.on('GET', /\/message\?/, ({ path }) =>
      path.includes('cursor=next')
        ? { data: messages.slice(3), cursor: {} }
        : { data: messages.slice(0, 3), cursor: { next: 'next' } },
    )
    const thread = new TestThread(SES)
    thread.replaying = true
    setup.connection.register(SES, thread)
    await setup.connection.loadSession(SES, CWD, {})
    expect(thread.lines.filter((line) => line.startsWith('tool'))).toHaveLength(4)
    expect(thread.lines[0]).toMatch(/^user Do exactly this/)
    expect(
      setup.server.sent.filter((sent) => /\/message\?/.test(sent.path)).map((sent) => sent.path),
    ).toEqual([
      `/api/session/${SES}/message?order=asc&limit=100`,
      `/api/session/${SES}/message?cursor=next`,
    ])
  })

  it('lists a folder’s own sessions, not its subagents’ or the ones Kettu keeps hidden', async () => {
    const setup = await connect()
    const hidden = await setup.connection.newSession(CWD, { hidden: 'titles' })
    setup.server.on('GET', /^\/api\/session\?/, () => ({
      data: [
        { ...setup.server.info('ses_a'), title: 'A' },
        { ...setup.server.info('ses_child'), parentID: 'ses_a' },
        setup.server.info(hidden.sessionId),
      ],
      cursor: { next: 'more' },
    }))
    expect(await setup.connection.listSessions(CWD, null)).toEqual({
      sessions: [
        { sessionId: 'ses_a', title: 'A', updatedAt: '1970-01-01T00:00:00.002Z', cwd: CWD },
      ],
      nextCursor: 'more',
    })
    expect(setup.server.sent.at(-1)!.path).toBe(
      '/api/session?directory=%2Fwork%2Fapp&parentID=null&limit=100',
    )
  })

  it('deletes a hidden session it made, and nothing for one that only listed options', async () => {
    const setup = await connect()
    const made = await setup.connection.newSession(CWD, { hidden: 'side' })
    await setup.connection.removeHidden(made.sessionId, () => {})
    expect(setup.server.posts(/^\/api\/session\/ses_1$/)).toEqual([
      { method: 'DELETE', path: '/api/session/ses_1', body: undefined },
    ])
  })
})

describe('forks', () => {
  const HISTORY: MessageInfo[] = [
    { type: 'user', id: 'msg_u1', text: 'one' },
    { type: 'assistant', id: 'msg_a1', content: [{ type: 'text', text: 'First reply' }] },
    { type: 'idle', id: 'msg_i1', outcome: 'succeeded' },
    { type: 'user', id: 'msg_u2', text: 'two' },
    { type: 'assistant', id: 'msg_a2', content: [{ type: 'text', text: 'Second reply' }] },
    { type: 'idle', id: 'msg_i2', outcome: 'succeeded' },
  ]

  const forked = async (point?: { messageId: string; text: string; occurrence: number }) => {
    const setup = await connect()
    setup.server.on('GET', /\/message\?/, () => ({ data: HISTORY, cursor: {} }))
    setup.server.on('POST', /\/fork$/, () => ({ data: setup.server.info('ses_fork') }))
    const fork = await setup.connection.forkSession(SES, CWD, {}, point)
    return { fork, body: setup.server.posts(/\/fork$/)[0]!.body }
  }

  it('copies the whole session without a point', async () => {
    const { fork, body } = await forked()
    expect(fork.sessionId).toBe('ses_fork')
    expect(body).toEqual({})
  })

  it('ends a fork with the reply it is taken at: before the message after that turn', async () => {
    expect(
      (await forked({ messageId: 'msg_a1', text: 'First reply', occurrence: 1 })).body,
    ).toEqual({
      before: 'msg_u2',
    })
    // The latest reply has nothing after its turn, so the whole session is copied.
    expect((await forked({ messageId: 'msg_a2.1', text: 'x', occurrence: 1 })).body).toEqual({})
  })

  it('finds by its text a reply an earlier connection gave another id', async () => {
    const { body } = await forked({ messageId: 'acp-7', text: 'First reply', occurrence: 1 })
    expect(body).toEqual({ before: 'msg_u2' })
    await expect(forked({ messageId: 'acp-7', text: 'Never said', occurrence: 1 })).rejects.toThrow(
      'no longer has that reply',
    )
  })
})

describe('a dropped event stream', () => {
  it('reads what it missed once it is back, and ends a turn that ended meanwhile', async () => {
    const setup = await connect()
    const { id, thread } = await session(setup)
    const turn = setup.connection.prompt(id, text('Read note.txt'))
    await settle()
    setup.server.push(
      { type: 'session.execution.started', data: { sessionID: id } },
      {
        type: 'session.text.delta',
        data: { sessionID: id, assistantMessageID: 'msg_a1', ordinal: 0, delta: 'Half a re' },
      },
    )
    expect(thread.lines).toEqual(['agent streaming Half a re'])

    setup.server.on('GET', /\/message\?/, () => ({
      // The latest page comes newest first.
      data: [
        { type: 'idle', id: 'msg_i1', outcome: 'succeeded' },
        {
          type: 'assistant',
          id: 'msg_a1',
          model: MODEL,
          content: [{ type: 'text', text: 'Half a reply, now whole.' }],
          finish: 'stop',
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 0 } },
          time: { created: Date.now() + 1000, completed: Date.now() + 2000 },
        },
        { type: 'user', id: 'msg_u1', text: 'Read note.txt' },
      ],
      cursor: {},
    }))
    setup.server.drop()
    const result = await turn
    expect(setup.server.streams).toBe(2)
    expect(thread.lines).toEqual(['agent Half a reply, now whole.'])
    expect(result).toMatchObject({
      stopReason: 'end_turn',
      tokens: { input: 10, output: 5, cacheRead: 100 },
      models: [{ model: 'deepseek/deepseek-flash' }],
    })
  })

  it('asks again for what a session that still runs waits on', async () => {
    const setup = await connect()
    const { id, thread } = await session(setup)
    thread.answer = () => new Promise(() => {})
    void setup.connection.prompt(id, text('run echo')).catch(() => {})
    await settle()
    setup.server.push({ type: 'session.execution.started', data: { sessionID: id } })
    setup.server.on('GET', /^\/api\/session\/active$/, () => ({
      data: { [id]: { type: 'running' } },
    }))
    setup.server.on('GET', /\/permission$/, () => ({
      data: [
        { id: 'per_1', sessionID: id, action: 'shell', resources: ['echo hi'], save: ['echo *'] },
      ],
    }))
    setup.server.drop()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(thread.asked.map((request) => request.toolCallId)).toEqual(['per_1'])
    expect(thread.lines).toEqual(['tool in_progress other shell: echo hi'])
  })
})
