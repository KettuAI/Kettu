// What the host shows of the library's MCP servers as Kettu runs them: their state, their tools
// with what each costs an agent's context, a session's servers and the record of their calls.
// Nothing here holds a key, a tool call's arguments or what it returned.

import { harnessOf, type AgentId } from './agents'
import type { McpTerminalApp } from './mcp-terminal'

/** Which projects a server goes to; absent means every project. */
export interface McpProjects {
  mode: 'only' | 'except'
  paths: string[]
}

export const MAX_MCP_PROJECTS = 200
export const MAX_TOOLS_OFF = 2_000

/** Whether a server set to `projects` goes to sessions of `project`, a canonical path. */
export function servedInProject(projects: McpProjects | undefined, project: string): boolean {
  if (!projects) return true
  const listed = projects.paths.includes(project)
  return projects.mode === 'only' ? listed : !listed
}

/** A server's state as the router knows it, without polling it. */
export type McpRunState =
  | { state: 'running'; instances: number }
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'needs-sign-in' }
  | { state: 'by-agent' }
  | { state: 'error'; reason: string; at: number }

export type McpToolTag = 'read-only' | 'changes' | 'deletes'

/** One tool of a server as it listed it last. */
export interface McpToolInfo {
  name: string
  /** The first sentence of its description. */
  summary: string
  /** Its definition's size as JSON, in bytes. */
  bytes: number
  tags: McpToolTag[]
  off: boolean
  /** How it differs from the definition the user accepted, when it does. */
  change?: 'added' | 'changed'
  /** Kept from agents until the user accepts the change. */
  held?: boolean
}

/**
 * What Kettu does when a server's tools change: holds them back until the user accepts them, only
 * notes it for a trusted source, or only notes it for a server each agent runs itself, which
 * Kettu cannot hold back.
 */
export type McpToolGuard = 'hold' | 'note' | 'by-agent'

/** How a server's tools differ from those the user accepted; absent when they do not. */
export interface McpToolChanges {
  serverId: string
  guard: McpToolGuard
  added: string[]
  changed: string[]
  /** Gone from the server: shown with the rest, never waiting to be accepted. */
  removed: string[]
  /** When the server first listed something not accepted. */
  since: number
}

/** A tool's description and parameters, as accepted or as the server lists it now. */
export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
}

/** One tool's change for the review window: null before for a new tool, after for a gone one. */
export interface McpToolDiff {
  name: string
  kind: 'added' | 'changed' | 'removed'
  before: McpToolDefinition | null
  after: McpToolDefinition | null
}

/** How many tools wait to be accepted: the new ones and the changed ones. */
export function changedCount(changes: McpToolChanges | null | undefined): number {
  return changes ? changes.added.length + changes.changed.length : 0
}

/** How an agent carries a server's tools in each turn. */
export type McpCarry = 'full' | 'names' | 'gateway'

export interface McpAgentCost {
  agentId: AgentId
  carry: McpCarry
  tokens: number
}

/** A library server's state, tools and per-agent context, for its page and the Marketplace. */
export interface McpServerInsight {
  serverId: string
  state: McpRunState
  /** Null until the server has listed its tools once. */
  tools: McpToolInfo[] | null
  agents: McpAgentCost[]
  changes: McpToolChanges | null
}

/** One process or connection the router keeps for a server. */
export interface McpInstanceInfo {
  id: string
  sharing: 'session' | 'folder' | 'all' | 'link'
  sessionId: string | null
  folder: string
  startedAt: number | null
  lastCallAt: number | null
  /** When it stops while nothing uses it, or null for one that does not stop on its own. */
  stopsAt: number | null
  running: boolean
}

/** One server a session's agent was handed, as its context popover lists it. */
export interface SessionMcpServer {
  serverId: string
  name: string
  title: string
  /** A remote server's address, whose site's icon stands for it; null for a command. */
  site: string | null
  state: McpRunState
  tools: number | null
  tokens: number | null
  /** Turned off for this session only. */
  off: boolean
  /** Whether it can be turned off and reconnected here: the router runs it for this session. */
  routed: boolean
  /**
   * Set for a server of the session's folder the user allowed on its card, which has no server
   * page: its tools that changed since accepted, reviewed here instead.
   */
  project?: true
  changes?: McpToolChanges | null
}

export type McpCallResult = 'ok' | 'tool-error' | 'error' | 'refused' | 'cancelled'

/** One tool call through the router: its metadata alone, never what was sent or returned. */
export interface McpCallRecord {
  at: number
  serverId: string
  sessionId: string | null
  agentId: AgentId | null
  tool: string
  ms: number
  /** The answer's size as JSON, in bytes. */
  bytes: number
  result: McpCallResult
  /** Why it failed, for `error` and `refused`: Kettu's or the protocol's message, never output. */
  error?: string
  /** For a call from a terminal, which has no session: the folder the agent ran in. */
  folder?: string
  /** For a call from an app's own file rather than an agent's. */
  app?: McpTerminalApp
}

export const MCP_CALL_DAYS = 30
export const MCP_CALL_ERROR_CHARS = 300
export const MCP_CALLS_PAGE = 500

export interface McpCallQuery {
  serverId: string
  failed?: boolean
  /** Calls at or after this time. */
  since?: number
  /** Calls before this time, for the next page. */
  before?: number
  /** Matches the tool's name. */
  query?: string
  limit?: number
}

/** The last stderr of each instance of a command server, with keys masked. */
export interface McpServerLog {
  instance: string
  serverId: string
  sessionId: string | null
  folder: string
  running: boolean
  text: string
}

/** Most of a server's stderr kept per instance, the end of it. */
export const MCP_STDERR_BYTES = 1024 * 1024

const SUMMARY_CHARS = 240

/** A description's first sentence, on one line. */
export function firstSentence(description: unknown): string {
  if (typeof description !== 'string') return ''
  const flat = description.replace(/\s+/g, ' ').trim()
  const end = /[.!?。！？](?=\s|$)/.exec(flat)
  const sentence = end ? flat.slice(0, end.index + 1) : flat
  return sentence.length > SUMMARY_CHARS ? `${sentence.slice(0, SUMMARY_CHARS - 1)}…` : sentence
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * What a tool's annotations claim it does, only where they say so: a tool without them is
 * tagged with nothing rather than with the protocol's defaults.
 */
export function toolTags(tool: unknown): McpToolTag[] {
  const notes = isRecord(tool) && isRecord(tool.annotations) ? tool.annotations : {}
  if (notes.readOnlyHint === true) return ['read-only']
  if (notes.destructiveHint === true) return ['deletes']
  if (notes.readOnlyHint === false || notes.destructiveHint === false) return ['changes']
  return []
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The tools a server listed, as the page shows them, those in `off` marked. Annotations are only
 * claims, so a tool is tagged from them only when its server comes from a trusted source.
 */
export function toolInfos(
  tools: readonly unknown[],
  off: readonly string[] = [],
  options: { trusted?: boolean; changes?: McpToolChanges | null } = {},
): McpToolInfo[] {
  const { trusted = false, changes = null } = options
  const out: McpToolInfo[] = []
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string') continue
    const change = changes?.added.includes(tool.name)
      ? 'added'
      : changes?.changed.includes(tool.name)
        ? 'changed'
        : undefined
    out.push({
      name: tool.name,
      summary: firstSentence(tool.description),
      bytes: utf8Bytes(JSON.stringify(tool)),
      tags: trusted ? toolTags(tool) : [],
      off: off.includes(tool.name),
      ...(change ? { change, held: changes?.guard === 'hold' } : {}),
    })
  }
  return out
}

/** Roughly how many tokens a text of `bytes` takes: a common rule for English and JSON. */
export function tokensOf(bytes: number): number {
  return Math.ceil(bytes / 4)
}

/** How an agent carries a server's tools: Claude Code looks them up and holds only names. */
export function carryOf(agentId: AgentId, gated: boolean): McpCarry {
  if (gated) return 'gateway'
  return harnessOf(agentId) === 'claude-code' ? 'names' : 'full'
}

/** The tokens a server's tools that are on take in each turn of an agent carrying them so. */
export function turnTokens(tools: readonly McpToolInfo[], carry: McpCarry, name: string): number {
  if (carry === 'gateway') return 0
  const on = tools.filter((tool) => !tool.off && !tool.held)
  if (carry === 'names') {
    return tokensOf(on.reduce((sum, tool) => sum + utf8Bytes(`mcp__${name}__${tool.name}`), 0))
  }
  return tokensOf(on.reduce((sum, tool) => sum + tool.bytes, 0))
}
