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
import type { TFunction } from 'i18next'
import { listingIdOf, type CommunityItem, type CommunityStanding } from '@shared/market-community'
import { compareVersions } from '@shared/market-publish'
import { harnessOf } from '@shared/agents'
import type { AgentId, HarnessId } from '@shared/thread'
import { basename } from '@renderer/lib/format'
import { currentLocale } from '@renderer/lib/i18n'
import type { HostScope } from '@renderer/stores/host-scope'
import { workflowsKey, useWorkflowsStore } from '@renderer/stores/workflows'
import { workflowName } from './workflow-model'
import { publishedStore } from '@renderer/stores/market-published'
import { publishedTitle } from './published-keys'

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

/**
 * A path with the home folder as `~`, for showing only. The renderer is not told the home folder,
 * so this knows the usual places of macOS, Linux and Windows.
 */
export function homeShort(path: string): string {
  return path.replace(
    /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/,
    '~',
  )
}

/** The folder a file or folder is in, by either separator. */
export function parentPath(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
}

/** The catalog's entry for a server, from its sections or the last search. */
export function catalogEntry(scope: HostScope, id: string): CatalogServer | null {
  const { catalog, search } = scope.useMarketplaceStore.getState()
  return (
    catalogServers(catalog).find((item) => item.id === id) ??
    search?.result?.items.find((item) => item.id === id) ??
    null
  )
}

/** The listing of `id`: the catalog's entry where there is one, else the server Kettu keeps. */
export function findListing(scope: HostScope, id: string, kept: MarketServer[]): Listing | null {
  const entry = catalogEntry(scope, id)
  if (entry) return fromCatalog(entry)
  const server = kept.find((s) => s.id === id)
  return server ? fromKept(server) : null
}

/**
 * What a listing shows: an MCP server, a harness's plugin, a skill or a workflow, by its id, or a
 * listing of the Kettu Marketplace, by the listing's.
 */
export type ItemRef =
  | { kind: 'mcp'; id: string }
  | { kind: 'plugin'; harness: PluginHarness; id: string }
  | { kind: 'skill'; id: string }
  | { kind: 'workflow'; id: string }
  | { kind: 'community'; id: string }

/**
 * The `item` of a listing's view: `mcp:<id>`, `plugin:<harness>/<id>`, `skill:<id>`,
 * `workflow:<id>` or `community:<listing>`.
 */
export function itemKey(ref: ItemRef): string {
  return ref.kind === 'plugin' ? `plugin:${ref.harness}/${ref.id}` : `${ref.kind}:${ref.id}`
}

export function parseItem(key: string): ItemRef | null {
  const colon = key.indexOf(':')
  const kind = key.slice(0, colon)
  const rest = key.slice(colon + 1)
  if (colon < 0 || !rest) return null
  if (kind === 'mcp' || kind === 'skill' || kind === 'workflow' || kind === 'community') {
    return { kind, id: rest }
  }
  if (kind !== 'plugin') return null
  const slash = rest.indexOf('/')
  const harness = rest.slice(0, slash)
  if (slash < 0 || (harness !== 'claude-code' && harness !== 'codex')) return null
  return { kind, harness, id: rest.slice(slash + 1) }
}

/** A listing's name for the history, where the stores know it. */
export function listingTitle(scope: HostScope, key: string): string | null {
  const own = publishedTitle(publishedStore(scope.hostId, scope.request).getState().published, key)
  if (own !== undefined) return own
  const ref = parseItem(key)
  if (!ref) return null
  if (ref.kind === 'workflow') {
    const entry = useWorkflowsStore
      .getState()
      .byHost[workflowsKey(scope.hostId)]?.entries.find((e) => e.id === ref.id)
    return entry ? workflowName(entry, currentLocale()) : null
  }
  const { mcp, skills } = scope.useSettingsStore.getState().settings.marketplace
  if (ref.kind === 'community') return communityItem(scope, ref.id)?.name ?? null
  if (ref.kind === 'mcp') return findListing(scope, ref.id, mcp)?.title ?? null
  if (ref.kind === 'plugin') return catalogPlugin(scope, ref.harness, ref.id)?.title ?? null
  const name = catalogSkill(scope, ref.id)?.name ?? skills.find((s) => s.id === ref.id)?.name
  return name ? displayTitle(name) : null
}

/** A listing of the Kettu Marketplace, from its page or the directory the host last gave. */
export function communityItem(
  scope: HostScope,
  id: string,
): Pick<CommunityItem, 'name' | 'kind'> | null {
  const { communityPages, communityListings } = scope.useMarketplaceStore.getState()
  const page = communityListings[id]?.listing
  if (page?.state === 'listed') return page.listing
  for (const pages of Object.values(communityPages)) {
    const found =
      pages.items.find((item) => item.id === id) ?? pages.yours.find((item) => item.id === id)
    if (found) return found
  }
  return null
}

/**
 * The key of a kept item's listing: the Kettu Marketplace's page for what came from it, else
 * the item's own.
 */
export function keptItemKey(kind: 'mcp' | 'skill', id: string): string {
  const listing = listingIdOf(id)
  return itemKey(listing ? { kind: 'community', id: listing } : { kind, id })
}

/** Whether a listing's current version is newer than, or replaces, the one installed. */
export function updateFor(
  standing: CommunityStanding | undefined,
  installed: string | null,
): string | null {
  if (!standing || (standing.state !== 'listed' && standing.state !== 'unlisted')) return null
  if (installed === null || standing.current === installed) return null
  // A withdrawn version moves its installs to the current one, even a lower one.
  return compareVersions(standing.current, installed) > 0 || !standing.versions.includes(installed)
    ? standing.current
    : null
}

/** A plugin of the harnesses' marketplaces, as the host last listed them. */
export function catalogPlugin(
  scope: HostScope,
  harness: PluginHarness,
  id: string,
): CatalogPlugin | null {
  const plugins = scope.useMarketplaceStore.getState().plugins
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

export function catalogSkill(scope: HostScope, id: string): CatalogSkill | null {
  return scope.useMarketplaceStore.getState().skills?.catalog.find((s) => s.id === id) ?? null
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

// Kettu hands Pi no skills folder yet.
const NO_SKILLS: readonly HarnessId[] = ['pi']

/** Whether Kettu can hand an agent the skills it keeps. */
export function takesSkills(agentId: AgentId): boolean {
  return !NO_SKILLS.includes(harnessOf(agentId))
}

/** Where a plugin is installed: every project, or the one project. */
export function scopeLine(plugin: InstalledPlugin, t: TFunction<'marketplace'>): string {
  return plugin.scope === 'user'
    ? t('plugin.scopeUser')
    : t(plugin.scope === 'local' ? 'plugin.scopeLocalIn' : 'plugin.scopeProjectIn', {
        project: basename(plugin.projectPath ?? ''),
      })
}
