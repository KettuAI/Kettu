// agy's tool calls in the shape the ACP mapper reads every agent's. agy 1.5.9 sends its tool's own
// name beside each call, a command's input as `{ CommandLine, toolSummary }`, its output under a
// header of times and the exit code, and an MCP server's tool as `mcp_<server>_<tool>`. A command
// that went on in the background ends without the times (1.5.15), and one a signal ended says so in
// place of its exit code. It keeps what it writes for itself, such as a Plan mode plan, in
// `~/.gemini/antigravity-cli/brain/`.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import { fenced } from '../codex/mapper'
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

/**
 * agy's names for the tools a session's MCP servers run without asking, the set Claude Code's and
 * Codex's settings are given.
 */
export function agyAutoAllowed(servers: readonly McpServer[] | undefined): ReadonlySet<string> {
  return new Set(
    (servers ?? []).flatMap((server) =>
      server.type === 'stdio'
        ? []
        : (server.autoAllow ?? []).map((tool) => `mcp_${server.name}_${tool}`),
    ),
  )
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

/**
 * The option that allows a call once, for a call of one of those tools, or of Kettu's gateway that
 * only describes a tool while Kettu's server is the session's; null for any other. A gateway call
 * that runs a tool is decided as that tool, after `throughGateway`.
 */
export function agyAllowOnce(
  toolCall: acp.ToolCallUpdate,
  options: readonly acp.PermissionOption[],
  allowed: ReadonlySet<string> | undefined,
): string | null {
  const name = toolName(toolCall)
  if (name === null) return null
  const lookup = describesOnly(toolCall) && allowed?.has(`${OWN_PREFIX}${GUIDE_TOOL}`) === true
  if (!lookup && !allowed?.has(name)) return null
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
