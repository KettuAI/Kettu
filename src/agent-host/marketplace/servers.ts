// The servers the Marketplace installed, as a session's agent gets them: those meant for its agent,
// each under its own name. Kettu runs and forwards them, so an agent gets the server's path on
// Kettu's loopback service with its session's token, or a bridge command when it speaks only stdio,
// and never a key; a command set to run by each agent goes to it as before, its inputs filled from
// the key store. The key store's values reach the host in memory from main.

import {
  runOf,
  serverFor,
  specInputs,
  type MarketKeyState,
  type MarketServer,
  type McpSpec,
  type McpValue,
} from '@shared/marketplace'
import { mcpFingerprint, type McpEndpoint } from '@shared/mcp-fingerprint'
import { servedInProject } from '@shared/mcp-insight'
import type { NodeRuntime } from '@shared/host-control'
import { createRedactor } from '@shared/log/redact'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import type { AgentInit, McpServer } from '../connection'
import { serverPath, type ServerCommand } from '../mcp-router/router'
import type { Access } from './connections'
import { getEnv, type Env } from '../find-command'
import { isBridgeSpec } from './mcp-terminal-files'

/** The values of each server's inputs, by server id and input name. */
export type MarketKeys = ReadonlyMap<string, ReadonlyMap<string, string>>

/** The MCP transports an agent speaks. */
export type McpTransports = Pick<
  AgentInit['capabilities'],
  'mcpHttp' | 'mcpSse' | 'mcpStdio' | 'mcpMergesSameName'
>

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

const reference = /\$\{([a-zA-Z_][a-zA-Z_0-9]*)\}/g
export function resolveMcpReference(
  value: string,
  env: Env,
  platform: Platform,
): { value: string; missing?: string } {
  let missing: string | undefined
  const resolved = value.replace(reference, (_, name: string) => {
    const found = getEnv(env, name, platform)
    if (found === undefined) missing ??= name
    return found ?? ''
  })
  return { value: resolved, missing }
}

/** A spec's headers or environment with the inputs filled; null when a required one is empty. */
function filled(
  values: readonly McpValue[],
  keys: ReadonlyMap<string, string> | undefined,
  shell?: { env: Env; platform: Platform },
): { values: { name: string; value: string }[]; secret: boolean } | null {
  const out: { name: string; value: string }[] = []
  let secret = false
  for (const item of values) {
    if (!('input' in item)) {
      const resolved = shell
        ? resolveMcpReference(item.value, shell.env, shell.platform)
        : { value: item.value }
      if (resolved.missing) return null
      out.push({ name: item.name, value: resolved.value })
      if (resolved.value !== item.value) secret = true
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

/** Where each OAuth server stands with its sign-in. */
export interface OAuthAccess {
  access(server: MarketServer): Access
}

/** How a session reaches the router: its origin and token, and the servers it is handed. */
export interface RouterAccess {
  origin: string
  token: string
  /** The servers handed to the session, which its token may then reach. */
  allow(serverIds: readonly string[]): void
  /**
   * Servers the session reaches only through Kettu's tool gateway, for an agent that drops
   * tools.
   */
  gate?(serverIds: readonly string[]): void
}

/**
 * For an agent that drops MCP tools past a budget of its own: a server whose tools Kettu knows to
 * be small is declared, up to a total, and every other one goes behind Kettu's tool gateway.
 */
export const GATED_SERVER_BYTES = 6_000
export const DECLARED_LIBRARY_BYTES = 12_000

/** The environment variables the bridge reads where to connect from. */
export const BRIDGE_ENV = { url: 'KETTU_MCP_URL', token: 'KETTU_MCP_TOKEN' } as const

/**
 * Masks what a server's process may print of its keys: the values of its inputs and every fixed
 * header or environment value, which a server added by hand may hold a key in, then `then`.
 */
export function serverMasker(
  server: MarketServer | undefined,
  keys: MarketKeys,
  then: (text: string) => string = (text) => text,
  shell?: { env: Env; platform: Platform },
): (text: string) => string {
  const values = [...(server ? (keys.get(server.id)?.values() ?? []) : [])]
  if (server) {
    for (const item of server.spec.type === 'stdio' ? server.spec.env : server.spec.headers) {
      if ('input' in item) continue
      values.push(item.value)
      // A reference reaches the process as what it names, which is masked as well.
      if (shell) values.push(resolveMcpReference(item.value, shell.env, shell.platform).value)
    }
  }
  // The longest first, so a value that holds another is masked whole.
  values.sort((a, b) => b.length - a.length)
  const own = createRedactor({ secrets: () => values })
  return (text) => then(own(text))
}

/** A server's fixed headers and filled inputs, as its requests carry them. */
export function serverHeaders(
  server: MarketServer,
  keys: MarketKeys,
  shell?: { env: Env; platform: Platform },
): Record<string, string> {
  if (server.spec.type !== 'http') return {}
  const values = filled(server.spec.headers, keys.get(server.id), shell)
  return Object.fromEntries((values?.values ?? []).map((value) => [value.name, value.value]))
}

/**
 * What a command server runs for the router: the program, its arguments and its environment, the
 * login shell's with the runtime's and the filled inputs over it; or why it cannot run.
 */
export function serverCommand(
  server: MarketServer,
  keys: MarketKeys,
  env: Readonly<Env>,
  node: NodeRuntime | undefined,
  platform: Platform = process.platform as Platform,
): ServerCommand | string {
  const { spec } = server
  if (spec.type !== 'stdio') return `${server.name} is not a command`
  if (spec.runtime === 'node' && !node) return `${server.name} needs Kettu's Node.js`
  const values = filled(spec.env, keys.get(server.id), { env, platform })
  if (!values) return `${server.name} is missing a required value`
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value
  const runtime = spec.runtime === 'node' ? node : undefined
  Object.assign(out, runtime?.env ?? {})
  for (const value of values.values) out[value.name] = value.value
  return runtime
    ? { command: runtime.command, args: [...spec.args], env: out }
    : { command: spec.command, args: [...spec.args], env: out }
}

/** The name a server is handed under, and the agent's own servers it stands in for. */
interface Handed {
  name: string
  replaces?: string[]
}

/** A command as the agent runs it, for a server handed straight to it. */
function direct(
  server: MarketServer,
  handed: Handed,
  keys: MarketKeys,
  platform: Platform,
  node: NodeRuntime | undefined,
  env: Env | undefined,
): McpServer | null {
  const { spec } = server
  if (spec.type !== 'stdio') return null
  const values = filled(spec.env, keys.get(server.id), env && { env, platform })
  if (!values) return null
  const runtime = spec.runtime === 'node' ? node : undefined
  const [command, args] = runtime
    ? [runtime.command, spec.args]
    : program(spec.command, spec.args, platform)
  const runtimeEnv = Object.entries(runtime?.env ?? {}).map(([key, value]) => ({
    name: key,
    value,
  }))
  return {
    type: 'stdio',
    ...handed,
    command,
    args,
    env: [...runtimeEnv, ...values.values],
    ...(values.secret ? { secret: true } : {}),
  }
}

/** Whether a server can run with what the host has: its required inputs set, its runtime there. */
function runnable(server: MarketServer, keys: MarketKeys, node: NodeRuntime | undefined): boolean {
  const { spec } = server
  if (spec.type === 'stdio' && spec.runtime === 'node' && !node) return false
  return filled(spec.type === 'http' ? spec.headers : spec.env, keys.get(server.id)) !== null
}

/** A server the agent's own configuration sets up, by where it connects or what it starts. */
export interface OwnServer {
  name: string
  endpoint: McpEndpoint
}

/** The library server a bridge entry connects to, or null for any other entry. */
function bridgeTarget(endpoint: McpEndpoint): string | null {
  if (endpoint.type !== 'stdio' || !isBridgeSpec(endpoint)) return null
  return endpoint.args[2] ?? null
}

/** Where a library server connects or what it starts, as its fingerprint compares it. */
export function endpointOf(spec: McpSpec): McpEndpoint {
  return spec.type === 'stdio'
    ? { type: 'stdio', command: spec.command, args: spec.args }
    : { type: spec.transport === 'sse' ? 'sse' : 'http', url: spec.url }
}

/**
 * The servers among `servers` that go to `agentId`, as its sessions get them. Each goes through
 * the router: by its path to an agent that speaks HTTP, by the bridge to one that speaks only
 * stdio. A command set to run by each agent goes to it directly, as does any command when there
 * is no bridge for a stdio-only agent, which `fellBack` hears of. A server whose required input
 * has no value is left out, as is one that signs in while it is not connected; one whose name
 * another server already has, such as Kettu's own, gets a number after it. For an agent that
 * merges same-name servers, the agent's own copy of a server, or its server of the same name, is
 * turned off for the session instead, and Kettu's goes under a name its configuration lacks.
 */
export function libraryServers(
  servers: readonly MarketServer[],
  keys: MarketKeys,
  agentId: AgentId,
  transports: McpTransports,
  options: {
    platform: Platform
    env?: Env
    taken?: readonly string[]
    oauth?: OAuthAccess
    router?: RouterAccess | null
    /** The bridge program, when this build has one. */
    bridge?: string | null
    /** Kettu's own Node.js, for the servers that run on it. */
    node?: NodeRuntime
    /**
     * For an agent that drops tools: the tools each server listed last, null when unknown, which
     * decide what is declared and what goes behind the gateway.
     */
    gateway?: { known(server: MarketServer): readonly unknown[] | null }
    /** Servers a workflow step names, by name or id, which its session gets while they are on. */
    also?: readonly string[]
    fellBack?(server: MarketServer, why: string): void
    /**
     * The servers the agent's own configuration sets up, which an entry of the same name
     * replaces.
     */
    own?: readonly OwnServer[]
    /**
     * Servers declared by untrusted project files (such as `.mcp.json`): never used to rename a
     * library server, only matched by fingerprint so duplicates can be suppressed.
     */
    projectOwn?: readonly OwnServer[]
    /** The agent's own server of that name is another server, which Kettu's entry replaces. */
    conflict?(server: MarketServer, own: string): void
    /** The session's project, which a server set to some projects only goes to when it names. */
    project?: string
    /** Each server handed, under the name the agent knows it by and how it reaches it. */
    handed?(server: MarketServer, name: string, how: 'router' | 'agent' | 'gateway'): void
  },
): McpServer[] {
  const used = new Set(options.taken ?? [])
  const out: McpServer[] = []
  const allowed: string[] = []
  const own = options.own ?? []
  const projectOwn = options.projectOwn ?? []
  const ownNames = new Set(own.map((item) => item.name))
  const projectNames = new Set(projectOwn.map((item) => item.name))
  const nameOf = (server: MarketServer): Handed => {
    const print = mcpFingerprint(endpointOf(server.spec))
    // An entry Kettu wrote for the agent's terminal runs the bridge to this very server.
    const isIt = (item: OwnServer): boolean =>
      mcpFingerprint(item.endpoint) === print || bridgeTarget(item.endpoint) === server.name
    if (transports.mcpMergesSameName) {
      const replaces = [
        ...new Set(
          [...own, ...projectOwn]
            .filter((item) => item.name === server.name || isIt(item))
            .map((item) => item.name),
        ),
      ]
      const taken = (name: string) => used.has(name) || ownNames.has(name) || projectNames.has(name)
      let name = server.name
      if (taken(name)) name = `${server.name}-kettu`
      for (let n = 2; taken(name); n++) name = `${server.name}-kettu-${n}`
      used.add(name)
      const clash = own.find((item) => item.name === server.name && !isIt(item))
      if (clash) options.conflict?.(server, clash.name)
      return replaces.length > 0 ? { name, replaces } : { name }
    }
    // The same server under another name in the agent's own file is handed under that name, so
    // the agent runs it once, as Kettu's. Prefer the library server's own name when both exist.
    const same =
      own.find((item) => item.name === server.name && isIt(item) && !used.has(item.name)) ??
      own.find((item) => isIt(item) && !used.has(item.name))
    let name = same?.name ?? server.name
    for (let n = 2; used.has(name); n++) name = `${server.name}-${n}`
    used.add(name)
    const clash = own.find((item) => item.name === name && !isIt(item))
    if (clash) options.conflict?.(server, clash.name)
    // Additional copies of the same server under other names (such as a second alias in the
    // agent's config or a project `.mcp.json` entry) cannot be shadowed by `name` alone.
    const replaces = [
      ...new Set(
        [...own, ...projectOwn]
          .filter((item) => item.name !== name && !used.has(item.name) && isIt(item))
          .map((item) => item.name),
      ),
    ]
    return replaces.length > 0 ? { name, replaces } : { name }
  }
  const router = options.router ?? null
  const gated: string[] = []
  let declared = 0
  for (const server of servers) {
    const named = options.also?.includes(server.name) || options.also?.includes(server.id)
    if (!serverFor(server, agentId) && !(server.on && named)) continue
    if (
      options.project !== undefined &&
      !named &&
      !servedInProject(server.projects, options.project)
    )
      continue
    const { spec } = server
    if (!runnable(server, keys, options.node)) continue
    if (spec.type === 'http' && spec.oauth && options.oauth?.access(server) === null) continue
    const byAgent = spec.type === 'stdio' && runOf(server).mode === 'agent'
    if (byAgent || !router) {
      if (spec.type !== 'stdio' || !transports.mcpStdio) continue
      const entry = direct(
        server,
        nameOf(server),
        keys,
        options.platform,
        options.node,
        options.env,
      )
      if (entry) {
        out.push(entry)
        options.handed?.(server, entry.name, 'agent')
      }
      continue
    }
    if (options.gateway && router.gate) {
      const known = options.gateway.known(server)
      const bytes = known === null ? Infinity : JSON.stringify(known).length
      if (bytes > GATED_SERVER_BYTES || declared + bytes > DECLARED_LIBRARY_BYTES) {
        gated.push(server.id)
        options.handed?.(server, server.name, 'gateway')
        continue
      }
      declared += bytes
    }
    if (transports.mcpHttp) {
      const entryName = nameOf(server)
      options.handed?.(server, entryName.name, 'router')
      out.push({
        type: 'http',
        ...entryName,
        url: `${router.origin}${serverPath(server.id)}`,
        headers: [{ name: 'Authorization', value: `Bearer ${router.token}` }],
        secret: true,
      })
      allowed.push(server.id)
      continue
    }
    if (!transports.mcpStdio) continue
    if (!options.bridge) {
      if (spec.type === 'stdio') {
        const entry = direct(
          server,
          nameOf(server),
          keys,
          options.platform,
          options.node,
          options.env,
        )
        if (entry) {
          out.push(entry)
          options.handed?.(server, entry.name, 'agent')
        }
        options.fellBack?.(server, 'this build has no bridge, so the agent runs it itself')
      } else {
        options.fellBack?.(
          server,
          'this build has no bridge, so a stdio-only agent cannot reach it',
        )
      }
      continue
    }
    const entryName = nameOf(server)
    options.handed?.(server, entryName.name, 'router')
    out.push({
      type: 'stdio',
      ...entryName,
      command: options.bridge,
      args: ['mcp', 'connect', server.name, '--agent', agentId],
      env: [
        { name: BRIDGE_ENV.url, value: router.origin },
        { name: BRIDGE_ENV.token, value: router.token },
      ],
      secret: true,
    })
    allowed.push(server.id)
  }
  if (router && allowed.length > 0) router.allow(allowed)
  if (router?.gate && gated.length > 0) router.gate(gated)
  return out
}
