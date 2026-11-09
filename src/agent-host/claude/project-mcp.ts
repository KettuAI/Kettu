import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { DeclaredMcpServer } from '@shared/thread'

const TARGET_CHARS = 300

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The servers the `.mcp.json` files of `cwd` and of every folder above it declare, which Claude
 * Code starts for a session there; the nearer file's server wins a name. Only names and what each
 * runs are read: Claude Code parses the config itself.
 */
export async function declaredServers(
  cwd: string,
  log?: (message: string) => void,
): Promise<DeclaredMcpServer[]> {
  const byName = new Map<string, DeclaredMcpServer>()
  let dir = path.resolve(cwd)
  for (;;) {
    for (const server of await read(path.join(dir, '.mcp.json'), log)) {
      if (!byName.has(server.name)) byName.set(server.name, server)
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return [...byName.values()]
}

async function read(file: string, log?: (message: string) => void): Promise<DeclaredMcpServer[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  let data: unknown
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (error) {
    log?.(`Could not read the MCP servers of ${file}: ${(error as Error).message}`)
    return []
  }
  const servers = isRecord(data) && isRecord(data.mcpServers) ? data.mcpServers : {}
  return Object.entries(servers).map(([name, config]) => ({ name, target: target(config) }))
}

/** The URL a server reaches or the command it runs, as the user reads it before allowing it. */
function target(config: unknown): string {
  if (!isRecord(config)) return ''
  const args = Array.isArray(config.args)
    ? config.args.filter((arg): arg is string => typeof arg === 'string')
    : []
  const text =
    typeof config.url === 'string'
      ? config.url
      : typeof config.command === 'string'
        ? [config.command, ...args].join(' ')
        : ''
  return text.length > TARGET_CHARS ? `${text.slice(0, TARGET_CHARS - 1)}…` : text
}
