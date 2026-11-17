// agy's tool calls in the shape the ACP mapper reads every agent's. agy 1.5.9 sends its tool's own
// name beside each call, a command's input as `{ CommandLine, toolSummary }`, its output under a
// header of times and the exit code, and an MCP server's tool as `mcp_<server>_<tool>`. It keeps
// what it writes for itself, such as a Plan mode plan, in `~/.gemini/antigravity-cli/brain/`.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import { fenced } from '../codex/mapper'
import type { McpServer } from '../connection'
import { toLf, type MapperContext, type TurnScope } from '../session-updates'

const RESULT = /^Created At: [^\n]*\nCompleted At: [^\n]*\nCommand exited with code (-?\d+)\.\n\n/
const OUTPUT = 'Command output:\n'
const NO_OUTPUT = 'No output from the command.'
const OWN_FOLDER = /(?:^|\/)\.gemini\/antigravity-cli\/brain\//

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

/** The option that allows a call once, for a call of one of those tools; null for any other. */
export function agyAllowOnce(
  toolCall: acp.ToolCallUpdate,
  options: readonly acp.PermissionOption[],
  allowed: ReadonlySet<string> | undefined,
): string | null {
  const name = toolName(toolCall)
  if (name === null || !allowed?.has(name)) return null
  return options.find((option) => option.kind === 'allow_once')?.optionId ?? null
}

/** What a finished command printed, and its exit code; null for a result of another shape. */
function commandResult(text: string): { output: string; exitCode: number } | null {
  const match = RESULT.exec(toLf(text))
  if (!match) return null
  const rest = toLf(text).slice(match[0].length)
  const output = rest.startsWith(OUTPUT)
    ? rest.slice(OUTPUT.length)
    : rest === NO_OUTPUT
      ? ''
      : null
  if (output === null) return null
  return { output: output.replace(/\n+$/, ''), exitCode: Number(match[1]) }
}

/** A command's call: its command line with what it says it does, and what it printed. */
function command(update: acp.ToolCallUpdate, line: string, summary: unknown): acp.ToolCallUpdate {
  const shaped: acp.ToolCallUpdate = {
    ...update,
    rawInput:
      typeof summary === 'string' ? { command: line, description: summary } : { command: line },
  }
  const block = update.content?.length === 1 ? update.content[0] : undefined
  if (block?.type !== 'content' || block.content.type !== 'text') return shaped
  const result = commandResult(block.content.text)
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
  return update
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
