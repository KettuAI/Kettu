import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentAccount } from '@shared/agent-host'
import {
  applyPatches,
  threadFromSnapshot,
  type SessionView,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type { LaunchSpec } from '../catalog'
import { CLAUDE_CODE } from '../catalog'
import {
  AgentRequestError,
  type PermissionAnswer,
  type PermissionRequest,
  type SessionTarget,
} from '../connection'
import type { HostedContext, HostedSpawnOptions } from '../driver'
import {
  newTurnScope,
  type MapperContext,
  type MapperEffect,
  type MapperOutput,
} from '../session-updates'
import { FakeChild, FakeClaudeSdk, type FakeQuery } from '../testing/fake-claude-sdk'
import { ClaudeConnection, promptContent } from './connection'
import { claudeSdkDriver } from './driver'
import type { SdkMessage, StoredMessage } from './sdk'

const baseSession: SessionView = {
  id: 'k1',
  agentId: 'claude-code',
  projectPath: '/repo',
  acpSessionId: null,
  status: 'ready',
  title: null,
  config: [],
  commands: [],
  usage: null,
  error: null,
  turnStartedAt: null,
  turnStartUsed: null,
  createdAt: 1,
  updatedAt: 1,
  parentId: null,
  origin: 'user',
  subagent: null,
  routine: null,
  queue: [],
  queuePaused: false,
}

interface Asked {
  request: PermissionRequest
  signal: AbortSignal
  answer(value: PermissionAnswer): void
}

class Target implements SessionTarget {
  thread: ThreadState = threadFromSnapshot({ session: baseSession, entries: [], seq: 0 })
  effects: MapperEffect[] = []
  replaying = false
  readonly asked: Asked[] = []
  private readonly scope = newTurnScope()
  private counter = 0

  context(): MapperContext {
    return {
      thread: this.thread,
      replaying: this.replaying,
      thoughtParts: false,
      cancelling: false,
      scope: this.scope,
      now: 1_000,
      nextId: () => `e:${++this.counter}`,
      sessionIdFor: (id) => `kettu-${id}`,
    }
  }

  apply(output: MapperOutput): void {
    this.thread = applyPatches(this.thread, output.patches)
    this.effects.push(...output.effects)
  }

  requestPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    this.apply(request.output)
    return new Promise((resolve, reject) => {
      this.asked.push({ request, signal, answer: resolve })
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }

  entries(): ThreadEntry[] {
    return this.thread.order.map((id) => this.thread.byId[id]!)
  }

  entry(id: string): ThreadEntry | undefined {
    return this.thread.byId[id]
  }
}

async function setup(env: Record<string, string> = {}, spec: Partial<LaunchSpec> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-claude-sdk-'))
  const entry = path.join(dir, 'sdk.mjs')
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '0.3.314' }))
  const sdk = new FakeClaudeSdk()
  const spawned: HostedSpawnOptions[] = []
  const children: FakeChild[] = []
  const accounts: AgentAccount[] = []
  const ignored: string[] = []
  const loaded: string[] = []
  const context: HostedContext = {
    def: CLAUDE_CODE,
    hooks: {
      traffic: () => {},
      account: (account) => accounts.push(account),
      ignored: (_id, what) => ignored.push(what),
      log: () => {},
    },
    spec: {
      command: entry,
      args: [],
      env: { CLAUDE_CODE_EXECUTABLE: '/opt/claude/bin/claude' },
      shell: false,
      display: { command: entry, args: [], env: {} },
      ...spec,
    },
    env: { PATH: '/usr/bin', HOME: '/home/ada', ...env },
    spawn: (options) => {
      spawned.push(options)
      const child = new FakeChild()
      children.push(child)
      return child as never
    },
  }
  const driver = claudeSdkDriver(async (file) => {
    loaded.push(file)
    return sdk
  })
  const connection = driver.connect(context)
  const init = await connection.initialize('1.0.0')
  return {
    sdk,
    connection,
    spawned,
    children,
    accounts,
    ignored,
    entry,
    init,
    loaded,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

function assistant(query: FakeQuery, id: string, content: unknown[], extra = {}): SdkMessage {
  return {
    type: 'assistant',
    message: { id, model: 'claude-opus-5', content },
    parent_tool_use_id: null,
    uuid: `uuid-${id}`,
    session_id: query.sessionId,
    ...extra,
  } as SdkMessage
}

function stream(query: FakeQuery, event: unknown, extra = {}): SdkMessage {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    session_id: query.sessionId,
    ...extra,
  } as SdkMessage
}

describe('the Claude Agent SDK driver', () => {
  it('answers initialize from the SDK it loads, without starting Claude Code', async () => {
    const { init, spawned, loaded, entry, sdk } = await setup()
    expect(loaded).toEqual([entry])
    expect(spawned).toEqual([])
    expect(sdk.queries).toEqual([])
    expect(init).toMatchObject({
      version: '0.3.314',
      capabilities: {
        loadSession: true,
        resumeSession: true,
        forkAtMessage: true,
        ownTitles: 'sent',
        steering: true,
        mcpHttp: true,
        prompt: { image: true, audio: false, embeddedContext: true },
      },
      authMethods: [
        {
          id: 'claude-ai-login',
          type: 'terminal',
          command: '/opt/claude/bin/claude',
          args: ['auth', 'login', '--claudeai'],
        },
        { id: 'console-login', args: ['auth', 'login', '--console'] },
      ],
    })
  })

  it("signs in with Claude Code's own login over SSH, whose browser is elsewhere", async () => {
    const { init } = await setup({ SSH_CONNECTION: '10.0.0.1 22' })
    expect(init).toMatchObject({ authMethods: [{ id: 'claude-login', args: [] }] })
  })

  it('opens a session as a query with the agent environment and Claude Code spawned by the host', async () => {
    const { sdk, connection, spawned } = await setup({
      CLAUDE_CONFIG_DIR: '/home/ada/.claude-work',
    })
    sdk.settings = { permissions: { defaultMode: 'acceptEdits' }, effortLevel: 'high' }
    const opened = await connection.newSession('/repo', {
      mcpServers: [
        {
          type: 'http',
          name: 'kettu',
          url: 'http://127.0.0.1:9/mcp',
          headers: [{ name: 'X-Key', value: 'k' }],
        },
      ],
      ultracode: true,
    })
    const { options } = sdk.last
    expect(options).toMatchObject({
      cwd: '/repo',
      sessionId: opened.sessionId,
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      permissionMode: 'acceptEdits',
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      mcpServers: {
        kettu: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Key': 'k' } },
      },
      settings: { ultracode: true },
      extraArgs: { 'replay-user-messages': null },
      disallowedTools: ['AskUserQuestion'],
    })
    expect(options.env).toMatchObject({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/home/ada/.claude-work',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    })
    expect(options.persistSession).toBeUndefined()
    expect(spawned).toEqual([
      expect.objectContaining({
        command: '/opt/claude/bin/claude',
        args: ['--output-format', 'stream-json'],
        cwd: '/repo',
        env: options.env,
        signal: expect.any(AbortSignal),
      }),
    ])
    // The options keep the adapter's ids and values, so a thread's stored ones still apply.
    expect(opened.config.map((option) => [option.id, option.value])).toEqual([
      ['mode', 'acceptEdits'],
      ['model', 'default'],
      ['effort', 'high'],
      ['fast', false],
    ])
    expect(opened.config[0]!.choices!.map((choice) => choice.value)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      ...(process.getuid?.() === 0 ? [] : ['bypassPermissions']),
    ])
  })

  it('reports the account the session runs under', async () => {
    const { connection, accounts } = await setup()
    await connection.newSession('/repo')
    await connection.newSession('/repo')
    expect(accounts).toEqual([{ kind: 'account', label: 'Claude Max', email: 'ada@example.com' }])
  })

  it('lists the commands Kettu can run, without the terminal ones', async () => {
    const { sdk, connection } = await setup()
    const target = new Target()
    const { sessionId } = await connection.newSession('/repo')
    connection.register(sessionId, target)
    expect(target.thread.session.commands).toEqual([
      { name: 'review', description: 'Review a pull request', inputHint: '<number>' },
      { name: 'statusline', description: 'Set up the status line' },
    ])
    sdk.last.emit({
      type: 'system',
      subtype: 'init',
      terminal_slash_commands: ['statusline'],
      session_id: sessionId,
    } as SdkMessage)
    await settle()
    expect(target.thread.session.commands.map((command) => command.name)).toEqual(['review'])
  })
})

describe('a turn', () => {
  let s: Awaited<ReturnType<typeof setup>>
  let target: Target
  let sessionId: string

  beforeEach(async () => {
    s = await setup()
    target = new Target()
    sessionId = (await s.connection.newSession('/repo')).sessionId
    s.connection.register(sessionId, target)
  })

  it('streams the reply and ends with the tokens of the turn, by model', async () => {
    s.sdk.script = (query) => {
      query.running()
      query.emit(
        stream(query, {
          type: 'message_start',
          message: { id: 'msg_1', usage: { input_tokens: 3, cache_read_input_tokens: 1000 } },
        }),
        stream(query, {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'Plan' },
        }),
        stream(query, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }),
        stream(query, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }),
        assistant(query, 'msg_1', [
          { type: 'thinking', thinking: 'Plan' },
          { type: 'text', text: 'Hello' },
        ]),
      )
      query.finish({
        usage: {
          input_tokens: 3,
          output_tokens: 7,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 20,
        },
        modelUsage: {
          'claude-opus-5': {
            inputTokens: 3,
            outputTokens: 7,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 20,
            contextWindow: 1_000_000,
          },
          'claude-haiku-5': {
            inputTokens: 50,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 200_000,
          },
        },
        total_cost_usd: 0.25,
      })
    }
    const result = await s.connection.prompt(sessionId, [{ type: 'text', text: 'Hi' }])
    expect(result).toEqual({
      stopReason: 'end_turn',
      tokens: { total: 1030, input: 3, output: 7, thought: null, cacheRead: 1000, cacheWrite: 20 },
      models: [
        {
          model: 'claude-opus-5',
          tokens: {
            total: 1030,
            input: 3,
            output: 7,
            thought: null,
            cacheRead: 1000,
            cacheWrite: 20,
          },
        },
        {
          model: 'claude-haiku-5',
          tokens: { total: 55, input: 50, output: 5, thought: null, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    })
    expect(target.entries()).toMatchObject([
      { kind: 'thought', id: 'm:msg_1', markdown: 'Plan' },
      { kind: 'agent', id: 'm:msg_1#agent', markdown: 'Hello', streaming: true },
    ])
    expect(target.thread.session.usage).toMatchObject({
      used: 1003,
      size: 1_000_000,
      cost: { amount: 0.25, currency: 'USD' },
    })
    expect(target.effects).toContainEqual({ kind: 'request' })
    expect(s.sdk.last.inputs[0]!.message.content).toEqual([{ type: 'text', text: 'Hi' }])
  })

  it("counts each turn's own spend from the running totals", async () => {
    let turn = 0
    s.sdk.script = (query) => {
      turn++
      query.running()
      query.emit(assistant(query, `msg_${turn}`, [{ type: 'text', text: 'ok' }]))
      query.finish({
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          'claude-opus-5': {
            inputTokens: turn * 10,
            outputTokens: turn,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      })
    }
    await s.connection.prompt(sessionId, [{ type: 'text', text: 'one' }])
    const second = await s.connection.prompt(sessionId, [{ type: 'text', text: 'two' }])
    expect(second.models).toEqual([
      {
        model: 'claude-opus-5',
        tokens: { total: 11, input: 10, output: 1, thought: null, cacheRead: 0, cacheWrite: 0 },
      },
    ])
  })

  it("takes the first result after a resume as the history's totals", async () => {
    const resumed = new Target()
    await s.connection.resumeSession('old-session', '/repo')
    s.connection.register('old-session', resumed)
    s.sdk.script = (query) => {
      query.running()
      query.emit(assistant(query, 'msg_9', [{ type: 'text', text: 'ok' }]))
      query.finish({
        usage: { input_tokens: 4, output_tokens: 2 },
        modelUsage: {
          'claude-opus-5': {
            inputTokens: 9000,
            outputTokens: 900,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      })
    }
    const result = await s.connection.prompt('old-session', [{ type: 'text', text: 'again' }])
    expect(result.models).toEqual([
      {
        model: 'claude-opus-5',
        tokens: { total: 6, input: 4, output: 2, thought: null, cacheRead: 0, cacheWrite: 0 },
      },
    ])
  })

  it('shows a tool call with its input, then its result', async () => {
    s.sdk.script = (query) => {
      query.running()
      query.emit(
        stream(query, { type: 'message_start', message: { id: 'msg_1' } }),
        stream(query, {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
        }),
        assistant(query, 'msg_1', [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'ls', description: 'List files' },
          },
        ]),
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.ts\nb.ts' }],
          },
          parent_tool_use_id: null,
          tool_use_result: { stdout: 'a.ts\nb.ts', stderr: '', interrupted: false },
          session_id: query.sessionId,
        } as SdkMessage,
      )
      query.finish()
    }
    await s.connection.prompt(sessionId, [{ type: 'text', text: 'ls' }])
    expect(target.entry('t:toolu_1')).toMatchObject({
      kind: 'tool',
      title: 'ls',
      toolKind: 'execute',
      status: 'completed',
      rawInput: 'ls',
      description: 'List files',
      content: [{ type: 'markdown', markdown: '```console\na.ts\nb.ts\n```' }],
    })
    expect(target.effects.filter((effect) => effect.kind === 'tool')).toMatchObject([
      { phase: 'started', toolCallId: 'toolu_1' },
      { phase: 'ended', toolCallId: 'toolu_1', output: '```console\na.ts\nb.ts\n```' },
    ])
  })

  it('shows TodoWrite as the plan', async () => {
    s.sdk.script = (query) => {
      query.running()
      query.emit(
        assistant(query, 'msg_1', [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Read', status: 'completed' },
                { content: 'Fix', status: 'in_progress' },
              ],
            },
          },
        ]),
      )
      query.finish()
    }
    await s.connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
    expect(target.entries()).toMatchObject([
      {
        kind: 'plan',
        items: [
          { content: 'Read', status: 'completed', priority: 'medium' },
          { content: 'Fix', status: 'in_progress', priority: 'medium' },
        ],
      },
    ])
  })

  it('fails a turn that needs a sign-in, and reads the sign-in again before the next one', async () => {
    s.sdk.script = (query) => {
      query.running()
      query.emit({
        type: 'assistant',
        message: {
          id: 'msg_x',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
        parent_tool_use_id: null,
        error: 'authentication_failed',
        uuid: 'u-x',
        session_id: query.sessionId,
      } as SdkMessage)
      query.finish({
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
      })
    }
    const failed = s.connection.prompt(sessionId, [{ type: 'text', text: 'Hi' }])
    await expect(failed).rejects.toMatchObject({
      kind: 'auth_required',
      message: 'Not logged in · Please run /login',
    })
    expect(target.entries()).toEqual([])
    s.sdk.script = new FakeClaudeSdk().script
    const before = s.sdk.queries.length
    await s.connection.prompt(sessionId, [{ type: 'text', text: 'Hi' }])
    expect(s.sdk.queries.length).toBe(before + 1)
    expect(s.sdk.last.options.resume).toBe(sessionId)
  })

  it('passes an error result on as the turn failing', async () => {
    s.sdk.script = (query) => {
      query.running()
      query.finish({ subtype: 'success', is_error: true, result: 'Credit balance is too low' })
    }
    await expect(
      s.connection.prompt(sessionId, [{ type: 'text', text: 'Hi' }]),
    ).rejects.toMatchObject({
      kind: 'agent_error',
      message: 'Credit balance is too low',
    })
  })

  it('steers a running turn, and leaves a message with no turn to Kettu', async () => {
    expect(await s.connection.steer(sessionId, [{ type: 'text', text: 'also' }])).toBe(
      'promptRequired',
    )
    let query!: FakeQuery
    s.sdk.script = (q) => {
      query = q
      if (q.inputs.length === 1) q.running()
    }
    const turn = s.connection.prompt(sessionId, [{ type: 'text', text: 'start' }])
    await settle()
    expect(await s.connection.steer(sessionId, [{ type: 'text', text: 'also' }])).toBe('injected')
    await settle()
    expect(query.inputs[1]).toMatchObject({
      priority: 'now',
      message: { content: [{ type: 'text', text: 'also' }] },
    })
    // The steering stops the part that ran, whose result says so; the turn runs on after it.
    query.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: null,
      terminal_reason: 'aborted_streaming',
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      session_id: query.sessionId,
    } as SdkMessage)
    query.finish()
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('interrupts a turn that is stopped, which ends cancelled', async () => {
    s.sdk.script = (query) => query.running()
    s.sdk.onInterrupt = (query) => query.finish({ terminal_reason: 'aborted_streaming' })
    const turn = s.connection.prompt(sessionId, [{ type: 'text', text: 'long' }])
    await settle()
    await s.connection.cancel(sessionId)
    await expect(turn).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(s.sdk.last.calls.map((call) => call.method)).toContain('interrupt')
  })

  it('fails the running turn when Claude Code ends, and opens it again for the next', async () => {
    s.sdk.script = (query) => {
      query.running()
      query.close()
    }
    await expect(
      s.connection.prompt(sessionId, [{ type: 'text', text: 'Hi' }]),
    ).rejects.toBeInstanceOf(AgentRequestError)
    s.sdk.script = new FakeClaudeSdk().script
    await expect(
      s.connection.prompt(sessionId, [{ type: 'text', text: 'Hi' }]),
    ).resolves.toMatchObject({
      stopReason: 'end_turn',
    })
  })

  it('titles the session from the title Claude Code stored, or one it generates once', async () => {
    s.sdk.generatedTitle = 'Fix the flaky login test'
    await s.connection.prompt(sessionId, [{ type: 'text', text: 'The login test fails at random' }])
    await settle()
    expect(target.thread.session.title).toBe('Fix the flaky login test')
    expect(target.effects).toContainEqual({ kind: 'title', title: 'Fix the flaky login test' })
    s.sdk.infos.set(sessionId, { sessionId, summary: 'x', lastModified: 1, customTitle: 'Renamed' })
    await s.connection.prompt(sessionId, [{ type: 'text', text: 'more' }])
    await settle()
    expect(s.sdk.last.calls.filter((call) => call.method === 'generateSessionTitle')).toHaveLength(
      1,
    )
  })

  it('asks for a title again after a turn whose text gave none', async () => {
    await s.connection.prompt(sessionId, [{ type: 'text', text: 'Hello there, Claude' }])
    await settle()
    expect(target.thread.session.title).toBeNull()
    s.sdk.generatedTitle = 'Greeting'
    await s.connection.prompt(sessionId, [{ type: 'text', text: 'And again' }])
    await settle()
    expect(target.thread.session.title).toBe('Greeting')
    expect(s.sdk.last.calls.filter((call) => call.method === 'generateSessionTitle')).toHaveLength(
      2,
    )
  })

  it('takes a failed authentication as a sign-in Claude Code needs', async () => {
    s.sdk.script = (query) => {
      query.running()
      query.emit({
        type: 'assistant',
        message: {
          id: 'msg_y',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401' }],
        },
        parent_tool_use_id: null,
        error: 'authentication_failed',
        uuid: 'u-y',
        session_id: query.sessionId,
      } as SdkMessage)
      query.finish({ is_error: true, result: 'Failed to authenticate. API Error: 401' })
    }
    await expect(
      s.connection.prompt(sessionId, [{ type: 'text', text: 'Hi' }]),
    ).rejects.toMatchObject({ kind: 'auth_required' })
  })

  it('deletes a session once its Claude Code has exited, which writes it last', async () => {
    const deleted = s.connection.deleteSession(sessionId)
    await settle()
    expect(s.sdk.calls.map((call) => call.method)).not.toContain('deleteSession')
    s.children[0]!.emit('exit', 0)
    await deleted
    expect(s.sdk.calls.find((call) => call.method === 'deleteSession')?.args).toEqual([
      sessionId,
      { dir: '/repo' },
    ])
  })

  it('sets the options through the query, sending ultracode again with the effort', async () => {
    const query = s.sdk.last
    await s.connection.resumeSession(sessionId, '/repo', { ultracode: true })
    let config = await s.connection.setConfigOption(sessionId, 'effort', 'low')
    expect(config.find((option) => option.id === 'effort')?.value).toBe('low')
    await s.connection.setConfigOption(sessionId, 'effort', 'default')
    config = await s.connection.setConfigOption(sessionId, 'model', 'haiku')
    expect(config.map((option) => option.id)).toEqual(['mode', 'model'])
    await s.connection.setConfigOption(sessionId, 'mode', 'plan')
    expect(query.calls.filter((call) => call.method !== 'initializationResult')).toEqual([
      { method: 'applyFlagSettings', args: [{ ultracode: true }] },
      { method: 'applyFlagSettings', args: [{ effortLevel: 'low', ultracode: true }] },
      { method: 'applyFlagSettings', args: [{ effortLevel: null, ultracode: true }] },
      { method: 'setModel', args: ['haiku'] },
      { method: 'setPermissionMode', args: ['plan'] },
    ])
    await expect(s.connection.setConfigOption(sessionId, 'mode', 'nope')).rejects.toBeInstanceOf(
      AgentRequestError,
    )
  })
})

describe('permissions', () => {
  let s: Awaited<ReturnType<typeof setup>>
  let target: Target
  let sessionId: string

  beforeEach(async () => {
    s = await setup()
    target = new Target()
    sessionId = (await s.connection.newSession('/repo')).sessionId
    s.connection.register(sessionId, target)
  })

  function ask(signal = new AbortController().signal) {
    return s.sdk.last.options.canUseTool!(
      'Bash',
      { command: 'npm test' },
      {
        signal,
        toolUseID: 'toolu_7',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      },
    )
  }

  it('asks with allow once, always allow naming its rule and where, and reject', async () => {
    const answer = ask()
    await settle()
    expect(target.asked[0]!.request).toMatchObject({
      toolCallId: 'toolu_7',
      toolEntryId: 't:toolu_7',
      options: [
        { id: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        {
          id: 'allow-with-updates',
          name: 'Always allow Bash(npm test:*) in local settings (.claude/settings.local.json)',
          kind: 'allow_always',
        },
        { id: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })
    expect(target.entry('t:toolu_7')).toMatchObject({
      kind: 'tool',
      title: 'npm test',
      status: 'pending',
    })
    target.asked[0]!.answer({ optionId: 'allow-once' })
    expect(await answer).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
      toolUseID: 'toolu_7',
    })
    expect(target.entry('t:toolu_7')).toMatchObject({ status: 'in_progress' })
  })

  it('adds the suggested rules for always allow, and denies a rejection or a cancel', async () => {
    let answer = ask()
    await settle()
    target.asked[0]!.answer({ optionId: 'allow-with-updates' })
    expect(await answer).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules', destination: 'localSettings' }],
    })
    answer = ask()
    await settle()
    target.asked[1]!.answer({ optionId: 'reject' })
    expect(await answer).toMatchObject({ behavior: 'deny' })
    answer = ask()
    await settle()
    target.asked[2]!.answer('cancelled')
    expect(await answer).toMatchObject({ behavior: 'deny' })
  })

  it('withdraws a request Claude Code no longer waits for', async () => {
    const abort = new AbortController()
    const answer = ask(abort.signal)
    await settle()
    abort.abort(new Error('interrupted'))
    expect(await answer).toMatchObject({ behavior: 'deny' })
  })

  it("offers no always allow that Claude Code holds back, nor for a plan's approval", async () => {
    const suppressed = s.sdk.last.options.canUseTool!(
      'Bash',
      { command: 'rm -rf x' },
      {
        signal: new AbortController().signal,
        toolUseID: 'toolu_8',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash' }],
            behavior: 'allow',
            destination: 'userSettings',
          },
        ],
        suppressAlwaysAllowRule: true,
      },
    )
    await settle()
    expect(target.asked[0]!.request.options.map((option) => option.kind)).toEqual([
      'allow_once',
      'reject_once',
    ])
    target.asked[0]!.answer({ optionId: 'reject' })
    await suppressed
    const plan = s.sdk.last.options.canUseTool!(
      'ExitPlanMode',
      { plan: 'Do it' },
      {
        signal: new AbortController().signal,
        toolUseID: 'toolu_9',
      },
    )
    await settle()
    expect(target.asked[1]!.request.options.map((option) => option.id)).toEqual([
      'exit-plan-auto',
      'exit-plan-accept-edits',
      'exit-plan-default',
      'reject',
    ])
    target.asked[1]!.answer({ optionId: 'exit-plan-accept-edits' })
    expect(await plan).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
  })
})

describe('sessions', () => {
  it('replays a history into the thread, images and file links included', async () => {
    const s = await setup()
    const history: StoredMessage[] = [
      {
        type: 'user',
        uuid: 'u1',
        session_id: 'h1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
            },
            { type: 'text', text: '[@a.ts](file:///repo/a.ts)' },
            { type: 'text', text: '\n<context ref="file:///repo/a.ts">\nconst a = 1\n</context>' },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 'h1',
        parent_tool_use_id: null,
        message: {
          id: 'msg_1',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/a.ts' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        session_id: 'h1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1\tconst a = 1' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        session_id: 'h1',
        parent_tool_use_id: null,
        message: { id: 'msg_2', content: [{ type: 'text', text: 'It sets a.' }] },
      },
    ]
    s.sdk.history.set('h1', history)
    const target = new Target()
    target.replaying = true
    s.connection.register('h1', target)
    await s.connection.loadSession('h1', '/repo')
    expect(s.sdk.last.options.resume).toBe('h1')
    const entries = target.entries()
    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ['user', 'm:u1'],
      ['tool', 't:toolu_1'],
      ['agent', 'm:msg_2'],
    ])
    expect(entries[0]).toMatchObject({
      content: [
        { type: 'text', text: 'Look at this' },
        {
          type: 'ref',
          ref: {
            kind: 'attachment',
            attachment: { type: 'image', sent: 'image', mimeType: 'image/png' },
          },
        },
        {
          type: 'ref',
          ref: { kind: 'attachment', attachment: { type: 'file', name: 'a.ts', sent: 'embedded' } },
        },
      ],
    })
    expect(target.effects).toContainEqual(
      expect.objectContaining({ kind: 'replayImage', entryId: 'm:u1', data: 'iVBORw0KGgo=' }),
    )
    expect(entries[1]).toMatchObject({ title: 'Read a.ts', status: 'completed' })
    expect(entries[2]).toMatchObject({ markdown: 'It sets a.', streaming: false })
  })

  it('cannot resume a session with no history, which the host starts again', async () => {
    const s = await setup()
    s.sdk.initError = () => new Error('No conversation found with session ID: gone')
    const error = await s.connection.resumeSession('gone', '/repo').catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'agent_error', code: -32002 })
  })

  it('forks from a reply by its message, as this connection or the history knows it', async () => {
    const s = await setup()
    const target = new Target()
    const { sessionId } = await s.connection.newSession('/repo')
    s.connection.register(sessionId, target)
    await s.connection.prompt(sessionId, [{ type: 'text', text: 'Hi' }])
    await s.connection.forkSession(
      sessionId,
      '/repo',
      {},
      { messageId: 'msg_1', text: 'Done.', occurrence: 1 },
    )
    expect(s.sdk.calls.find((call) => call.method === 'forkSession')?.args).toEqual([
      sessionId,
      { dir: '/repo', upToMessageId: 'uuid-1' },
    ])
    expect(s.sdk.last.options.resume).toBe(`fork-of-${sessionId}`)
  })

  it('finds the message an adapter-era thread names by its text and occurrence', async () => {
    const s = await setup()
    const reply = (uuid: string, id: string, text: string): StoredMessage => ({
      type: 'assistant',
      uuid,
      session_id: 'old',
      parent_tool_use_id: null,
      message: { id, content: [{ type: 'text', text }] },
    })
    s.sdk.history.set('old', [reply('a1', 'msg_a', 'Done.'), reply('a2', 'msg_b', 'Done.')])
    await s.connection.forkSession(
      'old',
      '/repo',
      {},
      { messageId: 'acp-7', text: 'Done.', occurrence: 2 },
    )
    expect(s.sdk.calls.find((call) => call.method === 'forkSession')?.args[1]).toEqual({
      dir: '/repo',
      upToMessageId: 'a2',
    })
    await expect(
      s.connection.forkSession(
        'old',
        '/repo',
        {},
        { messageId: 'acp-8', text: 'Other', occurrence: 1 },
      ),
    ).rejects.toBeInstanceOf(AgentRequestError)
  })

  it('opens a hidden session that keeps no history and runs no hooks, and removes it', async () => {
    const s = await setup()
    const { sessionId } = await s.connection.newSession('/repo', { hidden: 'titles' })
    const query = s.sdk.last
    expect(query.options).toMatchObject({
      persistSession: false,
      settingSources: [],
      settings: { disableAllHooks: true },
    })
    await s.connection.removeHidden(sessionId, () => {})
    expect(query.closed).toBe(true)
    expect(s.sdk.calls.map((call) => call.method)).not.toContain('deleteSession')
  })

  it('collects the text of a hidden turn', async () => {
    const s = await setup()
    const { sessionId } = await s.connection.newSession('/repo', { hidden: 'titles' })
    expect(await s.connection.collect(sessionId, 'Title these')).toEqual(['Done.'])
  })

  it('reads the SDK history with the agent configuration folder', async () => {
    const s = await setup({ CLAUDE_CONFIG_DIR: '/home/ada/.claude-work' })
    const before = process.env.CLAUDE_CONFIG_DIR
    await s.connection.loadSession('none', '/repo').catch(() => {})
    expect(s.sdk.calls.find((call) => call.method === 'getSessionMessages')?.args[2]).toBe(
      '/home/ada/.claude-work',
    )
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(before)
  })

  it('lists and deletes sessions in the project folder', async () => {
    const s = await setup()
    s.sdk.infos.set('a', { sessionId: 'a', summary: 'First prompt', lastModified: 5, cwd: '/repo' })
    s.sdk.infos.set('b', { sessionId: 'b', summary: 'x', customTitle: 'Named', lastModified: 6 })
    expect(await s.connection.listSessions('/repo', null)).toEqual({
      sessions: [
        {
          sessionId: 'a',
          title: 'First prompt',
          updatedAt: new Date(5).toISOString(),
          cwd: '/repo',
        },
        { sessionId: 'b', title: 'Named', updatedAt: new Date(6).toISOString(), cwd: '/repo' },
      ],
      nextCursor: null,
    })
    await s.connection.deleteSession('a')
    expect(s.sdk.calls.find((call) => call.method === 'deleteSession')?.args[0]).toBe('a')
  })
})

describe('subagents', () => {
  it("shows a subagent as a session of its own, with its parent's prompt", async () => {
    const s = await setup()
    const parent = new Target()
    const child = new Target()
    const { sessionId } = await s.connection.newSession('/repo')
    s.connection.register(sessionId, parent)
    let query!: FakeQuery
    s.sdk.script = (q) => {
      query = q
      q.running()
      q.emit(
        assistant(q, 'msg_1', [
          {
            type: 'tool_use',
            id: 'toolu_a',
            name: 'Agent',
            input: { description: 'Explore', prompt: 'Find it' },
          },
        ]),
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-1',
          tool_use_id: 'toolu_a',
          description: 'Explore',
          subagent_type: 'Explore',
          task_type: 'local_agent',
          prompt: 'Find it',
          session_id: q.sessionId,
        } as SdkMessage,
      )
    }
    const turn = s.connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
    await settle()
    expect(parent.entries()).toEqual([])
    expect(parent.effects).toContainEqual({
      kind: 'subagent',
      sessionId: 'task-1',
      title: 'Explore',
      description: 'Explore',
      canCancel: true,
      state: { kind: 'running' },
    })
    s.connection.register('task-1', child)
    expect(s.connection.rootOf('task-1')).toBe(sessionId)
    expect(child.entries()).toMatchObject([
      {
        kind: 'session_message',
        id: 'sm:toolu_a',
        senderId: `kettu-${sessionId}`,
        content: [{ type: 'text', text: 'Find it' }],
      },
    ])
    query.emit(
      assistant(query, 'msg_c', [{ type: 'text', text: 'Found' }], {
        parent_tool_use_id: 'toolu_a',
        agent_id: 'task-1',
      }),
    )
    await settle()
    expect(child.entry('m:msg_c')).toMatchObject({ kind: 'agent', markdown: 'Found' })
    await s.connection.cancel('task-1')
    expect(query.calls).toContainEqual({ method: 'stopTask', args: ['task-1'] })
    query.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      status: 'stopped',
      summary: 'Stopped',
      output_file: '',
      session_id: query.sessionId,
    } as SdkMessage)
    query.finish()
    await turn
    expect(parent.effects).toContainEqual(
      expect.objectContaining({
        kind: 'subagent',
        sessionId: 'task-1',
        state: expect.objectContaining({ kind: 'idle', stopReason: 'cancelled' }),
      }),
    )
  })

  it("replays a subagent's history into its session", async () => {
    const s = await setup()
    s.sdk.history.set('h2', [
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 'h2',
        parent_tool_use_id: null,
        message: {
          id: 'msg_1',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_s',
              name: 'Agent',
              input: { description: 'Look', prompt: 'Look around' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        session_id: 'h2',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_s',
              content: 'Report\nagentId: agent-9 (use SendMessage)',
            },
          ],
        },
      },
    ])
    s.sdk.subagentHistory.set('agent-9', [
      {
        type: 'user',
        uuid: 's1',
        session_id: 'h2',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'Look around' },
      },
      {
        type: 'assistant',
        uuid: 's2',
        session_id: 'h2',
        parent_tool_use_id: null,
        message: { id: 'msg_s', content: [{ type: 'text', text: 'Seen' }] },
      },
    ])
    const parent = new Target()
    const child = new Target()
    parent.replaying = true
    child.replaying = true
    s.connection.register('h2', parent)
    s.connection.register('agent-9', child)
    await s.connection.loadSession('h2', '/repo')
    expect(parent.entries()).toEqual([])
    expect(parent.effects).toContainEqual(
      expect.objectContaining({ kind: 'subagent', sessionId: 'agent-9', title: 'Look' }),
    )
    expect(child.entries()).toMatchObject([
      { kind: 'session_message', id: 'sm:toolu_s', senderId: 'kettu-h2' },
      { kind: 'agent', id: 'm:msg_s', markdown: 'Seen' },
    ])
  })
})

describe('reports', () => {
  it('reads the plan limits in a query that keeps nothing, when no session is open', async () => {
    const s = await setup()
    const limits = await s.connection.readLimits!()
    expect(limits).toMatchObject([
      {
        window: 'five_hour',
        label: '5-hour',
        usedPercent: 42,
        resetsAt: Date.parse('2026-10-30T18:00:00.000Z'),
      },
      { window: 'seven_day', label: 'Weekly', usedPercent: 7 },
      { window: 'seven_day_opus', label: 'Weekly · Opus', usedPercent: 12, resetsAt: null },
    ])
    const query = s.sdk.last
    expect(query.options).toMatchObject({ persistSession: false, settingSources: [] })
    expect(query.calls).toContainEqual({ method: 'usage', args: [{ skipBehaviors: true }] })
    expect(query.closed).toBe(true)
  })

  it('gives no limits for an account without them', async () => {
    const s = await setup()
    s.sdk.usage = { rate_limits_available: false, rate_limits: null }
    expect(await s.connection.readLimits!()).toEqual([])
  })

  it("reads a session's context from its query, in the report's terms", async () => {
    const s = await setup()
    const { sessionId } = await s.connection.newSession('/repo')
    const breakdown = await s.connection.readContext!(sessionId, '/repo', {})
    expect(breakdown).toMatchObject({
      model: 'claude-opus-5',
      used: 10_000,
      size: 200_000,
      categories: [
        { name: 'System prompt', tokens: 3000, share: 0.015 },
        { name: 'Messages', tokens: 7000, share: 0.035 },
        { name: 'Free space', tokens: 190_000, share: 0.95 },
      ],
      lists: [
        {
          name: 'MCP Tools',
          items: [{ name: 'mcp__kettu__show', detail: 'kettu', tokens: '310' }],
        },
        {
          name: 'Memory Files',
          items: [{ name: 'Project', detail: '/repo/CLAUDE.md', tokens: '1.2k' }],
        },
        { name: 'Skills', items: [{ name: 'review', detail: 'project', tokens: '45' }] },
      ],
    })
    expect(s.sdk.last.calls).toContainEqual({
      method: 'getContextUsage',
      args: [{ detail: 'summary' }],
    })
  })

  it('reads a closed session in a fork that keeps nothing', async () => {
    const s = await setup()
    await s.connection.readContext!('closed-one', '/repo', {})
    expect(s.sdk.last.options).toMatchObject({
      resume: 'closed-one',
      forkSession: true,
      persistSession: false,
    })
    expect(s.sdk.last.closed).toBe(true)
  })
})

describe('signing out', () => {
  it("runs Claude Code's logout through the host, and says why one failed", async () => {
    const s = await setup()
    const logout = s.connection.logout()
    await settle()
    expect(s.spawned).toEqual([
      expect.objectContaining({ command: '/opt/claude/bin/claude', args: ['auth', 'logout'] }),
    ])
    expect(s.spawned[0]!.env).toMatchObject({ PATH: '/usr/bin' })
    s.children[0]!.emit('exit', 0)
    await expect(logout).resolves.toBeUndefined()
    const failing = s.connection.logout()
    await settle()
    s.children[1]!.stderr.write('Could not reach the keychain\n')
    await settle()
    s.children[1]!.emit('exit', 1)
    await expect(failing).rejects.toMatchObject({ message: 'Could not reach the keychain' })
  })
})

describe('prompt content', () => {
  it('sends images as base64 and files as links, an embedded one with its text', () => {
    expect(
      promptContent([
        { type: 'text', text: 'See' },
        { type: 'image', mimeType: 'image/png', data: 'AAA' },
        { type: 'resource_link', uri: 'file:///repo/b.bin', name: 'b.bin' },
        {
          type: 'resource',
          resource: { uri: 'file:///repo/a.ts', mimeType: 'text/plain', text: 'x' },
        },
      ]),
    ).toEqual([
      { type: 'text', text: 'See' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: '[@b.bin](file:///repo/b.bin)' },
      { type: 'text', text: '[@a.ts](file:///repo/a.ts)' },
      { type: 'text', text: '\n<context ref="file:///repo/a.ts">\nx\n</context>' },
    ])
  })
})

describe('the connection', () => {
  it('ends every query when it closes', async () => {
    const s = await setup()
    await s.connection.newSession('/repo')
    s.connection.close()
    await s.connection.closed
    expect(s.sdk.last.closed).toBe(true)
    expect(s.connection.isClosed).toBe(true)
  })

  it('is the connection the driver makes', async () => {
    const s = await setup()
    expect(s.connection).toBeInstanceOf(ClaudeConnection)
  })
})
