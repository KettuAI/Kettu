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
}

/** Where each agent reads its configuration, by the same rules the agent itself follows. */
export function configLocations(
  agentId: AgentId,
  getEnv: (name: string) => string | undefined,
  home: string,
  platform: Platform,
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
    { id: 'folder', candidates: [folder], env },
    settings,
    { id: 'instructions', candidates: [p.join(folder, instructions)], env: null },
  ]

  switch (agentId) {
    case 'claude-code': {
      const moved = variable('CLAUDE_CONFIG_DIR')
      const folder = moved ?? p.join(home, '.claude')
      return layout(
        folder,
        moved ? 'CLAUDE_CONFIG_DIR' : null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'CLAUDE.md',
      )
    }
    case 'codex': {
      const moved = variable('CODEX_HOME')
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
  for (const candidate of location.candidates) {
    if (await exists(candidate, kind, log)) {
      return { id: location.id, path: candidate, exists: true, env: location.env }
    }
  }
  return { id: location.id, path: location.candidates[0] ?? '', exists: false, env: location.env }
}

/** The package whose `package.json` names the CLI an adapter runs, and the field that holds it. */
const CLI_VERSION_SOURCES: Partial<Record<AgentId, { package: string; field: string }>> = {
  'claude-code': { package: '@anthropic-ai/claude-agent-sdk', field: 'claudeCodeVersion' },
  codex: { package: '@openai/codex', field: 'version' },
}

async function readCliVersion(
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

export interface AgentDetailsContext {
  getEnv(name: string): string | undefined
  home: string
  platform: Platform
  /** `<userData>/agents`, where package agents are installed. */
  adaptersDir: string
  /** The pinned adapter version of a package agent; null for the others. */
  adapterVersion: string | null
  log: LogFn
}

/** Never rejects: a place or version that cannot be read comes back as missing or null. */
export async function readAgentDetails(
  agentId: AgentId,
  ctx: AgentDetailsContext,
): Promise<AgentDetails> {
  const locations = configLocations(agentId, ctx.getEnv, ctx.home, ctx.platform)
  const installRoot =
    ctx.adapterVersion === null ? null : path.join(ctx.adaptersDir, agentId, ctx.adapterVersion)
  const [config, cliVersion] = await Promise.all([
    Promise.all(locations.map((location) => resolveItem(location, ctx.log))),
    installRoot === null ? null : readCliVersion(agentId, installRoot, ctx.log),
  ])
  return { cliVersion, config }
}
