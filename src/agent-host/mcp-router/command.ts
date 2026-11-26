// A command server's process, started and stopped as an agent's is: in a process group of its own,
// its whole tree stopped with it, and recorded so that what a crashed host left is stopped by the
// next one.

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Platform } from '@shared/platform'
import { spawnAgent, type SpawnedAgent, type StopTimings } from '../agent-process'
import type { AgentTrees } from '../agent-trees'
import { findCommand, isExecutableFile, needsShell } from '../find-command'
import type { ServerCommand } from './router'

export interface CommandDeps {
  platform: Platform
  trees?: Pick<AgentTrees, 'launched' | 'active' | 'note' | 'reap'> | null
  timings?: StopTimings
  /** The host is quitting: a stop kills at once instead of waiting through each step. */
  quitting?(): boolean
}

/** The command, started in `cwd`; rejects when it is not found or cannot start. */
export async function startCommand(
  name: string,
  command: ServerCommand,
  cwd: string,
  deps: CommandDeps,
  onStderr: (text: string) => void,
): Promise<CommandTransport> {
  const { platform } = deps
  const file = await findCommand(command.command, {
    platform,
    env: command.env,
    isExecutable: (candidate) => isExecutableFile(candidate, platform),
  })
  if (!file) {
    throw Object.assign(new Error(`Command not found: ${command.command}`), { code: 'ENOENT' })
  }
  const words = { command: file, args: command.args, env: {} }
  const spawned = spawnAgent(
    { ...words, shell: needsShell(file, platform), display: words },
    {
      platform,
      env: command.env,
      cwd,
      onStderr,
      ...(deps.timings ? { timings: deps.timings } : {}),
    },
  )
  if (spawned.pid === null) {
    const exit = await spawned.exited
    throw new Error(exit.error ?? `${command.command} did not start`)
  }
  return new CommandTransport(name, spawned, deps)
}

export class CommandTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly buffer = new ReadBuffer()
  private readonly root: { pid: number; startedAt: number }
  private closing: Promise<void> | null = null
  private reaped: Promise<void> | null = null

  constructor(
    private readonly name: string,
    private readonly spawned: SpawnedAgent,
    private readonly deps: CommandDeps,
  ) {
    this.root = { pid: spawned.pid!, startedAt: spawned.startedAt }
    deps.trees?.launched(this.root)
  }

  private get trees(): CommandDeps['trees'] {
    return this.deps.trees
  }

  async start(): Promise<void> {
    this.spawned.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk)
      this.trees?.active(this.root)
      for (;;) {
        let message: JSONRPCMessage | null
        try {
          message = this.buffer.readMessage()
        } catch (error) {
          this.onerror?.(error as Error)
          continue
        }
        if (!message) break
        this.onmessage?.(message)
      }
    })
    void this.spawned.exited.then(() => {
      // What it left running goes too, also when it exited on its own.
      void this.reap()
      this.onclose?.()
    })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.spawned.hasExited) return
    this.spawned.child.stdin?.write(serializeMessage(message))
  }

  /** EOF, then its whole tree is stopped, and what it left is reaped. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.deps.quitting?.()) {
        await this.spawned.kill()
      } else if (!this.spawned.hasExited) {
        await this.trees?.note(this.root)
        await this.spawned.stop()
      }
      await this.reap()
    })()
    return this.closing
  }

  private reap(): Promise<void> {
    this.reaped ??= this.trees?.reap(this.root, `MCP server ${this.name}`) ?? Promise.resolve()
    return this.reaped
  }
}
