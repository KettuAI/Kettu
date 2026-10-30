// The run of an agent whose client runs inside the agent host: no process of its own, only the
// ones it spawns, each started and stopped as an agent's process is.

import os from 'node:os'
import type { Platform } from '@shared/platform'
import { spawnAgent, type AgentRun, type ExitInfo, type SpawnedAgent } from './agent-process'
import type { AgentConnection } from './connection'
import type { HostedSpawn } from './driver'
import { needsShell } from './find-command'
import type { ToolOptions } from './process-tree'

export interface HostedRunHooks {
  /** A child's stderr and process events, as an agent process's. */
  stderr(text: string): void
  event(event: string, detail?: string): void
  /** A child started, or exited: what the process record and main hold changes. */
  spawned(child: SpawnedAgent): void
  exited(child: SpawnedAgent): void
  /** Stops a child as a stop of the agent stops its process. */
  stop(child: SpawnedAgent, tools: ToolOptions): Promise<void>
}

const STOPPED: ExitInfo = { code: 0, signal: null }
// Read after the agent's name, as an exit's error is.
const CLOSED: ExitInfo = { code: null, signal: null, error: 'closed its connection' }
const KILLED: ExitInfo = { code: null, signal: 'SIGKILL' }

export class HostedRun implements AgentRun {
  readonly pid = null
  readonly startedAt = Date.now()
  readonly exited: Promise<ExitInfo>
  private resolveExit!: (info: ExitInfo) => void
  private done = false
  /** Set once it stops or is killed, so nothing more is spawned. */
  private closing = false
  private ending: Promise<ExitInfo> | null = null
  private connection: AgentConnection | null = null
  private readonly running = new Set<SpawnedAgent>()

  constructor(
    private readonly platform: Platform,
    private readonly hooks: HostedRunHooks,
  ) {
    this.exited = new Promise((resolve) => (this.resolveExit = resolve))
  }

  get hasExited(): boolean {
    return this.done
  }

  /** The processes it runs now. */
  get children(): SpawnedAgent[] {
    return [...this.running]
  }

  /** The connection that runs in it, closed as it stops; once it closes by itself the run ends. */
  attach(connection: AgentConnection): void {
    this.connection = connection
    const closed = (): void => void this.end(CLOSED, {})
    void connection.closed.then(closed, closed)
  }

  readonly spawn: HostedSpawn = (options) => {
    if (this.closing) throw new Error('The agent is stopping')
    const { command, args } = options
    const child = spawnAgent(
      {
        command,
        args,
        env: {},
        shell: needsShell(command, this.platform),
        display: { command, args, env: {} },
      },
      {
        platform: this.platform,
        env: options.env,
        cwd: options.cwd ?? os.homedir(),
        onStderr: (text) => this.hooks.stderr(text),
        onEvent: (event, detail) => this.hooks.event(event, detail),
      },
    )
    this.running.add(child)
    this.hooks.spawned(child)
    const { signal } = options
    const abort = (): void => void this.hooks.stop(child, {})
    void child.exited.then(() => {
      signal?.removeEventListener('abort', abort)
      this.running.delete(child)
      this.hooks.exited(child)
    })
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    return child.child
  }

  stop(tools: ToolOptions = {}): Promise<ExitInfo> {
    return this.end(STOPPED, tools)
  }

  async kill(): Promise<void> {
    this.closing = true
    this.connection?.close()
    await Promise.all(this.children.map((child) => child.kill()))
    this.finish(KILLED)
  }

  /** Closes the connection, then stops what still runs; a second call joins the first. */
  private end(info: ExitInfo, tools: ToolOptions): Promise<ExitInfo> {
    this.closing = true
    this.ending ??= (async () => {
      this.connection?.close()
      await Promise.all(this.children.map((child) => this.hooks.stop(child, tools)))
      this.finish(info)
      return info
    })()
    return this.ending
  }

  private finish(info: ExitInfo): void {
    if (this.done) return
    this.done = true
    this.resolveExit(info)
  }
}
