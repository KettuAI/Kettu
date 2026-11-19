// Calls of Kettu's own tools among an ACP agent's tool calls. Each agent names an MCP tool its own
// way, read from the name and version it gives in `initialize`; an agent not listed, or before the
// version read, keeps every row. The plan, the drafted report and memory writes show no row, as
// Claude Code's do, since the host shows them itself; a memory write that failed keeps its row.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import { isRowlessCall, isRowWhenFailed } from '../plan-tool'
import { SERVICE_NAME } from '../service-name'
import type { MapperContext, TurnScope } from '../session-updates'
import { compareVersions } from '../versions'

/**
 * How an agent names the MCP tool a call runs: in the call's title as Claude Code does,
 * `mcp__<server>__<tool>`; as agy does in the `name` it sends beside the call, `mcp_<server>_<tool>`;
 * or not at all, calling MCP tools from the code its `execute` tool runs, as `tools.<server>.<tool>`,
 * and listing them in the result's `metadata.toolCalls` as `<server>.<tool>`.
 */
export type McpNaming = 'claude' | 'agy' | 'code'

interface NamingRow {
  since: string // the first version whose naming was read
  naming: McpNaming
}

// Each comment names the version that was read.
const NAMINGS: ReadonlyMap<string, NamingRow> = new Map([
  // fake-agent 0.1.0 titles its calls as Claude Code names them.
  ['fake-agent', { since: '0.1.0', naming: 'claude' }],
  // agy 1.5.9 names the tool beside each call, in a field ACP does not have.
  ['Antigravity ACP Server', { since: '1.5.9', naming: 'agy' }],
  // OpenCode 2.0.32 reaches the MCP servers a client gives only through its Code Mode.
  ['OpenCode', { since: '2.0.32', naming: 'code' }],
])

/** How the agent `initialize` names names its MCP calls, or null when that is unknown. */
export function mcpNaming(
  info: { name: string; version: string } | null | undefined,
): McpNaming | null {
  if (!info) return null
  const row = NAMINGS.get(info.name)
  if (!row) return null
  return compareVersions(info.version, row.since) >= 0 ? row.naming : null
}

const CLAUDE_PREFIX = `mcp__${SERVICE_NAME}__`
const AGY_PREFIX = `mcp_${SERVICE_NAME}_`
// Code Mode's tool, a name OpenCode reserves for it.
const EXECUTE = 'execute'
const TOOLS_WORD = /\btools\b/g
const TOOL_REFERENCE = /\btools\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g

type Verdict = 'row' | 'none' | 'wait'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const ended = (status: acp.ToolCallUpdate['status']): boolean =>
  status === 'completed' || status === 'failed'

/** Kettu's tool a call runs, in a naming of one tool per call; null for any other call. */
function ownTool(call: acp.ToolCallUpdate, naming: 'claude' | 'agy'): string | null {
  const name = naming === 'claude' ? call.title : (call as { name?: unknown }).name
  const prefix = naming === 'claude' ? CLAUDE_PREFIX : AGY_PREFIX
  return typeof name === 'string' && name.startsWith(prefix) ? name.slice(prefix.length) : null
}

function directVerdict(call: acp.ToolCallUpdate, naming: 'claude' | 'agy'): Verdict {
  const tool = ownTool(call, naming)
  if (tool === null || !isRowlessCall(SERVICE_NAME, tool)) return 'row'
  if (!ended(call.status)) return 'wait'
  return call.status === 'failed' && isRowWhenFailed(SERVICE_NAME, tool) ? 'row' : 'none'
}

/** Whether code calls tools only as `tools.<server>.<tool>`, and only Kettu's rowless ones. */
export function callsOnlyRowless(code: string): boolean {
  let calls = 0
  for (const [, server, tool] of code.matchAll(TOOL_REFERENCE)) {
    if (!isRowlessCall(server!, tool!)) return false
    calls++
  }
  return calls > 0 && calls === (code.match(TOOLS_WORD)?.length ?? 0)
}

/** Whether the calls a script's result lists in its `metadata` all show no row. */
export function listsOnlyRowless(metadata: unknown): boolean {
  const calls = record(metadata)?.toolCalls
  if (!Array.isArray(calls) || calls.length === 0) return false
  return calls.every((item) => {
    const name = record(item)?.tool
    if (typeof name !== 'string') return false
    const dot = name.indexOf('.')
    const [server, tool] = [name.slice(0, dot), name.slice(dot + 1)]
    if (dot < 0 || !isRowlessCall(server, tool)) return false
    return !(record(item)?.status === 'error' && isRowWhenFailed(server, tool))
  })
}

/** Whether a script that ended made only calls that show no row, as its result lists them. */
function endedRowless(call: acp.ToolCallUpdate): boolean {
  return call.status === 'completed' && listsOnlyRowless(record(call.rawOutput)?.metadata)
}

function codeVerdict(call: acp.ToolCallUpdate): Verdict {
  if (call.title !== EXECUTE) return 'row'
  const code = record(call.rawInput)?.code
  if (typeof code === 'string' && !callsOnlyRowless(code)) return 'row'
  if (!ended(call.status)) return 'wait'
  return endedRowless(call) ? 'none' : 'row'
}

/** A row's call: agy's call of Kettu's tool under Claude Code's name for it, not "Run <name>". */
function titled<T extends acp.ToolCallUpdate>(call: T, naming: McpNaming): T {
  if (naming !== 'agy') return call
  const tool = ownTool(call, naming)
  return tool !== null ? { ...call, title: `${CLAUDE_PREFIX}${tool}` } : call
}

/** Calls that may show no row, held from their first update to their end, per turn. */
const heldCalls = new WeakMap<TurnScope, Map<string, acp.ToolCallUpdate>>()

/** The call as its updates so far tell it, and forgets it. */
function release<T extends acp.ToolCallUpdate>(ctx: MapperContext, update: T): T {
  const calls = heldCalls.get(ctx.scope)
  const held = calls?.get(update.toolCallId)
  if (!held) return update
  calls!.delete(update.toolCallId)
  const given = Object.entries(update).filter(([, value]) => value != null)
  return { ...held, ...Object.fromEntries(given) } as T
}

/**
 * The update the mapper reads for a tool call, or null while it shows no row. A call of Kettu's
 * that may show none is held until it ends, then shows only if it must, with what its updates said.
 */
export function ownCall<T extends acp.ToolCallUpdate>(
  update: T,
  naming: McpNaming | null,
  ctx: MapperContext,
): T | null {
  if (naming === null) return update
  const call = release(ctx, update)
  // A call whose row the thread has, such as one that asked for permission, keeps it.
  if (ctx.thread.byId[`t:${call.toolCallId}`]) return titled(call, naming)
  const verdict = naming === 'code' ? codeVerdict(call) : directVerdict(call, naming)
  if (verdict === 'wait') {
    let calls = heldCalls.get(ctx.scope)
    if (!calls) {
      calls = new Map()
      heldCalls.set(ctx.scope, calls)
    }
    calls.set(call.toolCallId, call)
    return null
  }
  return verdict === 'row' ? titled(call, naming) : null
}

/** A call that asks for permission, which keeps its row whatever it runs. */
export function askedCall<T extends acp.ToolCallUpdate>(
  update: T,
  naming: McpNaming | null,
  ctx: MapperContext,
): T {
  return naming === null ? update : titled(release(ctx, update), naming)
}
