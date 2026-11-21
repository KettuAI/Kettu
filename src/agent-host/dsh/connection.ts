// DeepSeek Harness through its SDK interface: one `dsh --profile sdk` process per open session,
// spoken to over newline-delimited JSON-RPC on its stdio. The wire can neither stop a turn nor close
// a session, and fixes the model at `initialize`, so Stop and a change of model end the session's
// process, and the next prompt starts another that resumes the session. The wire lists no models,
// so the menus show the list dsh gives in its ACP mode, read in a process of its own.

import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ConfigOption, QuestionAnswer, StopReason, TokenTotals } from '@shared/thread'
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
} from '../connection'
import { messageStream, RpcClosed, RpcError, RpcPeer } from '../codex/rpc'
import type { HostedContext } from '../driver'
import { t } from '../i18n'
import {
  addTokenTotals,
  type MapperContext,
  type MapperOutput,
  type SubagentState,
} from '../session-updates'
import { SessionMapper, tokenTotals } from './mapper'
import {
  CONFIG,
  DEFAULT_LEVEL,
  DEFAULT_PRESET,
  choiceOf,
  configOptions,
  isMode,
  listedModelChoices,
  modeCommands,
  modelChoices,
  startChoice,
  type ModelChoice,
} from './options'
import type {
  ApprovalOutcome,
  ApprovalRequestParams,
  EventData,
  PromptContent,
  QuestionRequest,
  QuestionResult,
  SessionEvent,
  SessionEventNotification,
  SessionStatusNotification,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from './protocol'
import { credentialsStamp, dshHome, readProvider, routeAccount, type Provider } from './credentials'
import { listingRows, readListing, type ListedModel } from './listing'
import { NO_ROUTES, readRoutes, type Routes } from './routes'

const PENDING_EVENTS = 2_000
const INITIALIZE_TIMEOUT_MS = 60_000
const SHUTDOWN_WAIT_MS = 5_000
/** How long dsh's list of its models is kept, as dsh keeps what DeepSeek publishes. */
const LISTING_MAX_AGE_MS = 600_000
/** When a listing that gave no answer is tried again. */
const LISTING_RETRY_MS = 60_000
/** How long a session waits for a listing that is still being read. */
const LISTING_WAIT_MS = 20_000

/**
 * The last list read for each dsh home, which outlives the agent's connection: a listing starts
 * dsh once more, so an agent that starts again shows the last list while it reads the next.
 */
const LISTINGS = new Map<string, { listed: ListedModel[]; home: string; due: number }>()
/** The temporary folder of each listing process, and how old a leftover one is removed. */
const LISTING_PREFIX = 'kettu-dsh-models-'
const STALE_LISTING_MS = 24 * 60 * 60_000
let staleRemoved = false

/**
 * Removes listing folders a day old or older, left by a host that quit while dsh still ran; once
 * per run, since a listing removes its own.
 */
async function removeStaleListings(): Promise<void> {
  if (staleRemoved) return
  staleRemoved = true
  const tmp = os.tmpdir()
  const names = await readdir(tmp).catch(() => [])
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith(LISTING_PREFIX)) continue
    const folder = path.join(tmp, name)
    const info = await stat(folder).catch(() => null)
    if (!info?.isDirectory() || now - info.mtimeMs < STALE_LISTING_MS) continue
    await rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}
const NOT_FOUND = /not found/i
const AUTH_CODES = new Set([
  'AUTH',
  'UNAUTHORIZED',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'MISSING_CREDENTIAL',
])
const OPTION = { allow: 'allow-once', reject: 'reject', approve: 'approve', keep: 'keep' }
/** An option id answering a question's choice, as a client without the card's questions sends. */
const ANSWER = /^answer:(\d+)$/
const OTHER_ANSWER = 'other'

interface Turn {
  resolve(result: PromptResult): void
  reject(error: Error): void
  tokens: TokenTotals | null
  model: string | null
  /** Started by dsh itself between Kettu's turns, such as when a subagent's result came back. */
  own: boolean
}

interface Proc {
  child: ChildProcess
  rpc: RpcPeer
  ready: Promise<void>
  /** The `--patch` file with the home's model routes and the session's MCP servers. */
  folder: string | null
  stopping: boolean
}

interface Session {
  id: string
  cwd: string
  options: SessionOptions
  mapper: SessionMapper
  proc: Proc | null
  /** dsh has the session on disk, so a new process resumes it rather than starting one. */
  persisted: boolean
  /** A model choice's value, and the level it runs at; null for a model without levels. */
  model: string
  effort: string | null
  preset: string
  plan: boolean
  turn: Turn | null
  /** The user stopped the turn; the process is ending. */
  cancelling: boolean
  /** Questions waiting for the user, by dsh's request id. */
  questions: Map<string, AbortController>
}

type Deferred = (ctx: MapperContext) => MapperOutput | null

interface Child {
  rootId: string
  mapper: SessionMapper
}

/** A dsh failure as Kettu's error: a sign-in it needs, or the provider's own refusal. */
export function turnError(error: { message: string; code: string; status?: number }): Error {
  if (error.status === 401 || AUTH_CODES.has(error.code)) {
    return new AgentRequestError('auth_required', error.message)
  }
  return new AgentRequestError('agent_error', error.message, null, {
    code: error.code,
    ...(error.status !== undefined ? { status: error.status } : {}),
  })
}

/** Kettu's prompt as dsh's content: text, images and links, in order. */
export function promptContent(blocks: readonly PromptBlock[]): PromptContent[] {
  const content: PromptContent[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'image':
        content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
        break
      case 'resource_link':
        // dsh opens a path with its own tools; a link reads as one in the message.
        content.push({ type: 'text', text: `@${fileOf(block.uri)}` })
        break
      case 'resource':
        content.push({
          type: 'text',
          text: `<file path="${fileOf(block.resource.uri)}">\n${block.resource.text}\n</file>`,
        })
        break
    }
  }
  return content
}

function fileOf(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  try {
    return decodeURIComponent(new URL(uri).pathname)
  } catch {
    return uri
  }
}

function stopReason(reason: EventData['turn/end']['reason']): StopReason {
  switch (reason.kind) {
    case 'aborted':
    case 'interrupted':
      return 'cancelled'
    case 'max-tokens':
      return 'max_tokens'
    case 'blocked':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

/** A name dsh takes for an MCP server: letters, digits, `_` and `-`, at most 32. */
export function serverName(name: string, taken: ReadonlySet<string>): string {
  const base = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'mcp'
  let candidate = base
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = `_${n}`
    candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`
  }
  return candidate
}

/**
 * The `--patch` rows that mount Kettu's MCP servers, and the variables that carry every header and
 * environment value: the file names only the variables, whose names hold `SECRET`, so dsh keeps
 * them from its tools.
 */
export function mcpPatch(servers: readonly McpServer[]): {
  yaml: string
  env: Record<string, string>
} {
  const env: Record<string, string> = {}
  const taken = new Set<string>()
  const lines = ['- insert:']
  let n = 0
  const secret = (value: string): string => {
    const name = `KETTU_MCP_SECRET_${n++}`
    env[name] = value
    return `!!js process.env.${name}`
  }
  const q = (value: string): string => JSON.stringify(value)
  servers.forEach((server, index) => {
    if (server.type === 'sse') return
    const name = serverName(server.name, taken)
    taken.add(name)
    lines.push(`    - id: ${q(`kettu-mcp-${index}`)}`)
    lines.push(`      name: '@deepseek-ai/dsh-mcp-client'`)
    lines.push('      config:')
    lines.push(`        serverName: ${q(name)}`)
    if (server.type === 'http') {
      lines.push(`        transport: streamable-http`)
      lines.push(`        url: ${q(server.url)}`)
      if (server.headers.length > 0) {
        lines.push('        headers:')
        for (const header of server.headers)
          lines.push(`          ${q(header.name)}: ${secret(header.value)}`)
      }
    } else if (server.type === 'stdio') {
      lines.push(`        transport: stdio`)
      lines.push(`        command: ${q(server.command)}`)
      lines.push(`        args: [${server.args.map(q).join(', ')}]`)
      if (server.env.length > 0) {
        lines.push('        env:')
        for (const variable of server.env)
          lines.push(`          ${q(variable.name)}: ${secret(variable.value)}`)
      }
    }
  })
  return { yaml: taken.size > 0 ? `${lines.join('\n')}\n` : '', env }
}

/** The plan card's answer as dsh's: Approve, or Keep planning with what to change. */
export function planAnswer(
  question: { id: string; options?: { label: string }[] },
  approve: string,
  answer: { optionId: string; note?: string } | null,
): QuestionResult {
  if (answer === null) return { cancelled: true }
  if (answer.optionId === OPTION.approve)
    return { answers: [{ id: question.id, selected: [approve] }] }
  const keep = question.options?.find((option) => option.label !== approve)?.label
  return {
    answers: [
      {
        id: question.id,
        selected: keep ? [keep] : [],
        ...(answer.note ? { custom: answer.note } : {}),
      },
    ],
  }
}

/** The question card's answers as dsh's: every question once, by its own id. */
export function questionResult(request: QuestionRequest, answer: PermissionAnswer): QuestionResult {
  if (answer === 'cancelled' || 'values' in answer) return { cancelled: true }
  const { questions } = request
  if ('optionId' in answer) {
    const first = questions[0]
    const chosen = ANSWER.exec(answer.optionId)
    const label = chosen ? first?.options?.[Number(chosen[1])]?.label : undefined
    if (!first || !label) return { cancelled: true }
    return {
      answers: questions.map((question) => ({
        id: question.id,
        selected: question === first ? [label] : [],
      })),
    }
  }
  const byIndex = new Map<number, QuestionAnswer>(answer.answers.map((a) => [a.question, a]))
  return {
    answers: questions.map((question, index) => {
      const given = byIndex.get(index)
      const labels = (question.options ?? []).map((option) => option.label)
      const selected = given ? given.choices.flatMap((choice) => labels[choice] ?? []) : []
      const custom = given?.text?.trim()
      return { id: question.id, selected, ...(custom ? { custom } : {}) }
    }),
  }
}

export class DshConnection implements AgentConnection {
  readonly closed: Promise<void>
  private resolveClosed!: () => void
  private done = false
  private version: string | null = null
  private readonly sessions = new Map<string, Session>()
  private readonly children = new Map<string, Child>()
  private readonly targets = new Map<string, SessionTarget>()
  private readonly pending = new Map<string, Deferred[]>()
  private readonly unregistered = new Set<string>()
  private pendingCount = 0
  /** The home's model routes and DeepSeek sign-in as last read, and the models they give. */
  private routes: Routes = NO_ROUTES
  private signedIn: Provider | null = null
  private models: ModelChoice[] = modelChoices(NO_ROUTES, null)
  private reported: string | null = null
  /** dsh's own list of its models; null until one was read. */
  private listed: ListedModel[] | null = null
  /** What of the home the last listing was started for, and when the next one is due. */
  private listedFor: string | null = null
  private listedDue = 0
  private listing: Promise<void> | null = null
  /** A listing ended, with a list or without: only then is a home known to offer no model. */
  private settled = false
  private readonly stopListing = new AbortController()

  constructor(private readonly context: HostedContext) {
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve))
  }

  get isClosed(): boolean {
    return this.done
  }

  get hiddenSessions(): boolean {
    return false
  }

  // A session that is only opened starts no process, so dsh never hears of it.
  get unpromptedSessions(): boolean {
    return true
  }

  private get hooks(): ConnectionHooks {
    return this.context.hooks
  }

  close(): void {
    if (this.done) return
    this.done = true
    this.stopListing.abort()
    for (const session of this.sessions.values()) {
      session.turn?.reject(new AgentRequestError('closed', 'DeepSeek Harness stopped'))
      session.turn = null
      void this.stop(session)
    }
    this.resolveClosed()
  }

  /** The bin of the installed package, which the launch runs with Node.js. */
  private get entry(): string | null {
    const args = this.context.spec.args
    return args.length > 0 ? args[args.length - 1]! : null
  }

  async initialize(): Promise<AgentInit> {
    const entry = this.entry
    // The user's own dsh runs without an entry, and said its version as it was detected.
    this.version = this.context.cliVersion ?? null
    if (entry) {
      try {
        const manifest = JSON.parse(
          await readFile(path.join(path.dirname(entry), '..', 'package.json'), 'utf8'),
        ) as { version?: unknown }
        this.version = typeof manifest.version === 'string' ? manifest.version : null
      } catch {
        // The version is only shown.
      }
    }
    await this.refresh()
    return {
      name: 'DeepSeek Harness',
      version: this.version,
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
        steering: false,
        mcpHttp: true,
        mcpSse: false,
        mcpStdio: true,
        prompt: { image: true, audio: false, embeddedContext: true },
      },
      // Its account sign-in needs its web server for the callback, which the SDK runs without.
      authMethods: [
        {
          id: 'dsh-web',
          name: t('dsh.auth.account'),
          description: t('dsh.auth.accountDescription'),
          type: 'terminal',
          args: ['web'],
          env: {},
        },
      ],
      raw: { version: this.version },
    }
  }

  /**
   * Reads the home again: its routes change in dsh's own pages and its sign-in in a terminal,
   * neither of which tells Kettu.
   */
  private async refresh(): Promise<void> {
    const { env } = this.context
    const folder = dshHome(env)
    const [routes, signedIn, stamp] = await Promise.all([
      readRoutes(folder),
      readProvider(env),
      credentialsStamp(env),
    ])
    this.routes = routes
    this.signedIn = signedIn
    // What dsh lists follows its routes and the keys it holds for them.
    const home = `${signedIn}\n${stamp}\n${routes.yaml}`
    const kept = LISTINGS.get(folder)
    if (this.listed === null && kept) {
      this.listed = kept.listed
      this.listedFor = kept.home
      this.listedDue = kept.due
      this.settled = true
    }
    if (!this.listing && !this.done && (home !== this.listedFor || Date.now() >= this.listedDue)) {
      this.listedFor = home
      this.listing = this.list(folder, home)
        .catch(() => {
          this.settled = true
          this.listedDue = Date.now() + LISTING_RETRY_MS
          this.apply()
        })
        .finally(() => {
          this.listing = null
        })
    }
    this.apply()
  }

  /**
   * Reads dsh's own list in a process of its own, which gets the home's routes as a session's
   * process does and keeps its session in a folder of Kettu's.
   */
  private async list(folder: string, home: string): Promise<void> {
    const { spec, env } = this.context
    void removeStaleListings()
    const own = await mkdtemp(path.join(os.tmpdir(), LISTING_PREFIX))
    let listed: ListedModel[] | null
    let exited: Promise<void> = Promise.resolve()
    try {
      const file = path.join(own, 'kettu.patch.yml')
      await writeFile(file, `${this.routes.yaml}${listingRows(own)}`, { mode: 0o600 })
      const listing = await readListing({
        cwd: own,
        signal: this.stopListing.signal,
        spawn: (stop) =>
          this.context.spawn({
            command: spec.command,
            args: [...spec.args, '--profile', 'acp', '--patch', file],
            cwd: own,
            env: { ...env, ...spec.env },
            signal: stop,
          }),
      }).catch(() => null)
      listed = listing?.models ?? null
      exited = listing?.exited ?? exited
    } finally {
      // dsh still writes to the folder as it exits, so it goes once dsh has, in the background.
      void exited.then(() => rm(own, { recursive: true, force: true })).catch(() => {})
    }
    this.settled = true
    this.listedDue = Date.now() + (listed ? LISTING_MAX_AGE_MS : LISTING_RETRY_MS)
    if (this.done) return
    if (listed) {
      this.listed = listed
      LISTINGS.set(folder, { listed, home, due: this.listedDue })
    }
    const before = JSON.stringify(this.models)
    this.apply()
    if (JSON.stringify(this.models) === before) return
    for (const session of this.sessions.values()) {
      if (this.targets.has(session.id)) this.config(session)
    }
  }

  /** Waits a while for a listing that is being read, so what follows goes by dsh's own list. */
  private async listSoon(): Promise<void> {
    if (!this.listing) return
    let timer: ReturnType<typeof setTimeout> | null = null
    await Promise.race([
      this.listing,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, LISTING_WAIT_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  /**
   * The models the menus offer, which are dsh's own list once it was read and until then the ones
   * the home's files name, and the sign-in the agent shows.
   */
  private apply(): void {
    const listed = this.listed ?? []
    this.models =
      listed.length > 0
        ? listedModelChoices(listed, this.routes, this.signedIn)
        : modelChoices(this.routes, this.signedIn)
    // Another route's own key is the user's to set in dsh, so a home with one counts as signed in.
    const routed = listed.length > 0 || this.routes.groups.length > 0
    const kind = this.signedIn ?? (routed ? 'gateway' : this.settled ? 'none' : null)
    if (kind === null || kind === this.reported) return
    this.reported = kind
    this.hooks.account(
      kind === 'gateway'
        ? { kind: 'gateway', label: t('dsh.account.gateway'), email: null }
        : kind === 'none'
          ? { kind: 'none', label: '', email: null }
          : routeAccount(kind),
    )
  }

  /** Keeps the session on a model the home lists, and on a level that model has. */
  private settle(session: Session): ModelChoice | null {
    const listed = this.models.find((choice) => choice.value === session.model)
    if (listed) {
      if (session.effort === null || !listed.efforts.includes(session.effort))
        session.effort = listed.effort
      return listed
    }
    const start = startChoice(this.models, this.routes)
    if (!start) return null
    session.model = start.value
    session.effort = start.effort
    return start
  }

  private options(session: Session): ConfigOption[] {
    this.settle(session)
    return configOptions(session, this.models)
  }

  authenticate(methodId: string): Promise<void> {
    return Promise.reject(
      new AgentRequestError('agent_error', `${methodId} signs in in a terminal`, -32602),
    )
  }

  logout(): Promise<void> {
    return Promise.reject(new AgentRequestError('agent_error', 'DeepSeek Harness has no sign-out'))
  }

  // Sessions.

  private open(
    sessionId: string,
    cwd: string,
    options: SessionOptions,
    persisted: boolean,
  ): Session {
    const session: Session = {
      id: sessionId,
      cwd,
      options,
      mapper: new SessionMapper(cwd),
      proc: null,
      persisted,
      model: '',
      effort: null,
      preset: DEFAULT_PRESET,
      plan: false,
      turn: null,
      cancelling: false,
      questions: new Map(),
    }
    this.sessions.set(sessionId, session)
    return session
  }

  async newSession(cwd: string, options: SessionOptions = {}): Promise<OpenedSession> {
    this.assertOpen()
    await this.refresh()
    // A session goes by dsh's own list: the first waits for it, as does Kettu's own read of the
    // options, which is also how it learns that a sign-in was made.
    if (options.hidden || this.listed === null) await this.listSoon()
    if (options.hidden && this.reported === 'none') {
      throw new AgentRequestError('auth_required', t('dsh.noModel'))
    }
    // dsh makes the id a folder name, so it stays short and plain.
    const sessionId = `kettu-${randomUUID().replace(/-/g, '')}`
    const session = this.open(sessionId, cwd, options, false)
    return { sessionId, config: this.options(session) }
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    this.assertOpen()
    await this.refresh()
    if (this.listed === null) await this.listSoon()
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.options = options
      return { config: this.options(existing) }
    }
    return { config: this.options(this.open(sessionId, cwd, options, true)) }
  }

  loadSession(): Promise<SessionSetup> {
    return Promise.reject(
      new AgentRequestError('agent_error', 'DeepSeek Harness replays no history'),
    )
  }

  forkSession(): Promise<OpenedSession> {
    return Promise.reject(new AgentRequestError('agent_error', 'DeepSeek Harness has no forks'))
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await this.stop(session)
    this.sessions.delete(sessionId)
    for (const [childId, child] of this.children)
      if (child.rootId === sessionId) this.children.delete(childId)
  }

  deleteSession(): Promise<void> {
    return Promise.reject(
      new AgentRequestError('agent_error', 'DeepSeek Harness keeps its sessions'),
    )
  }

  async listSessions(): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    return { sessions: [], nextCursor: null }
  }

  async removeHidden(sessionId: string): Promise<void> {
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
    return this.children.get(id)?.rootId ?? id
  }

  // Turns.

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    const session = this.requireSession(sessionId)
    if (session.turn) throw new AgentRequestError('agent_error', t('agentRun.turnRunning'))
    const proc = await this.ready(session)
    session.cancelling = false
    const result = new Promise<PromptResult>((resolve, reject) => {
      session.turn = { resolve, reject, tokens: null, model: this.modelId(session), own: false }
    })
    try {
      await proc.rpc.request('session/prompt', {
        sessionId,
        contentBlocks: promptContent(prompt),
      })
      session.persisted = true
    } catch (error) {
      session.turn = null
      throw this.requestError(error)
    }
    return result
  }

  async collect(sessionId: string, text: string): Promise<string[]> {
    const texts: string[] = []
    const session = this.requireSession(sessionId)
    const proc = await this.ready(session)
    const done = new Promise<void>((resolve, reject) => {
      session.turn = {
        resolve: () => resolve(),
        reject,
        tokens: null,
        model: this.modelId(session),
        own: false,
      }
    })
    const off = this.collector(sessionId, texts)
    try {
      await proc.rpc.request('session/prompt', {
        sessionId,
        contentBlocks: [{ type: 'text', text }],
      })
      session.persisted = true
      await done
    } finally {
      off()
    }
    return texts
  }

  private readonly collectors = new Map<string, string[]>()

  private collector(sessionId: string, texts: string[]): () => void {
    this.collectors.set(sessionId, texts)
    return () => this.collectors.delete(sessionId)
  }

  async steer(): Promise<'injected' | 'promptRequired'> {
    return 'promptRequired'
  }

  async injectHistory(): Promise<boolean> {
    return false
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.turn || !session.proc) return
    session.cancelling = true
    await this.stop(session)
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.setConfigOption(sessionId, CONFIG.mode, modeId)
  }

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const session = this.requireSession(sessionId)
    if (typeof value !== 'string') {
      throw new AgentRequestError('agent_error', t('agentRun.takesChoice', { option: optionId }))
    }
    switch (optionId) {
      case CONFIG.model:
      case CONFIG.effort: {
        // A model added in dsh since the home was last read is one of its models too.
        if (optionId === CONFIG.model && !this.models.some((choice) => choice.value === value)) {
          await this.refresh()
          await this.listSoon()
        }
        const model =
          optionId === CONFIG.model
            ? this.models.find((choice) => choice.value === value)
            : this.settle(session)
        if (!model || (optionId === CONFIG.effort && !model.efforts.includes(value))) {
          throw new AgentRequestError(
            'agent_error',
            t('agentRun.noChoice', { option: optionId, value }),
          )
        }
        if (session.turn) throw new AgentRequestError('agent_error', t('agentRun.betweenTurns'))
        const changed =
          optionId === CONFIG.model ? session.model !== value : session.effort !== value
        if (optionId === CONFIG.model) session.model = value
        else session.effort = value
        // The route is the process's, so the next prompt starts one with it.
        if (changed && session.proc) await this.stop(session)
        break
      }
      case CONFIG.mode: {
        if (!isMode(value))
          throw new AgentRequestError('agent_error', t('agentRun.noMode', { value }))
        const from = { preset: session.preset, plan: session.plan }
        if (value === 'plan') session.plan = true
        else {
          session.plan = false
          session.preset = value
        }
        if (session.proc && !session.proc.stopping) {
          for (const command of modeCommands(from, session)) await this.command(session, command)
        }
        break
      }
      default:
        throw new AgentRequestError('agent_error', t('agentRun.noOption', { option: optionId }))
    }
    return this.options(session)
  }

  private async command(session: Session, text: string): Promise<void> {
    const proc = await this.ready(session)
    await proc.rpc.request('session/query', {
      sessionId: session.id,
      contentBlocks: [{ type: 'text', text }],
    })
    session.persisted = true
  }

  // The process.

  /** The session's process once it answered `initialize` and holds the session, starting it if none. */
  private async ready(session: Session): Promise<Proc> {
    this.assertOpen()
    if (session.proc && !session.proc.stopping) {
      await session.proc.ready
      return session.proc
    }
    const proc = await this.spawn(session)
    session.proc = proc
    try {
      await proc.ready
    } catch (error) {
      if (session.proc === proc) session.proc = null
      void this.stop(session, proc)
      throw this.requestError(error)
    }
    return proc
  }

  private async spawn(session: Session): Promise<Proc> {
    const { spec, env } = this.context
    const servers = session.options.mcpServers ?? []
    const patch = mcpPatch(servers)
    await this.refresh()
    if (this.listed === null) await this.listSoon()
    // A model the user removed in dsh since leaves the session on another, which its menu shows.
    const { model, effort } = session
    this.settle(session)
    if (session.model !== model || session.effort !== effort) this.config(session)
    // The routes' rows come as the user wrote them in dsh's own files.
    const rows = `${this.routes.yaml}${patch.yaml}`
    let folder: string | null = null
    const args = [...spec.args, '--profile', 'sdk']
    if (rows) {
      folder = await mkdtemp(path.join(os.tmpdir(), 'kettu-dsh-'))
      const file = path.join(folder, 'kettu.patch.yml')
      await writeFile(file, rows, { mode: 0o600 })
      args.push('--patch', file)
    }
    const child = this.context.spawn({
      command: spec.command,
      args,
      cwd: session.cwd,
      env: {
        ...env,
        ...spec.env,
        ...patch.env,
        DSH_PERMISSION_MODE: session.preset,
      },
    })
    const { stream, close } = messageStream({
      kind: 'stdio',
      stdin: child.stdin!,
      stdout: child.stdout!,
    })
    const proc: Proc = {
      child,
      rpc: null as unknown as RpcPeer,
      ready: Promise.resolve(),
      folder,
      stopping: false,
    }
    proc.rpc = new RpcPeer(
      stream,
      {
        notification: (method, params) => this.notification(session, method, params),
        request: (method, params, _id, signal) => this.serve(session, method, params, signal),
        traffic: (direction, message) => this.hooks.traffic(direction, message),
        log: (level, message) => this.hooks.log(level, message),
      },
      () => {
        close()
        this.exited(session, proc)
      },
    )
    child.once('exit', () => proc.rpc.close())
    proc.ready = this.handshake(session, proc)
    return proc
  }

  private async handshake(session: Session, proc: Proc): Promise<void> {
    const model = this.settle(session)
    if (!model) throw new AgentRequestError('auth_required', t('dsh.noModel'))
    const provider = model.provider ?? this.signedIn ?? 'deepseek-official'
    const effort = session.effort === DEFAULT_LEVEL ? null : session.effort
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(t('dsh.didNotStart'))), INITIALIZE_TIMEOUT_MS).unref(),
    )
    await Promise.race([
      proc.rpc.request('initialize', {
        cwd: session.cwd,
        approvalRequests: true,
        provider,
        model: model.model,
        ...(effort !== null ? { reasoningEffort: effort } : {}),
        capabilities: { userQuestions: true },
      }),
      timeout,
    ])
    if (session.persisted) {
      try {
        await proc.rpc.request('session/resume', { sessionId: session.id })
      } catch (error) {
        // Never prompted before Kettu closed it, so dsh has nothing to resume.
        if (!(error instanceof RpcError && NOT_FOUND.test(error.message))) throw error
        session.persisted = false
      }
    }
    // A resumed session keeps the mode dsh stored, which a change while it had no process missed.
    const commands = session.persisted
      ? [`/permission ${session.preset}`, session.plan ? '/plan' : '/plan off']
      : session.plan
        ? ['/plan']
        : []
    for (const text of commands) {
      await proc.rpc.request('session/query', {
        sessionId: session.id,
        contentBlocks: [{ type: 'text', text }],
      })
    }
  }

  /** Ends the session's process: `shutdown`, then the host's stop of its tree. */
  private async stop(session: Session, proc = session.proc): Promise<void> {
    if (!proc) return
    if (session.proc === proc) session.proc = null
    if (proc.stopping) return
    proc.stopping = true
    for (const abort of session.questions.values()) abort.abort(new Error('The session stopped'))
    session.questions.clear()
    try {
      await Promise.race([
        proc.rpc.request('shutdown'),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref()),
      ])
    } catch {
      // Gone already.
    }
    if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill()
    await proc.rpc.closed
  }

  private exited(session: Session, proc: Proc): void {
    if (proc.folder) void rm(proc.folder, { recursive: true, force: true })
    if (session.proc === proc) session.proc = null
    const turn = session.turn
    if (!turn) return
    session.turn = null
    if (session.cancelling || this.done) {
      session.cancelling = false
      turn.resolve(this.result(turn, 'cancelled'))
    } else {
      turn.reject(new AgentRequestError('closed', 'DeepSeek Harness exited mid-turn'))
    }
  }

  // What dsh sends.

  private notification(session: Session, method: string, params: unknown): void {
    switch (method) {
      case 'session.event': {
        const { sessionId, event } = params as SessionEventNotification
        this.event(session, sessionId, event)
        break
      }
      case 'session.status': {
        const { sessionId, status } = params as SessionStatusNotification
        if (this.children.has(sessionId)) {
          this.subagent(sessionId, {
            state: status === 'running' ? { kind: 'running' } : undefined,
          })
        }
        break
      }
      case 'subagent.started': {
        const { parentSessionId, childSessionId } = params as SubagentStartedNotification
        const rootId = this.rootOf(parentSessionId)
        if (!this.children.has(childSessionId)) {
          this.children.set(childSessionId, { rootId, mapper: new SessionMapper(session.cwd) })
        }
        this.deliver(parentSessionId, {
          patches: [],
          effects: [{ kind: 'subagent', sessionId: childSessionId, state: { kind: 'running' } }],
        })
        break
      }
      case 'subagent.finished': {
        const finished = params as SubagentFinishedNotification
        this.subagent(finished.childSessionId, {
          state: {
            kind: 'idle',
            stopReason: finished.stopReason,
            error:
              finished.status === 'error'
                ? { message: t('dsh.subagent.failed', { reason: finished.stopReason }) }
                : null,
            tokens: null,
          },
        })
        break
      }
      case 'user-question.cancelled': {
        const { requestId } = params as { requestId: string }
        session.questions.get(requestId)?.abort(new Error('dsh stopped waiting'))
        session.questions.delete(requestId)
        break
      }
      default:
        this.hooks.ignored(session.id, method)
    }
  }

  private subagent(
    childId: string,
    changes: { state?: SubagentState; title?: string; description?: string | null },
  ): void {
    const child = this.children.get(childId)
    if (!child) return
    const parent = this.parentOf(childId)
    this.deliver(parent, {
      patches: [],
      effects: [
        {
          kind: 'subagent',
          sessionId: childId,
          ...(changes.state ? { state: changes.state } : {}),
          ...(changes.title !== undefined ? { title: changes.title } : {}),
          ...(changes.description !== undefined ? { description: changes.description } : {}),
        },
      ],
    })
  }

  /** The session that started `childId`: its root, which every subagent's effects go to. */
  private parentOf(childId: string): string {
    return this.children.get(childId)?.rootId ?? childId
  }

  private event(session: Session, sessionId: string, event: SessionEvent): void {
    const child = this.children.get(sessionId)
    const mapper = child?.mapper ?? (sessionId === session.id ? session.mapper : null)
    if (!mapper) {
      this.hooks.ignored(sessionId, event.type)
      return
    }
    if (!child) this.rootEvent(session, event)
    if (event.type === 'subagent/catalog') {
      const data = event.data as { childId?: unknown; label?: unknown; name?: unknown }
      if (typeof data.childId === 'string') {
        // The label is the task; the name, the handle the parent addresses the subagent by.
        const label = typeof data.label === 'string' && data.label ? data.label : null
        const name = typeof data.name === 'string' && data.name ? data.name : null
        const title = label ?? name
        if (title) {
          this.subagent(data.childId, { title, description: name && name !== title ? name : null })
        }
      }
      return
    }
    const collected = this.collectors.get(sessionId)
    if (collected && event.type === 'assistant/message') {
      const text = (event.data as EventData['assistant/message']).message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      if (text) collected.push(text)
      return
    }
    const target = this.targets.get(sessionId)
    if (!target) {
      this.hold(sessionId, (ctx) => mapper.event(event, ctx))
      return
    }
    const output = mapper.event(event, target.context())
    if (output) target.apply(output)
    else if (!QUIET.has(event.type)) this.hooks.ignored(sessionId, event.type)
  }

  /** What only the session's own events change: its turn, mode and choices. */
  private rootEvent(session: Session, event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start':
        if (!session.turn) {
          session.turn = {
            resolve: (result) => this.deliver(session.id, agentTurn('ended', result)),
            reject: (error) => this.deliver(session.id, agentTurn('failed', undefined, error)),
            tokens: null,
            model: this.modelId(session),
            own: true,
          }
          this.deliver(session.id, agentTurn('started'))
        }
        break
      case 'turn/end': {
        const turn = session.turn
        if (!turn) break
        session.turn = null
        const { reason } = event.data as EventData['turn/end']
        if (reason.kind === 'error') turn.reject(turnError(reason.error))
        else turn.resolve(this.result(turn, stopReason(reason)))
        break
      }
      case 'assistant/message': {
        const data = event.data as EventData['assistant/message']
        const tokens = tokenTotals(data.usage)
        if (session.turn && tokens)
          session.turn.tokens = addTokenTotals(session.turn.tokens, tokens)
        const source = data.message.source as { model?: unknown } | undefined
        if (session.turn && typeof source?.model === 'string') session.turn.model = source.model
        break
      }
      case 'permission/preset': {
        const { preset } = event.data as EventData['permission/preset']
        if (preset !== session.preset && isMode(preset) && preset !== 'plan') {
          session.preset = preset
          this.config(session)
        }
        break
      }
      case 'plan/mode': {
        const { active } = event.data as EventData['plan/mode']
        if (active !== session.plan) {
          session.plan = active
          this.config(session)
        }
        break
      }
      case 'model/selection': {
        const data = event.data as EventData['model/selection']
        const model = choiceOf(this.models, data.provider, data.model)
        if (!model) break
        session.model = model.value
        if (data.reasoningEffort && model.efforts.includes(data.reasoningEffort))
          session.effort = data.reasoningEffort
        break
      }
    }
  }

  private config(session: Session): void {
    this.deliver(session.id, {
      patches: [{ op: 'session.update', changes: { config: this.options(session) } }],
      effects: [],
    })
  }

  /** The id of the session's model, which its usage is counted under. */
  private modelId(session: Session): string {
    return this.models.find((choice) => choice.value === session.model)?.model ?? session.model
  }

  private result(turn: Turn, reason: StopReason): PromptResult {
    return {
      stopReason: reason,
      tokens: turn.tokens,
      models: turn.tokens && turn.model ? [{ model: turn.model, tokens: turn.tokens }] : [],
    }
  }

  private deliver(sessionId: string, output: MapperOutput): void {
    const target = this.targets.get(sessionId)
    if (target) target.apply(output)
    else this.hold(sessionId, () => output)
  }

  /**
   * Keeps an event for a session no target is registered for yet, as a subagent's first ones, to
   * map once its target comes, against its thread.
   */
  private hold(sessionId: string, map: Deferred): void {
    if (this.unregistered.has(sessionId) || this.pendingCount >= PENDING_EVENTS) return
    const list = this.pending.get(sessionId) ?? []
    list.push(map)
    this.pending.set(sessionId, list)
    this.pendingCount++
  }

  // What dsh asks.

  private async serve(
    session: Session,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (method) {
      case 'approval/request':
        return { outcome: await this.approve(params as ApprovalRequestParams, signal) }
      case 'user-question/ask':
        return this.ask(session, params as QuestionRequest, signal)
      default:
        throw new RpcError(-32601, `Kettu does not answer ${method}`)
    }
  }

  private targetFor(sessionId: string): SessionTarget | null {
    return this.targets.get(sessionId) ?? null
  }

  private async approve(
    params: ApprovalRequestParams,
    signal: AbortSignal,
  ): Promise<ApprovalOutcome> {
    const target = this.targetFor(params.sessionId)
    if (!target || !params.callId) return 'cancelled'
    let answer: PermissionAnswer
    try {
      answer = await target.requestPermission(
        {
          toolCallId: params.callId,
          toolEntryId: `t:${params.callId}`,
          output: { patches: [], effects: [] },
          options: [
            { id: OPTION.allow, name: t('permission.allowOnce'), kind: 'allow_once' },
            { id: OPTION.reject, name: t('dsh.permission.reject'), kind: 'reject_once' },
          ],
        },
        signal,
      )
    } catch {
      return 'cancelled'
    }
    const picked = optionAnswer(answer)
    if (picked === 'cancelled') return 'cancelled'
    return picked.optionId === OPTION.allow ? 'allowed-once' : 'rejected'
  }

  private async ask(
    session: Session,
    request: QuestionRequest,
    signal: AbortSignal,
  ): Promise<QuestionResult> {
    const target = this.targetFor(request.sessionId)
    if (!target || request.questions.length === 0) return { cancelled: true }
    const mapper = this.children.get(request.sessionId)?.mapper ?? session.mapper
    const abort = new AbortController()
    session.questions.set(request.requestId, abort)
    const both = AbortSignal.any([signal, abort.signal])
    try {
      const review = request.questions.length === 1 ? request.questions[0]! : null
      if (review?.intent?.kind === 'plan-review') {
        const callId = review.intent.callId ?? mapper.openCall('exit_plan_mode', target.context())
        if (!callId) return { cancelled: true }
        const approve = review.intent.approve
        const answer = await target.requestPermission(
          {
            toolCallId: callId,
            toolEntryId: `t:${callId}`,
            output: { patches: [], effects: [] },
            options: [
              {
                id: OPTION.approve,
                name: t('dsh.plan.approve'),
                kind: 'allow_once',
                preferred: true,
              },
              {
                id: OPTION.keep,
                name: t('permission.exitPlan.keepPlanning'),
                kind: 'reject_once',
                note: true,
              },
            ],
            plan: review.detail ?? '',
          },
          both,
        )
        const picked = optionAnswer(answer)
        return planAnswer(review, approve, picked === 'cancelled' ? null : picked)
      }
      const callId = mapper.openCall('ask_user_question', target.context())
      if (!callId) return { cancelled: true }
      const first = request.questions[0]!
      const answer = await target.requestPermission(
        {
          toolCallId: callId,
          toolEntryId: `t:${callId}`,
          output: { patches: [], effects: [] },
          options: [
            ...(first.options ?? []).map((option, index) => ({
              id: `answer:${index}`,
              name: option.label,
              kind: 'allow_once' as const,
              ...(option.description ? { description: option.description } : {}),
            })),
            { id: OTHER_ANSWER, name: t('question.other'), kind: 'reject_once' as const },
          ],
          questions: request.questions.map((question) => ({
            header: question.header ?? '',
            question: question.question,
            multiSelect: question.multiSelect === true,
            options: (question.options ?? []).map((option) => ({
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
            })),
            allowsText: true,
            secret: false,
          })),
        },
        both,
      )
      return questionResult(request, answer)
    } catch {
      return { cancelled: true }
    } finally {
      session.questions.delete(request.requestId)
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
    if (this.done) throw new AgentRequestError('closed', 'DeepSeek Harness stopped')
  }

  private requestError(error: unknown): Error {
    if (error instanceof AgentRequestError) return error
    if (error instanceof RpcClosed)
      return new AgentRequestError('closed', 'DeepSeek Harness stopped')
    if (error instanceof RpcError)
      return new AgentRequestError('agent_error', error.message, error.code)
    return new AgentRequestError('agent_error', (error as Error)?.message ?? String(error))
  }
}

/** Events the mapper takes no part of and nobody needs to hear about. */
const QUIET = new Set([
  'system/message',
  'user/message',
  'developer/message',
  'request/header',
  'step/start',
  'step/end',
  'turn/end',
  'agent/inbox/spliced',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'approval/asked',
  'approval/decided',
  'plan/mode',
  'model/selection',
  'session/title',
  'command/run',
  'command/done',
  'assistant/attempt',
  'llm/retry-started',
  'subagent/descriptor',
  'working-directory/change',
  'session-log-deepseek/delivery-accepted',
  'compaction/summary',
])

function agentTurn(
  phase: 'started' | 'ended' | 'failed',
  result?: PromptResult,
  error?: unknown,
): MapperOutput {
  if (phase === 'started')
    return { patches: [], effects: [{ kind: 'agentTurn', phase: 'started' }] }
  if (phase === 'ended')
    return { patches: [], effects: [{ kind: 'agentTurn', phase: 'ended', result: result! }] }
  return { patches: [], effects: [{ kind: 'agentTurn', phase: 'failed', error }] }
}
