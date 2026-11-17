// The contract between the renderer and the terminal host, over the terminal host port, which a
// paired device's terminal port speaks too.

import type { SurfaceControl } from './control'
import type { PortConnectionState } from './port-rpc'
import type { AgentId } from './thread'

/**
 * The agent that started a terminal with its tools, and the session it started it from; or, with
 * `fromReply`, the agent whose reply the user ran a code block of.
 */
export interface TerminalOwner {
  agentId: AgentId
  sessionId: string
  fromReply?: true
}

export interface TerminalInfo {
  id: string
  projectPath: string
  /** The session it belongs to; null for its project's New session, which hands it on. */
  sessionId: string | null
  shell: string // the program name, such as "zsh" or "pwsh"
  title: string // the foreground process, or the title the shell set
  busy: boolean // a process other than the shell is in the foreground
  exitCode: number | null // set once the shell has exited
  createdAt: number
  /** Null for a terminal the user opened; cleared when its shell is restarted. */
  owner: TerminalOwner | null
  /** Who uses it in the owner's running turn; idle for every terminal no turn uses. */
  control: SurfaceControl
  /** What its program waits for the user to type: a password, or nothing known. */
  waiting: 'password' | null
}

export interface TerminalContract {
  'terminals.create': {
    params: {
      projectPath: string
      // Where the shell starts, relative to the project: a folder inside it, never above.
      folder?: string
      sessionId?: string
      cols: number
      rows: number
      command?: TerminalCommand
    }
    result: TerminalInfo
  }
  /** Hands the project's New session terminals to the session it created. */
  'terminals.assign': { params: { projectPath: string; sessionId: string }; result: void }
  'terminals.list': { params: { projectPath?: string }; result: TerminalInfo[] }
  'terminals.attach': { params: { id: string }; result: { replay: string } }
  'terminals.input': { params: { id: string; data: string }; result: void }
  'terminals.resize': { params: { id: string; cols: number; rows: number }; result: void }
  'terminals.ack': { params: { id: string; chars: number }; result: void }
  'terminals.kill': { params: { id: string }; result: void }
  'terminals.restart': { params: { id: string }; result: TerminalInfo }
  /** Take over and Hand back of a terminal an agent's turn uses; false when no turn has it. */
  'terminals.takeOver': { params: { id: string }; result: boolean }
  'terminals.handBack': { params: { id: string }; result: boolean }
}

/**
 * Text typed into a new terminal once its shell is ready, without pressing Enter unless
 * `run` is set. From a port, `run` is only accepted for a sign-in command the agent host built;
 * the agent's commands and the code blocks the user runs from a reply come over main's channel.
 */
export interface TerminalCommand {
  text: string
  run: boolean
}

export type TerminalMethod = keyof TerminalContract
export type TerminalParams<M extends TerminalMethod> = TerminalContract[M]['params']
export type TerminalResult<M extends TerminalMethod> = TerminalContract[M]['result']

export const TERMINAL_METHODS = [
  'terminals.create',
  'terminals.list',
  'terminals.assign',
  'terminals.attach',
  'terminals.input',
  'terminals.resize',
  'terminals.ack',
  'terminals.kill',
  'terminals.restart',
  'terminals.takeOver',
  'terminals.handBack',
] as const satisfies readonly TerminalMethod[]

export type TerminalEvent =
  | { type: 'terminal.data'; id: string; data: string }
  /**
   * To a device's port that fell behind and missed output: the screen starts over from `replay`,
   * as after `terminals.attach`. Its characters are not acknowledged.
   */
  | { type: 'terminal.replay'; id: string; replay: string }
  | { type: 'terminal.info'; info: TerminalInfo }
  | { type: 'terminal.removed'; id: string }

export interface TerminalsApi {
  request<M extends TerminalMethod>(
    method: M,
    params: TerminalParams<M>,
  ): Promise<TerminalResult<M>>
  onEvent(listener: (event: TerminalEvent) => void): () => void
  /** Calls the listener with the current state, if there is one yet, and then on every change. */
  onConnection(listener: (state: PortConnectionState) => void): () => void
  /** Starts the host again after it failed (crashed too often); does nothing otherwise. */
  restart(): Promise<void>
  /** Whether the host runs, asked without starting it: one that does not holds no terminals. */
  running(): Promise<boolean>
}

/** Flow control constants, from VS Code's pty host (MIT). */
export const TERMINAL_FLOW = {
  ackChars: 5_000,
  highWatermark: 100_000,
  lowWatermark: 5_000,
  batchMs: 5,
  maxInputBytes: 64 * 1024,
  replayBytes: 1024 * 1024,
  scrollback: 10_000,
} as const
