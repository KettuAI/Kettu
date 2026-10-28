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
    case 'auggie': {
      // The CLI keeps user settings and prompt additions in its own folder.
      const folder = p.join(home, '.augment')
      return layout(
        folder,
        null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'APPEND_SYSTEM.md',
      )
    }
    case 'codebuddy': {
      const moved = variable('CODEBUDDY_CONFIG_DIR')
      const folder = moved ?? p.join(home, '.codebuddy')
      return layout(
        folder,
        moved ? 'CODEBUDDY_CONFIG_DIR' : null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'CODEBUDDY.md',
      )
    }
    case 'deepagents':
      // The adapter names neither a folder of its own nor a user instructions file.
      return []
    case 'dimcode': {
      // V2 keeps its data in its own folder; its docs name no instructions file.
      const moved = variable('DIMCODE_HOME')
      return [
        {
          id: 'folder',
          candidates: [moved ?? p.join(home, '.dimcode', 'v2')],
          env: moved ? 'DIMCODE_HOME' : null,
        },
      ]
    }
    case 'dirac': {
      const moved = variable('DIRAC_DIR')
      return [
        {
          id: 'folder',
          candidates: [moved ?? p.join(home, '.dirac', 'data')],
          env: moved ? 'DIRAC_DIR' : null,
        },
      ]
    }
    case 'glm': {
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = p.join(xdg ?? p.join(home, '.config'), 'glm-acp-agent')
      return [
        { id: 'folder', candidates: [folder], env: xdg ? 'XDG_CONFIG_HOME' : null },
        // `glm-acp-agent --setup` writes its key here, with Z_AI_API_KEY overriding it.
        { id: 'settings', candidates: [p.join(folder, 'credentials.json')], env: null },
      ]
    }
    case 'nova': {
      // New installs use ~/.nova; older ones keep their ~/.compass folder.
      const folder = p.join(home, '.nova')
      const legacy = p.join(home, '.compass')
      return [
        { id: 'folder', candidates: [folder, legacy], env: null },
        {
          id: 'settings',
          candidates: [p.join(folder, 'config.json'), p.join(legacy, 'config.json')],
          env: null,
        },
        {
          id: 'instructions',
          candidates: [
            p.join(folder, 'AGENTS.md'),
            p.join(folder, 'NOVA.md'),
            p.join(legacy, 'AGENTS.md'),
            p.join(legacy, 'NOVA.md'),
          ],
          env: null,
          fallback: p.join(folder, 'AGENTS.md'),
        },
      ]
    }
    case 'qoder': {
      const moved = variable('QODER_CONFIG_DIR')
      const folder = moved ?? p.join(home, '.qoder')
      return layout(
        folder,
        moved ? 'QODER_CONFIG_DIR' : null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'AGENTS.md',
      )
    }
    case 'sigit': {
      const moved = variable('SIGIT_CONFIG_DIR')
      const folder = moved ?? p.join(home, '.config', 'sigit')
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'SIGIT_CONFIG_DIR' : null },
        { id: 'settings', candidates: [p.join(folder, 'settings.toml')], env: null },
      ]
    }
    case 'agoragentic':
      // It names no folder and no instructions file; its key comes from the environment.
      return []
    case 'autohand': {
      const moved = variable('AUTOHAND_HOME')
      const folder = moved ?? p.join(home, '.autohand')
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'AUTOHAND_HOME' : null },
        {
          id: 'settings',
          candidates: ['config.toml', 'config.yaml', 'config.yml', 'config.json'].map((name) =>
            p.join(folder, name),
          ),
          env: null,
        },
      ]
    }
    case 'cursor': {
      const moved = variable('CURSOR_CONFIG_DIR')
      // Cursor's docs give XDG_CONFIG_HOME a folder of its own only on Linux and BSD.
      const xdg = platform === 'darwin' || platform === 'win32' ? null : variable('XDG_CONFIG_HOME')
      const folder = moved ?? (xdg ? p.join(xdg, 'cursor') : p.join(home, '.cursor'))
      // The CLI documents only project rules and AGENTS.md, so no global instructions file shows.
      return [
        {
          id: 'folder',
          candidates: [folder],
          env: moved ? 'CURSOR_CONFIG_DIR' : xdg ? 'XDG_CONFIG_HOME' : null,
        },
        { id: 'settings', candidates: [p.join(folder, 'cli-config.json')], env: null },
      ]
    }
    case 'kimi': {
      const moved = variable('KIMI_SHARE_DIR')
      const folder = moved ?? p.join(home, '.kimi')
      // Its docs name no global instructions file, so the folder and config.toml are all it shows.
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'KIMI_SHARE_DIR' : null },
        { id: 'settings', candidates: [p.join(folder, 'config.toml')], env: null },
      ]
    }
    case 'amp': {
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = p.join(xdg ?? p.join(home, '.config'), 'amp')
      return [
        { id: 'folder', candidates: [folder], env: xdg ? 'XDG_CONFIG_HOME' : null },
        {
          id: 'settings',
          candidates: [p.join(folder, 'settings.json'), p.join(folder, 'settings.jsonc')],
          env: null,
        },
        {
          id: 'instructions',
          candidates: [p.join(folder, 'AGENTS.md'), p.join(p.dirname(folder), 'AGENTS.md')],
          env: null,
          fallback: p.join(folder, 'AGENTS.md'),
        },
      ]
    }
    case 'goose': {
      const rootValue = getEnv('GOOSE_PATH_ROOT')
      const root =
        rootValue && rootValue.trim() !== '' && p.isAbsolute(rootValue) ? rootValue : null
      const xdg = platform === 'win32' ? null : variable('XDG_CONFIG_HOME')
      const appData = platform === 'win32' ? variable('APPDATA') : null
      let folder: string
      let env: string | null
      if (root) {
        folder = p.join(root, 'config')
        env = 'GOOSE_PATH_ROOT'
      } else if (platform === 'darwin') {
        folder = p.join(home, 'Library', 'Application Support', 'Block', 'goose')
        env = null
      } else if (platform === 'win32') {
        folder = p.join(appData ?? p.join(home, 'AppData', 'Roaming'), 'Block', 'goose', 'config')
        env = appData ? 'APPDATA' : null
      } else {
        folder = p.join(xdg ?? p.join(home, '.config'), 'goose')
        env = xdg ? 'XDG_CONFIG_HOME' : null
      }
      return [
        { id: 'folder', candidates: [folder], env },
        { id: 'settings', candidates: [p.join(folder, 'config.yaml')], env: null },
        {
          id: 'instructions',
          candidates: [p.join(folder, 'AGENTS.md'), p.join(folder, '.goosehints')],
          env: null,
          fallback: p.join(folder, 'AGENTS.md'),
        },
      ]
    }
    case 'kilo': {
      const file = variable('KILO_CONFIG')
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = p.join(xdg ?? p.join(home, '.config'), 'kilo')
      const settings: ConfigLocation = file
        ? { id: 'settings', candidates: [file], env: 'KILO_CONFIG' }
        : {
            id: 'settings',
            candidates: [p.join(folder, 'kilo.jsonc'), p.join(folder, 'kilo.json')],
            env: null,
          }
      return [
        { id: 'folder', candidates: [folder], env: xdg ? 'XDG_CONFIG_HOME' : null },
        settings,
        { id: 'instructions', candidates: [p.join(folder, 'AGENTS.md')], env: null },
      ]
    }
    case 'gemini': {
      // GEMINI_CLI_HOME replaces the home directory, so .gemini sits under it.
      const envHome = variable('GEMINI_CLI_HOME')
      const folder = p.join(envHome ?? home, '.gemini')
      return layout(
        folder,
        envHome ? 'GEMINI_CLI_HOME' : null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'GEMINI.md',
      )
    }
    case 'copilot': {
      const moved = variable('COPILOT_HOME')
      const folder = moved ?? p.join(home, '.copilot')
      return layout(
        folder,
        moved ? 'COPILOT_HOME' : null,
        { id: 'settings', candidates: [p.join(folder, 'config.json')], env: null },
        'copilot-instructions.md',
      )
    }
    case 'qwen': {
      const folder = p.join(home, '.qwen')
      return layout(
        folder,
        null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'QWEN.md',
      )
    }
    case 'grok': {
      const moved = variable('GROK_HOME')
      const folder = moved ?? p.join(home, '.grok')
      return layout(
        folder,
        moved ? 'GROK_HOME' : null,
        { id: 'settings', candidates: [p.join(folder, 'config.toml')], env: null },
        'AGENTS.md',
      )
    }
    case 'cline': {
      const moved = variable('CLINE_DIR')
      const folder = moved ?? p.join(home, '.cline')
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'CLINE_DIR' : null },
        {
          id: 'settings',
          candidates: [p.join(folder, 'data', 'settings', 'global-settings.json')],
          env: null,
        },
        // Cline reads its global rules from the cross-tool folder, not its own.
        { id: 'instructions', candidates: [p.join(home, '.agents', 'AGENTS.md')], env: null },
      ]
    }
    case 'droid': {
      const folder = p.join(home, '.factory')
      return layout(
        folder,
        null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'AGENTS.md',
      )
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
