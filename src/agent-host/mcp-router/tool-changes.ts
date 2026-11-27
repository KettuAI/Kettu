// The tool definitions each library server's user accepted, and what the server lists now. A
// server that changes a tool's description or parameters after it was added, or lists a new one,
// could steer an agent before the user sees it, so for a server from an untrusted source the
// router holds such tools back until the user accepts them. The first list Kettu sees of a server,
// on adding it or after an upgrade, counts as accepted. Kept in the host's state, one entry per
// server, removed with the server.

import { createHash } from 'node:crypto'
import path from 'node:path'
import { runOf, type MarketServer } from '@shared/marketplace'
import type {
  McpToolChanges,
  McpToolDefinition,
  McpToolDiff,
  McpToolGuard,
} from '@shared/mcp-insight'
import { JsonFile, type LogFn } from '../storage'
import { isRecord } from './jsonrpc'

export interface ServerTools {
  /** The definitions the user accepted, by name. */
  accepted: Record<string, McpToolDefinition>
  /** The definitions the server listed last, by name. */
  latest: Record<string, McpToolDefinition>
  /** When the server first listed something not accepted, while it still does. */
  since: number | null
}

export interface ToolsFile {
  version: 1
  servers: Record<string, ServerTools>
}

/** How the server's tools were seen: a full list, or a later page of one the router passed on. */
export type Sighting = 'list' | 'page'

/** How the id of a folder's own server starts, which the host registers as a session attaches. */
export const PROJECT_SERVER = 'project:'

export const MAX_TOOL_SERVERS = 500
export const MAX_SERVER_TOOLS = 2_000
/** The most read back of one server, as JSON. */
export const MAX_TOOLS_BYTES = 8 * 1024 * 1024

const REGISTRY_ID = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'uvx', 'pnpx'])
const EXACT_NPM = /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/i
const EXACT_PYPI = /^[A-Za-z0-9._-]+==\d+(?:\.\d+)*(?:[-+.][0-9A-Za-z.-]+)?$/

/**
 * Whether a plugin's server runs a fixed version: a program inside the plugin's own folder, which
 * changes only with the plugin, or a package pinned to one exact version.
 */
export function pinnedPluginServer(server: MarketServer): boolean {
  if (server.source !== 'plugin' || server.spec.type !== 'stdio') return false
  const { command, args, env } = server.spec
  const root = env.find((value) => value.name === 'PLUGIN_ROOT')
  if (root && 'value' in root && root.value) {
    const inside = path.relative(root.value, command)
    if (path.isAbsolute(command) && inside !== '' && !inside.startsWith('..')) return true
  }
  const runner = path.basename(command).replace(/\.(cmd|exe)$/i, '')
  if (!PACKAGE_RUNNERS.has(runner)) return false
  const target = args.find((arg) => !arg.startsWith('-'))
  return target !== undefined && (EXACT_NPM.test(target) || EXACT_PYPI.test(target))
}

/**
 * What a change of a server's tools does. Only a registry entry, whose namespace the registry
 * verified, and a plugin's pinned server are trusted; community listings, servers added by hand
 * or imported, and projects' servers are held back. One each agent runs itself is out of reach.
 */
export function toolGuard(server: MarketServer): McpToolGuard {
  if (server.spec.type === 'stdio' && runOf(server).mode === 'agent') return 'by-agent'
  return trustedSource(server) ? 'note' : 'hold'
}

export function trustedSource(server: MarketServer): boolean {
  if (server.source === 'registry') return REGISTRY_ID.test(server.id) && !server.importedFrom
  return pinnedPluginServer(server)
}

/** JSON with every object's keys in order, so key order never reads as a change. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = sortKeys(value[key])
  }
  return out
}

/** What a tool's definition is compared by: its description and parameters, keys in order. */
export function toolDigest(tool: McpToolDefinition): string {
  const shape = { description: tool.description ?? '', inputSchema: tool.inputSchema ?? null }
  return createHash('sha256').update(canonicalJson(shape)).digest('hex')
}

/** A listed tool as Kettu keeps it, or null for one without a name. */
export function definitionOf(tool: unknown): McpToolDefinition | null {
  if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name === '') return null
  return {
    name: tool.name,
    ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
  }
}

function definitions(tools: readonly unknown[]): Record<string, McpToolDefinition> {
  const out: Record<string, McpToolDefinition> = {}
  for (const tool of tools.slice(0, MAX_SERVER_TOOLS)) {
    const definition = definitionOf(tool)
    if (definition) out[definition.name] = definition
  }
  return out
}

function readDefinitions(raw: unknown): Record<string, McpToolDefinition> | null {
  if (!isRecord(raw)) return null
  const out: Record<string, McpToolDefinition> = {}
  for (const [name, value] of Object.entries(raw).slice(0, MAX_SERVER_TOOLS)) {
    const definition = definitionOf(value)
    if (!definition || definition.name !== name) return null
    out[name] = definition
  }
  return out
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

/** The file's servers, each dropped on its own when it is not what Kettu wrote. */
export function parseToolsFile(data: Record<string, unknown>): ToolsFile | string {
  if (!isRecord(data.servers)) return 'servers is not an object'
  const servers: ToolsFile['servers'] = {}
  for (const [id, raw] of Object.entries(data.servers).slice(0, MAX_TOOL_SERVERS)) {
    if (!isRecord(raw)) continue
    const accepted = readDefinitions(raw.accepted)
    const latest = readDefinitions(raw.latest)
    const since = raw.since === null || typeof raw.since === 'number' ? raw.since : undefined
    if (!accepted || !latest || since === undefined) continue
    const entry: ServerTools = { accepted, latest, since }
    // Dropping a server would make its next list count as accepted, so one too large to read
    // back keeps nothing accepted instead, and every tool it lists waits for the user.
    servers[id] = bytes(entry) <= MAX_TOOLS_BYTES ? entry : { accepted: {}, latest: {}, since: 0 }
  }
  return { version: 1, servers }
}

export function toolsFile(userDataPath: string, log: LogFn): JsonFile<ToolsFile> {
  return new JsonFile<ToolsFile>({
    file: path.join(userDataPath, 'state', 'mcp-tools.json'),
    version: 1,
    migrations: {},
    parse: parseToolsFile,
    empty: () => ({ version: 1, servers: {} }),
    log,
    compact: true,
  })
}

type Change = 'added' | 'changed'

const digests = new WeakMap<McpToolDefinition, string>()

function digestOf(tool: McpToolDefinition): string {
  let digest = digests.get(tool)
  if (digest === undefined) {
    digest = toolDigest(tool)
    digests.set(tool, digest)
  }
  return digest
}

function changeOf(entry: ServerTools, tool: McpToolDefinition): Change | null {
  const accepted = entry.accepted[tool.name]
  if (!accepted) return 'added'
  return digestOf(accepted) === digestOf(tool) ? null : 'changed'
}

function summaryOf(entry: ServerTools): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = []
  const changed: string[] = []
  for (const tool of Object.values(entry.latest)) {
    const change = changeOf(entry, tool)
    if (change === 'added') added.push(tool.name)
    else if (change === 'changed') changed.push(tool.name)
  }
  const removed = Object.keys(entry.accepted).filter((name) => !entry.latest[name])
  return { added, changed, removed }
}

/** The accepted tools and what each server lists now, in memory and written behind. */
export class ToolChanges {
  private data: ToolsFile = { version: 1, servers: {} }
  /** Servers whose accepted list a listing is filling in page by page. */
  private readonly seeding = new Set<string>()

  constructor(
    private readonly file: JsonFile<ToolsFile> | null,
    private readonly options: {
      /** How a server's tools differ from what was accepted changed: clients and agents hear. */
      changed?(serverId: string): void
      now?: () => number
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  async load(): Promise<void> {
    if (this.file) this.data = await this.file.load()
  }

  /**
   * The server listed `tools`. With nothing accepted yet, they are what is accepted: the list
   * the check sees on adding it, or the first one after an upgrade. A later page of the router's
   * first list adds to it; a later page of any other list adds to what it lists now.
   */
  seen(serverId: string, tools: readonly unknown[], how: Sighting): void {
    const listed = definitions(tools)
    const entry = this.data.servers[serverId]
    if (!entry) {
      if (how === 'page') return
      this.seeding.add(serverId)
      this.put(serverId, { accepted: listed, latest: listed, since: null })
      return
    }
    if (how === 'page' && this.seeding.has(serverId)) {
      const accepted = { ...entry.accepted, ...listed }
      this.put(serverId, { accepted, latest: { ...entry.latest, ...listed }, since: entry.since })
      return
    }
    if (how === 'list') this.seeding.delete(serverId)
    const latest = how === 'page' ? { ...entry.latest, ...listed } : listed
    this.update(serverId, entry, latest)
  }

  private update(serverId: string, entry: ServerTools, latest: ServerTools['latest']): void {
    const before = summaryOf(entry)
    const next: ServerTools = { ...entry, latest }
    const differs = Object.values(latest).some((tool) => changeOf(entry, tool) !== null)
    next.since = differs ? (entry.since ?? this.now()) : null
    if (canonicalJson(next) === canonicalJson(entry)) return
    this.put(serverId, next)
    if (canonicalJson(before) !== canonicalJson(summaryOf(next))) {
      this.options.changed?.(serverId)
    }
  }

  /** How a listed tool differs from what was accepted; null when it does not or nothing was. */
  change(serverId: string, tool: unknown): Change | null {
    const entry = this.data.servers[serverId]
    const definition = definitionOf(tool)
    if (!entry || !definition) return null
    return changeOf(entry, definition)
  }

  /**
   * How a tool an agent calls by name differs, from what the server listed last. A name never
   * listed or accepted counts as new once anything was accepted.
   */
  changeByName(serverId: string, name: string): Change | null {
    const entry = this.data.servers[serverId]
    if (!entry) return null
    const latest = entry.latest[name]
    if (latest) return changeOf(entry, latest)
    return entry.accepted[name] ? null : 'added'
  }

  /** How a server's tools differ from what was accepted, or null when they do not. */
  changes(serverId: string, guard: McpToolGuard): McpToolChanges | null {
    const entry = this.data.servers[serverId]
    if (!entry) return null
    const { added, changed, removed } = summaryOf(entry)
    if (added.length === 0 && changed.length === 0) return null
    return { serverId, guard, added, changed, removed, since: entry.since ?? this.now() }
  }

  /** What the server listed last, or null before Kettu saw it list anything. */
  latest(serverId: string): McpToolDefinition[] | null {
    const entry = this.data.servers[serverId]
    return entry ? Object.values(entry.latest) : null
  }

  /** Each changed tool as accepted and as listed now, for the review window. */
  diff(serverId: string): McpToolDiff[] {
    const entry = this.data.servers[serverId]
    if (!entry) return []
    const out: McpToolDiff[] = []
    for (const tool of Object.values(entry.latest)) {
      const kind = changeOf(entry, tool)
      if (!kind) continue
      out.push({ name: tool.name, kind, before: entry.accepted[tool.name] ?? null, after: tool })
    }
    for (const [name, before] of Object.entries(entry.accepted)) {
      if (!entry.latest[name]) out.push({ name, kind: 'removed', before, after: null })
    }
    return out
  }

  /**
   * The user accepted these tools as the server lists them now; the tools gone from it are
   * forgotten with them. Answers whether anything changed.
   */
  accept(serverId: string, names: readonly string[]): boolean {
    const entry = this.data.servers[serverId]
    if (!entry) return false
    const accepted = { ...entry.accepted }
    let took = false
    for (const name of names) {
      const tool = entry.latest[name]
      const was = accepted[name]
      if (!tool || (was && digestOf(was) === digestOf(tool))) continue
      accepted[name] = tool
      took = true
    }
    for (const name of Object.keys(accepted)) if (!entry.latest[name]) delete accepted[name]
    if (!took && Object.keys(accepted).length === Object.keys(entry.accepted).length) return false
    const next: ServerTools = { accepted, latest: entry.latest, since: entry.since }
    const differs = Object.values(next.latest).some((tool) => changeOf(next, tool) !== null)
    next.since = differs ? entry.since : null
    this.put(serverId, next)
    this.options.changed?.(serverId)
    return true
  }

  /**
   * Only the servers the library still keeps stay, and every folder's own server: the router
   * knows one only once a session in its folder attaches, so its accepted tools outlive a restart.
   * Its id changes with its content, so what was accepted never stands for a changed server.
   */
  keep(serverIds: ReadonlySet<string>): void {
    const gone = Object.keys(this.data.servers).filter(
      (id) => !serverIds.has(id) && !id.startsWith(PROJECT_SERVER),
    )
    if (gone.length === 0) return
    const servers = { ...this.data.servers }
    for (const id of gone) {
      delete servers[id]
      this.seeding.delete(id)
    }
    this.data = { version: 1, servers }
    this.file?.save(this.data)
  }

  async flush(): Promise<void> {
    await this.file?.flush()
  }

  private put(serverId: string, entry: ServerTools): void {
    this.data = { version: 1, servers: { ...this.data.servers, [serverId]: entry } }
    this.file?.save(this.data)
  }
}
