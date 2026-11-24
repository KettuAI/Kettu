// What the Marketplace shows of a server or skill, wherever it is known from: the
// catalogs, a search, or what Kettu and the agents keep; and the names, lists and command lines
// its pages build.

import {
  displayTitle,
  MARKET_NAME,
  specInputs,
  type CatalogServer,
  type CatalogSkill,
  type AgentOwnPlugin,
  type MarketCatalog,
  type MarketServer,
  type MarketSkill,
  type McpSpec,
} from '@shared/marketplace'
import type { TFunction } from 'i18next'
import { listingIdOf, type CommunityItem, type CommunityStanding } from '@shared/market-community'
import { compareVersions } from '@shared/market-publish'
import { basename } from '@renderer/lib/format'
import { currentLocale } from '@renderer/lib/i18n'
import type { HostScope } from '@renderer/stores/host-scope'
import { workflowsKey, useWorkflowsStore } from '@renderer/stores/workflows'
import { workflowName } from './workflow-model'
import { publishedStore } from '@renderer/stores/market-published'
import { publishedTitle } from './published-keys'
import { pluginTitle } from './plugin-model'

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
 * What a listing shows: an MCP server, a skill or a workflow, by its id, or a listing of the Kettu
 * Marketplace, by the listing's.
 */
export type ItemRef =
  | { kind: 'plugin'; id: string }
  | { kind: 'mcp'; id: string }
  | { kind: 'skill'; id: string }
  | { kind: 'workflow'; id: string }
  | { kind: 'community'; id: string }

/**
 * The `item` of a listing's view: `plugin:<id>` for an installed Kettu plugin, `mcp:<id>`,
 * `skill:<id>`, `workflow:<id>` or `community:<listing>`.
 */
export function itemKey(ref: ItemRef): string {
  return `${ref.kind}:${ref.id}`
}

export function parseItem(key: string): ItemRef | null {
  const colon = key.indexOf(':')
  const kind = key.slice(0, colon)
  const rest = key.slice(colon + 1)
  if (colon < 0 || !rest) return null
  if (
    kind === 'plugin' ||
    kind === 'mcp' ||
    kind === 'skill' ||
    kind === 'workflow' ||
    kind === 'community'
  ) {
    return { kind, id: rest }
  }
  return null
}

/** A listing's name for the history, where the stores know it. */
export function listingTitle(scope: HostScope, key: string): string | null {
  const own = publishedTitle(publishedStore(scope.hostId, scope.request).getState().published, key)
  if (own !== undefined) return own
  const ref = parseItem(key)
  if (!ref) return null
  if (ref.kind === 'plugin') {
    const plugin = scope.useMarketplaceStore.getState().plugins?.find((p) => p.id === ref.id)
    return plugin ? pluginTitle(plugin.contents, currentLocale()) : null
  }
  if (ref.kind === 'workflow') {
    const entry = useWorkflowsStore
      .getState()
      .byHost[workflowsKey(scope.hostId)]?.entries.find((e) => e.id === ref.id)
    return entry ? workflowName(entry, currentLocale()) : null
  }
  const { mcp, skills } = scope.useSettingsStore.getState().settings.marketplace
  if (ref.kind === 'community') return communityItem(scope, ref.id)?.name ?? null
  if (ref.kind === 'mcp') return findListing(scope, ref.id, mcp)?.title ?? null
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

export function skillMatches(skill: CatalogSkill | MarketSkill, query: string): boolean {
  return matchesText(
    [skill.name, 'publisher' in skill ? skill.publisher : null, skill.description],
    query,
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

/** Where a plugin is installed: every project, or the one project. */
export function scopeLine(plugin: AgentOwnPlugin, t: TFunction<'marketplace'>): string {
  return plugin.scope === 'user'
    ? t('plugin.scopeUser')
    : t(plugin.scope === 'local' ? 'plugin.scopeLocalIn' : 'plugin.scopeProjectIn', {
        project: basename(plugin.projectPath ?? ''),
      })
}
