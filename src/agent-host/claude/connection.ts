// A connection to Claude Code through the Claude Agent SDK, which runs in the agent host. Each open
// session is one SDK query with streaming input, and so one Claude Code process, spawned through
// the host so that it is recorded and stopped as the agent's own.

import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { ContextBreakdown, PlanLimit } from '@shared/agent-host'
import type { ConfigOption, TokenTotals } from '@shared/thread'
import {
  AgentRequestError,
  type AgentConnection,
  type AgentInit,
  type ForkPoint,
  type ListedSession,
  type ModelTokens,
  type OpenedSession,
  type PromptBlock,
  type PromptResult,
  type SessionOptions,
  type SessionSetup,
  type SessionTarget,
} from '../connection'
import type { HostedContext } from '../driver'
import type { Env } from '../find-command'
import {
  addTokenTotals,
  firstUserMessage,
  repeatsFirstMessage,
  type MapperContext,
  type MapperOutput,
} from '../session-updates'
import {
  availableModes,
  buildConfig,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  modelInfo,
  OPTION_IDS,
  settingsModel,
  type SessionChoices,
} from './config'
import {
  ClaudeMapper,
  DEFAULT_CONTEXT_WINDOW,
  mapCommands,
  MODE_OPTION_ID,
  SYNTHETIC_MODEL,
  type Delivery,
} from './mapper'
import { answeredMode, permissionOptions, permissionResult } from './permissions'
import { mapAccount, mapContextUsage, mapUsageLimits } from './reports'
import type {
  AccountInfo,
  AssistantMessage,
  ClaudeSdk,
  ContentBlock,
  FlagSettings,
  ModelInfo,
  ModelUsage,
  PermissionMode,
  PermissionResult,
  Query,
  QueryOptions,
  ResultMessage,
  SdkMessage,
  SettingSource,
  SlashCommandInfo,
  StoredMessage,
  SystemMessage,
  ToolPermissionContext,
  UserInput,
} from './sdk'

export type LoadSdk = (entry: string) => Promise<ClaudeSdk>

const CONFIG_DIR = 'CLAUDE_CONFIG_DIR'
const CLI_VARIABLE = 'CLAUDE_CODE_EXECUTABLE'
const LIST_PAGE = 1000
const PENDING_SESSIONS = 32
const PENDING_DELIVERIES = 2000
const PENDING_TTL_MS = 60_000
const CLOSED_SESSIONS = 256
const TITLE_CONTEXT = 1000
const TITLE_MINIMUM = 10
/** How long a stop waits for Claude Code to exit before it goes on. */
const EXIT_WAIT_MS = 5_000
/** JSON-RPC's code for a session the agent does not have, which the host reads. */
const RESOURCE_NOT_FOUND = -32002
const INVALID_PARAMS = -32602
const USER_SOURCES: SettingSource[] = ['user', 'project', 'local']

/** How Claude Code says a request failed for want of a sign-in. */
const SIGN_IN_TEXT =
  /please run \/login|not logged in|invalid api key|oauth token (has expired|revoked)|authentication_failed/i

class Input implements AsyncIterable<UserInput> {
  private readonly items: UserInput[] = []
  private waiting: ((result: IteratorResult<UserInput>) => void) | null = null
  private done = false

  push(item: UserInput): void {
    if (this.done) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    this.done = true
    const resolve = this.waiting
    this.waiting = null
    resolve?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<UserInput> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.done) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

interface Turn {
  resolve(result: PromptResult): void
  reject(error: unknown): void
  /** Claude Code said it runs the turn: an `idle` before that is from before it. */
  running: boolean
  cancelled: boolean
  tokens: TokenTotals | null
  models: Map<string, TokenTotals>
  stopReason: PromptResult['stopReason']
  error: AgentRequestError | null
  /** The text of a message Claude Code wrote itself, such as an error. */
  notice: string | null
  /** The kind of error such a message names, such as `authentication_failed`. */
  failure: string | null
  /** The agent messages' text, for `collect`. */
  texts: string[] | null
}

interface Session {
  id: string
  cwd: string
  options: SessionOptions
  query: Query | null
  input: Input | null
  mapper: ClaudeMapper
  models: ModelInfo[]
  modes: PermissionMode[]
  choices: SessionChoices
  config: ConfigOption[]
  turn: Turn | null
  /** Its query took up a history, whose spend the first result's running totals hold. */
  resumed: boolean
  /** The latest running totals by model; undefined until the query's first result. */
  totals: Record<string, ModelUsage> | undefined
  /** Whether Claude Code sends its state changes, which end a turn. */
  states: boolean
  /** The latest main-thread model. */
  model: string | null
  /** The main thread's message uuids, by API message id, for a fork point. */
  uuids: Map<string, string>
  commands: SlashCommandInfo[]
  terminal: Set<string>
  /** Reopen before the next prompt: the last one failed to sign in, or the query ended. */
  stale: boolean
  /** What the title is generated from, until one is settled on. */
  titleText: string | null
  ultracode: boolean | undefined
  /** Set for a session opened only to read from. */
  quiet: boolean
  /** Its Claude Code process, while it runs. */
  process: ChildProcess | null
}

interface Pending {
  at: number
  items: Delivery[]
}

function tokenTotals(usage: {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}): TokenTotals {
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  return {
    total: input + output + cacheRead + cacheWrite,
    input,
    output,
    thought: null,
    cacheRead,
    cacheWrite,
  }
}

function modelTotals(usage: ModelUsage): TokenTotals {
  return tokenTotals({
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
  })
}

/** What each model spent between two readings of the running totals. */
function spentSince(
  now: Record<string, ModelUsage>,
  before: Record<string, ModelUsage>,
): Map<string, TokenTotals> {
  const spent = new Map<string, TokenTotals>()
  for (const [model, usage] of Object.entries(now)) {
    const was = before[model]
    const delta = modelTotals(usage)
    if (was) {
      const old = modelTotals(was)
      delta.input -= old.input
      delta.output -= old.output
      delta.cacheRead = (delta.cacheRead ?? 0) - (old.cacheRead ?? 0)
      delta.cacheWrite = (delta.cacheWrite ?? 0) - (old.cacheWrite ?? 0)
      delta.total -= old.total
    }
    if (delta.total > 0) spent.set(model, delta)
  }
  return spent
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A resume of a session Claude Code has no history for. */
function missingSession(error: unknown): boolean {
  const text = errorText(error)
  return (
    text.includes('No conversation found with session ID') ||
    text === 'Query closed before response received'
  )
}

/** Kettu's prompt as the content of Claude Code's user message. */
export function promptContent(blocks: readonly PromptBlock[]): ContentBlock[] {
  const content: ContentBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'image':
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: block.mimeType, data: block.data },
        })
        break
      case 'resource_link':
        content.push({ type: 'text', text: `[@${block.name}](${block.uri})` })
        break
      case 'resource': {
        const { uri, text } = block.resource
        const name = decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1)) || uri
        content.push({ type: 'text', text: `[@${name}](${uri})` })
        content.push({ type: 'text', text: `\n<context ref="${uri}">\n${text}\n</context>` })
        break
      }
    }
  }
  return content
}

/** The SDK's own copy of Claude Code, from its optional platform package. */
export function bundledCli(entry: string, platform = process.platform): string | null {
  const scope = '@anthropic-ai/claude-agent-sdk'
  const { arch } = process
  const musl =
    platform === 'linux' &&
    !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)
      ?.header?.glibcVersionRuntime
  const names =
    platform === 'linux'
      ? musl
        ? [`${scope}-linux-${arch}-musl`, `${scope}-linux-${arch}`]
        : [`${scope}-linux-${arch}`, `${scope}-linux-${arch}-musl`]
      : [`${scope}-${platform}-${arch}`]
  const binary = platform === 'win32' ? 'claude.exe' : 'claude'
  const require = createRequire(entry)
  for (const name of names) {
    try {
      const file = path.join(path.dirname(require.resolve(`${name}/package.json`)), binary)
      if (existsSync(file)) return file
    } catch {
      // Not installed for this platform.
    }
  }
  return null
}

export class ClaudeConnection implements AgentConnection {
  readonly closed: Promise<void>
  private resolveClosed!: () => void
  private done = false
  private sdk: ClaudeSdk | null = null
  private cli: string | null = null
  private readonly sessions = new Map<string, Session>()
  private readonly targets = new Map<string, SessionTarget>()
  private readonly pending = new Map<string, Pending>()
  private readonly unregistered = new Set<string>()
  /** The session each subagent's task runs under. */
  private readonly children = new Map<string, string>()
  private envQueue: Promise<unknown> = Promise.resolve()
  private account: string | null = null

  constructor(
    private readonly context: HostedContext,
    private readonly load: LoadSdk,
  ) {
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve))
  }

  get isClosed(): boolean {
    return this.done
  }

  get hiddenSessions(): boolean {
    return true
  }

  close(): void {
    if (this.done) return
    this.done = true
    for (const session of this.sessions.values()) {
      const turn = session.turn
      session.turn = null
      turn?.reject(this.closedError())
      void this.stop(session)
    }
    this.sessions.clear()
    this.resolveClosed()
  }

  private closedError(): AgentRequestError {
    return new AgentRequestError('closed', 'The connection to Claude Code is closed')
  }

  /** The agent's environment with its own variables, as Claude Code gets it. */
  private get env(): Env {
    return { ...this.context.env, ...this.context.spec.env }
  }

  async initialize(_appVersion: string, signal?: AbortSignal): Promise<AgentInit> {
    const entry = this.context.spec.command
    const loading = this.load(entry)
    const sdk = await (signal
      ? Promise.race([
          loading,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason)
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
        ])
      : loading)
    this.sdk = sdk
    this.cli = this.context.spec.cli ?? this.env[CLI_VARIABLE] ?? bundledCli(entry)
    let version: string | null = null
    try {
      const manifest = JSON.parse(
        await readFile(path.join(path.dirname(entry), 'package.json'), 'utf8'),
      ) as { version?: unknown }
      version = typeof manifest.version === 'string' ? manifest.version : null
    } catch {
      // The version is only shown.
    }
    const env = this.env
    const remote = !!(env.NO_BROWSER || env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)
    const command = this.cli ?? undefined
    const terminal = (id: string, name: string, description: string, args: string[]) => ({
      id,
      name,
      description,
      type: 'terminal' as const,
      ...(command ? { command } : {}),
      args,
      env: {},
    })
    return {
      name: 'Claude Agent SDK',
      version,
      capabilities: {
        loadSession: true,
        listSessions: true,
        resumeSession: true,
        closeSession: true,
        deleteSession: true,
        forkSession: true,
        forkAtMessage: true,
        ownTitles: 'sent',
        logout: true,
        steering: true,
        mcpHttp: true,
        prompt: { image: true, audio: false, embeddedContext: true },
      },
      // A browser on another machine cannot finish the sign-in, so there Claude Code's own runs.
      authMethods: remote
        ? [terminal('claude-login', 'Log in with Claude', 'Run `claude` and then /login', [])]
        : [
            terminal('claude-ai-login', 'Claude Subscription', 'Use Claude subscription', [
              'auth',
              'login',
              '--claudeai',
            ]),
            terminal(
              'console-login',
              'Anthropic Console',
              'Use Anthropic Console (API usage billing)',
              ['auth', 'login', '--console'],
            ),
          ],
      raw: { sdk: version, cli: this.cli },
    }
  }

  authenticate(methodId: string): Promise<void> {
    return Promise.reject(
      new AgentRequestError('agent_error', `${methodId} signs in in a terminal`, INVALID_PARAMS),
    )
  }

  async logout(): Promise<void> {
    const cli = this.requireCli()
    const child = this.context.spawn({ command: cli, args: ['auth', 'logout'], env: this.env })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.stdout?.resume()
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode) => resolve(exitCode))
    })
    if (code !== 0) {
      throw new AgentRequestError(
        'agent_error',
        stderr.trim() || `claude auth logout exited with ${code}`,
      )
    }
    this.account = null
  }

  private requireSdk(): ClaudeSdk {
    if (this.done) throw this.closedError()
    if (!this.sdk) throw new AgentRequestError('agent_error', 'Claude Code has not started')
    return this.sdk
  }

  private requireCli(): string {
    if (!this.cli) {
      throw new AgentRequestError('agent_error', 'No Claude Code program was found for the SDK')
    }
    return this.cli
  }

  /**
   * Runs one of the SDK's own functions, which find the configuration folder in this process's
   * environment, with the agent's folder there; one at a time, since the environment is shared.
   */
  private withConfigDir<T>(work: () => Promise<T>): Promise<T> {
    const folder = this.env[CONFIG_DIR]
    const run = async (): Promise<T> => {
      const before = process.env[CONFIG_DIR]
      if (folder) process.env[CONFIG_DIR] = folder
      else delete process.env[CONFIG_DIR]
      try {
        return await work()
      } finally {
        if (before === undefined) delete process.env[CONFIG_DIR]
        else process.env[CONFIG_DIR] = before
      }
    }
    const next = this.envQueue.then(run, run)
    this.envQueue = next.catch(() => {})
    return next
  }

  // Sessions.

  async newSession(cwd: string, options: SessionOptions = {}): Promise<OpenedSession> {
    const sessionId = randomUUID()
    const session = await this.open(sessionId, cwd, options, { resume: false })
    return { sessionId, config: session.config }
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const sdk = this.requireSdk()
    const history = await this.withConfigDir(() => sdk.getSessionMessages(sessionId, { dir: cwd }))
    if (history.length === 0) {
      throw new AgentRequestError('agent_error', `No session ${sessionId}`, RESOURCE_NOT_FOUND)
    }
    const session = await this.open(sessionId, cwd, options, { resume: true })
    this.rememberUuids(session, history)
    for (const delivery of session.mapper.replay(history)) this.deliver(delivery, true)
    // Each subagent's history is its own, replayed into its session after its parent's.
    for (const child of session.mapper.replayed) {
      this.children.set(child.taskId, sessionId)
      let messages: StoredMessage[] = []
      try {
        messages = await this.withConfigDir(() =>
          sdk.getSubagentMessages(sessionId, child.taskId, { dir: cwd }),
        )
      } catch (error) {
        this.context.hooks.log(
          'warn',
          `Could not read subagent ${child.taskId}: ${errorText(error)}`,
        )
      }
      const mapper = new ClaudeMapper(child.taskId, cwd)
      const prompter = { parentId: sessionId, messageId: child.toolUseId }
      for (const delivery of mapper.replay(messages, prompter)) this.deliver(delivery, true)
    }
    return { config: session.config }
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const open = this.sessions.get(sessionId)
    if (open?.query && !open.stale) {
      // Already open: only Kettu's ultracode switch can have changed.
      if (options.ultracode !== undefined && options.ultracode !== open.ultracode) {
        await this.applyFlags(open, { ultracode: options.ultracode })
        open.ultracode = options.ultracode
        open.options = { ...open.options, ultracode: options.ultracode }
      }
      return { config: open.config }
    }
    const session = await this.open(sessionId, cwd, options, { resume: true })
    return { config: session.config }
  }

  async forkSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
    point?: ForkPoint,
  ): Promise<OpenedSession> {
    const sdk = this.requireSdk()
    const upTo = point ? await this.forkUuid(sessionId, cwd, point) : undefined
    if (point && !upTo) {
      throw new AgentRequestError(
        'agent_error',
        `Fork point message ${point.messageId} was not found in session ${sessionId}`,
        INVALID_PARAMS,
      )
    }
    if (options.hidden) {
      // A hidden fork writes no history: it reads the session's, up to the point, and keeps none.
      const forkId = randomUUID()
      const session = await this.open(forkId, cwd, options, {
        resume: true,
        from: sessionId,
        ...(upTo ? { at: upTo } : {}),
      })
      return { sessionId: forkId, config: session.config }
    }
    const forked = await this.withConfigDir(() =>
      sdk.forkSession(sessionId, { dir: cwd, ...(upTo ? { upToMessageId: upTo } : {}) }),
    )
    const session = await this.open(forked.sessionId, cwd, options, { resume: true })
    return { sessionId: forked.sessionId, config: session.config }
  }

  /**
   * The uuid of the message a fork ends at: the API message id Kettu has, as this connection saw
   * it or the history has it, else the message with its text at its occurrence, which also finds
   * one the ACP adapter named.
   */
  private async forkUuid(sessionId: string, cwd: string, point: ForkPoint): Promise<string | null> {
    const live = this.sessions.get(sessionId)?.uuids.get(point.messageId)
    if (live) return live
    const sdk = this.requireSdk()
    const history = await this.withConfigDir(() => sdk.getSessionMessages(sessionId, { dir: cwd }))
    const groups = new Map<string, { uuid: string; text: string }>()
    for (const message of history) {
      if (message.type !== 'assistant' || message.parent_tool_use_id) continue
      const inner = message.message as AssistantMessage['message'] | undefined
      const id = inner?.id ?? message.uuid
      const group = groups.get(id) ?? { uuid: message.uuid, text: '' }
      group.uuid = message.uuid
      for (const block of inner?.content ?? []) {
        if (block.type === 'text') group.text += (block as { text: string }).text
      }
      groups.set(id, group)
    }
    const exact = groups.get(point.messageId)
    if (exact) return exact.uuid
    const same = [...groups.values()].filter((group) => group.text === point.text)
    return same[point.occurrence - 1]?.uuid ?? null
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    await this.stop(session)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      this.sessions.delete(sessionId)
      // Claude Code writes the session's title and costs as it exits, which would list it again.
      await this.stop(session)
    }
    const sdk = this.requireSdk()
    await this.withConfigDir(() =>
      sdk.deleteSession(sessionId, session ? { dir: session.cwd } : {}),
    )
  }

  async listSessions(
    cwd: string,
    cursor: string | null,
  ): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    const sdk = this.requireSdk()
    const offset = Math.max(0, Number(cursor ?? 0) || 0)
    const infos = await this.withConfigDir(() =>
      sdk.listSessions({ dir: cwd, limit: LIST_PAGE, offset }),
    )
    return {
      sessions: infos.map((info) => ({
        sessionId: info.sessionId,
        title: info.customTitle ?? info.summary ?? null,
        updatedAt: Number.isFinite(info.lastModified)
          ? new Date(info.lastModified).toISOString()
          : null,
        cwd: info.cwd ?? cwd,
      })),
      nextCursor: infos.length === LIST_PAGE ? String(offset + LIST_PAGE) : null,
    }
  }

  async removeHidden(sessionId: string): Promise<void> {
    await this.closeSession(sessionId)
    this.unregister(sessionId)
  }

  // Opening a query.

  /** Reads the settings a session starts with; an unreadable file only leaves the defaults. */
  private async settings(cwd: string, sources: SettingSource[]): Promise<Record<string, unknown>> {
    const sdk = this.requireSdk()
    try {
      return await this.withConfigDir(async () => {
        const resolved = await sdk.resolveSettings({ cwd, settingSources: sources })
        // A mode a repository's own settings escalate to holds only once Claude Code trusts it.
        return sdk.filterEscalatingDefaultMode(resolved)
      })
    } catch (error) {
      this.context.hooks.log('warn', `Could not read Claude Code's settings: ${errorText(error)}`)
      return {}
    }
  }

  private async open(
    sessionId: string,
    cwd: string,
    options: SessionOptions,
    how: { resume: boolean; from?: string; at?: string; quiet?: boolean },
  ): Promise<Session> {
    const sdk = this.requireSdk()
    const previous = this.sessions.get(sessionId)
    if (previous) void this.stop(previous)
    const hidden = options.hidden
    const sources = hidden === 'titles' || hidden === 'limits' ? [] : USER_SOURCES
    const settings = await this.settings(cwd, sources)
    const allowBypass = process.getuid?.() !== 0
    const modes = availableModes(allowBypass)
    const permissions = (settings.permissions ?? {}) as { defaultMode?: unknown }
    const wanted = typeof permissions.defaultMode === 'string' ? permissions.defaultMode : 'default'
    const mode: PermissionMode = modes.includes(wanted as PermissionMode)
      ? (wanted as PermissionMode)
      : 'default'
    const input = new Input()
    const session: Session = {
      id: sessionId,
      cwd,
      options,
      query: null,
      input,
      mapper: new ClaudeMapper(sessionId, cwd),
      models: [],
      modes,
      choices: { mode, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, fast: false },
      config: [],
      turn: null,
      resumed: how.resume,
      totals: undefined,
      states: false,
      model: null,
      uuids: new Map(),
      commands: [],
      terminal: new Set(),
      stale: false,
      titleText: '',
      ultracode: options.ultracode,
      quiet: how.quiet === true,
      process: null,
    }
    const flags: Record<string, unknown> = {}
    if (hidden) flags.disableAllHooks = true
    if (options.ultracode !== undefined) flags.ultracode = options.ultracode
    const mcpServers = Object.fromEntries(
      (options.mcpServers ?? []).map((server) => [
        server.name,
        {
          type: 'http' as const,
          url: server.url,
          headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
        },
      ]),
    )
    const queryOptions: QueryOptions = {
      cwd,
      env: { ...this.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
      pathToClaudeCodeExecutable: this.requireCli(),
      spawnClaudeCodeProcess: (spawn) => {
        const child = this.context.spawn({
          command: spawn.command,
          args: spawn.args,
          ...(spawn.cwd ? { cwd: spawn.cwd } : {}),
          env: spawn.env as Env,
          signal: spawn.signal,
        })
        session.process = child
        return child
      },
      includePartialMessages: true,
      forwardSubagentText: true,
      perTaskStopAffordance: true,
      settingSources: sources,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      // Kettu has no form for its questions, so Claude Code asks in its reply instead.
      disallowedTools: ['AskUserQuestion'],
      permissionMode: mode,
      allowDangerouslySkipPermissions: allowBypass,
      canUseTool: (name, toolInput, permission) =>
        this.canUseTool(session, name, toolInput, permission),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      ...(Object.keys(flags).length > 0 ? { settings: flags } : {}),
      extraArgs: { 'replay-user-messages': null },
      ...(hidden ? { persistSession: false } : {}),
      ...(how.from
        ? {
            resume: how.from,
            forkSession: true,
            sessionId,
            ...(how.at ? { resumeSessionAt: how.at } : {}),
          }
        : how.resume
          ? { resume: sessionId }
          : { sessionId }),
    }
    const query = sdk.query({ prompt: input, options: queryOptions })
    session.query = query
    this.context.hooks.traffic('out', { method: 'query', sessionId, resume: how.resume })
    const reading = this.read(session, query)
    let init
    try {
      init = await query.initializationResult()
    } catch (error) {
      session.query = null
      input.close()
      query.close()
      void reading
      if (how.resume && missingSession(error)) {
        throw new AgentRequestError('agent_error', errorText(error), RESOURCE_NOT_FOUND)
      }
      throw new AgentRequestError('agent_error', errorText(error))
    }
    if (this.done) {
      query.close()
      throw this.closedError()
    }
    this.reportAccount(init.account)
    session.models = init.models ?? []
    const model =
      typeof settings.model === 'string' ? settings.model : (this.env.ANTHROPIC_MODEL ?? null)
    session.choices.model = settingsModel(session.models, model)
    if (typeof settings.effortLevel === 'string') session.choices.effort = settings.effortLevel
    session.choices.fast = init.fast_mode_state !== undefined && init.fast_mode_state !== 'off'
    session.commands = init.commands ?? []
    session.config = buildConfig(session.models, session.choices, modes)
    this.sessions.set(sessionId, session)
    if (!session.quiet) {
      this.unregistered.delete(sessionId)
      this.publishCommands(session)
    }
    return session
  }

  private reportAccount(info: AccountInfo | undefined): void {
    const account = mapAccount(info)
    if (!account) return
    const key = JSON.stringify(account)
    if (key === this.account) return
    this.account = key
    this.context.hooks.account(account)
  }

  private publishCommands(session: Session): void {
    const commands = mapCommands(session.commands, session.terminal)
    this.deliver({
      sessionId: session.id,
      map: () => ({ patches: [{ op: 'session.update', changes: { commands } }], effects: [] }),
    })
  }

  private rememberUuids(session: Session, history: readonly StoredMessage[]): void {
    for (const message of history) {
      if (message.type !== 'assistant' || message.parent_tool_use_id) continue
      const id = (message.message as { id?: unknown } | undefined)?.id
      if (typeof id === 'string') session.uuids.set(id, message.uuid)
    }
  }

  /**
   * Stops a session's query; its turn ends as the query's end ends it. Settles once its Claude
   * Code has exited, which writes the session's last state to its history as it goes.
   */
  private stop(session: Session): Promise<void> {
    const { query, input, process: child } = session
    session.query = null
    session.input = null
    session.process = null
    input?.close()
    query?.close()
    for (const [task, root] of this.children) if (root === session.id) this.children.delete(task)
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, EXIT_WAIT_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async read(session: Session, query: Query): Promise<void> {
    let failure: unknown = null
    try {
      for await (const message of query) {
        if (session.query !== query) break
        this.context.hooks.traffic('in', message)
        this.handle(session, message)
      }
    } catch (error) {
      failure = error
    }
    this.ended(session, query, failure)
  }

  /** The query ended: the session reopens on its next prompt, and a running turn fails. */
  private ended(session: Session, query: Query, failure: unknown): void {
    const current = session.query === query
    if (current) {
      session.query = null
      session.input?.close()
      session.input = null
      session.stale = true
    }
    const turn = session.turn
    if (!turn) return
    if (!current && session.query) return
    session.turn = null
    if (this.done) turn.reject(this.closedError())
    else if (turn.cancelled) turn.resolve(this.turnResult(turn, 'cancelled'))
    else {
      const message = failure ? errorText(failure) : 'Claude Code stopped before the turn ended'
      turn.reject(new AgentRequestError('agent_error', message))
    }
  }

  // Messages.

  private handle(session: Session, message: SdkMessage): void {
    if (session.quiet) return
    const turn = session.turn
    if (message.type === 'system') {
      const system = message as SystemMessage
      if (system.subtype === 'init') {
        const terminal = system.terminal_slash_commands
        session.terminal = new Set(Array.isArray(terminal) ? (terminal as string[]) : [])
        this.publishCommands(session)
      } else if (system.subtype === 'commands_changed' && Array.isArray(system.commands)) {
        session.commands = system.commands as SlashCommandInfo[]
        this.publishCommands(session)
      } else if (system.subtype === 'session_state_changed') {
        session.states = true
        if (system.state === 'running' && turn) turn.running = true
        if (system.state === 'idle' && turn?.running) this.settle(session)
        return
      } else if (system.subtype === 'task_started' && typeof system.task_id === 'string') {
        if (system.task_type === 'local_agent' || typeof system.subagent_type === 'string') {
          this.children.set(system.task_id, session.id)
        }
      } else if (system.subtype === 'status' && typeof system.permissionMode === 'string') {
        this.setChoice(session, 'mode', system.permissionMode)
      }
    } else if (message.type === 'assistant') {
      const assistant = message as AssistantMessage
      const top = !assistant.parent_tool_use_id && !assistant.agent_id
      if (assistant.message.model === SYNTHETIC_MODEL || assistant.error) {
        const text = assistant.message.content
          .flatMap((block) => (block.type === 'text' ? [(block as { text: string }).text] : []))
          .join('\n')
        if (turn && top) {
          turn.notice = text || assistant.error || null
          turn.failure = assistant.error ?? null
        }
        if (assistant.message.model === SYNTHETIC_MODEL) return
      }
      if (top) {
        if (assistant.message.model) session.model = assistant.message.model
        session.uuids.set(assistant.message.id, assistant.uuid)
        const text = assistant.message.content
          .flatMap((block) => (block.type === 'text' ? [(block as { text: string }).text] : []))
          .join('')
        if (text) {
          turn?.texts?.push(text)
          if (session.titleText !== null)
            session.titleText = (session.titleText + text).slice(-TITLE_CONTEXT)
        }
      }
    } else if (message.type === 'result') {
      if (turn) turn.running = true
      this.result(session, message as ResultMessage)
      return
    }
    if (turn?.texts) return
    const deliveries = session.mapper.live(message)
    if (deliveries === null) {
      const what =
        'subtype' in message && message.subtype
          ? `${message.type}/${message.subtype}`
          : message.type
      this.context.hooks.ignored(session.id, what)
      return
    }
    for (const delivery of deliveries) this.deliver(delivery)
  }

  private result(session: Session, result: ResultMessage): void {
    const turn = session.turn
    const totals = result.modelUsage ?? {}
    // The first result after a resume carries the history's totals, so only its own usage counts.
    const spent =
      session.totals === undefined && session.resumed
        ? new Map([[session.model ?? 'claude', tokenTotals(result.usage ?? {})]])
        : spentSince(totals, session.totals ?? {})
    session.totals = totals
    const window = (session.model && totals[session.model]?.contextWindow) || undefined
    this.deliver({
      sessionId: session.id,
      map: (ctx) => usageOutput(ctx, result.total_cost_usd, window),
    })
    if (!turn) return
    turn.tokens = addTokenTotals(turn.tokens, tokenTotals(result.usage ?? {}))
    for (const [model, tokens] of spent) {
      turn.models.set(model, addTokenTotals(turn.models.get(model) ?? null, tokens))
    }
    // A steered turn runs on after the part the steering stopped, so its latest result says.
    const aborted =
      result.terminal_reason === 'aborted_streaming' || result.terminal_reason === 'aborted_tools'
    turn.error = null
    if (turn.cancelled || aborted) turn.stopReason = 'cancelled'
    else if (result.stop_reason === 'max_tokens') turn.stopReason = 'max_tokens'
    else if (result.stop_reason === 'refusal') turn.stopReason = 'refusal'
    else if (result.subtype === 'error_max_turns' || result.subtype === 'error_max_budget_usd') {
      turn.stopReason = 'max_turn_requests'
    } else if (result.is_error) {
      const text =
        (result.subtype === 'success' ? result.result : result.errors?.join('\n')) ||
        turn.notice ||
        result.subtype
      const signIn = turn.failure === 'authentication_failed' || SIGN_IN_TEXT.test(text)
      turn.error = new AgentRequestError(signIn ? 'auth_required' : 'agent_error', text)
    } else {
      turn.stopReason = 'end_turn'
    }
    // A Claude Code that does not send its states ends the turn with its result.
    if (!session.states) this.settle(session)
  }

  private turnResult(turn: Turn, stopReason: PromptResult['stopReason']): PromptResult {
    const models: ModelTokens[] = [...turn.models].map(([model, tokens]) => ({ model, tokens }))
    return { stopReason, tokens: turn.tokens, models }
  }

  private settle(session: Session): void {
    const turn = session.turn
    if (!turn) return
    session.turn = null
    if (turn.error && !turn.cancelled) {
      // A turn that failed to sign in reopens its query, which reads the sign-in again.
      if (turn.error.kind === 'auth_required') session.stale = true
      turn.reject(turn.error)
      return
    }
    turn.resolve(this.turnResult(turn, turn.cancelled ? 'cancelled' : turn.stopReason))
    if (!turn.texts && !session.options.hidden) void this.title(session)
  }

  /** The session's title after a turn: the one stored, or one generated once from its text. */
  private async title(session: Session): Promise<void> {
    if (session.titleText === null) return
    const sdk = this.requireSdk()
    let title: string | null
    try {
      const info = await this.withConfigDir(() =>
        sdk.getSessionInfo(session.id, { dir: session.cwd }),
      )
      title = info?.customTitle ?? null
      const query = session.query
      const text = session.titleText.trim()
      if (!title && query?.generateSessionTitle && text.length >= TITLE_MINIMUM) {
        // Asked once at a time; a generation that gives none leaves a later turn to ask again.
        session.titleText = null
        title = await query.generateSessionTitle(text, { persist: true })
        if (!title) session.titleText = text
      }
    } catch (error) {
      this.context.hooks.log(
        'warn',
        `Could not read the title of ${session.id}: ${errorText(error)}`,
      )
      return
    }
    if (!title) return
    session.titleText = null
    const value = title.replace(/\s+/g, ' ').trim()
    this.deliver({
      sessionId: session.id,
      map: (ctx) => {
        if (repeatsFirstMessage(value, firstUserMessage(ctx.thread)))
          return { patches: [], effects: [] }
        return {
          patches: [{ op: 'session.update', changes: { title: value, updatedAt: ctx.now } }],
          effects: [{ kind: 'title', title: value }],
        }
      },
    })
  }

  // Routing.

  private deliver(delivery: Delivery, replay = false): void {
    const { sessionId } = delivery
    const target = this.targets.get(sessionId)
    if (target) {
      const context = target.context()
      if (replay && !context.replaying) {
        target.apply(delivery.map({ ...context, replaying: true }))
      } else {
        target.apply(delivery.map(context))
      }
      return
    }
    if (this.unregistered.has(sessionId)) {
      this.context.hooks.ignored(sessionId, 'update for a session Kettu closed')
      return
    }
    const now = Date.now()
    for (const [id, entry] of this.pending) {
      if (now - entry.at > PENDING_TTL_MS) {
        this.pending.delete(id)
        this.context.hooks.ignored(
          id,
          `${entry.items.length} updates for a session Kettu does not have`,
        )
      }
    }
    let entry = this.pending.get(sessionId)
    if (!entry) {
      if (this.pending.size >= PENDING_SESSIONS) {
        this.context.hooks.ignored(sessionId, 'update for an unknown session')
        return
      }
      entry = { at: now, items: [] }
      this.pending.set(sessionId, entry)
    }
    if (entry.items.length < PENDING_DELIVERIES) entry.items.push(delivery)
  }

  register(sessionId: string, target: SessionTarget): void {
    this.targets.set(sessionId, target)
    this.unregistered.delete(sessionId)
    const early = this.pending.get(sessionId)
    if (!early) return
    this.pending.delete(sessionId)
    for (const delivery of early.items) target.apply(delivery.map(target.context()))
  }

  unregister(sessionId: string, target?: SessionTarget): void {
    if (target && this.targets.get(sessionId) !== target) return
    this.targets.delete(sessionId)
    this.pending.delete(sessionId)
    this.unregistered.add(sessionId)
    if (this.unregistered.size > CLOSED_SESSIONS) {
      this.unregistered.delete(this.unregistered.values().next().value!)
    }
  }

  reopen(sessionId: string): void {
    this.unregistered.delete(sessionId)
  }

  rootOf(id: string): string {
    return this.sessions.has(id) ? id : (this.children.get(id) ?? id)
  }

  // Turns.

  /** The session, its query opened again when it ended or its sign-in failed. */
  private async ready(sessionId: string): Promise<Session> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new AgentRequestError(
        'agent_error',
        `Session ${sessionId} is not open`,
        RESOURCE_NOT_FOUND,
      )
    }
    if (session.query && !session.stale) return session
    if (session.options.hidden) {
      throw new AgentRequestError('agent_error', `Session ${sessionId} has ended`)
    }
    let reopened: Session
    try {
      reopened = await this.open(sessionId, session.cwd, session.options, { resume: true })
    } catch (error) {
      // Claude Code keeps no history for a session never prompted, so it starts again as new.
      if (!(error instanceof AgentRequestError) || error.code !== RESOURCE_NOT_FOUND) throw error
      reopened = await this.open(sessionId, session.cwd, session.options, { resume: false })
    }
    // What the user chose before goes back to the reopened query.
    await this.restoreChoices(reopened, session.choices)
    reopened.titleText = session.titleText
    return reopened
  }

  private async restoreChoices(session: Session, choices: SessionChoices): Promise<void> {
    for (const id of [OPTION_IDS.mode, OPTION_IDS.model, OPTION_IDS.effort, OPTION_IDS.fast]) {
      const value = choices[id]
      const option = session.config.find((item) => item.id === id)
      if (!option || option.value === value) continue
      try {
        await this.applyOption(session, id, value)
      } catch (error) {
        this.context.hooks.log('warn', `Could not set ${id} again: ${errorText(error)}`)
      }
    }
  }

  private send(session: Session, blocks: readonly PromptBlock[], priority?: 'now'): void {
    const content = promptContent(blocks)
    this.context.hooks.traffic('out', {
      method: priority ? 'steer' : 'prompt',
      sessionId: session.id,
      blocks: content.map((block) => block.type),
    })
    if (session.titleText !== null) {
      const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
      session.titleText = `${session.titleText}\n${text}\n`.slice(-TITLE_CONTEXT)
    }
    session.input!.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: session.id,
      ...(priority ? { priority } : {}),
    })
  }

  private startTurn(session: Session, texts: string[] | null): Promise<PromptResult> {
    if (session.turn) {
      return Promise.reject(new AgentRequestError('agent_error', 'A turn is already running'))
    }
    return new Promise((resolve, reject) => {
      session.turn = {
        resolve,
        reject,
        running: false,
        cancelled: false,
        tokens: null,
        models: new Map(),
        stopReason: 'end_turn',
        error: null,
        notice: null,
        failure: null,
        texts,
      }
    })
  }

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    const session = await this.ready(sessionId)
    const turn = this.startTurn(session, null)
    this.send(session, prompt)
    return turn
  }

  async collect(sessionId: string, text: string): Promise<string[]> {
    const session = await this.ready(sessionId)
    const texts: string[] = []
    const turn = this.startTurn(session, texts)
    this.send(session, [{ type: 'text', text }])
    await turn
    return texts
  }

  async steer(
    sessionId: string,
    prompt: readonly PromptBlock[],
  ): Promise<'injected' | 'promptRequired'> {
    const session = this.sessions.get(sessionId)
    if (!session?.turn || !session.input) return 'promptRequired'
    this.send(session, prompt, 'now')
    return 'injected'
  }

  async cancel(sessionId: string): Promise<void> {
    const root = this.children.get(sessionId)
    if (root) {
      await this.sessions.get(root)?.query?.stopTask(sessionId)
      return
    }
    const session = this.sessions.get(sessionId)
    if (!session?.turn || !session.query) return
    session.turn.cancelled = true
    this.context.hooks.traffic('out', { method: 'interrupt', sessionId })
    await session.query.interrupt()
  }

  // Options.

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.setConfigOption(sessionId, MODE_OPTION_ID, modeId)
  }

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const session = await this.ready(sessionId)
    await this.applyOption(session, optionId, value)
    return session.config
  }

  private async applyOption(
    session: Session,
    optionId: string,
    value: string | boolean,
  ): Promise<void> {
    const query = session.query!
    switch (optionId) {
      case OPTION_IDS.mode:
        if (typeof value !== 'string' || !session.modes.includes(value as PermissionMode)) break
        await query.setPermissionMode(value as PermissionMode)
        this.setChoice(session, 'mode', value)
        return
      case OPTION_IDS.model: {
        if (typeof value !== 'string') break
        await query.setModel(value === DEFAULT_MODEL ? undefined : value)
        session.choices.model = value
        // The effort and fast mode a model offers are its own.
        const info = modelInfo(session.models, value)
        if (!info?.supportedEffortLevels?.includes(session.choices.effort)) {
          session.choices.effort = DEFAULT_EFFORT
        }
        session.config = buildConfig(session.models, session.choices, session.modes)
        return
      }
      case OPTION_IDS.effort:
        if (typeof value !== 'string') break
        await this.applyFlags(session, { effortLevel: value === DEFAULT_EFFORT ? null : value })
        session.choices.effort = value
        session.config = buildConfig(session.models, session.choices, session.modes)
        return
      case OPTION_IDS.fast:
        await this.applyFlags(session, { fastMode: value === true })
        session.choices.fast = value === true
        session.config = buildConfig(session.models, session.choices, session.modes)
        return
    }
    throw new AgentRequestError(
      'agent_error',
      `No option ${optionId} takes ${String(value)}`,
      INVALID_PARAMS,
    )
  }

  /** Flag settings, with ultracode sent again: an effort change without it turns it off. */
  private async applyFlags(session: Session, settings: FlagSettings): Promise<void> {
    const ultracode = settings.ultracode ?? session.ultracode
    await session.query!.applyFlagSettings({
      ...settings,
      ...(ultracode !== undefined ? { ultracode } : {}),
    })
  }

  /** Records a choice Claude Code made or took, such as the mode a plan's approval set. */
  private setChoice(session: Session, id: 'mode', value: string): void {
    if (session.choices[id] === value) return
    session.choices[id] = value
    session.config = buildConfig(session.models, session.choices, session.modes)
  }

  // Permissions.

  private async canUseTool(
    session: Session,
    toolName: string,
    input: Record<string, unknown>,
    permission: ToolPermissionContext,
  ): Promise<PermissionResult> {
    const own = permission.agentID && this.children.get(permission.agentID) === session.id
    const targetId = own ? permission.agentID! : session.id
    const target = this.targets.get(targetId)
    if (!target) return permissionResult(null, input, permission)
    const options = permissionOptions(toolName, permission, session.modes)
    const output = session.mapper.permissionTool(
      target.context(),
      { type: 'tool_use', id: permission.toolUseID, name: toolName, input },
      targetId,
    )
    let optionId: string | null
    try {
      const answer = await target.requestPermission(
        {
          toolCallId: permission.toolUseID,
          toolEntryId: `t:${permission.toolUseID}`,
          output,
          options,
        },
        permission.signal,
      )
      optionId = answer === 'cancelled' ? null : answer.optionId
    } catch {
      // Withdrawn: Claude Code no longer waits for the answer.
      return permissionResult(null, input, permission)
    }
    const result = permissionResult(optionId, input, permission)
    if (result.behavior === 'allow') {
      target.apply(session.mapper.toolStatus(target.context(), permission.toolUseID, 'in_progress'))
      const mode = optionId ? answeredMode(optionId) : null
      if (mode) this.setChoice(session, 'mode', mode)
    }
    return result
  }

  // Reports.

  async readLimits(): Promise<PlanLimit[]> {
    const open = [...this.sessions.values()].find((session) => session.query && !session.stale)
    const temporary = open ? null : await this.temporary(os.tmpdir(), { hidden: 'limits' })
    const query = open?.query ?? temporary?.query
    try {
      if (!query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) return []
      const answer = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      })
      return mapUsageLimits(answer, Date.now())
    } catch (error) {
      this.context.hooks.log(
        'warn',
        `Claude Code's plan limits could not be read: ${errorText(error)}`,
      )
      return []
    } finally {
      if (temporary) await this.closeSession(temporary.id)
    }
  }

  async readContext(
    sessionId: string,
    cwd: string,
    options: SessionOptions,
  ): Promise<ContextBreakdown> {
    const open = this.sessions.get(sessionId)
    const live = open?.query && !open.stale ? open : null
    const temporary = live
      ? null
      : await this.temporary(cwd, { ...options, hidden: 'context' }, sessionId)
    const query = (live ?? temporary)!.query!
    try {
      return mapContextUsage(await query.getContextUsage({ detail: 'summary' }), Date.now())
    } finally {
      if (temporary) await this.closeSession(temporary.id)
    }
  }

  /** A query opened only to read from, which keeps no history: of `from`, when it is given. */
  private temporary(cwd: string, options: SessionOptions, from?: string): Promise<Session> {
    const id = randomUUID()
    this.unregistered.add(id)
    return this.open(id, cwd, options, {
      resume: from !== undefined,
      quiet: true,
      ...(from ? { from } : {}),
    })
  }
}

/** The session's cost so far and its context window, after a result. */
function usageOutput(ctx: MapperContext, cost: number, window: number | undefined): MapperOutput {
  const previous = ctx.thread.session.usage
  const size = window ?? previous?.size ?? DEFAULT_CONTEXT_WINDOW
  return {
    patches: [
      {
        op: 'session.update',
        changes: {
          usage: {
            used: previous?.used ?? 0,
            size,
            cost: Number.isFinite(cost)
              ? { amount: cost, currency: 'USD' }
              : (previous?.cost ?? null),
            tokens: previous?.tokens ?? null,
            ...(previous?.cache ? { cache: previous.cache } : {}),
          },
        },
      },
    ],
    effects: [],
  }
}
