// A stand-in for the Claude Agent SDK, with the shape its driver loads: each query plays the
// messages a test scripts for the prompts it gets and records every call made to it.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type {
  AccountInfo,
  ClaudeSdk,
  ContextUsageAnswer,
  FlagSettings,
  InitializeAnswer,
  PermissionMode,
  Query,
  QueryOptions,
  SdkMessage,
  SessionInfo,
  StoredMessage,
  UsageAnswer,
  UserInput,
} from '../claude/sdk'

export const FAKE_INIT: InitializeAnswer = {
  commands: [
    { name: 'review', description: 'Review a pull request', argumentHint: '<number>' },
    { name: 'clear', description: 'Clear the conversation' },
    { name: 'statusline', description: 'Set up the status line' },
  ],
  models: [
    {
      value: 'default',
      displayName: 'Default (recommended)',
      description: 'Opus for everything',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
      supportsFastMode: true,
    },
    { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
  ],
  account: { email: 'ada@example.com', subscriptionType: 'max', apiProvider: 'firstParty' },
  fast_mode_state: 'off',
}

export type Script = (query: FakeQuery, input: UserInput) => void

export class FakeQuery implements Query {
  readonly calls: { method: string; args: unknown[] }[] = []
  readonly inputs: UserInput[] = []
  closed = false
  private readonly queue: SdkMessage[] = []
  private waiting: ((result: IteratorResult<SdkMessage>) => void) | null = null
  readonly process: unknown

  constructor(
    readonly sdk: FakeClaudeSdk,
    readonly options: QueryOptions,
    prompt: AsyncIterable<UserInput>,
  ) {
    // The SDK starts its Claude Code process as the query starts.
    this.process = options.spawnClaudeCodeProcess({
      command: options.pathToClaudeCodeExecutable,
      args: ['--output-format', 'stream-json'],
      cwd: options.cwd,
      env: options.env,
      signal: new AbortController().signal,
    })
    void (async () => {
      for await (const input of prompt) {
        this.inputs.push(input)
        sdk.script(this, input)
      }
    })()
  }

  /** The session id this query runs as. */
  get sessionId(): string {
    return this.options.sessionId ?? this.options.resume ?? 'none'
  }

  emit(...messages: SdkMessage[]): void {
    for (const message of messages) {
      if (this.closed) return
      if (this.waiting) {
        const resolve = this.waiting
        this.waiting = null
        resolve({ value: message, done: false })
      } else {
        this.queue.push(message)
      }
    }
  }

  /** A whole turn's ending: its result, then the idle state. */
  finish(result: Partial<Extract<SdkMessage, { type: 'result' }>> = {}): void {
    this.emit(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
        modelUsage: {},
        session_id: this.sessionId,
        ...result,
      } as SdkMessage,
      {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        session_id: this.sessionId,
      },
    )
  }

  running(): void {
    this.emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      session_id: this.sessionId,
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkMessage> {
    return {
      next: () => {
        const message = this.queue.shift()
        if (message) return Promise.resolve({ value: message, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      },
    }
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  async interrupt(): Promise<void> {
    this.record('interrupt')
    this.sdk.onInterrupt(this)
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.record('setPermissionMode', mode)
  }

  async setModel(model?: string): Promise<void> {
    this.record('setModel', model)
  }

  async applyFlagSettings(settings: FlagSettings): Promise<void> {
    this.record('applyFlagSettings', settings)
  }

  async initializationResult(): Promise<InitializeAnswer> {
    this.record('initializationResult')
    if (this.sdk.initError) throw this.sdk.initError(this)
    return this.sdk.init
  }

  async getContextUsage(options?: { detail?: 'summary' | 'full' }): Promise<ContextUsageAnswer> {
    this.record('getContextUsage', options)
    return this.sdk.context
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options: {
    skipBehaviors?: boolean
  }): Promise<UsageAnswer> {
    this.record('usage', options)
    return this.sdk.usage
  }

  async accountInfo(): Promise<AccountInfo> {
    this.record('accountInfo')
    return this.sdk.account ?? this.sdk.init.account ?? {}
  }

  async stopTask(taskId: string): Promise<void> {
    this.record('stopTask', taskId)
  }

  async generateSessionTitle(description: string, options: { persist: boolean }) {
    this.record('generateSessionTitle', description, options)
    return this.sdk.generatedTitle
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.record('close')
    // The SDK ends its Claude Code process with the query.
    const child = this.process
    if (this.sdk.exitOnClose && child instanceof FakeChild && child.exitCode === null) {
      child.exitCode = 0
      queueMicrotask(() => child.emit('exit', 0, null))
    }
    const resolve = this.waiting
    this.waiting = null
    resolve?.({ value: undefined, done: true })
  }
}

/** A child process as the fake SDK's spawn gets it, which never runs anything. */
export class FakeChild extends EventEmitter {
  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdin = null
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
}

export class FakeClaudeSdk implements ClaudeSdk {
  readonly queries: FakeQuery[] = []
  readonly calls: { method: string; args: unknown[] }[] = []
  readonly history = new Map<string, StoredMessage[]>()
  readonly subagentHistory = new Map<string, StoredMessage[]>()
  readonly infos = new Map<string, SessionInfo>()
  init: InitializeAnswer = FAKE_INIT
  /** Whether a closed query's process exits at once; a test that exits it itself sets false. */
  exitOnClose = true
  /** What a query's `accountInfo` answers, when it differs from the account it started with. */
  account: AccountInfo | null = null
  initError: ((query: FakeQuery) => Error) | null = null
  settings: Record<string, unknown> = {}
  generatedTitle: string | null = null
  context: ContextUsageAnswer = {
    categories: [
      { name: 'System prompt', tokens: 3000 },
      { name: 'Messages', tokens: 7000 },
      { name: 'MCP tools (deferred)', tokens: 900, isDeferred: true },
      { name: 'Free space', tokens: 190_000 },
    ],
    totalTokens: 10_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    model: 'claude-opus-5',
    memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 1200 }],
    mcpTools: [{ name: 'mcp__kettu__show', serverName: 'kettu', tokens: 310 }],
    agents: [],
    skills: { skillFrontmatter: [{ name: 'review', source: 'project', tokens: 45 }] },
  }
  usage: UsageAnswer = {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42, resets_at: '2026-10-30T18:00:00.000Z' },
      seven_day: { utilization: 7, resets_at: '2026-11-03T09:00:00.000Z' },
      model_scoped: [{ display_name: 'Opus', utilization: 12, resets_at: null }],
    },
  }
  /** What a query does with each prompt; by default it answers "Done." and ends the turn. */
  script: Script = (query) => {
    query.running()
    query.emit({
      type: 'assistant',
      message: {
        id: `msg_${query.inputs.length}`,
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'Done.' }],
      },
      parent_tool_use_id: null,
      uuid: `uuid-${query.inputs.length}`,
      session_id: query.sessionId,
    })
    query.finish()
  }
  onInterrupt: (query: FakeQuery) => void = () => {}

  query(params: { prompt: AsyncIterable<UserInput>; options: QueryOptions }): Query {
    const query = new FakeQuery(this, params.options, params.prompt)
    this.queries.push(query)
    return query
  }

  get last(): FakeQuery {
    return this.queries[this.queries.length - 1]!
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  async listSessions(options: { dir: string; limit?: number; offset?: number }) {
    this.record('listSessions', options)
    const all = [...this.infos.values()]
    const start = options.offset ?? 0
    return all.slice(start, start + (options.limit ?? all.length))
  }

  async getSessionInfo(sessionId: string, options: { dir: string }) {
    this.record('getSessionInfo', sessionId, options)
    return this.infos.get(sessionId)
  }

  async getSessionMessages(sessionId: string, options: { dir: string }) {
    this.record('getSessionMessages', sessionId, options, process.env.CLAUDE_CONFIG_DIR)
    return this.history.get(sessionId) ?? []
  }

  async getSubagentMessages(sessionId: string, agentId: string, options: { dir: string }) {
    this.record('getSubagentMessages', sessionId, agentId, options)
    return this.subagentHistory.get(agentId) ?? []
  }

  async deleteSession(sessionId: string, options: { dir?: string }) {
    this.record('deleteSession', sessionId, options)
    this.history.delete(sessionId)
  }

  async forkSession(sessionId: string, options: { dir: string; upToMessageId?: string }) {
    this.record('forkSession', sessionId, options)
    return { sessionId: `fork-of-${sessionId}` }
  }

  async resolveSettings(options: { cwd: string; settingSources?: string[] }) {
    this.record('resolveSettings', options)
    return { effective: this.settings }
  }

  filterEscalatingDefaultMode(resolved: { effective: Record<string, unknown> }) {
    return resolved.effective
  }
}
