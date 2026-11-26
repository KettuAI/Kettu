// Identifies interruptible wait tool calls (such as Codex's clock.sleep or Claude Code's Sleep
// tool) so workflow handoffs can wake a reused step session without interrupting real tool work.

import type { ThreadEntry } from '@shared/thread'

/** Matches standalone sleep tool names across native tools, MCP prefixes, and server:tool labels. */
const SLEEP_TOOL_NAME =
  /^(?:sleep|clock[.:：/]sleep|mcp__[a-z0-9_.-]+__sleep|[^:：\s]+[:：]\s*sleep)$/i

/** Whether a built-in, dynamic, or MCP tool name represents an interruptible sleep/wait tool. */
export function isSleepToolName(name: string): boolean {
  return SLEEP_TOOL_NAME.test(name.trim())
}

/** Whether an MCP server + tool pair represents an interruptible sleep/wait call. */
export function isSleepMcpTool(server: string, tool: string): boolean {
  const cleanTool = tool.trim().toLowerCase()
  if (cleanTool === 'sleep' || cleanTool === 'clock.sleep') return true
  return server.trim().toLowerCase() === 'clock' && cleanTool === 'sleep'
}

/** Whether an in-progress thread entry represents an interruptible sleep/wait tool call. */
export function isSleepToolEntry(entry: ThreadEntry): boolean {
  return (
    entry.kind === 'tool' &&
    entry.toolKind === 'other' &&
    (entry.status === 'pending' || entry.status === 'in_progress') &&
    isSleepToolName(entry.title)
  )
}
