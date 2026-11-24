// Cline through its SDK: one process for the Agent, which loads `@cline/sdk` from the `cline`
// package Kettu installed and serves every session of the Agent, spoken to over newline-delimited
// JSON-RPC on its stdio. A session is in Cline's own store under the id Kettu holds, as its ACP
// mode keeps it, so one made over ACP carries on here with its history.

import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ConfigOption, QuestionAnswer, StopReason } from '@shared/thread'
import {
  AgentRequestError,
  optionAnswer,
  type AgentConnection,
  type AgentInit,
  type ConnectionHooks,
  type ListedSession,
  type McpServer,
  type OpenedSession,
  type PermissionAnswer,
  type PromptBlock,
  type PromptResult,
  type SessionOptions,
  type SessionSetup,
  type SessionTarget,
  type SignInClient,
} from '../connection'
import { messageStream, RpcClosed, RpcError, RpcPeer } from '../codex/rpc'
import type { HostedContext } from '../driver'
import { t } from '../i18n'
import type { MapperContext, MapperOutput } from '../session-updates'
import { SessionMapper, tokenTotals } from './mapper'
import { configOptions, currentModel, settingsChange, type Choices } from './options'
import {
  ERROR,
  METHOD,
  type ApprovalParams,
  type ApprovalResult,
  type ClineMcpServer,
  type ClineProvider,
  type EventNotification,
  type HelloResult,
  type OpenParams,
  type OpenResult,
  type OpenUrlParams,
  type PromptParams,
  type QuestionParams,
  type QuestionResult,
  type SetResult,
  type SteerResult,
  type TurnResult,
} from './protocol'

const PENDING_EVENTS = 2_000
/** Where Node.js keeps the SDK's compiled code, which halves a later start. */
const COMPILE_CACHE = 'NODE_COMPILE_CACHE'
/** Loading the SDK takes a few seconds the first time; past this it counts as not starting. */
const HELLO_TIMEOUT_MS = 20_000
const SHUTDOWN_WAIT_MS = 5_000
const OPTION = { allow: 'allow-once', always: 'allow-always', reject: 'reject' }
/** An option id answering a question's choice, as a client without the card's questions sends. */
const ANSWER = /^answer:(\d+)$/
const OTHER_ANSWER = 'other'

/** Kettu's words for a refusal the SDK's process names by reason, which cannot translate. */
function refusalText(data: unknown): string | null {
  const reason = (data as { reason?: unknown } | null | undefined)?.reason
  if (reason === 'signIn') return t('cline.signInFirst')
  if (reason === 'betweenTurns') return t('agentRun.betweenTurns')
  return null
}

/** The SDK's process cannot serve the agent: its start fails, and the agent runs over ACP. */
export class ClineSdkUnavailable extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ClineSdkUnavailable'
  }
}

interface Proc {
  child: ChildProcess
  rpc: RpcPeer
}

interface Session {
  id: string
  cwd: string
  mapper: SessionMapper
  choices: Choices
  /** A turn runs, whose answer its prompt waits for. */
  running: boolean
  /** Requests that wait for the user, withdrawn once the turn they belong to ends. */
  asks: Set<AbortController>
}

type Deferred = (ctx: MapperContext) => MapperOutput | null

/** Where the installed `cline` package keeps the SDK, from the package's bin entry. */
export function sdkEntry(binEntry: string): string {
  return path.join(path.dirname(binEntry), '..', '..', '@cline', 'sdk', 'dist', 'index.js')
}

/** A folder beside the install for Node.js's compile cache, removed with the install. */
function compileCacheDir(binEntry: string): string {
  return path.join(path.dirname(binEntry), '..', '..', '.cache', 'kettu-compile')
}

/** Kettu's prompt as Cline takes it: text, images as data URLs and files by path. */
export function promptParts(blocks: readonly PromptBlock[]): Omit<PromptParams, 'sessionId'> {
  const text: string[] = []
  const images: string[] = []
  const files: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        text.push(block.text)
        break
      case 'image':
        images.push(`data:${block.mimeType};base64,${block.data}`)
        break
      case 'resource_link': {
        const file = fileOf(block.uri)
        // Cline reads a file into the message itself; any other link reads as written.
        if (file) files.push(file)
        else text.push(block.uri)
        break
      }
      case 'resource':
        text.push(
          `<file_content path="${fileOf(block.resource.uri) ?? block.resource.uri}">\n${block.resource.text}\n</file_content>`,
        )
        break
    }
  }
  return { text: text.join('\n'), images, files }
}

function fileOf(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  try {
    return decodeURIComponent(new URL(uri).pathname)
  } catch {
    return null
  }
}

/** Kettu's MCP servers as the SDK registers them. */
export function mcpServers(servers: readonly McpServer[]): ClineMcpServer[] {
  return servers.map((server): ClineMcpServer => {
    if (server.type === 'stdio') {
      return {
        name: server.name,
        type: 'stdio',
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map((item) => [item.name, item.value])),
        autoAllow: [],
      }
    }
    return {
      name: server.name,
      type: server.type === 'http' ? 'streamableHttp' : 'sse',
      url: server.url,
      headers: Object.fromEntries(server.headers.map((item) => [item.name, item.value])),
      autoAllow: server.autoAllow ?? [],
    }
  })
}

/** What goes into the session's own instructions: each server's paragraph, Kettu's memory, the role. */
function instructions(options: SessionOptions): string | null {
  if (options.promptAhead) return null
  const parts = [
    ...(options.mcpServers ?? []).flatMap((server) =>
      server.type === 'stdio' ? [] : (server.prompt ?? []),
    ),
    ...(options.memory ? [options.memory.text] : []),
    ...(options.role ? [options.role] : []),
  ]
  return parts.length > 0 ? parts.join('\n\n') : null
}

function stopReason(finishReason: string): StopReason {
  switch (finishReason) {
    case 'aborted':
      return 'cancelled'
    case 'max_iterations':
      return 'max_turn_requests'
    default:
      return 'end_turn'
  }
}

/** The question card's answer as the text Cline's tool returns. */
export function questionAnswer(
  options: readonly string[],
  answer: PermissionAnswer,
): string | null {
  if (answer === 'cancelled' || 'values' in answer) return null
  if ('optionId' in answer) {
    const chosen = ANSWER.exec(answer.optionId)
    return (chosen ? options[Number(chosen[1])] : undefined) ?? answer.note?.trim() ?? null
  }
  const given: QuestionAnswer | undefined = answer.answers.find((item) => item.question === 0)
  if (!given) return null
  const picked = given.choices.flatMap((choice) => options[choice] ?? [])
  const text = given.text?.trim()
  const parts = [...picked, ...(text ? [text] : [])]
  return parts.length > 0 ? parts.join('\n') : null
}

export class ClineConnection implements AgentConnection {
  readonly closed: Promise<void>
  readonly ownInstructions = true
  private resolveClosed!: () => void
  private done = false
  private proc: Proc | null = null
  private providers: ClineProvider[] = []
  private readonly sessions = new Map<string, Session>()
  private readonly targets = new Map<string, SessionTarget>()
  private readonly pending = new Map<string, Deferred[]>()
  private readonly unregistered = new Set<string>()
  private readonly collectors = new Map<string, string[]>()
  private pendingCount = 0
  /** The client a sign-in runs for, which opens the page Cline hands over. */
  private signIn: SignInClient | null = null

  constructor(private readonly context: HostedContext) {
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve))
  }

  get isClosed(): boolean {
    return this.done
  }

  get hiddenSessions(): boolean {
    return false
  }

  /** A session costs Cline nothing until its first prompt, so one opened only to be read leaves no trace. */
  get unpromptedSessions(): boolean {
    return true
  }

  private get hooks(): ConnectionHooks {
    return this.context.hooks
  }

  close(): void {
    if (this.done) return
    this.done = true
    for (const session of this.sessions.values()) this.withdraw(session)
    const proc = this.proc
    this.proc = null
    if (proc) void this.stop(proc)
    this.resolveClosed()
  }

  // The process.

  /** The bin of the installed package, which the launch runs with Node.js. */
  private get binEntry(): string | null {
    const { args } = this.context.spec
    return args.find((word) => /[\\/]cline[\\/]bin[\\/]cline$/.test(word)) ?? null
  }

  private start(): Proc {
    const { nodeRuntime, clineHostPath, env, spec } = this.context
    const bin = this.binEntry
    if (!nodeRuntime || !clineHostPath || !bin) {
      throw new ClineSdkUnavailable('Kettu has no process to run the SDK in')
    }
    // What only starts the process is named to it, to keep from the commands the agent runs: an
    // Electron app one of them starts would otherwise run as Node.js.
    const own = { ...nodeRuntime.env, [COMPILE_CACHE]: compileCacheDir(bin) }
    const child = this.context.spawn({
      command: nodeRuntime.command,
      args: [clineHostPath, sdkEntry(bin), ...Object.keys(own)],
      env: { ...env, ...spec.env, ...own },
    })
    const { stream, close } = messageStream({
      kind: 'stdio',
      stdin: child.stdin!,
      stdout: child.stdout!,
    })
    const proc: Proc = { child, rpc: null as unknown as RpcPeer }
    proc.rpc = new RpcPeer(
      stream,
      {
        notification: (method, params) => this.notification(method, params),
        request: (method, params, _id, signal) => this.serve(method, params, signal),
        traffic: (direction, message) => this.hooks.traffic(direction, message),
        log: (level, message) => this.hooks.log(level, message),
      },
      () => {
        close()
        // The process is the Agent: once it is gone, so is the connection.
        if (this.proc === proc) this.close()
      },
    )
    child.once('exit', () => proc.rpc.close())
    child.once('error', () => proc.rpc.close())
    return proc
  }

  private async stop(proc: Proc): Promise<void> {
    try {
      await Promise.race([
        proc.rpc.request(METHOD.shutdown),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref()),
      ])
    } catch {
      // Gone already.
    }
    if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill()
    proc.rpc.close()
  }

  private get rpc(): RpcPeer {
    if (this.done || !this.proc) throw new AgentRequestError('closed', 'Cline stopped')
    return this.proc.rpc
  }

  private async call<T>(method: string, params?: unknown): Promise<T> {
    try {
      return await this.rpc.request<T>(method, params)
    } catch (error) {
      throw this.requestError(error)
    }
  }

  // The agent.

  async initialize(): Promise<AgentInit> {
    let proc: Proc
    let hello: HelloResult
    try {
      proc = this.start()
      this.proc = proc
      hello = await Promise.race([
        proc.rpc.request<HelloResult>(METHOD.hello),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('The SDK did not load in time')),
            HELLO_TIMEOUT_MS,
          ).unref(),
        ),
      ])
    } catch (error) {
      const failed = this.proc
      this.proc = null
      if (failed) void this.stop(failed)
      if (error instanceof ClineSdkUnavailable) throw error
      throw new ClineSdkUnavailable(
        error instanceof RpcClosed
          ? 'its process ended before it answered'
          : ((error as Error)?.message ?? String(error)),
      )
    }
    this.providers = hello.providers
    this.reportAccount()
    const version = await this.packageVersion()
    return {
      name: 'Cline',
      version,
      capabilities: {
        loadSession: false,
        listSessions: false,
        resumeSession: true,
        closeSession: true,
        deleteSession: false,
        forkSession: false,
        forkAtMessage: false,
        ownTitles: null,
        logout: false,
        steering: true,
        mcpHttp: true,
        mcpSse: true,
        mcpStdio: true,
        // Cline reads a linked file into the message itself, so files go as links.
        prompt: { image: true, audio: false, embeddedContext: false },
      },
      authMethods: hello.providers
        .filter((provider) => provider.oauth)
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          type: 'agent' as const,
          args: [],
          env: {},
        })),
      raw: { version, core: hello.core },
    }
  }

  private async packageVersion(): Promise<string | null> {
    const bin = this.binEntry
    if (!bin) return null
    try {
      const manifest = JSON.parse(
        await readFile(path.join(path.dirname(bin), '..', 'package.json'), 'utf8'),
      ) as { version?: unknown }
      return typeof manifest.version === 'string' ? manifest.version : null
    } catch {
      return null
    }
  }

  /** The provider Cline is signed in to or holds a key for, as the Agent's account. */
  private reportAccount(): void {
    const ready = this.providers.filter((provider) => provider.ready)
    const provider = ready.find((item) => item.oauth) ?? ready[0]
    this.hooks.authState?.(provider ? 'authenticated' : 'unauthenticated')
    this.hooks.account(
      provider
        ? { kind: provider.oauth ? 'account' : 'api_key', label: provider.name, email: null }
        : { kind: 'none', label: '', email: null },
    )
  }

  async authenticate(methodId: string, client?: SignInClient): Promise<void> {
    this.signIn = client ?? null
    try {
      const result = await this.call<{ providers: ClineProvider[] }>(METHOD.signIn, {
        provider: methodId,
      })
      this.providers = result.providers
      this.reportAccount()
    } finally {
      this.signIn = null
    }
  }

  logout(): Promise<void> {
    return Promise.reject(new AgentRequestError('agent_error', 'Cline has no sign-out'))
  }

  // Sessions.

  private async open(
    sessionId: string,
    cwd: string,
    options: SessionOptions,
    resume: boolean,
  ): Promise<Session> {
    const existing = this.sessions.get(sessionId)
    const params: OpenParams = {
      sessionId,
      cwd,
      resume,
      settings: existing?.choices.settings ?? {},
      mcpServers: mcpServers(options.mcpServers ?? []),
      instructions: instructions(options),
    }
    const opened = await this.call<OpenResult>(METHOD.open, params)
    this.providers = opened.providers
    const choices: Choices = {
      settings: opened.settings,
      providers: opened.providers,
      models: opened.models,
    }
    const session: Session = existing ?? {
      id: sessionId,
      cwd,
      mapper: new SessionMapper(cwd),
      choices,
      running: false,
      asks: new Set(),
    }
    session.choices = choices
    session.mapper.window(currentModel(choices)?.contextWindow ?? null)
    this.sessions.set(sessionId, session)
    return session
  }

  async newSession(cwd: string, options: SessionOptions = {}): Promise<OpenedSession> {
    this.assertOpen()
    // Cline makes the id a folder name; its own ids are a time and a few letters.
    const sessionId = `${Date.now()}_${randomBytes(4).toString('hex')}_kettu`
    const session = await this.open(sessionId, cwd, options, false)
    return { sessionId, config: configOptions(session.choices) }
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    this.assertOpen()
    const session = await this.open(sessionId, cwd, options, true)
    return { config: configOptions(session.choices) }
  }

  loadSession(): Promise<SessionSetup> {
    return Promise.reject(new AgentRequestError('agent_error', 'Cline replays no history'))
  }

  forkSession(): Promise<OpenedSession> {
    return Promise.reject(new AgentRequestError('agent_error', 'Cline has no forks'))
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    this.withdraw(session)
    if (this.done || !this.proc) return
    await this.call(METHOD.close, { sessionId }).catch(() => {})
  }

  deleteSession(): Promise<void> {
    return Promise.reject(new AgentRequestError('agent_error', 'Cline keeps its sessions'))
  }

  async listSessions(): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    return { sessions: [], nextCursor: null }
  }

  async removeHidden(sessionId: string): Promise<void> {
    this.unregistered.add(sessionId)
    await this.closeSession(sessionId)
  }

  register(sessionId: string, target: SessionTarget): void {
    this.targets.set(sessionId, target)
    this.unregistered.delete(sessionId)
    const early = this.pending.get(sessionId)
    if (!early) return
    this.pending.delete(sessionId)
    this.pendingCount -= early.length
    for (const map of early) {
      const output = map(target.context())
      if (output) target.apply(output)
    }
  }

  unregister(sessionId: string, target?: SessionTarget): void {
    if (target && this.targets.get(sessionId) !== target) return
    this.targets.delete(sessionId)
    this.unregistered.add(sessionId)
  }

  reopen(sessionId: string): void {
    this.unregistered.delete(sessionId)
  }

  rootOf(id: string): string {
    return id
  }

  // Turns.

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    const session = this.requireSession(sessionId)
    if (session.running) throw new AgentRequestError('agent_error', t('agentRun.turnRunning'))
    session.running = true
    session.mapper.turn()
    try {
      const params: PromptParams = { sessionId, ...promptParts(prompt) }
      const result = await this.call<TurnResult>(METHOD.prompt, params)
      const tokens = result.usage ? tokenTotals(result.usage) : null
      return {
        stopReason: stopReason(result.finishReason),
        tokens,
        models: tokens && result.model ? [{ model: result.model, tokens }] : [],
      }
    } finally {
      session.running = false
      this.withdraw(session)
      const target = this.targets.get(sessionId)
      const output = target && session.mapper.ended(target.context())
      if (output) target.apply(output)
    }
  }

  async collect(sessionId: string, text: string): Promise<string[]> {
    const texts: string[] = []
    this.collectors.set(sessionId, texts)
    try {
      await this.prompt(sessionId, [{ type: 'text', text }])
    } finally {
      this.collectors.delete(sessionId)
    }
    return texts
  }

  async steer(
    sessionId: string,
    prompt: readonly PromptBlock[],
  ): Promise<'injected' | 'promptRequired'> {
    const session = this.sessions.get(sessionId)
    if (!session?.running) return 'promptRequired'
    const params: PromptParams = { sessionId, ...promptParts(prompt) }
    const result = await this.call<SteerResult>(METHOD.steer, params)
    return result.injected ? 'injected' : 'promptRequired'
  }

  async injectHistory(): Promise<boolean> {
    return false
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.running) return
    await this.call(METHOD.cancel, { sessionId })
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.setConfigOption(sessionId, 'mode', modeId)
  }

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const session = this.requireSession(sessionId)
    const settings = settingsChange(optionId, value, session.choices)
    if (!settings) {
      throw new AgentRequestError(
        'agent_error',
        t('agentRun.noChoice', { option: optionId, value: String(value) }),
      )
    }
    const result = await this.call<SetResult>(METHOD.set, { sessionId, settings })
    session.choices = { ...session.choices, settings: result.settings, models: result.models }
    session.mapper.window(currentModel(session.choices)?.contextWindow ?? null)
    return configOptions(session.choices)
  }

  // What the process sends.

  private notification(method: string, params: unknown): void {
    if (method !== METHOD.event) {
      this.hooks.ignored(null, method)
      return
    }
    const { sessionId, event } = params as EventNotification
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.hooks.ignored(sessionId, event.type)
      return
    }
    const collected = this.collectors.get(sessionId)
    if (collected) {
      if (event.type === 'content_end' && event.contentType === 'text' && event.text) {
        collected.push(event.text)
      }
      return
    }
    const target = this.targets.get(sessionId)
    if (!target) {
      this.hold(sessionId, (ctx) => session.mapper.event(event, ctx))
      return
    }
    const output = session.mapper.event(event, target.context())
    if (output) target.apply(output)
  }

  /** Keeps an event for a session no target is registered for yet, to map once its target comes. */
  private hold(sessionId: string, map: Deferred): void {
    if (this.unregistered.has(sessionId) || this.pendingCount >= PENDING_EVENTS) return
    const list = this.pending.get(sessionId) ?? []
    list.push(map)
    this.pending.set(sessionId, list)
    this.pendingCount++
  }

  private async serve(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case METHOD.approval:
        return this.approve(params as ApprovalParams, signal)
      case METHOD.question:
        return this.ask(params as QuestionParams, signal)
      case METHOD.openUrl:
        this.signIn?.openLink((params as OpenUrlParams).url)
        return {}
      default:
        throw new RpcError(-32601, `Kettu does not answer ${method}`)
    }
  }

  /** A signal that also aborts once the session's turn ends, which withdraws the card. */
  private asking(session: Session, signal: AbortSignal): { signal: AbortSignal; done(): void } {
    const abort = new AbortController()
    session.asks.add(abort)
    return {
      signal: AbortSignal.any([signal, abort.signal]),
      done: () => void session.asks.delete(abort),
    }
  }

  private withdraw(session: Session): void {
    for (const abort of session.asks) abort.abort(new Error('The turn ended'))
    session.asks.clear()
  }

  private async approve(params: ApprovalParams, signal: AbortSignal): Promise<ApprovalResult> {
    const session = this.sessions.get(params.sessionId)
    const target = this.targets.get(params.sessionId)
    if (!session || !target) return { approved: false }
    const asking = this.asking(session, signal)
    try {
      const answer = await target.requestPermission(
        {
          toolCallId: params.toolCallId,
          toolEntryId: `t:${params.toolCallId}`,
          output: session.mapper.announce(
            params.toolCallId,
            params.toolName,
            params.input,
            target.context(),
          ),
          options: [
            { id: OPTION.allow, name: t('permission.allowOnce'), kind: 'allow_once' },
            { id: OPTION.always, name: t('cline.permission.allowAlways'), kind: 'allow_always' },
            { id: OPTION.reject, name: t('dsh.permission.reject'), kind: 'reject_once' },
          ],
        },
        asking.signal,
      )
      const picked = optionAnswer(answer)
      if (picked === 'cancelled' || picked.optionId === OPTION.reject) return { approved: false }
      return { approved: true, ...(picked.optionId === OPTION.always ? { always: true } : {}) }
    } catch {
      return { approved: false }
    } finally {
      asking.done()
    }
  }

  private async ask(params: QuestionParams, signal: AbortSignal): Promise<QuestionResult> {
    const session = this.sessions.get(params.sessionId)
    const target = this.targets.get(params.sessionId)
    if (!session || !target || !params.toolCallId) return { answer: null }
    const asking = this.asking(session, signal)
    try {
      const answer = await target.requestPermission(
        {
          toolCallId: params.toolCallId,
          toolEntryId: `t:${params.toolCallId}`,
          output: { patches: [], effects: [] },
          options: [
            ...params.options.map((option, index) => ({
              id: `answer:${index}`,
              name: option,
              kind: 'allow_once' as const,
            })),
            { id: OTHER_ANSWER, name: t('question.other'), kind: 'reject_once' as const },
          ],
          questions: [
            {
              header: '',
              question: params.question,
              multiSelect: false,
              options: params.options.map((label) => ({ label })),
              allowsText: true,
              secret: false,
            },
          ],
        },
        asking.signal,
      )
      return { answer: questionAnswer(params.options, answer) }
    } catch {
      return { answer: null }
    } finally {
      asking.done()
    }
  }

  // Helpers.

  private requireSession(sessionId: string): Session {
    this.assertOpen()
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new AgentRequestError('agent_error', t('agentRun.noSession', { id: sessionId }), -32002)
    }
    return session
  }

  private assertOpen(): void {
    if (this.done) throw new AgentRequestError('closed', 'Cline stopped')
  }

  private requestError(error: unknown): Error {
    if (error instanceof AgentRequestError) return error
    if (error instanceof RpcClosed) return new AgentRequestError('closed', 'Cline stopped')
    if (error instanceof RpcError) {
      return new AgentRequestError(
        error.code === ERROR.authRequired ? 'auth_required' : 'agent_error',
        refusalText(error.data) ?? error.message,
        error.code,
      )
    }
    return new AgentRequestError('agent_error', (error as Error)?.message ?? String(error))
  }
}
