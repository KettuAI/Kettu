// agy's tool calls in the shape the ACP mapper reads every agent's. agy 1.5.9 sends its tool's own
// name beside each call, a command's input as `{ CommandLine, toolSummary }`, its output under a
// header of times and the exit code, and an MCP server's tool as `mcp_<server>_<tool>`.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import { fenced } from '../codex/mapper'
import type { McpServer } from '../connection'
import { isClaudeRowlessCall, isClaudeRowWhenFailed } from '../plan-tool'
import { SERVICE_NAME } from '../service-name'
import { toLf } from '../session-updates'

const KETTU_PREFIX = `mcp_${SERVICE_NAME}_`

const RESULT = /^Created At: [^\n]*\nCompleted At: [^\n]*\nCommand exited with code (-?\d+)\.\n\n/
const OUTPUT = 'Command output:\n'
const NO_OUTPUT = 'No output from the command.'

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

/**
 * An agy tool call as the mapper reads it, or null for a call of Kettu's own that shows no row. A
 * memory write takes Claude Code's name for it, which the mapper holds until it fails or succeeds;
 * `shown` keeps a call whose row the thread already has, such as one that asked for permission.
 */
export function fromAgy<T extends acp.ToolCallUpdate>(update: T, shown: boolean): T | null {
  const name = toolName(update)
  if (name?.startsWith(KETTU_PREFIX)) {
    const claudeName = `mcp__${SERVICE_NAME}__${name.slice(KETTU_PREFIX.length)}`
    if (isClaudeRowWhenFailed(claudeName)) return { ...update, title: claudeName }
    if (isClaudeRowlessCall(claudeName) && !shown) return null
    return update
  }
  const input = record(update.rawInput)
  if (typeof input?.CommandLine === 'string') {
    return command(update, input.CommandLine, input.toolSummary) as T
  }
  return update
}
