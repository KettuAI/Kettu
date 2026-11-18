import type { ContextDefinitionEstimate } from '@shared/context'
import type { McpServerStatus, SkillMetadata } from './protocol'

const UTF8_BYTES_PER_TOKEN = 4

const estimatedTokens = (bytes: number): number => Math.ceil(bytes / UTF8_BYTES_PER_TOKEN)

function bySize(a: ContextDefinitionEstimate, b: ContextDefinitionEstimate): number {
  return (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name)
}

export function estimateSkills(skills: SkillMetadata[]): ContextDefinitionEstimate[] {
  return skills
    .filter((skill) => skill.enabled)
    .map(({ name, description, path }) => ({
      name,
      tokens: estimatedTokens(Buffer.byteLength(`- ${name}: ${description} (file: ${path})\n`)),
    }))
    .sort(bySize)
}

function toolTokens(server: McpServerStatus): number | null {
  if (!server.tools || server.toolsError) return null
  const tools = Object.entries(server.tools)
  if (!tools.length && server.runtimeStatus && server.runtimeStatus !== 'connected') return null

  let bytes = 0
  for (const [name, value] of tools) {
    if (!value || typeof value !== 'object') return null
    const { description, inputSchema } = value as Record<string, unknown>
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return null
    bytes += Buffer.byteLength(JSON.stringify({ name, description, parameters: inputSchema }))
  }
  return estimatedTokens(bytes)
}

export function estimateMcpServers(servers: McpServerStatus[]): ContextDefinitionEstimate[] {
  return servers
    .filter((server) => server.runtimeStatus !== 'disabled')
    .map((server) => ({ name: server.name, tokens: toolTokens(server) }))
    .sort(bySize)
}
