// The MCP tools of Kettu's MCP service: an agent lists the servers of Kettu's MCP library on the
// host its session runs on, reads one's tools and recent errors, checks one, and adds a server or
// turns servers on or off for the user. Reading and checking never ask; adding and switching
// always wait for the user's answer in a card, in Full access too, since a server runs with the
// user's own permissions for every agent. A key never passes through here: an added server takes
// its environment variables and headers only as references, or as ones the user fills in on the
// server's page, and nothing read back shows a value.

import { randomUUID } from 'node:crypto'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/agents'
import { CONTROL_WAIT_MS } from '@shared/control'
import { createRedactor } from '@shared/log/redact'
import { listingIdOf } from '@shared/market-community'
import {
  MARKET_NAME,
  runOf,
  serverName,
  specInputs,
  type CatalogServer,
  type MarketServer,
  type McpOAuth,
  type McpSpec,
} from '@shared/marketplace'
import type { McpCheck } from '@shared/mcp-discovery'
import { mcpFingerprint } from '@shared/mcp-fingerprint'
import type { McpCallRecord, McpServerInsight, McpServerLog } from '@shared/mcp-insight'
import {
  isSwitchOn,
  restoreOf,
  restoreStands,
  restored,
  switched,
  type McpRestore,
  type McpSwitchTarget,
} from '@shared/mcp-switch'
import type {
  McpAddServer,
  McpAddValue,
  McpChangeEntry,
  McpChangeOutcome,
  McpCheckSummary,
  McpSwitchItem,
} from '@shared/thread'
import type { Caller } from '../artifacts/tools'
import { importedServer } from './mcp-config'
import { parseMcpPaste } from './mcp-paste'

export const LIST_MCP_SERVERS = 'list_mcp_servers'
export const READ_MCP_SERVER = 'read_mcp_server'
export const CHECK_MCP_SERVER = 'check_mcp_server'
export const ADD_MCP_SERVER = 'add_mcp_server'
export const SWITCH_MCP_SERVERS = 'switch_mcp_servers'
/** Allowed when the agent starts: Kettu's own card is the only ask. */
export const MCP_TOOL_NAMES = [
  LIST_MCP_SERVERS,
  READ_MCP_SERVER,
  CHECK_MCP_SERVER,
  ADD_MCP_SERVER,
  SWITCH_MCP_SERVERS,
]
/** The tools that wait for the user's answer in a card before they act. */
export const MCP_ASKING_TOOLS = [ADD_MCP_SERVER, SWITCH_MCP_SERVERS]
/** How long a card waits before nothing happens. */
export const MCP_WAIT_MS = 10 * 60_000
/** The switches one call may turn. */
export const MAX_SWITCHES = 20

const SERVER_CHARS = 256
const CONFIG_CHARS = 64 * 1024
const PATH_CHARS = 4096
const TOOL_CHARS = 256
const AGENT_CHARS = 120
/** The failed calls and the stderr lines a read gives. */
const READ_ERRORS = 10
const READ_LOG_LINES = 20
const LOG_LINE_CHARS = 400

/** What looks like a key in an address or a command's arguments, which an agent may not pass. */
const looksSecret = createRedactor()

const SERVER_ARG = {
  type: 'string',
  minLength: 1,
  maxLength: SERVER_CHARS,
  description: "The server's name or id from list_mcp_servers.",
}

const WAITS =
  'It waits for the user to answer a card in this session, in every mode, Full access too, and ' +
  'nothing happens until they approve; declined or unanswered for 10 minutes, nothing happens. ' +
  'This call returns within a minute: if it says the user has not answered yet, call it again ' +
  'with the same arguments, which shows no second card and returns what became of this one.'

export const MCP_TOOLS: Tool[] = [
  {
    name: LIST_MCP_SERVERS,
    title: "List Kettu's MCP servers",
    description:
      "Lists the MCP servers in Kettu's library on the computer this session runs on, which Kettu " +
      'runs and hands to every agent: their names and ids, whether each is on, how it runs, which ' +
      'agents and projects get it, how many tools it has and how many are off, its state and its ' +
      'last check, and the keys still to fill in. Call it before adding one, so you do not add a ' +
      'second copy.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: READ_MCP_SERVER,
    title: 'Read an MCP server',
    description:
      'Reads one library server: how it runs, its environment variables and headers by name ' +
      '(references only; keys never show), its tools with which are off, its failed calls of the ' +
      'last days and the last lines its process wrote to stderr, keys masked.',
    inputSchema: {
      type: 'object',
      properties: { server: SERVER_ARG },
      required: ['server'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: CHECK_MCP_SERVER,
    title: 'Check an MCP server',
    description:
      'Starts or connects to one library server as an agent would, lists its tools and says ' +
      "whether it works: connected, needs the user to sign in, or why it failed. Only Kettu's " +
      'check of the server; it changes nothing.',
    inputSchema: {
      type: 'object',
      properties: { server: SERVER_ARG },
      required: ['server'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: ADD_MCP_SERVER,
    title: "Add an MCP server to Kettu's library",
    description:
      "Adds one MCP server to Kettu's library, only when the user asked for it: a server of the " +
      'Marketplace catalog by its id, or a URL, a command or an {"mcpServers": {...}} configuration ' +
      'of one server. Environment variables and headers are taken only as references to the ' +
      'environment, such as "${GITHUB_TOKEN}", or as "" for a key the user fills in on the ' +
      "server's page afterwards; a call that carries a key itself is refused. Kettu checks the " +
      `server once it is added. ${WAITS}`,
    inputSchema: {
      type: 'object',
      properties: {
        catalog: {
          type: 'string',
          minLength: 1,
          maxLength: SERVER_CHARS,
          description:
            "A server of the Marketplace's catalog by its registry id, such as " +
            'io.github.github/github-mcp-server.',
        },
        config: {
          type: 'string',
          minLength: 1,
          maxLength: CONFIG_CHARS,
          description:
            'A URL, a command such as "npx -y @modelcontextprotocol/server-memory" or "claude mcp ' +
            'add ...", or an {"mcpServers": {...}} JSON of one server, as Add by hand takes it.',
        },
        name: {
          type: 'string',
          pattern: MARKET_NAME.source,
          description:
            "The name agents call it by; without it, one from the server's own name, kept apart " +
            'from the names already in use.',
        },
        agents: {
          type: 'array',
          items: { type: 'string', maxLength: AGENT_CHARS },
          minItems: 1,
          maxItems: 50,
          description: 'The agents that get it, ids list_agents gives; without it, every agent.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: SWITCH_MCP_SERVERS,
    title: 'Turn MCP servers on or off',
    description:
      'Turns library servers on or off, only when the user asked: a whole server, or for one ' +
      'agent, one project or one of its tools. One call makes all its switches or none, and the ' +
      `user can undo them from the thread. ${WAITS}`,
    inputSchema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_SWITCHES,
          items: {
            type: 'object',
            properties: {
              server: SERVER_ARG,
              on: { type: 'boolean', description: 'true turns it on, false off.' },
              agent: {
                type: 'string',
                maxLength: AGENT_CHARS,
                description: 'Only for this agent, an id list_agents gives.',
              },
              project: {
                type: 'string',
                maxLength: PATH_CHARS,
                description: "Only in this project, the folder of one of Kettu's projects.",
              },
              tool: {
                type: 'string',
                maxLength: TOOL_CHARS,
                description: 'Only this tool of the server, by its name from read_mcp_server.',
              },
            },
            required: ['server', 'on'],
            additionalProperties: false,
          },
          description:
            'Each switch; name at most one of agent, project and tool, or none for the whole server.',
        },
      },
      required: ['changes'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

const NAMES = new Set(MCP_TOOL_NAMES)

export function isMcpToolName(name: string): boolean {
  return NAMES.has(name)
}

/** What a card asks, as the host adds it to the thread. */
export type McpAsk = Pick<McpChangeEntry, 'action' | 'server' | 'items'>

/** The user's answer to a card, or how it ended without one. */
export type McpAnswer = { decision: 'confirm' } | { decision: 'decline' | 'expired' | 'ended' }

export interface McpToolsDeps {
  /** The library's servers as the host has them now. */
  servers(): readonly MarketServer[]
  /** The server's state and tools as the router knows them. */
  insight(serverId: string): McpServerInsight | null
  /** The server's last check, or null when it was never checked. */
  lastCheck(serverId: string): McpCheck | null
  /** Checks the server, or joins the check already going; `project` is a folder to start it in. */
  check(server: MarketServer, project?: string): Promise<McpCheck>
  /** The server's failed calls, newest first. */
  failedCalls(serverId: string, limit: number): Promise<McpCallRecord[]>
  /** The stderr of each instance of the server, keys masked. */
  logs(serverId: string): McpServerLog[]
  /** Masks the server's own keys and anything that reads as a key. */
  mask(serverId: string): (text: string) => string
  /** The names of the server's inputs that have a value in the key store. */
  keysSet(serverId: string): readonly string[]
  /** The agents of this host. */
  agents(): readonly AgentStatus[]
  /** The canonical path of one of Kettu's projects on this host; null when it is none. */
  project(path: string): Promise<string | null>
  /** The folder the session works in, for a check; null for none. */
  sessionFolder(sessionId: string): string | null
  /** How a remote server's address signs in; null when it takes no OAuth; throws when unreachable. */
  detectSignIn(url: string): Promise<McpOAuth | null>
  /** A server of the Marketplace's catalog by its id; null when the catalog has none. */
  catalogServer(id: string): Promise<CatalogServer | null>
  /** Puts the servers into the library, through the same checks as the Marketplace. */
  put(servers: MarketServer[]): Promise<void>
  /** Adds the card to the thread; null for a session Kettu holds no thread for. */
  ask(sessionId: string, ask: McpAsk): { entryId: string; answer: Promise<McpAnswer> } | null
  settle(
    sessionId: string,
    entryId: string,
    outcome: McpChangeOutcome,
    restore?: McpRestore[],
  ): void
  newId?(): string
}

/** Undo found a switch changed again since, so nothing was put back. */
export class McpStaleUndo extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpStaleUndo'
  }
}

/** A card a call opened, which the agent's next call with the same arguments picks up. */
interface CardJob {
  key: string
  action: McpAsk['action']
  what: string
  confirmed: boolean
  result: Promise<CallToolResult>
}

class Refusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

/** What applying an approved card does, and the words of its result. */
interface Plan {
  ask: McpAsk
  what: string
  apply(): Promise<{ text: string; data: Record<string, unknown>; restore?: McpRestore[] }>
  /** After it is applied: the check of an added server, whose outcome the line shows. */
  afterApply?(settleCheck: (check: McpCheckSummary) => void): void
}

/**
 * A result whose words go in its structured content too, since an agent that reads the structured
 * content alone, as Claude Code does, would miss what to do next.
 */
function reply(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { message: text, ...data } }
}

function failed(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === undefined) return {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Refusal('The arguments must be an object.')
  }
  const o = input as Record<string, unknown>
  const unknown = Object.keys(o).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw new Refusal(`Unknown argument ${unknown}.`)
  return o
}

/** Keys in a fixed order, so two equal objects read the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(o[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function text(o: Record<string, unknown>, key: string, max: number): string {
  const value = o[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Refusal(`${key} must be a text of 1 to ${max} characters.`)
  }
  return value
}

const REFERENCE = /^(?:(?:Bearer|Basic) )?\$\{[a-zA-Z_][a-zA-Z_0-9]*\}$/

function argText(arg: string): string {
  return /[\s"']/.test(arg) || arg === '' ? JSON.stringify(arg) : arg
}

/** A spec's program and arguments, or its address, as one line. */
function targetOf(spec: McpSpec): string {
  return spec.type === 'http' ? spec.url : [spec.command, ...spec.args].map(argText).join(' ')
}

function valuesOf(spec: McpSpec): McpAddValue[] {
  return (spec.type === 'http' ? spec.headers : spec.env).map((item): McpAddValue => {
    if ('input' in item) return { name: item.name, state: 'unset' }
    return REFERENCE.test(item.value)
      ? { name: item.name, state: 'reference', reference: item.value }
      : { name: item.name, state: 'fixed' }
  })
}

/** A check as the line under an added server says it. */
export function checkSummary(check: McpCheck): McpCheckSummary | null {
  switch (check.state) {
    case 'checking':
      return null
    case 'connected':
      return { state: 'connected', tools: check.tools }
    case 'needs-sign-in':
    case 'project-only':
      return { state: check.state }
    case 'error':
      return { state: 'error', reason: check.reason }
  }
}

const ERROR_WORDS: Record<Extract<McpCheck, { state: 'error' }>['reason'], string> = {
  'command-not-found': 'its command was not found on this computer',
  exited: 'its process exited',
  timeout: 'it did not answer in time',
  http: 'its server answered with an HTTP error',
  'cannot-connect': 'Kettu could not connect to it',
  'missing-variable': 'an environment variable it references is not set',
}

/** How a held tool reads to an agent: what it waits for and where. */
const HELD_WORDS =
  "held back until the user accepts the change on the server's page in Kettu's Marketplace"

function checkText(check: McpCheck | null, mask: (text: string) => string): string {
  if (check === null) return 'not checked yet'
  switch (check.state) {
    case 'checking':
      return 'being checked now'
    case 'connected':
      return `connected, ${check.tools} tool${check.tools === 1 ? '' : 's'}`
    case 'needs-sign-in':
      return "needs the user to sign in, on the server's page in the Marketplace"
    case 'project-only':
      return "runs only in a project's folder, so it was not started outside one"
    case 'error': {
      const parts = [
        ERROR_WORDS[check.reason],
        check.step ? `at ${check.step}` : null,
        check.status !== undefined ? `status ${check.status}` : null,
        check.seconds !== undefined ? `after ${check.seconds} s` : null,
      ].filter(Boolean)
      const detail = check.detail ? `: ${mask(check.detail)}` : ''
      return `failed, ${parts.join(', ')}${detail}`
    }
  }
}

function targetWords(target: McpSwitchTarget, agentName: (id: AgentId) => string): string {
  switch (target.kind) {
    case 'server':
      return 'the whole server'
    case 'agent':
      return `for ${agentName(target.agentId)}`
    case 'project':
      return `in the project ${target.path}`
    case 'tool':
      return `its tool ${target.tool}`
  }
}

export class McpTools {
  /** The cards calls opened, by session. */
  private readonly jobs = new Map<string, CardJob[]>()

  constructor(private readonly deps: McpToolsDeps) {}

  /** The session's turn ended: a later turn's call with the same arguments asks again. */
  turnEnded(sessionId: string): void {
    this.jobs.delete(sessionId)
  }

  /** Serves a call; a refusal becomes a tool error whose text says why. */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    const deadline = Date.now() + CONTROL_WAIT_MS
    try {
      switch (name) {
        case LIST_MCP_SERVERS:
          fields(input, [])
          return this.list()
        case READ_MCP_SERVER:
          return await this.read(this.serverOf(fields(input, ['server'])))
        case CHECK_MCP_SERVER:
          return await this.runCheck(caller, this.serverOf(fields(input, ['server'])), deadline)
      }
      if (!MCP_ASKING_TOOLS.includes(name)) throw new Error(`Unknown tool ${name}`)
      const key = `${name}:${stable(input ?? {})}`
      const waiting = this.jobs.get(caller.sessionId)?.find((job) => job.key === key)
      if (waiting) return await this.follow(caller.sessionId, waiting, deadline)
      const plan =
        name === ADD_MCP_SERVER ? await this.planAdd(input) : await this.planSwitch(input)
      if ('result' in plan) return plan.result
      return await this.open(caller.sessionId, key, plan)
    } catch (error) {
      if (error instanceof Refusal) return failed(error.message)
      throw error
    }
  }

  /** Undo on a switch line: every part goes back, unless one changed again since. */
  async undo(restore: readonly McpRestore[]): Promise<void> {
    const servers = this.deps.servers()
    const put = restore.map((item) => {
      const server = servers.find((s) => s.id === item.serverId)
      if (!server)
        throw new McpStaleUndo('A server this change switched is no longer in the library')
      if (!restoreStands(server, item)) {
        throw new McpStaleUndo(`${server.title} was changed again since, so nothing was undone`)
      }
      return restored(server, item)
    })
    await this.deps.put(put)
  }

  private agentName(agentId: AgentId): string {
    return this.deps.agents().find((status) => status.id === agentId)?.name ?? agentId
  }

  private hostAgents(): AgentStatus[] {
    return this.deps
      .agents()
      .filter((status) => status.registered !== false && status.uninstalled !== true)
  }

  private agentOf(value: unknown): AgentId {
    if (typeof value !== 'string' || value.length === 0 || value.length > AGENT_CHARS) {
      throw new Refusal('An agent must be an id list_agents gives.')
    }
    const status = this.hostAgents().find((s) => s.id === value)
    if (!status) {
      const ids = this.hostAgents().map((s) => `${s.id} (${s.name})`)
      throw new Refusal(
        `Nothing was done: there is no agent ${value} on this computer. Its agents: ${ids.join(', ') || 'none'}.`,
      )
    }
    return status.id
  }

  private serverOf(o: Record<string, unknown>, key = 'server'): MarketServer {
    const given = text(o, key, SERVER_CHARS)
    const servers = this.deps.servers()
    const server = servers.find((s) => s.id === given) ?? servers.find((s) => s.name === given)
    if (!server) {
      throw new Refusal(
        `There is no MCP server ${given} in Kettu's library on this computer. Call ` +
          `${LIST_MCP_SERVERS} for their names.`,
      )
    }
    return server
  }

  private agentsText(agents: MarketServer['agents']): string {
    return agents === 'all'
      ? 'every agent'
      : agents.length === 0
        ? 'no agent'
        : agents.map((id) => this.agentName(id)).join(', ')
  }

  private describe(server: MarketServer): { line: string; data: Record<string, unknown> } {
    const insight = this.deps.insight(server.id)
    const check = this.deps.lastCheck(server.id)
    const mask = this.deps.mask(server.id)
    const tools = insight?.tools ?? null
    const off = tools?.filter((tool) => tool.off).length ?? 0
    const held = tools?.filter((tool) => tool.held).length ?? 0
    const set = new Set(this.deps.keysSet(server.id))
    const unset = specInputs(server.spec)
      .filter((input) => !set.has(input.name))
      .map((input) => input.name)
    const how =
      server.spec.type === 'http'
        ? `remote (${server.spec.transport})${server.spec.oauth ? ', signs in with OAuth' : ''}`
        : runOf(server).mode === 'agent'
          ? 'a command each agent runs itself'
          : 'a command Kettu runs'
    const projects = server.projects
      ? `${server.projects.mode === 'only' ? 'only in' : 'every project except'} ${
          server.projects.paths.join(', ') || 'none'
        }`
      : 'every project'
    const state = insight ? insight.state.state : 'unknown'
    const line =
      `- ${server.name} "${server.title}" (id ${server.id}): ${server.on ? 'on' : 'off'}; ${how}\n` +
      `  for ${this.agentsText(server.agents)}; ${projects}\n` +
      `  ${tools ? `${tools.length} tools${off ? `, ${off} off` : ''}${held ? `, ${held} ${HELD_WORDS}` : ''}` : 'tools not listed yet'}; ` +
      `state ${state}; last check: ${checkText(check, mask)}` +
      (unset.length ? `\n  keys the user has not filled in: ${unset.join(', ')}` : '')
    return {
      line,
      data: {
        id: server.id,
        name: server.name,
        title: server.title,
        on: server.on,
        type: server.spec.type,
        agents: server.agents,
        projects: server.projects ?? null,
        tools: tools?.length ?? null,
        toolsOff: off,
        toolsHeld: held,
        state,
        check: check ? checkSummary(check) : null,
        keysNotSet: unset,
      },
    }
  }

  private list(): CallToolResult {
    const servers = this.deps.servers()
    if (servers.length === 0) {
      return reply("Kettu's MCP library on this computer has no servers.", { servers: [] })
    }
    const lines = servers.map((server) => this.describe(server))
    return reply(
      `${servers.length} MCP server${servers.length === 1 ? '' : 's'} in Kettu's library on this computer:\n` +
        lines.map((l) => l.line).join('\n'),
      { servers: lines.map((l) => l.data) },
    )
  }

  private async read(server: MarketServer): Promise<CallToolResult> {
    const mask = this.deps.mask(server.id)
    const { line, data } = this.describe(server)
    const set = new Set(this.deps.keysSet(server.id))
    const values = (server.spec.type === 'http' ? server.spec.headers : server.spec.env).map(
      (item) => {
        if ('input' in item) {
          return `${item.name}: in the key store, ${set.has(item.name) ? 'set' : 'not set'}`
        }
        return REFERENCE.test(item.value)
          ? `${item.name}: ${item.value}`
          : `${item.name}: a fixed value, not shown`
      },
    )
    const tools = this.deps.insight(server.id)?.tools ?? null
    const calls = await this.deps.failedCalls(server.id, READ_ERRORS)
    const logs = this.deps.logs(server.id).map((log) => {
      const lines = mask(log.text).split(/\r?\n/).filter(Boolean).slice(-READ_LOG_LINES)
      return {
        instance: log.instance,
        running: log.running,
        lines: lines.map((l) => (l.length > LOG_LINE_CHARS ? `${l.slice(0, LOG_LINE_CHARS)}…` : l)),
      }
    })
    const parts = [
      line,
      `${server.spec.type === 'http' ? 'Address' : 'Command'}: ${mask(targetOf(server.spec))}`,
      values.length
        ? `${server.spec.type === 'http' ? 'Headers' : 'Environment'}:\n${values.map((v) => `- ${v}`).join('\n')}`
        : null,
      tools
        ? `Tools:\n${tools
            .map(
              (tool) =>
                `- ${tool.name}${tool.off ? ' (off)' : ''}${tool.held ? ` (${tool.change === 'added' ? 'new' : 'changed'}, ${HELD_WORDS})` : ''}${tool.tags.length ? ` [${tool.tags.join(', ')}]` : ''}: ${tool.summary}`,
            )
            .join('\n')}`
        : 'Kettu has not listed its tools yet; check_mcp_server lists them.',
      calls.length
        ? `Failed calls, newest first:\n${calls
            .map(
              (call) =>
                `- ${new Date(call.at).toISOString()} ${call.tool}: ${call.result}${call.error ? `, ${mask(call.error)}` : ''}`,
            )
            .join('\n')}`
        : 'No failed calls on record.',
      logs.some((log) => log.lines.length > 0)
        ? `Last stderr lines, keys masked:\n${logs
            .filter((log) => log.lines.length > 0)
            .map(
              (log) =>
                `${log.instance}${log.running ? '' : ' (stopped)'}:\n${log.lines.map((l) => `  ${l}`).join('\n')}`,
            )
            .join('\n')}`
        : null,
    ].filter((part): part is string => part !== null)
    return reply(parts.join('\n\n'), {
      ...data,
      target: mask(targetOf(server.spec)),
      values,
      toolList:
        tools?.map((tool) => ({
          name: tool.name,
          off: tool.off,
          held: tool.held === true,
          tags: tool.tags,
        })) ?? null,
      failedCalls: calls.map((call) => ({
        at: call.at,
        tool: call.tool,
        result: call.result,
        error: call.error ? mask(call.error) : null,
      })),
      stderr: logs,
    })
  }

  private async runCheck(
    caller: Caller,
    server: MarketServer,
    deadline: number,
  ): Promise<CallToolResult> {
    const mask = this.deps.mask(server.id)
    const folder = this.deps.sessionFolder(caller.sessionId) ?? undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
    })
    try {
      const check = await Promise.race([this.deps.check(server, folder), late])
      if (check === null) {
        return reply(
          `${server.name} is still being checked. Call ${CHECK_MCP_SERVER} again for the outcome; ` +
            'it starts no second check.',
          { checking: true },
        )
      }
      const held = this.deps.insight(server.id)?.tools?.filter((tool) => tool.held).length ?? 0
      return reply(
        `${server.name}: ${checkText(check, mask)}${held ? `; ${held} of them ${HELD_WORDS}` : ''}.`,
        { server: server.id, check: checkSummary(check), toolsHeld: held },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /** The agents an added server goes to. */
  private agentsArg(value: unknown): MarketServer['agents'] {
    if (value === undefined) return 'all'
    if (!Array.isArray(value) || value.length === 0) {
      throw new Refusal('agents must be a list of agent ids, or left out for every agent.')
    }
    const ids = [...new Set(value.map((id) => this.agentOf(id)))]
    const all = this.hostAgents().every((status) => ids.includes(status.id))
    return all ? 'all' : ids
  }

  private async planAdd(input: unknown): Promise<Plan> {
    const o = fields(input, ['catalog', 'config', 'name', 'agents'])
    if ((o.catalog === undefined) === (o.config === undefined)) {
      throw new Refusal('Give either catalog or config, not both.')
    }
    const kept = this.deps.servers()
    const agents = this.agentsArg(o.agents)
    let server: MarketServer
    if (o.catalog !== undefined) {
      const id = text(o, 'catalog', SERVER_CHARS)
      const existing = kept.find((s) => s.id === id)
      if (existing) {
        throw new Refusal(
          `Nothing was done: ${existing.title} is already in the library as ${existing.name}.`,
        )
      }
      const found = await this.deps.catalogServer(id)
      if (!found) {
        throw new Refusal(
          `The Marketplace catalog has no server ${id}. Give its registry id exactly, or add it ` +
            'by its URL or command with config.',
        )
      }
      server = {
        id: found.id,
        name: serverName(listingIdOf(found.id) ? found.title : found.id, kept),
        title: found.title,
        source: listingIdOf(found.id) ? 'kettu' : 'registry',
        version: found.version,
        spec: found.spec,
        agents,
        on: true,
      }
    } else {
      const config = text(o, 'config', CONFIG_CHARS)
      let parsed
      try {
        parsed = parseMcpPaste(config)
      } catch (error) {
        throw new Refusal(`Nothing was done: ${(error as Error).message}`)
      }
      if (parsed.length !== 1) {
        throw new Refusal('Nothing was done: add one server per call.')
      }
      const draft = parsed[0]!
      const values = Object.entries(draft.secrets)
      const valued = values.filter(([, value]) => value.trim() !== '').map(([name]) => name)
      if (valued.length > 0) {
        throw new Refusal(
          `Nothing was done: ${valued.join(', ')} ${valued.length === 1 ? 'carries a value' : 'carry values'}. ` +
            'Give environment variables and headers only as references to the environment, such ' +
            'as "${GITHUB_TOKEN}", or as "" for a key the user fills in on the server\'s page in ' +
            'the Marketplace once it is added. Never pass a key yourself; tell the user where to ' +
            'enter it.',
        )
      }
      const spec = draft.spec
      const words = spec.type === 'http' ? [spec.url] : [spec.command, ...spec.args]
      if (words.some((word) => looksSecret(word) !== word)) {
        throw new Refusal(
          'Nothing was done: the address or the arguments carry what looks like a key. Pass a ' +
            'key only as an environment variable or header reference, such as "${API_KEY}", or ' +
            "leave it for the user to fill in on the server's page.",
        )
      }
      const fingerprint = mcpFingerprint(
        spec.type === 'http' ? { type: 'http', url: spec.url } : spec,
      )
      const same = kept.find(
        (s) =>
          mcpFingerprint(s.spec.type === 'http' ? { type: 'http', url: s.spec.url } : s.spec) ===
          fingerprint,
      )
      if (same) {
        throw new Refusal(
          `Nothing was done: the library already has this server as ${same.name}. Use ` +
            `${SWITCH_MCP_SERVERS} to turn it on for the agents that need it.`,
        )
      }
      const base = MARKET_NAME.test(draft.name) ? draft.name : serverName(draft.name, kept)
      const name =
        kept.some((s) => s.name === base) || base === 'kettu' ? serverName(base, kept) : base
      server = importedServer(
        `manual:${this.deps.newId?.() ?? randomUUID()}`,
        draft,
        name,
        agents,
        [],
      )
      delete server.importedFrom
    }
    if (o.name !== undefined) {
      const name = text(o, 'name', 48)
      if (!MARKET_NAME.test(name) || name === 'kettu') {
        throw new Refusal(
          'name must be lowercase letters, digits, - and _, starting with a letter or digit, and not kettu.',
        )
      }
      if (kept.some((s) => s.name === name)) {
        throw new Refusal(`Nothing was done: the library already has a server named ${name}.`)
      }
      server = { ...server, name, ...(server.source === 'manual' ? { title: name } : {}) }
    }
    // Ask the address how it signs in, as adding by hand does; headers mean it signs in with them.
    let oauth: boolean | null = server.spec.type === 'http' && server.spec.oauth !== undefined
    if (server.source === 'manual' && server.spec.type === 'http' && !oauth) {
      const spec = server.spec
      if (spec.headers.length === 0) {
        try {
          const found = await this.deps.detectSignIn(spec.url)
          if (found) server = { ...server, spec: { ...spec, oauth: found } }
          oauth = found !== null
        } catch {
          oauth = null
        }
      }
    }
    const card: McpAddServer = {
      serverId: server.id,
      name: server.name,
      title: server.title,
      type: server.spec.type,
      transport: server.spec.type === 'http' ? server.spec.transport : null,
      target: looksSecret(targetOf(server.spec)),
      oauth,
      values: valuesOf(server.spec),
      agents: server.agents,
    }
    const unset = card.values.filter((value) => value.state === 'unset').map((v) => v.name)
    const added = server
    return {
      ask: { action: 'add', server: card, items: [] },
      what: `add the MCP server ${server.name}`,
      apply: async () => {
        if (this.deps.servers().some((s) => s.id === added.id || s.name === added.name)) {
          throw new Error(`the library has a server ${added.name} since`)
        }
        await this.deps.put([added])
        const keys = unset.length
          ? ` The user still has to fill in ${unset.join(', ')} on its page in the Marketplace; ` +
            'do not ask for them in this conversation.'
          : ''
        return {
          text:
            `The user pressed Add. ${added.name} is in Kettu's library for ` +
            `${this.agentsText(added.agents)}, and Kettu checks it now; ${CHECK_MCP_SERVER} gives ` +
            `the outcome. Agents get it in their next session.${keys}`,
          data: { server: added.id, name: added.name },
        }
      },
      afterApply: (settleCheck) => {
        void this.deps.check(added).then(
          (check) => {
            const summary = checkSummary(check)
            if (summary) settleCheck(summary)
          },
          () => settleCheck({ state: 'error', reason: 'cannot-connect' }),
        )
      },
    }
  }

  private async planSwitch(input: unknown): Promise<Plan | { result: CallToolResult }> {
    const o = fields(input, ['changes'])
    if (!Array.isArray(o.changes) || o.changes.length === 0 || o.changes.length > MAX_SWITCHES) {
      throw new Refusal(`changes must be a list of 1 to ${MAX_SWITCHES} switches.`)
    }
    const hostAgents = this.hostAgents().map((status) => status.id)
    const wanted: { serverId: string; target: McpSwitchTarget; on: boolean }[] = []
    const items: McpSwitchItem[] = []
    // Each server as the switches before leave it, so two switches of one server read in order.
    const working = new Map<string, MarketServer>()
    for (const change of o.changes) {
      const c = fields(change, ['server', 'on', 'agent', 'project', 'tool'])
      const base = this.serverOf(c)
      if (typeof c.on !== 'boolean') throw new Refusal('on must be true or false.')
      const named = ['agent', 'project', 'tool'].filter((key) => c[key] !== undefined)
      if (named.length > 1) {
        throw new Refusal('Name at most one of agent, project and tool in each switch.')
      }
      let target: McpSwitchTarget = { kind: 'server' }
      if (c.agent !== undefined) target = { kind: 'agent', agentId: this.agentOf(c.agent) }
      if (c.project !== undefined) {
        const given = text(c, 'project', PATH_CHARS)
        const path = await this.deps.project(given)
        if (path === null) {
          throw new Refusal(
            `Nothing was done: ${given} is not one of Kettu's projects on this computer.`,
          )
        }
        target = { kind: 'project', path }
      }
      if (c.tool !== undefined) {
        const tool = text(c, 'tool', TOOL_CHARS)
        const tools = this.deps.insight(base.id)?.tools ?? null
        if (tools === null) {
          throw new Refusal(
            `Kettu has not listed the tools of ${base.name} yet. Call ${CHECK_MCP_SERVER} first.`,
          )
        }
        const found = tools.find((t) => t.name === tool)
        if (!found) {
          throw new Refusal(
            `${base.name} has no tool ${tool}. Its tools: ${tools.map((t) => t.name).join(', ')}.`,
          )
        }
        if (found.held && c.on) {
          throw new Refusal(
            `Nothing was done: ${tool} of ${base.name} is ${HELD_WORDS}, which turning it on ` +
              'does not change.',
          )
        }
        target = { kind: 'tool', tool }
      }
      const server = working.get(base.id) ?? base
      const from = isSwitchOn(server, target)
      if (from === c.on) continue
      working.set(base.id, switched(server, target, c.on, hostAgents))
      wanted.push({ serverId: base.id, target, on: c.on })
      items.push({ serverId: base.id, title: base.title, target, from, to: c.on })
    }
    if (items.length === 0) {
      return {
        result: reply('Nothing to change: every switch is already set that way.', {
          changed: false,
        }),
      }
    }
    const what = items
      .map((item) => {
        const server = this.deps.servers().find((s) => s.id === item.serverId)
        return `${server?.name ?? item.serverId} ${targetWords(item.target, (id) => this.agentName(id))} ${item.to ? 'on' : 'off'}`
      })
      .join('; ')
    return {
      ask: { action: 'switch', server: null, items },
      what: `turn ${what}`,
      apply: async () => {
        // Applied to the library as it is now, so a change the user made meanwhile stays.
        const now = this.deps.servers()
        const next = new Map<string, MarketServer>()
        for (const { serverId, target, on } of wanted) {
          const server = next.get(serverId) ?? now.find((s) => s.id === serverId)
          if (!server) throw new Error('a server it switches is no longer in the library')
          next.set(
            serverId,
            switched(
              server,
              target,
              on,
              this.hostAgents().map((s) => s.id),
            ),
          )
        }
        const restore = [...next].flatMap(([id, server]) => {
          const done = restoreOf(
            now.find((s) => s.id === id)!,
            server,
          )
          return done ? [done] : []
        })
        if (restore.length > 0) await this.deps.put([...next.values()])
        return {
          text:
            `The user pressed ${items.every((item) => item.to) ? 'Turn on' : 'Turn off'}: ${what}. ` +
            'Sessions started from now get it; the user can undo it from the thread.',
          data: { changed: items.length },
          restore,
        }
      },
    }
  }

  /** Opens the card and waits for its answer up to the call's deadline. */
  private async open(sessionId: string, key: string, plan: Plan): Promise<CallToolResult> {
    const card = this.deps.ask(sessionId, plan.ask)
    if (!card) throw new Refusal('This session is not open, so it shows no card. Nothing was done.')
    const job: CardJob = {
      key,
      action: plan.ask.action,
      what: plan.what,
      confirmed: false,
      result: null!,
    }
    job.result = card.answer.then((answer) => {
      job.confirmed = answer.decision === 'confirm'
      return this.answered(sessionId, card.entryId, plan, answer)
    })
    job.result.catch(() => {})
    this.jobs.set(sessionId, [...(this.jobs.get(sessionId) ?? []), job])
    return this.follow(sessionId, job, Date.now() + CONTROL_WAIT_MS)
  }

  /** Does what the user approved, or says why nothing happened. */
  private async answered(
    sessionId: string,
    entryId: string,
    plan: Plan,
    answer: McpAnswer,
  ): Promise<CallToolResult> {
    if (answer.decision !== 'confirm') {
      const text =
        answer.decision === 'decline'
          ? `The user chose Don't. Nothing was done; do not ask to ${plan.what} again unless they ask.`
          : answer.decision === 'expired'
            ? 'The user did not answer within 10 minutes, so nothing was done.'
            : 'The turn ended before the user answered, so nothing was done.'
      return reply(text, { done: false })
    }
    try {
      const done = await plan.apply()
      this.deps.settle(sessionId, entryId, { kind: 'done' }, done.restore)
      plan.afterApply?.((check) => this.deps.settle(sessionId, entryId, { kind: 'done', check }))
      return reply(done.text, { done: true, ...done.data })
    } catch (error) {
      const message = (error as Error).message
      this.deps.settle(sessionId, entryId, { kind: 'failed', message })
      throw new Refusal(`The user approved, but Kettu could not do it: ${message}`)
    }
  }

  /** The card's outcome once it has one, or by the deadline that the user has not answered yet. */
  private async follow(sessionId: string, job: CardJob, deadline: number): Promise<CallToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
    })
    try {
      const result = await Promise.race([job.result, late])
      if (result === null) return stillWaiting(job)
      this.done(sessionId, job)
      return result
    } catch (error) {
      this.done(sessionId, job)
      if (error instanceof Refusal) return failed(error.message)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private done(sessionId: string, job: CardJob): void {
    const left = (this.jobs.get(sessionId) ?? []).filter((other) => other !== job)
    if (left.length > 0) this.jobs.set(sessionId, left)
    else this.jobs.delete(sessionId)
  }
}

function stillWaiting(job: CardJob): CallToolResult {
  const tool = job.action === 'add' ? ADD_MCP_SERVER : SWITCH_MCP_SERVERS
  const text = job.confirmed
    ? `The user approved and Kettu is doing it. Call ${tool} again with the same arguments for the outcome.`
    : `The user has not answered the card to ${job.what} yet, and nothing was done. Call ${tool} again with the same arguments to keep waiting on the same card; it shows no second one.`
  return reply(text, { waiting: true, confirmed: job.confirmed })
}
