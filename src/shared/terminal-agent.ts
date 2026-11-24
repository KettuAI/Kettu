// An agent's terminal calls, from the `terminal_*` tools on Kettu's MCP service through main's
// control channel to the terminal host, which alone acts on them.

import { CONTROL_WAIT_MS } from './control'
import type { AgentId } from './thread'

export const TERMINAL_TOOL_NAMES = [
  'terminal_list',
  'terminal_run',
  'terminal_read',
  'terminal_wait',
  'terminal_input',
  'terminal_stop',
  'terminal_rename',
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
      /** The tab's name, else the command names it. */
      name?: string
    }
  /**
   * The user's Run on a shell code block of the session's agent's reply: a new terminal of the
   * agent's, run from the reply, that the user types into as usual. `command` may span lines.
   */
  | {
      kind: 'reply'
      sessionId: string
      agentId: AgentId
      folder: string
      command: string
      /** A paired device asked, which the terminal host allows only as the owner set it to. */
      fromDevice: boolean
    }
  /** The session's terminals, the user's included, each with whether its agent may use it. */
  | { kind: 'list'; sessionId: string }
  /**
   * Gives or takes back the session's agent the use of a terminal the user opened in it. Only the
   * agent host sends it, once the user allowed it in a card, shared it, or took it back.
   */
  | { kind: 'allow'; sessionId: string; terminalId: string; allowed: boolean }
  /**
   * Names the tab, an empty name going back to its title. A name the user gave, or a terminal of
   * theirs the agent may not use yet, answers `ask` unless `asked`: the user asked for the rename,
   * allowed it in a card, or the session's mode asks nothing.
   */
  | { kind: 'rename'; sessionId: string; terminalId: string; name: string; asked: boolean }
  /** The user is asked whether the agent may use the terminal, which its tab shows meanwhile. */
  | { kind: 'asking'; sessionId: string; terminalId: string; asking: boolean }
  | { kind: 'read'; sessionId: string; terminalId: string; lines: number }
  /** Returns once the command ends, the terminal waits for a password, or it goes quiet. */
  | { kind: 'wait'; sessionId: string; terminalId: string; lines: number }
  /**
   * `readOnly`: the session plans, so a terminal the user opened is only read. `passwords`: the
   * user lets agents type passwords, so the call does not wait while the terminal waits for one.
   */
  | {
      kind: 'input'
      sessionId: string
      terminalId: string
      text: string
      enter: boolean
      readOnly?: boolean
      passwords?: boolean
    }
  | {
      kind: 'stop'
      sessionId: string
      terminalId: string
      close: boolean
      readOnly?: boolean
      passwords?: boolean
    }

/** A terminal as the agent sees it. */
export interface AgentTerminal {
  id: string
  /** What it runs or last ran, or the shell's name. */
  title: string
  /** The name its tab shows in place of the title, and who gave it; null for none. */
  name: string | null
  namedBy: 'user' | 'agent' | null
  busy: boolean
  exitCode: number | null
  /** Its program waits for the user to type a password. */
  password: boolean
  /** Who opened it: the agent's tools, the user's Run on a block of the agent's reply, or the user. */
  opener: 'agent' | 'reply' | 'user'
  /** The agent may use it now: one it opened, or one of the user's they allowed it. */
  usable: boolean
}

/**
 * Why a wait returned: the command ended, the shell exited, it waits for a password, its output
 * went quiet, nothing ran, or the wait ran out.
 */
export type TerminalWaitReason = 'ended' | 'exited' | 'password' | 'quiet' | 'idle' | 'timeout'

export type TerminalCallResult =
  | { kind: 'terminal'; terminal: AgentTerminal }
  | { kind: 'output'; terminal: AgentTerminal; output: string; reason?: TerminalWaitReason }
  | { kind: 'list'; terminals: AgentTerminal[] }
  | { kind: 'closed' }
  /** The terminal is the user's and the agent may not use it yet: the agent host asks them. */
  | { kind: 'ask'; terminal: AgentTerminal }
  /** The user still holds the terminal: the agent calls again to keep waiting. */
  | { kind: 'held' }
  /** The user still types a password into it: the agent calls again to keep waiting. */
  | { kind: 'password' }

export type TerminalCallErrorCode =
  'not_found' | 'restricted' | 'not_allowed' | 'stopped' | 'unavailable' | 'failed'

export type TerminalCallAnswer =
  { result: TerminalCallResult } | { error: { code: TerminalCallErrorCode; message: string } }

/** How long main waits for the terminal host's answer: a held call returns after CONTROL_WAIT_MS. */
export const TERMINAL_CALL_TIMEOUT_MS = CONTROL_WAIT_MS + 15_000

/** The longest a `wait` call waits, under the shortest harness tool time limit. */
export const TERMINAL_WAIT_MS = 40_000
/** How long output must stop before a `wait` call counts the terminal as quiet. */
export const TERMINAL_QUIET_MS = 3_000

export const MAX_TERMINAL_COMMAND = 16 * 1024
export const MAX_TERMINAL_READ_LINES = 2000
export const DEFAULT_TERMINAL_READ_LINES = 200

/** Why a reply's code block may not run: empty, too long, or holding characters one cannot see. */
export type ReplyCommandProblem = 'empty' | 'too_long' | 'control' | 'invisible'

/* eslint-disable no-control-regex */
// Tabs and newlines are part of a block; any other control character could act as a key.
const REPLY_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
// Characters that show as nothing or reorder what is shown, so what runs would differ from what
// the user read: soft hyphen, zero-width and joiner characters, bidirectional controls, BOM.
const REPLY_INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/
/* eslint-enable no-control-regex */

/** Checks a code block the user runs from a reply, which runs as shown or not at all. */
export function replyCommandProblem(command: string): ReplyCommandProblem | null {
  if (command.trim().length === 0) return 'empty'
  if (command.length > MAX_TERMINAL_COMMAND) return 'too_long'
  if (REPLY_CONTROL.test(command)) return 'control'
  if (REPLY_INVISIBLE.test(command)) return 'invisible'
  return null
}

const NOTICE_LEAD = 'I ran this from your reply in terminal '

/** A fence longer than any run of backticks in `text`, so the block cannot close early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** The message that tells the session's agent the user ran a block of its reply in a terminal. */
export function replyRunNotice(terminalId: string, command: string): string {
  const fence = fenceFor(command)
  return [
    `${NOTICE_LEAD}\`${terminalId}\`, beside our conversation:`,
    '',
    `${fence}sh`,
    command,
    fence,
    '',
    'Follow it with terminal_wait and terminal_read, then carry on. If it waits for a password, ask me to type it in that terminal and wait for me.',
  ].join('\n')
}

/** The terminal and the command of a message `replyRunNotice` wrote, or null for any other. */
export function parseReplyRunNotice(text: string): { terminalId: string; command: string } | null {
  if (!text.startsWith(NOTICE_LEAD)) return null
  const match =
    /^I ran this from your reply in terminal `([^`\n]+)`, beside our conversation:\n\n(`{3,})sh\n([\s\S]*?)\n\2\n/.exec(
      text,
    )
  return match ? { terminalId: match[1]!, command: match[3]! } : null
}
