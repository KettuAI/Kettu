// The plugins Claude Code and Codex agents have of their own, which Kettu only lists: read
// through each agent's harness and kept in memory until asked to read again. Kettu installs,
// updates and removes none of them.

import os from 'node:os'
import type { AgentOwnPlugin, AgentOwnPlugins, PluginScope } from '@shared/marketplace'
import type { Platform } from '@shared/platform'
import { harnessOf, type AgentId } from '@shared/thread'
import {
  programFailure,
  runProgram,
  type ProgramOptions,
  type ProgramRun,
} from '../adapter-install'
import type { PluginListResponse } from '../codex/protocol'
import type { CodexRequest } from '../codex/rpc'
import type { Env } from '../find-command'
import { LocalizedError } from '../localized-error'

const SKILLS_DIR = 'skills-dir'
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/
const LIST_MS = 60_000

type Listed = Omit<AgentOwnPlugin, 'harness' | 'agentId'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function scope(value: unknown): PluginScope | null {
  return value === 'user' || value === 'project' || value === 'local' ? value : null
}

/** `claude plugin list --json`: the installed plugins, as a list or under `installed`. */
export function parseClaudePlugins(stdout: string): Listed[] {
  let value: unknown
  try {
    value = JSON.parse(stdout) as unknown
  } catch {
    throw new LocalizedError({ key: 'marketPlugins.pluginListNotJson' })
  }
  const installed = Array.isArray(value) ? value : isRecord(value) ? value.installed : null
  if (!Array.isArray(installed)) {
    throw new LocalizedError({ key: 'marketPlugins.pluginListNotObject' })
  }
  return installed.filter(isRecord).flatMap((item): Listed[] => {
    const id = text(item.id)
    const at = scope(item.scope)
    // The skills folders Claude Code lists as plugins of its own, such as `(suppressed)@skills-dir`.
    if (!id || !at || !PLUGIN_ID.test(id) || id.endsWith(`@${SKILLS_DIR}`)) return []
    return [
      {
        id,
        version: text(item.version),
        scope: at,
        enabled: item.enabled === true,
        projectPath: text(item.projectPath),
      },
    ]
  })
}

/** `plugin/list`: the installed plugins of Codex's local marketplaces. */
export function codexInstalledPlugins(response: PluginListResponse): Listed[] {
  return response.marketplaces
    .filter((marketplace) => marketplace.path !== null)
    .flatMap((marketplace) => marketplace.plugins)
    .filter((plugin) => plugin.source.type !== 'remote' && plugin.installed)
    .map((plugin) => ({
      id: plugin.id,
      version: plugin.localVersion ?? plugin.version,
      scope: 'user',
      enabled: plugin.enabled,
      projectPath: null,
    }))
}

export interface OwnPluginsDeps {
  platform: Platform
  /** The Claude Code and Codex agents that are turned on and installed. */
  agents(): Promise<AgentId[]>
  /** The agent's own program and environment; null when it is not installed. */
  program(agentId: AgentId): Promise<{ program: string; env: Env } | null>
  /** The agent's app-server, started if it is not running. */
  appServer(agentId: AgentId): Promise<CodexRequest>
  run?: (options: ProgramOptions) => Promise<ProgramRun>
}

export class OwnPluginsService {
  private readonly kept = new Map<AgentId, AgentOwnPlugin[]>()

  constructor(private readonly deps: OwnPluginsDeps) {}

  /** Every agent's own plugins, each read once unless `refresh` reads it again. */
  async plugins(refresh = false): Promise<AgentOwnPlugins> {
    const out: AgentOwnPlugins = { plugins: [], errors: [] }
    const agentIds = await this.deps.agents()
    const results = await Promise.all(
      agentIds.map(async (agentId) => {
        const known = this.kept.get(agentId)
        if (known && !refresh) return { plugins: known }
        try {
          const plugins = await this.read(agentId)
          this.kept.set(agentId, plugins)
          return { plugins }
        } catch (error) {
          // The list from before stands in, with the reason it is not new.
          return { plugins: known ?? [], error: (error as Error).message }
        }
      }),
    )
    results.forEach(({ plugins, error }, index) => {
      if (error !== undefined) out.errors.push({ agentId: agentIds[index]!, message: error })
      out.plugins.push(...plugins)
    })
    return out
  }

  private async read(agentId: AgentId): Promise<AgentOwnPlugin[]> {
    const harness = harnessOf(agentId)
    if (harness === 'codex') {
      const request = await this.deps.appServer(agentId)
      const response = await request<PluginListResponse>('plugin/list', {
        marketplaceKinds: ['local'],
      })
      return codexInstalledPlugins(response).map((plugin) => ({ ...plugin, harness, agentId }))
    }
    if (harness !== 'claude-code') return []
    const found = await this.deps.program(agentId)
    if (!found) return []
    const run = await (this.deps.run ?? runProgram)({
      program: found.program,
      args: ['plugin', 'list', '--json'],
      cwd: os.homedir(),
      env: found.env,
      platform: this.deps.platform,
      timeoutMs: LIST_MS,
    })
    if (run.code !== 0 || run.timedOut || run.aborted || run.error) {
      const failure = programFailure('claude', run, LIST_MS)
      if (failure) throw new Error(failure)
      throw new LocalizedError({ key: 'marketPlugins.claudeFailed' })
    }
    return parseClaudePlugins(run.stdout).map((plugin) => ({ ...plugin, harness, agentId }))
  }
}
