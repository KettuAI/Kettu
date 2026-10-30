// How the agent manager starts an agent through its protocol. A process driver speaks over the
// stdio of the one process Kettu spawns for the agent. A hosted driver runs inside the agent host
// and spawns what it needs, such as a CLI per session, through `spawn`, which records each process
// in the agent's process trees so that an idle stop, a restart, a quit or a crash stops it too.

import type { ChildProcess } from 'node:child_process'
import type { AgentDefinition, LaunchSpec } from './catalog'
import type { AgentConnection, ConnectionHooks } from './connection'
import type { Env } from './find-command'

/** A launched agent's process stdio, which the driver frames as its protocol does. */
export interface StdioTransport {
  readonly kind: 'stdio'
  readonly stdin: NodeJS.WritableStream
  readonly stdout: NodeJS.ReadableStream
}

/** Messages to and from an agent that runs in this process, as tests and development run one. */
export interface MessageTransport {
  readonly kind: 'messages'
  readonly stream: { readable: ReadableStream<unknown>; writable: WritableStream<unknown> }
  close(): void
}

export type AgentTransport = StdioTransport | MessageTransport

/** What its connections answer directly, so the host offers it before the agent ever started. */
export interface DirectReads {
  /** Its connections have `readLimits`. */
  limits?: boolean
  /** Its connections have `readContext`. */
  context?: boolean
}

export interface DriverContext {
  def: AgentDefinition
  hooks: ConnectionHooks
}

export interface ProcessDriver {
  readonly kind: 'process'
  readonly reads?: DirectReads
  /** The connection over the process the launcher spawned for the agent. */
  connect(transport: AgentTransport, context: DriverContext): AgentConnection
}

export interface HostedSpawnOptions {
  command: string
  args: string[]
  /** The home directory when not given, as for an agent's process. */
  cwd?: string
  /** The whole environment the process gets. */
  env: Env
  /** Stops the process, as a stop of the agent does, once it aborts. */
  signal?: AbortSignal
}

/**
 * Spawns a process for an agent that runs in the host, with stdin, stdout and stderr piped; its
 * stderr also goes to the agent's diagnostics. It is stopped as an agent's process is: EOF, then
 * its whole tree. Throws once the agent is stopping.
 */
export type HostedSpawn = (options: HostedSpawnOptions) => ChildProcess

export interface HostedContext extends DriverContext {
  /** What detection found to run for the agent. */
  spec: LaunchSpec
  /** The agent's environment, as its process would get it. */
  env: Env
  spawn: HostedSpawn
}

export interface HostedDriver {
  readonly kind: 'hosted'
  readonly reads?: DirectReads
  /**
   * The connection to an agent that runs in the host. Nothing runs until its `initialize`; once
   * it closes by itself the agent counts as exited.
   */
  connect(context: HostedContext): AgentConnection
}

export type AgentDriver = ProcessDriver | HostedDriver
