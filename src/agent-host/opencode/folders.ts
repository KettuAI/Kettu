// OpenCode runs a folder's own config, plugins and MCP servers as soon as a request names the
// folder, so its sessions run on a server started with the project config turned off, and only
// the sessions of folders whose own settings the user let apply run on a second server started
// without it. Both read and write the same stored sessions, so a session moves between them by
// attaching again.

import type {
  AgentConnection,
  AgentInit,
  ForkPoint,
  ListedSession,
  OpenedSession,
  PromptBlock,
  PromptResult,
  RewindPoint,
  SessionOptions,
  SessionSetup,
  SessionTarget,
} from '../connection'
import type { HostedContext } from '../driver'
import type { ConfigOption } from '@shared/thread'
import { OpenCodeConnection } from './connection'
import { startServer, type StartServer } from './server'

/** Turns OpenCode's project config off, as its own flag does for every folder of a server. */
export const HELD_ENV = { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } as const

export class OpenCodeFolders implements AgentConnection {
  readonly closed: Promise<void>
  readonly ownInstructions = true
  private readonly held: OpenCodeConnection
  private open: OpenCodeConnection | null = null
  private opening: Promise<OpenCodeConnection> | null = null
  private appVersion = ''
  /** Which server runs each session the host opened through this connection. */
  private readonly on = new Map<string, OpenCodeConnection>()
  private readonly targets = new Map<string, SessionTarget>()

  constructor(
    private readonly context: HostedContext,
    private readonly start: StartServer = startServer,
  ) {
    this.held = new OpenCodeConnection({ ...context, env: { ...context.env, ...HELD_ENV } }, start)
    this.closed = this.held.closed
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

  /** OpenCode's stored sessions, which both servers read alike. */
  get stored(): OpenCodeConnection['stored'] {
    return this.held.stored
  }

  close(): void {
    this.open?.close()
    this.held.close()
  }

  initialize(appVersion: string, signal?: AbortSignal): Promise<AgentInit> {
    this.appVersion = appVersion
    return this.held.initialize(appVersion, signal)
  }

  authenticate(methodId: string): Promise<void> {
    return this.held.authenticate(methodId)
  }

  logout(): Promise<void> {
    return this.held.logout()
  }

  /** The server for a session attached with `options`: the second one once the folder may load. */
  private async serverFor(options: SessionOptions | undefined): Promise<OpenCodeConnection> {
    if (!options?.projectTrusted) return this.held
    if (this.open && !this.open.isClosed) return this.open
    this.opening ??= (async () => {
      const open = new OpenCodeConnection(this.context, this.start)
      try {
        await open.initialize(this.appVersion)
      } catch (error) {
        open.close()
        throw error
      }
      for (const [id, target] of this.targets) open.register(id, target)
      // Its sessions end with it, as they do when the first server stops.
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

  private of(sessionId: string): OpenCodeConnection {
    return this.on.get(sessionId) ?? (this.open?.has(sessionId) ? this.open : this.held)
  }

  private attachOn(sessionId: string, server: OpenCodeConnection): void {
    const other = server === this.held ? this.open : this.held
    // The other server lets go of it, so the two never run one session at once.
    if (other?.has(sessionId)) void other.closeSession(sessionId).catch(() => {})
    this.on.set(sessionId, server)
  }

  async newSession(cwd: string, options?: SessionOptions): Promise<OpenedSession> {
    const server = await this.serverFor(options)
    const opened = await server.newSession(cwd, options)
    this.on.set(opened.sessionId, server)
    return opened
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options?: SessionOptions,
  ): Promise<SessionSetup> {
    const server = await this.serverFor(options)
    this.attachOn(sessionId, server)
    return server.loadSession(sessionId, cwd, options)
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options?: SessionOptions,
  ): Promise<SessionSetup> {
    const server = await this.serverFor(options)
    this.attachOn(sessionId, server)
    return server.resumeSession(sessionId, cwd, options)
  }

  async forkSession(
    sessionId: string,
    cwd: string,
    options?: SessionOptions,
    point?: ForkPoint,
  ): Promise<OpenedSession> {
    const server = await this.serverFor(options)
    const opened = await server.forkSession(sessionId, cwd, options, point)
    this.on.set(opened.sessionId, server)
    return opened
  }

  stageRewind(sessionId: string, cwd: string, point: RewindPoint): Promise<void> {
    return this.of(sessionId).stageRewind(sessionId, cwd, point)
  }

  unstageRewind(sessionId: string): Promise<void> {
    return this.of(sessionId).unstageRewind(sessionId)
  }

  rewindSession(
    ...args: Parameters<OpenCodeConnection['rewindSession']>
  ): ReturnType<OpenCodeConnection['rewindSession']> {
    return this.of(args[0]).rewindSession(...args)
  }

  async closeSession(sessionId: string): Promise<void> {
    const server = this.of(sessionId)
    this.on.delete(sessionId)
    return server.closeSession(sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const server = this.of(sessionId)
    this.on.delete(sessionId)
    return server.deleteSession(sessionId)
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

  // A target goes to both servers, since a session resumed on the second registers first.
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
