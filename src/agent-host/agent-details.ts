// What Settings › Agents shows on an agent's page beyond its status: where the agent reads its
// configuration, and which CLI version its adapter runs.

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConfigItem, AgentDetails } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import type { LogFn } from './storage'

/** One configuration entry; `candidates` are the paths the agent tries, first choice first. */
export interface ConfigLocation {
  id: AgentConfigItem['id']
  candidates: string[]
  env: string | null
  /** The folder picked in Settings, which wins over the variable. */
  chosen?: boolean
  /** The path shown when none exists, when that is not the first candidate. */
  fallback?: string
}

/**
 * Where each agent reads its configuration, by the same rules the agent itself follows. `chosen`
 * is the folder picked in Settings for Claude Code or Codex, which the agent gets in its variable.
 */
export function configLocations(
  agentId: AgentId,
  getEnv: (name: string) => string | undefined,
  home: string,
  platform: Platform,
  chosen: string | null = null,
): ConfigLocation[] {
  const p = platform === 'win32' ? path.win32 : path.posix
  // A relative value is taken from the home directory, where agents are spawned.
  const variable = (name: string): string | null => {
    const value = getEnv(name)
    return value && value.trim() !== '' ? p.resolve(home, value) : null
  }
  const layout = (
    folder: string,
    env: string | null,
    settings: ConfigLocation,
    instructions: string,
  ): ConfigLocation[] => [
    chosen !== null && folder === chosen
      ? { id: 'folder', candidates: [folder], env: null, chosen: true }
      : { id: 'folder', candidates: [folder], env },
    settings,
    { id: 'instructions', candidates: [p.join(folder, instructions)], env: null },
  ]

  switch (agentId) {
    case 'claude-code': {
      const moved = chosen ?? variable('CLAUDE_CONFIG_DIR')
      const folder = moved ?? p.join(home, '.claude')
      return layout(
        folder,
        moved ? 'CLAUDE_CONFIG_DIR' : null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'CLAUDE.md',
      )
    }
    case 'codex': {
      const moved = chosen ?? variable('CODEX_HOME')
      const folder = moved ?? p.join(home, '.codex')
      return layout(
        folder,
        moved ? 'CODEX_HOME' : null,
        { id: 'settings', candidates: [p.join(folder, 'config.toml')], env: null },
        'AGENTS.md',
      )
    }
    case 'opencode': {
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = p.join(xdg ?? p.join(home, '.config'), 'opencode')
      const file = variable('OPENCODE_CONFIG')
      const settings: ConfigLocation = file
        ? { id: 'settings', candidates: [file], env: 'OPENCODE_CONFIG' }
        : {
            id: 'settings',
            candidates: [p.join(folder, 'opencode.json'), p.join(folder, 'opencode.jsonc')],
            env: null,
          }
      return layout(folder, xdg ? 'XDG_CONFIG_HOME' : null, settings, 'AGENTS.md')
    }
    case 'pi': {
      const moved = variable('PI_CODING_AGENT_DIR')
      const folder = moved ?? p.join(home, '.pi', 'agent')
      return [
        ...layout(
          folder,
          moved ? 'PI_CODING_AGENT_DIR' : null,
          { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
          'AGENTS.md',
        ).map((location) =>
          // Pi reads the first of these that exists, and AGENTS.md when none does.
          location.id === 'instructions'
            ? {
                ...location,
                candidates: ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'].map((name) =>
                  p.join(folder, name),
                ),
                fallback: p.join(folder, 'AGENTS.md'),
              }
            : location,
        ),
      ]
    }
    case 'fake-agent':
      return []
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function exists(target: string, kind: 'directory' | 'file', log: LogFn): Promise<boolean> {
  try {
    const info = await stat(target)
    return kind === 'directory' ? info.isDirectory() : info.isFile()
  } catch (error) {
    if (!isMissing(error)) log('warn', `Could not check ${target}: ${(error as Error).message}`)
    return false
  }
}

async function resolveItem(location: ConfigLocation, log: LogFn): Promise<AgentConfigItem> {
  const kind = location.id === 'folder' ? 'directory' : 'file'
  const chosen = location.chosen ?? false
  for (const candidate of location.candidates) {
    if (await exists(candidate, kind, log)) {
      return { id: location.id, path: candidate, exists: true, env: location.env, chosen }
    }
  }
  const path = location.fallback ?? location.candidates[0] ?? ''
  return { id: location.id, path, exists: false, env: location.env, chosen }
}

/** The package whose `package.json` names the CLI an adapter runs, and the field that holds it. */
export const CLI_VERSION_SOURCES: Partial<Record<AgentId, { package: string; field: string }>> = {
  'claude-code': { package: '@anthropic-ai/claude-agent-sdk', field: 'claudeCodeVersion' },
  codex: { package: '@openai/codex', field: 'version' },
}

/** The CLI version an installed adapter carries, from the install in `installRoot`. */
export async function readCliVersion(
  agentId: AgentId,
  installRoot: string,
  log: LogFn,
): Promise<string | null> {
  const source = CLI_VERSION_SOURCES[agentId]
  if (!source) return null
  const file = path.join(installRoot, 'node_modules', source.package, 'package.json')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    // Not installed yet is normal.
    if (!isMissing(error)) log('warn', `Could not read ${file}: ${(error as Error).message}`)
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const value =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)[source.field]
        : undefined
    if (typeof value === 'string' && value !== '') return value
    log('warn', `${file} has no "${source.field}" string`)
  } catch (error) {
    log('warn', `Could not parse ${file}: ${(error as Error).message}`)
  }
  return null
}

type LogEntry = Parameters<LogFn>

/** Runs `read` with a log that holds its entries, so concurrent reads can be logged in a fixed order. */
async function withLogs<T>(read: (log: LogFn) => Promise<T>): Promise<[T, LogEntry[]]> {
  const entries: LogEntry[] = []
  const result = await read((...entry) => {
    entries.push(entry)
  })
  return [result, entries]
}

export interface AgentDetailsContext {
  getEnv(name: string): string | undefined
  home: string
  platform: Platform
  /** The folder picked in Settings for an agent whose folder can be moved; null otherwise. */
  chosen?: string | null
  /** The directory of the adapter install a package agent runs; null for the others. */
  adapterDir: string | null
  log: LogFn
}

/** Never rejects: a place or version that cannot be read comes back as missing or null. */
export async function readAgentDetails(
  agentId: AgentId,
  ctx: AgentDetailsContext,
): Promise<AgentDetails> {
  const locations = configLocations(agentId, ctx.getEnv, ctx.home, ctx.platform, ctx.chosen)
  const installRoot = ctx.adapterDir
  const [items, version] = await Promise.all([
    Promise.all(locations.map((location) => withLogs((log) => resolveItem(location, log)))),
    withLogs(async (log) =>
      installRoot === null ? null : readCliVersion(agentId, installRoot, log),
    ),
  ])
  // The reads finish in any order; replay their logs in the order the page lists them.
  for (const [, entries] of [...items, version]) for (const entry of entries) ctx.log(...entry)
  return { cliVersion: version[0], config: items.map(([item]) => item) }
}

/** Where the agent keeps MCP servers of its own, and what moved the file, if anything. */
export interface McpLocation {
  path: string
  env: string | null
  chosen: boolean
  exists: boolean
}

/**
 * The file in which the agent keeps MCP servers for every project. Claude Code keeps them in
 * `.claude.json`, Codex in `config.toml` of its folder, and OpenCode in its settings file. Only the
 * file's existence is checked; it is never read.
 */
export async function mcpLocation(
  agentId: AgentId,
  getEnv: (name: string) => string | undefined,
  home: string,
  platform: Platform,
  chosen: string | null = null,
  log: LogFn,
): Promise<McpLocation | null> {
  const p = platform === 'win32' ? path.win32 : path.posix
  // A relative value is taken from the home directory, where agents are spawned.
  const variable = (name: string): string | null => {
    const value = getEnv(name)
    return value && value.trim() !== '' ? p.resolve(home, value) : null
  }
  switch (agentId) {
    case 'claude-code': {
      const env = variable('CLAUDE_CONFIG_DIR')
      const dir = chosen ?? env ?? home
      return {
        path: p.join(dir, '.claude.json'),
        env: chosen ? null : env ? 'CLAUDE_CONFIG_DIR' : null,
        chosen: chosen !== null,
        exists: await exists(p.join(dir, '.claude.json'), 'file', log),
      }
    }
    case 'codex': {
      const env = variable('CODEX_HOME')
      const dir = chosen ?? env ?? p.join(home, '.codex')
      return {
        path: p.join(dir, 'config.toml'),
        env: chosen ? null : env ? 'CODEX_HOME' : null,
        chosen: chosen !== null,
        exists: await exists(p.join(dir, 'config.toml'), 'file', log),
      }
    }
    case 'opencode': {
      const file = variable('OPENCODE_CONFIG')
      if (file) {
        return {
          path: file,
          env: 'OPENCODE_CONFIG',
          chosen: false,
          exists: await exists(file, 'file', log),
        }
      }
      const xdg = variable('XDG_CONFIG_HOME')
      const dir = p.join(xdg ?? p.join(home, '.config'), 'opencode')
      const candidates = [p.join(dir, 'opencode.json'), p.join(dir, 'opencode.jsonc')]
      const found = await firstExisting(candidates, log)
      return {
        path: found ?? candidates[0]!,
        env: xdg ? 'XDG_CONFIG_HOME' : null,
        chosen: false,
        exists: found !== null,
      }
    }
    default:
      return null
  }
}

async function firstExisting(candidates: string[], log: LogFn): Promise<string | null> {
  for (const candidate of candidates) if (await exists(candidate, 'file', log)) return candidate
  return null
}
