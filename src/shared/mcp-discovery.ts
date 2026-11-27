import type { AgentId } from './agents'
import type { MarketServer, McpSpec } from './marketplace'

export interface McpConfigSource {
  path: string
  agentId?: AgentId
  app?: string
  project?: string
  entryName?: string
}

export interface McpDiscoverySource extends McpConfigSource {
  id: string
  name: string
  keys: string[]
  spec?: McpSpec
  imported?: boolean
}

export interface McpDiscoveryFileError {
  source: McpConfigSource
  reason:
    | 'permission'
    | 'not-file'
    | 'too-large'
    | 'invalid-json'
    | 'invalid-toml'
    | 'invalid-yaml'
    | 'invalid-server'
    | 'unreadable'
  line?: number
}

export interface McpDiscoveryRow {
  id: string
  name: string
  spec: McpSpec
  sources: McpDiscoverySource[]
  differentKeys: string[]
  existing: string[]
  nameConflict: boolean
  isNew: boolean
}

export interface McpDiscovery {
  servers: McpDiscoveryRow[]
  errors: McpDiscoveryFileError[]
  notice: string | null
}

export interface McpInstallEntry {
  server: MarketServer
  secrets: Record<string, string>
}

export interface McpImportChoice {
  id: string
  sourceId?: string
  name: string
  agents: MarketServer['agents']
  another?: boolean
}

export type McpCheck =
  | { state: 'checking' }
  | { state: 'connected'; tools: number; startMs: number; initializeMs: number; toolsMs: number }
  | { state: 'needs-sign-in' }
  | { state: 'project-only' }
  | {
      state: 'error'
      reason:
        'command-not-found' | 'exited' | 'timeout' | 'http' | 'cannot-connect' | 'missing-variable'
      step?: 'start' | 'initialize' | 'tools'
      seconds?: number
      status?: number
      detail?: string
    }
