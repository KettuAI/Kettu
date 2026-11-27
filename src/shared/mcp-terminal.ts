// An agent's CLI in a terminal using Kettu's MCP servers: Kettu writes one bridge entry per server
// into the agent's own file, after a backup, and keeps a record of what it wrote.

import type { AgentId } from './agents'
import type { McpDiscoveryFileError } from './mcp-discovery'

/** Why Kettu cannot take over an agent's file. */
export type McpTerminalUnsupported = 'format' | 'no-bridge'

/** One agent's row in Marketplace › MCP › Terminal and apps, and on its page in Settings. */
export interface McpTerminalRow {
  agentId: AgentId
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
  agentId: AgentId
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
  agentId: AgentId
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
