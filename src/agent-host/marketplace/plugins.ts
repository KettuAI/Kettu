// The Marketplace's plugins: what each Claude Code and Codex agent's own marketplaces offer and
// what it has installed, read through its harness and kept an hour per agent in the host's state,
// and the changes, made the same way in the agent's configuration.

import path from 'node:path'
import type {
  CatalogPlugin,
  InstalledPlugin,
  MarketPlugins,
  PluginDetails,
  PluginHarness,
  PluginMarketplace,
  PluginScope,
} from '@shared/marketplace'
import type { Platform } from '@shared/platform'
import { harnessOf, type AgentId } from '@shared/thread'
import type { ProgramOptions, ProgramRun } from '../adapter-install'
import { HostError } from '../errors'
import type { Env } from '../find-command'
import { JsonFile, type LogFn } from '../storage'
import * as claude from './claude-plugins'
import * as codex from './codex-plugins'

const HOUR_MS = 60 * 60_000

/** What one agent's harness reported, as kept. */
interface AgentPlugins {
  at: number
  catalog: CatalogPlugin[]
  installed: InstalledPlugin[]
  marketplaces: PluginMarketplace[]
  /** Codex's marketplace file for each plugin, by id. */
  paths: Record<string, string>
}

export interface PluginsFile {
  version: 1
  agents: Record<string, AgentPlugins>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The kept lists; an agent's entry that is not the shape written is dropped and read again. */
export function parsePluginsFile(data: Record<string, unknown>): PluginsFile | string {
  if (!isRecord(data.agents)) return 'agents is not an object'
  const agents: Record<string, AgentPlugins> = {}
  for (const [agentId, entry] of Object.entries(data.agents)) {
    if (
      isRecord(entry) &&
      typeof entry.at === 'number' &&
      Array.isArray(entry.catalog) &&
      Array.isArray(entry.installed) &&
      Array.isArray(entry.marketplaces) &&
      isRecord(entry.paths) &&
      entry.catalog.every((item) => isRecord(item) && typeof item.id === 'string') &&
      entry.installed.every((item) => isRecord(item) && typeof item.id === 'string')
    ) {
      agents[agentId] = entry as unknown as AgentPlugins
    }
  }
  return { version: 1, agents }
}

export function pluginsFile(userDataPath: string, log: LogFn): JsonFile<PluginsFile> {
  return new JsonFile<PluginsFile>({
    file: path.join(userDataPath, 'state', 'market-plugins.json'),
    version: 1,
    migrations: {},
    parse: parsePluginsFile,
    empty: () => ({ version: 1, agents: {} }),
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

  /** Every agent's plugins, each from the hour's copy unless `refresh` reads them again. */
  async plugins(refresh = false): Promise<MarketPlugins> {
    const kept = await this.load()
    const out: MarketPlugins = { catalog: [], installed: [], marketplaces: [], errors: [] }
    const seen = new Set<string>()
    const agentIds = await this.deps.agents()
    const results = await Promise.all(
      agentIds.map(async (agentId): Promise<{ entry: AgentPlugins | null; error?: string }> => {
        const cached = kept.agents[agentId]
        if (!refresh && cached && this.now() - cached.at < HOUR_MS) return { entry: cached }
        try {
          return { entry: await this.read(agentId) }
        } catch (error) {
          // The lists from before stand in, with the reason they are not new.
          return { entry: cached ?? null, error: (error as Error).message }
        }
      }),
    )
    results.forEach(({ entry, error }, index) => {
      if (error !== undefined) out.errors.push({ agentId: agentIds[index]!, message: error })
      if (!entry) return
      for (const plugin of entry.catalog) {
        const key = `${plugin.harness}\0${plugin.id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.catalog.push(plugin)
      }
      out.installed.push(...entry.installed)
      out.marketplaces.push(...entry.marketplaces)
    })
    return out
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
      if (!installed) throw new Error(`Codex did not list ${id} as installed`)
      return installed
    })
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
        await claude.uninstallPlugin(await this.cli(agentId), id, scope, projectPath)
      } else {
        await codex.uninstallCodexPlugin(await this.deps.appServer(agentId), id)
      }
    })
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
    if (!harness) throw new HostError('invalid_params', 'Only Claude Code and Codex have plugins')
    return harness
  }

  private checkScope(harness: PluginHarness, scope: PluginScope, projectPath: string | null): void {
    if (harness === 'codex' && scope !== 'user') {
      throw new HostError('invalid_params', 'Codex installs plugins for the user only')
    }
    if ((scope === 'user') !== (projectPath === null)) {
      throw new HostError(
        'invalid_params',
        'A project or local scope needs the project, and only it',
      )
    }
  }

  private async cli(agentId: AgentId): Promise<claude.ClaudeCli> {
    const found = await this.deps.program(agentId)
    if (!found) throw new HostError('agent_unavailable', 'Claude Code is not installed')
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
        ? { ...(await claude.listPlugins(await this.cli(agentId))), paths: {} }
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
      if (this.kept?.agents[agentId]) {
        delete this.kept.agents[agentId]
        this.deps.file.save(this.kept)
      }
    }
  }

  /** The marketplace file Codex reads a plugin from, which its list gave. */
  private codexPath(entry: AgentPlugins, id: string): string {
    const at = entry.paths[id]
    if (!at) throw new HostError('not_found', `Codex offers no plugin ${id}`)
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
        return (this.kept = { version: 1, agents: {} })
      },
    )
    return this.loading
  }
}
