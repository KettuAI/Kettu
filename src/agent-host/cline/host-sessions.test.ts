// What the process that runs Cline's SDK decides itself, against a stand-in SDK: which provider a
// session runs on, when a core starts and what it carries, and which tool calls ask the user.

import { describe, expect, it } from 'vitest'
import { Host, HostError, mcpToolName, type HostPeer } from './host-sessions'
import { ERROR, METHOD, type OpenParams, type OpenResult, type TurnResult } from './protocol'
import type {
  Sdk,
  SdkCoreOptions,
  SdkMessage,
  SdkModelInfo,
  SdkProviderSettings,
  SdkSessionEvent,
  SdkStartInput,
} from './sdk'

type Approval = { approved: boolean; reason?: string }

/** What a stand-in core does when prompted: the calls it asks approval for, and how it ends. */
interface Script {
  tools?: string[]
  fatal?: string
  finishReason?: string
}

class FakeCore {
  started: SdkStartInput | null = null
  disposed: string | null = null
  sent: { prompt: string; mode?: string; delivery?: string }[] = []
  approvals: Approval[] = []
  models: string[] = []
  private listener: ((event: SdkSessionEvent) => void) | null = null
  messages: SdkMessage[] = []

  constructor(
    readonly options: SdkCoreOptions,
    private readonly world: World,
  ) {}

  async start(input: SdkStartInput): Promise<{ sessionId: string }> {
    this.started = input
    this.messages = [...(input.initialMessages ?? [])]
    return { sessionId: String(input.config.sessionId) }
  }

  async send(input: {
    sessionId: string
    prompt: string
    mode?: string
    delivery?: 'queue' | 'steer'
  }) {
    this.sent.push({ prompt: input.prompt, mode: input.mode, delivery: input.delivery })
    if (input.delivery === 'steer') return undefined
    const script = this.world.script
    for (const [index, toolName] of (script.tools ?? []).entries()) {
      this.approvals.push(
        await this.options.capabilities!.requestToolApproval!({
          sessionId: input.sessionId,
          toolCallId: `call_${index}`,
          toolName,
          input: {},
        }),
      )
    }
    if (script.fatal) {
      this.listener?.({
        type: 'agent_event',
        payload: {
          sessionId: input.sessionId,
          event: {
            type: 'error',
            error: new Error(script.fatal),
            recoverable: false,
            iteration: 1,
          },
        },
      } as unknown as SdkSessionEvent)
    }
    this.messages.push(
      { role: 'user', content: input.prompt },
      { role: 'assistant', content: 'ok' },
    )
    return {
      finishReason: script.finishReason ?? 'completed',
      model: { id: 'model-a' },
      usage: { inputTokens: 10, outputTokens: 2, totalCost: 0.5 },
    }
  }

  async abort(): Promise<void> {}
  async dispose(reason?: string): Promise<void> {
    this.disposed = reason ?? ''
  }
  async get(sessionId: string) {
    return this.world.rows[sessionId]
  }
  async readMessages(sessionId: string): Promise<SdkMessage[]> {
    return this.started ? this.messages : (this.world.stored[sessionId] ?? [])
  }
  async readSessionCompactionState(): Promise<unknown> {
    return undefined
  }
  subscribe(listener: (event: SdkSessionEvent) => void): () => void {
    this.listener = listener
    return () => (this.listener = null)
  }
  async updateSessionModel(_sessionId: string, modelId: string): Promise<void> {
    this.models.push(modelId)
  }
  async updateSessionConnection(): Promise<void> {}
}

interface World {
  settings: Record<string, SdkProviderSettings>
  lastUsed: string | null
  rows: Record<string, { sessionId: string; provider: string; model: string; cwd: string }>
  stored: Record<string, SdkMessage[]>
  /** The compaction the user chose in Cline; undefined for one who never chose. */
  compaction?: 'basic' | 'agentic' | 'off'
  script: Script
  cores: FakeCore[]
  down: string[]
}

function world(overrides: Partial<World> = {}): World {
  return {
    settings: { anthropic: { provider: 'anthropic', apiKey: 'key', model: 'model-a' } },
    lastUsed: 'anthropic',
    rows: {},
    stored: {},
    script: {},
    cores: [],
    down: [],
    ...overrides,
  }
}

function fakeSdk(w: World): Sdk {
  const models: Record<string, Record<string, SdkModelInfo>> = {
    anthropic: {
      'model-a': {
        id: 'model-a',
        name: 'Model A',
        contextWindow: 400_000,
        maxInputTokens: 258_400,
        capabilities: ['reasoning', 'images'],
      },
      'model-b': { id: 'model-b', name: 'Model B', contextWindow: 128_000, capabilities: [] },
    },
    cline: { 'cline/default': { id: 'cline/default', name: 'Default', capabilities: [] } },
  }
  const sdk: Partial<Sdk> = {
    CORE_BUILD_VERSION: '0.2.0',
    ClineCore: {
      create: async (options) => {
        const core = new FakeCore(options, w)
        w.cores.push(core)
        return core
      },
    },
    ProviderSettingsManager: class {
      getProviderSettings(id: string) {
        return w.settings[id]
      }
      getLastUsedProviderSettings() {
        return w.lastUsed ? w.settings[w.lastUsed] : undefined
      }
      read() {
        return { providers: w.settings }
      }
    },
    InMemoryMcpManager: class {
      async registerServer() {}
      async dispose() {}
    },
    Llms: {
      getModelsForProvider: async (id) => models[id] ?? {},
      getProvider: async (id) => ({
        name: id === 'cline' ? 'Cline' : id,
        defaultModelId: id === 'cline' ? 'cline/default' : 'model-b',
      }),
    },
    createDefaultMcpServerClientFactory: () => ({}),
    // A server is first reached when its tools are listed.
    createMcpTools: async ({ serverName }) => {
      if (w.down.includes(serverName)) throw new Error('connection refused')
      return [{ name: `${serverName}__set_plan` }]
    },
    isProviderSettingsUsable: (_id, settings) => !!settings?.apiKey,
    isOAuthProvider: (id) => id === 'cline' || id === 'cline-pass' || id === 'openai-codex',
    getPersistedProviderApiKey: (_id, settings) => settings?.apiKey,
    getClineDefaultSystemPrompt: (options) =>
      `mode=${String(options.mode)} rules=${String(options.rules ?? '')}`,
    buildWorkspaceMetadata: async () => '',
    readCompactionModeGlobally: () => w.compaction,
    projectSessionCompactionState: () => undefined,
    createSessionCompactionState: () => undefined,
    loginAndSaveLocalProviderOAuthCredentials: async (_manager, id, openUrl) => {
      openUrl('https://sign-in.test/page')
      w.settings[id] = { provider: id, apiKey: 'token' }
      return w.settings[id]
    },
  }
  return sdk as Sdk
}

function setup(
  w: World = world(),
  answer: (params: unknown) => unknown = () => ({ approved: true }),
) {
  const asked: { method: string; params: unknown }[] = []
  const events: unknown[] = []
  const peer: HostPeer = {
    ask: async <T>(method: string, params: unknown) => {
      asked.push({ method, params })
      return answer(params) as T
    },
    notify: (_method, params) => void events.push(params),
    log: () => {},
  }
  const host = new Host(fakeSdk(w), peer)
  const open = (params: Partial<OpenParams> = {}) =>
    host.serve(METHOD.open, {
      sessionId: 's1',
      cwd: '/work/app',
      resume: false,
      settings: {},
      mcpServers: [],
      instructions: null,
      ...params,
    }) as Promise<OpenResult>
  const prompt = (text = 'hello') =>
    host.serve(METHOD.prompt, {
      sessionId: 's1',
      text,
      images: [],
      files: [],
    }) as Promise<TurnResult>
  const set = (settings: Record<string, unknown>) =>
    host.serve(METHOD.set, { sessionId: 's1', settings })
  /** The cores of sessions; the first core only reads the store. */
  const sessionCores = () => w.cores.filter((core) => core.options.capabilities)
  return { host, w, asked, events, open, prompt, set, sessionCores }
}

describe('Cline host sessions', () => {
  it('asks for a sign-in while Cline holds none', async () => {
    const { open } = setup(world({ settings: {}, lastUsed: null }))
    await expect(open()).rejects.toMatchObject({ code: ERROR.authRequired })
  })

  it('starts a session on the provider and model Cline last ran with', async () => {
    const { open } = setup()
    const opened = await open()
    expect(opened).toMatchObject({
      stored: false,
      settings: { provider: 'anthropic', model: 'model-a', mode: 'act', autoApprove: false },
    })
    expect(opened.providers.map((provider) => [provider.id, provider.ready])).toEqual([
      ['anthropic', true],
      ['cline', false],
      ['cline-pass', false],
      ['openai-codex', false],
    ])
  })

  it('reports the input a model takes as its window, which Cline compacts against', async () => {
    const { open } = setup()
    const opened = await open()
    expect(opened.models.map((model) => [model.id, model.contextWindow])).toEqual([
      ['model-a', 258_400],
      ['model-b', 128_000],
    ])
  })

  it('compacts a session unless the user turned that off in Cline, as its own CLI does', async () => {
    const started = async (compaction?: World['compaction']) => {
      const { open, prompt, sessionCores } = setup(world({ compaction }))
      await open()
      await prompt()
      return sessionCores()[0]!.started!.config.compaction
    }
    expect(await started()).toEqual({ enabled: true })
    expect(await started('basic')).toEqual({ enabled: true, strategy: 'basic' })
    expect(await started('off')).toEqual({ enabled: false })
  })

  it('starts no core until the first prompt, then one under the id Kettu holds', async () => {
    const { open, prompt, sessionCores } = setup()
    await open({ instructions: 'Kettu paragraph.' })
    expect(sessionCores()).toHaveLength(0)
    const result = await prompt()
    expect(result).toEqual({
      finishReason: 'completed',
      model: 'model-a',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0.5,
      },
    })
    const [core] = sessionCores()
    expect(core!.options).toMatchObject({ clientName: 'kettu', backendMode: 'local' })
    expect(core!.started).toMatchObject({
      source: 'cli',
      interactive: true,
      config: {
        sessionId: 's1',
        providerId: 'anthropic',
        modelId: 'model-a',
        apiKey: 'key',
        mode: 'act',
        cwd: '/work/app',
        systemPrompt: 'mode=act rules=Kettu paragraph.',
      },
    })
    expect(core!.started!.initialMessages).toBeUndefined()
  })

  it('carries on a stored session with its own provider, model and conversation', async () => {
    const stored: SdkMessage[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' },
    ]
    const { open, prompt, sessionCores } = setup(
      world({
        rows: {
          s1: { sessionId: 's1', provider: 'anthropic', model: 'model-b', cwd: '/work/app' },
        },
        stored: { s1: stored },
      }),
    )
    const opened = await open({ resume: true })
    expect(opened).toMatchObject({ stored: true, settings: { model: 'model-b' } })
    await prompt()
    expect(sessionCores()[0]!.started).toMatchObject({
      config: { sessionId: 's1', modelId: 'model-b' },
      initialMessages: stored,
    })
  })

  it('lets safe tools run, asks for the others, and remembers an answer for the session', async () => {
    const answers = [{ approved: true }, { approved: true, always: true }, { approved: false }]
    const { open, prompt, asked, w, sessionCores } = setup(world(), () => answers.shift())
    await open()
    w.script = { tools: ['run_commands', 'editor', 'editor', 'run_commands'] }
    await prompt()
    const [core] = sessionCores()
    // Reads and questions never reach the approval, by the policies the core starts with.
    expect(core!.started!.toolPolicies).toMatchObject({
      '*': { autoApprove: false },
      read_files: { autoApprove: true },
      ask_question: { autoApprove: true },
    })
    expect(core!.started!.toolPolicies!.run_commands).toBeUndefined()
    // run_commands once, editor always, then editor again unasked, and run_commands denied.
    expect(asked.map((ask) => (ask.params as { toolName: string }).toolName)).toEqual([
      'run_commands',
      'editor',
      'run_commands',
    ])
    expect(core!.approvals).toEqual([
      { approved: true },
      { approved: true },
      { approved: true },
      {
        approved: false,
        reason: 'This tool call was rejected by the user and not executed.',
      },
    ])
  })

  it('asks for nothing once tools are approved automatically', async () => {
    const { open, prompt, set, asked, w } = setup()
    await open()
    await set({ autoApprove: true })
    w.script = { tools: ['run_commands'] }
    await prompt()
    expect(asked).toEqual([])
  })

  it("runs an MCP server's tools it may run unasked, and asks for the server's other tools", async () => {
    const { open, prompt, asked, w, sessionCores } = setup(world({ down: ['down'] }))
    await open({
      mcpServers: [
        {
          name: 'kettu',
          type: 'streamableHttp',
          url: 'http://k',
          headers: {},
          autoAllow: ['set_plan'],
        },
        { name: 'down', type: 'streamableHttp', url: 'http://d', headers: {}, autoAllow: [] },
      ],
    })
    w.script = { tools: ['kettu__set_plan', 'kettu__create_artifact'] }
    await prompt()
    expect(asked.map((ask) => (ask.params as { toolName: string }).toolName)).toEqual([
      'kettu__create_artifact',
    ])
    // The server that could not be reached is left out; the session runs without it.
    expect(sessionCores()[0]!.started!.config.extraTools).toEqual([{ name: 'kettu__set_plan' }])
  })

  it('fails the turn with what the runtime could not go on from, a sign-in as one', async () => {
    const { open, prompt, w, events } = setup()
    await open()
    w.script = { fatal: '401 Unauthorized' }
    await expect(prompt()).rejects.toMatchObject({
      code: ERROR.authRequired,
      message: '401 Unauthorized',
    })
    expect(events.at(-1)).toMatchObject({
      sessionId: 's1',
      event: { type: 'error', error: { message: '401 Unauthorized' }, recoverable: false },
    })
    w.script = { fatal: 'The provider is down' }
    await expect(prompt()).rejects.toMatchObject({ code: ERROR.failed })
    w.script = { fatal: 'aborted', finishReason: 'aborted' }
    await expect(prompt()).resolves.toMatchObject({ finishReason: 'aborted' })
  })

  it('starts a new core with the conversation so far when the mode changes', async () => {
    const { open, prompt, set, sessionCores } = setup()
    await open()
    await prompt('first')
    await set({ mode: 'plan' })
    expect(sessionCores()[0]!.disposed).toBe('kettu_mode_change')
    await prompt('second')
    const [, second] = sessionCores()
    expect(second!.started).toMatchObject({
      config: { sessionId: 's1', mode: 'plan', systemPrompt: 'mode=plan rules=' },
      initialMessages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
      ],
    })
    expect(second!.sent).toEqual([{ prompt: 'second', mode: 'plan', delivery: undefined }])
  })

  it('changes the model of a live session in place, and of a provider to one it lists', async () => {
    const w = world()
    w.settings.cline = { provider: 'cline', apiKey: 'token' }
    const { open, prompt, set, sessionCores } = setup(w)
    await open()
    await prompt()
    await set({ model: 'model-b' })
    expect(sessionCores()[0]!.models).toEqual(['model-b'])
    expect(sessionCores()[0]!.disposed).toBeNull()
    const changed = (await set({ provider: 'cline' })) as { settings: { model: string } }
    expect(changed.settings).toMatchObject({ provider: 'cline', model: 'cline/default' })
    expect(sessionCores()[0]!.disposed).toBe('kettu_provider_change')
  })

  it('signs in through the page Cline hands over', async () => {
    const { host, asked, w } = setup(world({ settings: {}, lastUsed: null }))
    const result = (await host.serve(METHOD.signIn, { provider: 'cline' })) as {
      providers: { id: string; ready: boolean }[]
    }
    expect(asked).toEqual([
      { method: METHOD.openUrl, params: { url: 'https://sign-in.test/page' } },
    ])
    expect(result.providers.find((provider) => provider.id === 'cline')?.ready).toBe(true)
    expect(w.settings.cline?.apiKey).toBe('token')
  })

  it('answers an unknown session and an unknown method as errors', async () => {
    const { host } = setup()
    await expect(
      host.serve(METHOD.prompt, { sessionId: 'none', text: 'x', images: [], files: [] }),
    ).rejects.toMatchObject({ code: ERROR.noSession })
    await expect(host.serve('nope', {})).rejects.toBeInstanceOf(HostError)
  })
})

describe('Cline MCP tool names', () => {
  it('keeps a plain name and shortens one a provider would refuse', () => {
    expect(mcpToolName('kettu', 'set_plan')).toBe('kettu__set_plan')
    const long = mcpToolName('server', 'x'.repeat(80))
    expect(long).toHaveLength(64)
    expect(long).toMatch(/^server__x+_[0-9a-f]{8}$/)
    expect(mcpToolName('my server', 'a.b')).toMatch(/^my_server__a_b_[0-9a-f]{8}$/)
  })
})
