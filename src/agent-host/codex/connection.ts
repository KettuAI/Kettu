// One connection to `codex app-server`, which serves every Codex session of the agent. A Kettu
// session is a Codex thread under the thread's own id; its settings live here and go with each
// turn, since app-server keeps none between them that Kettu could read back.

import os from 'node:os'
import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import type { ConfigOption, TokenTotals } from '@shared/thread'
import {
  programFailure,
  runProgram,
  type ProgramOptions,
  type ProgramRun,
} from '../adapter-install'
import type { LaunchSpec } from '../catalog'
import {
  AgentRequestError,
  type AgentConnection,
  type AgentInit,
  type AuthMethodInfo,
  type ConnectionHooks,
  type ForkPoint,
  type ListedSession,
  type McpServer,
  type OpenedSession,
  type PromptBlock,
  type PromptResult,
  type SessionOptions,
  type SessionSetup,
  type SessionTarget,
} from '../connection'
import type { AgentTransport } from '../driver'
import type { Env } from '../find-command'
import { t } from '../i18n'
import type { MapperEffect, MapperOutput } from '../session-updates'
import { mapAccount, mapRateLimits } from './account'
import {
  commandApproval,
  elicitationApproval,
  fileChangeApproval,
  permissionsApproval,
  refusal,
  userInputApproval,
  type Approval,
} from './approvals'
import {
  applyOption,
  buildConfig,
  ConfigValueError,
  DEFAULT_MODE,
  effortFor,
  fastTier,
  modeFromPolicy,
  modeOf,
  type Settings,
} from './config'
import { childThreads, childTurnEffect, ThreadMapper } from './mapper'
import type {
  CollaborationMode,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  InitializeResponse,
  JsonValue,
  Model,
  ModelListResponse,
  RateLimitSnapshot,
  RequestId,
  SandboxMode,
  SandboxPolicy,
  Thread,
  ThreadItem,
  ThreadItemsListResponse,
  ThreadListResponse,
  ThreadResponse,
  TokenUsageBreakdown,
  Turn,
  TurnError,
  UserInput,
} from './protocol'
import { messageStream, methodNotFound, RpcClosed, RpcError, RpcPeer } from './rpc'

/** What the driver knows of the launch, for the sign-in and sign-out Codex runs in a terminal. */
export interface CodexLaunch {
  spec: LaunchSpec
  env: Env
  platform: Platform
  /** Runs `codex logout`; tests pass their own. */
  run?(options: ProgramOptions): Promise<ProgramRun>
}

const RESOURCE_NOT_FOUND = -32002
const INVALID_REQUEST = -32600

// Updates for a thread nobody registered yet wait here, as ACP's do.
const PENDING_THREADS = 32
const PENDING_UPDATES = 2_000
const PENDING_TTL_MS = 60_000
const CLOSED_THREADS = 256
const KNOWN_CHILDREN = 1_000

/** The kinds of thread `thread/list` names, as codex-acp listed them; subagents are left out. */
const LISTED_SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'unknown']

// Notifications that change nothing Kettu shows.
const QUIET = new Set([
  'turn/started',
  'turn/completed',
  'turn/diff/updated',
  'thread/status/changed',
  'thread/settings/updated',
  'thread/readState/changed',
  'thread/closed',
  'thread/archived',
  'thread/unarchived',
  'thread/deleted',
  'thread/compacted',
  'item/fileChange/outputDelta',
  'item/mcpToolCall/progress',
  'item/commandExecution/terminalInteraction',
  'mcpServer/startupStatus/updated',
  'remoteControl/status/changed',
  'skills/changed',
  'turn/moderationMetadata',
])

// Opted out of at `initialize`, so they never cross the pipe.
const OPTED_OUT = ['turn/moderationMetadata']

const NOT_FOUND = /no rollout found|thread not loaded|thread not found|unknown thread/i

function totals(usage: TokenUsageBreakdown): TokenTotals {
  return {
    total: usage.totalTokens,
    // Codex counts the cached and cache-written input in its input; Kettu counts them apart.
    input: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens),
    output: usage.outputTokens,
    thought: usage.reasoningOutputTokens,
    cacheRead: usage.cachedInputTokens,
    cacheWrite: usage.cacheWriteInputTokens,
  }
}

function addUsage(sum: TokenUsageBreakdown | null, next: TokenUsageBreakdown): TokenUsageBreakdown {
  if (!sum) return { ...next }
  return {
    totalTokens: sum.totalTokens + next.totalTokens,
    inputTokens: sum.inputTokens + next.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + next.cachedInputTokens,
    cacheWriteInputTokens: sum.cacheWriteInputTokens + next.cacheWriteInputTokens,
    outputTokens: sum.outputTokens + next.outputTokens,
    reasoningOutputTokens: sum.reasoningOutputTokens + next.reasoningOutputTokens,
  }
}

/** `[@name](uri)`, as codex-acp sent a file link, which a replay reads back as an attachment. */
function fileLink(name: string | null, uri: string): string {
  if (name) return `[@${name}](${uri})`
  if (uri.startsWith('file://')) {
    const file = uri.replace('file://', '')
    return `[@${file.split('/').pop() ?? file}](${uri})`
  }
  return uri
}

/** Kettu's prompt blocks as Codex's input, in the forms codex-acp sent them. */
export function userInputs(prompt: readonly PromptBlock[]): UserInput[] {
  return prompt.map((block): UserInput => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text, text_elements: [] }
      case 'image':
        return { type: 'image', url: `data:${block.mimeType};base64,${block.data}` }
      case 'resource_link':
        return { type: 'text', text: fileLink(block.name, block.uri), text_elements: [] }
      case 'resource': {
        const { uri, text } = block.resource
        return {
          type: 'text',
          text: `${fileLink(null, uri)}\n<context ref="${uri}">\n${text}\n</context>`,
          text_elements: [],
        }
      }
    }
  })
}

function sandboxMode(policy: SandboxPolicy): SandboxMode {
  if (policy.type === 'readOnly') return 'read-only'
  if (policy.type === 'dangerFullAccess') return 'danger-full-access'
  return 'workspace-write'
}

/** Per-session config Codex takes at start: the folder trusted, as codex-acp did, and Kettu's MCP. */
function sessionConfig(
  cwd: string,
  servers: readonly McpServer[] | undefined,
): Record<string, JsonValue> {
  const config: Record<string, JsonValue> = { projects: { [cwd]: { trust_level: 'trusted' } } }
  if (servers && servers.length > 0) {
    config.mcp_servers = Object.fromEntries(
      servers.map((server) => [
        server.name.replace(/\s+/g, '_'),
        {
          url: server.url,
          http_headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
        },
      ]),
    )
  }
  return config
}

interface Prompting {
  turnId: string | null
  cancel: boolean
  resolve(result: PromptResult): void
  reject(error: Error): void
}

interface Running {
  id: string
  usage: TokenUsageBreakdown | null
  error: TurnError | null
}

interface ThreadRecord {
  id: string
  settings: Settings
  /** The settings are the session's own, from its open, not a guess for a thread Kettu saw. */
  known: boolean
  /** Opened for Kettu itself and kept by nobody: an ephemeral thread. */
  hidden: boolean
  prompted: boolean
  mapper: ThreadMapper
  running: Running | null
  prompting: Prompting | null
}

type Delivery = { method: string; params: unknown }

export class CodexConnection implements AgentConnection {
  private readonly rpc: RpcPeer
  private readonly closeTransport: () => void
  private readonly threads = new Map<string, ThreadRecord>()
  private readonly targets = new Map<string, SessionTarget>()
  private readonly pending = new Map<string, { at: number; updates: Delivery[] }>()
  private readonly unregistered = new Set<string>()
  private readonly collectors = new Map<string, (delivery: Delivery) => void>()
  /** Subagent threads, to the thread each runs under. */
  private readonly parents = new Map<string, string>()
  private models: Promise<Model[]> | null = null
  /** The models once listed, which each turn's service tier is read from. */
  private knownModels: Model[] = []
  private initialized = false

  constructor(
    transport: AgentTransport,
    private readonly hooks: ConnectionHooks,
    private readonly launch: CodexLaunch | null = null,
  ) {
    const { stream, close } = messageStream(transport)
    this.closeTransport = close
    this.rpc = new RpcPeer(stream, {
      notification: (method, params) => this.onNotification(method, params),
      request: (method, params, id, signal) => this.onRequest(method, params, id, signal),
      traffic: (direction, message) => hooks.traffic(direction, message),
      log: (level, message) => hooks.log(level, message),
    })
  }

  get closed(): Promise<void> {
    return this.rpc.closed
  }

  get isClosed(): boolean {
    return this.rpc.isClosed
  }

  close(): void {
    this.rpc.close()
    this.closeTransport()
  }

  // Requests to app-server.

  private async call<T>(method: string, params?: unknown): Promise<T> {
    try {
      return await this.rpc.request<T>(method, params)
    } catch (error) {
      throw this.toError(error)
    }
  }

  private toError(error: unknown): AgentRequestError {
    if (error instanceof AgentRequestError) return error
    if (error instanceof RpcClosed || this.rpc.isClosed) {
      return new AgentRequestError('closed', 'The agent connection closed')
    }
    if (error instanceof RpcError) {
      // A thread with no rollout, which a thread never prompted is, counts as one Codex lacks.
      const code = NOT_FOUND.test(error.message) ? RESOURCE_NOT_FOUND : error.code
      return new AgentRequestError('agent_error', error.message, code, error.data)
    }
    return new AgentRequestError('agent_error', (error as Error)?.message ?? String(error))
  }

  async initialize(appVersion: string, signal?: AbortSignal): Promise<AgentInit> {
    const answer = this.call<InitializeResponse>('initialize', {
      clientInfo: { name: 'Kettu', title: 'Kettu', version: appVersion },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: OPTED_OUT,
      },
    })
    const response = await (signal
      ? Promise.race([
          answer,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason as Error)
            signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
          }),
        ])
      : answer)
    this.rpc.notify('initialized')
    this.initialized = true
    // `<client>/<Codex version> (...)`, the only place app-server says its version.
    const version = /^[^/\s]+\/(\S+)/.exec(response.userAgent ?? '')?.[1] ?? null
    void this.refreshAccount()
    return {
      name: 'Codex',
      version,
      capabilities: {
        loadSession: true,
        listSessions: true,
        resumeSession: true,
        closeSession: true,
        deleteSession: true,
        forkSession: true,
        forkAtMessage: true,
        // app-server names no thread by itself; Codex's own clients write the titles.
        ownTitles: null,
        logout: this.launch !== null,
        steering: true,
        mcpHttp: true,
        prompt: { image: true, audio: false, embeddedContext: true },
      },
      authMethods: this.authMethods(),
      raw: response,
    }
  }

  /** `codex login` in a terminal; app-server's own sign-in is not for other products to use. */
  private authMethods(): AuthMethodInfo[] {
    const program = this.launch?.spec.command
    if (!program) return []
    const method = (id: string, key: 'chatGpt' | 'deviceCode' | 'apiKey', args: string[]) => ({
      id,
      name: t(`codex.auth.${key}.name`),
      description: t(`codex.auth.${key}.description`),
      type: 'terminal' as const,
      command: program,
      args,
      env: {},
    })
    return [
      method('chat-gpt', 'chatGpt', ['login']),
      method('chat-gpt-device-code', 'deviceCode', ['login', '--device-auth']),
      method('api-key', 'apiKey', ['login', '--with-api-key']),
    ]
  }

  async authenticate(): Promise<void> {
    throw new AgentRequestError('agent_error', 'Codex signs in through `codex login` in a terminal')
  }

  /** `codex logout`, with the program and environment the agent runs with. */
  async logout(): Promise<void> {
    const launch = this.launch
    if (!launch) throw new AgentRequestError('agent_error', 'Codex cannot sign out here')
    const timeoutMs = 30_000
    const run = await (launch.run ?? runProgram)({
      program: launch.spec.command,
      args: ['logout'],
      cwd: os.homedir(),
      env: { ...launch.env, ...launch.spec.env },
      platform: launch.platform,
      timeoutMs,
    })
    const failure = programFailure('codex logout', run, timeoutMs)
    if (failure) throw new AgentRequestError('agent_error', failure)
    void this.refreshAccount()
  }

  private async refreshAccount(): Promise<AgentAccount | null> {
    try {
      const account = mapAccount(
        await this.call<GetAccountResponse>('account/read', { refreshToken: false }),
      )
      this.hooks.account(account)
      return account
    } catch (error) {
      if (!this.isClosed) {
        this.hooks.log('warn', `Could not read the Codex account: ${(error as Error).message}`)
      }
      return null
    }
  }

  /** Rejects with `auth_required` before a session opens on an install with no sign-in. */
  private async requireSignIn(): Promise<void> {
    let response: GetAccountResponse
    try {
      response = await this.call<GetAccountResponse>('account/read', { refreshToken: false })
    } catch (error) {
      // An answer without the login lets the session open; a missing login fails its first turn.
      if (error instanceof AgentRequestError && error.kind === 'closed') throw error
      return
    }
    this.hooks.account(mapAccount(response))
    if (response.requiresOpenaiAuth && !response.account) {
      throw new AgentRequestError('auth_required', t('codex.signInNeeded'))
    }
  }

  // Sessions.

  private listModels(): Promise<Model[]> {
    this.models ??= (async () => {
      const models: Model[] = []
      let cursor: string | null = null
      do {
        const page: ModelListResponse = await this.call<ModelListResponse>('model/list', {
          cursor,
          limit: null,
        })
        models.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)
      this.knownModels = models
      return models
    })().catch((error: unknown) => {
      this.models = null
      this.hooks.log('warn', `Could not list Codex's models: ${(error as Error).message}`)
      return []
    })
    return this.models
  }

  private async record(
    id: string,
    response: ThreadResponse,
    hidden: boolean,
    base?: Settings,
  ): Promise<ThreadRecord> {
    const models = await this.listModels()
    const modelId = base?.model ?? response.model
    const model = models.find((item) => item.id === modelId)
    const settings: Settings = base
      ? { ...base, effort: effortFor(model, base.effort) }
      : {
          mode: modeFromPolicy(response),
          collaboration: response.collaborationMode?.mode ?? 'default',
          model: modelId,
          effort: effortFor(model, response.reasoningEffort),
          fast: !!response.serviceTier && response.serviceTier === fastTier(model),
        }
    const record: ThreadRecord = {
      id,
      settings,
      hidden,
      known: true,
      prompted: false,
      mapper: this.threads.get(id)?.mapper ?? new ThreadMapper(),
      running: null,
      prompting: null,
    }
    this.threads.set(id, record)
    return record
  }

  private async config(record: ThreadRecord): Promise<ConfigOption[]> {
    return buildConfig(record.settings, await this.listModels())
  }

  async newSession(cwd: string, options: SessionOptions = {}): Promise<OpenedSession> {
    await this.requireSignIn()
    const mode = modeOf(DEFAULT_MODE)!
    const hidden = options.hidden !== undefined
    const response = await this.call<ThreadResponse>('thread/start', {
      cwd,
      approvalPolicy: mode.approvalPolicy,
      approvalsReviewer: mode.approvalsReviewer,
      sandbox: sandboxMode(mode.sandbox),
      config: sessionConfig(cwd, options.mcpServers),
      ephemeral: hidden,
      experimentalRawEvents: false,
    })
    const record = await this.record(response.thread.id, response, hidden)
    record.settings = { ...record.settings, mode: DEFAULT_MODE }
    return { sessionId: record.id, config: await this.config(record) }
  }

  private async resume(
    threadId: string,
    cwd: string,
    options: SessionOptions,
  ): Promise<ThreadRecord> {
    await this.requireSignIn()
    const seen = this.threads.get(threadId)
    const known = seen?.known ? seen.settings : undefined
    const mode = known ? modeOf(known.mode) : null
    const response = await this.call<ThreadResponse>('thread/resume', {
      threadId,
      cwd,
      ...(mode
        ? {
            approvalPolicy: mode.approvalPolicy,
            approvalsReviewer: mode.approvalsReviewer,
            sandbox: sandboxMode(mode.sandbox),
          }
        : {}),
      config: sessionConfig(cwd, options.mcpServers),
      excludeTurns: true,
    })
    const record = await this.record(threadId, response, options.hidden !== undefined, known)
    record.prompted = true
    return record
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const record = await this.resume(sessionId, cwd, options)
    return { config: await this.config(record) }
  }

  /** `thread/resume`, then the thread's items to its target, as a replay. */
  async loadSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const record = await this.resume(sessionId, cwd, options)
    const children = await this.replay(record)
    for (const child of children) {
      // A subagent's own history, for a child Kettu shows; one it cannot read stays as it was.
      if (!this.targets.has(child)) continue
      const childRecord = this.threads.get(child) ?? this.child(child, record.id)
      await this.replay(childRecord).catch((error: unknown) => {
        this.hooks.log(
          'warn',
          `Could not replay Codex subagent ${child}: ${(error as Error).message}`,
        )
      })
    }
    return { config: await this.config(record) }
  }

  /** The thread's history, oldest first, each item with its turn. */
  private async items(threadId: string): Promise<ThreadItemsListResponse['data']> {
    const entries: ThreadItemsListResponse['data'] = []
    let cursor: string | null = null
    do {
      const page: ThreadItemsListResponse = await this.call<ThreadItemsListResponse>(
        'thread/items/list',
        { threadId, cursor, limit: 200, sortDirection: 'asc' },
      )
      entries.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)
    return entries
  }

  /** Replays a thread's items to its target; returns the subagents they name. */
  private async replay(record: ThreadRecord): Promise<string[]> {
    const entries = await this.items(record.id)
    const children: string[] = []
    for (const { item } of entries) {
      for (const child of childThreads(item)) {
        this.learnChild(child, record.id)
        if (!children.includes(child)) children.push(child)
      }
      const target = this.targets.get(record.id)
      if (target) target.apply(record.mapper.replay(item, target.context()))
    }
    return children
  }

  async forkSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
    point?: ForkPoint,
  ): Promise<OpenedSession> {
    await this.requireSignIn()
    const from = this.threads.get(sessionId)
    const source = from?.known ? from.settings : undefined
    const lastTurnId = point ? await this.turnOf(sessionId, point) : null
    const hidden = options.hidden !== undefined
    const mode = modeOf(source?.mode ?? DEFAULT_MODE)!
    const response = await this.call<ThreadResponse>('thread/fork', {
      threadId: sessionId,
      ...(lastTurnId ? { lastTurnId } : {}),
      cwd,
      approvalPolicy: mode.approvalPolicy,
      approvalsReviewer: mode.approvalsReviewer,
      sandbox: sandboxMode(mode.sandbox),
      // A fork takes the model and effort of the configuration, not of its source.
      ...(source ? { model: source.model } : {}),
      config: sessionConfig(cwd, options.mcpServers),
      ephemeral: hidden,
      excludeTurns: true,
    })
    const record = await this.record(response.thread.id, response, hidden, source)
    record.prompted = true
    return { sessionId: record.id, config: await this.config(record) }
  }

  /**
   * The turn that ends at `point`: the turn of the agent message with its id, or of the nth agent
   * message with its text, for a message whose id Codex does not know.
   */
  private async turnOf(threadId: string, point: ForkPoint): Promise<string> {
    const entries = await this.items(threadId)
    const byId = entries.find((entry) => entry.item.id === point.messageId)
    if (byId) return byId.turnId
    const same = entries.filter(
      (entry) => entry.item.type === 'agentMessage' && entry.item.text === point.text,
    )
    const byText = same[point.occurrence - 1]
    if (byText) return byText.turnId
    throw new AgentRequestError('agent_error', t('codex.noForkPoint'))
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.call('thread/unsubscribe', { threadId: sessionId })
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.call('thread/delete', { threadId: sessionId })
    this.threads.delete(sessionId)
  }

  async listSessions(
    cwd: string,
    cursor: string | null,
  ): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    const response = await this.call<ThreadListResponse>('thread/list', {
      cwd,
      cursor,
      sourceKinds: LISTED_SOURCES,
    })
    return {
      sessions: response.data
        .filter((thread) => !thread.parentThreadId && !thread.ephemeral)
        .map((thread) => ({
          sessionId: thread.id,
          title: listedTitle(thread),
          updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
          cwd: thread.cwd,
        })),
      nextCursor: response.nextCursor,
    }
  }

  // Routing.

  register(sessionId: string, target: SessionTarget): void {
    this.targets.set(sessionId, target)
    this.unregistered.delete(sessionId)
    const early = this.pending.get(sessionId)
    if (!early) return
    this.pending.delete(sessionId)
    for (const update of early.updates) this.toTarget(sessionId, target, update)
  }

  unregister(sessionId: string, target?: SessionTarget): void {
    if (target && this.targets.get(sessionId) !== target) return
    this.targets.delete(sessionId)
    this.pending.delete(sessionId)
    this.unregistered.add(sessionId)
    if (this.unregistered.size > CLOSED_THREADS) {
      this.unregistered.delete(this.unregistered.values().next().value!)
    }
  }

  reopen(sessionId: string): void {
    this.unregistered.delete(sessionId)
  }

  rootOf(id: string): string {
    let current = id
    for (let depth = 0; depth < 16; depth++) {
      if (this.targets.has(current)) return current
      const parent = this.parents.get(current)
      if (!parent) break
      current = parent
    }
    return this.targets.has(current) ? current : (this.parents.get(id) ?? id)
  }

  private learnChild(child: string, parent: string): void {
    if (child === parent || this.parents.get(child) === parent) return
    this.parents.delete(child)
    this.parents.set(child, parent)
    if (this.parents.size > KNOWN_CHILDREN) this.parents.delete(this.parents.keys().next().value!)
  }

  private child(id: string, parent: string): ThreadRecord {
    const parentSettings = this.threads.get(parent)?.settings
    const record: ThreadRecord = {
      id,
      settings: parentSettings ?? {
        mode: DEFAULT_MODE,
        collaboration: 'default',
        model: '',
        effort: null,
        fast: false,
      },
      hidden: false,
      known: false,
      prompted: true,
      mapper: new ThreadMapper(),
      running: null,
      prompting: null,
    }
    this.threads.set(id, record)
    return record
  }

  private thread(id: string): ThreadRecord {
    const record = this.threads.get(id)
    if (record) return record
    const parent = this.parents.get(id)
    if (parent) return this.child(id, parent)
    const created: ThreadRecord = {
      id,
      settings: {
        mode: DEFAULT_MODE,
        collaboration: 'default',
        model: '',
        effort: null,
        fast: false,
      },
      hidden: false,
      known: false,
      prompted: true,
      mapper: new ThreadMapper(),
      running: null,
      prompting: null,
    }
    this.threads.set(id, created)
    return created
  }

  private toTarget(threadId: string, target: SessionTarget, { method, params }: Delivery): void {
    const record = this.thread(threadId)
    const mapped = record.mapper.notification(method, params, target.context())
    if (mapped) target.apply(mapped)
    else this.hooks.ignored(threadId, `notification ${method}`)
  }

  private deliver(threadId: string, delivery: Delivery): void {
    const collector = this.collectors.get(threadId)
    if (collector) {
      collector(delivery)
      return
    }
    const target = this.targets.get(threadId)
    if (target) {
      this.toTarget(threadId, target, delivery)
      return
    }
    if (this.unregistered.has(threadId)) {
      this.hooks.ignored(threadId, 'update for a session Kettu closed')
      return
    }
    const now = Date.now()
    for (const [id, entry] of this.pending) {
      if (now - entry.at > PENDING_TTL_MS) {
        this.pending.delete(id)
        this.hooks.ignored(id, `${entry.updates.length} updates for a session Kettu does not have`)
      }
    }
    let entry = this.pending.get(threadId)
    if (!entry) {
      if (this.pending.size >= PENDING_THREADS) {
        this.hooks.ignored(threadId, 'update for an unknown session')
        return
      }
      entry = { at: now, updates: [] }
      this.pending.set(threadId, entry)
    }
    if (entry.updates.length < PENDING_UPDATES) entry.updates.push(delivery)
  }

  /** Effects for the session a subagent runs under, which Kettu keeps the subagent's state on. */
  private toParent(childId: string, effects: MapperEffect[]): void {
    const parent = this.parents.get(childId)
    const target = parent ? this.targets.get(parent) : undefined
    if (target) target.apply({ patches: [], effects } satisfies MapperOutput)
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'serverRequest/resolved':
        this.rpc.withdraw(p.requestId as RequestId)
        return
      case 'account/updated':
        void this.refreshAccount()
        return
      case 'account/rateLimits/updated':
        this.pushLimits(p.rateLimits as RateLimitSnapshot)
        return
      case 'thread/started':
        this.threadStarted(p.thread as Thread)
        return
      case 'error':
        this.turnError(p)
        return
      case 'deprecationNotice':
      case 'configWarning':
        this.hooks.log('warn', `Codex: ${String(p.summary ?? p.message ?? method)}`)
        return
    }
    const threadId = typeof p.threadId === 'string' ? p.threadId : null
    if (!threadId) {
      if (!QUIET.has(method)) this.hooks.ignored(null, `notification ${method}`)
      return
    }
    switch (method) {
      case 'turn/started':
        this.turnStarted(threadId, p.turn as Turn)
        break
      case 'thread/tokenUsage/updated':
        this.countTokens(threadId, p)
        break
      case 'item/started':
      case 'item/completed':
        for (const child of childThreads(p.item as ThreadItem)) {
          this.learnChild(child, threadId)
        }
        break
    }
    if (!QUIET.has(method)) this.deliver(threadId, { method, params })
    if (method === 'turn/completed') this.turnCompleted(threadId, p.turn as Turn)
  }

  private threadStarted(thread: Thread | undefined): void {
    if (!thread?.parentThreadId) return
    this.learnChild(thread.id, thread.parentThreadId)
    const title = thread.agentNickname ?? thread.agentRole
    this.toParent(thread.id, [
      {
        kind: 'subagent',
        sessionId: thread.id,
        canCancel: true,
        ...(title ? { title } : {}),
      },
    ])
  }

  private turnStarted(threadId: string, turn: Turn): void {
    const record = this.thread(threadId)
    record.running = { id: turn.id, usage: null, error: null }
    const prompting = record.prompting
    if (prompting && prompting.turnId === null) {
      prompting.turnId = turn.id
      if (prompting.cancel) void this.interrupt(threadId, turn.id)
    }
    if (this.parents.has(threadId)) this.toParent(threadId, [childTurnEffect(threadId, null, null)])
  }

  private countTokens(threadId: string, params: Record<string, unknown>): void {
    const running = this.threads.get(threadId)?.running
    const usage = params.tokenUsage as { last?: TokenUsageBreakdown } | undefined
    if (!running || !usage?.last || (params.turnId && params.turnId !== running.id)) return
    running.usage = addUsage(running.usage, usage.last)
  }

  private turnError(params: Record<string, unknown>): void {
    if (params.willRetry === true) return
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    const running = threadId ? this.threads.get(threadId)?.running : null
    if (running && (!params.turnId || params.turnId === running.id)) {
      running.error = params.error as TurnError
    }
  }

  private turnCompleted(threadId: string, turn: Turn): void {
    const record = this.thread(threadId)
    const running = record.running?.id === turn.id ? record.running : null
    record.running = null
    const usage = running?.usage ?? null
    const tokens = usage ? totals(usage) : null
    if (this.parents.has(threadId)) {
      this.toParent(threadId, [childTurnEffect(threadId, turn, tokens)])
    }
    const prompting = record.prompting
    if (!prompting || (prompting.turnId !== null && prompting.turnId !== turn.id)) return
    record.prompting = null
    if (turn.status === 'failed') {
      prompting.reject(this.turnFailure(turn.error ?? running?.error ?? null))
      return
    }
    prompting.resolve({
      stopReason: turn.status === 'interrupted' ? 'cancelled' : 'end_turn',
      tokens,
      models: tokens && record.settings.model ? [{ model: record.settings.model, tokens }] : [],
    })
  }

  private turnFailure(error: TurnError | null): AgentRequestError {
    const info = error?.codexErrorInfo ?? null
    const status =
      typeof info === 'object' && info !== null && !Array.isArray(info)
        ? (Object.values(info)[0] as { httpStatusCode?: unknown } | undefined)?.httpStatusCode
        : undefined
    const message = error?.message ?? t('codex.turnFailed')
    if (info === 'unauthorized' || status === 401) {
      return new AgentRequestError('auth_required', message)
    }
    return new AgentRequestError('agent_error', error?.additionalDetails ?? message, null, {
      codexErrorInfo: info,
      ...(typeof status === 'number' ? { status } : {}),
      message,
    })
  }

  private pushLimits(snapshot: RateLimitSnapshot | undefined): void {
    if (!snapshot) return
    const limits = mapRateLimits(snapshot, Date.now())
    if (limits.length === 0) return
    // The limits are the account's, so any session can carry them; one with a turn first.
    const threadId =
      [...this.targets.keys()].find((id) => this.threads.get(id)?.running) ??
      this.targets.keys().next().value
    const target = threadId ? this.targets.get(threadId) : undefined
    if (!target) return
    target.apply({ patches: [], effects: limits.map((limit) => ({ kind: 'limit', limit })) })
  }

  // Requests from app-server.

  private async onRequest(
    method: string,
    params: unknown,
    id: RequestId,
    signal: AbortSignal,
  ): Promise<unknown> {
    const p = params as { threadId?: string }
    const threadId = typeof p?.threadId === 'string' ? p.threadId : null
    const target = threadId ? this.targets.get(threadId) : undefined
    if (refusal(method) === null) throw methodNotFound(method)
    if (!target || !threadId) {
      // Never approve without the user: a request for an unknown session is declined.
      this.hooks.log('warn', `Codex request ${method} for unknown session ${threadId ?? ''}`)
      return refusal(method)
    }
    const record = this.thread(threadId)
    const ctx = target.context()
    let approval: Approval | null
    switch (method) {
      case 'item/commandExecution/requestApproval':
        approval = commandApproval(params as never, record.mapper, ctx)
        break
      case 'item/fileChange/requestApproval':
        approval = fileChangeApproval(params as never, record.mapper, ctx)
        break
      case 'item/permissions/requestApproval':
        approval = permissionsApproval(params as never, record.mapper, ctx)
        break
      case 'item/tool/requestUserInput':
        approval = userInputApproval(params as never, record.mapper, ctx)
        break
      default:
        approval = elicitationApproval(params as never, id, record.mapper, ctx)
    }
    if (!approval) {
      this.hooks.ignored(threadId, `${method} that Kettu cannot ask`)
      return refusal(method)
    }
    const answer = await target.requestPermission(approval.request, signal)
    return approval.respond(answer)
  }

  // Turns.

  private turnParams(record: ThreadRecord, input: UserInput[]): Record<string, unknown> {
    const { settings } = record
    const mode = modeOf(settings.mode) ?? modeOf(DEFAULT_MODE)!
    const collaborationMode: CollaborationMode | null = settings.model
      ? {
          mode: settings.collaboration,
          settings: {
            model: settings.model,
            reasoning_effort: settings.effort,
            developer_instructions: null,
          },
        }
      : null
    return {
      threadId: record.id,
      input,
      approvalPolicy: mode.approvalPolicy,
      approvalsReviewer: mode.approvalsReviewer,
      sandboxPolicy: mode.sandbox,
      summary: 'auto',
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      serviceTier: settings.fast ? (this.fastTierOf(settings.model) ?? 'default') : 'default',
      ...(collaborationMode ? { collaborationMode } : {}),
    }
  }

  private fastTierOf(modelId: string): string | null {
    return fastTier(this.knownModels.find((model) => model.id === modelId))
  }

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    const record = this.thread(sessionId)
    if (record.prompting) {
      throw new AgentRequestError('agent_error', 'A turn is already running in this session')
    }
    await this.listModels()
    const done = new Promise<PromptResult>((resolve, reject) => {
      record.prompting = { turnId: null, cancel: false, resolve, reject }
    })
    const prompting = record.prompting!
    try {
      const response = await this.call<{ turn: Turn }>(
        'turn/start',
        this.turnParams(record, userInputs(prompt)),
      )
      record.prompted = true
      if (prompting.turnId === null) {
        prompting.turnId = response.turn.id
        if (prompting.cancel) void this.interrupt(sessionId, response.turn.id)
      }
    } catch (error) {
      if (record.prompting === prompting) record.prompting = null
      throw error
    }
    void this.closed.then(() => {
      if (record.prompting !== prompting) return
      record.prompting = null
      prompting.reject(new AgentRequestError('closed', 'The agent connection closed'))
    })
    return done
  }

  async collect(sessionId: string, text: string): Promise<string[]> {
    const messages: string[] = []
    this.pending.delete(sessionId)
    this.collectors.set(sessionId, ({ method, params }) => {
      const item = (params as { item?: ThreadItem }).item
      if (method === 'item/completed' && item?.type === 'agentMessage' && item.text !== '') {
        messages.push(item.text)
      }
    })
    try {
      await this.prompt(sessionId, [{ type: 'text', text }])
    } finally {
      this.collectors.delete(sessionId)
      this.unregister(sessionId)
    }
    return messages
  }

  /** `turn/steer` into the running turn; with no turn, or another one now, the message stays. */
  async steer(
    sessionId: string,
    prompt: readonly PromptBlock[],
  ): Promise<'injected' | 'promptRequired'> {
    const record = this.threads.get(sessionId)
    const turnId = record?.running?.id ?? record?.prompting?.turnId ?? null
    if (!turnId) return 'promptRequired'
    try {
      await this.rpc.request('turn/steer', {
        threadId: sessionId,
        input: userInputs(prompt),
        expectedTurnId: turnId,
      })
      return 'injected'
    } catch (error) {
      if (
        error instanceof RpcError &&
        error.code === INVALID_REQUEST &&
        /turn/i.test(error.message)
      ) {
        return 'promptRequired'
      }
      throw this.toError(error)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const record = this.threads.get(sessionId)
    if (!record) return
    const turnId = record.running?.id ?? record.prompting?.turnId ?? null
    if (turnId) {
      await this.interrupt(sessionId, turnId)
      return
    }
    // A cancel before the turn has its id goes once it does.
    if (record.prompting) record.prompting.cancel = true
  }

  private async interrupt(threadId: string, turnId: string): Promise<void> {
    try {
      await this.rpc.request('turn/interrupt', { threadId, turnId })
    } catch (error) {
      // The turn ended meanwhile.
      if (error instanceof RpcError && /no active turn/i.test(error.message)) return
      throw this.toError(error)
    }
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.setConfigOption(sessionId, 'mode', modeId)
  }

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const record = this.threads.get(sessionId)
    if (!record) throw new AgentRequestError('agent_error', `Codex has no session ${sessionId}`)
    const models = await this.listModels()
    try {
      record.settings = applyOption(record.settings, models, optionId, value)
    } catch (error) {
      if (error instanceof ConfigValueError) {
        throw new AgentRequestError('agent_error', error.message, -32602)
      }
      throw error
    }
    return buildConfig(record.settings, models)
  }

  // Hidden sessions: ephemeral threads, which app-server never writes to disk.

  get hiddenSessions(): boolean {
    return this.initialized
  }

  async removeHidden(sessionId: string, log: (message: string) => void): Promise<void> {
    this.unregister(sessionId)
    const record = this.threads.get(sessionId)
    this.threads.delete(sessionId)
    const failed = (error: unknown): void => {
      if (!this.isClosed) log((error as Error).message)
    }
    // A thread from an earlier run was ephemeral, or never prompted, so nothing of it is left.
    if (!record) return
    // A prepared session that was never prompted has nothing on disk either.
    if (!record.hidden && record.prompted) {
      await this.deleteSession(sessionId).catch(failed)
      return
    }
    await this.closeSession(sessionId).catch(failed)
  }

  async readLimits(): Promise<PlanLimit[]> {
    const response = await this.call<GetAccountRateLimitsResponse>('account/rateLimits/read')
    const now = Date.now()
    const snapshots = response.rateLimitsByLimitId
      ? Object.values(response.rateLimitsByLimitId).filter((s) => s !== undefined)
      : [response.rateLimits]
    return snapshots.flatMap((snapshot) => mapRateLimits(snapshot, now))
  }
}

function listedTitle(thread: Thread): string | null {
  for (const title of [thread.name, thread.preview]) {
    const collapsed = title?.replace(/\s+/g, ' ').trim() ?? ''
    if (collapsed !== '') return collapsed
  }
  return null
}
