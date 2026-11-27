// Turning a library MCP server on or off for the whole library, one agent, one project or one
// tool, as its page does, and putting back exactly what one such change did. The host applies
// them for an agent's card and its Undo; a client reads them to tell whether Undo still applies.

import { isAgentId, type AgentId } from './agents'
import type { MarketServer } from './marketplace'
import { servedInProject, type McpProjects } from './mcp-insight'

/** What a switch is for: the whole server, one agent, one project (a canonical path) or one tool. */
export type McpSwitchTarget =
  | { kind: 'server' }
  | { kind: 'agent'; agentId: AgentId }
  | { kind: 'project'; path: string }
  | { kind: 'tool'; tool: string }

/** The parts of a server its switches change. */
export interface McpSwitches {
  on: boolean
  agents: 'all' | AgentId[]
  projects: McpProjects | null
  toolsOff: string[]
}

/**
 * What one change did to one server: the parts it changed, as they were and as it left them.
 * Undo puts `before` back only while every part still reads `after`.
 */
export interface McpRestore {
  serverId: string
  before: Partial<McpSwitches>
  after: Partial<McpSwitches>
}

const PARTS = ['on', 'agents', 'projects', 'toolsOff'] as const

export function switchesOf(server: MarketServer): McpSwitches {
  return {
    on: server.on,
    agents: server.agents,
    projects: server.projects ?? null,
    toolsOff: server.toolsOff ?? [],
  }
}

/** Whether the switch is on now. */
export function isSwitchOn(server: MarketServer, target: McpSwitchTarget): boolean {
  switch (target.kind) {
    case 'server':
      return server.on
    case 'agent':
      return server.agents === 'all' || server.agents.includes(target.agentId)
    case 'project':
      return servedInProject(server.projects, target.path)
    case 'tool':
      return !(server.toolsOff ?? []).includes(target.tool)
  }
}

/** The server with its parts set to `parts`, an empty project choice or tool list dropped. */
function withParts(server: MarketServer, parts: Partial<McpSwitches>): MarketServer {
  const next: MarketServer = { ...server }
  if (parts.on !== undefined) next.on = parts.on
  if (parts.agents !== undefined) next.agents = parts.agents
  if (parts.projects !== undefined) {
    if (parts.projects === null) delete next.projects
    else next.projects = parts.projects
  }
  if (parts.toolsOff !== undefined) {
    if (parts.toolsOff.length === 0) delete next.toolsOff
    else next.toolsOff = parts.toolsOff
  }
  return next
}

/**
 * The server with the switch set, as its page sets it: an agent list that holds every agent of the
 * host again goes back to every agent, so agents added later get it too.
 */
export function switched(
  server: MarketServer,
  target: McpSwitchTarget,
  on: boolean,
  hostAgents: readonly AgentId[],
): MarketServer {
  if (isSwitchOn(server, target) === on) return server
  switch (target.kind) {
    case 'server':
      return withParts(server, { on })
    case 'agent': {
      const now = server.agents === 'all' ? [...hostAgents] : server.agents
      const next = on ? [...now, target.agentId] : now.filter((id) => id !== target.agentId)
      const all = hostAgents.length > 0 && hostAgents.every((id) => next.includes(id))
      return withParts(server, { agents: all ? 'all' : next })
    }
    case 'project': {
      const projects = server.projects
      if (!projects) {
        return withParts(server, { projects: { mode: 'except', paths: [target.path] } })
      }
      const adds = (projects.mode === 'only') === on
      const paths = adds
        ? [...projects.paths, target.path]
        : projects.paths.filter((path) => path !== target.path)
      if (projects.mode === 'except' && paths.length === 0) {
        return withParts(server, { projects: null })
      }
      return withParts(server, { projects: { mode: projects.mode, paths } })
    }
    case 'tool': {
      const off = server.toolsOff ?? []
      const next = on ? off.filter((tool) => tool !== target.tool) : [...off, target.tool]
      return withParts(server, { toolsOff: next })
    }
  }
}

/** A part as text that compares equal whatever order its lists are in. */
function key(value: McpSwitches[keyof McpSwitches] | undefined): string {
  if (Array.isArray(value)) return JSON.stringify([...value].sort())
  if (value && typeof value === 'object') {
    return JSON.stringify({ mode: value.mode, paths: [...value.paths].sort() })
  }
  return JSON.stringify(value ?? null)
}

/** What a change did to a server, or null when it changed none of its switches. */
export function restoreOf(before: MarketServer, after: MarketServer): McpRestore | null {
  const was = switchesOf(before)
  const now = switchesOf(after)
  const changed = PARTS.filter((part) => key(was[part]) !== key(now[part]))
  if (changed.length === 0) return null
  const pick = (from: McpSwitches): Partial<McpSwitches> =>
    Object.fromEntries(changed.map((part) => [part, from[part]])) as Partial<McpSwitches>
  return { serverId: before.id, before: pick(was), after: pick(now) }
}

/** Whether every part the change set still reads as it left it. */
export function restoreStands(server: MarketServer, restore: McpRestore): boolean {
  const now = switchesOf(server)
  return PARTS.every(
    (part) => !(part in restore.after) || key(now[part]) === key(restore.after[part]),
  )
}

/** The server with the parts the change set put back as they were. */
export function restored(server: MarketServer, restore: McpRestore): MarketServer {
  return withParts(server, restore.before)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProjects(value: unknown): value is McpProjects | null {
  return (
    value === null ||
    (isRecord(value) &&
      (value.mode === 'only' || value.mode === 'except') &&
      Array.isArray(value.paths) &&
      value.paths.every((path) => typeof path === 'string'))
  )
}

function isParts(value: unknown): value is Partial<McpSwitches> {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([part, item]) => {
    switch (part) {
      case 'on':
        return typeof item === 'boolean'
      case 'agents':
        return item === 'all' || (Array.isArray(item) && item.every(isAgentId))
      case 'projects':
        return isProjects(item)
      case 'toolsOff':
        return Array.isArray(item) && item.every((tool) => typeof tool === 'string')
      default:
        return false
    }
  })
}

export function isMcpRestore(value: unknown): value is McpRestore {
  return (
    isRecord(value) &&
    typeof value.serverId === 'string' &&
    isParts(value.before) &&
    isParts(value.after)
  )
}

export function isMcpSwitchTarget(value: unknown): value is McpSwitchTarget {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'server':
      return true
    case 'agent':
      return isAgentId(value.agentId)
    case 'project':
      return typeof value.path === 'string'
    case 'tool':
      return typeof value.tool === 'string'
    default:
      return false
  }
}
