// The Cline connection against a stand-in for its host process that replays what the real one
// sent (@cline/sdk 0.2.0), and the pieces it converts Kettu's prompts, servers and answers with.

import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type {
  AgentConnection,
  ConnectionHooks,
  PermissionAnswer,
  PermissionRequest,
  SessionTarget,
} from '../connection'
import { AgentRequestError } from '../connection'
import type { HostedContext, HostedSpawnOptions } from '../driver'
import { newTurnScope } from '../session-updates'
import {
  ClineConnection,
  ClineSdkUnavailable,
  mcpServers,
  promptParts,
  questionAnswer,
  sdkEntry,
} from './connection'
import { withFallback } from './driver'
import recorded from './fixtures/recorded.json'
import { CONFIG } from './options'
import { ERROR, METHOD } from './protocol'

type Wire = [string, unknown]
type TurnName = keyof typeof recorded.turns

interface Rpc {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
}

/** The host process as a pair of streams, which answers as the recording says. */
function fakeHost(options: { hello?: 'fail' | 'ok'; signedOut?: boolean } = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => {
      child.exitCode = 0
      child.emit('exit', 0)
      return true
    },
  })
  const requests: Rpc[] = []
  const answers = new Map<number, (result: unknown) => void>()
  let nextId = 1000
  const post = (message: unknown): void => void stdout.write(`${JSON.stringify(message)}\n`)
  const ask = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      const id = nextId++
      answers.set(id, resolve)
      post({ jsonrpc: '2.0', id, method, params })
    })
  let settings = { ...recorded.opened.settings }
  const turn = async (sessionId: string, text: string): Promise<unknown> => {
    const name = text.replace(/^KP /, '').replace(/ /g, '-') as TurnName
    const script = recorded.turns[name] as (typeof recorded.turns)[TurnName] | undefined
    // A turn nobody recorded never ends, as one that still runs.
    if (!script) return new Promise(() => {})
    for (const [kind, data] of script.wire as Wire[]) {
      if (kind === 'event')
        post({ jsonrpc: '2.0', method: METHOD.event, params: { sessionId, event: data } })
      else if (kind === 'approval' || kind === 'question') {
        asked.push(await ask(kind, { sessionId, ...(data as object) }))
      }
    }
    return script.result
  }
  const asked: unknown[] = []
  createInterface({ input: stdin }).on('line', (line) => {
    const message = JSON.parse(line) as Rpc
    if (message.method === undefined) {
      answers.get(message.id!)?.(message.result)
      answers.delete(message.id!)
      return
    }
    requests.push(message)
    const reply = (result: unknown): void => post({ jsonrpc: '2.0', id: message.id, result })
    const fail = (code: number, text: string): void =>
      post({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })
    const params = message.params ?? {}
    switch (message.method) {
      case METHOD.hello:
        if (options.hello === 'fail') child.kill()
        else reply(recorded.hello)
        break
      case METHOD.open:
        if (options.signedOut)
          fail(ERROR.authRequired, 'Sign in to Cline before starting a session')
        else reply({ ...recorded.opened, settings, stored: params.resume === true })
        break
      case METHOD.prompt:
        void turn(params.sessionId as string, params.text as string).then(reply)
        break
      case METHOD.set:
        settings = { ...settings, ...(params.settings as object) }
        reply({ settings, models: recorded.opened.models })
        break
      default:
        reply({})
    }
  })
  return { child: child as unknown as ChildProcess, requests, asked }
}

function context(host: ReturnType<typeof fakeHost>, spawned: HostedSpawnOptions[] = []) {
  const logs: string[] = []
  const hooks: ConnectionHooks = {
    traffic: () => {},
    account: (account) => logs.push(`account ${account.kind} ${account.label}`),
    authState: (state) => logs.push(`auth ${state}`),
    ignored: () => {},
    log: (_level, message) => logs.push(message),
  }
  const ctx = {
    def: { id: 'cline', name: 'Cline' },
    hooks,
    spec: {
      command: '/usr/bin/node',
      args: ['/data/harnesses/cline/3.0.74/node_modules/cline/bin/cline', '--acp'],
      env: {},
      shell: false,
      display: { command: 'node', args: [], env: {} },
    },
    env: { HOME: '/home/u' },
    nodeRuntime: { command: '/app/kettu', env: { ELECTRON_RUN_AS_NODE: '1' } },
    clineHostPath: '/app/out/cline-host.js',
    spawn: (options: HostedSpawnOptions) => {
      spawned.push(options)
      return host.child
    },
  } as unknown as HostedContext
  return { ctx, logs }
}

/** A session's thread, as the host keeps it, answering each card with `answer`. */
function target(
  answer: (request: PermissionRequest) => PermissionAnswer | Promise<PermissionAnswer>,
) {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'cline',
      projectPath: '/work/app',
      acpSessionId: '',
      status: 'running',
      title: null,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 0,
      updatedAt: 0,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
    entries: [],
    seq: 0,
  })
  const scope = newTurnScope()
  const cards: PermissionRequest[] = []
  let n = 0
  const sessionTarget: SessionTarget = {
    context: () => ({
      thread,
      replaying: false,
      cancelling: false,
      scope,
      now: 1_000 + n,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }),
    apply: (output) => {
      thread = applyPatches(thread, output.patches)
    },
    requestPermission: async (request) => {
      thread = applyPatches(thread, request.output.patches)
      cards.push(request)
      return answer(request)
    },
    send: () => {},
    startMode: () => null,
  }
  return { target: sessionTarget, cards, entries: (): ThreadEntry[] => threadEntries(thread) }
}

async function started(host = fakeHost()) {
  const spawned: HostedSpawnOptions[] = []
  const { ctx, logs } = context(host, spawned)
  const connection = new ClineConnection(ctx)
  const init = await connection.initialize()
  return { connection, init, host, spawned, logs }
}

describe('Cline connection', () => {
  it("runs the SDK's process on Kettu's own runtime, from the installed package", async () => {
    const { init, spawned, logs } = await started()
    expect(spawned[0]).toMatchObject({
      command: '/app/kettu',
      args: [
        '/app/out/cline-host.js',
        '/data/harnesses/cline/3.0.74/node_modules/@cline/sdk/dist/index.js',
      ],
    })
    expect(spawned[0]!.env).toMatchObject({ HOME: '/home/u', ELECTRON_RUN_AS_NODE: '1' })
    expect(init.capabilities).toMatchObject({
      resumeSession: true,
      loadSession: false,
      steering: true,
      mcpHttp: true,
      mcpStdio: true,
      prompt: { image: true, embeddedContext: false },
    })
    // The providers Cline signs in to with a page are the sign-in methods.
    expect(init.authMethods.map((method) => method.id)).toEqual([
      'cline',
      'cline-pass',
      'openai-codex',
    ])
    expect(logs).toContain('auth authenticated')
    expect(logs).toContain('account api_key OpenAI Compatible')
  })

  it('says the SDK is unavailable when its process ends before answering', async () => {
    const { ctx } = context(fakeHost({ hello: 'fail' }))
    await expect(new ClineConnection(ctx).initialize()).rejects.toBeInstanceOf(ClineSdkUnavailable)
  })

  it('says so too without a runtime or a host script to run', async () => {
    const { ctx } = context(fakeHost())
    const connection = new ClineConnection({ ...ctx, clineHostPath: null })
    await expect(connection.initialize()).rejects.toBeInstanceOf(ClineSdkUnavailable)
  })

  it('opens a session with its options under the ids its ACP mode gave them', async () => {
    const { connection, host } = await started()
    const opened = await connection.newSession('/work/app', {
      mcpServers: [
        {
          type: 'http',
          name: 'kettu',
          url: 'http://127.0.0.1:1/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer t' }],
          autoAllow: ['set_plan'],
          prompt: 'Use set_plan.',
        },
      ],
      memory: { text: 'Memory index.' },
    })
    expect(opened.sessionId).toMatch(/^\d+_[0-9a-f]{8}_kettu$/)
    expect(opened.config.map((option) => [option.id, option.value])).toEqual([
      [CONFIG.mode, 'act'],
      [CONFIG.model, 'gpt-4o'],
      [CONFIG.autoApprove, false],
    ])
    const open = host.requests.find((request) => request.method === METHOD.open)!
    expect(open.params).toMatchObject({
      resume: false,
      instructions: 'Use set_plan.\n\nMemory index.',
      mcpServers: [
        {
          name: 'kettu',
          type: 'streamableHttp',
          headers: { Authorization: 'Bearer t' },
          autoAllow: ['set_plan'],
        },
      ],
    })
  })

  it("keeps Kettu's paragraphs out of the instructions of a session that takes them ahead", async () => {
    const { connection, host } = await started()
    await connection.resumeSession('1_cli', '/work/app', {
      promptAhead: true,
      memory: { text: 'Memory index.' },
    })
    const open = host.requests.find((request) => request.method === METHOD.open)!
    expect(open.params).toMatchObject({ sessionId: '1_cli', resume: true, instructions: null })
  })

  it('asks for a sign-in when Cline has none', async () => {
    const { connection } = await started(fakeHost({ signedOut: true }))
    await expect(connection.newSession('/work/app')).rejects.toMatchObject({
      kind: 'auth_required',
    })
  })

  it('runs a turn: the card for a command, its answer, the row and the result', async () => {
    const { connection, host } = await started()
    const { sessionId } = await connection.newSession('/work/app')
    const thread = target(() => ({ optionId: 'allow-always' }))
    connection.register(sessionId, thread.target)
    const result = await connection.prompt(sessionId, [{ type: 'text', text: 'KP shell' }])
    expect(result).toMatchObject({
      stopReason: 'end_turn',
      tokens: { input: 2409, output: 60, total: 2469 },
      models: [{ model: 'gpt-4o' }],
    })
    expect(thread.cards).toHaveLength(1)
    expect(thread.cards[0]).toMatchObject({
      toolCallId: 'call_4',
      toolEntryId: 't:call_4',
      options: [{ kind: 'allow_once' }, { kind: 'allow_always' }, { kind: 'reject_once' }],
    })
    expect(host.asked).toEqual([{ approved: true, always: true }])
    expect(thread.entries().find((entry) => entry.kind === 'tool')).toMatchObject({
      title: 'echo probe-shell && ls',
      status: 'completed',
    })
  })

  it('answers a denied card as a refusal', async () => {
    const { connection, host } = await started()
    const { sessionId } = await connection.newSession('/work/app')
    connection.register(sessionId, target(() => ({ optionId: 'reject' })).target)
    await connection.prompt(sessionId, [{ type: 'text', text: 'KP shell denied' }])
    expect(host.asked).toEqual([{ approved: false }])
  })

  it('asks a question in a card and returns the answer as text', async () => {
    const { connection, host } = await started()
    const { sessionId } = await connection.newSession('/work/app')
    const thread = target(() => ({ answers: [{ question: 0, choices: [0], text: 'or teal' }] }))
    connection.register(sessionId, thread.target)
    await connection.prompt(sessionId, [{ type: 'text', text: 'KP ask' }])
    expect(thread.cards[0]).toMatchObject({
      toolCallId: 'call_12',
      questions: [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }],
    })
    expect(host.asked).toEqual([{ answer: 'Red\nor teal' }])
  })

  it('reads a stopped turn as cancelled', async () => {
    const { connection } = await started()
    const { sessionId } = await connection.newSession('/work/app')
    connection.register(sessionId, target(() => 'cancelled').target)
    const result = await connection.prompt(sessionId, [{ type: 'text', text: 'KP slow' }])
    expect(result.stopReason).toBe('cancelled')
  })

  it('changes an option through the process and returns the options as they are then', async () => {
    const { connection, host } = await started()
    const { sessionId } = await connection.newSession('/work/app')
    const config = await connection.setConfigOption(sessionId, CONFIG.mode, 'plan')
    expect(config.find((option) => option.id === CONFIG.mode)?.value).toBe('plan')
    expect(host.requests.at(-1)).toMatchObject({
      method: METHOD.set,
      params: { sessionId, settings: { mode: 'plan' } },
    })
    await expect(connection.setConfigOption(sessionId, CONFIG.mode, 'yolo')).rejects.toBeInstanceOf(
      AgentRequestError,
    )
  })

  it('closes when its process ends, failing the turn that ran', async () => {
    const host = fakeHost()
    const { connection } = await started(host)
    const { sessionId } = await connection.newSession('/work/app')
    const turn = connection.prompt(sessionId, [{ type: 'text', text: 'KP unknown' }])
    host.child.kill()
    await expect(turn).rejects.toMatchObject({ kind: 'closed' })
    await connection.closed
    expect(connection.isClosed).toBe(true)
  })
})

describe('Cline conversions', () => {
  it('finds the SDK beside the installed package', () => {
    expect(sdkEntry('/d/cline/3.0.74/node_modules/cline/bin/cline')).toBe(
      '/d/cline/3.0.74/node_modules/@cline/sdk/dist/index.js',
    )
  })

  it('sends images as data URLs and linked files by path', () => {
    expect(
      promptParts([
        { type: 'text', text: 'Look' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'resource_link', uri: 'file:///work/app/a%20b.txt', name: 'a b.txt' },
        { type: 'resource_link', uri: 'https://a.test/x', name: 'x' },
        {
          type: 'resource',
          resource: { uri: 'file:///work/app/c.txt', mimeType: 'text/plain', text: 'C' },
        },
      ]),
    ).toEqual({
      text: 'Look\nhttps://a.test/x\n<file_content path="/work/app/c.txt">\nC\n</file_content>',
      images: ['data:image/png;base64,AAAA'],
      files: ['/work/app/a b.txt'],
    })
  })

  it('hands over each kind of MCP server in the transport the SDK names', () => {
    expect(
      mcpServers([
        { type: 'sse', name: 'old', url: 'http://a/sse', headers: [] },
        {
          type: 'stdio',
          name: 'local',
          command: 'npx',
          args: ['x'],
          env: [{ name: 'TOKEN', value: 's' }],
        },
      ]),
    ).toEqual([
      { name: 'old', type: 'sse', url: 'http://a/sse', headers: {}, autoAllow: [] },
      {
        name: 'local',
        type: 'stdio',
        command: 'npx',
        args: ['x'],
        env: { TOKEN: 's' },
        autoAllow: [],
      },
    ])
  })

  it('reads a question card answered by option id, by text alone, or dismissed', () => {
    expect(questionAnswer(['Red', 'Blue'], { optionId: 'answer:1' })).toBe('Blue')
    expect(
      questionAnswer(['Red', 'Blue'], { answers: [{ question: 0, choices: [], text: ' mauve ' }] }),
    ).toBe('mauve')
    expect(questionAnswer(['Red', 'Blue'], 'cancelled')).toBeNull()
    expect(questionAnswer(['Red', 'Blue'], { answers: [] })).toBeNull()
  })
})

describe('Cline fallback', () => {
  const stub = (init: () => Promise<unknown>) => {
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => (resolveClosed = resolve))
    const connection = {
      closed,
      isClosed: false,
      close: () => {
        connection.isClosed = true
        resolveClosed()
      },
      initialize: init,
      which: '',
    }
    return connection
  }
  const settled = async (promise: Promise<void>): Promise<boolean> =>
    Promise.race([
      promise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 20)),
    ])

  it('is the first connection when it starts', async () => {
    const first = Object.assign(
      stub(async () => ({ name: 'first' })),
      { which: 'first' },
    )
    const made: string[] = []
    const connection = withFallback(
      first as unknown as AgentConnection,
      () => true,
      () => {
        made.push('second')
        return first as unknown as AgentConnection
      },
      () => {},
    )
    expect(await connection.initialize('1')).toEqual({ name: 'first' })
    expect(made).toEqual([])
    expect((connection as unknown as { which: string }).which).toBe('first')
    connection.close()
    expect(await settled(connection.closed)).toBe(true)
  })

  it('becomes the fallback when the first cannot serve, and stays open though the first closed', async () => {
    const first = stub(async () => {
      first.close()
      throw new ClineSdkUnavailable('no SDK')
    })
    const second = Object.assign(
      stub(async () => ({ name: 'second' })),
      { which: 'second' },
    )
    const reasons: string[] = []
    const connection = withFallback(
      first as unknown as AgentConnection,
      (error) => error instanceof ClineSdkUnavailable,
      () => second as unknown as AgentConnection,
      (reason) => reasons.push(reason),
    )
    expect(await connection.initialize('1')).toEqual({ name: 'second' })
    expect(reasons).toEqual(['no SDK'])
    expect((connection as unknown as { which: string }).which).toBe('second')
    expect(await settled(connection.closed)).toBe(false)
    second.close()
    expect(await settled(connection.closed)).toBe(true)
  })

  it('fails as the first does for any other failure', async () => {
    const first = stub(async () => {
      first.close()
      throw new Error('broken')
    })
    const connection = withFallback(
      first as unknown as AgentConnection,
      (error) => error instanceof ClineSdkUnavailable,
      () => {
        throw new Error('never')
      },
      () => {},
    )
    await expect(connection.initialize('1')).rejects.toThrow('broken')
    expect(await settled(connection.closed)).toBe(true)
  })
})
