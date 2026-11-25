// agy's tool calls in the shape the ACP mapper reads every agent's. agy 1.5.9 sends its tool's own
// name beside each call, a command's input as `{ CommandLine, toolSummary }`, its output under a
// header of times and the exit code, and an MCP server's tool as `mcp_<server>_<tool>`. A command
// that went on in the background ends without the times (1.5.15), and one a signal ended says so in
// place of its exit code. It keeps what it writes for itself, such as a Plan mode plan, in
// `~/.gemini/antigravity-cli/brain/`.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import { fenced } from '../codex/mapper'
import { unsafeCommand, type Shell } from '../command-safety'
import type { McpServer } from '../connection'
import { GUIDE_TOOL } from '../guide/guide'
import { SERVICE_NAME } from '../service-name'
import { toLf, type MapperContext, type TurnScope } from '../session-updates'
import { GATEWAY_TOOL } from '../tool-gateway'

const RESULT =
  /^(?:Created At: [^\n]*\n)?(?:Completed At: [^\n]*\n)?(Command exited with code (-?\d+)\.|Command was terminated by signal or canceled\.)\n\n/
const OUTPUT = 'Command output:\n'
const NO_OUTPUT = 'No output from the command.'
const OWN_FOLDER = /(?:^|\/)\.gemini\/antigravity-cli\/brain\//
const OWN_PREFIX = `mcp_${SERVICE_NAME}_`
const GATEWAY_NAME = `${OWN_PREFIX}${GATEWAY_TOOL}`
const TERMINAL_RUN_NAME = `${OWN_PREFIX}terminal_run`

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The name agy gives the tool beside the call, which ACP has no field for. */
function toolName(update: acp.ToolCallUpdate): string | null {
  const name = (update as { name?: unknown }).name
  return typeof name === 'string' ? name : null
}

/** agy 会话按权限模式分层的 MCP 自动放行名单。 */
export interface AgyAutoAllow {
  /** 所有权限模式下均可直接放行的 MCP 工具名（如只读查询与 Kettu 内部管理类工具）。 */
  readonly always: ReadonlySet<string>
  /** 仅在 Auto 权限模式下自动放行的可回滚 MCP 工具名。 */
  readonly onAuto: ReadonlySet<string>
  /** 当前会话是否挂载了 Kettu 内置 MCP 服务（用于限定安全命令动态判定范围）。 */
  readonly hasKettu: boolean
}

/**
 * 收集 agy 会话挂载的 MCP 服务器的自动放行名单（分为全模式放行与仅 Auto 模式放行）。
 */
export function agyAutoAllowed(servers: readonly McpServer[] | undefined): AgyAutoAllow {
  const always = new Set<string>()
  const onAuto = new Set<string>()
  let hasKettu = false
  for (const server of servers ?? []) {
    if (server.type === 'stdio') continue
    if (server.name === SERVICE_NAME) hasKettu = true
    for (const tool of server.autoAllow ?? []) always.add(`mcp_${server.name}_${tool}`)
    for (const tool of server.autoModeAllow ?? []) onAuto.add(`mcp_${server.name}_${tool}`)
  }
  return { always, onAuto, hasKettu }
}

/**
 * A call of Kettu's gateway as the call of the tool it runs, so it asks, shows and is held as a
 * direct call of that tool is. agy 1.5.14 repeats the name and input on every update of a call. A
 * call without `arguments`, which only describes a tool, stays the gateway's.
 */
export function throughGateway<T extends acp.ToolCallUpdate>(update: T): T {
  if (toolName(update) !== GATEWAY_NAME) return update
  const input = record(update.rawInput)
  const tool = input?.tool
  const args = record(input?.arguments)
  if (typeof tool !== 'string' || !args) return update
  const name = `${OWN_PREFIX}${tool}`
  const summary = input!.toolSummary
  const rawInput = typeof summary === 'string' ? { ...args, toolSummary: summary } : args
  return {
    ...update,
    name,
    title: `Run ${name}`,
    rawInput,
    ...('args' in update ? { args: rawInput } : {}),
  }
}

/** Whether a call of the gateway only describes a tool, which runs nothing. */
function describesOnly(toolCall: acp.ToolCallUpdate): boolean {
  if (toolName(toolCall) !== GATEWAY_NAME) return false
  const input = record(toolCall.rawInput)
  return typeof input?.tool === 'string' && input.arguments === undefined
}

/** 判断 terminal_run 在 Auto 模式下运行的命令是否属于可回滚的安全命令。 */
function isSafeTerminalRun(toolCall: acp.ToolCallUpdate, shell: Shell): boolean {
  const command = record(toolCall.rawInput)?.command
  return typeof command === 'string' && command.trim() !== '' && !unsafeCommand(command, shell)
}

/**
 * 判断 agy 的 MCP 工具调用是否可直接回复 allow_once：
 * - 命中全模式白名单或仅查询 Kettu 网关工具说明时直接放行；
 * - 处于 Auto 权限模式时，额外放行可回滚的 Kettu 内置工具与通过安全检查的 terminal_run；
 * - 不可逆操作（删除、危险命令、桌面操控、第三方外部 MCP 等）返回 null 交由用户确认。
 */
export function agyAllowOnce(
  toolCall: acp.ToolCallUpdate,
  options: readonly acp.PermissionOption[],
  allowed: AgyAutoAllow | undefined,
  autoMode = false,
  shell: Shell = process.platform === 'win32' ? 'powershell' : 'posix',
): string | null {
  const name = toolName(toolCall)
  if (name === null || !allowed) return null
  const lookup = describesOnly(toolCall) && allowed.always.has(`${OWN_PREFIX}${GUIDE_TOOL}`)
  const allow =
    lookup ||
    allowed.always.has(name) ||
    (autoMode &&
      (allowed.onAuto.has(name) ||
        (name === TERMINAL_RUN_NAME && allowed.hasKettu && isSafeTerminalRun(toolCall, shell))))
  if (!allow) return null
  return options.find((option) => option.kind === 'allow_once')?.optionId ?? null
}

/**
 * What a finished command printed, the line that says how it ended, and its exit code, null for
 * one a signal ended; null for a result of another shape.
 */
function commandResult(
  text: string,
): { output: string; ending: string; exitCode: number | null } | null {
  const match = RESULT.exec(toLf(text))
  if (!match) return null
  const rest = toLf(text).slice(match[0].length)
  const output = rest.startsWith(OUTPUT)
    ? rest.slice(OUTPUT.length)
    : rest === NO_OUTPUT
      ? ''
      : null
  if (output === null) return null
  return {
    output: output.replace(/\n+$/, ''),
    ending: match[1]!,
    exitCode: match[2] === undefined ? null : Number(match[2]),
  }
}

/** The text of a command call's result, when it carries one. */
function resultText(update: acp.ToolCallUpdate): string | null {
  const block = update.content?.length === 1 ? update.content[0] : undefined
  return block?.type === 'content' && block.content.type === 'text' ? block.content.text : null
}

/** The line that says how a finished command of agy's ended, such as its exit code; null for none. */
export function commandEnding(update: acp.ToolCallUpdate): string | null {
  const text = resultText(update)
  return text === null ? null : (commandResult(text)?.ending ?? null)
}

/** A command's call: its command line with what it says it does, and what it printed. */
function command(update: acp.ToolCallUpdate, line: string, summary: unknown): acp.ToolCallUpdate {
  const shaped: acp.ToolCallUpdate = {
    ...update,
    rawInput:
      typeof summary === 'string' ? { command: line, description: summary } : { command: line },
  }
  const text = resultText(update)
  const result = text === null ? null : commandResult(text)
  if (!result) return shaped
  shaped.content = result.output
    ? [{ type: 'content', content: { type: 'text', text: fenced(result.output) } }]
    : []
  // agy reports a command that exited non-zero as completed; Claude Code and Codex fail it.
  if (update.status === 'completed' && result.exitCode !== 0) shaped.status = 'failed'
  return shaped
}

/** An agy tool call in the shape the mapper reads every agent's. */
export function fromAgy<T extends acp.ToolCallUpdate>(update: T): T {
  const input = record(update.rawInput)
  if (typeof input?.CommandLine === 'string') {
    return command(update, input.CommandLine, input.toolSummary) as T
  }
  // An ask is titled by its first question, as Claude Code's is, not "Run ask_question".
  if (toolName(update) === 'ask_question' && Array.isArray(input?.questions)) {
    const first = record(input.questions[0])?.question
    if (typeof first === 'string' && first !== '') return { ...update, title: first }
  }
  return update
}

/**
 * agy's `edit_file` request with the whole file in place of the snippet it names: agy's request
 * carries its `Target` and `Replacement` as the diff, which shows with wrong line numbers and a
 * changed last line, while the finished call carries the whole file's. `read` gives the file's
 * text; a file that cannot be read, or has the target not exactly once, leaves the snippet.
 */
export async function inWholeFile<T extends acp.ToolCallUpdate>(
  update: T,
  read: (path: string) => Promise<string | null>,
): Promise<T> {
  if (toolName(update) !== 'edit_file') return update
  const input = record(update.rawInput)
  const { Path: file, Target: target, Replacement: replacement } = input ?? {}
  if (typeof file !== 'string' || typeof target !== 'string' || typeof replacement !== 'string') {
    return update
  }
  if (target === '') return update
  const text = await read(file)
  if (text === null) return update
  const at = text.indexOf(target)
  if (at < 0 || text.indexOf(target, at + 1) >= 0) return update
  const edited = text.slice(0, at) + replacement + text.slice(at + target.length)
  return { ...update, content: [{ type: 'diff', path: file, oldText: text, newText: edited }] }
}

/** Calls on agy's own files that show no row, per turn, for their updates that name no file. */
const ownFileCalls = new WeakMap<TurnScope, Set<string>>()

/**
 * Whether a call works only on files agy keeps for itself, which are agy's, not the project's: it
 * shows no row and changes nothing in the project. A call whose row the thread has keeps it.
 */
export function onAgyOwnFiles(update: acp.ToolCallUpdate, ctx: MapperContext): boolean {
  if (ctx.thread.byId[`t:${update.toolCallId}`]) return false
  let calls = ownFileCalls.get(ctx.scope)
  if (calls?.has(update.toolCallId)) return true
  const paths = (update.locations ?? []).map((location) => location.path.replace(/\\/g, '/'))
  if (paths.length === 0 || !paths.every((path) => OWN_FOLDER.test(path))) return false
  if (!calls) {
    calls = new Set()
    ownFileCalls.set(ctx.scope, calls)
  }
  calls.add(update.toolCallId)
  return true
}
