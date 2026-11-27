import path from 'node:path'
import type { AgentId, HarnessId } from '@shared/agents'
import type { Platform } from '@shared/platform'
import type { McpConfigFile } from './mcp-config'

interface AgentConfig {
  id: AgentId
  harness: HarnessId
  folder: string | null
}

export function mcpConfigPaths(
  platform: Platform,
  home: string,
  agents: readonly AgentConfig[],
  projects: readonly string[],
  getEnv: (key: string, agent?: AgentId) => string | undefined,
  agentOnly = false,
): McpConfigFile[] {
  const p = platform === 'win32' ? path.win32 : path.posix
  const files: McpConfigFile[] = []
  const userConfig = (key: string): string | undefined => {
    const value = getEnv(key)?.trim()
    return value ? p.resolve(home, value) : undefined
  }
  for (const { id: agentId, harness, folder } of agents) {
    const configured = (key: string): string | undefined => {
      const value = getEnv(key, agentId)?.trim()
      return value ? p.resolve(home, value) : undefined
    }
    const under = (fallback: string, variable?: string): string =>
      folder ?? (variable && configured(variable)) ?? p.join(home, fallback)
    const add = (file: string, layout: McpConfigFile['layout'] = 'standard', firstOf?: string) =>
      files.push({ path: file, agentId, layout, firstOf })
    switch (harness) {
      case 'claude-code':
        files.push({
          path: p.join(under('', 'CLAUDE_CONFIG_DIR'), '.claude.json'),
          agentId,
          layout: 'claude',
          projects,
        })
        break
      case 'codex':
        add(p.join(under('.codex', 'CODEX_HOME'), 'config.toml'), 'codex')
        break
      case 'opencode': {
        const dir =
          folder ??
          configured('OPENCODE_CONFIG_DIR') ??
          p.join(configured('XDG_CONFIG_HOME') ?? p.join(home, '.config'), 'opencode')
        const file = configured('OPENCODE_CONFIG')
        if (file) add(file, 'opencode')
        else {
          add(p.join(dir, 'opencode.json'), 'opencode')
          add(p.join(dir, 'opencode.jsonc'), 'opencode')
        }
        break
      }
      case 'gemini':
        add(p.join(under('.gemini', 'GEMINI_CLI_HOME'), 'settings.json'))
        break
      case 'antigravity':
        add(
          p.join(
            folder ? p.join(folder, '.gemini') : p.join(home, '.gemini'),
            'config',
            'mcp_config.json',
          ),
        )
        break
      case 'pi':
        add(p.join(under('.pi/agent', 'PI_CODING_AGENT_DIR'), 'mcp.json'))
        break
      case 'deepseek': {
        const root = under('.dsh', 'DSH_HOME')
        add(p.join(root, 'cordis.patch.yml'), 'yaml')
        for (const profile of ['sdk', 'acp', 'cli']) {
          add(p.join(root, 'profiles', profile, 'cordis.patch.yml'), 'yaml')
        }
        break
      }
      case 'qwen':
        add(p.join(under('.qwen'), 'settings.json'))
        break
      case 'cursor':
        add(p.join(under('.cursor'), 'mcp.json'))
        break
      case 'copilot':
        add(p.join(under('.copilot', 'COPILOT_HOME'), 'mcp-config.json'))
        break
      case 'droid':
        add(p.join(under('.factory'), 'mcp.json'))
        break
      case 'kimi':
        add(p.join(under('.kimi', 'KIMI_HOME'), 'mcp.json'))
        break
      case 'qoder':
      case 'qoder-cn':
        add(p.join(under(harness === 'qoder' ? '.qoder' : '.qoder-cn'), 'settings.json'))
        break
      case 'codebuddy':
        for (const file of ['.mcp.json', 'mcp.json', '.codebuddy.json']) {
          add(p.join(under('.codebuddy', 'CODEBUDDY_CONFIG_DIR'), file), 'standard', agentId)
        }
        break
      case 'cline':
        add(
          configured('CLINE_MCP_SETTINGS_PATH') ??
            p.join(under('.cline'), 'data', 'settings', 'cline_mcp_settings.json'),
        )
        break
      case 'mistral-vibe':
        add(p.join(under('.vibe', 'VIBE_HOME'), 'config.toml'), 'codex')
        break
    }
  }

  if (agentOnly) return files

  const config = userConfig('XDG_CONFIG_HOME') ?? p.join(home, '.config')
  const appData =
    platform === 'darwin'
      ? p.join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? (userConfig('APPDATA') ?? p.join(home, 'AppData', 'Roaming'))
        : config
  const app = (name: string, file: string, layout: McpConfigFile['layout'] = 'standard') =>
    files.push({ app: name, path: file, layout })
  app('Claude Desktop', p.join(appData, 'Claude', 'claude_desktop_config.json'))
  app('Cursor', p.join(home, '.cursor', 'mcp.json'))
  app('VS Code', p.join(appData, 'Code', 'User', 'mcp.json'), 'vscode')
  app('VS Code Insiders', p.join(appData, 'Code - Insiders', 'User', 'mcp.json'), 'vscode')
  app(
    'GitHub Copilot',
    p.join(userConfig('COPILOT_HOME') ?? p.join(home, '.copilot'), 'mcp-config.json'),
  )
  app('Windsurf', p.join(home, '.codeium', 'windsurf', 'mcp_config.json'))
  app('Zed', p.join(platform === 'win32' ? appData : config, 'zed', 'settings.json'), 'zed')

  const projectFiles: [string, McpConfigFile['layout'], string?][] = [
    ['.mcp.json', 'standard'],
    ['.codex/config.toml', 'codex'],
    ['opencode.json', 'opencode'],
    ['opencode.jsonc', 'opencode'],
    ['.gemini/settings.json', 'standard'],
    ['.agents/mcp_config.json', 'standard'],
    ['.pi/mcp.json', 'standard'],
    ['.qwen/settings.json', 'standard'],
    ['.cursor/mcp.json', 'standard', 'Cursor'],
    ['.vscode/mcp.json', 'vscode', 'VS Code'],
    ['.factory/mcp.json', 'standard'],
    ['.qoder/settings.json', 'standard'],
    ['mcp.json', 'standard'],
    ['.zed/settings.json', 'zed', 'Zed'],
  ]
  for (const project of projects) {
    for (const [file, layout, name] of projectFiles) {
      files.push({ path: p.join(project, file), layout, project, app: name })
    }
  }
  return files
}
