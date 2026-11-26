// The bridge program that carries a stdio-only MCP client to a server Kettu runs: shipped with
// the desktop app and the daemon among their helpers, built from native/mcp-bridge.

import type { Platform } from './platform'

export const MCP_BRIDGE_NAME = 'kettu-mcp-bridge'

export function mcpBridgeFile(platform: Platform): string {
  return platform === 'win32' ? `${MCP_BRIDGE_NAME}.exe` : MCP_BRIDGE_NAME
}
