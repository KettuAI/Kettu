// The `terminal_*` tools on Kettu's MCP service: an agent runs a command in a terminal tab of its
// session, where the user sees it and can take it over, then reads, types into and stops it. Kettu
// checks every argument here, and the terminal host lets a session reach only its own terminals:
// those its agent opened freely, those the user opened once the user allows it, which is asked here.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { CONTROL_WAIT_MS, type SurfaceAccessAnswer } from '@shared/control'
import { MAX_TERMINAL_NAME, terminalName } from '@shared/terminal-host'
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
  description: 'The terminal id that terminal_run or terminal_list gave.',
}
const ACTS = { readOnlyHint: false, openWorldHint: false } as const
const NAME: Schema = {
  type: 'string',
  maxLength: MAX_TERMINAL_NAME,
  description: `A short name for the tab, at most ${MAX_TERMINAL_NAME} characters, such as "Dev server".`,
}
const LINES: Schema = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_TERMINAL_READ_LINES,
  default: DEFAULT_TERMINAL_READ_LINES,
}

// A terminal the user opened is theirs: the first call on it asks them, and waits for the answer.
const USERS =
  ' A terminal the user opened needs their allow: your first call on it asks them in the conversation and waits for the answer; when it returns that they have not answered yet, call again to keep waiting.'

export const TERMINAL_TOOLS: Tool[] = [
  {
    name: 'terminal_list',
    title: 'List terminals',
    description:
      "This session's terminals beside the conversation, the ones the user opened included: each one's id, name, what runs in it, who opened it and whether you may use it now. Use it to pick up a terminal the user worked in, then read its output with terminal_read." +
      USERS,
    inputSchema: object({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'terminal_run',
    title: 'Run in a terminal',
    description:
      "Opens a new terminal tab in this session's folder, beside the conversation, and runs a one-line command in the user's shell, such as a dev server, a watcher or a long build. The user sees it and can take it over. Give it a short `name` that says what it is for; without one the tab shows the command. Returns the terminal's id; read its output with terminal_read.",
    inputSchema: object(
      { command: { type: 'string', description: 'One line, run as typed.' }, name: NAME },
      ['command'],
    ),
    annotations: { ...ACTS, destructiveHint: true },
  },
  {
    name: 'terminal_read',
    title: 'Read a terminal',
    description:
      "The latest output of one of this session's terminals, as plain text, whether its command still runs, whether it waits for the user's password, and the shell's exit code. The output is what the terminal keeps, its last 1 MB, not the shell's history file." +
      USERS,
    inputSchema: object({ terminalId: TERMINAL_ID, lines: LINES }, ['terminalId']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'terminal_wait',
    title: 'Wait on a terminal',
    description: `Waits until the terminal's command ends, it waits for the user's password, or its output has been quiet for ${TERMINAL_QUIET_MS / 1000} s (such as a server that is up), at most ${TERMINAL_WAIT_MS / 1000} s, then answers like terminal_read and says why it returned. Call it again to keep waiting.${USERS}`,
    inputSchema: object({ terminalId: TERMINAL_ID, lines: LINES }, ['terminalId']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'terminal_input',
    title: 'Type into a terminal',
    description:
      "Types text into one of this session's terminals, and presses Enter when `enter` is set, such as the next command in a terminal the user handed you or an answer to a prompt. Never types a password: only the user does. While the user has taken the terminal over or types a password into it, the call waits; when it returns that they still do, call again to keep waiting." +
      USERS,
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
      "Sends Ctrl+C to one of this session's terminals, stopping its command. `close` also ends the shell and closes the tab. Waits like terminal_input while the user has it." +
      USERS,
    inputSchema: object({ terminalId: TERMINAL_ID, close: { type: 'boolean', default: false } }, [
      'terminalId',
    ]),
    annotations: { ...ACTS },
  },
  {
    name: 'terminal_rename',
    title: 'Rename a terminal',
    description:
      "Names one of this session's terminal tabs; an empty name goes back to what it runs. You may rename the terminals you opened and those the user lets you use, unless the user named them. A name the user gave, or a terminal of theirs you may not use yet, asks the user first and waits for the answer, unless the user asked you for this rename in the conversation: then set `userAsked` and it is renamed at once. Never set `userAsked` on your own initiative.",
    inputSchema: object(
      {
        terminalId: TERMINAL_ID,
        name: {
          ...NAME,
          description: `${String(NAME.description)} Empty goes back to the automatic name.`,
        },
        userAsked: {
          type: 'boolean',
          default: false,
          description: 'The user asked you in the conversation to give this terminal this name.',
        },
      },
      ['terminalId', 'name'],
    ),
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  },
]

// What terminal_input says instead once the user lets agents type passwords.
const PASSWORD_DESCRIPTIONS: Partial<Record<TerminalToolName, string>> = {
  terminal_input:
    "Types text into one of this session's terminals, and presses Enter when `enter` is set, such as the next command in a terminal the user handed you or an answer to a prompt. Types a password only when the user gave it to you for that or the project's files hold it, such as a test account's; otherwise the user types it. While the user has taken the terminal over, the call waits; when it returns that they still have it, call again to keep waiting." +
    USERS,
}

const PASSWORD_TOOLS: Tool[] = TERMINAL_TOOLS.map((tool) => {
  const description = PASSWORD_DESCRIPTIONS[tool.name as TerminalToolName]
  return description ? { ...tool, description } : tool
})

/**
 * The tools that only list and read the session's terminals, which run without the agent's own
 * permission prompt: on a terminal of the user's, Kettu asks them in its own card instead.
 */
export const TERMINAL_READ_TOOLS: readonly TerminalToolName[] = [
  'terminal_list',
  'terminal_read',
  'terminal_wait',
  // Touches nothing in a terminal; a name or terminal of the user's asks them in Kettu's card.
  'terminal_rename',
]

/** 仅在 Auto 模式下自动放行的非破坏性终端控制工具（运行与输入命令单独做安全判定）。 */
export const TERMINAL_AUTO_MODE_TOOLS: readonly TerminalToolName[] = ['terminal_stop']

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
  /** What the session's permission mode lets it: full access asks nothing, planning only reads. */
  accessOf(sessionId: string): { fullAccess: boolean; planning: boolean }
  /**
   * Asks the user in the session's thread whether its agent may use a terminal they opened, or with
   * `rename`, give it that name.
   */
  ask(
    sessionId: string,
    terminal: AgentTerminal,
    ask: { readOnly: boolean; rename?: string; passwords?: boolean },
  ): Promise<SurfaceAccessAnswer>
  /** Full access let the agent use a terminal the user opened without asking. */
  used(sessionId: string, terminal: AgentTerminal): void
  /** The user referenced the terminal in a message to the session, which allows it. */
  shared(sessionId: string, terminalId: string): boolean
  /** Whether the user lets agents type passwords, read at each call; without it they do not. */
  passwords?(): boolean
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

function terminalNameArg(value: unknown): string {
  if (typeof value !== 'string') throw new TerminalArgsError('"name" must be a string')
  const named = terminalName(value)
  if ('problem' in named) throw new TerminalArgsError(named.problem)
  return named.name ?? ''
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
  context: {
    agentId: AgentId | null
    folder: string | null
    planning?: boolean
    fullAccess?: boolean
    passwords?: boolean
  },
): TerminalCall {
  const given = args(input)
  switch (name) {
    case 'terminal_list':
      return { kind: 'list', sessionId }
    case 'terminal_run': {
      const command = typed(given.command, 'command', false)
      if (!context.agentId || !context.folder) {
        throw new TerminalArgsError('This session has no folder to open a terminal in')
      }
      const name = given.name === undefined ? undefined : terminalNameArg(given.name)
      return {
        kind: 'run',
        sessionId,
        agentId: context.agentId,
        folder: context.folder,
        command,
        ...(name ? { name } : {}),
      }
    }
    case 'terminal_rename':
      return {
        kind: 'rename',
        sessionId,
        terminalId: terminalId(given.terminalId),
        name: terminalNameArg(given.name),
        // Full access asks nothing; the user asking for it is their answer.
        asked: flag(given.userAsked, 'userAsked', false) || context.fullAccess === true,
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
        ...(context.planning ? { readOnly: true } : {}),
        ...(context.passwords ? { passwords: true } : {}),
      }
    case 'terminal_stop':
      return {
        kind: 'stop',
        sessionId,
        terminalId: terminalId(given.terminalId),
        close: flag(given.close, 'close', false),
        ...(context.planning ? { readOnly: true } : {}),
        ...(context.passwords ? { passwords: true } : {}),
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

const OPENERS: Record<AgentTerminal['opener'], string> = {
  agent: 'You opened it.',
  reply: 'The user ran it from your reply.',
  user: 'The user opened it.',
}

const NAMERS: Record<NonNullable<AgentTerminal['namedBy']>, string> = {
  user: ' The user named it.',
  agent: ' You named it.',
}

function listed(terminal: AgentTerminal, passwords: boolean): string {
  const use = terminal.usable ? '' : ' Ask first: your first call on it asks the user to allow it.'
  const by = terminal.namedBy ? NAMERS[terminal.namedBy] : ''
  return `- ${describe(terminal, passwords)}${by} ${OPENERS[terminal.opener]}${use}`
}

/** `passwords`: the user lets agents type passwords. */
function describe(terminal: AgentTerminal, passwords: boolean): string {
  const state =
    terminal.exitCode !== null
      ? `the shell exited with code ${terminal.exitCode}`
      : terminal.password
        ? passwords
          ? `${terminal.title} waits for a password; type it with terminal_input if the user gave it to you for that or the project's files hold it, otherwise ask the user to type it there, then call terminal_wait`
          : `${terminal.title} waits for the user to type a password in it; ask them to, then call terminal_wait`
        : terminal.busy
          ? `running ${terminal.title}`
          : 'idle at the prompt'
  const name = terminal.name ? ` "${terminal.name}"` : ''
  return `Terminal ${terminal.id}${name}: ${state}.`
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
  // The user's answer each terminal of theirs waits on, by session and terminal, so a call made
  // again while they decide waits on the same card rather than asking twice.
  private readonly asking = new Map<string, Promise<SurfaceAccessAnswer>>()

  constructor(private readonly deps: TerminalToolDeps) {}

  /** `tools` as agents are told them now: the terminal tools say who types a password. */
  listed(tools: Tool[]): Tool[] {
    if (!this.passwords) return tools
    return tools.map((tool) => PASSWORD_TOOLS.find((typed) => typed.name === tool.name) ?? tool)
  }

  private get passwords(): boolean {
    return this.deps.passwords?.() === true
  }

  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    if (!isTerminalToolName(name)) throw new Error(`Unknown tool ${name}`)
    const sessionId = this.deps.sessionOf(caller.sessionId)
    const access = this.deps.accessOf(sessionId)
    let call: TerminalCall
    try {
      call = terminalCallOf(name, sessionId, input, {
        agentId: this.deps.agentOf(sessionId),
        folder: this.deps.folderOf(sessionId),
        planning: access.planning,
        fullAccess: access.fullAccess,
        passwords: this.passwords,
      })
    } catch (error) {
      if (error instanceof TerminalArgsError) return failure('invalid_params', error.message)
      throw error
    }
    const answer = await this.deps.call(call)
    if ('result' in answer && answer.result.kind === 'ask') {
      return call.kind === 'rename'
        ? this.askRename(call, answer.result.terminal)
        : this.askFirst(call, answer.result.terminal, access)
    }
    return this.answer(answer)
  }

  /**
   * A rename of a name the user gave, or of a terminal of theirs: their card's answer renames it
   * this once, without allowing the terminal itself.
   */
  private async askRename(
    call: Extract<TerminalCall, { kind: 'rename' }>,
    terminal: AgentTerminal,
  ): Promise<CallToolResult> {
    const { sessionId } = call
    const key = `${sessionId}\n${terminal.id}\nrename\n${call.name}`
    let asking = this.asking.get(key)
    if (!asking) {
      void this.deps.call({ kind: 'asking', sessionId, terminalId: terminal.id, asking: true })
      asking = this.deps
        .ask(sessionId, terminal, { readOnly: false, rename: call.name })
        .then(async (answer) => {
          await this.deps.call({
            kind: 'asking',
            sessionId,
            terminalId: terminal.id,
            asking: false,
          })
          return answer
        })
        .finally(() => this.asking.delete(key))
      this.asking.set(key, asking)
    }
    const decision = await this.waitFor(asking)
    if (decision === 'waiting') {
      const status = `The user has not answered yet whether you may rename their terminal "${terminal.name ?? terminal.title}". Call again to keep waiting.`
      return reply(status, { asking: true, status })
    }
    if (decision !== 'allow') {
      return failure('not_allowed', 'The user kept the name of their terminal.')
    }
    return this.answer(await this.deps.call({ ...call, asked: true }))
  }

  /** The answer, or `waiting` once CONTROL_WAIT_MS passed without one. */
  private async waitFor(
    asking: Promise<SurfaceAccessAnswer>,
  ): Promise<SurfaceAccessAnswer | 'waiting'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const decision = await Promise.race([
      asking,
      new Promise<'waiting'>((resolve) => {
        timer = setTimeout(() => resolve('waiting'), CONTROL_WAIT_MS)
      }),
    ])
    clearTimeout(timer)
    return decision
  }

  /**
   * A terminal the user opened: Full access goes ahead, any other mode asks the user in a card and
   * waits up to CONTROL_WAIT_MS before telling the agent to call again. Once allowed, the call runs.
   */
  private async askFirst(
    call: TerminalCall,
    terminal: AgentTerminal,
    access: { fullAccess: boolean; planning: boolean },
  ): Promise<CallToolResult> {
    const { sessionId } = call
    let decision: SurfaceAccessAnswer | 'waiting'
    if (this.deps.shared(sessionId, terminal.id)) {
      // The user referenced it in the conversation, which allows it.
      decision = await this.grant(sessionId, terminal.id)
    } else if (access.fullAccess) {
      decision = await this.grant(sessionId, terminal.id)
      if (decision === 'allow') this.deps.used(sessionId, terminal)
    } else {
      const key = `${sessionId}\n${terminal.id}`
      let asking = this.asking.get(key)
      if (!asking) {
        void this.deps.call({ kind: 'asking', sessionId, terminalId: terminal.id, asking: true })
        // The allow is given as the answer comes, so a call made after it finds the terminal open.
        asking = this.deps
          .ask(sessionId, terminal, {
            readOnly: access.planning,
            ...(this.passwords ? { passwords: true } : {}),
          })
          .then(async (answer) => {
            if (answer === 'allow') return this.grant(sessionId, terminal.id)
            await this.deps.call({
              kind: 'asking',
              sessionId,
              terminalId: terminal.id,
              asking: false,
            })
            return answer
          })
          .finally(() => this.asking.delete(key))
        this.asking.set(key, asking)
      }
      decision = await this.waitFor(asking)
    }
    if (decision === 'waiting') {
      const status = `The user has not answered yet whether you may use their terminal "${terminal.title}". Call again to keep waiting.`
      return reply(status, { asking: true, status })
    }
    if (decision !== 'allow') {
      return failure(
        'not_allowed',
        `The user did not allow this session to use their terminal "${terminal.title}". Do not ask again unless they bring it up.`,
      )
    }
    const answer = await this.deps.call(call)
    if ('result' in answer && answer.result.kind === 'ask') {
      return failure('not_allowed', `The user took their terminal "${terminal.title}" back.`)
    }
    return this.answer(answer)
  }

  /** Tells the terminal host the agent may use the terminal; `deny` when it is gone. */
  private async grant(sessionId: string, terminalId: string): Promise<SurfaceAccessAnswer> {
    const answer = await this.deps.call({ kind: 'allow', sessionId, terminalId, allowed: true })
    return 'error' in answer ? 'deny' : 'allow'
  }

  /** The answer as text and as the same values structured, which some harnesses read alone. */
  private answer(answer: TerminalCallAnswer): CallToolResult {
    if ('error' in answer) return failure(answer.error.code, answer.error.message)
    const { result } = answer
    switch (result.kind) {
      case 'terminal': {
        const status = describe(result.terminal, this.passwords)
        return reply(status, { terminal: result.terminal, status })
      }
      case 'output': {
        const described = describe(result.terminal, this.passwords)
        const status = result.reason ? `${described} ${WAIT_REASONS[result.reason]}` : described
        const output = result.output || '(no output yet)'
        return reply(`${status}\n\n${output}`, {
          terminal: result.terminal,
          status,
          output,
          ...(result.reason ? { reason: result.reason } : {}),
        })
      }
      case 'list': {
        const text =
          result.terminals.length === 0
            ? 'This session has no terminals. Open one with terminal_run.'
            : `This session's terminals:\n${result.terminals.map((terminal) => listed(terminal, this.passwords)).join('\n')}`
        return reply(text, { terminals: result.terminals })
      }
      case 'ask':
        return failure('not_allowed', 'The user has not allowed this terminal.')
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
