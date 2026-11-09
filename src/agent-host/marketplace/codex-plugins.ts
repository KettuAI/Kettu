// Codex's plugins and skills through the agent's own app-server: its local and curated
// marketplaces, never the remote catalog of ChatGPT apps, and the skills Codex has of its own.

import type {
  AgentOwnSkill,
  CatalogPlugin,
  InstalledPlugin,
  PluginDetails,
  PluginMarketplace,
} from '@shared/marketplace'
import { displayTitle } from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import type {
  MarketplaceAddResponse,
  PluginListResponse,
  PluginReadResponse,
  SkillsListResponse,
} from '../codex/protocol'

/** A request of the agent's app-server. */
export type CodexRequest = <T>(method: string, params?: unknown) => Promise<T>

export interface CodexPluginList {
  catalog: CatalogPlugin[]
  installed: InstalledPlugin[]
  marketplaces: PluginMarketplace[]
  /** Where each plugin's marketplace file is, by plugin id, which reading and installing need. */
  paths: Record<string, string>
}

/** OpenAI's own marketplaces, such as `openai-curated`. */
function official(name: string): boolean {
  return name.startsWith('openai-')
}

function https(value: string | null | undefined): string | null {
  const url = value ? URL.parse(value) : null
  return url?.protocol === 'https:' ? url.href : null
}

/** `plugin/list` as the Marketplace lists it; a marketplace only the remote service has is left out. */
export function codexPlugins(response: PluginListResponse, agentId: AgentId): CodexPluginList {
  const featured = new Set(response.featuredPluginIds)
  const out: CodexPluginList = { catalog: [], installed: [], marketplaces: [], paths: {} }
  for (const marketplace of response.marketplaces) {
    if (marketplace.path === null) continue
    out.marketplaces.push({
      harness: 'codex',
      agentId,
      name: marketplace.name,
      source: marketplace.path,
      official: official(marketplace.name),
    })
    for (const plugin of marketplace.plugins) {
      if (plugin.source.type === 'remote') continue
      out.paths[plugin.id] = marketplace.path
      const version = plugin.localVersion ?? plugin.version
      if (plugin.installed) {
        out.installed.push({
          id: plugin.id,
          harness: 'codex',
          agentId,
          version,
          scope: 'user',
          enabled: plugin.enabled,
          projectPath: null,
        })
      }
      if (plugin.installPolicy === 'NOT_AVAILABLE' || plugin.availability !== 'AVAILABLE') continue
      const about = plugin.interface
      out.catalog.push({
        id: plugin.id,
        harness: 'codex',
        name: plugin.name,
        title: about?.displayName || displayTitle(plugin.name),
        description: about?.shortDescription ?? '',
        publisher: about?.developerName ?? null,
        official: official(marketplace.name),
        marketplace: marketplace.name,
        category: about?.category ?? null,
        homepage: https(about?.websiteUrl),
        installs: null,
        version,
        featured: featured.has(plugin.id),
      })
    }
  }
  return out
}

export async function listCodexPlugins(
  request: CodexRequest,
  agentId: AgentId,
): Promise<CodexPluginList> {
  const response = await request<PluginListResponse>('plugin/list', { marketplaceKinds: ['local'] })
  return codexPlugins(response, agentId)
}

/** `plugin/read`, named by the plugin's name in its marketplace file. */
export async function codexPluginDetails(
  request: CodexRequest,
  agentId: AgentId,
  id: string,
  marketplacePath: string,
): Promise<PluginDetails> {
  const { plugin } = await request<PluginReadResponse>('plugin/read', {
    marketplacePath,
    pluginName: pluginName(id),
  })
  return {
    id,
    agentId,
    description: plugin.description ?? plugin.summary.interface?.shortDescription ?? null,
    skills: plugin.skills.map((skill) => skill.name),
    commands: [],
    agents: [],
    hooks: plugin.hooks.map((hook) => hook.eventName),
    mcpServers: plugin.mcpServers,
    lspServers: [],
    alwaysOnTokens: null,
  }
}

/** A plugin id's name part: `<name>@<marketplace>`. */
function pluginName(id: string): string {
  const at = id.lastIndexOf('@')
  return at > 0 ? id.slice(0, at) : id
}

export async function installCodexPlugin(
  request: CodexRequest,
  id: string,
  marketplacePath: string,
): Promise<void> {
  await request('plugin/install', { marketplacePath, pluginName: pluginName(id) })
}

export async function uninstallCodexPlugin(request: CodexRequest, id: string): Promise<void> {
  await request('plugin/uninstall', { pluginId: id })
}

/** Codex keeps a plugin's switch in its config as `[plugins."<id>"] enabled`. */
export async function setCodexPluginEnabled(
  request: CodexRequest,
  id: string,
  enabled: boolean,
): Promise<void> {
  await request('config/value/write', {
    keyPath: 'plugins',
    value: { [id]: { enabled } },
    mergeStrategy: 'upsert',
  })
}

export async function addCodexMarketplace(
  request: CodexRequest,
  agentId: AgentId,
  source: string,
): Promise<PluginMarketplace> {
  const added = await request<MarketplaceAddResponse>('marketplace/add', { source })
  return {
    harness: 'codex',
    agentId,
    name: added.marketplaceName,
    source,
    official: official(added.marketplaceName),
  }
}

export async function removeCodexMarketplace(request: CodexRequest, name: string): Promise<void> {
  await request('marketplace/remove', { marketplaceName: name })
}

/**
 * The skills Codex has of its own: the user's, the admin's and its plugins', without Codex's
 * built-in ones and without those `isKettus` says Kettu hands it.
 */
export function codexOwnSkills(
  response: SkillsListResponse,
  agentId: AgentId,
  isKettus: (path: string) => boolean,
): AgentOwnSkill[] {
  const seen = new Set<string>()
  return response.data
    .flatMap((entry) => entry.skills)
    .filter((skill) => skill.scope !== 'system' && !isKettus(skill.path))
    .filter((skill) => !seen.has(skill.path) && seen.add(skill.path))
    .map((skill) => ({
      agentId,
      name: skill.name,
      description: skill.shortDescription ?? skill.description,
      path: skill.path,
      enabled: skill.enabled,
      plugin: skill.pluginId ?? null,
    }))
}
