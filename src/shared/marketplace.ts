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
      // From an MCP bundle's manifest: the label, the kind of value and its default and bounds.
      title?: string
      kind?: 'string' | 'number' | 'boolean' | 'directory' | 'file'
      default?: string
      min?: number
      max?: number
    }

/** How an agent reaches a server: a URL, or a program it starts and talks to over stdio. */
export type McpSpec =
  | {
      type: 'http'
      transport: 'streamable-http' | 'sse'
      url: string
      headers: McpValue[]
      // Signs in with OAuth: Kettu keeps the tokens and agents reach the server through its proxy.
      oauth?: McpOAuth
    }
  | {
      type: 'stdio'
      command: string
      args: string[]
      env: McpValue[]
      // Runs on the host's own Node.js, resolved when a session starts, so no app path is stored.
      runtime?: 'node'
    }

/** How Kettu signs in to a remote server with OAuth. */
export interface McpOAuth {
  // The device flow of an app Kettu registered with the service, for one that registers no
  // clients (GitHub); otherwise the browser flow with dynamic client registration.
  flow: 'browser' | 'device'
}

/** Where a server Kettu keeps stands with its sign-in, by server id. */
export type MarketConnection =
  | { state: 'connected'; account: string | null }
  | { state: 'disconnected' } // never connected, or disconnected by the user
  | { state: 'needs-reconnect'; reason: string } // the token expired and could not be renewed
  | { state: 'error'; message: string }
export type MarketConnections = Record<string, MarketConnection>

/** What Connect starts: a page to open in the browser, or a code to enter at the service. */
export type ConnectStart =
  | { loginId: string; kind: 'browser'; url: string }
  | {
      loginId: string
      kind: 'device'
      userCode: string
      verificationUri: string
      expiresAt: number
    }
  // The server answered without a sign-in: it is connected already, and agents reach it directly.
  | { loginId: string; kind: 'open' }

/** A server Kettu keeps, stored in the host settings' `marketplace.mcp`. */
export interface MarketServer {
  id: string // the registry's name, such as io.github.github/github-mcp-server, or manual:<uuid>
  name: string // what agents call it: lowercase letters, digits, - and _, unique among Kettu's
  title: string
  // kettu: the Kettu Marketplace, by id kettu:<listing>; plugin: a plugin's, by id
  // plugin:<plugin>:<name>, removed with it
  source: 'registry' | 'manual' | 'kettu' | 'plugin'
  version: string | null // the registry's or the listing's version; null when added by hand
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

/** How long the host keeps each list before it reads it again, in ms. */
export const MARKET_KEPT_MS = {
  catalog: 24 * 60 * 60_000,
  skills: 24 * 60 * 60_000,
} as const

export interface MarketCatalog {
  sections: CatalogSection[]
  fetchedAt: number | null // ms since the epoch the registry last answered; null when it never has
  error: string | null // why the last read failed; the sections then come from the cache
  stale?: boolean // a `cached` answer older than MARKET_KEPT_MS; a read without `cached` renews it
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

/**
 * The name agents call a registry server by: the last part of its registry name, without the
 * words every server has, made unique among Kettu's and never `kettu`, Kettu's own server's.
 */
export function serverName(id: string, kept: readonly MarketServer[]): string {
  const last = id.split('/').pop() ?? id
  const plain = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[^a-z0-9]+|[-_]+$/g, '')
  const short = plain(last.replace(/^mcp[-_]?(server)?[-_]?|[-_]?mcp([-_]?server)?$/gi, ''))
  const base = (short || plain(last)).slice(0, 40)
  return uniqueName(MARKET_NAME.test(base) ? base : 'server', kept)
}

/** `base`, or `base-2`, `base-3`… when another server Kettu keeps or Kettu itself has it. */
function uniqueName(base: string, kept: readonly MarketServer[]): string {
  const taken = new Set(kept.map((s) => s.name))
  taken.add('kettu')
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`
    if (!taken.has(name)) return name
  }
}

/** A skill Kettu keeps, stored in the host settings' `marketplace.skills`; its files live on the host. */
export interface MarketSkill {
  // <owner>/<repo>:<name> from the catalog, github:<owner>/<repo>/<path>, local:<uuid>,
  // kettu:<listing>, or plugin:<plugin>:<name> for a plugin's, removed with it
  id: string
  name: string // the skill's own name, from its SKILL.md
  description: string
  source: 'catalog' | 'github' | 'local' | 'kettu' | 'plugin'
  // The repository URL, the folder it was copied from, @<publisher>/<slug>, or the plugin's name
  origin: string
  version: string | null // the commit or the listing's version it was copied at; null for a folder
  agents: 'all' | AgentId[]
  on: boolean
}

/**
 * How far a catalog repository's publisher is vouched for: the maker of the agent, an organization
 * whose domain GitHub verified, or neither.
 */
export type SkillTrust = 'official' | 'verified' | 'community'

/** A skill the catalog lists, from a repository the app knows. */
export interface CatalogSkill {
  id: string // <owner>/<repo>:<name>
  name: string
  description: string
  publisher: string
  official: boolean
  trust?: SkillTrust // absent from older hosts, whose catalog is Anthropic's alone
  repository: string // https URL
  path: string // the skill's folder in the repository
  version: string | null // the commit the catalog was read at
  // Its SKILL.md's own words, an SPDX id read from a license file, or the name of a file that
  // holds terms Kettu does not know; null when nothing says. Absent from older hosts.
  license?: string | null
  allowedTools?: string[] // its `allowed-tools`, used without asking; absent from older hosts
}

/** A repository of the skills catalog, as the host last read it. */
export interface SkillRepository {
  id: string // <owner>/<repo>
  publisher: string
  trust: SkillTrust
  url: string // https URL
  read: boolean // whether the host has a copy; a `cached` answer reads none it lacks
  error: string | null // why the last read failed; the skills then come from the copy before
  stale?: boolean // as MarketCatalog's, for this repository's copy
}

/** One repository of the catalog, read on its own. */
export interface MarketSkillRepository {
  repository: SkillRepository
  skills: CatalogSkill[]
}

// GitHub's own rules for an account's name, and the characters a repository's name may hold.
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/
// A skill's name as the Agent Skills specification has it.
export const SKILL_NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/

/** A repository's `<owner>/<repo>`, or null when it could not name one on GitHub. */
export function skillRepositoryId(text: string): { owner: string; repo: string } | null {
  const [owner = '', repo = '', ...rest] = text.split('/')
  if (rest.length > 0 || !GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo)) return null
  return repo === '.' || repo === '..' ? null : { owner, repo }
}

/** A catalog skill's id, `<owner>/<repo>:<name>`, read into its parts; null for anything else. */
export function catalogSkillId(id: string): { repository: string; name: string } | null {
  const colon = id.indexOf(':')
  if (colon < 0) return null
  const repository = id.slice(0, colon)
  const name = id.slice(colon + 1)
  return skillRepositoryId(repository) && SKILL_NAME.test(name) ? { repository, name } : null
}

/** Where a skill to add comes from. */
export type SkillSource =
  | { kind: 'catalog'; id: string }
  | { kind: 'github'; url: string } // a repository or one folder in it, on github.com
  | { kind: 'local'; path: string } // a folder on the host with a SKILL.md
  | { kind: 'kettu'; id: string } // a listing of the Kettu Marketplace, at its current version

/** A skill an agent has of its own, read only. */
export interface AgentOwnSkill {
  agentId: AgentId
  name: string
  description: string
  path: string
  enabled: boolean
  plugin: string | null // the plugin it came with, by id
}

/** A skill Kettu ships, handed to every agent that reaches Kettu's own server; never removed. */
export interface BuiltinSkill {
  name: string
  description: string
}

export interface MarketSkills {
  catalog: CatalogSkill[]
  own: AgentOwnSkill[]
  error: string | null // the repositories that could not be read and why; theirs come from the cache
  stale?: boolean // as MarketCatalog's
  repositories?: SkillRepository[] // in the catalog's order; absent from older hosts
  builtIn?: BuiltinSkill[] // Kettu's own, for the features that are on; absent from older hosts
}

/** The harnesses with plugins of their own, which Kettu only lists. */
export type PluginHarness = 'claude-code' | 'codex'
export type PluginScope = 'user' | 'project' | 'local'

/** A plugin in one agent's own configuration. */
export interface AgentOwnPlugin {
  id: string // <name>@<marketplace>, as the harness names it
  harness: PluginHarness
  agentId: AgentId
  version: string | null
  scope: PluginScope
  enabled: boolean
  projectPath: string | null // for a project or local scope
}

export interface AgentOwnPlugins {
  plugins: AgentOwnPlugin[]
  errors: { agentId: AgentId; message: string }[]
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
