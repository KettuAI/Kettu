// The contract between the renderer and the terminal host, over the terminal host port, which a
// paired device's terminal port speaks too.

import type { PortConnectionState } from './port-rpc'

export interface TerminalInfo {
  id: string
  projectPath: string
  shell: string // the program name, such as "zsh" or "pwsh"
  title: string // the foreground process, or the title the shell set
  busy: boolean // a process other than the shell is in the foreground
  exitCode: number | null // set once the shell has exited
  createdAt: number
}

export interface TerminalContract {
  'terminals.create': {
    params: { projectPath: string; cols: number; rows: number; command?: TerminalCommand }
    result: TerminalInfo
  }
  'terminals.list': { params: { projectPath?: string }; result: TerminalInfo[] }
  'terminals.attach': { params: { id: string }; result: { replay: string } }
  'terminals.input': { params: { id: string; data: string }; result: void }
  'terminals.resize': { params: { id: string; cols: number; rows: number }; result: void }
  'terminals.ack': { params: { id: string; chars: number }; result: void }
  'terminals.kill': { params: { id: string }; result: void }
  'terminals.restart': { params: { id: string }; result: TerminalInfo }
}

/**
 * Text typed into a new terminal once its shell is ready, without pressing Enter unless
 * `run` is set. `run` is only accepted for a sign-in command the agent host built.
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
  'terminals.attach',
  'terminals.input',
  'terminals.resize',
  'terminals.ack',
  'terminals.kill',
  'terminals.restart',
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
