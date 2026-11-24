// Pi through its RPC mode: one `pi --mode rpc` process per open session, the user's own pi, spoken
// to over JSON lines on its stdio. A process holds one session, so a session that is closed loses
// its process and the next use starts another on the session's file; a fork starts one from a copy
// pi makes. Pi asks no permission for its tools: only its extensions' dialogs wait for the user.

import type { ChildProcess } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { ConfigOption, StopReason, TokenTotals, ToolEntry } from '@shared/thread'
import {
  AgentRequestError,
  type AgentConnection,
  type AgentInit,
  type ConnectionHooks,
  type ForkPoint,
  type ListedSession,
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
import { t } from '../i18n'
import { addTokenTotals, type MapperContext, type MapperOutput } from '../session-updates'
import { compareVersions } from '../versions'
import {
  autoCompactWord,
  commandList,
  parseCommand,
  queueMode,
  statsMessage,
  type ParsedCommand,
} from './commands'
import { dialogOf } from './dialogs'
import {
  EXTENSION_SINCE,
  piExtension,
  piServers,
  SCOPE_STATUS,
  SCOPE_VARIABLE,
  SERVERS_VARIABLE,
} from './extension'
import {
  activeBranch,
  blockText,
  forkEntry,
  SessionMapper,
  tokenTotals,
  toolPath,
  writesFile,
} from './mapper'
import {
  CONFIG,
  configOptions,
  hasModel,
  modelProviders,
  parseModelValue,
  parseScope,
} from './options'
import type {
  PiCommandInfo,
  PiDisposition,
  PiEntry,
  PiEvent,
  PiImage,
  PiMessage,
  PiModel,
  PiState,
  PiStats,
  PiUiRequest,
} from './protocol'
import { PiClosed, PiCommandError, PiRpc } from './rpc'
import {
  findSessionFile,
  listSessionFiles,
  piFolders,
  removeSessionFile,
  type PiFolders,
} from './session-files'

const START_TIMEOUT_MS = 60_000
const STATS_TIMEOUT_MS = 2_000
const ABORT_TIMEOUT_MS = 15_000
const PENDING_EVENTS = 2_000
const STDERR_TAIL = 2_000
const PAGE_SIZE = 50
const CHANGELOG_CHARS = 20_000
/** A file larger than this is not read to show what a `write` replaced. */
const BEFORE_BYTES = 1024 * 1024
const RESOURCE_NOT_FOUND = -32002
const SIGN_IN_METHOD = 'pi_terminal_login'
/** The first pi with `clear_queue`, without which a queued message cannot be taken back. */
const STEERING_SINCE = '0.84.4'
/** Pi's words when its model has no credentials, which a sign-in settles. */
const NEEDS_SIGN_IN = /api key|not configured|unauthorized|authentication|\/login/i

interface Turn {
  resolve(result: PromptResult): void
  reject(error: Error): void
  tokens: TokenTotals | null
  models: Map<string, TokenTotals>
  /** The error its latest reply ended with, which a retry that answers clears. */
  error: string | null
  /** Its latest reply ended as stopped or as cut at the output limit. */
  stop: 'aborted' | 'length' | null
  /** Pi started a run for it. */
  started: boolean
  /** Started by pi itself between Kettu's turns, such as for a message left in its queue. */
  own: boolean
}

interface Proc {
  child: ChildProcess
  rpc: PiRpc
  /** Stops the process as a stop of the agent does: EOF, then its whole tree. */
  stop: AbortController
  ready: Promise<void>
  stopping: boolean
  /** The end of what it wrote to stderr, which says why a start failed. */
  stderr: string
}

/** The text a file held before a `write` call: null for a new file, undefined when unknown. */
type Before = string | null | undefined

interface Session {
  id: string
  cwd: string
  options: SessionOptions
  mapper: SessionMapper
  proc: Proc | null
  /** Its file in pi's sessions folder; null while pi has written none, or for one never saved. */
  file: string | null
  /** Opened for Kettu's own use: nothing of it is saved or shown. */
  hidden: boolean
  model: PiModel | null
  level: string
  models: PiModel[]
  levels: string[]
  scope: ReadonlySet<string> | null
  turn: Turn | null
  /** The user stopped the turn. */
  cancelling: boolean
  /** One of Kettu's own commands for pi runs, which a stop ends as it does a turn. */
  busy: boolean
  /** Messages in pi's queue, which a settled run leaves there. */
  queued: number
  /** Messages a stop took out of pi's queue, which go with the next prompt. */
  undelivered: string[]
  /** Dialogs waiting for the user, by pi's id for the request. */
  dialogs: Map<string, AbortController>
  /** What the files of `write` calls held, by call. */
  befores: Map<string, { file: string; text: Promise<Before> }>
  /** The session's events are handled one after another. */
  events: Promise<void>
  /** The text of each reply, for a session Kettu prompts for itself. */
  collected: string[] | null
}

type Deferred = (ctx: MapperContext) => MapperOutput | null

type Start =
  { kind: 'new' } | { kind: 'resume'; file: string | null } | { kind: 'fork'; file: string }

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

function fileOf(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  try {
    return decodeURIComponent(new URL(uri).pathname)
  } catch {
    return null
  }
}

/** `[@name](uri)`, the form a replay reads back as an attachment. */
function fileLink(name: string | null, uri: string): string {
  const shown = name ?? fileOf(uri)?.split('/').pop() ?? null
  return shown ? `[@${shown}](${uri})` : uri
}

/** Kettu's prompt as pi's: one text with the files it names, and its images beside it. */
export function promptMessage(blocks: readonly PromptBlock[]): {
  message: string
  images: PiImage[]
} {
  let message = ''
  const images: PiImage[] = []
  const line = (text: string): void => {
    if (message !== '' && !message.endsWith('\n')) message += '\n'
    message += `${text}\n`
  }
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        message += block.text
        break
      case 'image':
        images.push({ type: 'image', data: block.data, mimeType: block.mimeType })
        break
      case 'resource_link':
        line(fileLink(block.name, block.uri))
        break
      case 'resource': {
        const { uri, text } = block.resource
        line(`${fileLink(null, uri)}\n<context ref="${uri}">\n${text}\n</context>`)
        break
      }
    }
  }
  return { message: message.replace(/\n+$/, ''), images }
}

/** A failure of pi's as Kettu's error: a sign-in its model needs, or what pi said. */
export function commandError(error: unknown, name = 'Pi'): Error {
  if (error instanceof AgentRequestError) return error
  if (error instanceof PiClosed) return new AgentRequestError('closed', `${name} stopped`)
  const message = error instanceof Error ? error.message : String(error)
  if (
    error instanceof PiCommandError &&
    error.command === 'prompt' &&
    NEEDS_SIGN_IN.test(message)
  ) {
    return new AgentRequestError('auth_required', message)
  }
  return new AgentRequestError('agent_error', message)
}

/** The status a provider's error names, as pi writes it before the provider's own words. */
export function turnError(message: string): Error {
  const status = /^(\d{3})\b/.exec(message.trim())?.[1]
  return new AgentRequestError('agent_error', message, null, {
    ...(status ? { status: Number(status) } : {}),
  })
}

export class PiConnection implements AgentConnection {
  readonly closed: Promise<void>
  private resolveClosed!: () => void
  private done = false
  private readonly cli: string
  private readonly version: string | null
  /** Kettu's extension, once `initialize` wrote it for a pi that takes MCP servers from one. */
  private extension: string | null = null
  private readonly platform: Platform
  private folders: Promise<PiFolders> | null = null
  private readonly sessions = new Map<string, Session>()
  /** Each session's file once pi named it, kept after the session closed. */
  private readonly files = new Map<string, string>()
  /** The folder pi keeps each working directory's sessions in, once one named it. */
  private readonly sessionDirs = new Map<string, string>()
  private readonly targets = new Map<string, SessionTarget>()
  private readonly pending = new Map<string, Deferred[]>()
  private readonly unregistered = new Set<string>()
  private pendingCount = 0

  constructor(private readonly context: HostedContext) {
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve))
    const { spec } = context
    this.cli = spec.cli ?? spec.command
    this.version = context.cliVersion ?? null
    this.platform = process.platform as Platform
  }

  get isClosed(): boolean {
    return this.done
  }

  /** A session Kettu opens for itself is never saved, so nothing of it stays in pi's history. */
  get hiddenSessions(): boolean {
    return true
  }

  get unpromptedSessions(): boolean {
    return true
  }

  private get hooks(): ConnectionHooks {
    return this.context.hooks
  }

  /** Whether the user's pi is `version` or later; false when it printed no version. */
  private since(version: string): boolean {
    return this.version !== null && compareVersions(this.version, version) >= 0
  }

  close(): void {
    if (this.done) return
    this.done = true
    for (const session of this.sessions.values()) {
      const turn = session.turn
      session.turn = null
      turn?.reject(new AgentRequestError('closed', 'Pi stopped'))
      this.endDialogs(session)
      void this.stop(session)
    }
    this.resolveClosed()
  }

  async initialize(): Promise<AgentInit> {
    const dir = this.context.kettuDir
    if (dir && this.since(EXTENSION_SINCE)) {
      try {
        this.extension = await piExtension(dir)
      } catch (error) {
        // Unwritten, pi runs by itself, only without Kettu's tools.
        this.hooks.log('warn', `Could not write Kettu's extension: ${(error as Error).message}`)
      }
    }
    const tools = this.extension !== null
    return {
      name: 'Pi',
      version: this.version,
      capabilities: {
        loadSession: true,
        listSessions: true,
        resumeSession: true,
        closeSession: true,
        deleteSession: true,
        forkSession: true,
        forkAtMessage: true,
        ownTitles: null,
        logout: false,
        steering: this.since(STEERING_SINCE),
        // Pi takes MCP servers through Kettu's extension, which registers them with its own MCP.
        mcpHttp: tools,
        mcpSse: false,
        mcpStdio: tools,
        prompt: { image: true, audio: false, embeddedContext: true },
      },
      // Pi signs in to its model providers in its own terminal UI, with `/login`.
      authMethods: [
        {
          id: SIGN_IN_METHOD,
          name: t('pi.auth.terminal'),
          description: t('pi.auth.terminalDescription'),
          type: 'terminal',
          command: this.cli,
          args: [],
          env: {},
        },
      ],
      raw: { version: this.version, extension: tools },
    }
  }

  authenticate(methodId: string): Promise<void> {
    return Promise.reject(
      new AgentRequestError('agent_error', `${methodId} signs in in a terminal`, -32602),
    )
  }

  logout(): Promise<void> {
    return Promise.reject(new AgentRequestError('agent_error', 'Pi has no sign-out of its own'))
  }

  // Sessions.

  private blank(cwd: string, options: SessionOptions): Session {
    return {
      id: '',
      cwd,
      options,
      mapper: new SessionMapper(cwd),
      proc: null,
      file: null,
      hidden: options.hidden !== undefined,
      model: null,
      level: 'off',
      models: [],
      levels: [],
      scope: null,
      turn: null,
      cancelling: false,
      busy: false,
      queued: 0,
      undelivered: [],
      dialogs: new Map(),
      befores: new Map(),
      events: Promise.resolve(),
      collected: null,
    }
  }

  /** Starts a session's process and takes the session in, once pi named it and has a model. */
  private async open(session: Session, start: Start): Promise<void> {
    const proc = await this.launch(session, start)
    session.proc = proc
    try {
      await proc.ready
      if (session.models.length === 0 && !hasModel(session.model)) {
        throw new AgentRequestError('auth_required', t('pi.auth.required'))
      }
    } catch (error) {
      if (session.proc === proc) session.proc = null
      const failure = this.startError(error, proc)
      void this.stop(session, proc)
      throw failure
    }
    this.sessions.set(session.id, session)
    if (!session.hidden) this.announceCommands(session, proc)
  }

  async newSession(cwd: string, options: SessionOptions = {}): Promise<OpenedSession> {
    this.assertOpen()
    const session = this.blank(cwd, options)
    await this.open(session, { kind: 'new' })
    return { sessionId: session.id, config: this.config(session), ...this.harness() }
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    this.assertOpen()
    const session = await this.attachSession(sessionId, cwd, options)
    return { config: this.config(session), ...this.harness() }
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    this.assertOpen()
    const session = await this.attachSession(sessionId, cwd, options)
    const proc = session.proc!
    let history: { entries: PiEntry[]; leafId: string | null }
    try {
      history = await proc.rpc.request({ type: 'get_entries' })
    } catch (error) {
      throw commandError(error)
    }
    for (const entry of activeBranch(history.entries ?? [], history.leafId ?? null)) {
      this.deliver(sessionId, (ctx) => session.mapper.entry(entry, ctx))
    }
    await this.readStats(session, proc)
    return { config: this.config(session), ...this.harness() }
  }

  /** The session with a process of its own on its file, started anew with `options`. */
  private async attachSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions,
  ): Promise<Session> {
    const existing = this.sessions.get(sessionId)
    if (existing?.turn) {
      throw new AgentRequestError('agent_error', t('agentRun.turnRunning'))
    }
    if (existing) {
      // Its servers and their tokens are the process's, so it starts again with the new ones.
      this.sessions.delete(sessionId)
      await this.stop(existing)
    }
    const file = await this.fileOf(sessionId, cwd)
    const session = this.blank(cwd, options)
    session.id = sessionId
    session.undelivered = existing?.undelivered ?? []
    await this.open(session, { kind: 'resume', file })
    return session
  }

  async forkSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
    point?: ForkPoint,
  ): Promise<OpenedSession> {
    this.assertOpen()
    const source = await this.fileOf(sessionId, this.sessions.get(sessionId)?.cwd ?? cwd)
    const session = this.blank(cwd, options)
    // A session pi wrote no file for holds nothing, so its fork is a new session.
    await this.open(session, source ? { kind: 'fork', file: source } : { kind: 'new' })
    if (point && source) {
      try {
        await this.cutAt(session, point)
      } catch (error) {
        await this.discard(session)
        throw commandError(error)
      }
    }
    return { sessionId: session.id, config: this.config(session), ...this.harness() }
  }

  /**
   * Cuts a fresh fork to the reply `point` names: pi forks from a user message, keeping what came
   * before it, into a session of its own, so the whole copy the fork started as goes.
   */
  private async cutAt(session: Session, point: ForkPoint): Promise<void> {
    const proc = session.proc!
    const history = await proc.rpc.request<{ entries: PiEntry[]; leafId: string | null }>({
      type: 'get_entries',
    })
    const cut = forkEntry(activeBranch(history.entries ?? [], history.leafId ?? null), point)
    if (!cut.found) throw new AgentRequestError('agent_error', t('pi.fork.noReply'))
    if (cut.entryId === null) return
    const copy = { id: session.id, file: session.file }
    const forked = await proc.rpc.request<{ cancelled?: boolean }>({
      type: 'fork',
      entryId: cut.entryId,
    })
    if (forked?.cancelled) throw new AgentRequestError('agent_error', t('pi.fork.cancelled'))
    const state = await proc.rpc.request<PiState>({ type: 'get_state' })
    this.sessions.delete(copy.id)
    this.files.delete(copy.id)
    this.named(session, state)
    this.sessions.set(session.id, session)
    if (copy.file && copy.file !== session.file) {
      await removeSessionFile(copy.file).catch(() => {})
    }
  }

  /** Ends a session that never reached its caller, with the file pi wrote for it. */
  private async discard(session: Session): Promise<void> {
    this.sessions.delete(session.id)
    await this.stop(session)
    const file = session.file
    this.files.delete(session.id)
    if (file) await removeSessionFile(file).catch(() => {})
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    const turn = session.turn
    session.turn = null
    turn?.resolve(this.result(turn, 'cancelled'))
    this.endDialogs(session)
    await this.stop(session)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    await this.closeSession(sessionId)
    const file = session?.file ?? (await this.fileOf(sessionId, session?.cwd ?? null))
    this.files.delete(sessionId)
    if (!file) return
    try {
      await removeSessionFile(file)
    } catch (error) {
      throw new AgentRequestError('agent_error', (error as Error).message)
    }
  }

  async removeHidden(sessionId: string, log: (message: string) => void): Promise<void> {
    const session = this.sessions.get(sessionId)
    this.unregistered.add(sessionId)
    this.dropPending(sessionId)
    try {
      // Only a fork has a file: a session opened for Kettu itself is never saved.
      if (session?.file || this.files.has(sessionId)) await this.deleteSession(sessionId)
      else await this.closeSession(sessionId)
    } catch (error) {
      if (!this.done) log((error as Error).message)
    }
  }

  async listSessions(
    cwd: string,
    cursor: string | null,
  ): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    const real = await realpath(cwd).catch(() => cwd)
    const all = await listSessionFiles(await this.piFolders(), real, this.dirOf(cwd, real))
    const offset = cursor ? Number.parseInt(cursor, 10) : 0
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0
    return {
      sessions: all.slice(start, start + PAGE_SIZE),
      nextCursor: start + PAGE_SIZE < all.length ? String(start + PAGE_SIZE) : null,
    }
  }

  private piFolders(): Promise<PiFolders> {
    this.folders ??= piFolders({ ...this.context.env, ...this.context.spec.env }, this.platform)
    return this.folders
  }

  /** A session's file: the one pi named while it ran, else the one found for its id. */
  private async fileOf(sessionId: string, cwd: string | null): Promise<string | null> {
    const known = this.sessions.get(sessionId)?.file ?? this.files.get(sessionId)
    if (known && (await isFile(known))) return known
    const real = cwd === null ? null : await realpath(cwd).catch(() => cwd)
    const dir = cwd === null || real === null ? null : this.dirOf(cwd, real)
    const file = await findSessionFile(await this.piFolders(), real, sessionId, dir)
    if (file) this.files.set(sessionId, file)
    return file
  }

  /** The folder pi named for the sessions of a working directory, under either of its paths. */
  private dirOf(cwd: string, real: string): string | null {
    return this.sessionDirs.get(real) ?? this.sessionDirs.get(cwd) ?? null
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

  // The process.

  private async launch(session: Session, start: Start): Promise<Proc> {
    const { spec, env } = this.context
    const command = (await this.context.currentCli?.(this.cli)) ?? this.cli
    const args = [...spec.args, '--no-themes']
    const extra: Record<string, string> = {}
    if (this.extension) {
      args.push('-e', this.extension)
      extra[SCOPE_VARIABLE] = '1'
      const servers = piServers(session.options.mcpServers ?? [])
      if (servers.length > 0) extra[SERVERS_VARIABLE] = JSON.stringify(servers)
    }
    for (const root of session.options.skillRoots ?? []) args.push('--skill', root)
    if (session.hidden && start.kind !== 'fork') args.push('--no-session')
    else if (start.kind === 'fork') args.push('--fork', start.file)
    else if (start.kind === 'resume') {
      // Without a file pi was never prompted in it, and takes the id for a session it starts.
      args.push(...(start.file ? ['--session', start.file] : ['--session-id', session.id]))
    }
    const stop = new AbortController()
    const child = this.context.spawn({
      command,
      args,
      cwd: session.cwd,
      env: { ...env, ...spec.env, ...extra },
      signal: stop.signal,
    })
    const proc: Proc = {
      child,
      rpc: null as unknown as PiRpc,
      stop,
      ready: Promise.resolve(),
      stopping: false,
      stderr: '',
    }
    child.stderr?.on('data', (chunk: Buffer | string) => {
      proc.stderr = `${proc.stderr}${String(chunk)}`.slice(-STDERR_TAIL)
    })
    proc.rpc = new PiRpc(child.stdin!, child.stdout!, {
      event: (event) => this.enqueue(session, proc, event),
      traffic: (direction, message) => this.hooks.traffic(direction, message),
      garbage: (line) =>
        this.hooks.log('warn', `Pi wrote a line that is no record: ${line.slice(0, 200)}`),
    })
    void proc.rpc.closed.then(() => this.exited(session, proc))
    proc.ready = this.handshake(session, proc, start)
    // A start that failed is reported by the caller that awaits it.
    proc.ready.catch(() => {})
    return proc
  }

  private async handshake(session: Session, proc: Proc, start: Start): Promise<void> {
    const state = await proc.rpc.request<PiState>({ type: 'get_state' }, START_TIMEOUT_MS)
    if (start.kind === 'resume' && state.sessionId !== session.id) {
      // Pi opened a file as a session of another id, so this is not the session asked for.
      throw new AgentRequestError(
        'agent_error',
        t('pi.session.notFound', { id: session.id }),
        RESOURCE_NOT_FOUND,
      )
    }
    this.named(session, state)
    const [models, levels] = await Promise.all([
      proc.rpc.request<{ models?: PiModel[] }>({ type: 'get_available_models' }),
      proc.rpc
        .request<{ levels?: string[] }>({ type: 'get_available_thinking_levels' })
        .catch(() => ({ levels: [] as string[] })),
    ])
    session.models = Array.isArray(models?.models) ? models.models : []
    session.levels = Array.isArray(levels?.levels) ? levels.levels : []
    this.hooks.modelProviders?.(modelProviders(session.models))
    this.took(session, state)
  }

  /** Takes the id and file pi named the session, which a fork changes. */
  private named(session: Session, state: PiState): void {
    session.id = state.sessionId
    session.file = state.sessionFile ?? null
    if (session.file && !session.hidden) {
      this.files.set(session.id, session.file)
      this.sessionDirs.set(session.cwd, path.dirname(session.file))
    }
  }

  private took(session: Session, state: PiState): void {
    session.model = hasModel(state.model) ? state.model : null
    session.level = state.thinkingLevel
    session.mapper.setContextWindow(session.model?.contextWindow)
  }

  private harness(): { harnessVersion?: string } {
    return this.version ? { harnessVersion: this.version } : {}
  }

  private config(session: Session): ConfigOption[] {
    return configOptions(session)
  }

  private pushConfig(session: Session): void {
    if (session.hidden) return
    const config = this.config(session)
    this.deliver(session.id, () => ({
      patches: [{ op: 'session.update', changes: { config } }],
      effects: [],
    }))
  }

  /** The commands the session offers, once pi listed its own. */
  private announceCommands(session: Session, proc: Proc): void {
    void proc.rpc
      .request<{ commands?: PiCommandInfo[] }>({ type: 'get_commands' })
      .then((data) => (Array.isArray(data?.commands) ? data.commands : []))
      .catch(() => [] as PiCommandInfo[])
      .then((listed) => {
        if (session.proc !== proc) return
        const commands = commandList(listed)
        this.deliver(session.id, () => ({
          patches: [{ op: 'session.update', changes: { commands } }],
          effects: [],
        }))
      })
  }

  /** The session's process once it answered, starting one on the session's file if it has none. */
  private async ready(session: Session): Promise<Proc> {
    this.assertOpen()
    if (session.proc && !session.proc.stopping) {
      await session.proc.ready
      return session.proc
    }
    const file = session.hidden ? null : await this.fileOf(session.id, session.cwd)
    const proc = await this.launch(session, { kind: 'resume', file })
    session.proc = proc
    try {
      await proc.ready
    } catch (error) {
      if (session.proc === proc) session.proc = null
      const failure = this.startError(error, proc)
      void this.stop(session, proc)
      throw failure
    }
    return proc
  }

  /** Why a start failed, with what pi wrote about it when it went without answering. */
  private startError(error: unknown, proc: Proc): Error {
    if (error instanceof AgentRequestError) return error
    if (error instanceof PiClosed) {
      const said = proc.stderr.trim().split('\n').pop()?.trim()
      return new AgentRequestError(
        'agent_error',
        said ? t('pi.start.failedWith', { reason: said }) : t('pi.start.failed'),
        /no session found/i.test(proc.stderr) ? RESOURCE_NOT_FOUND : null,
      )
    }
    return commandError(error)
  }

  /** Ends a session's process: a stop of its run, EOF, then the host's stop of its tree. */
  private async stop(session: Session, proc = session.proc): Promise<void> {
    if (!proc) return
    if (session.proc === proc) session.proc = null
    if (proc.stopping) return
    proc.stopping = true
    proc.rpc.end()
    proc.stop.abort()
    await proc.rpc.closed
  }

  private exited(session: Session, proc: Proc): void {
    if (session.proc === proc) session.proc = null
    session.befores.clear()
    this.endDialogs(session)
    const turn = session.turn
    if (!turn) return
    session.turn = null
    if (session.cancelling || this.done || proc.stopping) {
      session.cancelling = false
      turn.resolve(this.result(turn, 'cancelled'))
    } else {
      turn.reject(new AgentRequestError('closed', 'Pi exited mid-turn'))
    }
  }

  // Turns.

  private newTurn(
    session: Session,
    own: boolean,
    resolve: Turn['resolve'],
    reject: Turn['reject'],
  ): Turn {
    const turn: Turn = {
      resolve,
      reject,
      tokens: null,
      models: new Map(),
      error: null,
      stop: null,
      started: false,
      own,
    }
    session.turn = turn
    return turn
  }

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    const session = this.requireSession(sessionId)
    if (session.turn) throw new AgentRequestError('agent_error', t('agentRun.turnRunning'))
    const proc = await this.ready(session)
    const { message, images } = promptMessage(prompt)
    const command = images.length === 0 ? parseCommand(message) : null
    if (command) return this.runCommand(session, proc, command)
    return this.run(session, proc, message, images)
  }

  private async run(
    session: Session,
    proc: Proc,
    text: string,
    images: readonly PiImage[],
  ): Promise<PromptResult> {
    session.cancelling = false
    const message = [...session.undelivered, text].join('\n\n')
    session.undelivered = []
    const done = new Promise<PromptResult>((resolve, reject) => {
      this.newTurn(session, false, resolve, reject)
    })
    const turn = session.turn!
    try {
      const answer = await proc.rpc.request<{ disposition?: PiDisposition } | undefined>({
        type: 'prompt',
        message,
        ...(images.length > 0 ? { images } : {}),
      })
      await session.events
      if (
        session.turn === turn &&
        !(await this.started(session, proc, turn, answer?.disposition))
      ) {
        // An extension's command took the prompt, so no run comes to settle it.
        session.turn = null
        turn.resolve(this.result(turn, 'end_turn'))
      }
    } catch (error) {
      if (session.turn === turn) session.turn = null
      throw commandError(error)
    }
    return done
  }

  /** Whether pi started a run for a prompt it accepted; before 0.99 only its state says. */
  private async started(
    session: Session,
    proc: Proc,
    turn: Turn,
    disposition: PiDisposition | undefined,
  ): Promise<boolean> {
    if (disposition !== undefined) return disposition !== 'handled'
    if (turn.started) return true
    const state = await proc.rpc.request<PiState>({ type: 'get_state' }).catch(() => null)
    await session.events
    return turn.started || session.turn !== turn || state?.isStreaming === true
  }

  async collect(sessionId: string, text: string): Promise<string[]> {
    const session = this.requireSession(sessionId)
    if (session.turn) throw new AgentRequestError('agent_error', t('agentRun.turnRunning'))
    const proc = await this.ready(session)
    const texts: string[] = []
    session.collected = texts
    try {
      await this.run(session, proc, text, [])
    } finally {
      session.collected = null
    }
    return texts
  }

  async steer(
    sessionId: string,
    prompt: readonly PromptBlock[],
  ): Promise<'injected' | 'promptRequired'> {
    const session = this.sessions.get(sessionId)
    const proc = session?.proc
    if (!session?.turn || !proc || proc.stopping || session.cancelling) return 'promptRequired'
    if (!this.since(STEERING_SINCE)) return 'promptRequired'
    const { message, images } = promptMessage(prompt)
    try {
      await proc.rpc.request({
        type: 'steer',
        message,
        ...(images.length > 0 ? { images } : {}),
      })
    } catch (error) {
      if (error instanceof PiCommandError) return 'promptRequired'
      throw commandError(error)
    }
    session.queued++
    // The run may have settled while the message was on its way, and pi starts none for it.
    await session.events
    if (!session.turn && session.proc === proc) void this.flushQueue(session, proc)
    return 'injected'
  }

  async injectHistory(): Promise<boolean> {
    return false
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    const proc = session?.proc
    if (!session || !proc || (!session.turn && !session.busy)) return
    session.cancelling = true
    this.endDialogs(session)
    try {
      // Pi runs what is left in its queue after a stop, so the queue is emptied first.
      if (session.turn && this.since(STEERING_SINCE)) {
        const left = await proc.rpc
          .request<{ steering?: string[]; followUp?: string[] }>({ type: 'clear_queue' })
          .catch(() => null)
        session.undelivered.push(...(left?.steering ?? []), ...(left?.followUp ?? []))
        session.queued = 0
      }
      await proc.rpc.request({ type: 'abort' }, ABORT_TIMEOUT_MS)
    } catch (error) {
      if (error instanceof PiClosed) return
      // A run that does not stop ends with its process; the next prompt starts another.
      this.hooks.log('warn', `Pi did not stop its run: ${(error as Error).message}`)
      await this.stop(session, proc)
    }
  }

  async setMode(): Promise<void> {
    throw new AgentRequestError('agent_error', 'Pi has no modes')
  }

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const session = this.requireSession(sessionId)
    if (typeof value !== 'string' || value === '') {
      throw new AgentRequestError('agent_error', t('agentRun.takesChoice', { option: optionId }))
    }
    const proc = await this.ready(session)
    try {
      if (optionId === CONFIG.model) {
        const model = parseModelValue(value)
        if (!model) throw new AgentRequestError('agent_error', t('agentRun.noModel', { value }))
        await proc.rpc.request({ type: 'set_model', ...model })
      } else if (optionId === CONFIG.level) {
        await proc.rpc.request({ type: 'set_thinking_level', level: value })
      } else {
        throw new AgentRequestError('agent_error', t('agentRun.noOption', { option: optionId }))
      }
      await this.refresh(session, proc)
    } catch (error) {
      throw commandError(error)
    }
    if (optionId === CONFIG.model && !session.hidden) void this.readStats(session, proc)
    return this.config(session)
  }

  /** Reads the model, the level pi settled on and the levels the model takes. */
  private async refresh(session: Session, proc: Proc): Promise<void> {
    const [state, levels] = await Promise.all([
      proc.rpc.request<PiState>({ type: 'get_state' }),
      proc.rpc
        .request<{ levels?: string[] }>({ type: 'get_available_thinking_levels' })
        .catch(() => null),
    ])
    if (levels && Array.isArray(levels.levels)) session.levels = levels.levels
    this.took(session, state)
  }

  /** Pi's own count of what the context holds, which a turn's end and a new model change. */
  private async readStats(session: Session, proc: Proc): Promise<void> {
    if (session.hidden) return
    try {
      const stats = await proc.rpc.request<PiStats>({ type: 'get_session_stats' }, STATS_TIMEOUT_MS)
      this.deliver(session.id, (ctx) => session.mapper.stats(stats ?? {}, ctx))
    } catch {
      // The usage stays as the replies' own counts left it.
    }
  }

  // What pi sends.

  private enqueue(session: Session, proc: Proc, event: PiEvent): void {
    session.events = session.events
      .then(() => this.handle(session, proc, event))
      .catch((error: unknown) => {
        this.hooks.log('warn', `Could not take pi's ${event.type}: ${(error as Error).message}`)
      })
  }

  private async handle(session: Session, proc: Proc, event: PiEvent): Promise<void> {
    let before: Before
    switch (event.type) {
      case 'agent_start':
        this.runStarted(session)
        return
      case 'agent_settled':
        await this.settled(session, proc, event.aborted === true)
        return
      case 'agent_end':
      case 'turn_start':
      case 'turn_end':
        return
      case 'queue_update':
        session.queued = (event.steering?.length ?? 0) + (event.followUp?.length ?? 0)
        return
      case 'thinking_level_changed':
        if (event.level !== session.level) {
          session.level = event.level
          this.pushConfig(session)
        }
        return
      case 'extension_ui_request':
        if (this.uiRequest(session, proc, event)) return
        break
      case 'message_update': {
        const call = event.assistantMessageEvent.toolCall
        if (event.assistantMessageEvent.type === 'toolcall_end' && call) {
          this.noteBefore(session, call.id, call.name, call.arguments)
        }
        break
      }
      case 'message_end':
        if (this.replied(session, event.message)) return
        break
      case 'tool_execution_start':
        before = await session.befores.get(event.toolCallId)?.text
        break
      case 'tool_execution_end': {
        const noted = session.befores.get(event.toolCallId)
        before = await noted?.text
        session.befores.delete(event.toolCallId)
        this.fileChanged(session, event.toolCallId, event.toolName)
        break
      }
    }
    if (session.hidden) return
    const shown = this.deliver(session.id, (ctx) => session.mapper.event(event, ctx, before))
    if (shown === false && !QUIET.has(event.type)) this.hooks.ignored(session.id, event.type)
  }

  private runStarted(session: Session): void {
    if (session.turn) {
      session.turn.started = true
      return
    }
    // A run pi starts by itself, as for a message an extension sent, is a turn of its own.
    const turn = this.newTurn(
      session,
      true,
      (result) => this.deliver(session.id, () => agentTurn('ended', result)),
      (error) => this.deliver(session.id, () => agentTurn('failed', undefined, error)),
    )
    turn.started = true
    session.cancelling = false
    this.deliver(session.id, () => agentTurn('started'))
  }

  /** What a reply adds to its turn; true for a session whose replies are only collected. */
  private replied(session: Session, message: PiMessage): boolean {
    if (message.role !== 'assistant') return session.collected !== null
    const turn = session.turn
    if (turn) {
      const tokens = tokenTotals(message.usage)
      if (tokens) {
        turn.tokens = addTokenTotals(turn.tokens, tokens)
        const model =
          message.provider && message.model ? `${message.provider}/${message.model}` : null
        if (model) turn.models.set(model, addTokenTotals(turn.models.get(model) ?? null, tokens))
      }
      turn.error = message.stopReason === 'error' ? (message.errorMessage ?? '') : null
      turn.stop =
        message.stopReason === 'aborted' || message.stopReason === 'length'
          ? message.stopReason
          : null
    }
    if (session.collected === null) return false
    const text = blockText(message.content).trim()
    if (text) session.collected.push(text)
    return true
  }

  private async settled(session: Session, proc: Proc, aborted: boolean): Promise<void> {
    this.endDialogs(session)
    const turn = session.turn
    if (!turn) return
    await this.readStats(session, proc)
    if (session.turn !== turn) return
    session.turn = null
    const cancelled = aborted || session.cancelling || turn.stop === 'aborted'
    session.cancelling = false
    if (cancelled) turn.resolve(this.result(turn, 'cancelled'))
    else if (turn.error !== null) turn.reject(turnError(turn.error || t('notice.turnFailed')))
    else turn.resolve(this.result(turn, turn.stop === 'length' ? 'max_tokens' : 'end_turn'))
    if (!cancelled && session.queued > 0 && session.proc === proc) {
      void this.flushQueue(session, proc)
    }
  }

  /**
   * Sends what a settled run left in pi's queue as a prompt of its own, since pi starts no run for
   * it: a message that arrived as the run ended would otherwise wait for the user's next one.
   */
  private async flushQueue(session: Session, proc: Proc): Promise<void> {
    session.queued = 0
    const left = await proc.rpc
      .request<{ steering?: string[]; followUp?: string[] }>({ type: 'clear_queue' })
      .catch(() => null)
    const texts = [...(left?.steering ?? []), ...(left?.followUp ?? [])]
    if (texts.length === 0 || session.turn || session.proc !== proc || session.cancelling) {
      session.undelivered.push(...texts)
      return
    }
    try {
      // Pi's `agent_start` opens the turn, as for any run it starts by itself.
      await proc.rpc.request({ type: 'prompt', message: texts.join('\n\n') })
    } catch (error) {
      session.undelivered.push(...texts)
      this.hooks.log('warn', `Pi did not take a queued message: ${(error as Error).message}`)
    }
  }

  private result(turn: Turn, reason: StopReason): PromptResult {
    const models: ModelTokens[] = [...turn.models].map(([model, tokens]) => ({ model, tokens }))
    return { stopReason: reason, tokens: turn.tokens, models }
  }

  // Files a `write` replaces.

  /**
   * Reads what the file of a `write` call holds once the reply named the call, while the reply
   * still streams: pi runs the call only after the reply ended, and a read at the call's start
   * would find what the call wrote.
   */
  private noteBefore(session: Session, callId: string, name: string, args: unknown): void {
    if (session.hidden || name !== 'write' || session.befores.has(callId)) return
    const file = toolPath(args, session.cwd)
    if (!file) return
    // Another call still to run on the file changes it first, so what it holds now is not it.
    const stale = [...session.befores.values()].some((noted) => noted.file === file)
    session.befores.set(callId, {
      file,
      text: stale ? Promise.resolve(undefined) : readBefore(file),
    })
  }

  /**
   * A call that changed a file makes what was read of it for later calls out of date: after a
   * `write` the file holds what that call wrote, after any other change nobody knows.
   */
  private fileChanged(session: Session, callId: string, name: string): void {
    if (!writesFile(name)) return
    const args = session.mapper.call(callId)?.args
    const file = toolPath(args, session.cwd)
    const content = (args as { content?: unknown } | undefined)?.content
    const text: Before = name === 'write' && typeof content === 'string' ? content : undefined
    for (const [id, noted] of session.befores) {
      if (id !== callId && (file === null || noted.file === file)) {
        session.befores.set(id, { file: noted.file, text: Promise.resolve(text) })
      }
    }
  }

  // Extensions' dialogs.

  /** Takes a request of an extension's UI; false for one the mapper shows. */
  private uiRequest(session: Session, proc: Proc, request: PiUiRequest): boolean {
    switch (request.method) {
      case 'setStatus':
        if (request.statusKey === SCOPE_STATUS) {
          const scope = parseScope(request.statusText)
          const changed = scope !== null || session.scope !== null
          session.scope = scope
          // The first one comes before the session is known, and its options carry the scope.
          if (changed && this.sessions.get(session.id) === session) this.pushConfig(session)
        }
        return true
      case 'notify':
        return false
      case 'select':
      case 'confirm':
      case 'input':
      case 'editor':
        void this.ask(session, proc, request)
        return true
      default:
        // Widgets, titles and editor text belong to pi's terminal UI.
        return true
    }
  }

  private async ask(session: Session, proc: Proc, request: PiUiRequest): Promise<void> {
    const dialog = dialogOf(request)
    const target = this.targets.get(session.id)
    if (!dialog || !target || session.hidden || session.collected !== null) {
      proc.rpc.answer(request.id, { cancelled: true })
      return
    }
    const callId = `pi-ui-${request.id}`
    const entryId = `t:${callId}`
    const entry: ToolEntry = {
      kind: 'tool',
      id: entryId,
      title: dialog.question.split('\n')[0]!,
      toolKind: 'other',
      status: 'pending',
      content: [],
      locations: [],
      permission: null,
      permissionResult: null,
      question: dialog.question,
      ...(dialog.detail ? { rawInput: dialog.detail } : {}),
    }
    const abort = new AbortController()
    session.dialogs.set(request.id, abort)
    // Pi answers a dialog with a timeout by itself once the time is up, and the card goes with it.
    const timer =
      typeof request.timeout === 'number' && request.timeout > 0
        ? setTimeout(() => abort.abort(new Error('The dialog timed out')), request.timeout)
        : null
    let answer: PermissionAnswer = 'cancelled'
    let withdrawn = false
    try {
      answer = await target.requestPermission(
        {
          toolCallId: callId,
          toolEntryId: entryId,
          output: { patches: [{ op: 'entry.add', entry }], effects: [] },
          options: dialog.options,
          ...(dialog.questions ? { questions: dialog.questions } : {}),
        },
        abort.signal,
      )
    } catch {
      withdrawn = true
    } finally {
      if (timer) clearTimeout(timer)
      session.dialogs.delete(request.id)
    }
    // A dialog withdrawn with its run has no one left to answer.
    if (withdrawn && abort.signal.aborted) {
      proc.rpc.answer(request.id, { cancelled: true })
      return
    }
    const given = withdrawn ? { cancelled: true as const } : dialog.answer(answer)
    proc.rpc.answer(request.id, given)
    this.deliver(session.id, () => ({
      patches: [
        {
          op: 'entry.update',
          id: entryId,
          changes: { status: 'cancelled' in given ? 'cancelled' : 'completed' },
        },
      ],
      effects: [],
    }))
  }

  private endDialogs(session: Session): void {
    for (const abort of session.dialogs.values()) abort.abort(new Error('The run ended'))
    session.dialogs.clear()
  }

  // Kettu's own commands for pi.

  private say(session: Session, markdown: string, link?: { uri: string; name: string }): void {
    this.deliver(session.id, (ctx) => ({
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'agent',
            id: ctx.nextId(),
            markdown,
            attachments: link ? [{ kind: 'link', uri: link.uri, name: link.name }] : [],
            streaming: false,
            at: ctx.now,
          },
        },
      ],
      effects: [],
    }))
  }

  private async runCommand(
    session: Session,
    proc: Proc,
    command: ParsedCommand,
  ): Promise<PromptResult> {
    const { rpc } = proc
    session.cancelling = false
    session.busy = true
    try {
      switch (command.name) {
        case 'compact':
          // Its start and end arrive as events, which draw the divider with the summary.
          await rpc
            .request({
              type: 'compact',
              ...(command.rest ? { customInstructions: command.rest } : {}),
            })
            .catch((error: unknown) => {
              if (!(error instanceof PiCommandError)) throw error
            })
          await session.events
          await this.readStats(session, proc)
          break
        case 'autocompact': {
          const state = await rpc.request<PiState>({ type: 'get_state' })
          const enabled = autoCompactWord(command.rest) ?? !state.autoCompactionEnabled
          await rpc.request({ type: 'set_auto_compaction', enabled })
          this.say(session, t(enabled ? 'pi.autocompact.on' : 'pi.autocompact.off'))
          break
        }
        case 'export': {
          const state = await rpc.request<PiState>({ type: 'get_state' })
          if (!state.sessionFile || !state.messageCount || !(await isFile(state.sessionFile))) {
            this.say(session, t('pi.export.nothing'))
            break
          }
          const name = `pi-session-${session.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.html`
          const exported = await rpc.request<{ path?: string }>({
            type: 'export_html',
            outputPath: path.join(session.cwd, name),
          })
          if (!exported?.path) throw new AgentRequestError('agent_error', t('pi.export.noPath'))
          this.say(session, t('pi.export.done'), {
            uri: `file://${exported.path}`,
            name: path.basename(exported.path),
          })
          break
        }
        case 'session':
          this.say(session, statsMessage(await rpc.request<PiStats>({ type: 'get_session_stats' })))
          break
        case 'name':
          if (!command.rest) {
            this.say(session, t('pi.name.usage'))
            break
          }
          await rpc.request({ type: 'set_session_name', name: command.rest })
          await session.events
          this.say(session, t('pi.name.done', { name: command.rest }))
          break
        case 'steering':
        case 'follow-up': {
          const steering = command.name === 'steering'
          const label = t(steering ? 'pi.queue.steering' : 'pi.queue.followUp')
          if (!command.rest) {
            const state = await rpc.request<PiState>({ type: 'get_state' })
            const mode = (steering ? state.steeringMode : state.followUpMode) ?? '?'
            this.say(session, t('pi.queue.mode', { label, mode }))
            break
          }
          const mode = queueMode(command.rest)
          if (!mode) {
            this.say(session, t('pi.queue.usage', { name: command.name }))
            break
          }
          await rpc.request({ type: steering ? 'set_steering_mode' : 'set_follow_up_mode', mode })
          this.say(session, t('pi.queue.set', { label, mode }))
          break
        }
        case 'changelog': {
          const text = await readChangelog(this.cli)
          this.say(
            session,
            text === null
              ? t('pi.changelog.missing')
              : text.length > CHANGELOG_CHARS
                ? `${text.slice(0, CHANGELOG_CHARS)}\n\n…`
                : text,
          )
          break
        }
      }
    } catch (error) {
      // A command the user stopped ends as a stopped turn does.
      if (!session.cancelling) throw commandError(error)
    } finally {
      session.busy = false
    }
    const stopped = session.cancelling
    session.cancelling = false
    return { stopReason: stopped ? 'cancelled' : 'end_turn', tokens: null, models: [] }
  }

  // Helpers.

  /**
   * Maps for the session's target and applies it; false when the mapper shows nothing of it.
   * Without a target yet, the mapping waits for one.
   */
  private deliver(sessionId: string, map: Deferred): boolean | null {
    const target = this.targets.get(sessionId)
    if (!target) {
      this.hold(sessionId, map)
      return null
    }
    const output = map(target.context())
    if (!output) return false
    if (output.patches.length > 0 || output.effects.length > 0) target.apply(output)
    return true
  }

  private hold(sessionId: string, map: Deferred): void {
    if (this.unregistered.has(sessionId) || this.pendingCount >= PENDING_EVENTS) return
    const list = this.pending.get(sessionId) ?? []
    list.push(map)
    this.pending.set(sessionId, list)
    this.pendingCount++
  }

  private dropPending(sessionId: string): void {
    const held = this.pending.get(sessionId)
    if (!held) return
    this.pending.delete(sessionId)
    this.pendingCount -= held.length
  }

  private requireSession(sessionId: string): Session {
    this.assertOpen()
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new AgentRequestError(
        'agent_error',
        t('agentRun.noSession', { id: sessionId }),
        RESOURCE_NOT_FOUND,
      )
    }
    return session
  }

  private assertOpen(): void {
    if (this.done) throw new AgentRequestError('closed', 'Pi stopped')
  }
}

/** Events the mapper takes no part of and nobody needs to hear about. */
const QUIET: ReadonlySet<string> = new Set([
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_update',
  'auto_retry_end',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
  'entry_appended',
  'bash_execution_update',
])

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() ?? false
}

async function readBefore(file: string): Promise<Before> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > BEFORE_BYTES) return undefined
    return await readFile(file, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  }
}

/** Pi's changelog, in the package the program belongs to; null when it is not found there. */
async function readChangelog(cli: string): Promise<string | null> {
  let dir = path.dirname(await realpath(cli).catch(() => cli))
  for (let up = 0; up < 5; up++) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
        name?: unknown
      }
      if (typeof manifest.name === 'string' && manifest.name.endsWith('pi-coding-agent')) {
        return await readFile(path.join(dir, 'CHANGELOG.md'), 'utf8')
      }
    } catch {
      // Not the package's folder.
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
