import { parse as parseToml } from '@decimalturn/toml-patch'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parseDocument } from 'yaml'
import type { MarketServer, McpSpec, McpValue } from '@shared/marketplace'
import type { McpConfigSource, McpDiscoveryFileError } from '@shared/mcp-discovery'

type Dictionary = Record<string, unknown>
export type ConfigLayout = 'standard' | 'claude' | 'codex' | 'opencode' | 'vscode' | 'zed' | 'yaml'
export interface McpConfigFile extends McpConfigSource {
  layout: ConfigLayout
  projects?: readonly string[]
  /** Skip servers named in a listed project's `disabledMcpServers` (for a single session). */
  respectProjectDisabled?: boolean
  firstOf?: string
}

export interface ConfiguredMcp {
  name: string
  spec: McpSpec
  secrets: Record<string, string>
  source: McpConfigSource
}

const SHELL_REFERENCE = /^(?:(?:Bearer|Basic) )?\$\{[a-zA-Z_][a-zA-Z_0-9]*\}$/

export function object(value: unknown): Dictionary | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Dictionary)
    : null
}

export class McpConfigError extends Error {
  constructor(
    readonly reason: McpDiscoveryFileError['reason'],
    readonly line?: number,
  ) {
    super(reason)
  }
}

function invalid(): never {
  throw new McpConfigError('invalid-server')
}

function stringMap(value: unknown): [string, string][] {
  if (value === undefined) return []
  const map = object(value)
  if (!map) return invalid()
  return Object.entries(map).map(([name, text]) => {
    if (typeof text !== 'string') return invalid()
    return [name, text]
  })
}

function inputs(
  values: [string, string][],
  secrets: Record<string, string>,
  caseInsensitive = false,
): McpValue[] {
  const unique = new Map<string, [string, string]>()
  for (const [name, value] of values) {
    unique.set(caseInsensitive ? name.toLowerCase() : name, [name, value])
  }
  return [...unique.values()].map(([name, value]) => {
    if (SHELL_REFERENCE.test(value)) return { name, value }
    secrets[name] = value
    return { name, input: true, secret: true, required: true }
  })
}

export function configuredMcp(
  name: string,
  raw: unknown,
  source: McpConfigSource,
): ConfiguredMcp | null {
  source = { ...source, entryName: name }
  const server = object(raw)
  if (!server) return invalid()
  if (server.enabled === false || server.disabled === true) return null
  const secrets = Object.create(null) as Record<string, string>
  const url = server.url ?? server.httpUrl ?? server.serverUrl
  if (typeof url === 'string') {
    let endpoint: URL
    try {
      endpoint = new URL(url)
    } catch {
      return invalid()
    }
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    ) {
      return invalid()
    }
    const references = stringMap(server.env_http_headers).map(
      ([header, variable]): [string, string] => {
        if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(variable)) return invalid()
        return [header, '${' + variable + '}']
      },
    )
    if (server.bearer_token_env_var !== undefined) {
      if (
        typeof server.bearer_token_env_var !== 'string' ||
        !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(server.bearer_token_env_var)
      ) {
        return invalid()
      }
      references.push(['Authorization', 'Bearer ${' + server.bearer_token_env_var + '}'])
    }
    // Codex writes literal headers in `http_headers`; merge over `headers` so neither drops keys.
    const headers = inputs(
      [...stringMap(server.headers), ...stringMap(server.http_headers), ...references],
      secrets,
      true,
    )
    return {
      name,
      source,
      secrets,
      spec: {
        type: 'http',
        url,
        transport: server.type === 'sse' || server.transport === 'sse' ? 'sse' : 'streamable-http',
        headers,
      },
    }
  }

  const commandObject = object(server.command)
  const commandWords = Array.isArray(server.command) ? server.command : null
  const command = commandObject?.path ?? commandWords?.[0] ?? server.command
  const args = commandWords?.slice(1) ?? commandObject?.args ?? server.args ?? []
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    !Array.isArray(args) ||
    !args.every((arg: unknown): arg is string => typeof arg === 'string')
  )
    return invalid()
  const env = inputs(stringMap(commandObject?.env ?? server.env ?? server.environment), secrets)
  return { name, source, secrets, spec: { type: 'stdio', command, args, env } }
}

function readDocument(text: string, layout: ConfigLayout): Dictionary {
  if (layout === 'codex' || layout === 'yaml') {
    let result: unknown
    try {
      if (layout === 'codex') result = parseToml(text)
      else {
        const document = parseDocument(text, {
          customTags: [
            {
              tag: 'tag:yaml.org,2002:js',
              resolve: (value: string) => {
                const name = /^process\.env\.([a-zA-Z_][a-zA-Z_0-9]*)$/.exec(value)?.[1]
                return name ? '${' + name + '}' : null
              },
            },
          ],
        })
        if (document.errors.length > 0) throw new Error('Invalid YAML')
        result = document.toJS({ maxAliasCount: 0 })
        if (Array.isArray(result)) return { patches: result }
      }
    } catch {
      throw new McpConfigError(layout === 'codex' ? 'invalid-toml' : 'invalid-yaml')
    }
    return object(result) ?? invalid()
  }
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true })
  const error = errors[0]
  if (error)
    throw new McpConfigError('invalid-json', text.slice(0, error.offset).split('\n').length)
  return object(parsed) ?? invalid()
}

function entries(value: unknown): [string, unknown][] {
  return value === undefined ? [] : Object.entries(object(value) ?? invalid())
}

function zedEntry(raw: unknown): unknown {
  const server = object(raw)
  if (server?.source === 'extension' && !server.command && !server.url) return { enabled: false }
  const settings = object(server?.settings)
  return server && settings ? { ...settings, ...server } : raw
}

export function parseMcpConfig(
  text: string,
  file: McpConfigFile,
): { servers: ConfiguredMcp[]; error?: McpDiscoveryFileError } {
  const { path, agentId, app, project } = file
  const source = { path, agentId, app, project }
  try {
    const config = readDocument(text, file.layout)
    const servers: ConfiguredMcp[] = []
    let malformed = false
    const add = (
      values: unknown,
      origin: McpConfigSource,
      map = (value: unknown) => value,
    ): void => {
      for (const [name, raw] of entries(values)) {
        try {
          const server = configuredMcp(name, map(raw), origin)
          if (server) servers.push(server)
        } catch {
          malformed = true
        }
      }
    }
    switch (file.layout) {
      case 'claude': {
        const projects = object(config.projects)
        const disabled = new Set<string>()
        if (file.respectProjectDisabled) {
          for (const projectPath of file.projects ?? []) {
            const list = object(projects?.[projectPath])?.disabledMcpServers
            if (Array.isArray(list)) {
              for (const item of list) if (typeof item === 'string') disabled.add(item)
            }
          }
        }
        add(config.mcpServers, source)
        for (const projectPath of file.projects ?? []) {
          add(object(projects?.[projectPath])?.mcpServers, { ...source, project: projectPath })
        }
        if (disabled.size > 0) {
          const active = servers.filter((server) => !disabled.has(server.name))
          return malformed
            ? { servers: active, error: { source, reason: 'invalid-server' } }
            : { servers: active }
        }
        break
      }
      case 'codex':
        if (Array.isArray(config.mcp_servers)) {
          for (const raw of config.mcp_servers) {
            const item = object(raw)
            if (!item || typeof item.name !== 'string') malformed = true
            else add({ [item.name]: item }, source)
          }
        } else add(config.mcp_servers, source)
        break
      case 'opencode':
        add(object(config.mcp)?.servers ?? config.mcp, source)
        break
      case 'vscode':
        add(config.servers ?? config.mcpServers, source)
        break
      case 'zed':
        add(config.context_servers, source, zedEntry)
        break
      case 'yaml':
        add(
          config.mcpServers ?? config.mcp_servers ?? object(config.mcp)?.servers ?? config.mcp,
          source,
        )
        for (const patch of Array.isArray(config.patches) ? config.patches : []) {
          const inserted = object(patch)?.insert
          for (const raw of Array.isArray(inserted) ? inserted : []) {
            const item = object(raw)
            if (item?.name !== '@deepseek-ai/dsh-mcp-client') continue
            const settings = object(item.config)
            if (typeof settings?.serverName === 'string')
              add({ [settings.serverName]: settings }, source)
            else malformed = true
          }
        }
        break
      case 'standard':
        add(config.mcpServers ?? config.servers, source)
        break
    }
    return malformed ? { servers, error: { source, reason: 'invalid-server' } } : { servers }
  } catch (error) {
    return {
      servers: [],
      error:
        error instanceof McpConfigError
          ? { source, reason: error.reason, line: error.line }
          : { source, reason: 'unreadable' },
    }
  }
}

export function importedServer(
  id: string,
  configured: ConfiguredMcp,
  name: string,
  agents: MarketServer['agents'],
  sources: McpConfigSource[],
): MarketServer {
  return {
    id,
    name,
    title: name,
    source: 'manual',
    version: null,
    spec: configured.spec,
    agents,
    on: true,
    importedFrom: sources,
  }
}
