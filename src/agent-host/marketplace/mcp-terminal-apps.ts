// Which of the apps a takeover can change are installed: by the app itself, never by its config
// folder, which stays behind after the app is removed.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { MCP_TERMINAL_APPS, type McpTerminalApp } from '@shared/mcp-terminal'

const MAC_BUNDLES: Record<McpTerminalApp, string[]> = {
  'claude-desktop': ['Claude.app'],
  cursor: ['Cursor.app'],
  vscode: ['Visual Studio Code.app'],
  windsurf: ['Windsurf.app'],
  devin: ['Devin.app'],
  zed: ['Zed.app', 'Zed Preview.app'],
}

/** Under %LOCALAPPDATA%; a `Programs` one also under %ProgramFiles%, for a machine-wide install. */
const WINDOWS_FOLDERS: Record<McpTerminalApp, string[]> = {
  'claude-desktop': ['AnthropicClaude'],
  cursor: ['Programs\\cursor'],
  vscode: ['Programs\\Microsoft VS Code'],
  windsurf: ['Programs\\Windsurf'],
  devin: ['Programs\\Devin'],
  zed: ['Programs\\Zed'],
}

const LINUX_COMMANDS: Record<McpTerminalApp, string[]> = {
  'claude-desktop': ['claude-desktop'],
  cursor: ['cursor'],
  vscode: ['code'],
  windsurf: ['windsurf'],
  // Not `devin`, which is Devin CLI's.
  devin: ['devin-desktop'],
  zed: ['zed', 'zeditor'],
}

export interface InstalledAppsOptions {
  platform: Platform
  home: string
  env: Record<string, string | undefined>
  find(command: string): Promise<string | null>
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  )

export async function installedTerminalApps(
  options: InstalledAppsOptions,
): Promise<McpTerminalApp[]> {
  const { platform, home, env } = options
  const apps = Object.keys(MCP_TERMINAL_APPS) as McpTerminalApp[]
  const found = await Promise.all(
    apps.map(async (app) => {
      if (platform === 'darwin') {
        const roots = ['/Applications', path.posix.join(home, 'Applications')]
        for (const root of roots) {
          for (const bundle of MAC_BUNDLES[app]) {
            if (await exists(path.posix.join(root, bundle))) return true
          }
        }
        return false
      }
      if (platform === 'win32') {
        const local = env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local')
        const machine = env.ProgramFiles
        const places = WINDOWS_FOLDERS[app].flatMap((folder) => [
          path.win32.join(local, folder),
          ...(machine && folder.startsWith('Programs\\')
            ? [path.win32.join(machine, folder.slice('Programs\\'.length))]
            : []),
        ])
        for (const place of places) if (await exists(place)) return true
        return false
      }
      for (const command of LINUX_COMMANDS[app]) {
        if (await options.find(command)) return true
      }
      return false
    }),
  )
  return apps.filter((_, index) => found[index])
}
