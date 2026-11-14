// An agent's terminal calls, from the `terminal_*` tools on Kettu's MCP service through main's
// control channel to the terminal host, which alone acts on them.

import { CONTROL_WAIT_MS } from './control'
import type { AgentId } from './thread'

export const TERMINAL_TOOL_NAMES = [
  'terminal_run',
  'terminal_read',
  'terminal_input',
  'terminal_stop',
] as const

export type TerminalToolName = (typeof TERMINAL_TOOL_NAMES)[number]

/** What the agent host asks of the terminal host for one tool call. */
export type TerminalCall =
  | {
      kind: 'run'
      sessionId: string
      agentId: AgentId
      /** The session's folder, its worktree when it has one. */
      folder: string
      command: string
    }
  | { kind: 'read'; sessionId: string; terminalId: string; lines: number }
  | { kind: 'input'; sessionId: string; terminalId: string; text: string; enter: boolean }
  | { kind: 'stop'; sessionId: string; terminalId: string; close: boolean }

/** A terminal as the agent sees it. */
export interface AgentTerminal {
  id: string
  title: string
  busy: boolean
  exitCode: number | null
}

export type TerminalCallResult =
  | { kind: 'terminal'; terminal: AgentTerminal }
  | { kind: 'output'; terminal: AgentTerminal; output: string }
  | { kind: 'closed' }
  /** The user still holds the terminal: the agent calls again to keep waiting. */
  | { kind: 'held' }

export type TerminalCallErrorCode =
  'not_found' | 'restricted' | 'stopped' | 'unavailable' | 'failed'

export type TerminalCallAnswer =
  { result: TerminalCallResult } | { error: { code: TerminalCallErrorCode; message: string } }

/** How long main waits for the terminal host's answer: a held call returns after CONTROL_WAIT_MS. */
export const TERMINAL_CALL_TIMEOUT_MS = CONTROL_WAIT_MS + 15_000

export const MAX_TERMINAL_COMMAND = 16 * 1024
export const MAX_TERMINAL_READ_LINES = 2000
export const DEFAULT_TERMINAL_READ_LINES = 200
