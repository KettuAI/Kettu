// The Marketplace's plugins: what each Claude Code and Codex agent's own marketplaces offer and
// what it has installed, read through its harness and kept an hour per agent in the host's state,
// and the changes, made the same way in the agent's configuration.

import path from 'node:path'
import {
  MARKET_KEPT_MS,
  type CatalogPlugin,
  type InstalledPlugin,
  type MarketPlugins,
  type PluginDetails,
  type PluginHarness,
  type PluginLogo,
  type PluginMarketplace,
  type PluginScope,
} from '@shared/marketplace'
import type { Platform } from '@shared/platform'
import { KETTU_PLUGINS } from '@shared/market-community'
import { harnessOf, type AgentId } from '@shared/thread'
import type { ProgramOptions, ProgramRun } from '../adapter-install'
import { HostError } from '../errors'
import type { Env } from '../find-command'
import { t } from '../i18n'
import { JsonFile, type LogFn, type Migration } from '../storage'
import * as claude from './claude-plugins'
import * as codex from './codex-plugins'
import type { PluginLogoPaths } from './codex-plugins'
import type { LocalMarketplace } from './community'
import { logText } from '../localized-error'
import { readLogo } from './plugin-logo'

/** What one agent's harness reported, as kept. */
interface AgentPlugins {
  at: number
  catalog: CatalogPlugin[]
  installed: InstalledPlugin[]
  marketplaces: PluginMarketplace[]
  /** Codex's marketplace file for each plugin, by id. */
  paths: Record<string, string>
  /** The logo files of Codex's plugins, by id. */
  logos: Record<string, PluginLogoPaths>
}

export interface PluginsFile {
  version: 2
  agents: Record<string, AgentPlugins>
}

/**
 * The file since version 2: each plugin the agents offer once, in `plugins`, and each agent's
 * catalog as the indexes of its plugins there. The agents of one harness offer nearly the same
 * catalog, of thousands of plugins, which version 1 kept whole for each of them.
 */
interface StoredPlugins {
  version: 2
  plugins: CatalogPlugin[]
  agents: Record<string, Omit<AgentPlugins, 'catalog'> & { catalog: number[] }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The same plugin as offered: equal fields, each a plain value, as the harnesses report them. */
function samePlugin(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const value = a[key]
    return (value === null || typeof value !== 'object') && Object.is(value, b[key])
  })
}

/** Every distinct item of the catalogs once, and each catalog as indexes into them. */
function shareCatalogs(catalogs: readonly (readonly unknown[])[]): {
  plugins: unknown[]
  indexes: number[][]
} {
  const plugins: unknown[] = []
  const known = new Map<unknown, number>()
  const byId = new Map<string, number[]>()
  const indexes = catalogs.map((catalog) =>
    catalog.map((item) => {
      let index = known.get(item)
      if (index !== undefined) return index
      if (isRecord(item) && typeof item.id === 'string') {
        const sameId = byId.get(item.id) ?? []
        index = sameId.find((at) => samePlugin(plugins[at] as Record<string, unknown>, item))
        if (index === undefined) sameId.push(plugins.length)
        byId.set(item.id, sameId)
      }
      if (index === undefined) {
        index = plugins.length
        plugins.push(item)
      }
      known.set(item, index)
      return index
    }),
  )
  return { plugins, indexes }
}

const PLUGINS_MIGRATIONS: Readonly<Record<number, Migration>> = {
  // Each plugin kept once. An entry that is not the shape written stays as it was, and is dropped.
  1: (data) => {
    if (!isRecord(data.agents)) return data
    const listed = Object.entries(data.agents).flatMap(([agentId, entry]) =>
      isRecord(entry) && Array.isArray(entry.catalog)
        ? [{ agentId, entry, catalog: entry.catalog }]
        : [],
    )
    const { plugins, indexes } = shareCatalogs(listed.map(({ catalog }) => catalog))
    const agents: Record<string, unknown> = { ...data.agents }
    listed.forEach(({ agentId, entry }, at) => {
      agents[agentId] = { ...entry, catalog: indexes[at] }
    })
    return { ...data, plugins, agents }
  },
}

function storedPlugins(file: PluginsFile): StoredPlugins {
  const agentIds = Object.keys(file.agents)
  const { plugins, indexes } = shareCatalogs(agentIds.map((id) => file.agents[id]!.catalog))
  return {
    version: 2,
    plugins: plugins as CatalogPlugin[],
    agents: Object.fromEntries(
      agentIds.map((id, at) => [id, { ...file.agents[id]!, catalog: indexes[at]! }]),
    ),
  }
}

/** The kept lists; an agent's entry that is not the shape written is dropped and read again. */
export function parsePluginsFile(data: Record<string, unknown>): PluginsFile | string {
  if (!isRecord(data.agents)) return 'agents is not an object'
  if (!Array.isArray(data.plugins)) return 'plugins is not a list'
  const plugins: unknown[] = data.plugins
  const offered = (at: unknown): boolean =>
    Number.isInteger(at) &&
    (at as number) >= 0 &&
    (at as number) < plugins.length &&
    isRecord(plugins[at as number]) &&
    typeof (plugins[at as number] as Record<string, unknown>).id === 'string'
  const agents: Record<string, AgentPlugins> = {}
  for (const [agentId, entry] of Object.entries(data.agents)) {
    if (
      isRecord(entry) &&
      typeof entry.at === 'number' &&
      Array.isArray(entry.catalog) &&
      Array.isArray(entry.installed) &&
      Array.isArray(entry.marketplaces) &&
      isRecord(entry.paths) &&
      isRecord(entry.logos) &&
      entry.catalog.every(offered) &&
      entry.installed.every((item) => isRecord(item) && typeof item.id === 'string')
    ) {
      const catalog = entry.catalog.map((at: number) => plugins[at] as CatalogPlugin)
      agents[agentId] = { ...(entry as unknown as AgentPlugins), catalog }
    }
  }
  return { version: 2, agents }
}

export function pluginsFile(userDataPath: string, log: LogFn): JsonFile<PluginsFile> {
  return new JsonFile<PluginsFile>({
    file: path.join(userDataPath, 'state', 'market-plugins.json'),
    version: 2,
    migrations: PLUGINS_MIGRATIONS,
    parse: parsePluginsFile,
    empty: () => ({ version: 2, agents: {} }),
    serialize: storedPlugins,
    compact: true,
    log,
  })
}

export interface PluginsDeps {
  file: JsonFile<PluginsFile>
  log: LogFn
  platform: Platform
  /** The Claude Code and Codex agents that are turned on and installed. */
  agents(): Promise<AgentId[]>
  /** The agent's own program and environment; null when it is not installed. */
  program(agentId: AgentId): Promise<{ program: string; env: Env } | null>
  /** The agent's app-server, started if it is not running. */
  appServer(agentId: AgentId): Promise<codex.CodexRequest>
  run?: (options: ProgramOptions) => Promise<ProgramRun>
  now?: () => number
}

/** Whether a plugin id is of the Kettu Marketplace's local marketplace. */
function fromKettu(id: string): boolean {
  return id.endsWith(`@${KETTU_PLUGINS}`)
}

function pluginHarness(agentId: AgentId): PluginHarness | null {
  const harness = harnessOf(agentId)
  return harness === 'claude-code' || harness === 'codex' ? harness : null
}

export class MarketPluginsService {
  private kept: PluginsFile | null = null
  private loading: Promise<PluginsFile> | null = null
  private readonly reading = new Map<AgentId, Promise<AgentPlugins>>()
  private readonly now: () => number

  constructor(private readonly deps: PluginsDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Every agent's plugins, each from the hour's copy unless `refresh` reads them again; `cached`
   * takes any copy there is, however old, and says whether one is.
   */
  async plugins(refresh = false, cached = false): Promise<MarketPlugins> {
    const kept = await this.load()
    const out: MarketPlugins = { catalog: [], installed: [], marketplaces: [], errors: [] }
    const seen = new Set<string>()
    const agentIds = await this.deps.agents()
    let stale = false
    const results = await Promise.all(
      agentIds.map(async (agentId): Promise<{ entry: AgentPlugins | null; error?: string }> => {
        const copy = kept.agents[agentId]
        const old = !copy || this.now() - copy.at >= MARKET_KEPT_MS.plugins
        if (!refresh && copy && (!old || cached)) {
          stale ||= old
          return { entry: copy }
        }
        try {
          return { entry: await this.read(agentId) }
        } catch (error) {
          // The lists from before stand in, with the reason they are not new.
          return { entry: copy ?? null, error: (error as Error).message }
        }
      }),
    )
    if (cached) out.stale = stale
    results.forEach(({ entry, error }, index) => {
      if (error !== undefined) out.errors.push({ agentId: agentIds[index]!, message: error })
      if (!entry) return
      for (const plugin of entry.catalog) {
        // Kettu's own marketplace offers what the directory's Community already lists.
        if (plugin.marketplace === KETTU_PLUGINS) continue
        const key = `${plugin.harness}\0${plugin.id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.catalog.push(plugin)
      }
      out.installed.push(...entry.installed)
      out.marketplaces.push(...entry.marketplaces.filter((m) => m.name !== KETTU_PLUGINS))
    })
    return out
  }

  /** A plugin's own logo, from the files its package ships, as any agent's kept list names them. */
  async logo(id: string): Promise<PluginLogo> {
    const kept = await this.load()
    const paths = Object.values(kept.agents)
      .map((entry) => entry.logos[id])
      .find((found) => found !== undefined)
    if (!paths) return { light: null, dark: null }
    const [light, dark] = await Promise.all([
      readLogo(paths.light),
      paths.dark ? readLogo(paths.dark) : null,
    ])
    return { light, dark }
  }

  async details(agentId: AgentId, id: string): Promise<PluginDetails> {
    const harness = this.harness(agentId)
    return this.harnessCall(async () => {
      const entry = await this.entry(agentId)
      if (harness === 'codex') {
        return codex.codexPluginDetails(
          await this.deps.appServer(agentId),
          agentId,
          id,
          this.codexPath(entry, id),
        )
      }
      const offered = entry.catalog.find((plugin) => plugin.id === id)
      return claude.pluginDetails(await this.cli(agentId), id, offered?.description || null)
    })
  }

  async install(
    agentId: AgentId,
    id: string,
    scope: PluginScope,
    projectPath: string | null,
  ): Promise<InstalledPlugin> {
    const harness = this.harness(agentId)
    this.checkScope(harness, scope, projectPath)
    return this.change(agentId, async () => {
      if (harness === 'claude-code') {
        return claude.installPlugin(await this.cli(agentId), id, scope, projectPath)
      }
      const at = this.codexPath(await this.entry(agentId), id)
      const request = await this.deps.appServer(agentId)
      await codex.installCodexPlugin(request, id, at)
      const list = await codex.listCodexPlugins(request, agentId)
      const installed = list.installed.find((plugin) => plugin.id === id)
      if (!installed) throw new Error(t('marketPlugins.notListedInstalled', { agent: 'Codex', id }))
      return installed
    })
  }

  /** Installs, or updates, a plugin of the Kettu Marketplace's local marketplace of the harness. */
  async installLocal(
    agentId: AgentId,
    local: LocalMarketplace,
    name: string,
    scope: PluginScope,
    projectPath: string | null,
  ): Promise<InstalledPlugin> {
    const harness = this.harness(agentId)
    this.checkScope(harness, scope, projectPath)
    return this.change(agentId, async () =>
      harness === 'claude-code'
        ? claude.installLocalPlugin(await this.cli(agentId), local.dir, name, scope, projectPath)
        : codex.installLocalCodexPlugin(
            await this.deps.appServer(agentId),
            agentId,
            local.dir,
            local.file,
            name,
          ),
    )
  }

  /**
   * Whether any agent of the harness has the plugin, as each harness lists it now; one that could
   * not be asked counts as having it.
   */
  async installedAnywhere(harness: PluginHarness, id: string): Promise<boolean> {
    const agentIds = (await this.deps.agents()).filter(
      (agentId) => pluginHarness(agentId) === harness,
    )
    const found = await Promise.all(
      agentIds.map(async (agentId) => {
        try {
          const installed =
            harness === 'claude-code'
              ? await claude.installedPlugins(await this.cli(agentId))
              : (await codex.listCodexPlugins(await this.deps.appServer(agentId), agentId))
                  .installed
          return installed.some((plugin) => plugin.id === id)
        } catch {
          return true
        }
      }),
    )
    return found.some(Boolean)
  }

  async uninstall(
    agentId: AgentId,
    id: string,
    scope: PluginScope,
    projectPath: string | null,
  ): Promise<void> {
    const harness = this.harness(agentId)
    this.checkScope(harness, scope, projectPath)
    return this.change(agentId, async () => {
      if (harness === 'claude-code') {
        const cli = await this.cli(agentId)
        await claude.uninstallPlugin(cli, id, scope, projectPath)
        if (fromKettu(id)) {
          await this.dropLocal(
            agentId,
            () => claude.installedPlugins(cli),
            () => claude.removeMarketplace(cli, KETTU_PLUGINS),
          )
        }
      } else {
        const request = await this.deps.appServer(agentId)
        await codex.uninstallCodexPlugin(request, id)
        if (fromKettu(id)) {
          await this.dropLocal(
            agentId,
            async () => (await codex.listCodexPlugins(request, agentId)).installed,
            () => codex.removeCodexMarketplace(request, KETTU_PLUGINS),
          )
        }
      }
    })
  }

  /**
   * Removes the Kettu Marketplace's local marketplace from an agent that has none of its plugins
   * left, in any scope or project, so no registration stays behind. The plugin is gone either way,
   * so a failure here is only logged.
   */
  private async dropLocal(
    agentId: AgentId,
    installed: () => Promise<InstalledPlugin[]>,
    remove: () => Promise<void>,
  ): Promise<void> {
    try {
      if ((await installed()).some((plugin) => fromKettu(plugin.id))) return
      await remove()
    } catch (error) {
      this.deps.log('warn', `Could not remove ${KETTU_PLUGINS} from ${agentId}: ${logText(error)}`)
    }
  }

  /**
   * Points every agent of the harness whose registration of the Kettu Marketplace's local
   * marketplace names another folder at `local`, as after it moved; an agent that cannot be asked
   * is only logged, and the link left at the old folder keeps it working.
   */
  async pointLocal(harness: PluginHarness, local: LocalMarketplace): Promise<void> {
    const agentIds = (await this.deps.agents()).filter(
      (agentId) => pluginHarness(agentId) === harness,
    )
    for (const agentId of agentIds) {
      try {
        const moved =
          harness === 'claude-code'
            ? await claude.pointLocalMarketplace(await this.cli(agentId), local.dir, false)
            : await codex.pointLocalCodexMarketplace(
                await this.deps.appServer(agentId),
                agentId,
                local.dir,
                local.file,
              )
        if (moved) this.forget(agentId)
      } catch (error) {
        this.deps.log(
          'warn',
          `Could not point ${agentId}'s ${KETTU_PLUGINS} at ${local.dir}: ${logText(error)}`,
        )
      }
    }
  }

  async setEnabled(
    agentId: AgentId,
    id: string,
    enabled: boolean,
    scope: PluginScope,
    projectPath: string | null,
  ): Promise<void> {
    const harness = this.harness(agentId)
    this.checkScope(harness, scope, projectPath)
    return this.change(agentId, async () => {
      if (harness === 'claude-code') {
        await claude.setPluginEnabled(await this.cli(agentId), id, enabled, scope, projectPath)
      } else {
        await codex.setCodexPluginEnabled(await this.deps.appServer(agentId), id, enabled)
      }
    })
  }

  async addMarketplace(agentId: AgentId, source: string): Promise<PluginMarketplace> {
    const harness = this.harness(agentId)
    return this.change(agentId, async () =>
      harness === 'claude-code'
        ? claude.addMarketplace(await this.cli(agentId), source)
        : codex.addCodexMarketplace(await this.deps.appServer(agentId), agentId, source),
    )
  }

  async removeMarketplace(agentId: AgentId, name: string): Promise<void> {
    const harness = this.harness(agentId)
    return this.change(agentId, async () => {
      if (harness === 'claude-code') await claude.removeMarketplace(await this.cli(agentId), name)
      else await codex.removeCodexMarketplace(await this.deps.appServer(agentId), name)
    })
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  private harness(agentId: AgentId): PluginHarness {
    const harness = pluginHarness(agentId)
    if (!harness) throw new HostError('invalid_params', t('marketPlugins.noPlugins'))
    return harness
  }

  private checkScope(harness: PluginHarness, scope: PluginScope, projectPath: string | null): void {
    if (harness === 'codex' && scope !== 'user') {
      throw new HostError('invalid_params', t('marketPlugins.codexUserOnly'))
    }
    if ((scope === 'user') !== (projectPath === null)) {
      throw new HostError('invalid_params', t('marketPlugins.scopeNeedsProject'))
    }
  }

  private async cli(agentId: AgentId): Promise<claude.ClaudeCli> {
    const found = await this.deps.program(agentId)
    if (!found)
      throw new HostError('agent_unavailable', t('agent.notInstalled', { agent: 'Claude Code' }))
    return {
      agentId,
      program: found.program,
      env: found.env,
      platform: this.deps.platform,
      ...(this.deps.run ? { run: this.deps.run } : {}),
    }
  }

  /** The agent's kept lists, read when there are none. */
  private async entry(agentId: AgentId): Promise<AgentPlugins> {
    const kept = await this.load()
    return kept.agents[agentId] ?? (await this.read(agentId))
  }

  private read(agentId: AgentId): Promise<AgentPlugins> {
    let reading = this.reading.get(agentId)
    if (!reading) {
      reading = this.readNow(agentId).finally(() => this.reading.delete(agentId))
      this.reading.set(agentId, reading)
    }
    return reading
  }

  private async readNow(agentId: AgentId): Promise<AgentPlugins> {
    const harness = this.harness(agentId)
    const list =
      harness === 'claude-code'
        ? { ...(await claude.listPlugins(await this.cli(agentId))), paths: {}, logos: {} }
        : await codex.listCodexPlugins(await this.deps.appServer(agentId), agentId)
    const entry: AgentPlugins = { at: this.now(), ...list }
    const kept = await this.load()
    kept.agents[agentId] = entry
    this.deps.file.save(kept)
    return entry
  }

  /**
   * Runs a change in the agent's configuration, whose kept lists are then stale, done or not: they
   * are read again when next asked for.
   */
  private async change<T>(agentId: AgentId, run: () => Promise<T>): Promise<T> {
    try {
      return await this.harnessCall(run)
    } finally {
      this.forget(agentId)
    }
  }

  /** Drops the agent's kept lists, which a change made out of date. */
  private forget(agentId: AgentId): void {
    if (this.kept?.agents[agentId]) {
      delete this.kept.agents[agentId]
      this.deps.file.save(this.kept)
    }
  }

  /** The marketplace file Codex reads a plugin from, which its list gave. */
  private codexPath(entry: AgentPlugins, id: string): string {
    const at = entry.paths[id]
    if (!at)
      throw new HostError('not_found', t('marketPlugins.noSuchPlugin', { agent: 'Codex', id }))
    return at
  }

  /** Runs a harness command, its own failure reported as the agent's. */
  private async harnessCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof HostError) throw error
      throw new HostError('agent_error', (error as Error).message)
    }
  }

  private load(): Promise<PluginsFile> {
    if (this.kept) return Promise.resolve(this.kept)
    this.loading ??= this.deps.file.load().then(
      (file) => (this.kept = file),
      (error: unknown) => {
        this.deps.log('warn', `Could not read the kept plugin lists: ${(error as Error).message}`)
        return (this.kept = { version: 2, agents: {} })
      },
    )
    return this.loading
  }
}
