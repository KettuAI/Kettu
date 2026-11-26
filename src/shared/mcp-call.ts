// The MCP tool a tool call runs, read from the call's title as each agent writes it, so a client
// names the call when it draws it, in sessions recorded before as well.

/** The server name agents know Kettu's own MCP service by. */
export const KETTU_SERVER = 'kettu'

export interface McpCall {
  server: string
  tool: string
  /** False when a script the agent ran called the tool, so the call's input is the script. */
  direct: boolean
}

// Claude Code, dsh's own names and the ACP agents that title a call as Claude Code does.
const CLAUDE = /^mcp__(\S+?)__(\S+)$/
// Codex, Cline, dsh and Pi as Kettu's hosts title them, with a full-width colon in Chinese.
const COLON = /^kettu\s*[:：]\s*([a-z0-9_]+)$/
// Other agents' spellings; a dot is OpenCode's Code Mode, whose script calls `tools.kettu.<tool>`.
const OTHER = /^kettu([_./])([a-z0-9_]+)$/

/** The tool a call's title names, or null for a title that names no MCP tool. */
export function mcpCallOf(title: string): McpCall | null {
  const name = title.trim()
  const claude = CLAUDE.exec(name)
  if (claude) return { server: claude[1]!, tool: claude[2]!, direct: true }
  const colon = COLON.exec(name)
  if (colon) return { server: KETTU_SERVER, tool: colon[1]!, direct: true }
  const other = OTHER.exec(name)
  if (other) return { server: KETTU_SERVER, tool: other[2]!, direct: other[1] !== '.' }
  return null
}

/**
 * The tools a title names, one or, as OpenCode titles a script that calls several, a list
 * separated by commas; null unless every part names one.
 */
export function mcpCallsOf(title: string): McpCall[] | null {
  const calls = title.split(',').map(mcpCallOf)
  return calls.every((call) => call !== null) ? calls : null
}

/** The workflow tools on Kettu's MCP server that render as dedicated cards in a thread. */
export const WORKFLOW_CARD_TOOLS = {
  start: 'suggest_workflow',
  create: 'create_workflow',
  report: 'report_step',
  pick: 'pick_step_agents',
} as const

export type WorkflowCardTool = keyof typeof WORKFLOW_CARD_TOOLS

const WORKFLOW_CARD_BY_NAME = new Map<string, WorkflowCardTool>(
  Object.entries(WORKFLOW_CARD_TOOLS).map(([tool, name]) => [name, tool as WorkflowCardTool]),
)

const AGY_KETTU_PREFIX = `mcp_${KETTU_SERVER}_`

/**
 * The Kettu workflow card tool a tool call title names, or null for any other call (including
 * identically named tools on third-party MCP servers).
 */
export function workflowToolOfTitle(title: string): WorkflowCardTool | null {
  const trimmed = title.trim()
  const single = mcpCallOf(trimmed)
  if (single) {
    return single.server === KETTU_SERVER ? (WORKFLOW_CARD_BY_NAME.get(single.tool) ?? null) : null
  }
  const multi = mcpCallsOf(trimmed)
  if (multi) {
    // A script calling several Kettu tools (e.g. list_workflows then suggest_workflow): take the last card tool.
    for (let i = multi.length - 1; i >= 0; i--) {
      const call = multi[i]!
      if (call.server !== KETTU_SERVER) continue
      const tool = WORKFLOW_CARD_BY_NAME.get(call.tool)
      if (tool) return tool
    }
    return null
  }
  if (trimmed.startsWith(AGY_KETTU_PREFIX)) {
    return WORKFLOW_CARD_BY_NAME.get(trimmed.slice(AGY_KETTU_PREFIX.length)) ?? null
  }
  // A bare tool name, as some agents title a call, is Kettu's: no other tool has these names.
  return WORKFLOW_CARD_BY_NAME.get(trimmed) ?? null
}
