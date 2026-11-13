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
import type { AgentAccount, ContextBreakdown, PlanLimit } from '@shared/agent-host'
import type { ConfigOption, PendingElicitation, TokenTotals, ToolEntry } from '@shared/thread'
import {
  AgentRequestError,
  optionAnswer,
  type AgentConnection,
  type AgentInit,
  type FolderHooks,
  type ForkPoint,
  type ListedSession,
  type McpServer,
  type ModelTokens,
  type OpenedSession,
  type PermissionAnswer,
  type PromptBlock,
  type PromptResult,
  type SessionOptions,
  type SessionSetup,
  type SessionTarget,
} from '../connection'
import type { HostedContext } from '../driver'
import { formFields, isWebUrl } from '../elicitation'
import type { Env } from '../find-command'
import { t } from '../i18n'
import {
  addTokenTotals,
  firstUserMessage,
  repeatsFirstMessage,
  type MapperContext,
  type MapperEffect,
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
  type InheritedEffort,
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
import {
  ANSWER_IN_REPLY,
  answeredMode,
  BUILD_MODES,
  OTHER_ANSWER,
  pendingQuestions,
  permissionOptions,
  permissionResult,
  planResult,
  QUESTION_UNREADABLE,
  questionAnswers,
  questionOptions,
  QUESTIONS_SKIPPED,
} from './permissions'
import { folderHooks } from './project-hooks'
import { declaredServers } from './project-mcp'
import { mapAccount, mapAuthStatus, mapContextUsage, mapUsageLimits } from './reports'
import { askedQuestions } from './tools'
import type {
  AccountInfo,
  AssistantMessage,
  ClaudeSdk,
  ContentBlock,
  ElicitationCompleteMessage,
  ElicitationRequest,
  ElicitationResult,
  FlagSettings,
  McpServerConfig,
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
  StreamEvent,
  SystemMessage,
  ToolPermissionContext,
  UserInput,
} from './sdk'

/** Claude Code's tools that move a session into another worktree mid-session. */
export const WORKTREE_TOOLS = ['EnterWorktree', 'ExitWorktree'] as const

export type LoadSdk = (entry: string) => Promise<ClaudeSdk>

const CONFIG_DIR = 'CLAUDE_CONFIG_DIR'
const CLI_VARIABLE = 'CLAUDE_CODE_EXECUTABLE'
const LIST_PAGE = 1000
const PENDING_SESSIONS = 32
const PENDING_DELIVERIES = 2000
const PENDING_TTL_MS = 60_000
const CLOSED_SESSIONS = 256
/** Accepted pages that have not reported done; the oldest is forgotten past this. */
const OPEN_PAGES = 64
const TITLE_CONTEXT = 1000
const TITLE_MINIMUM = 10
/** How long a stop waits for Claude Code to exit before it goes on. */
const EXIT_WAIT_MS = 5_000
/** The most of a task's output the board reads, which is the tail Claude Code itself answers. */
const TASK_OUTPUT_LIMIT = 8 * 1024
const AUTH_STATUS_MS = 10_000
/** JSON-RPC's code for a session the agent does not have, which the host reads. */
const RESOURCE_NOT_FOUND = -32002
const INVALID_PARAMS = -32602
const USER_SOURCES: SettingSource[] = ['user', 'project', 'local']
/** The settings by which Claude Code signs in: an endpoint and key, or a helper that gives one. */
const SIGN_IN_SETTINGS = ['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'] as const

function signInSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of SIGN_IN_SETTINGS) if (settings[key] !== undefined) picked[key] = settings[key]
  return picked
}

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
  /** The agent's text as it streams, for `answer`. */
  onText: ((text: string) => void) | null
  /** Claude Code started it between Kettu's turns, so its end goes to the host as an effect. */
  byAgent: boolean
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
  /** The mode it opened in, Claude Code's own default for new sessions. */
  openMode: PermissionMode
  /** The last mode other than plan its choices took, which a plan's approval starts with. */
  buildMode: PermissionMode | null
  config: ConfigOption[]
  turn: Turn | null
  /** Its query took up a history, whose spend the first result's running totals hold. */
  resumed: boolean
  /** The latest running totals by model; undefined until the query's first result. */
  totals: Record<string, ModelUsage> | undefined
  /** Whether Claude Code sends its state changes, which end a turn. */
  states: boolean
  /** Claude Code has not gone idle since it last ran, as while background agents hold it. */
  busy: boolean
  /** The latest main-thread model. */
  model: string | null
  /** The main thread's message uuids, by API message id, for a fork point. */
  uuids: Map<string, string>
  commands: SlashCommandInfo[]
  terminal: Set<string>
  /** Reopen before the next prompt: the last one failed to sign in, or the query ended. */
  stale: boolean
  /** The servers the folder declares itself that the query was started without. */
  held: string[]
  /** The hooks the folder declares itself, which the query runs only when `hooksHeld` is false. */
  hooks: FolderHooks | null
  /** The query was started with every hook off, the folder's not being allowed. */
  hooksHeld: boolean
  /** What the title is generated from, until one is settled on. */
  titleText: string | null
  /** Bumps each time `titleText` grows, so a failed ask is not repeated for the same text. */
  titleRev: number
  /** The revision a generation already answered with nothing. */
  titleForRev: number | null
  /** A title request already running. */
  titling: Promise<void> | null
  /** The value ultracode inherits from Claude Code's settings; null until resolved. */
  ultracodeDefault: boolean | null
  /** What a session at its default effort runs at, besides the model's own default. */
  inheritedEffort: InheritedEffort
  /** Set for a session opened only to read from. */
  quiet: boolean
  /** Its Claude Code process, while it runs. */
  process: ChildProcess | null
}

interface Pending {
  at: number
  items: Delivery[]
}

function newTurn(
  resolve: (result: PromptResult) => void,
  reject: (error: unknown) => void,
  texts: string[] | null,
): Turn {
  return {
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
    onText: null,
    byAgent: false,
  }
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

/** Servers as the SDK's `mcpServers` record, by name. */
function claudeServers(servers: readonly McpServer[]): Record<string, McpServerConfig> {
  return Object.fromEntries(
    servers.map((server): [string, McpServerConfig] => [
      server.name,
      server.type === 'stdio'
        ? {
            type: 'stdio',
            command: server.command,
            args: [...server.args],
            env: Object.fromEntries(server.env.map((v) => [v.name, v.value])),
          }
        : {
            type: server.type,
            url: server.url,
            headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
          },
    ]),
  )
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
  /** How many permissions each subagent has open. */
  private readonly asking = new Map<string, number>()
  /** The entry of each accepted `url` request, by elicitation id, until its server reports done. */
  private readonly openPages = new Map<string, { targetId: string; entryId: string }>()
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
        mcpSse: true,
        mcpStdio: true,
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
    if (open?.query && !open.stale) return { config: open.config }
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

  /**
   * Reads the settings a session starts with, and the hooks the folder's own declare; an
   * unreadable file only leaves the defaults.
   */
  private async settings(
    cwd: string,
    sources: SettingSource[],
  ): Promise<{ values: Record<string, unknown>; known: boolean; hooks: FolderHooks | null }> {
    const sdk = this.requireSdk()
    try {
      const { values, hooks } = await this.withConfigDir(async () => {
        const resolved = await sdk.resolveSettings({ cwd, settingSources: sources })
        // A mode a repository's own settings escalate to holds only once Claude Code trusts it.
        return {
          values: sdk.filterEscalatingDefaultMode(resolved),
          hooks: folderHooks(resolved.sources),
        }
      })
      return { values, known: true, hooks }
    } catch (error) {
      this.context.hooks.log('warn', `Could not read Claude Code's settings: ${errorText(error)}`)
      return { values: {}, known: false, hooks: null }
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
    const bare = hidden === 'sample'
    const sources = hidden === 'titles' || hidden === 'limits' || bare ? [] : USER_SOURCES
    const settings = await this.settings(cwd, sources)
    const allowBypass = process.getuid?.() !== 0
    const modes = availableModes(allowBypass)
    const permissions = (settings.values.permissions ?? {}) as { defaultMode?: unknown }
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
      choices: {
        mode,
        model: DEFAULT_MODEL,
        effort: DEFAULT_EFFORT,
        fast: false,
        ultracode: 'default',
      },
      openMode: mode,
      buildMode: null,
      config: [],
      turn: null,
      resumed: how.resume,
      totals: undefined,
      states: false,
      busy: false,
      model: null,
      uuids: new Map(),
      commands: [],
      terminal: new Set(),
      stale: false,
      held: [],
      hooks: settings.hooks,
      hooksHeld: false,
      titleText: '',
      titleRev: 0,
      titleForRev: null,
      titling: null,
      ultracodeDefault: settings.known ? settings.values.ultracode === true : null,
      inheritedEffort: {
        env: this.env.CLAUDE_CODE_EFFORT_LEVEL,
        modelSettings: settings.values.modelSettings,
      },
      quiet: how.quiet === true,
      process: null,
    }
    const flags: Record<string, unknown> = {}
    // Through the SDK, Claude Code runs the hooks of a folder's own settings without asking.
    session.hooksHeld = !hidden && (await this.hooksHeld(cwd, options, settings))
    if (hidden || session.hooksHeld) flags.disableAllHooks = true
    // A page's question reads none of the user's settings but how they sign in, which may be there.
    if (bare) Object.assign(flags, signInSettings((await this.settings(cwd, ['user'])).values))
    // Through the SDK, Claude Code starts the servers of a folder's .mcp.json without asking.
    session.held = bare ? [] : await this.heldServers(cwd, options)
    if (session.held.length > 0) flags.disabledMcpjsonServers = session.held
    const servers = bare ? [] : (options.mcpServers ?? [])
    // The SDK writes this option onto Claude Code's command line, which other users can read, so a
    // server that holds a key comes only through the control channel once the query has started.
    const mcpServers = claudeServers(servers.filter((server) => !server.secret))
    const allowedTools = servers.flatMap((server) =>
      server.type === 'stdio'
        ? []
        : (server.autoAllow ?? []).map((tool) => `mcp__${server.name}__${tool}`),
    )
    const plugins = bare
      ? []
      : (options.localPlugins ?? []).map((folder) => ({ type: 'local' as const, path: folder }))
    const prompts = servers.flatMap((server) =>
      server.type === 'stdio' ? [] : (server.prompt ?? []),
    )
    const queryOptions: QueryOptions = {
      cwd,
      env: {
        ...this.env,
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        // Without it Claude Code sends no summary of its tool calls.
        CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: '1',
      },
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
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(prompts.length > 0 && !bare ? { append: prompts.join('\n\n') } : {}),
      },
      // A question from a page gets no tool at all: it cannot read, change or run anything.
      tools: bare ? [] : { type: 'preset', preset: 'claude_code' },
      ...(bare ? { strictMcpConfig: true } : {}),
      ...(allowedTools.length > 0 && !bare ? { allowedTools } : {}),
      // Kettu keeps a session in its folder: the panels, the diffs and the permission scope follow
      // that folder, and a worktree is Kettu's to make.
      ...(bare ? {} : { disallowedTools: [...WORKTREE_TOOLS] }),
      permissionMode: mode,
      allowDangerouslySkipPermissions: allowBypass,
      canUseTool: (name, toolInput, permission) =>
        this.canUseTool(session, name, toolInput, permission),
      onElicitation: (request, { signal, requestId }) =>
        this.elicit(session, request, requestId, signal),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
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
    if (servers.some((server) => server.secret)) this.addSecretServers(session, query, servers)
    this.reportAccount(init.account)
    session.models = init.models ?? []
    const model =
      typeof settings.values.model === 'string'
        ? settings.values.model
        : (this.env.ANTHROPIC_MODEL ?? null)
    session.choices.model = settingsModel(session.models, model)
    if (typeof settings.values.effortLevel === 'string') {
      session.choices.effort = settings.values.effortLevel
    }
    session.choices.fast = init.fast_mode_state !== undefined && init.fast_mode_state !== 'off'
    session.commands = init.commands ?? []
    session.config = buildConfig(
      session.models,
      session.choices,
      modes,
      session.ultracodeDefault,
      session.inheritedEffort,
    )
    this.sessions.set(sessionId, session)
    if (!session.quiet) {
      this.unregistered.delete(sessionId)
      this.publishCommands(session)
    }
    return session
  }

  /**
   * Hands the query all its servers, those holding keys among them, in place of the ones its
   * options started it with. Not awaited: the answer comes once every server has tried to connect,
   * and a server that cannot only leaves the session without its tools.
   */
  private addSecretServers(session: Session, query: Query, servers: readonly McpServer[]): void {
    const names = servers.map((server) => server.name)
    this.context.hooks.traffic('out', { method: 'setMcpServers', sessionId: session.id, names })
    query.setMcpServers(claudeServers(servers)).then(
      (result) => {
        for (const [name, error] of Object.entries(result.errors)) {
          this.context.hooks.log('warn', `MCP server ${name} did not connect: ${error}`)
        }
      },
      (error: unknown) => {
        if (session.query !== query) return
        this.context.hooks.log('warn', `Could not add MCP servers: ${errorText(error)}`)
      },
    )
  }

  private reportAccount(info: AccountInfo | undefined): void {
    const account = mapAccount(info)
    if (account) this.report(account)
  }

  private report(account: AgentAccount): void {
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
    for (const delivery of session.mapper.endAll('cancelled')) this.deliver(delivery)
    for (const delivery of session.mapper.endBackground()) this.deliver(delivery)
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
      for (const delivery of session.mapper.endAll('error')) this.deliver(delivery)
      for (const delivery of session.mapper.endBackground()) this.deliver(delivery)
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
        // A turn Claude Code starts once a background agent ends: it never went idle, so no
        // running state comes, only the init each turn of its opens with.
        if (!turn && session.busy && !session.options.hidden) this.agentTurn(session)
      } else if (system.subtype === 'commands_changed' && Array.isArray(system.commands)) {
        session.commands = system.commands as SlashCommandInfo[]
        this.publishCommands(session)
      } else if (system.subtype === 'session_state_changed') {
        session.states = true
        session.busy = system.state !== 'idle'
        if (system.state === 'running' && turn) turn.running = true
        else if (system.state === 'running' && !session.options.hidden) this.agentTurn(session)
        if (system.state === 'idle' && turn?.running) this.settle(session)
        return
      } else if (system.subtype === 'task_started' && typeof system.task_id === 'string') {
        if (system.task_type === 'local_agent' || typeof system.subagent_type === 'string') {
          this.children.set(system.task_id, session.id)
        }
      } else if (system.subtype === 'status' && typeof system.permissionMode === 'string') {
        this.setChoice(session, 'mode', system.permissionMode)
      } else if (system.subtype === 'elicitation_complete') {
        this.pageDone(message as ElicitationCompleteMessage)
      }
    } else if (message.type === 'assistant') {
      const assistant = message as AssistantMessage
      const top = !assistant.parent_tool_use_id && !assistant.agent_id
      const synthetic = assistant.message.model === SYNTHETIC_MODEL
      if (synthetic || assistant.error) {
        const text = assistant.message.content
          .flatMap((block) => (block.type === 'text' ? [(block as { text: string }).text] : []))
          .join('\n')
        if (turn && top) {
          turn.notice = text || assistant.error || null
          turn.failure = assistant.error ?? null
        }
        if (synthetic && assistant.error) return
      }
      if (top && !synthetic) {
        if (assistant.message.model) session.model = assistant.message.model
        session.uuids.set(assistant.message.id, assistant.uuid)
        const text = assistant.message.content
          .flatMap((block) => (block.type === 'text' ? [(block as { text: string }).text] : []))
          .join('')
        if (text) {
          turn?.texts?.push(text)
          this.noteTitle(session, text)
        }
      }
    } else if (message.type === 'result') {
      if (turn) turn.running = true
      this.result(session, message as ResultMessage)
      return
    } else if (message.type === 'stream_event' && turn?.onText) {
      const event = (message as StreamEvent).event
      const top = !(message as StreamEvent).parent_tool_use_id && !(message as StreamEvent).agent_id
      if (top && event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        if (event.delta.text) turn.onText(event.delta.text)
      }
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
    // A Claude Code that does not send its states ends the turn with its result. So do a stopped
    // turn and one that leaves background agents running, which keep Claude Code from going idle.
    if (!session.states || turn.cancelled || (!aborted && session.mapper.holdsIdleBack())) {
      this.settle(session)
    }
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

  /**
   * The session's title: one Claude Code stored, or one generated from the message. Nothing is
   * asked again for text that already came back empty; a failure or a title that only repeats the
   * message leaves a later call, such as the end of the turn, to try again.
   */
  private title(session: Session): Promise<void> {
    if (session.titleText === null || session.options.hidden) return Promise.resolve()
    if (session.titleText.trim().length < TITLE_MINIMUM) return Promise.resolve()
    if (session.titleForRev === session.titleRev) return Promise.resolve()
    if (session.titling) return session.titling.then(() => this.title(session))
    const run = this.askTitle(session).finally(() => {
      if (session.titling === run) session.titling = null
    })
    session.titling = run
    return run
  }

  /** Asks once. A title is kept only once it is accepted, so a failed ask can be repeated. */
  private async askTitle(session: Session): Promise<void> {
    const asked = session.titleText?.trim() ?? ''
    const rev = session.titleRev
    if (asked.length < TITLE_MINIMUM) return
    const sdk = this.requireSdk()
    const query = session.query
    let title: string | null = null
    let generated = false
    try {
      const info = await this.withConfigDir(() =>
        sdk.getSessionInfo(session.id, { dir: session.cwd }),
      )
      const stored = info?.customTitle?.trim() ? info.customTitle : null
      if (stored && !repeatsFirstMessage(stored, asked)) title = stored
      if (!title && query?.generateSessionTitle) {
        generated = true
        // Not persisted yet: a title that only repeats the message must not block the next ask.
        title = await query.generateSessionTitle(asked, { persist: false })
      }
    } catch (error) {
      this.context.hooks.log(
        'warn',
        `Could not read the title of ${session.id}: ${errorText(error)}`,
      )
      return
    }
    const value = title?.replace(/\s+/g, ' ').trim() ?? ''
    if (!value || !this.keepTitle(session, value, asked)) {
      // The same text gets one answer. Text that arrived while asking, after a repeat, is asked.
      if (!value || session.titleRev === rev) session.titleForRev = session.titleRev
      return
    }
    session.titleText = null
    session.titleForRev = null
    if (!generated) return
    try {
      await query?.renameSession?.(value, session.id)
    } catch (error) {
      this.context.hooks.log(
        'warn',
        `Could not store the title of ${session.id}: ${errorText(error)}`,
      )
    }
  }

  /** Whether `value` says more than the message it came from, and so can replace the title. */
  private keepTitle(session: Session, value: string, asked: string): boolean {
    if (repeatsFirstMessage(value, asked)) return false
    let accepted = false
    this.deliver({
      sessionId: session.id,
      map: (ctx) => {
        if (
          repeatsFirstMessage(value, firstUserMessage(ctx.thread)) ||
          repeatsFirstMessage(value, asked)
        ) {
          return { patches: [], effects: [] }
        }
        accepted = true
        return {
          patches: [{ op: 'session.update', changes: { title: value, updatedAt: ctx.now } }],
          effects: [{ kind: 'title', title: value }],
        }
      },
    })
    return accepted
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
    if (session.query && !session.stale && (session.turn || !(await this.released(session)))) {
      return session
    }
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
    reopened.buildMode = session.buildMode
    reopened.titleText = session.titleText
    return reopened
  }

  /**
   * The servers `cwd`'s .mcp.json files declare that may not start: all of them without a gate, and
   * a hidden session asks nobody about the rest.
   */
  private async heldServers(cwd: string, options: SessionOptions): Promise<string[]> {
    const declared = await declaredServers(cwd, (message) =>
      this.context.hooks.log('warn', message),
    )
    if (declared.length === 0) return []
    const names = declared.map((server) => server.name)
    const gate = options.projectMcp
    if (!gate) return names
    try {
      return await (options.hidden ? gate.held(cwd, names) : gate.hold(cwd, declared))
    } catch (error) {
      this.context.hooks.log('warn', `Could not read the answers for ${cwd}: ${errorText(error)}`)
      return names
    }
  }

  /**
   * Whether the hooks of `cwd`'s own settings may not run: all of them without a gate, and those
   * of settings that could not be read, which may declare some.
   */
  private async hooksHeld(
    cwd: string,
    options: SessionOptions,
    settings: { known: boolean; hooks: FolderHooks | null },
  ): Promise<boolean> {
    if (!settings.known) return true
    if (!settings.hooks) return false
    const gate = options.projectHooks
    if (!gate) return true
    try {
      return await gate.hold(cwd, settings.hooks)
    } catch (error) {
      this.context.hooks.log('warn', `Could not read the answers for ${cwd}: ${errorText(error)}`)
      return true
    }
  }

  /**
   * Whether the user allowed hooks or a server the query was started without since, which a
   * running query never takes up, so it opens again.
   */
  private async released(session: Session): Promise<boolean> {
    const hooks = session.options.projectHooks
    if (session.hooksHeld && session.hooks && hooks) {
      if (!(await hooks.held(session.cwd, session.hooks))) return true
    }
    const gate = session.options.projectMcp
    if (!gate || session.held.length === 0) return false
    return (await gate.held(session.cwd, session.held)).length < session.held.length
  }

  private async restoreChoices(session: Session, choices: SessionChoices): Promise<void> {
    const options: [string, keyof SessionChoices][] = [
      [OPTION_IDS.mode, 'mode'],
      [OPTION_IDS.model, 'model'],
      [OPTION_IDS.effort, 'effort'],
      [OPTION_IDS.fast, 'fast'],
      [OPTION_IDS.ultracode, 'ultracode'],
    ]
    for (const [id, key] of options) {
      const value = choices[key]
      const option = session.config.find((item) => item.id === id)
      // The choices, not the option values: an effort left at its default shows the level it runs at.
      if (!option || session.choices[key] === value) continue
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
    const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    this.noteTitle(session, `\n${text}\n`)
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
    const current = session.turn
    // A prompt that crossed a turn Claude Code started joins it, as Claude Code runs them as one.
    if (current?.byAgent && texts === null) {
      current.byAgent = false
      this.tellTurn(session, { kind: 'agentTurn', phase: 'joined' })
      return new Promise((resolve, reject) => {
        current.resolve = resolve
        current.reject = reject
      })
    }
    if (current) {
      return Promise.reject(new AgentRequestError('agent_error', 'A turn is already running'))
    }
    return new Promise((resolve, reject) => {
      session.turn = newTurn(resolve, reject, texts)
    })
  }

  /**
   * Claude Code started a turn between Kettu's, as when a command it ran in the background
   * ended. The host hears of it and its end, so the session shows it running as any turn.
   */
  private agentTurn(session: Session): void {
    session.turn = newTurn(
      (result) => this.tellTurn(session, { kind: 'agentTurn', phase: 'ended', result }),
      (error) => this.tellTurn(session, { kind: 'agentTurn', phase: 'failed', error }),
      null,
    )
    session.turn.running = true
    session.turn.byAgent = true
    this.tellTurn(session, { kind: 'agentTurn', phase: 'started' })
  }

  private tellTurn(session: Session, effect: MapperEffect): void {
    this.deliver({ sessionId: session.id, map: () => ({ patches: [], effects: [effect] }) })
  }

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    const session = await this.ready(sessionId)
    const turn = this.startTurn(session, null)
    this.send(session, prompt)
    // Asked now, not after the turn: a long run would otherwise keep the raw message as its title.
    void this.title(session)
    return turn
  }

  /** Adds text the next title is written from, until one has been accepted. */
  private noteTitle(session: Session, text: string): void {
    if (session.titleText === null || text.trim() === '') return
    session.titleText = `${session.titleText}${text}`.slice(-TITLE_CONTEXT)
    session.titleRev += 1
  }

  async answerQuestion(
    dir: string,
    prompt: readonly PromptBlock[],
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const sessionId = randomUUID()
    const session = await this.open(sessionId, dir, { hidden: 'sample' }, { resume: false })
    const cancel = (): void => void this.cancel(sessionId).catch(() => {})
    try {
      signal.throwIfAborted()
      const texts: string[] = []
      const turn = this.startTurn(session, texts)
      session.turn!.onText = onText
      signal.addEventListener('abort', cancel, { once: true })
      this.send(session, prompt)
      const result = await turn
      if (result.stopReason === 'cancelled') throw new Error('The question was cancelled')
      return texts.join('\n\n')
    } finally {
      signal.removeEventListener('abort', cancel)
      await this.removeHidden(sessionId)
    }
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

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const query = this.sessions.get(sessionId)?.query
    if (!query) throw new AgentRequestError('agent_error', 'Claude Code is not running')
    this.context.hooks.traffic('out', { method: 'stopTask', sessionId, taskId })
    await query.stopTask(taskId)
  }

  async taskOutput(
    sessionId: string,
    taskId: string,
  ): Promise<{ output: string; truncated: boolean }> {
    const query = this.sessions.get(sessionId)?.query
    if (!query) throw new AgentRequestError('agent_error', 'Claude Code is not running')
    if (!query.getTaskOutput) {
      throw new AgentRequestError('agent_error', 'This Claude Code cannot read task output')
    }
    const read = await query.getTaskOutput(taskId)
    const output = typeof read.output === 'string' ? read.output : ''
    const cut = output.length > TASK_OUTPUT_LIMIT
    return {
      output: cut ? output.slice(-TASK_OUTPUT_LIMIT) : output,
      truncated: cut || read.truncated === true,
    }
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
        session.config = buildConfig(
          session.models,
          session.choices,
          session.modes,
          session.ultracodeDefault,
          session.inheritedEffort,
        )
        return
      }
      case OPTION_IDS.effort:
        if (typeof value !== 'string') break
        await this.applyFlags(session, { effortLevel: value === DEFAULT_EFFORT ? null : value })
        session.choices.effort = value
        session.config = buildConfig(
          session.models,
          session.choices,
          session.modes,
          session.ultracodeDefault,
          session.inheritedEffort,
        )
        return
      case OPTION_IDS.fast:
        await this.applyFlags(session, { fastMode: value === true })
        session.choices.fast = value === true
        session.config = buildConfig(
          session.models,
          session.choices,
          session.modes,
          session.ultracodeDefault,
          session.inheritedEffort,
        )
        return
      case OPTION_IDS.ultracode: {
        if (value !== 'default' && typeof value !== 'boolean') break
        const ultracode = value === 'default' ? this.inheritedUltracode(session) : value
        await query.applyFlagSettings({ ultracode })
        session.choices.ultracode = value
        session.config = buildConfig(
          session.models,
          session.choices,
          session.modes,
          session.ultracodeDefault,
          session.inheritedEffort,
        )
        return
      }
    }
    throw new AgentRequestError(
      'agent_error',
      `No option ${optionId} takes ${String(value)}`,
      INVALID_PARAMS,
    )
  }

  /** Flag settings, with the effective ultracode sent again: an effort change without it turns it off. */
  private async applyFlags(session: Session, settings: FlagSettings): Promise<void> {
    const ultracode =
      session.choices.ultracode === 'default'
        ? this.inheritedUltracode(session)
        : session.choices.ultracode
    await session.query!.applyFlagSettings({ ...settings, ultracode })
  }

  /** The value a default choice inherits; unknown is refused rather than taken as off. */
  private inheritedUltracode(session: Session): boolean {
    if (session.ultracodeDefault === null) {
      throw new AgentRequestError(
        'agent_error',
        "Ultracode's inherited value is unknown, so it cannot be applied",
        INVALID_PARAMS,
      )
    }
    return session.ultracodeDefault
  }

  /** Records a choice Claude Code made or took, such as the mode a plan's approval set. */
  private setChoice(session: Session, id: 'mode', value: string): void {
    if (session.choices[id] === value) return
    session.choices[id] = value
    if (value !== 'plan') session.buildMode = value as PermissionMode
    session.config = buildConfig(
      session.models,
      session.choices,
      session.modes,
      session.ultracodeDefault,
      session.inheritedEffort,
    )
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
    if (targetId === session.id)
      return this.ask(session, target, targetId, toolName, input, permission)
    // A subagent waits while any of its permissions is open, as its parent's card shows.
    const open = (this.asking.get(targetId) ?? 0) + 1
    this.asking.set(targetId, open)
    if (open === 1)
      for (const delivery of session.mapper.waiting(targetId, true)) this.deliver(delivery)
    try {
      return await this.ask(session, target, targetId, toolName, input, permission)
    } finally {
      const left = (this.asking.get(targetId) ?? 1) - 1
      if (left > 0) this.asking.set(targetId, left)
      else {
        this.asking.delete(targetId)
        // Withdrawn, the subagent is being stopped rather than running on.
        if (!permission.signal.aborted) {
          for (const delivery of session.mapper.waiting(targetId, false)) this.deliver(delivery)
        }
      }
    }
  }

  private async ask(
    session: Session,
    target: SessionTarget,
    targetId: string,
    toolName: string,
    input: Record<string, unknown>,
    permission: ToolPermissionContext,
  ): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') return this.askQuestions(session, target, input, permission)
    const plan = toolName === 'ExitPlanMode'
    const options = permissionOptions(
      toolName,
      permission,
      session.modes,
      plan ? this.buildMode(session, target) : undefined,
    )
    const output = session.mapper.permissionTool(
      target.context(),
      { type: 'tool_use', id: permission.toolUseID, name: toolName, input },
      targetId,
    )
    let picked: { optionId: string; note?: string } | null
    try {
      const answer = optionAnswer(
        await target.requestPermission(
          {
            toolCallId: permission.toolUseID,
            toolEntryId: `t:${permission.toolUseID}`,
            output,
            options,
            ...(plan ? { plan: typeof input.plan === 'string' ? input.plan : '' } : {}),
          },
          permission.signal,
        ),
      )
      picked = answer === 'cancelled' ? null : answer
    } catch {
      // Withdrawn: Claude Code no longer waits for the answer.
      return permissionResult(null, input, permission)
    }
    const optionId = picked?.optionId ?? null
    const result = plan
      ? planResult(picked, input, permission)
      : permissionResult(optionId, input, permission)
    if (result.behavior === 'allow') {
      target.apply(session.mapper.toolStatus(target.context(), permission.toolUseID, 'in_progress'))
      const mode = optionId ? answeredMode(optionId) : null
      if (mode) this.setChoice(session, 'mode', mode)
    }
    return result
  }

  /**
   * The mode a plan's approval starts with chosen: the last one the session used before it
   * planned; for a session that started in plan mode, the one its agent's new sessions start in.
   */
  private buildMode(session: Session, target: SessionTarget): PermissionMode {
    const candidates = [session.buildMode, target.startMode(), session.openMode]
    const offered = candidates.find(
      (mode): mode is PermissionMode =>
        typeof mode === 'string' &&
        BUILD_MODES.includes(mode as PermissionMode) &&
        session.modes.includes(mode as PermissionMode),
    )
    return offered ?? 'default'
  }

  /**
   * AskUserQuestion's questions as one card, answered together; Claude Code takes the answers
   * keyed by question, and a question the user skipped has none. Something else is the user's own
   * words in the card; a client without the card's questions sends an option id instead, which
   * answers the first question alone or, for Something else, waits for the next message.
   */
  private async askQuestions(
    session: Session,
    target: SessionTarget,
    input: Record<string, unknown>,
    permission: ToolPermissionContext,
  ): Promise<PermissionResult> {
    const { toolUseID } = permission
    const questions = askedQuestions(input)
    if (!questions) return { behavior: 'deny', message: QUESTION_UNREADABLE, toolUseID }
    const block = { type: 'tool_use' as const, id: toolUseID, name: 'AskUserQuestion', input }
    let answer: PermissionAnswer
    try {
      answer = await target.requestPermission(
        {
          toolCallId: toolUseID,
          toolEntryId: `t:${toolUseID}`,
          output: session.mapper.permissionTool(target.context(), block, session.id),
          options: questionOptions(questions[0]!),
          questions: pendingQuestions(questions),
        },
        permission.signal,
      )
    } catch {
      return permissionResult(null, input, permission)
    }
    if (answer === 'cancelled' || 'values' in answer)
      return permissionResult(null, input, permission)
    let answers: Record<string, string>
    if ('answers' in answer) {
      answers = questionAnswers(questions, answer.answers)
      if (Object.keys(answers).length === 0) {
        return { behavior: 'deny', message: QUESTIONS_SKIPPED, toolUseID }
      }
    } else {
      const chosen = questions[0]!.options[Number(answer.optionId.replace(/^answer:/, ''))]
      if (answer.optionId === OTHER_ANSWER || !chosen) {
        return { behavior: 'deny', message: ANSWER_IN_REPLY, toolUseID }
      }
      answers = { [questions[0]!.question]: chosen.label }
    }
    target.apply(session.mapper.toolStatus(target.context(), toolUseID, 'in_progress'))
    return { behavior: 'allow', updatedInput: { ...input, answers }, toolUseID }
  }

  // MCP servers' requests.

  /**
   * An MCP server's form or page as a card, answered with the form's values or by opening the page.
   * A page the user opened stays in progress until its server reports it done.
   */
  private async elicit(
    session: Session,
    request: ElicitationRequest,
    requestId: string,
    signal: AbortSignal,
  ): Promise<ElicitationResult> {
    const target = this.targets.get(session.id)
    if (!target || session.quiet) return { action: 'decline' }
    const server = request.displayName || request.serverName
    let elicitation: PendingElicitation
    if (request.mode === 'url') {
      // Only a web page is offered; anything else could open a program on the user's computer.
      if (!request.url || !isWebUrl(request.url)) return { action: 'decline' }
      elicitation = { kind: 'url', server, message: request.message, url: request.url }
    } else {
      const fields = formFields(request.requestedSchema ?? {})
      if (!fields) {
        this.context.hooks.ignored(session.id, `a form from ${server} that Kettu cannot show`)
        return { action: 'decline' }
      }
      elicitation = { kind: 'form', server, message: request.message, fields }
    }
    const ctx = target.context()
    const entryId = ctx.nextId()
    const entry: ToolEntry = {
      kind: 'tool',
      id: entryId,
      title:
        request.title ||
        t(elicitation.kind === 'url' ? 'elicitation.urlTitle' : 'elicitation.formTitle', {
          server,
        }),
      toolKind: 'other',
      status: 'pending',
      content: request.message ? [{ type: 'markdown', markdown: request.message }] : [],
      locations: [],
      permission: null,
      permissionResult: null,
      elicitation: {
        server,
        kind: elicitation.kind,
        ...(elicitation.kind === 'url' ? { url: elicitation.url } : {}),
      },
    }
    const options =
      elicitation.kind === 'url'
        ? [
            { id: 'accept', name: t('elicitation.open'), kind: 'allow_once' as const },
            { id: 'decline', name: t('elicitation.decline'), kind: 'reject_once' as const },
          ]
        : [
            { id: 'accept', name: t('elicitation.submit'), kind: 'allow_once' as const },
            { id: 'decline', name: t('elicitation.decline'), kind: 'reject_once' as const },
          ]
    let result: ElicitationResult
    try {
      const answer = await target.requestPermission(
        {
          toolCallId: `elicitation:${requestId}`,
          toolEntryId: entryId,
          output: { patches: [{ op: 'entry.add', entry }], effects: [] },
          options,
          elicitation,
        },
        signal,
      )
      if (answer === 'cancelled' || 'answers' in answer) result = { action: 'cancel' }
      else if ('values' in answer) result = { action: 'accept', content: answer.values }
      else result = { action: answer.optionId === 'accept' ? 'accept' : 'decline' }
    } catch {
      // Withdrawn: the SDK no longer waits for the answer.
      return { action: 'cancel' }
    }
    let status: ToolEntry['status'] = result.action === 'cancel' ? 'cancelled' : 'completed'
    if (result.action === 'accept' && elicitation.kind === 'url' && request.elicitationId) {
      status = 'in_progress'
      this.openPages.set(request.elicitationId, { targetId: session.id, entryId })
      if (this.openPages.size > OPEN_PAGES) {
        this.openPages.delete(this.openPages.keys().next().value!)
      }
    }
    this.setStatus(target, entryId, status)
    return result
  }

  private pageDone(message: ElicitationCompleteMessage): void {
    const page = this.openPages.get(message.elicitation_id)
    if (!page) return
    this.openPages.delete(message.elicitation_id)
    const target = this.targets.get(page.targetId)
    if (target) this.setStatus(target, page.entryId, 'completed')
  }

  private setStatus(target: SessionTarget, entryId: string, status: ToolEntry['status']): void {
    const entry = target.context().thread.byId[entryId]
    if (entry?.kind !== 'tool' || entry.status === status) return
    target.apply({
      patches: [{ op: 'entry.update', id: entryId, changes: { status } }],
      effects: [],
    })
  }

  // Reports.

  /** The plan limits, and the account with them, which Settings reads together. */
  async readLimits(): Promise<PlanLimit[]> {
    // Reported again even when unchanged, since the reader may have forgotten it.
    this.account = null
    const open = [...this.sessions.values()].find((session) => session.query && !session.stale)
    let temporary: Session | null = null
    if (!open) {
      try {
        temporary = await this.temporary(os.tmpdir(), { hidden: 'limits' })
      } catch (error) {
        // The query can fail while the CLI already knows the sign-in. Ask it before giving up.
        this.context.hooks.log(
          'warn',
          `Claude Code's plan limits could not be read: ${errorText(error)}`,
        )
        const account = await this.authStatus()
        if (account) this.report(account)
        return []
      }
    }
    const query = open?.query ?? temporary?.query
    try {
      if (query) await this.readAccount(query)
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

  /** The account a query runs under; Claude Code's own status tells when it is signed out. */
  private async readAccount(query: Query): Promise<void> {
    let info: AccountInfo | undefined
    try {
      info = await query.accountInfo()
    } catch (error) {
      this.context.hooks.log('warn', `Claude Code's account could not be read: ${errorText(error)}`)
    }
    const account = mapAccount(info) ?? (await this.authStatus())
    if (account) this.report(account)
  }

  private async authStatus(): Promise<AgentAccount | null> {
    if (!this.cli) return null
    const child = this.context.spawn({
      command: this.cli,
      args: ['auth', 'status', '--json'],
      env: this.env,
      signal: AbortSignal.timeout(AUTH_STATUS_MS),
    })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.resume()
    try {
      // Signed out, it exits with 1 and still writes its status.
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', () => resolve())
      })
    } catch (error) {
      this.context.hooks.log('warn', `claude auth status failed: ${errorText(error)}`)
      return null
    }
    return mapAuthStatus(stdout)
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
      return mapContextUsage(await query.getContextUsage({ detail: 'summary' }), Date.now(), {
        cwd,
        home: os.homedir(),
      })
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
