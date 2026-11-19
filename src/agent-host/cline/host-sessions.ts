// What the process that runs Cline's SDK does for the agent host: its providers and models, and
// its sessions. Each session has a core of its own, made at its first prompt as Cline's own ACP
// mode makes one, so a session nobody prompted leaves nothing in Cline's store. Nothing here
// reports usage: the SDK is given no telemetry service.

import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  ERROR,
  METHOD,
  type ApprovalParams,
  type ApprovalResult,
  type ClineEvent,
  type ClineMcpServer,
  type ClineModel,
  type ClineProvider,
  type ClineSettings,
  type HelloResult,
  type ModelsParams,
  type ModelsResult,
  type OpenParams,
  type OpenResult,
  type PromptParams,
  type QuestionParams,
  type QuestionResult,
  type SetParams,
  type SetResult,
  type SignInParams,
  type SteerResult,
  type TurnResult,
} from './protocol'
import type {
  Sdk,
  SdkApprovalRequest,
  SdkCore,
  SdkMcpManager,
  SdkMessage,
  SdkModelInfo,
  SdkProviderSettingsManager,
  SdkSessionEvent,
  SdkTool,
  SdkToolContext,
  SdkToolPolicy,
} from './sdk'

/** The provider a host without one starts on, as Cline's own CLI does. */
const DEFAULT_PROVIDER = 'cline'
/** The providers Cline signs in to with its own page, which a signed-out host offers. */
const SIGN_IN_PROVIDERS = ['cline', 'cline-pass', 'openai-codex']
/** Tools that run without asking, as in Cline's own terminal interface. */
const SAFE_TOOLS = [
  'ask_followup_question',
  'ask_question',
  'fetch_web_content',
  'read_files',
  'search_codebase',
  'skills',
  'submit_and_exit',
]
/** The reason Cline's hosts give a rejected call, which its runtime reads as the user's own. */
const USER_REJECTED = 'This tool call was rejected by the user and not executed.'
const AUTH_ERRORS = [
  '401',
  '403',
  'unauthorized',
  'forbidden',
  'invalid token',
  'expired token',
  'authentication',
]
/** OpenAI's limit on a function name, which Cline's own MCP tool names keep to. */
const TOOL_NAME_LIMIT = 64

/**
 * The input a model takes, which Cline compacts against: a catalog that names it beside the whole
 * window, the reply included, means the smaller.
 */
function inputWindow(info: SdkModelInfo): number | undefined {
  const { contextWindow: window, maxInputTokens: input } = info
  if (typeof input !== 'number') return typeof window === 'number' ? window : undefined
  return typeof window === 'number' ? Math.min(input, window) : input
}

export class HostError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

interface Session {
  id: string
  cwd: string
  settings: ClineSettings
  mcpServers: ClineMcpServer[]
  instructions: string | null
  core: SdkCore | null
  off: (() => void) | null
  manager: SdkMcpManager | null
  /** The conversation the next core starts from: the store's, or the core's before it. */
  messages: SdkMessage[] | null
  running: boolean
  /** A failure the running turn cannot go on from, which its answer carries. */
  fatal: string | null
  /** Tools the user allowed for the rest of the session. */
  allowed: Set<string>
  /** MCP tools that run without asking, by the name the model calls them. */
  autoAllowed: Set<string>
}

/** The agent host, as this process reaches it. */
export interface HostPeer {
  ask<T>(method: string, params: unknown): Promise<T>
  notify(method: string, params: unknown): void
  /** A line for the Agent's diagnostics. */
  log(text: string): void
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function isAuthError(message: string): boolean {
  const text = message.toLowerCase()
  return AUTH_ERRORS.some((pattern) => text.includes(pattern))
}

/** The name the model calls an MCP tool by, as Cline's own transform makes it. */
export function mcpToolName(serverName: string, toolName: string): string {
  const raw = `${serverName}__${toolName}`
  const plain = raw.replace(/[^a-zA-Z0-9_-]+/g, '_')
  if (plain === raw && raw.length <= TOOL_NAME_LIMIT) return raw
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8)
  return `${plain.slice(0, TOOL_NAME_LIMIT - 9) || 'mcp_tool'}_${hash}`
}

export class Host {
  private readonly sessions = new Map<string, Session>()
  private readonly settings: SdkProviderSettingsManager
  private service: Promise<SdkCore> | null = null

  constructor(
    private readonly sdk: Sdk,
    private readonly peer: HostPeer,
  ) {
    this.settings = new sdk.ProviderSettingsManager()
  }

  async serve(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case METHOD.hello:
        return this.hello()
      case METHOD.models:
        return this.models((params as ModelsParams).provider)
      case METHOD.open:
        return this.open(params as OpenParams)
      case METHOD.prompt:
        return this.prompt(params as PromptParams)
      case METHOD.steer:
        return this.steer(params as PromptParams)
      case METHOD.cancel:
        return this.cancel((params as { sessionId: string }).sessionId)
      case METHOD.set:
        return this.set(params as SetParams)
      case METHOD.close:
        return this.close((params as { sessionId: string }).sessionId)
      case METHOD.signIn:
        return this.signIn(params as SignInParams)
      case METHOD.shutdown:
        await this.shutdown()
        return {}
      default:
        throw new HostError(-32601, `No method ${method}`)
    }
  }

  // Providers and models.

  private async provider(id: string): Promise<ClineProvider> {
    const { sdk } = this
    const known = await sdk.Llms.getProvider(id).catch(() => undefined)
    return {
      id,
      name: known?.name ?? id,
      ready: sdk.isProviderSettingsUsable(id, this.settings.getProviderSettings(id)),
      oauth: sdk.isOAuthProvider(id),
    }
  }

  /** The providers Cline is set up for, and the ones it signs in to with a page. */
  private async providers(): Promise<ClineProvider[]> {
    const stored = Object.keys(this.settings.read().providers ?? {})
    const ids = [...new Set([...stored, ...SIGN_IN_PROVIDERS])]
    const all = await Promise.all(ids.map((id) => this.provider(id)))
    return all.filter((provider) => provider.ready || SIGN_IN_PROVIDERS.includes(provider.id))
  }

  private lastProvider(): string | null {
    return this.settings.getLastUsedProviderSettings({ isClinePassEnabled: true })?.provider ?? null
  }

  private async hello(): Promise<HelloResult> {
    return {
      core: this.sdk.CORE_BUILD_VERSION,
      providers: await this.providers(),
      provider: this.lastProvider(),
    }
  }

  private async models(provider: string): Promise<ModelsResult> {
    const known = await this.sdk.Llms.getModelsForProvider(provider, { filter: 'chat' })
    const models = Object.entries(known).map(([id, info]): ClineModel => {
      const window = inputWindow(info)
      return {
        id,
        name: info.name ?? id,
        ...(info.description ? { description: info.description } : {}),
        ...(window === undefined ? {} : { contextWindow: window }),
        reasoning: info.capabilities?.includes('reasoning') === true,
        images: info.capabilities?.includes('images') === true,
      }
    })
    const ids = new Set(models.map((model) => model.id))
    const saved = this.settings.getProviderSettings(provider)?.model
    const preset = (await this.sdk.Llms.getProvider(provider).catch(() => undefined))
      ?.defaultModelId
    const model = [saved, preset].find((id) => id !== undefined && ids.has(id))
    // A model set up by hand may be in no catalog, and still is the one Cline runs.
    return { models, model: model ?? saved ?? models[0]?.id ?? '' }
  }

  /** Whether the provider reasons unless told otherwise, as Cline's own CLI reads its settings. */
  private thinks(provider: string): boolean {
    const reasoning = this.settings.getProviderSettings(provider)?.reasoning
    if (!reasoning || reasoning.enabled === false || reasoning.effort === 'none') return false
    return reasoning.enabled === true || typeof reasoning.effort === 'string'
  }

  // Sessions.

  /** A core that only reads Cline's store, shared by every session. */
  private store(): Promise<SdkCore> {
    this.service ??= this.sdk.ClineCore.create({ clientName: 'kettu', backendMode: 'local' })
    return this.service
  }

  private require(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new HostError(ERROR.noSession, `No session ${sessionId}`)
    return session
  }

  private async open(params: OpenParams): Promise<OpenResult> {
    const existing = this.sessions.get(params.sessionId)
    if (existing) {
      existing.mcpServers = params.mcpServers
      existing.instructions = params.instructions
      return this.opened(existing, existing.messages !== null || existing.core !== null)
    }
    let messages: SdkMessage[] = []
    let row: { provider: string; model: string } | undefined
    if (params.resume) {
      const store = await this.store()
      row = await store.get(params.sessionId).catch(() => undefined)
      messages = await store.readMessages(params.sessionId).catch(() => [])
    }
    const ready = (await this.providers()).filter((provider) => provider.ready)
    if (ready.length === 0 && !row) {
      throw new HostError(ERROR.authRequired, 'Sign in to Cline before starting a session')
    }
    const last = this.lastProvider()
    const provider =
      params.settings.provider ??
      row?.provider ??
      (last && ready.some((item) => item.id === last) ? last : (ready[0]?.id ?? DEFAULT_PROVIDER))
    const model = params.settings.model ?? row?.model ?? (await this.models(provider)).model
    const session: Session = {
      id: params.sessionId,
      cwd: params.cwd,
      settings: {
        provider,
        model,
        mode: params.settings.mode ?? 'act',
        thinking: params.settings.thinking ?? this.thinks(provider),
        autoApprove: params.settings.autoApprove ?? false,
      },
      mcpServers: params.mcpServers,
      instructions: params.instructions,
      core: null,
      off: null,
      manager: null,
      messages: messages.length > 0 ? messages : null,
      running: false,
      fatal: null,
      allowed: new Set(),
      autoAllowed: new Set(),
    }
    this.sessions.set(session.id, session)
    return this.opened(session, messages.length > 0)
  }

  private async opened(session: Session, stored: boolean): Promise<OpenResult> {
    return {
      stored,
      settings: session.settings,
      providers: await this.providers(),
      models: (await this.models(session.settings.provider)).models,
    }
  }

  /** The session's MCP servers as tools; one that cannot be reached is left out. */
  private async mcpTools(session: Session): Promise<SdkTool[]> {
    const { sdk } = this
    if (session.mcpServers.length === 0) return []
    const manager = new sdk.InMemoryMcpManager({
      clientFactory: sdk.createDefaultMcpServerClientFactory(),
    })
    session.manager = manager
    const tools: SdkTool[] = []
    for (const server of session.mcpServers) {
      const { name, autoAllow, ...transport } = server
      try {
        await manager.registerServer({ name, transport })
        tools.push(...(await sdk.createMcpTools({ serverName: name, provider: manager })))
        for (const tool of autoAllow) session.autoAllowed.add(mcpToolName(name, tool))
      } catch (error) {
        this.peer.log(`MCP server ${name} is unavailable: ${messageOf(error)}`)
      }
    }
    return tools
  }

  /** Starts the session's core if it has none, carrying the conversation it had. */
  private async ensureCore(session: Session): Promise<SdkCore> {
    if (session.core) return session.core
    const { sdk } = this
    const { provider, model, mode, thinking } = session.settings
    const saved = this.settings.getProviderSettings(provider)
    const policies: Record<string, SdkToolPolicy> = { '*': { autoApprove: false } }
    for (const name of SAFE_TOOLS) policies[name] = { autoApprove: true }
    const core = await sdk.ClineCore.create({
      clientName: 'kettu',
      backendMode: 'local',
      capabilities: {
        requestToolApproval: (request) => this.approve(session, request),
        toolExecutors: {
          askQuestion: (question, options, context) =>
            this.question(session, question, options, context),
        },
      },
      toolPolicies: policies,
    })
    const off = core.subscribe((event) => this.forward(session, event))
    try {
      const tools = await this.mcpTools(session)
      const systemPrompt = sdk.getClineDefaultSystemPrompt({
        ide: 'Kettu',
        workspaceRoot: session.cwd,
        workspaceName: path.basename(session.cwd),
        metadata: await sdk.buildWorkspaceMetadata(session.cwd),
        ...(session.instructions ? { rules: session.instructions } : {}),
        mode,
        providerId: provider,
        platform: process.platform,
        // The user changes the mode in Kettu, so the model has no tool that does.
        planModeSwitchTool: false,
      })
      const effort = saved?.reasoning?.effort
      await core.start({
        source: 'cli',
        interactive: true,
        toolPolicies: policies,
        config: {
          sessionId: session.id,
          providerId: provider,
          modelId: model,
          apiKey: sdk.getPersistedProviderApiKey(provider, saved) ?? '',
          systemPrompt,
          mode,
          thinking,
          ...(thinking && effort && effort !== 'none' ? { reasoningEffort: effort } : {}),
          enableTools: true,
          enableSpawnAgent: true,
          enableAgentTeams: false,
          cwd: session.cwd,
          workspaceRoot: session.cwd,
          compaction: this.compacts(),
          ...(tools.length > 0 ? { extraTools: tools } : {}),
        },
        ...(session.messages ? { initialMessages: session.messages } : {}),
        ...(await this.compaction(session)),
      })
    } catch (error) {
      off()
      await this.disposeMcp(session)
      await core.dispose('kettu_start_failed').catch(() => {})
      throw error
    }
    session.core = core
    session.off = off
    session.messages = null
    return core
  }

  /** Whether a session compacts and how: the user's setting in Cline, read as its own CLI does. */
  private compacts(): { enabled: boolean; strategy?: string } {
    const mode = this.sdk.readCompactionModeGlobally()
    if (mode === undefined) return { enabled: true }
    return mode === 'off' ? { enabled: false } : { enabled: true, strategy: mode }
  }

  /** The compacted view of the carried conversation, when Cline keeps one for the session. */
  private async compaction(session: Session): Promise<{ initialCompactionState?: unknown }> {
    const messages = session.messages
    if (!messages) return {}
    try {
      const store = await this.store()
      const state = await store.readSessionCompactionState(session.id)
      if (!state) return {}
      const compacted = this.sdk.projectSessionCompactionState(state, messages)
      if (!compacted) return {}
      return {
        initialCompactionState: this.sdk.createSessionCompactionState({
          sourceMessages: messages,
          compactedMessages: compacted,
          systemPrompt: (state as { system_prompt?: string }).system_prompt,
        }),
      }
    } catch {
      return {}
    }
  }

  private async disposeMcp(session: Session): Promise<void> {
    const manager = session.manager
    session.manager = null
    session.autoAllowed.clear()
    await manager?.dispose().catch(() => {})
  }

  /** Ends the session's core, keeping its conversation for the one that follows. */
  private async teardown(session: Session, reason: string): Promise<void> {
    const core = session.core
    if (!core) return
    session.messages = await core.readMessages(session.id).catch(() => null)
    if (session.messages?.length === 0) session.messages = null
    session.off?.()
    session.off = null
    session.core = null
    await core.abort(session.id).catch(() => {})
    await core.dispose(reason).catch(() => {})
    await this.disposeMcp(session)
  }

  private forward(session: Session, event: SdkSessionEvent): void {
    if (event.type !== 'agent_event' || event.payload?.sessionId !== session.id) return
    const { event: agent } = event.payload as { event: ClineEvent & { error?: unknown } }
    if (agent.type === 'error') {
      const message = messageOf(agent.error)
      if (!agent.recoverable) session.fatal = message
      this.peer.notify(METHOD.event, {
        sessionId: session.id,
        event: { ...agent, error: { message } },
      })
      return
    }
    this.peer.notify(METHOD.event, { sessionId: session.id, event: agent })
  }

  // Turns.

  private async prompt(params: PromptParams): Promise<TurnResult> {
    const session = this.require(params.sessionId)
    if (session.running) throw new HostError(ERROR.failed, 'A turn is already running')
    session.running = true
    session.fatal = null
    try {
      const core = await this.ensureCore(session)
      const result = await core.send({
        sessionId: session.id,
        prompt: params.text,
        mode: session.settings.mode,
        ...(params.images.length > 0 ? { userImages: params.images } : {}),
        ...(params.files.length > 0 ? { userFiles: params.files } : {}),
      })
      const finishReason = result?.finishReason ?? 'completed'
      // The runtime reports a failure it cannot go on from as an event and still answers.
      if (session.fatal && finishReason !== 'aborted') {
        throw new HostError(
          isAuthError(session.fatal) ? ERROR.authRequired : ERROR.failed,
          session.fatal,
        )
      }
      const usage = result?.usage
      return {
        finishReason,
        model: result?.model?.id ?? session.settings.model,
        usage: usage
          ? {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              cacheReadTokens: usage.cacheReadTokens ?? 0,
              cacheWriteTokens: usage.cacheWriteTokens ?? 0,
              cost: typeof usage.totalCost === 'number' ? usage.totalCost : null,
            }
          : null,
      }
    } catch (error) {
      if (error instanceof HostError) throw error
      const message = messageOf(error)
      throw new HostError(isAuthError(message) ? ERROR.authRequired : ERROR.failed, message)
    } finally {
      session.running = false
    }
  }

  private async steer(params: PromptParams): Promise<SteerResult> {
    const session = this.require(params.sessionId)
    if (!session.running || !session.core) return { injected: false }
    // Resolves once the runtime queued it; the running turn's own answer carries the rest.
    void session.core
      .send({
        sessionId: session.id,
        prompt: params.text,
        delivery: 'steer',
        ...(params.images.length > 0 ? { userImages: params.images } : {}),
        ...(params.files.length > 0 ? { userFiles: params.files } : {}),
      })
      .catch((error: unknown) => {
        this.peer.log(`A steered message failed: ${messageOf(error)}`)
      })
    return { injected: true }
  }

  private async cancel(sessionId: string): Promise<Record<string, never>> {
    const session = this.sessions.get(sessionId)
    if (session?.core && session.running) {
      await session.core.abort(session.id, new Error('The user stopped the turn')).catch(() => {})
    }
    return {}
  }

  private async set(params: SetParams): Promise<SetResult> {
    const session = this.require(params.sessionId)
    const { settings } = session
    const next = params.settings
    if (next.autoApprove !== undefined) settings.autoApprove = next.autoApprove
    const provider = next.provider !== undefined && next.provider !== settings.provider
    const mode = next.mode !== undefined && next.mode !== settings.mode
    if (provider || mode) {
      if (session.running) throw new HostError(ERROR.failed, 'Change it between turns')
      // Both shape the system prompt and the tools, so the next prompt starts a core with them.
      await this.teardown(session, provider ? 'kettu_provider_change' : 'kettu_mode_change')
      if (mode) settings.mode = next.mode!
      if (provider) {
        settings.provider = next.provider!
        const offered = await this.models(settings.provider)
        const keeps = offered.models.some((model) => model.id === settings.model)
        settings.model = next.model ?? (keeps ? settings.model : offered.model)
        settings.thinking = next.thinking ?? this.thinks(settings.provider)
      }
    }
    if (next.model !== undefined && next.model !== settings.model) {
      settings.model = next.model
      await session.core?.updateSessionModel(session.id, next.model)
    }
    if (next.thinking !== undefined && next.thinking !== settings.thinking) {
      settings.thinking = next.thinking
      await session.core?.updateSessionConnection(session.id, { thinking: next.thinking })
    }
    return { settings, models: (await this.models(settings.provider)).models }
  }

  private async close(sessionId: string): Promise<Record<string, never>> {
    const session = this.sessions.get(sessionId)
    if (!session) return {}
    this.sessions.delete(sessionId)
    await this.teardown(session, 'kettu_session_closed')
    return {}
  }

  private async signIn(params: SignInParams): Promise<{ providers: ClineProvider[] }> {
    await this.sdk.loginAndSaveLocalProviderOAuthCredentials(
      this.settings,
      params.provider,
      (url) => void this.peer.ask(METHOD.openUrl, { url }).catch(() => {}),
    )
    return { providers: await this.providers() }
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => this.teardown(session, 'kettu_shutdown')))
    const service = this.service
    this.service = null
    if (service) await (await service).dispose('kettu_shutdown').catch(() => {})
  }

  // What the SDK asks.

  private async approve(
    session: Session,
    request: SdkApprovalRequest,
  ): Promise<{ approved: boolean; reason?: string }> {
    const { toolName } = request
    if (
      session.settings.autoApprove ||
      session.allowed.has(toolName) ||
      session.autoAllowed.has(toolName)
    ) {
      return { approved: true }
    }
    const params: ApprovalParams = {
      sessionId: session.id,
      toolCallId: request.toolCallId,
      toolName,
      input: request.input,
    }
    let answer: ApprovalResult
    try {
      answer = await this.peer.ask<ApprovalResult>(METHOD.approval, params)
    } catch {
      return { approved: false, reason: 'Permission request failed' }
    }
    if (answer.approved && answer.always) session.allowed.add(toolName)
    return answer.approved
      ? { approved: true }
      : { approved: false, reason: answer.reason ?? USER_REJECTED }
  }

  private async question(
    session: Session,
    question: string,
    options: string[],
    context: SdkToolContext,
  ): Promise<string> {
    const params: QuestionParams = {
      sessionId: session.id,
      toolCallId: context.toolCallId ?? null,
      question,
      options,
    }
    const { answer } = await this.peer.ask<QuestionResult>(METHOD.question, params)
    return answer ?? 'The user closed the question without answering it.'
  }
}
