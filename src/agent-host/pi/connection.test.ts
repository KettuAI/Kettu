// The Pi connection against a scripted `pi --mode rpc`: how each session's process is started,
// what a turn resolves with, and what is sent to pi, with events recorded from pi 1.5.2 and 0.81.0.

import type { ChildProcess } from 'node:child_process'
import type { ModelProvider } from '@shared/agent-host'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import { PI } from '../agents/pi'
import {
  AgentRequestError,
  type McpServer,
  type PermissionAnswer,
  type PermissionRequest,
  type SessionTarget,
} from '../connection'
import type { HostedSpawnOptions } from '../driver'
import { newTurnScope, type MapperEffect } from '../session-updates'
import { PiConnection, promptMessage, turnError } from './connection'
import stored from './fixtures/entries.json'
import old from './fixtures/old-081.json'
import failed from './fixtures/provider-error.json'
import reply from './fixtures/reply.json'
import { readJsonLines } from './jsonl'
import { folderName } from './session-files'

type Command = Record<string, unknown> & { type: string; id?: string }
type Handler = (command: Command, pi: FakePi) => unknown

const MODELS = [
  { provider: 'example', id: 'small-model', name: 'Small', contextWindow: 1_000_000 },
  { provider: 'example', id: 'big/model', name: 'Big', contextWindow: 512_000 },
]

/** A process that answers pi's commands as scripted and sends the events it is told to. */
class FakePi extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  readonly commands: Command[] = []
  /** Events a `prompt` sends once pi accepted it, one list per prompt. */
  readonly runs: unknown[][] = []
  state: Record<string, unknown> = {
    model: MODELS[0],
    thinkingLevel: 'high',
    isStreaming: false,
    sessionId: 'pi-session-1',
    autoCompactionEnabled: true,
    messageCount: 0,
  }
  models: unknown[] = MODELS
  queue: string[] = []
  readonly handlers: Record<string, Handler> = {
    get_state: () => this.state,
    get_available_models: () => ({ models: this.models }),
    get_available_thinking_levels: () => ({ levels: ['low', 'high', 'max'] }),
    get_commands: () => ({
      commands: [{ name: 'skill:lint', description: 'Lint the code', source: 'skill' }],
    }),
    get_session_stats: () => ({
      cost: 0.002,
      contextUsage: { tokens: 3216, contextWindow: 1_000_000, percent: 0.3 },
    }),
    get_entries: () => ({ entries: [], leafId: null }),
    prompt: () => {
      const run = this.runs.shift()
      if (run) setImmediate(() => this.send(...run))
      return { disposition: 'started' }
    },
    steer: (command) => {
      this.queue.push(String(command.message))
      this.send({ type: 'queue_update', steering: [...this.queue], followUp: [] })
      return { disposition: 'queued' }
    },
    clear_queue: () => ({ steering: this.queue.splice(0), followUp: [] }),
    abort: () => {
      this.send({ type: 'agent_settled', aborted: true })
      return undefined
    },
    set_model: (command) => {
      const model = MODELS.find((m) => m.provider === command.provider && m.id === command.modelId)
      if (!model)
        throw new Error(`Model not found: ${String(command.provider)}/${String(command.modelId)}`)
      this.state = { ...this.state, model }
      return model
    },
    set_thinking_level: (command) => {
      this.state = { ...this.state, thinkingLevel: command.level }
      return undefined
    },
  }

  constructor(
    readonly options: HostedSpawnOptions,
    script?: (pi: FakePi) => void,
  ) {
    super()
    script?.(this)
    void readJsonLines(this.stdin, {
      record: (value) => this.take(value as Command),
      garbage: () => {},
    }).then(() => this.exit(0))
    options.signal?.addEventListener('abort', () => this.exit(0))
  }

  send(...events: unknown[]): void {
    for (const event of events) this.stdout.write(`${JSON.stringify(event)}\n`)
  }

  exit(code: number | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    if (code === null) this.signalCode = 'SIGTERM'
    else this.exitCode = code
    this.stdout.end()
    this.emit('exit', code, this.signalCode)
  }

  kill(): boolean {
    this.exit(null)
    return true
  }

  sent(type: string): Command[] {
    return this.commands.filter((command) => command.type === type)
  }

  private take(command: Command): void {
    this.commands.push(command)
    if (command.type === 'extension_ui_response') return
    const handler = this.handlers[command.type]
    const answer = { id: command.id, type: 'response', command: command.type }
    if (!handler) {
      this.send({ ...answer, success: false, error: `Unknown command: ${command.type}` })
      return
    }
    try {
      const data = handler(command, this)
      this.send({ ...answer, success: true, ...(data === undefined ? {} : { data }) })
    } catch (error) {
      this.send({ ...answer, success: false, error: (error as Error).message })
    }
  }
}

function freshThread(): ThreadState {
  return threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'pi',
      projectPath: '/work/app',
      acpSessionId: 'pi-session-1',
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
}

interface Watched {
  target: SessionTarget
  thread(): ThreadState
  entries(): ThreadEntry[]
  effects: MapperEffect[]
  asked: PermissionRequest[]
}

/** A session's target that keeps the thread, and answers what is asked with `answer`. */
function watch(
  answer: (
    request: PermissionRequest,
    signal: AbortSignal,
  ) => Promise<PermissionAnswer> = async () => 'cancelled',
): Watched {
  let thread = freshThread()
  const scope = newTurnScope()
  const effects: MapperEffect[] = []
  const asked: PermissionRequest[] = []
  let n = 0
  const target: SessionTarget = {
    context: () => ({
      thread,
      replaying: false,
      cancelling: false,
      scope,
      now: 5_000 + n,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }),
    apply: (out) => {
      thread = applyPatches(thread, out.patches)
      effects.push(...out.effects)
    },
    requestPermission: (request, signal) => {
      thread = applyPatches(thread, request.output.patches)
      asked.push(request)
      return answer(request, signal)
    },
    send: () => {},
    startMode: () => null,
  }
  return { target, thread: () => thread, entries: () => threadEntries(thread), effects, asked }
}

const dirs: string[] = []
const connections: PiConnection[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-pi-rpc-')))
  dirs.push(dir)
  return dir
}

interface Setup {
  connection: PiConnection
  spawned: FakePi[]
  /** Pi's agent folder, whose `sessions` hold the session files. */
  agentDir: string
  cwd: string
  logs: string[]
  /** Each list of providers the connection reported, in order. */
  providers: ModelProvider[][]
}

async function connect(
  options: { version?: string | null; script?: (pi: FakePi, index: number) => void } = {},
): Promise<Setup> {
  const root = await tempDir()
  const agentDir = path.join(root, 'agent')
  const cwd = path.join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const spawned: FakePi[] = []
  const logs: string[] = []
  const providers: ModelProvider[][] = []
  const connection = new PiConnection({
    def: PI,
    hooks: {
      traffic: () => {},
      account: () => {},
      modelProviders: (listed) => providers.push(listed),
      ignored: () => {},
      log: (_level, message) => logs.push(message),
    },
    spec: {
      command: '/usr/local/bin/pi',
      args: ['--mode', 'rpc'],
      env: {},
      shell: false,
      display: { command: 'pi', args: ['--mode', 'rpc'], env: {} },
    },
    env: { HOME: root, PI_CODING_AGENT_DIR: agentDir },
    spawn: (spawnOptions) => {
      const index = spawned.length
      const pi = new FakePi(spawnOptions, (fake) => {
        // As pi does: the session a file or an id names, else one of its own.
        const { args } = spawnOptions
        const file = args.includes('--session') ? args[args.indexOf('--session') + 1]! : null
        const named = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1]! : null
        const sessionId =
          named ??
          (file ? path.basename(file, '.jsonl').split('_').pop()! : `pi-session-${index + 1}`)
        fake.state = {
          ...fake.state,
          sessionId,
          sessionFile: file ?? path.join(agentDir, 'sessions', 'x', `t_${sessionId}.jsonl`),
        }
        options.script?.(fake, index)
      })
      spawned.push(pi)
      return pi as unknown as ChildProcess
    },
    cliVersion: options.version === undefined ? '1.5.2' : options.version,
    kettuDir: path.join(root, 'extensions'),
  })
  connections.push(connection)
  await connection.initialize()
  return { connection, spawned, agentDir, cwd, logs, providers }
}

/** Writes a session file as pi names and starts one, in the folder of the working directory. */
async function sessionFile(setup: Setup, id: string, prompt?: string): Promise<string> {
  const dir = path.join(setup.agentDir, 'sessions', folderName(setup.cwd))
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `2026-11-19T10-00-00-000Z_${id}.jsonl`)
  const lines: unknown[] = [
    { type: 'session', version: 3, id, timestamp: '2026-11-19T10:00:00.000Z', cwd: setup.cwd },
  ]
  if (prompt) {
    lines.push({
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: '2026-11-19T10:00:05.000Z',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    })
  }
  await writeFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  return file
}

const text = (value: string) => [{ type: 'text' as const, text: value }]
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

/** Waits until `met` holds, for what takes a file read or a process start to come about. */
async function until(met: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !met(); tries++) await tick()
  if (!met()) throw new Error('The condition never held')
}

const KETTU: McpServer = {
  type: 'http',
  name: 'kettu',
  url: 'http://127.0.0.1:4100/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer session-token' }],
  secret: true,
}

describe('starting a session', () => {
  it('hands pi each skill folder of the session with --skill', async () => {
    const { connection, spawned, cwd } = await connect()
    await connection.newSession(cwd, { skillRoots: ['/data/skills/a', '/data/skills/b'] })
    const { args } = spawned[0]!.options
    expect(args.filter((_, i) => args[i - 1] === '--skill')).toEqual([
      '/data/skills/a',
      '/data/skills/b',
    ])
  })

  it("runs the user's pi in RPC mode with Kettu's extension, and takes pi's id for it", async () => {
    const { connection, spawned, cwd } = await connect()
    const opened = await connection.newSession(cwd, { mcpServers: [KETTU] })
    expect(opened.sessionId).toBe('pi-session-1')
    expect(opened.harnessVersion).toBe('1.5.2')
    const { options } = spawned[0]!
    expect(options.command).toBe('/usr/local/bin/pi')
    expect(options.cwd).toBe(cwd)
    expect(options.args.slice(0, 4)).toEqual(['--mode', 'rpc', '--no-themes', '-e'])
    expect(options.args[4]).toMatch(/kettu-[0-9a-f]{12}\.mjs$/)
    expect(options.args).toHaveLength(5)
    // A token reaches pi in its environment alone, never on its command line.
    expect(options.args.join(' ')).not.toContain('session-token')
    expect(JSON.parse(options.env.KETTU_MCP_SERVERS!)).toMatchObject([
      { name: 'kettu', config: { headers: { Authorization: 'Bearer session-token' } } },
    ])
    expect(options.env.KETTU_MODEL_SCOPE).toBe('1')
  })

  it('offers the model and the thinking level under the ids stored sessions hold', async () => {
    const { connection, cwd } = await connect()
    const { config } = await connection.newSession(cwd)
    expect(config).toMatchObject([
      {
        id: 'model',
        category: 'model',
        value: 'example/small-model',
        choices: [
          { value: 'example/small-model', name: 'example/Small' },
          { value: 'example/big/model', name: 'example/Big' },
        ],
      },
      {
        id: 'thought_level',
        category: 'thought_level',
        value: 'high',
        choices: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    ])
  })

  it('reports the providers its models come from, with how many each lists', async () => {
    const { connection, cwd, providers } = await connect({
      script: (pi) => {
        pi.models = [...MODELS, { provider: 'deepseek', id: 'deepseek-v4', name: 'V4' }]
      },
    })
    await connection.newSession(cwd)
    expect(providers.at(-1)).toEqual([
      { id: 'example', models: 2 },
      { id: 'deepseek', models: 1 },
    ])
  })

  it('asks for a sign-in when pi has no model provider, and ends the process', async () => {
    const { connection, spawned, cwd, providers } = await connect({
      script: (pi) => {
        pi.models = []
        pi.state = { ...pi.state, model: { provider: 'unknown', id: 'unknown' } }
      },
    })
    const failure = await connection.newSession(cwd).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AgentRequestError)
    expect((failure as AgentRequestError).kind).toBe('auth_required')
    expect(providers.at(-1)).toEqual([])
    await tick()
    expect(spawned[0]!.exitCode).toBe(0)
  })

  it('says why pi went when it exits before it answers', async () => {
    const { connection, cwd } = await connect({
      script: (pi) => {
        pi.handlers.get_state = () => {
          pi.stderr.write('Error: settings.json is not valid JSON\n')
          setImmediate(() => pi.exit(1))
          throw new Error('never sent')
        }
        // The response of a process that died is never read.
        pi.send = () => {}
      },
    })
    await expect(connection.newSession(cwd)).rejects.toThrow(/settings\.json is not valid JSON/)
  })

  it('opens a session for Kettu itself without saving it, and narrows no folder', async () => {
    const { connection, spawned, cwd } = await connect()
    const opened = await connection.newSession(cwd, { hidden: 'options' })
    expect(spawned[0]!.options.args).toContain('--no-session')
    await connection.removeHidden(opened.sessionId, () => {})
    expect(spawned[0]!.exitCode).toBe(0)
  })

  it('starts an older pi without the extension, its tools or steering', async () => {
    const { connection, spawned, cwd } = await connect({ version: '0.99.2' })
    const init = await connection.initialize()
    expect(init.capabilities).toMatchObject({ mcpHttp: false, mcpStdio: false, steering: true })
    await connection.newSession(cwd, { mcpServers: [KETTU] })
    expect(spawned[0]!.options.args).toEqual(['--mode', 'rpc', '--no-themes'])
    expect(spawned[0]!.options.env.KETTU_MCP_SERVERS).toBeUndefined()
    const oldest = await connect({ version: '0.81.0' })
    expect((await oldest.connection.initialize()).capabilities.steering).toBe(false)
  })
})

describe('a turn', () => {
  it('shows the reply and resolves with its tokens once pi settled', async () => {
    const { connection, spawned, cwd } = await connect()
    const { sessionId } = await connection.newSession(cwd)
    const seen = watch()
    connection.register(sessionId, seen.target)
    spawned[0]!.runs.push(reply)
    const result = await connection.prompt(sessionId, text('Reply with exactly: pong'))
    expect(result).toEqual({
      stopReason: 'end_turn',
      tokens: { total: 3216, input: 2956, output: 4, thought: 0, cacheRead: 256, cacheWrite: 0 },
      models: [{ model: 'example/small-model', tokens: expect.objectContaining({ total: 3216 }) }],
    })
    expect(spawned[0]!.sent('prompt')[0]).toMatchObject({ message: 'Reply with exactly: pong' })
    expect(seen.entries()).toMatchObject([{ kind: 'agent', markdown: 'pong', streaming: false }])
    // Pi's own count once the turn settled, with what the session cost.
    expect(seen.thread().session.usage).toMatchObject({
      used: 3216,
      size: 1_000_000,
      cost: { amount: 0.002, currency: 'USD' },
    })
    expect(seen.thread().session.commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(['skill:lint', 'compact', 'name']),
    )
  })

  it("fails with the provider's own words and status when a reply ends in an error", async () => {
    const { connection, spawned, cwd } = await connect()
    const { sessionId } = await connection.newSession(cwd)
    connection.register(sessionId, watch().target)
    spawned[0]!.runs.push(failed)
    const failure = await connection.prompt(sessionId, text('Say hi.')).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(AgentRequestError)
    expect(failure).toMatchObject({ kind: 'agent_error', data: { status: 402 } })
    expect((failure as Error).message).toContain('Insufficient Balance')
    expect(turnError('boom')).toMatchObject({ kind: 'agent_error', data: {} })
  })

  it('asks for a sign-in when pi refuses a prompt for want of a key', async () => {
    const { connection, spawned, cwd } = await connect()
    const { sessionId } = await connection.newSession(cwd)
    spawned[0]!.handlers.prompt = () => {
      throw new Error('No API key found for the selected model.\n\nUse /login to log in.')
    }
    await expect(connection.prompt(sessionId, text('hi'))).rejects.toMatchObject({
      kind: 'auth_required',
    })
    // The turn is over, so the next prompt is taken.
    spawned[0]!.handlers.prompt = () => ({ disposition: 'handled' })
    await expect(connection.prompt(sessionId, text('/mcp'))).resolves.toMatchObject({
      stopReason: 'end_turn',
    })
  })

  it('ends at once when an extension took the prompt, which starts no run', async () => {
    const { connection, spawned, cwd } = await connect()
    const { sessionId } = await connection.newSession(cwd)
    const seen = watch()
    connection.register(sessionId, seen.target)
    spawned[0]!.handlers.prompt = (_command, pi) => {
      pi.send({
        type: 'extension_ui_request',
        id: 'n',
        method: 'notify',
        message: 'docs: connected',
      })
      return { disposition: 'handled' }
    }
    const result = await connection.prompt(sessionId, text('/mcp'))
    expect(result).toEqual({ stopReason: 'end_turn', tokens: null, models: [] })
    expect(seen.entries()).toMatchObject([{ kind: 'notice', title: 'docs: connected' }])
  })

  it("tells a started run from a taken prompt by pi's state before 0.99", async () => {
    const { connection, spawned, cwd } = await connect({ version: '0.87.1' })
    const { sessionId } = await connection.newSession(cwd)
    const seen = watch()
    connection.register(sessionId, seen.target)
    const pi = spawned[0]!
    pi.handlers.prompt = () => undefined
    await expect(connection.prompt(sessionId, text('/mcp'))).resolves.toMatchObject({
      stopReason: 'end_turn',
    })
    pi.handlers.prompt = () => {
      pi.send(...old)
      return undefined
    }
    const result = await connection.prompt(sessionId, text('Read notes.txt'))
    expect(result.stopReason).toBe('end_turn')
    expect(seen.entries().filter((entry) => entry.kind === 'tool')).toHaveLength(3)
  })

  it('sends a file as a link a replay reads back, and an image beside the text', () => {
    expect(
      promptMessage([
        { type: 'text', text: 'Look at ' },
        { type: 'resource_link', uri: 'file:///work/app/a%20b.ts', name: 'a b.ts' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        {
          type: 'resource',
          resource: { uri: 'file:///work/app/c.md', mimeType: 'text/markdown', text: '# C' },
        },
      ]),
    ).toEqual({
      message:
        'Look at \n[@a b.ts](file:///work/app/a%20b.ts)\n[@c.md](file:///work/app/c.md)\n<context ref="file:///work/app/c.md">\n# C\n</context>',
      images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    })
  })

  it('rejects when pi exits mid-turn, and starts pi again for the next prompt', async () => {
    const setup = await connect()
    const { connection, spawned, cwd } = setup
    const { sessionId } = await connection.newSession(cwd)
    await sessionFile(setup, sessionId)
    const pi = spawned[0]!
    pi.handlers.prompt = () => {
      setImmediate(() => pi.exit(1))
      return { disposition: 'started' }
    }
    await expect(connection.prompt(sessionId, text('hi'))).rejects.toMatchObject({ kind: 'closed' })
    const next = connection.prompt(sessionId, text('again'))
    await until(() => spawned.length === 2 && spawned[1]!.sent('prompt').length === 1)
    expect(spawned[1]!.options.args).toContain('--session')
    spawned[1]!.send({ type: 'agent_start' }, { type: 'agent_settled', aborted: false })
    await expect(next).resolves.toMatchObject({ stopReason: 'end_turn' })
  })
})

describe('stopping and steering', () => {
  it('empties the queue before the stop, and sends what it held with the next prompt', async () => {
    const { connection, spawned, cwd } = await connect()
    const { sessionId } = await connection.newSession(cwd)
    connection.register(sessionId, watch().target)
    const pi = spawned[0]!
    pi.runs.push([{ type: 'agent_start' }])
    const turn = connection.prompt(sessionId, text('Run sleep 30'))
    await tick()
    await expect(connection.steer(sessionId, text('never mind'))).resolves.toBe('injected')
    await connection.cancel(sessionId)
    await expect(turn).resolves.toMatchObject({ stopReason: 'cancelled' })
    const order = pi.commands.map((command) => command.type)
    expect(order.indexOf('clear_queue')).toBeLessThan(order.indexOf('abort'))
    pi.runs.push([{ type: 'agent_start' }, { type: 'agent_settled', aborted: false }])
    await connection.prompt(sessionId, text('What did I say?'))
    expect(pi.sent('prompt')[1]).toMatchObject({ message: 'never mind\n\nWhat did I say?' })
  })

  it('takes no message into a session without a running turn', async () => {
    const { connection, spawned, cwd } = await connect()
    const { sessionId } = await connection.newSession(cwd)
    await expect(connection.steer(sessionId, text('hello'))).resolves.toBe('promptRequired')
    expect(spawned[0]!.sent('steer')).toEqual([])
  })

  it("runs a message the settled run left in pi's queue as a turn of pi's own", async () => {
    const { connection, spawned, cwd } = await connect()
    const { sessionId } = await connection.newSession(cwd)
    const seen = watch()
    connection.register(sessionId, seen.target)
    const pi = spawned[0]!
    pi.runs.push([{ type: 'agent_start' }])
    const turn = connection.prompt(sessionId, text('Tell me a color'))
    await tick()
    await connection.steer(sessionId, text('an animal instead'))
    // The run ends without taking the message.
    pi.send({ type: 'agent_settled', aborted: false })
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' })
    pi.runs.push([{ type: 'agent_start' }, { type: 'agent_settled', aborted: false }])
    const turns = () => seen.effects.filter((effect) => effect.kind === 'agentTurn')
    await until(() => turns().length === 2)
    expect(pi.sent('prompt')[1]).toMatchObject({ message: 'an animal instead' })
    expect(turns().map((e) => e.phase)).toEqual(['started', 'ended'])
  })
})

describe('options', () => {
  it('sets the model by its provider and id, and reads what pi settled on', async () => {
    const { connection, spawned, cwd } = await connect()
    const { sessionId } = await connection.newSession(cwd)
    const config = await connection.setConfigOption(sessionId, 'model', 'example/big/model')
    expect(spawned[0]!.sent('set_model')[0]).toMatchObject({
      provider: 'example',
      modelId: 'big/model',
    })
    expect(config[0]).toMatchObject({ id: 'model', value: 'example/big/model' })
    const level = await connection.setConfigOption(sessionId, 'thought_level', 'low')
    expect(level[1]).toMatchObject({ id: 'thought_level', value: 'low' })
    await expect(connection.setConfigOption(sessionId, 'model', 'example/gone')).rejects.toThrow(
      'Model not found: example/gone',
    )
    await expect(connection.setConfigOption(sessionId, 'mode', 'x')).rejects.toThrow()
  })

  it("keeps the models to the scope Kettu's extension reports, and follows a later level", async () => {
    const { connection, spawned, cwd } = await connect({
      script: (pi) => {
        // The extension reports the scope as the session starts, before pi answers a command.
        pi.send({
          type: 'extension_ui_request',
          id: 's',
          method: 'setStatus',
          statusKey: 'kettu.model-scope',
          statusText: JSON.stringify({ models: ['example/big/model'] }),
        })
      },
    })
    const { sessionId, config } = await connection.newSession(cwd)
    // The model in use stays listed beside the scope.
    expect(config[0]!.choices!.map((choice) => choice.value)).toEqual([
      'example/small-model',
      'example/big/model',
    ])
    const scoped = await connection.setConfigOption(sessionId, 'model', 'example/big/model')
    expect(scoped[0]!.choices!.map((choice) => choice.value)).toEqual(['example/big/model'])
    const seen = watch()
    connection.register(sessionId, seen.target)
    spawned[0]!.send({ type: 'thinking_level_changed', level: 'max' })
    await tick()
    expect(seen.thread().session.config[1]).toMatchObject({ id: 'thought_level', value: 'max' })
  })
})

describe('sessions pi keeps', () => {
  it('resumes a session on its file, and one pi never wrote under its id', async () => {
    const setup = await connect()
    const { connection, spawned, cwd } = setup
    const file = await sessionFile(setup, 'pi-session-1')
    await connection.resumeSession('pi-session-1', cwd)
    expect(spawned[0]!.options.args.slice(-2)).toEqual(['--session', file])
    await connection.closeSession('pi-session-1')
    await connection.resumeSession('pi-session-2', cwd)
    expect(spawned[1]!.options.args.slice(-2)).toEqual(['--session-id', 'pi-session-2'])
  })

  it('finds a session made through the adapter by the file its map names', async () => {
    const setup = await connect()
    const { connection, spawned, cwd } = setup
    const elsewhere = path.join(setup.agentDir, '..', 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    const file = path.join(elsewhere, '2026-11-01T09-00-00-000Z_pi-session-1.jsonl')
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', version: 3, id: 'pi-session-1', cwd })}\n`,
    )
    const map = path.join(setup.agentDir, '..', '.pi', 'pi-acp', 'session-map.json')
    await mkdir(path.dirname(map), { recursive: true })
    await writeFile(
      map,
      JSON.stringify({ version: 1, sessions: { 'pi-session-1': { sessionFile: file } } }),
    )
    await connection.resumeSession('pi-session-1', cwd)
    expect(spawned[0]!.options.args.slice(-2)).toEqual(['--session', file])
  })

  it('refuses a resume when pi opened another session than the one asked for', async () => {
    const { connection, spawned, cwd } = await connect({
      script: (pi) => {
        pi.state = { ...pi.state, sessionId: 'someone-else' }
      },
    })
    await expect(connection.resumeSession('pi-session-9', cwd)).rejects.toMatchObject({
      code: -32002,
    })
    await tick()
    expect(spawned[0]!.exitCode).toBe(0)
  })

  it('replays the active branch of a session it loads', async () => {
    const setup = await connect({
      script: (pi) => {
        pi.handlers.get_entries = () => stored
      },
    })
    const { connection, cwd } = setup
    await sessionFile(setup, 'pi-session-1')
    const seen = watch()
    connection.register('pi-session-1', seen.target)
    await connection.loadSession('pi-session-1', cwd)
    const kinds = seen.entries().map((entry) => entry.kind)
    expect(kinds.filter((kind) => kind === 'user')).toHaveLength(3)
    expect(kinds.filter((kind) => kind === 'tool')).toHaveLength(4)
    expect(kinds.at(-1)).toBe('agent')
  })

  it('lists the sessions of a folder, and deletes one with its file', async () => {
    const setup = await connect()
    const { connection, cwd } = setup
    const file = await sessionFile(setup, 'pi-session-7', 'Fix the login page')
    const listed = await connection.listSessions(cwd, null)
    expect(listed).toEqual({
      sessions: [
        {
          sessionId: 'pi-session-7',
          title: 'Fix the login page',
          updatedAt: '2026-11-19T10:00:05.000Z',
          cwd,
        },
      ],
      nextCursor: null,
    })
    const opened = await connection.resumeSession('pi-session-7', cwd)
    expect(opened.config).toHaveLength(2)
    await connection.deleteSession('pi-session-7')
    await expect(stat(file)).rejects.toThrow()
    expect((await connection.listSessions(cwd, null)).sessions).toEqual([])
  })

  it('forks from a copy pi makes, and cuts it at the prompt after the reply', async () => {
    const setup = await connect({
      script: (pi, index) => {
        if (index !== 1) return
        pi.handlers.get_entries = () => stored
        pi.handlers.fork = (command) => {
          pi.state = {
            ...pi.state,
            sessionId: 'pi-cut',
            sessionFile: path.join(setup.agentDir, 'sessions', 'x', 't_pi-cut.jsonl'),
          }
          return { text: String(command.entryId), cancelled: false }
        }
      },
    })
    const { connection, spawned, cwd } = setup
    const source = await sessionFile(setup, 'pi-session-1')
    await connection.resumeSession('pi-session-1', cwd)
    // Where the scripted pi says it wrote the copy it forks from.
    const copy = path.join(setup.agentDir, 'sessions', 'x', 't_pi-session-2.jsonl')
    await mkdir(path.dirname(copy), { recursive: true })
    await writeFile(copy, '{}\n')
    const forked = await connection.forkSession(
      'pi-session-1',
      cwd,
      {},
      {
        messageId: '1795102903400-0',
        text: 'pong',
        occurrence: 1,
      },
    )
    expect(spawned[1]!.options.args.slice(-2)).toEqual(['--fork', source])
    const user = stored.entries.find((entry) =>
      JSON.stringify(entry).includes('Read notes.txt with the read tool'),
    )!
    expect(spawned[1]!.sent('fork')[0]).toMatchObject({ entryId: user.id })
    expect(forked.sessionId).toBe('pi-cut')
    // The whole copy the fork started as is gone; the source is untouched.
    await expect(stat(copy)).rejects.toThrow()
    expect((await stat(source)).isFile()).toBe(true)
  })
})

describe("an extension's dialogs", () => {
  async function ask(
    request: Record<string, unknown>,
    answer: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>,
  ) {
    const setup = await connect()
    const { sessionId } = await setup.connection.newSession(setup.cwd)
    const seen = watch(answer)
    setup.connection.register(sessionId, seen.target)
    const pi = setup.spawned[0]!
    pi.send({ type: 'extension_ui_request', id: 'ui-1', ...request })
    await until(() => seen.asked.length === 1)
    await tick()
    return { ...setup, seen, pi, sessionId, answers: pi.sent('extension_ui_response') }
  }

  it('asks a choice as a question, and answers with the choice as the extension wrote it', async () => {
    const choices = ['1. Staging — safe to break', '2. Production']
    const { seen, answers } = await ask(
      { method: 'select', title: 'Deploy where?', options: choices },
      async () => ({ optionId: 'choice-0' }),
    )
    expect(seen.asked[0]!.options).toEqual([
      { id: 'choice-0', kind: 'allow_once', name: 'Staging', description: 'safe to break' },
      { id: 'choice-1', kind: 'allow_once', name: 'Production' },
    ])
    expect(seen.entries()).toMatchObject([
      { kind: 'tool', id: 't:pi-ui-ui-1', question: 'Deploy where?', status: 'completed' },
    ])
    expect(answers).toEqual([{ type: 'extension_ui_response', id: 'ui-1', value: choices[0] }])
  })

  it('asks a confirmation, and a text as a question the user writes an answer to', async () => {
    const confirm = await ask(
      { method: 'confirm', title: 'Clear session?', message: 'All messages will be lost.' },
      async () => ({ optionId: 'no' }),
    )
    expect(confirm.answers).toEqual([
      { type: 'extension_ui_response', id: 'ui-1', confirmed: false },
    ])
    const input = await ask({ method: 'input', title: 'Branch name' }, async () => ({
      answers: [{ question: 0, choices: [], text: 'fix/login' }],
    }))
    expect(input.seen.asked[0]!.questions).toMatchObject([
      { question: 'Branch name', allowsText: true },
    ])
    expect(input.answers).toEqual([
      { type: 'extension_ui_response', id: 'ui-1', value: 'fix/login' },
    ])
  })

  it('cancels a dialog the user dismissed, and one its run ended', async () => {
    const dismissed = await ask(
      { method: 'select', title: 'Pick', options: ['A'] },
      async () => 'cancelled',
    )
    expect(dismissed.answers).toEqual([
      { type: 'extension_ui_response', id: 'ui-1', cancelled: true },
    ])
    expect(dismissed.seen.entries()).toMatchObject([{ status: 'cancelled' }])
    const waiting = await ask(
      { method: 'select', title: 'Pick', options: ['A'] },
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error))
        }),
    )
    expect(waiting.answers).toEqual([])
    waiting.pi.send({ type: 'agent_start' }, { type: 'agent_settled', aborted: false })
    await until(() => waiting.pi.sent('extension_ui_response').length === 1)
    expect(waiting.pi.sent('extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'ui-1', cancelled: true },
    ])
  })
})

describe("Kettu's own commands for pi", () => {
  it("run through pi's RPC instead of going to the model", async () => {
    const { connection, spawned, cwd } = await connect()
    const { sessionId } = await connection.newSession(cwd)
    const seen = watch()
    connection.register(sessionId, seen.target)
    const pi = spawned[0]!
    pi.handlers.set_session_name = (command) => {
      pi.send({ type: 'session_info_changed', name: command.name })
      return undefined
    }
    pi.handlers.compact = () => {
      pi.send(
        { type: 'compaction_start', reason: 'manual' },
        { type: 'compaction_end', reason: 'manual', result: { summary: 'Earlier: A.' } },
      )
      return { summary: 'Earlier: A.' }
    }
    pi.handlers.set_auto_compaction = () => undefined
    await connection.prompt(sessionId, text('/name Refactor auth'))
    await connection.prompt(sessionId, text('/compact keep the plan'))
    await connection.prompt(sessionId, text('/autocompact off'))
    await connection.prompt(sessionId, text('/session'))
    expect(pi.sent('prompt')).toEqual([])
    expect(pi.sent('set_session_name')[0]).toMatchObject({ name: 'Refactor auth' })
    expect(pi.sent('compact')[0]).toMatchObject({ customInstructions: 'keep the plan' })
    expect(pi.sent('set_auto_compaction')[0]).toMatchObject({ enabled: false })
    expect(seen.thread().session.title).toBe('Refactor auth')
    expect(seen.entries().map((entry) => entry.kind)).toEqual([
      'agent',
      'compaction',
      'agent',
      'agent',
    ])
  })
})
