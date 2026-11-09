// Claude Code's plugins through its own `claude plugin` commands, run as the agent with its
// configuration folder: the marketplaces, what they offer, what is installed, and the changes.
// Arguments go as an argv array, never through a shell, and nothing confirms a command a
// marketplace declares: a plugin that needs one fails with Claude Code's own message.

import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentId } from '@shared/thread'
import type {
  CatalogPlugin,
  InstalledPlugin,
  PluginDetails,
  PluginMarketplace,
  PluginScope,
} from '@shared/marketplace'
import { displayTitle } from '@shared/marketplace'
import {
  programFailure,
  runProgram,
  type ProgramOptions,
  type ProgramRun,
} from '../adapter-install'
import type { Env } from '../find-command'
import type { Platform } from '@shared/platform'

export const OFFICIAL_MARKETPLACE = 'claude-plugins-official'
const SKILLS_DIR = 'skills-dir'
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/
const OFFICIAL_SOURCE = 'anthropics/claude-plugins-official'
const FEATURED = 12
const LIST_MS = 60_000
const CHANGE_MS = 180_000
const MANIFEST_BYTES = 16 * 1024 * 1024

/** How to run the agent's `claude`. */
export interface ClaudeCli {
  agentId: AgentId
  program: string
  env: Env
  platform: Platform
  run?: (options: ProgramOptions) => Promise<ProgramRun>
}

export interface ClaudeMarketplace {
  name: string
  source: string
  installLocation: string | null
}

interface Installed {
  id: string
  version: string | null
  scope: PluginScope
  enabled: boolean
  projectPath: string | null
}

interface Available {
  id: string
  name: string
  description: string
  marketplace: string
  installs: number | null
  version: string | null
  /** The repository the plugin comes from, for one its marketplace does not keep. */
  url: string | null
}

/** What a marketplace's own `marketplace.json` adds about a plugin. */
export interface ManifestEntry {
  title: string | null
  publisher: string | null
  category: string | null
  homepage: string | null
  version: string | null
}

type Fields = Record<string, unknown>

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function https(value: unknown): string | null {
  const url = typeof value === 'string' ? URL.parse(value) : null
  return url?.protocol === 'https:' ? url.href : null
}

function json(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout) as unknown
  } catch {
    throw new Error(`Claude Code's ${what} was not JSON`)
  }
}

/** The machine-readable line a `--json` change prints last; null when there is none. */
export function lastJsonLine(stdout: string): Fields | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i]!) as unknown
      return isRecord(value) ? value : null
    } catch {
      continue
    }
  }
  return null
}

/** `claude plugin marketplace list --json`. */
export function parseMarketplaces(stdout: string): ClaudeMarketplace[] {
  const value = json(stdout, 'marketplace list')
  if (!Array.isArray(value)) throw new Error("Claude Code's marketplace list was not a list")
  return value.filter(isRecord).flatMap((item) => {
    const name = text(item.name)
    if (!name) return []
    const source = text(item.repo) ?? text(item.url) ?? text(item.path) ?? text(item.source) ?? ''
    return [{ name, source, installLocation: text(item.installLocation) }]
  })
}

function scope(value: unknown): PluginScope | null {
  return value === 'user' || value === 'project' || value === 'local' ? value : null
}

/** `claude plugin list --json`, with `--available` or not. */
export function parsePluginList(stdout: string): {
  installed: Installed[]
  available: Available[]
} {
  const value = json(stdout, 'plugin list')
  // Without --available the list is the installed plugins alone.
  const record = Array.isArray(value) ? { installed: value, available: [] } : value
  if (!isRecord(record)) throw new Error("Claude Code's plugin list was not an object")
  const installed = (Array.isArray(record.installed) ? record.installed : [])
    .filter(isRecord)
    .flatMap((item): Installed[] => {
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
  const available = (Array.isArray(record.available) ? record.available : [])
    .filter(isRecord)
    .flatMap((item): Available[] => {
      const id = text(item.pluginId)
      const name = text(item.name)
      const marketplace = text(item.marketplaceName)
      if (!id || !name || !marketplace) return []
      const url = isRecord(item.source) ? https(item.source.url) : null
      return [
        {
          id,
          name,
          description: text(item.description) ?? '',
          marketplace,
          installs: typeof item.installCount === 'number' ? item.installCount : null,
          version: text(item.version),
          url,
        },
      ]
    })
  return { installed, available }
}

/** A marketplace's `.claude-plugin/marketplace.json`, by plugin name. */
export function parseManifest(value: unknown): Map<string, ManifestEntry> {
  const out = new Map<string, ManifestEntry>()
  if (!isRecord(value) || !Array.isArray(value.plugins)) return out
  const owner = isRecord(value.owner) ? text(value.owner.name) : null
  for (const plugin of value.plugins.filter(isRecord)) {
    const name = text(plugin.name)
    if (!name) continue
    const author = isRecord(plugin.author) ? text(plugin.author.name) : null
    // A plugin kept in the marketplace's own repository is its owner's.
    const inside = typeof plugin.source === 'string'
    out.set(name, {
      title: text(plugin.displayName),
      publisher: author ?? (inside ? owner : null),
      category: text(plugin.category),
      homepage: https(plugin.homepage),
      version: text(plugin.version),
    })
  }
  return out
}

/** The owner of a GitHub repository URL, as a publisher when nothing else names one. */
function repositoryOwner(url: string | null): string | null {
  const match = url ? /^https:\/\/github\.com\/([^/]+)\//.exec(url) : null
  return match ? match[1]! : null
}

/**
 * The catalog from the plugins Claude Code offers: a plugin in Anthropic's own marketplace is
 * official, the most installed ones are featured, and the directory's copy of a plugin a
 * marketplace offers by the same name is left out.
 */
export function claudeCatalog(
  available: readonly Available[],
  manifests: ReadonlyMap<string, ReadonlyMap<string, ManifestEntry>>,
  marketplaces: readonly ClaudeMarketplace[],
): CatalogPlugin[] {
  const known = new Set(marketplaces.map((marketplace) => marketplace.name))
  const offered = new Set(
    available.filter((plugin) => known.has(plugin.marketplace)).map((plugin) => plugin.name),
  )
  const plugins = available.filter(
    (plugin) => known.has(plugin.marketplace) || !offered.has(plugin.name),
  )
  const featured = new Set(
    plugins
      .filter((plugin) => plugin.installs !== null)
      .sort((a, b) => b.installs! - a.installs!)
      .slice(0, FEATURED)
      .map((plugin) => plugin.id),
  )
  return plugins.map((plugin) => {
    const manifest = manifests.get(plugin.marketplace)?.get(plugin.name)
    return {
      id: plugin.id,
      harness: 'claude-code',
      name: plugin.name,
      title: manifest?.title ?? displayTitle(plugin.name),
      description: plugin.description,
      publisher: manifest?.publisher ?? repositoryOwner(plugin.url),
      official: plugin.marketplace === OFFICIAL_MARKETPLACE,
      marketplace: plugin.marketplace,
      category: manifest?.category ?? null,
      homepage: manifest?.homepage ?? null,
      installs: plugin.installs,
      version: manifest?.version ?? plugin.version,
      featured: featured.has(plugin.id),
    }
  })
}

const INVENTORY: Record<
  string,
  keyof Omit<PluginDetails, 'id' | 'agentId' | 'description' | 'alwaysOnTokens'>
> = {
  Skills: 'skills',
  Commands: 'commands',
  Agents: 'agents',
  Hooks: 'hooks',
  'MCP servers': 'mcpServers',
  'LSP servers': 'lspServers',
}

/**
 * `claude plugin details`, which prints text only: its description, its component inventory and
 * what it adds to every session. What does not parse is left empty.
 */
export function parseDetails(output: string, id: string, agentId: AgentId): PluginDetails {
  const details: PluginDetails = {
    id,
    agentId,
    description: null,
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    alwaysOnTokens: null,
  }
  for (const line of output.split(/\r?\n/)) {
    const description = /^\s+Description:\s+(.+)$/.exec(line)
    if (description && details.description === null) {
      details.description = description[1]!.trim()
      continue
    }
    const part =
      /^\s+(Skills|Commands|Agents|Hooks|MCP servers|LSP servers) \((\d+)\)\s*(.*)$/.exec(line)
    if (part) {
      details[INVENTORY[part[1]!]!] = part[3]!
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '' && !/^(\+|and )\d+ more$/.test(name))
      continue
    }
    const tokens = /^\s+Always-on:\s+[~<]?\s*([\d,]+)\s*tok/.exec(line)
    if (tokens) details.alwaysOnTokens = Number(tokens[1]!.replace(/,/g, ''))
  }
  return details
}

/** What a plugin folder holds, for a plugin not installed yet that its marketplace keeps. */
export async function folderInventory(
  folder: string,
): Promise<Pick<PluginDetails, 'skills' | 'commands' | 'agents' | 'hooks' | 'mcpServers'>> {
  const names = async (sub: string, files: boolean): Promise<string[]> => {
    const entries = await readdir(path.join(folder, sub), { withFileTypes: true }).catch(() => [])
    return entries
      .filter((entry) =>
        files ? entry.isFile() && entry.name.endsWith('.md') : entry.isDirectory(),
      )
      .map((entry) => (files ? entry.name.slice(0, -3) : entry.name))
      .sort()
  }
  const keys = async (file: string, field: string | null): Promise<string[]> => {
    const value = await readJson(path.join(folder, file), 1024 * 1024)
    const record = field === null ? value : isRecord(value) ? value[field] : null
    return isRecord(record) ? Object.keys(record).sort() : []
  }
  const [skills, commands, agents, hooks, mcpServers] = await Promise.all([
    names('skills', false),
    names('commands', true),
    names('agents', true),
    keys(path.join('hooks', 'hooks.json'), 'hooks'),
    keys('.mcp.json', 'mcpServers'),
  ])
  return { skills, commands, agents, hooks, mcpServers }
}

async function readJson(file: string, limit: number): Promise<unknown> {
  try {
    if ((await stat(file)).size > limit) return null
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** Runs `claude plugin <args>` and returns its stdout; throws Claude Code's own reason. */
async function claude(
  cli: ClaudeCli,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<string> {
  const run = await (cli.run ?? runProgram)({
    program: cli.program,
    args: ['plugin', ...args],
    cwd: options.cwd ?? os.homedir(),
    env: cli.env,
    platform: cli.platform,
    timeoutMs: options.timeoutMs,
  })
  if (run.code !== 0 || run.timedOut || run.aborted || run.error) {
    const said = lastJsonLine(run.stdout)
    const message = said ? (text(said.message) ?? text(said.error)) : null
    throw new Error(message ?? programFailure('claude', run, options.timeoutMs) ?? 'claude failed')
  }
  return run.stdout
}

/** A change's `--json` result line, or Claude Code's own reason when it did not go through. */
async function change(cli: ClaudeCli, args: string[], cwd?: string): Promise<Fields> {
  const stdout = await claude(cli, [...args, '--json'], { cwd, timeoutMs: CHANGE_MS })
  const result = lastJsonLine(stdout)
  if (!result) throw new Error('Claude Code gave no result')
  if (result.outcome !== undefined && result.outcome !== 'ok') {
    throw new Error(text(result.message) ?? `Claude Code answered ${String(result.outcome)}`)
  }
  return result
}

function scopeArgs(scopeOf: PluginScope): string[] {
  return ['--scope', scopeOf]
}

export async function listMarketplaces(cli: ClaudeCli): Promise<ClaudeMarketplace[]> {
  return parseMarketplaces(
    await claude(cli, ['marketplace', 'list', '--json'], { timeoutMs: LIST_MS }),
  )
}

export interface ClaudePluginList {
  catalog: CatalogPlugin[]
  installed: InstalledPlugin[]
  marketplaces: PluginMarketplace[]
}

/**
 * The agent's marketplaces, the plugins they offer and the installed ones. An agent with no
 * marketplace first gets Anthropic's, as Claude Code adds it on its first interactive start.
 */
export async function listPlugins(cli: ClaudeCli): Promise<ClaudePluginList> {
  let marketplaces = await listMarketplaces(cli)
  if (marketplaces.length === 0) {
    await change(cli, ['marketplace', 'add', OFFICIAL_SOURCE])
    marketplaces = await listMarketplaces(cli)
  }
  const list = parsePluginList(
    await claude(cli, ['list', '--available', '--json'], { timeoutMs: LIST_MS }),
  )
  const manifests = new Map<string, Map<string, ManifestEntry>>()
  await Promise.all(
    marketplaces.map(async (marketplace) => {
      if (!marketplace.installLocation) return
      const file = path.join(marketplace.installLocation, '.claude-plugin', 'marketplace.json')
      manifests.set(marketplace.name, parseManifest(await readJson(file, MANIFEST_BYTES)))
    }),
  )
  return {
    catalog: claudeCatalog(list.available, manifests, marketplaces),
    installed: list.installed.map((plugin) => ({
      ...plugin,
      harness: 'claude-code',
      agentId: cli.agentId,
    })),
    marketplaces: marketplaces.map((marketplace) => ({
      harness: 'claude-code',
      agentId: cli.agentId,
      name: marketplace.name,
      source: marketplace.source,
      official: marketplace.name === OFFICIAL_MARKETPLACE,
    })),
  }
}

/** The plugins installed in the agent's configuration, without what the marketplaces offer. */
export async function installedPlugins(cli: ClaudeCli): Promise<InstalledPlugin[]> {
  const list = parsePluginList(await claude(cli, ['list', '--json'], { timeoutMs: LIST_MS }))
  return list.installed.map((plugin) => ({
    ...plugin,
    harness: 'claude-code',
    agentId: cli.agentId,
  }))
}

export async function installPlugin(
  cli: ClaudeCli,
  id: string,
  at: PluginScope,
  projectPath: string | null,
): Promise<InstalledPlugin> {
  await change(cli, ['install', id, ...scopeArgs(at)], projectPath ?? undefined)
  const installed = await installedPlugins(cli)
  const found = installed.find(
    (plugin) =>
      plugin.id === id &&
      plugin.scope === at &&
      (at === 'user' || plugin.projectPath === projectPath),
  )
  return (
    found ?? {
      id,
      harness: 'claude-code',
      agentId: cli.agentId,
      version: null,
      scope: at,
      enabled: true,
      projectPath,
    }
  )
}

export async function uninstallPlugin(
  cli: ClaudeCli,
  id: string,
  at: PluginScope,
  projectPath: string | null,
): Promise<void> {
  await change(cli, ['uninstall', id, ...scopeArgs(at)], projectPath ?? undefined)
}

export async function setPluginEnabled(
  cli: ClaudeCli,
  id: string,
  enabled: boolean,
  at: PluginScope,
  projectPath: string | null,
): Promise<void> {
  await change(
    cli,
    [enabled ? 'enable' : 'disable', id, ...scopeArgs(at)],
    projectPath ?? undefined,
  )
}

export async function addMarketplace(cli: ClaudeCli, source: string): Promise<PluginMarketplace> {
  const before = new Set((await listMarketplaces(cli)).map((marketplace) => marketplace.name))
  const result = await change(cli, ['marketplace', 'add', source])
  const after = await listMarketplaces(cli)
  const said =
    text(result.marketplace) ??
    (isRecord(result.marketplace) ? text(result.marketplace.name) : null)
  const added =
    after.find((marketplace) => marketplace.name === said) ??
    after.find((marketplace) => !before.has(marketplace.name)) ??
    after.find((marketplace) => marketplace.source === source)
  if (!added) throw new Error('Claude Code did not list the marketplace it added')
  return {
    harness: 'claude-code',
    agentId: cli.agentId,
    name: added.name,
    source: added.source,
    official: added.name === OFFICIAL_MARKETPLACE,
  }
}

export async function removeMarketplace(cli: ClaudeCli, name: string): Promise<void> {
  await change(cli, ['marketplace', 'remove', name])
}

/**
 * What a plugin adds: `claude plugin details` for an installed one; for one that is not, what its
 * folder holds when its marketplace keeps it, with the description the catalog has.
 */
export async function pluginDetails(
  cli: ClaudeCli,
  id: string,
  description: string | null,
): Promise<PluginDetails> {
  const run = await (cli.run ?? runProgram)({
    program: cli.program,
    args: ['plugin', 'details', id],
    cwd: os.homedir(),
    env: cli.env,
    platform: cli.platform,
    timeoutMs: LIST_MS,
  })
  if (run.code === 0) return parseDetails(run.stdout, id, cli.agentId)
  const details = parseDetails('', id, cli.agentId)
  details.description = description
  const folder = await keptFolder(cli, id)
  return folder ? { ...details, ...(await folderInventory(folder)) } : details
}

/** The folder a marketplace keeps a plugin in, from its `marketplace.json`; null when elsewhere. */
async function keptFolder(cli: ClaudeCli, id: string): Promise<string | null> {
  const at = id.lastIndexOf('@')
  if (at <= 0) return null
  const name = id.slice(0, at)
  const location = (await listMarketplaces(cli)).find(
    (m) => m.name === id.slice(at + 1),
  )?.installLocation
  if (!location) return null
  const manifest = await readJson(
    path.join(location, '.claude-plugin', 'marketplace.json'),
    MANIFEST_BYTES,
  )
  const plugins = isRecord(manifest) && Array.isArray(manifest.plugins) ? manifest.plugins : []
  const source = plugins.filter(isRecord).find((plugin) => plugin.name === name)?.source
  if (typeof source !== 'string') return null
  const root = path.resolve(location)
  const folder = path.resolve(root, source)
  return folder.startsWith(root + path.sep) ? folder : null
}
