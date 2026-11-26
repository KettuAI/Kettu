// The short tool list for an agent that drops MCP tools past a budget of its own and cannot call a
// dropped one, as agy 1.5.14 over ACP: a core of Kettu's tools declared as they are, and one tool
// that runs any other. agy drops the largest tools first, so the gateway is the smallest listed.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

export const GATEWAY_TOOL = 'call_kettu_tool'
/** Finds a tool by words, among Kettu's and the servers behind the gateway. */
export const FIND_TOOL = 'find_tools'
/** The most tools a search answers with. */
const FOUND = 20

/**
 * The tools such an agent still gets declared: the entries it must reach without a lookup. With no
 * device tool in its list agy 1.5.14 ran `xcrun` for the user's simulators, so `device_list` is one.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'read_kettu_guide',
  'list_skills',
  'create_artifact',
  'update_artifact',
  'read_artifact',
  'list_artifacts',
  'set_plan',
  'suggest_next_message',
  'start_session',
  'send_message',
  'list_agents',
  'get_session',
  'remember',
  'list_workflows',
  'suggest_workflow',
  'browser_navigate',
  'device_list',
])

export const GATEWAY: Tool = {
  name: GATEWAY_TOOL,
  description:
    'Runs a Kettu tool not in your function list; leave out arguments to read its arguments.',
  inputSchema: {
    type: 'object',
    properties: { tool: { type: 'string' }, arguments: { type: 'object' } },
    required: ['tool'],
  },
}

/** The gateway for a session with MCP servers behind it too, which `server` names. */
export const GATEWAY_WITH_SERVERS: Tool = {
  ...GATEWAY,
  description:
    'Runs a tool not in your function list, Kettu’s or an MCP server’s by server; leave out ' +
    'arguments to read them.',
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string' },
      server: { type: 'string' },
      arguments: { type: 'object' },
    },
    required: ['tool'],
  },
}

export const FIND: Tool = {
  name: FIND_TOOL,
  description:
    'Finds tools not in your function list by words, among Kettu’s and your MCP servers’, with ' +
    'the server and tool to call them by with call_kettu_tool.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Words the tool’s name or use has' } },
    required: ['query'],
  },
}

/** What a harness keeps of a tool to declare it: its name, description and arguments. */
export function declared(tool: Tool): { name: string; description?: string; inputSchema: unknown } {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
}

/**
 * The list such an agent gets from the full one: its core tools there, and the gateway; with
 * servers behind the gateway, the gateway that names them and the search.
 */
export function gatewayList(tools: readonly Tool[], servers = false): Tool[] {
  const core = tools.filter((tool) => CORE_TOOLS.has(tool.name))
  return servers ? [...core, GATEWAY_WITH_SERVERS, FIND] : [...core, GATEWAY]
}

export type GatewayInput =
  { tool: string; server?: string; arguments?: Record<string, unknown> } | { error: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A gateway call's arguments; without `arguments` the call only describes the tool. */
export function gatewayInput(input: unknown): GatewayInput {
  const o = input ?? {}
  if (!isObject(o)) return { error: 'The arguments must be an object.' }
  const extra = Object.keys(o).find((key) => !['tool', 'server', 'arguments'].includes(key))
  if (extra !== undefined) return { error: `Unknown argument ${extra}.` }
  if (typeof o.tool !== 'string' || o.tool === '') return { error: 'tool must be a tool name.' }
  if (o.server !== undefined && (typeof o.server !== 'string' || o.server === '')) {
    return { error: 'server must be the name of an MCP server.' }
  }
  const server = typeof o.server === 'string' ? { server: o.server } : {}
  if (o.arguments === undefined) return { tool: o.tool, ...server }
  if (!isObject(o.arguments)) {
    return { error: 'arguments must be an object of the tool’s arguments, {} when it takes none.' }
  }
  return { tool: o.tool, ...server, arguments: o.arguments }
}

/** A tool a search can find: Kettu's own without a server, or one of a server's. */
export interface Findable {
  server: string | null
  tool: Tool
}

function firstLine(text: string | undefined): string {
  const line = (text ?? '').split(/\n/)[0]!.trim()
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

/** The tools whose name or description has every word of the query, Kettu's first. */
export function findTools(query: unknown, tools: readonly Findable[]): CallToolResult {
  if (typeof query !== 'string' || query.trim() === '') {
    return { content: [{ type: 'text', text: 'query must be words to look for.' }], isError: true }
  }
  const words = query
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
  const found = tools.filter(({ tool }) => {
    const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
  if (found.length === 0) {
    return { content: [{ type: 'text', text: `No tool has ${words.join(' ')}.` }] }
  }
  const lines = found.slice(0, FOUND).map(({ server, tool }) => {
    const where =
      server === null ? `tool "${tool.name}"` : `server "${server}", tool "${tool.name}"`
    return `- ${where}: ${firstLine(tool.description)}`
  })
  const more = found.length > FOUND ? `\n…and ${found.length - FOUND} more; use more words.` : ''
  return {
    content: [
      {
        type: 'text',
        text:
          `${lines.join('\n')}${more}\n\nCall one with ${GATEWAY_TOOL}, its server and tool; ` +
          'leave out arguments to read them first.',
      },
    ],
  }
}

const schemaText = (tool: Tool): string =>
  `Arguments of ${tool.name} (JSON Schema): ${JSON.stringify(tool.inputSchema)}`

/** A gateway call without arguments: the tool as it would have been declared. */
export function described(tool: Tool, server?: string): CallToolResult {
  const by = server === undefined ? '' : `server "${server}", `
  const text =
    `${tool.name}: ${tool.description ?? ''}\n\n${schemaText(tool)}\n\n` +
    `Call it with ${GATEWAY_TOOL}, ${by}tool "${tool.name}" and these arguments, {} when it takes none.`
  return { content: [{ type: 'text', text }] }
}

/** A failed call through the gateway, with the tool's arguments to correct it by. */
export function withArguments(result: CallToolResult, tool: Tool): CallToolResult {
  return { ...result, content: [...result.content, { type: 'text', text: schemaText(tool) }] }
}

/** A gateway call that names no tool the session can use, with the names it can. */
export function unknownTool(name: string, tools: readonly Tool[]): CallToolResult {
  const names = tools.map((tool) => tool.name).filter((tool) => tool !== GATEWAY_TOOL)
  const text = `${name} is not a Kettu tool this session can use. Its tools: ${names.join(', ')}.`
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * What a guide topic ends with for such an agent: every tool of its part with its arguments, the
 * core ones too, since the harness may drop them as well under the room other servers take.
 */
export function topicTools(tools: readonly Tool[]): string {
  const listed = tools.filter((tool) => tool.name !== GATEWAY_TOOL)
  if (listed.length === 0) return ''
  const blocks = listed.map(
    (tool) => `### ${tool.name}\n\n${tool.description ?? ''}\n\n${schemaText(tool)}`,
  )
  return (
    `\n\n## The tools\n\n` +
    `Call one missing from your function list with ${GATEWAY_TOOL}, its name as tool and its ` +
    `arguments as arguments.\n\n${blocks.join('\n\n')}`
  )
}
