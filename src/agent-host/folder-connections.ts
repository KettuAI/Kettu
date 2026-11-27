// A harness whose one process applies a folder's own config to every session it serves, and has a
// switch only for all of them, runs two: one with the folder config turned off for every session,
// and, once the user let a folder's own settings apply, another without the switch for that
// folder's sessions. Both read and write the same stored sessions, so a session moves between
// them by attaching again.

import type {
  AgentConnection,
  AgentInit,
  ForkPoint,
  ListedSession,
  OpenedSession,
  PromptBlock,
  PromptResult,
  SessionOptions,
  SessionSetup,
  SessionTarget,
  SignInClient,
} from './connection'
import type { ConfigOption } from '@shared/thread'

export interface FolderConnectionsOptions<C extends AgentConnection> {
  /** A connection that loads no folder's own config (`held`), or one that does. */
  make(held: boolean): C
  /** Whether a connection runs a session, for ids the host never attached, such as a subagent's. */
  has?(connection: C, sessionId: string): boolean
}

type Optional<K extends keyof AgentConnection> = NonNullable<AgentConnection[K]>

export class FolderConnections<C extends AgentConnection> implements AgentConnection {
  readonly closed: Promise<void>
  readonly ownInstructions?: boolean
  readonly systemPromptAppend?: boolean
  readonly reportsBack?: boolean
  readonly rewindsOpen?: boolean
  readAuthStatus?: Optional<'readAuthStatus'>
  copySession?: Optional<'copySession'>
  canRewind?: Optional<'canRewind'>
  rewindSession?: Optional<'rewindSession'>
  stageRewind?: Optional<'stageRewind'>
  unstageRewind?: Optional<'unstageRewind'>
  stopTask?: Optional<'stopTask'>
  taskOutput?: Optional<'taskOutput'>
  sideQuestion?: Optional<'sideQuestion'>
  injectHistory?: Optional<'injectHistory'>
  answerQuestion?: Optional<'answerQuestion'>
  readLimits?: Optional<'readLimits'>
  request?: Optional<'request'>
  readContext?: Optional<'readContext'>
  readContextEstimates?: Optional<'readContextEstimates'>
  protected readonly held: C
  private open: C | null = null
  private opening: Promise<C> | null = null
  private appVersion = ''
  /** Which connection runs each session the host opened through this one. */
  private readonly on = new Map<string, C>()
  private readonly targets = new Map<string, SessionTarget>()

  constructor(private readonly options: FolderConnectionsOptions<C>) {
    const held = options.make(true)
    this.held = held
    this.closed = held.closed
    if (held.ownInstructions !== undefined) this.ownInstructions = held.ownInstructions
    if (held.systemPromptAppend !== undefined) this.systemPromptAppend = held.systemPromptAppend
    if (held.reportsBack !== undefined) this.reportsBack = held.reportsBack
    if (held.rewindsOpen !== undefined) this.rewindsOpen = held.rewindsOpen
    // What the process answers for itself, outside any session, comes from the held one.
    if (held.readAuthStatus) this.readAuthStatus = () => held.readAuthStatus!()
    if (held.answerQuestion) this.answerQuestion = (...a) => held.answerQuestion!(...a)
    if (held.readLimits) this.readLimits = () => held.readLimits!()
    if (held.request)
      this.request = <T>(method: string, params?: unknown) => held.request!<T>(method, params)
    // What a session asks goes to the connection that runs it.
    if (held.copySession) this.copySession = (id, ...a) => this.of(id).copySession!(id, ...a)
    if (held.canRewind) this.canRewind = (id, ...a) => this.of(id).canRewind!(id, ...a)
    if (held.rewindSession) this.rewindSession = (id, ...a) => this.of(id).rewindSession!(id, ...a)
    if (held.stageRewind) this.stageRewind = (id, ...a) => this.of(id).stageRewind!(id, ...a)
    if (held.unstageRewind) this.unstageRewind = (id, ...a) => this.of(id).unstageRewind!(id, ...a)
    if (held.stopTask) this.stopTask = (id, ...a) => this.of(id).stopTask!(id, ...a)
    if (held.taskOutput) this.taskOutput = (id, ...a) => this.of(id).taskOutput!(id, ...a)
    if (held.sideQuestion) this.sideQuestion = (id, ...a) => this.of(id).sideQuestion!(id, ...a)
    if (held.injectHistory) this.injectHistory = (id, ...a) => this.of(id).injectHistory!(id, ...a)
    if (held.readContext) this.readContext = (id, ...a) => this.of(id).readContext!(id, ...a)
    if (held.readContextEstimates) {
      this.readContextEstimates = (id, ...a) => this.of(id).readContextEstimates!(id, ...a)
    }
  }

  get isClosed(): boolean {
    return this.held.isClosed
  }

  get hiddenSessions(): boolean {
    return this.held.hiddenSessions
  }

  get unpromptedSessions(): boolean {
    return this.held.unpromptedSessions
  }

  get allowsKettuTools(): boolean | undefined {
    return this.held.allowsKettuTools
  }

  close(): void {
    this.open?.close()
    this.held.close()
  }

  initialize(appVersion: string, signal?: AbortSignal): Promise<AgentInit> {
    this.appVersion = appVersion
    return this.held.initialize(appVersion, signal)
  }

  authenticate(methodId: string, client?: SignInClient): Promise<void> {
    return this.held.authenticate(methodId, client)
  }

  logout(): Promise<void> {
    return this.held.logout()
  }

  /** The connection for a session attached with `options`: the second once the folder may load. */
  private async connectionFor(options: SessionOptions | undefined): Promise<C> {
    if (!options?.projectTrusted) return this.held
    if (this.open && !this.open.isClosed) return this.open
    this.opening ??= (async () => {
      const open = this.options.make(false)
      try {
        await open.initialize(this.appVersion)
      } catch (error) {
        open.close()
        throw error
      }
      for (const [id, target] of this.targets) open.register(id, target)
      // Its sessions end with it, as they do when the first one stops.
      void open.closed.then(() => {
        if (this.open === open) this.close()
      })
      this.open = open
      return open
    })().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  protected of(sessionId: string): C {
    const known = this.on.get(sessionId)
    if (known) return known
    const open = this.open
    if (open && this.options.has?.(open, sessionId)) return open
    if (open) {
      const root = open.rootOf(sessionId)
      if (root !== sessionId && this.on.get(root) === open) return open
    }
    return this.held
  }

  private attachOn(sessionId: string, connection: C): void {
    const other = connection === this.held ? this.open : this.held
    // The other one lets go of it, so the two never run one session at once.
    if (other && this.on.get(sessionId) === other) {
      void other.closeSession(sessionId).catch(() => {})
    } else if (other && this.options.has?.(other, sessionId)) {
      void other.closeSession(sessionId).catch(() => {})
    }
    this.on.set(sessionId, connection)
  }

  async newSession(cwd: string, options?: SessionOptions): Promise<OpenedSession> {
    const connection = await this.connectionFor(options)
    const opened = await connection.newSession(cwd, options)
    this.on.set(opened.sessionId, connection)
    return opened
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options?: SessionOptions,
  ): Promise<SessionSetup> {
    const connection = await this.connectionFor(options)
    this.attachOn(sessionId, connection)
    return connection.loadSession(sessionId, cwd, options)
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options?: SessionOptions,
  ): Promise<SessionSetup> {
    const connection = await this.connectionFor(options)
    this.attachOn(sessionId, connection)
    return connection.resumeSession(sessionId, cwd, options)
  }

  async forkSession(
    sessionId: string,
    cwd: string,
    options?: SessionOptions,
    point?: ForkPoint,
  ): Promise<OpenedSession> {
    const connection = await this.connectionFor(options)
    const opened = await connection.forkSession(sessionId, cwd, options, point)
    this.on.set(opened.sessionId, connection)
    return opened
  }

  async closeSession(sessionId: string): Promise<void> {
    const connection = this.of(sessionId)
    this.on.delete(sessionId)
    return connection.closeSession(sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const connection = this.of(sessionId)
    this.on.delete(sessionId)
    return connection.deleteSession(sessionId)
  }

  removeHidden(sessionId: string, log: (message: string) => void): Promise<void> {
    return this.of(sessionId).removeHidden(sessionId, log)
  }

  listSessions(
    cwd: string | null,
    cursor: string | null,
  ): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    return this.held.listSessions(cwd, cursor)
  }

  // A target goes to both, since a session resumed on the second registers first.
  register(sessionId: string, target: SessionTarget): void {
    this.targets.set(sessionId, target)
    this.held.register(sessionId, target)
    this.open?.register(sessionId, target)
  }

  unregister(sessionId: string, target?: SessionTarget): void {
    if (!target || this.targets.get(sessionId) === target) this.targets.delete(sessionId)
    this.held.unregister(sessionId, target)
    this.open?.unregister(sessionId, target)
  }

  reopen(sessionId: string): void {
    this.held.reopen(sessionId)
    this.open?.reopen(sessionId)
  }

  rootOf(id: string): string {
    return this.of(id).rootOf(id)
  }

  prompt(
    sessionId: string,
    prompt: readonly PromptBlock[],
    heard?: (ref: string) => void,
  ): Promise<PromptResult> {
    return this.of(sessionId).prompt(sessionId, prompt, heard)
  }

  collect(sessionId: string, text: string): Promise<string[]> {
    return this.of(sessionId).collect(sessionId, text)
  }

  steer(sessionId: string, prompt: readonly PromptBlock[]): Promise<'injected' | 'promptRequired'> {
    return this.of(sessionId).steer(sessionId, prompt)
  }

  cancel(sessionId: string): Promise<void> {
    return this.of(sessionId).cancel(sessionId)
  }

  setMode(sessionId: string, modeId: string): Promise<void> {
    return this.of(sessionId).setMode(sessionId, modeId)
  }

  setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    return this.of(sessionId).setConfigOption(sessionId, optionId, value)
  }
}
