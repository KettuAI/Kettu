// An agent's CLI in a terminal, or an app, using Kettu's MCP servers: Kettu writes one bridge
// entry per server into its own file, after a backup, and keeps a record of what it wrote.

import { isAgentId, type AgentId } from './agents'
import type { McpDiscoveryFileError } from './mcp-discovery'

/** The apps whose MCP file Kettu can take over, by the name discovery lists them under. */
export const MCP_TERMINAL_APPS = {
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  devin: 'Devin Desktop',
  zed: 'Zed',
} as const

export type McpTerminalApp = keyof typeof MCP_TERMINAL_APPS

/** Whose file a takeover changes: an agent's, or an app's as `app:<id>`. */
export type McpTerminalTarget = AgentId | `app:${McpTerminalApp}`

/** The app a target is, or null for an agent. */
export function terminalApp(target: string): McpTerminalApp | null {
  if (!target.startsWith('app:')) return null
  const app = target.slice(4)
  return Object.hasOwn(MCP_TERMINAL_APPS, app) ? (app as McpTerminalApp) : null
}

export function isTerminalTarget(value: unknown): value is McpTerminalTarget {
  return typeof value === 'string' && (isAgentId(value) || terminalApp(value) !== null)
}

/** Why Kettu cannot take over a file. */
export type McpTerminalUnsupported = 'format' | 'no-bridge'

/** One agent's or app's row in Marketplace › MCP › Terminal and apps; an agent's is on its page too. */
export interface McpTerminalRow {
  target: McpTerminalTarget
  /** The file Kettu changes, where the agent's CLI reads its servers. */
  file: string
  on: boolean
  /** Set when Kettu cannot write this agent's file, so its switch is off and disabled. */
  unsupported?: McpTerminalUnsupported
  /** The servers its file sets up that are not Kettu's entries. */
  own: number
  /** When Kettu last backed the file up, before a change. */
  backedUpAt: number | null
  /** Entries Kettu wrote that were changed or removed outside Kettu since. */
  changed: number
  /** The file cannot be read now, so Kettu writes nothing to it. */
  error?: McpDiscoveryFileError['reason']
  /** Apps that read this same file, which this row's switch covers too. */
  shared?: McpTerminalApp[]
}

/** One file of a takeover's change, its changed key shown before and after, keys masked. */
export interface McpTerminalFileChange {
  path: string
  /** The keys Kettu changes in it, such as `mcpServers` or `permissions.deny`. */
  keys: string[]
  /** What the change is for: the servers, or the tools turned off in Kettu. */
  kind: 'servers' | 'tools'
  /** How many tools go into the agent's own setting, for `tools`. */
  tools?: number
  before: string
  after: string
}

/** What turning a takeover on will do, shown before anything is written. */
export interface McpTerminalPlan {
  target: McpTerminalTarget
  /** Confirms the plan: turning on refuses when the file changed since. */
  id: string
  files: McpTerminalFileChange[]
  /** The agent's own servers that are imported first; `keys` when values move to the keychain. */
  imports: { name: string; command: string; keys: boolean }[]
  /** What the agent gets through Kettu afterwards. */
  entries: { name: string; replaces: boolean }[]
}

/** What turning a takeover off puts back and removes. */
export interface McpTerminalOffPlan {
  target: McpTerminalTarget
  /** The agent's own entries that come back, as they were. */
  back: { name: string; command: string; keys: boolean }[]
  /** Kettu's entries the terminal goes without. */
  removed: string[]
  /** Tools Kettu wrote into the agent's own setting, which come out again. */
  tools: number
}

/** A copy of the file as it was before one of Kettu's writes. */
export interface McpTerminalBackup {
  id: string
  at: number
  /** What the write after it did. */
  reason: 'takeover' | 'update' | 'apply' | 'restore' | 'off'
  /** The servers Kettu had written in the file then; 0 for the one before the takeover. */
  servers: number
  /** Restoring it turns the takeover off. */
  first: boolean
}

/** An entry Kettu wrote that changed outside Kettu, for the user to decide on. */
export interface McpTerminalDrift {
  name: string
  kind: 'changed' | 'removed'
  /** What the file's entry runs or connects to now, for `changed`. */
  command?: string
  /** The file's entry holds values written in it. */
  keys?: boolean
}

/** For each drifted entry: keep the file's version, or put Kettu's back. */
export type McpTerminalChoice = 'file' | 'kettu'
