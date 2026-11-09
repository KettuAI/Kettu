// The Marketplace: the MCP servers its catalog lists, and the ones Kettu keeps on the host and hands
// to agents when their sessions start. Keys never travel in these shapes; clients only learn that one
// is set.

import type { AgentId } from './agents'

/** A header or environment variable: a fixed value, or one the user fills in when installing. */
export type McpValue =
  | { name: string; value: string }
  | {
      name: string
      input: true
      // A secret shows as a password and never comes back; both kinds live in the key store.
      secret: boolean
      required: boolean
      description?: string
      // Sent before the value, such as `Bearer ` for a header that wants a bearer token.
      prefix?: string
    }

/** How an agent reaches a server: a URL, or a program it starts and talks to over stdio. */
export type McpSpec =
  | { type: 'http'; transport: 'streamable-http' | 'sse'; url: string; headers: McpValue[] }
  | { type: 'stdio'; command: string; args: string[]; env: McpValue[] }

/** A server Kettu keeps, stored in the host settings' `marketplace.mcp`. */
export interface MarketServer {
  id: string // the registry's name, such as io.github.github/github-mcp-server, or manual:<uuid>
  name: string // what agents call it: lowercase letters, digits, - and _, unique among Kettu's
  title: string
  source: 'registry' | 'manual'
  version: string | null // the registry's version; null when added by hand
  spec: McpSpec
  agents: 'all' | AgentId[] // the agents that get it; 'all' takes in agents added later
  on: boolean
}

/** One server in the catalog, with the spec Kettu would install: its remote first, else a package. */
export interface CatalogServer {
  id: string // the registry's name
  title: string
  publisher: string
  official: boolean // published by the maker of the service, per the app's own list
  description: string
  version: string
  updated: string | null // ISO date the registry last changed it
  repository: string | null // https URL
  website: string | null // https URL
  brand: string | null // a mark the app ships for this server, from the featured list
  spec: McpSpec
}

/** A group of the catalog; its title comes from the app's copy by id. */
export interface CatalogSection {
  id: string // featured, development, data, productivity, design
  items: CatalogServer[]
}

export interface MarketCatalog {
  sections: CatalogSection[]
  fetchedAt: number | null // ms since the epoch the registry last answered; null when it never has
  error: string | null // why the last read failed; the sections then come from the cache
}

export interface MarketSearch {
  query: string
  items: CatalogServer[]
  error: string | null
}

/** Which of each server's inputs have a value in the key store, by server id. */
export type MarketKeyState = Record<string, string[]>

/** What a client sends to fill or clear a server's inputs; null clears one. */
export interface MarketKeysPatch {
  serverId: string
  values: Record<string, string | null>
}

/** The inputs a spec asks for, in order. */
export function specInputs(spec: McpSpec): Extract<McpValue, { input: true }>[] {
  const values = spec.type === 'http' ? spec.headers : spec.env
  return values.filter((v): v is Extract<McpValue, { input: true }> => 'input' in v)
}

/** The command line or URL a spec runs, without any value the user filled in. */
export function specRuns(spec: McpSpec): string {
  return spec.type === 'http' ? spec.url : [spec.command, ...spec.args].join(' ')
}

/** Whether a server goes to an agent. */
export function serverFor(server: MarketServer, agentId: AgentId): boolean {
  return server.on && (server.agents === 'all' || server.agents.includes(agentId))
}

export const MARKET_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/

/** A skill Kettu keeps, stored in the host settings' `marketplace.skills`; its files live on the host. */
export interface MarketSkill {
  id: string // anthropics/skills:pdf, github:<owner>/<repo>/<path>, or local:<uuid>
  name: string // the skill's own name, from its SKILL.md
  description: string
  source: 'catalog' | 'github' | 'local'
  origin: string // the repository URL, or the folder it was copied from
  version: string | null // the commit it was copied at; null for a local folder
  agents: 'all' | AgentId[]
  on: boolean
}

/** A skill the catalog lists, from a repository the app knows. */
export interface CatalogSkill {
  id: string
  name: string
  description: string
  publisher: string
  official: boolean
  repository: string // https URL
  path: string // the skill's folder in the repository
  version: string | null // the commit the catalog was read at
}

/** Where a skill to add comes from. */
export type SkillSource =
  | { kind: 'catalog'; id: string }
  | { kind: 'github'; url: string } // a repository or one folder in it, on github.com
  | { kind: 'local'; path: string } // a folder on the host with a SKILL.md

/** A skill an agent has of its own, read only. */
export interface AgentOwnSkill {
  agentId: AgentId
  name: string
  description: string
  path: string
  enabled: boolean
  plugin: string | null // the plugin it came with, by id
}

export interface MarketSkills {
  catalog: CatalogSkill[]
  own: AgentOwnSkill[]
  error: string | null // why the catalog could not be read; it then comes from the cache
}

/** The harnesses that install plugins themselves. */
export type PluginHarness = 'claude-code' | 'codex'
export type PluginScope = 'user' | 'project' | 'local'

/** A plugin one of the harnesses' marketplaces offers. */
export interface CatalogPlugin {
  id: string // <name>@<marketplace>, as the harness names it
  harness: PluginHarness
  name: string
  title: string
  description: string
  publisher: string | null
  official: boolean // in the harness maker's own marketplace
  marketplace: string
  category: string | null
  homepage: string | null // https URL
  installs: number | null // as the marketplace counts them
  version: string | null
  featured: boolean
}

/** A plugin installed in one agent's configuration. */
export interface InstalledPlugin {
  id: string
  harness: PluginHarness
  agentId: AgentId
  version: string | null
  scope: PluginScope
  enabled: boolean
  projectPath: string | null // for a project or local scope
}

export interface PluginMarketplace {
  harness: PluginHarness
  agentId: AgentId
  name: string
  source: string // owner/repo, a Git URL or a path, as the harness reports it
  official: boolean
}

export interface MarketPlugins {
  catalog: CatalogPlugin[]
  installed: InstalledPlugin[]
  marketplaces: PluginMarketplace[]
  errors: { agentId: AgentId; message: string }[]
}

/** What a plugin adds, as its harness reports it. */
export interface PluginDetails {
  id: string
  agentId: AgentId
  description: string | null
  skills: string[]
  commands: string[]
  agents: string[]
  hooks: string[]
  mcpServers: string[]
  lspServers: string[]
  alwaysOnTokens: number | null // what it adds to every session, when the harness says
}

// Words a lowercase name holds that read wrong with only their first letter capitalized.
const CASED: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  aws: 'AWS',
  claude: 'Claude',
  codex: 'Codex',
  css: 'CSS',
  docx: 'DOCX',
  github: 'GitHub',
  gitlab: 'GitLab',
  html: 'HTML',
  ios: 'iOS',
  json: 'JSON',
  lsp: 'LSP',
  mcp: 'MCP',
  md: 'MD',
  pdf: 'PDF',
  pptx: 'PPTX',
  pr: 'PR',
  sdk: 'SDK',
  sql: 'SQL',
  ui: 'UI',
  url: 'URL',
  xlsx: 'XLSX',
}

/** A name to show for a slug such as `code-review` (Code review); other names stay as they are. */
export function displayTitle(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return name
  const words = name.split(/[-_]+/).filter(Boolean)
  return words
    .map((word, i) => CASED[word] ?? (i === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
}
