// One ACP v1 connection to an agent process, through the official SDK.
//
// The host uses the SDK's `unstable` entrypoint: its client validates every
// `session/update` against the schema of the entrypoint before any handler runs, and the
// stable schema has no `subagent_update` or `session_message`, which sub-sessions need.
// Only the unstable features the architecture allows are used (subagents, the prompt
// response's `usage`, and `session/fork` with its fork point in `_meta`); nothing else
// unstable is advertised or called.

import { Readable, Writable } from 'node:stream'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AnyMessage,
  type AuthMethod,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type McpServer as AcpMcpServer,
  type SessionUpdate,
  type Stream,
} from '@agentclientprotocol/sdk/unstable'
import type { AgentId, ConfigOption } from '@shared/thread'
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
import type { AgentTransport, MessageTransport } from '../driver'
import { isStopReason } from '../session-updates'
import {
  KNOWN_UPDATES,
  mapAuthStatus,
  mapConfig,
  mapModelUsage,
  mapPermissionOptions,
  mapPermissionToolCall,
  mapSessionUpdate,
  mapTokenTotals,
} from './mapper'
import { forkPointMeta, forksAtMessage } from './fork-point'
import { DELETE_AGAIN_MS, hiddenRemoval, sessionMeta, type Removal } from './hidden-sessions'
import { ownTitles } from './own-titles'

/** A message-level stream to an agent, from a process's stdio or an in-process agent. */
export interface AcpTransport {
  readonly stream: Stream
  close(): void
}

export function processTransport(
  stdin: NodeJS.WritableStream,
  stdout: NodeJS.ReadableStream,
): AcpTransport {
  const stream = ndJsonStream(
    Writable.toWeb(stdin as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(stdout as Readable) as ReadableStream<Uint8Array>,
  )
  return { stream, close: () => {} }
}

/** Connects an SDK `AgentApp` through an in-memory stream pair, for tests and development. */
export function inProcessTransport(app: AgentApp): AcpTransport & MessageTransport {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>()
  const toClient = new TransformStream<AnyMessage, AnyMessage>()
  const agentConnection = app.connect({ readable: toAgent.readable, writable: toClient.writable })
  return {
    kind: 'messages',
    stream: { readable: toClient.readable, writable: toAgent.writable },
    close: () => agentConnection.close(),
  }
}

/** The ACP messages over what the launcher gave the driver. */
function acpTransport(transport: AcpTransport | AgentTransport): AcpTransport {
  if ('kind' in transport && transport.kind === 'stdio') {
    return processTransport(transport.stdin, transport.stdout)
  }
  return { stream: transport.stream as Stream, close: () => transport.close() }
}

/** What ACP needs to know of the agent behind it, besides the neutral hooks. */
export interface AcpOptions {
  /** The catalog's agent, whose adapter's `_meta` and hidden-session removal apply. */
  agentId?: AgentId
  /** Its name, for an error about it. */
  name?: string
  /** The agent sends its thought levels again as legacy `modes`, which are ignored. */
  levelsAsModes?: boolean
  /** The agent sends its startup note as the first message after `session/new`, which is dropped. */
  startupNote?: boolean
}

export type AcpHooks = ConnectionHooks & AcpOptions

const AUTH_REQUIRED = -32000

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: true },
  session: { notices: {}, compaction: {}, configOptions: { boolean: {} } },
  subagents: {},
  // Kilo publishes its terminal sign-in command only to a client that advertises this.
  _meta: { 'terminal-auth': true },
}

type AuthMethodMeta = {
  type?: unknown
  args?: unknown
  env?: unknown
  'terminal-auth'?: { command?: unknown; args?: unknown } | null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

/** `_meta["terminal-auth"]`'s command, which runs as given rather than after the launch command. */
function namedCommand(meta: AuthMethodMeta | null | undefined): {
  command: string
  args: string[]
} | null {
  const named = meta?.['terminal-auth']
  if (typeof named !== 'object' || named === null) return null
  if (typeof named.command !== 'string' || named.command === '') return null
  return { command: named.command, args: stringList(named.args) }
}

/** One of `init.authMethods`, reading the metadata forms agents publish a terminal sign-in in. */
function authMethod(method: AuthMethod): AuthMethodInfo {
  const meta = method._meta as AuthMethodMeta | null | undefined
  const named = namedCommand(meta)
  const declared = 'type' in method && method.type === 'terminal'
  const terminal = declared || named !== null || meta?.type === 'terminal'
  const declaredArgs = (method as { args?: string[] }).args ?? []
  const args = named?.args ?? (declared ? declaredArgs : stringList(meta?.args))
  const env = declared
    ? { ...((method as { env?: Record<string, string> }).env ?? {}) }
    : stringMap(meta?.env)
  return {
    id: method.id,
    name: method.name,
    ...(method.description ? { description: method.description } : {}),
    type: terminal ? 'terminal' : 'agent',
    ...(named ? { command: named.command } : {}),
    args: terminal ? args : [],
    env: terminal ? env : {},
  }
}

// Updates for a session id nobody registered yet, such as the commands an agent sends right
// after answering `session/new`, wait here for the session to register.
const PENDING_SESSIONS = 32
const PENDING_UPDATES = 2_000
const PENDING_TTL_MS = 60_000
// OpenCode marks a subagent's updates, which it sends on the session the subagent runs under.
const CHILD_SESSION_META = 'opencode/child-session'
const CHILD_SESSIONS = 1_000
// Sessions Kettu closed: their late updates are dropped, not kept for a later register.
const CLOSED_SESSIONS = 256

/** Kettu's prompt blocks as ACP content blocks. */
function contentBlocks(prompt: readonly PromptBlock[]): ContentBlock[] {
  return prompt.map((block): ContentBlock => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'image':
        return {
          type: 'image',
          mimeType: block.mimeType,
          data: block.data,
          ...(block.uri !== undefined ? { uri: block.uri } : {}),
        }
      case 'resource_link':
        return {
          type: 'resource_link',
          uri: block.uri,
          name: block.name,
          ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
          ...(block.size !== undefined ? { size: block.size } : {}),
        }
      case 'resource':
        return {
          type: 'resource',
          resource: {
            uri: block.resource.uri,
            mimeType: block.resource.mimeType,
            text: block.resource.text,
          },
        }
    }
  })
}

/** Kettu's MCP servers as ACP's. */
function mcpServers(servers: readonly McpServer[] | undefined): AcpMcpServer[] {
  return (servers ?? []).map((server) => ({
    type: 'http',
    name: server.name,
    url: server.url,
    headers: server.headers.map(({ name, value }) => ({ name, value })),
  }))
}

export class AcpConnection implements AgentConnection {
  private readonly connection: ClientConnection
  private readonly targets = new Map<string, SessionTarget>()
  private readonly pending = new Map<string, { at: number; updates: SessionUpdate[] }>()
  private readonly unregistered = new Set<string>()
  /** Sessions Kettu runs a report in, which no thread shows. */
  private readonly collectors = new Map<string, (update: SessionUpdate) => void>()
  /** OpenCode's subagent sessions, to the session each runs under. */
  private readonly children = new Map<string, string>()
  /** The startup note a session others opened by `session/new` sends before its first prompt. */
  private readonly pendingStartup = new Map<string, string>()
  /** How its hidden sessions go, once `initialize` has answered. */
  private removal: Removal | null = null

  private constructor(
    private readonly transport: AcpTransport,
    private readonly hooks: AcpHooks,
  ) {
    const app = client({ name: 'Kettu' })
      .onNotification(methods.client.session.update, (ctx) => {
        this.deliver(ctx.params.sessionId, ctx.params.update)
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const target = this.targets.get(ctx.params.sessionId)
        if (!target) {
          // Never approve without the user: a request for an unknown session is declined.
          hooks.log('warn', `Permission request for unknown session ${ctx.params.sessionId}`)
          return { outcome: { outcome: 'cancelled' } }
        }
        const { entryId, output } = mapPermissionToolCall(ctx.params.toolCall, target.context())
        const answer = await target.requestPermission(
          {
            toolCallId: ctx.params.toolCall.toolCallId,
            toolEntryId: entryId,
            output,
            options: mapPermissionOptions(ctx.params.options),
          },
          ctx.signal,
        )
        return answer === 'cancelled'
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId: answer.optionId } }
      })
      .onNotification(
        '_auth/status_update',
        (params: unknown) => params,
        (ctx) => {
          const account = mapAuthStatus(ctx.params)
          if (account) hooks.account(account)
          else hooks.ignored(null, '_auth/status_update with an unknown shape')
        },
      )
      .onNotification('*', (ctx) => {
        // `$/cancel_request` is handled by the SDK itself before it reaches here.
        if (!ctx.method.startsWith('$/')) hooks.ignored(null, `notification ${ctx.method}`)
      })
    this.connection = app.connect(this.tap(transport.stream))
  }

  static connect(transport: AcpTransport | AgentTransport, hooks: AcpHooks): AcpConnection {
    return new AcpConnection(acpTransport(transport), hooks)
  }

  /** Records traffic, and drops update variants the SDK's schema would reject noisily. */
  private tap(stream: Stream): Stream {
    const hooks = this.hooks
    const readable = stream.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform: (message, controller) => {
          hooks.traffic('in', message)
          const variant = unknownVariant(message)
          if (variant) {
            const sessionId = (message as { params: { sessionId?: unknown } }).params.sessionId
            hooks.ignored(
              typeof sessionId === 'string' ? sessionId : null,
              `session update ${variant}`,
            )
            return
          }
          controller.enqueue(message)
        },
      }),
    )
    const writer = stream.writable.getWriter()
    const writable = new WritableStream<AnyMessage>({
      write: (message) => {
        hooks.traffic('out', message)
        return writer.write(message)
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    })
    return { readable, writable }
  }

  private deliver(sessionId: string, update: SessionUpdate): void {
    if (this.dropStartup(sessionId, update)) return
    this.learnChild(sessionId, update)
    const target = this.targets.get(sessionId)
    if (target) {
      target.apply(mapSessionUpdate(update, target.context()))
      return
    }
    const collector = this.collectors.get(sessionId)
    if (collector) {
      collector(update)
      return
    }
    if (this.unregistered.has(sessionId)) {
      this.hooks.ignored(sessionId, 'update for a session Kettu closed')
      return
    }
    const now = Date.now()
    for (const [id, entry] of this.pending) {
      if (now - entry.at > PENDING_TTL_MS) {
        this.pending.delete(id)
        this.hooks.ignored(id, `${entry.updates.length} updates for a session Kettu does not have`)
      }
    }
    let entry = this.pending.get(sessionId)
    if (!entry) {
      if (this.pending.size >= PENDING_SESSIONS) {
        this.hooks.ignored(sessionId, 'update for an unknown session')
        return
      }
      entry = { at: now, updates: [] }
      this.pending.set(sessionId, entry)
    }
    if (entry.updates.length < PENDING_UPDATES) entry.updates.push(update)
  }

  /**
   * Drops the startup note an agent marked `startupNote` sends after `session/new`: the first
   * agent message before its first prompt, when its text is the answer's `_meta.piAcp.startupInfo`.
   */
  private dropStartup(sessionId: string, update: SessionUpdate): boolean {
    const note = this.pendingStartup.get(sessionId)
    if (note === undefined) return false
    if (update.sessionUpdate !== 'agent_message_chunk') return false
    this.pendingStartup.delete(sessionId)
    if (update.content.type !== 'text' || update.content.text !== note) return false
    this.hooks.ignored(sessionId, 'startup note')
    return true
  }

  private learnChild(sessionId: string, update: SessionUpdate): void {
    const child = (
      update._meta as Record<string, { id?: unknown } | undefined> | null | undefined
    )?.[CHILD_SESSION_META]
    const id = child?.id
    if (typeof id !== 'string' || id === sessionId || this.children.get(id) === sessionId) {
      return
    }
    this.children.delete(id)
    this.children.set(id, sessionId)
    if (this.children.size > CHILD_SESSIONS) {
      this.children.delete(this.children.keys().next().value!)
    }
  }

  /** The session `id` runs under: its own if Kettu has it, else as OpenCode reported it. */
  rootOf(id: string): string {
    return this.targets.has(id) ? id : (this.children.get(id) ?? id)
  }

  /** Routes a session's updates to `target`, first replaying any that arrived early. */
  register(sessionId: string, target: SessionTarget): void {
    this.targets.set(sessionId, target)
    this.unregistered.delete(sessionId)
    const early = this.pending.get(sessionId)
    if (!early) return
    this.pending.delete(sessionId)
    for (const update of early.updates) {
      if (!this.dropStartup(sessionId, update)) {
        target.apply(mapSessionUpdate(update, target.context()))
      }
    }
  }

  unregister(sessionId: string, target?: SessionTarget): void {
    if (target && this.targets.get(sessionId) !== target) return
    this.targets.delete(sessionId)
    this.pending.delete(sessionId)
    this.pendingStartup.delete(sessionId)
    this.unregistered.add(sessionId)
    if (this.unregistered.size > CLOSED_SESSIONS) {
      this.unregistered.delete(this.unregistered.values().next().value!)
    }
  }

  /** Updates for a session Kettu closed wait for its next register again, like early ones. */
  reopen(sessionId: string): void {
    this.unregistered.delete(sessionId)
  }

  get closed(): Promise<void> {
    return this.connection.closed
  }

  get isClosed(): boolean {
    return this.connection.signal.aborted
  }

  close(): void {
    this.connection.close()
    this.transport.close()
  }

  /** The agent's options; legacy `modes` are ignored for an agent that sends its levels too. */
  private config(
    options: Parameters<typeof mapConfig>[0],
    modes: Parameters<typeof mapConfig>[1],
  ): ConfigOption[] {
    return mapConfig(options, this.hooks.levelsAsModes ? null : modes)
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw this.toError(error)
    }
  }

  private toError(error: unknown): AgentRequestError {
    if (error instanceof AgentRequestError) return error
    if (error instanceof RequestError) {
      if (error.code === AUTH_REQUIRED) {
        return new AgentRequestError('auth_required', error.message, error.code, error.data)
      }
      return new AgentRequestError('agent_error', error.message, error.code, error.data)
    }
    if (this.connection.signal.aborted) {
      return new AgentRequestError('closed', 'The agent connection closed')
    }
    return new AgentRequestError('agent_error', (error as Error)?.message ?? String(error))
  }

  async initialize(appVersion: string, signal?: AbortSignal): Promise<AgentInit> {
    const init: InitializeResponse = await this.call(() =>
      this.connection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'Kettu', title: 'Kettu', version: appVersion },
          clientCapabilities: CLIENT_CAPABILITIES,
        },
        signal ? { cancellationSignal: signal } : undefined,
      ),
    )
    if (init.protocolVersion !== 1) {
      throw new Error(
        `${this.hooks.name ?? 'The agent'} speaks an unsupported protocol version (${init.protocolVersion}).`,
      )
    }
    const caps = init.agentCapabilities ?? {}
    const session = caps.sessionCapabilities ?? {}
    const result: AgentInit = {
      protocolVersion: init.protocolVersion,
      name: init.agentInfo?.title ?? init.agentInfo?.name ?? null,
      version: init.agentInfo?.version ?? null,
      capabilities: {
        loadSession: caps.loadSession === true,
        listSessions: session.list != null,
        resumeSession: session.resume != null,
        closeSession: session.close != null,
        deleteSession: session.delete != null,
        forkSession: session.fork != null,
        forkAtMessage: session.fork != null && forksAtMessage(init.agentInfo),
        ownTitles: ownTitles(init.agentInfo),
        logout: caps.auth?.logout != null,
        // `_session/steering`, an extension advertised in the response's own `_meta`.
        steering:
          (init._meta as { steering?: { supported?: unknown } } | null | undefined)?.steering
            ?.supported === true,
        mcpHttp: caps.mcpCapabilities?.http === true,
        prompt: {
          image: caps.promptCapabilities?.image === true,
          audio: caps.promptCapabilities?.audio === true,
          embeddedContext: caps.promptCapabilities?.embeddedContext === true,
        },
      },
      authMethods: (init.authMethods ?? []).map(authMethod),
      raw: init.agentCapabilities ?? null,
    }
    this.removal = hiddenRemoval(this.hooks.agentId, result.capabilities)
    return result
  }

  private meta(options: SessionOptions): Record<string, unknown> | undefined {
    return sessionMeta(this.hooks.agentId, options)
  }

  async newSession(cwd: string, options: SessionOptions = {}): Promise<OpenedSession> {
    const meta = this.meta(options)
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: mcpServers(options.mcpServers),
        ...(meta ? { _meta: meta } : {}),
      }),
    )
    // pi-acp 0.0.34 repeats the startup note its answer carries as the session's first message.
    const startup = (response._meta as { piAcp?: { startupInfo?: unknown } } | null | undefined)
      ?.piAcp?.startupInfo
    if (this.hooks.startupNote && typeof startup === 'string' && startup !== '') {
      this.pendingStartup.set(response.sessionId, startup)
    }
    return {
      sessionId: response.sessionId,
      config: this.config(response.configOptions, response.modes),
    }
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const meta = this.meta(options)
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: mcpServers(options.mcpServers),
        ...(meta ? { _meta: meta } : {}),
      }),
    )
    return { config: this.config(response.configOptions, response.modes) }
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const meta = this.meta(options)
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: mcpServers(options.mcpServers),
        ...(meta ? { _meta: meta } : {}),
      }),
    )
    return { config: this.config(response.configOptions, response.modes) }
  }

  /**
   * `session/fork`, from ACP's unstable schema: a new session that starts from this one, up to
   * `point` for an agent with `forkAtMessage`.
   */
  async forkSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
    point?: ForkPoint,
  ): Promise<OpenedSession> {
    const meta = this.meta(options)
    const forkMeta = point ? { ...meta, ...forkPointMeta(point) } : meta
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.fork, {
        sessionId,
        cwd,
        mcpServers: mcpServers(options.mcpServers),
        ...(forkMeta ? { _meta: forkMeta } : {}),
      }),
    )
    return {
      sessionId: response.sessionId,
      config: this.config(response.configOptions, response.modes),
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.call(() => this.connection.agent.request(methods.agent.session.close, { sessionId }))
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.call(() =>
      this.connection.agent.request(methods.agent.session.delete, { sessionId }),
    )
  }

  async listSessions(
    cwd: string,
    cursor: string | null,
  ): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.list, {
        cwd,
        ...(cursor ? { cursor } : {}),
      }),
    )
    return {
      sessions: response.sessions.map((info) => ({
        sessionId: info.sessionId,
        title: info.title ?? null,
        updatedAt: info.updatedAt ?? null,
        cwd: info.cwd,
      })),
      nextCursor: response.nextCursor ?? null,
    }
  }

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    // The note comes before a session's first prompt; a message after it is the agent's own.
    this.pendingStartup.delete(sessionId)
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: contentBlocks(prompt),
      }),
    )
    return {
      stopReason: isStopReason(response.stopReason) ? response.stopReason : 'end_turn',
      tokens: mapTokenTotals(response.usage),
      models: mapModelUsage(response._meta),
    }
  }

  async collect(sessionId: string, text: string): Promise<string[]> {
    const messages: { id: string | null; text: string }[] = []
    this.pending.delete(sessionId)
    this.collectors.set(sessionId, (update) => {
      if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') return
      const id = update.messageId ?? null
      const last = messages.at(-1)
      if (last && (id === null || last.id === id)) last.text += update.content.text
      else messages.push({ id, text: update.content.text })
    })
    try {
      await this.prompt(sessionId, [{ type: 'text', text }])
    } finally {
      this.collectors.delete(sessionId)
      this.unregister(sessionId)
    }
    return messages.map((message) => message.text)
  }

  /**
   * `_session/steering`: sends a message into the running turn. With `promptRequired`, an agent
   * with no turn running answers so instead of starting one, and the message stays Kettu's.
   */
  async steer(
    sessionId: string,
    prompt: readonly PromptBlock[],
  ): Promise<'injected' | 'promptRequired'> {
    const response = await this.call(() =>
      this.connection.agent.request<{ outcome?: unknown }>('_session/steering', {
        sessionId,
        prompt: contentBlocks(prompt),
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      }),
    )
    if (response?.outcome === 'injected' || response?.outcome === 'promptRequired') {
      return response.outcome
    }
    throw new AgentRequestError(
      'agent_error',
      `Unexpected steering outcome ${JSON.stringify(response?.outcome)}`,
    )
  }

  async cancel(sessionId: string): Promise<void> {
    await this.call(() => this.connection.agent.notify(methods.agent.session.cancel, { sessionId }))
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.call(() =>
      this.connection.agent.request(methods.agent.session.setMode, { sessionId, modeId }),
    )
  }

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const response = await this.call(() =>
      this.connection.agent.request(
        methods.agent.session.setConfigOption,
        typeof value === 'boolean'
          ? { sessionId, configId: optionId, type: 'boolean', value }
          : { sessionId, configId: optionId, value },
      ),
    )
    return this.config(response.configOptions, null)
  }

  async authenticate(methodId: string): Promise<void> {
    await this.call(() => this.connection.agent.request(methods.agent.authenticate, { methodId }))
  }

  async logout(): Promise<void> {
    await this.call(() => this.connection.agent.request(methods.agent.logout, {}))
  }

  get hiddenSessions(): boolean {
    return this.removal !== null
  }

  async removeHidden(sessionId: string, log: (message: string) => void): Promise<void> {
    this.unregister(sessionId)
    const removal = this.removal
    if (!removal) return
    const failed = (error: unknown): void => {
      if (!this.isClosed) log((error as Error).message)
    }
    if (removal === 'close') {
      await this.closeSession(sessionId).catch(failed)
      return
    }
    await this.deleteSession(sessionId).catch(failed)
    for (const delay of removal === 'delete-again' ? DELETE_AGAIN_MS : []) {
      setTimeout(() => void this.deleteSession(sessionId).catch(failed), delay).unref()
    }
  }
}

/** The `sessionUpdate` of a `session/update` notification the SDK does not know, or null. */
function unknownVariant(message: AnyMessage): string | null {
  if (!('method' in message) || message.method !== 'session/update' || 'id' in message) return null
  const params = message.params as { update?: { sessionUpdate?: unknown } } | undefined
  const variant = params?.update?.sessionUpdate
  if (typeof variant !== 'string') return null
  return KNOWN_UPDATES.has(variant) ? null : variant
}
