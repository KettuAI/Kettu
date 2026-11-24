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
