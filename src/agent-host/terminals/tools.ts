// The `terminal_*` tools on Kettu's MCP service: an agent runs a command in a terminal tab of its
// session, where the user sees it and can take it over, then reads, types into and stops it. Kettu
// checks every argument here, and the terminal host lets a session reach only its own terminals.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import {
  DEFAULT_TERMINAL_READ_LINES,
  MAX_TERMINAL_COMMAND,
  MAX_TERMINAL_READ_LINES,
  TERMINAL_QUIET_MS,
  TERMINAL_TOOL_NAMES,
  TERMINAL_WAIT_MS,
  type AgentTerminal,
  type TerminalCall,
  type TerminalCallAnswer,
  type TerminalToolName,
  type TerminalWaitReason,
} from '@shared/terminal-agent'
import type { AgentId } from '@shared/thread'
import type { Caller } from '../artifacts/tools'

type Schema = Record<string, unknown>

function object(properties: Record<string, Schema>, required: string[] = []): Tool['inputSchema'] {
  return { type: 'object', properties, required, additionalProperties: false }
}

const TERMINAL_ID: Schema = {
  type: 'string',
  description: 'The terminal id that terminal_run gave.',
}
const ACTS = { readOnlyHint: false, openWorldHint: false } as const
const LINES: Schema = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_TERMINAL_READ_LINES,
  default: DEFAULT_TERMINAL_READ_LINES,
}

export const TERMINAL_TOOLS: Tool[] = [
  {
    name: 'terminal_run',
    title: 'Run in a terminal',
    description:
      "Opens a new terminal tab in this session's folder, beside the conversation, and runs a one-line command in the user's shell, such as a dev server, a watcher or a long build. The user sees it and can take it over. Returns the terminal's id; read its output with terminal_read.",
    inputSchema: object({ command: { type: 'string', description: 'One line, run as typed.' } }, [
      'command',
    ]),
    annotations: { ...ACTS, destructiveHint: true },
  },
  {
    name: 'terminal_read',
    title: 'Read a terminal',
    description:
      "The latest output of a terminal this session started or the user ran from your reply, as plain text, whether its command still runs, whether it waits for the user's password, and the shell's exit code.",
    inputSchema: object({ terminalId: TERMINAL_ID, lines: LINES }, ['terminalId']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'terminal_wait',
    title: 'Wait on a terminal',
    description: `Waits until the terminal's command ends, it waits for the user's password, or its output has been quiet for ${TERMINAL_QUIET_MS / 1000} s (such as a server that is up), at most ${TERMINAL_WAIT_MS / 1000} s, then answers like terminal_read and says why it returned. Call it again to keep waiting.`,
    inputSchema: object({ terminalId: TERMINAL_ID, lines: LINES }, ['terminalId']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'terminal_input',
    title: 'Type into a terminal',
    description:
      'Types text into a terminal this session started, and presses Enter when `enter` is set, such as an answer to a prompt. Never types a password: only the user does. While the user has taken the terminal over or types a password into it, the call waits; when it returns that they still do, call again to keep waiting.',
    inputSchema: object(
      {
        terminalId: TERMINAL_ID,
        text: { type: 'string' },
        enter: { type: 'boolean', default: true },
      },
      ['terminalId', 'text'],
    ),
    annotations: { ...ACTS, destructiveHint: true },
  },
  {
    name: 'terminal_stop',
    title: 'Stop a terminal',
    description:
      'Sends Ctrl+C to a terminal this session started, stopping its command. `close` also ends the shell and closes the tab. Waits like terminal_input while the user has it.',
    inputSchema: object({ terminalId: TERMINAL_ID, close: { type: 'boolean', default: false } }, [
      'terminalId',
    ]),
    annotations: { ...ACTS },
  },
]

export function isTerminalToolName(name: string): name is TerminalToolName {
  return (TERMINAL_TOOL_NAMES as readonly string[]).includes(name)
}

export interface TerminalToolDeps {
  call(call: TerminalCall): Promise<TerminalCallAnswer>
  /** The session whose terminals a call uses: a subagent's, the session it runs under. */
  sessionOf(sessionId: string): string
  agentOf(sessionId: string): AgentId | null
  /** The session's folder, its worktree when it has one; null when it has none yet. */
  folderOf(sessionId: string): string | null
}

export class TerminalArgsError extends Error {}

const MAX_ID = 128

function args(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  return input as Record<string, unknown>
}

/** A command or text as typed: newlines and other control characters could act as keys. */
function typed(value: unknown, key: string, allowEmpty: boolean): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > MAX_TERMINAL_COMMAND
  ) {
    throw new TerminalArgsError(
      `"${key}" must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${MAX_TERMINAL_COMMAND} characters`,
    )
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
    throw new TerminalArgsError(`"${key}" must be one line without control characters`)
  }
  return value
}

function terminalId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID) {
    throw new TerminalArgsError('"terminalId" must be the id terminal_run gave')
  }
  return value
}

function lines(value: unknown): number {
  if (value === undefined) return DEFAULT_TERMINAL_READ_LINES
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TERMINAL_READ_LINES
  ) {
    throw new TerminalArgsError(`"lines" must be an integer from 1 to ${MAX_TERMINAL_READ_LINES}`)
  }
  return value
}

function flag(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TerminalArgsError(`"${key}" must be a boolean`)
  return value
}

/** The call a tool's arguments ask for, checked; throws a TerminalArgsError otherwise. */
export function terminalCallOf(
  name: TerminalToolName,
  sessionId: string,
  input: unknown,
  context: { agentId: AgentId | null; folder: string | null },
): TerminalCall {
  const given = args(input)
  switch (name) {
    case 'terminal_run': {
      const command = typed(given.command, 'command', false)
      if (!context.agentId || !context.folder) {
        throw new TerminalArgsError('This session has no folder to open a terminal in')
      }
      return { kind: 'run', sessionId, agentId: context.agentId, folder: context.folder, command }
    }
    case 'terminal_read':
    case 'terminal_wait':
      return {
        kind: name === 'terminal_read' ? 'read' : 'wait',
        sessionId,
        terminalId: terminalId(given.terminalId),
        lines: lines(given.lines),
      }
    case 'terminal_input':
      return {
        kind: 'input',
        sessionId,
        terminalId: terminalId(given.terminalId),
        text: typed(given.text, 'text', true),
        enter: flag(given.enter, 'enter', true),
      }
    case 'terminal_stop':
      return {
        kind: 'stop',
        sessionId,
        terminalId: terminalId(given.terminalId),
        close: flag(given.close, 'close', false),
      }
  }
}

function failure(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code, message },
    isError: true,
  }
}

function reply(text: string, value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: value }
}

function describe(terminal: AgentTerminal): string {
  const state =
    terminal.exitCode !== null
      ? `the shell exited with code ${terminal.exitCode}`
      : terminal.password
        ? `${terminal.title} waits for the user to type a password in it; ask them to, then call terminal_wait`
        : terminal.busy
          ? `running ${terminal.title}`
          : 'idle at the prompt'
  return `Terminal ${terminal.id}: ${state}.`
}

const WAIT_REASONS: Record<TerminalWaitReason, string> = {
  ended: 'Its command ended.',
  exited: 'Its shell exited.',
  password: 'It waits for a password.',
  quiet: `Its output has been quiet for ${TERMINAL_QUIET_MS / 1000} s.`,
  idle: 'No command runs in it.',
  timeout: `It still runs after ${TERMINAL_WAIT_MS / 1000} s; call terminal_wait again to keep waiting.`,
}

export class TerminalTools {
  constructor(private readonly deps: TerminalToolDeps) {}

  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    if (!isTerminalToolName(name)) throw new Error(`Unknown tool ${name}`)
    const sessionId = this.deps.sessionOf(caller.sessionId)
    let call: TerminalCall
    try {
      call = terminalCallOf(name, sessionId, input, {
        agentId: this.deps.agentOf(sessionId),
        folder: this.deps.folderOf(sessionId),
      })
    } catch (error) {
      if (error instanceof TerminalArgsError) return failure('invalid_params', error.message)
      throw error
    }
    return this.answer(await this.deps.call(call))
  }

  /** The answer as text and as the same values structured, which some harnesses read alone. */
  private answer(answer: TerminalCallAnswer): CallToolResult {
    if ('error' in answer) return failure(answer.error.code, answer.error.message)
    const { result } = answer
    switch (result.kind) {
      case 'terminal': {
        const status = describe(result.terminal)
        return reply(status, { terminal: result.terminal, status })
      }
      case 'output': {
        const status = result.reason
          ? `${describe(result.terminal)} ${WAIT_REASONS[result.reason]}`
          : describe(result.terminal)
        const output = result.output || '(no output yet)'
        return reply(`${status}\n\n${output}`, {
          terminal: result.terminal,
          status,
          output,
          ...(result.reason ? { reason: result.reason } : {}),
        })
      }
      case 'closed':
        return reply('The terminal is closed.', { closed: true })
      case 'held': {
        const status =
          'The user has taken this terminal over and still uses it. Call again to keep waiting until they hand it back.'
        return reply(status, { held: true, status })
      }
      case 'password': {
        const status =
          'The user is still typing a password into this terminal. Call again to keep waiting.'
        return reply(status, { password: true, status })
      }
    }
  }
}
