// What the Marketplace shows of a server, plugin or skill, wherever it is known from: the
// catalogs, a search, or what Kettu and the agents keep; and the names, lists and command lines
// its pages build.

import {
  displayTitle,
  MARKET_NAME,
  specInputs,
  type CatalogPlugin,
  type CatalogServer,
  type CatalogSkill,
  type InstalledPlugin,
  type MarketCatalog,
  type MarketServer,
  type MarketSkill,
  type McpSpec,
  type PluginHarness,
} from '@shared/marketplace'
import { harnessOf } from '@shared/agents'
import type { AgentId, HarnessId } from '@shared/thread'
import { useMarketplaceStore } from '@renderer/stores/marketplace'
import { useSettingsStore } from '@renderer/stores/settings'

/** A server as its listing shows it; what only the catalog knows is null for one added by hand. */
export interface Listing {
  id: string
  title: string
  publisher: string | null
  official: boolean
  description: string | null
  version: string | null
  updated: string | null
  repository: string | null
  website: string | null
  brand: string | null
  spec: McpSpec
  source: MarketServer['source']
}

/** Every server of the catalog, once each, in the order its sections list them. */
export function catalogServers(catalog: MarketCatalog | null): CatalogServer[] {
  const seen = new Set<string>()
  const all: CatalogServer[] = []
  for (const section of catalog?.sections ?? []) {
    for (const item of section.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      all.push(item)
    }
  }
  return all
}

export function fromCatalog(server: CatalogServer): Listing {
  return {
    id: server.id,
    title: server.title,
    publisher: server.publisher,
    official: server.official,
    description: server.description || null,
    version: server.version,
    updated: server.updated,
    repository: server.repository,
    website: server.website,
    brand: server.brand,
    spec: server.spec,
    source: 'registry',
  }
}

/** A kept server's listing, from what Kettu stored when it was installed or added. */
export function fromKept(server: MarketServer): Listing {
  return {
    id: server.id,
    title: server.title,
    publisher: null,
    official: false,
    description: null,
    version: server.version,
    updated: null,
    repository: null,
    website: null,
    brand: null,
    spec: server.spec,
    source: server.source,
  }
}

/** The catalog's entry for a server, from its sections or the last search. */
export function catalogEntry(id: string): CatalogServer | null {
  const { catalog, search } = useMarketplaceStore.getState()
  return (
    catalogServers(catalog).find((item) => item.id === id) ??
    search?.result?.items.find((item) => item.id === id) ??
    null
  )
}

/** The listing of `id`: the catalog's entry where there is one, else the server Kettu keeps. */
export function findListing(id: string, kept: MarketServer[]): Listing | null {
  const entry = catalogEntry(id)
  if (entry) return fromCatalog(entry)
  const server = kept.find((s) => s.id === id)
  return server ? fromKept(server) : null
}

/** What a listing shows: an MCP server, a harness's plugin or a skill, by its id. */
export type ItemRef =
  | { kind: 'mcp'; id: string }
  | { kind: 'plugin'; harness: PluginHarness; id: string }
  | { kind: 'skill'; id: string }

/** The `item` of a listing's view: `mcp:<id>`, `plugin:<harness>/<id>` or `skill:<id>`. */
export function itemKey(ref: ItemRef): string {
  return ref.kind === 'plugin' ? `plugin:${ref.harness}/${ref.id}` : `${ref.kind}:${ref.id}`
}

export function parseItem(key: string): ItemRef | null {
  const colon = key.indexOf(':')
  const kind = key.slice(0, colon)
  const rest = key.slice(colon + 1)
  if (colon < 0 || !rest) return null
  if (kind === 'mcp' || kind === 'skill') return { kind, id: rest }
  if (kind !== 'plugin') return null
  const slash = rest.indexOf('/')
  const harness = rest.slice(0, slash)
  if (slash < 0 || (harness !== 'claude-code' && harness !== 'codex')) return null
  return { kind, harness, id: rest.slice(slash + 1) }
}

/** A listing's name for the history, where the stores know it. */
export function listingTitle(key: string): string | null {
  const ref = parseItem(key)
  if (!ref) return null
  const { mcp, skills } = useSettingsStore.getState().settings.marketplace
  if (ref.kind === 'mcp') return findListing(ref.id, mcp)?.title ?? null
  if (ref.kind === 'plugin') return catalogPlugin(ref.harness, ref.id)?.title ?? null
  const name = catalogSkill(ref.id)?.name ?? skills.find((s) => s.id === ref.id)?.name
  return name ? displayTitle(name) : null
}

/** A plugin of the harnesses' marketplaces, as the host last listed them. */
export function catalogPlugin(harness: PluginHarness, id: string): CatalogPlugin | null {
  const plugins = useMarketplaceStore.getState().plugins
  return plugins?.catalog.find((p) => p.harness === harness && p.id === id) ?? null
}

/** The agents' installs of a plugin. */
export function pluginInstalls(
  installed: InstalledPlugin[] | undefined,
  harness: PluginHarness,
  id: string,
): InstalledPlugin[] {
  return (installed ?? []).filter((p) => p.harness === harness && p.id === id)
}

export function catalogSkill(id: string): CatalogSkill | null {
  return useMarketplaceStore.getState().skills?.catalog.find((s) => s.id === id) ?? null
}

/** A plugin's name before the marketplace it comes from: `review@market` is `review`. */
export function pluginName(id: string): string {
  const at = id.lastIndexOf('@')
  return at > 0 ? id.slice(0, at) : id
}

/** Whether text matches what the search field holds. */
export function matchesText(parts: (string | null | undefined)[], query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return parts.filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)
}

export function pluginMatches(plugin: CatalogPlugin, query: string): boolean {
  return matchesText(
    [plugin.title, plugin.name, plugin.publisher, plugin.description, plugin.category],
    query,
  )
}

export function skillMatches(skill: CatalogSkill | MarketSkill, query: string): boolean {
  return matchesText(
    [skill.name, 'publisher' in skill ? skill.publisher : null, skill.description],
    query,
  )
}

/** A plugin category's title: the marketplace's own word, capitalized. */
export function categoryTitle(category: string): string {
  const words = category.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toLocaleUpperCase() + words.slice(1)
}

/** Most installed first; plugins without a count after, their marketplace's picks first, then by title. */
export function byInstalls(a: CatalogPlugin, b: CatalogPlugin): number {
  // Codex counts no installs, so its own picks lead there.
  return (
    (b.installs ?? -1) - (a.installs ?? -1) ||
    Number(b.featured) - Number(a.featured) ||
    a.title.localeCompare(b.title)
  )
}

/** Whether a plugin comes from Anthropic itself, in Claude Code's official marketplace. */
export function fromAnthropic(plugin: CatalogPlugin): boolean {
  return (
    plugin.harness === 'claude-code' && plugin.official && /anthropic/i.test(plugin.publisher ?? '')
  )
}

export function skillFromAnthropic(skill: CatalogSkill): boolean {
  return /anthropic/i.test(skill.publisher) || skill.id.startsWith('anthropics/skills')
}

/** Whether a listing matches what the search field holds, by its name, maker and line. */
export function matchesQuery(listing: Listing, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return [listing.title, listing.publisher, listing.description, listing.id]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
    .includes(needle)
}

/**
 * The name agents call a registry server by: the last part of its registry name, without the
 * words every server has, made unique among Kettu's and never `kettu`, Kettu's own server's.
 */
export function serverName(id: string, kept: MarketServer[]): string {
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
function uniqueName(base: string, kept: MarketServer[]): string {
  const taken = new Set(kept.map((s) => s.name))
  taken.add('kettu')
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`
    if (!taken.has(name)) return name
  }
}

/** Whether a name a user typed can be a server's name among the ones Kettu keeps. */
export function nameProblem(
  name: string,
  kept: MarketServer[],
): 'empty' | 'format' | 'reserved' | 'taken' | null {
  if (!name) return 'empty'
  if (!MARKET_NAME.test(name)) return 'format'
  if (name === 'kettu') return 'reserved'
  if (kept.some((s) => s.name === name)) return 'taken'
  return null
}

/** Whether a server asks for anything when it is installed. */
export function asksFirst(spec: McpSpec): boolean {
  return specInputs(spec).length > 0
}

/** How a server signs in with OAuth, or null for one that takes keys or nothing. */
export function oauthFlow(spec: McpSpec): 'browser' | 'device' | null {
  return spec.type === 'http' && spec.oauth ? spec.oauth.flow : null
}

/**
 * A command line split into its words as a shell would split it: spaces separate them, quotes
 * keep spaces in one, and a backslash keeps the next character. Null while a quote is open.
 */
export function splitCommand(line: string): string[] | null {
  const words: string[] = []
  let word = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      has = true
    } else if (char === '\\' && i + 1 < line.length) {
      word += line[++i]
      has = true
    } else if (/\s/.test(char)) {
      if (has) words.push(word)
      word = ''
      has = false
    } else {
      word += char
      has = true
    }
  }
  if (quote) return null
  if (has) words.push(word)
  return words
}

/** Other servers of the catalog to show under a listing: its publisher's, else its sections'. */
export function relatedServers(id: string, catalog: MarketCatalog | null, limit = 4) {
  const all = catalogServers(catalog).filter((item) => item.id !== id)
  const self = catalogServers(catalog).find((item) => item.id === id)
  const same = self ? all.filter((item) => item.publisher === self.publisher) : []
  if (same.length >= 2) return { byPublisher: true, items: same.slice(0, limit) }
  const sections = (catalog?.sections ?? []).filter((s) => s.items.some((item) => item.id === id))
  const near = sections.flatMap((s) => s.items).filter((item) => item.id !== id)
  const items = [...new Map((near.length ? near : all).map((item) => [item.id, item])).values()]
  return { byPublisher: false, items: items.slice(0, limit) }
}

// pi-acp starts pi with fixed arguments, so Kettu has nowhere to hand Pi a skills folder.
const NO_SKILLS: readonly HarnessId[] = ['pi']

/** Whether Kettu can hand an agent the skills it keeps. */
export function takesSkills(agentId: AgentId): boolean {
  return !NO_SKILLS.includes(harnessOf(agentId))
}
