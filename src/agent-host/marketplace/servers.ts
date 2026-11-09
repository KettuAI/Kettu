// The servers the Marketplace installed, as a session's agent gets them: those meant for its agent,
// each input filled from the key store, and only over transports the agent speaks. The key store's
// values reach the host in memory from main and leave it only inside what agents are handed.

import {
  serverFor,
  specInputs,
  type MarketKeyState,
  type MarketServer,
  type McpValue,
} from '@shared/marketplace'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import type { AgentInit, McpServer } from '../connection'
import type { Access } from './connections'
import { proxyPath } from './proxy'

/** The values of each server's inputs, by server id and input name. */
export type MarketKeys = ReadonlyMap<string, ReadonlyMap<string, string>>

/** The MCP transports an agent speaks. */
export type McpTransports = Pick<AgentInit['capabilities'], 'mcpHttp' | 'mcpSse' | 'mcpStdio'>

export const ALL_TRANSPORTS: McpTransports = { mcpHttp: true, mcpSse: true, mcpStdio: true }

// Bounds on what main sends, which it already checks; a message past them is dropped whole.
const MAX_SERVERS = 1_000
const MAX_INPUTS = 64
const MAX_NAME_CHARS = 256
const MAX_VALUE_CHARS = 16_384

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `host:market-keys` values, or null when they are not names to strings by server id. */
export function parseMarketKeys(value: unknown): MarketKeys | null {
  if (!isRecord(value)) return null
  const servers = Object.entries(value)
  if (servers.length > MAX_SERVERS) return null
  const keys = new Map<string, Map<string, string>>()
  for (const [id, inputs] of servers) {
    if (id.length === 0 || id.length > MAX_NAME_CHARS || !isRecord(inputs)) return null
    const entries = Object.entries(inputs)
    if (entries.length > MAX_INPUTS) return null
    const values = new Map<string, string>()
    for (const [name, text] of entries) {
      if (name.length === 0 || name.length > MAX_NAME_CHARS) return null
      if (typeof text !== 'string' || text.length > MAX_VALUE_CHARS) return null
      if (text !== '') values.set(name, text)
    }
    keys.set(id, values)
  }
  return keys
}

/** Which of each kept server's inputs have a value, by server id; never the values. */
export function keyState(servers: readonly MarketServer[], keys: MarketKeys): MarketKeyState {
  return Object.fromEntries(
    servers.map((server) => [
      server.id,
      specInputs(server.spec)
        .filter((input) => keys.get(server.id)?.has(input.name) === true)
        .map((input) => input.name),
    ]),
  )
}

/** A spec's headers or environment with the inputs filled; null when a required one is empty. */
function filled(
  values: readonly McpValue[],
  keys: ReadonlyMap<string, string> | undefined,
): { values: { name: string; value: string }[]; secret: boolean } | null {
  const out: { name: string; value: string }[] = []
  let secret = false
  for (const item of values) {
    if (!('input' in item)) {
      out.push({ name: item.name, value: item.value })
      continue
    }
    const value = keys?.get(item.name)
    if (value === undefined) {
      if (item.required) return null
      continue
    }
    out.push({ name: item.name, value: `${item.prefix ?? ''}${value}` })
    secret = true
  }
  return { values: out, secret }
}

/**
 * `npx` is a `.cmd` script on Windows, which an agent cannot start as a program, so it runs
 * through `cmd /c` there.
 */
function program(command: string, args: string[], platform: Platform): [string, string[]] {
  if (platform === 'win32' && command.toLowerCase() === 'npx') {
    return ['cmd', ['/c', command, ...args]]
  }
  return [command, args]
}

/** How the session reaches the OAuth servers: where each stands, and its bearer for the proxy. */
export interface OAuthAccess {
  access(server: MarketServer): Access
  bearer(): { origin: string; token: string } | null
}

/** A server's fixed headers and filled inputs, as its requests carry them. */
export function serverHeaders(server: MarketServer, keys: MarketKeys): Record<string, string> {
  if (server.spec.type !== 'http') return {}
  const values = filled(server.spec.headers, keys.get(server.id))
  return Object.fromEntries((values?.values ?? []).map((value) => [value.name, value.value]))
}

/**
 * The servers among `servers` that go to `agentId`, as its sessions get them. A server whose
 * required input has no value, or whose transport the agent cannot speak, is left out; one whose
 * name another server already has, such as Kettu's own, gets a number after it. A server that
 * signs in goes through the proxy with the session's bearer while it is connected, directly when
 * it turned out to need no sign-in, and not at all otherwise.
 */
export function libraryServers(
  servers: readonly MarketServer[],
  keys: MarketKeys,
  agentId: AgentId,
  transports: McpTransports,
  options: { platform: Platform; taken?: readonly string[]; oauth?: OAuthAccess },
): McpServer[] {
  const used = new Set(options.taken ?? [])
  const out: McpServer[] = []
  const nameOf = (server: MarketServer): string => {
    let name = server.name
    for (let n = 2; used.has(name); n++) name = `${server.name}-${n}`
    used.add(name)
    return name
  }
  for (const server of servers) {
    if (!serverFor(server, agentId)) continue
    const { spec } = server
    if (spec.type === 'http' && spec.oauth) {
      const access = options.oauth?.access(server) ?? null
      if (access === null) continue
      if (access === 'proxy') {
        // The proxy speaks streamable HTTP to agents and to the server.
        if (!transports.mcpHttp || spec.transport !== 'streamable-http') continue
        const bearer = options.oauth?.bearer()
        if (!bearer) continue
        out.push({
          type: 'http',
          name: nameOf(server),
          url: `${bearer.origin}${proxyPath(server.id)}`,
          headers: [{ name: 'Authorization', value: `Bearer ${bearer.token}` }],
          secret: true,
        })
        continue
      }
    }
    if (spec.type === 'http') {
      const speaks = spec.transport === 'sse' ? transports.mcpSse : transports.mcpHttp
      if (!speaks) continue
    } else if (!transports.mcpStdio) {
      continue
    }
    const values = filled(spec.type === 'http' ? spec.headers : spec.env, keys.get(server.id))
    if (!values) continue
    const name = nameOf(server)
    if (spec.type === 'http') {
      out.push({
        type: spec.transport === 'sse' ? 'sse' : 'http',
        name,
        url: spec.url,
        headers: values.values,
        ...(values.secret ? { secret: true } : {}),
      })
    } else {
      const [command, args] = program(spec.command, spec.args, options.platform)
      out.push({
        type: 'stdio',
        name,
        command,
        args,
        env: values.values,
        ...(values.secret ? { secret: true } : {}),
      })
    }
  }
  return out
}
