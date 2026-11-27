import { createHash, randomUUID } from 'node:crypto'
import { constants, watch, type FSWatcher } from 'node:fs'
import { lstat, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { MARKET_NAME, type MarketServer } from '@shared/marketplace'
import { mcpFingerprint } from '@shared/mcp-fingerprint'
import { endpointOf, type OwnServer } from './servers'
import { JsonFile, type LogFn } from '../storage'
import { isBridgeSpec } from './mcp-terminal-files'
import type {
  McpDiscovery,
  McpDiscoveryRow,
  McpDiscoverySource,
  McpImportChoice,
} from '@shared/mcp-discovery'
import {
  importedServer,
  parseMcpConfig,
  type ConfiguredMcp,
  type McpConfigFile,
} from './mcp-config'

const MAX_CONFIG_BYTES = 2 * 1024 * 1024

export async function readMcpConfig(
  file: McpConfigFile,
): Promise<ReturnType<typeof parseMcpConfig> | null> {
  const { path, app, agentId, project } = file
  const source = { path, app, agentId, project }
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) return { servers: [], error: { source, reason: 'not-file' } }
      if (stat.size > MAX_CONFIG_BYTES)
        return { servers: [], error: { source, reason: 'too-large' } }
      const buffer = Buffer.alloc(stat.size + 1)
      const { bytesRead } = await handle.read(buffer)
      if (bytesRead > stat.size) return { servers: [], error: { source, reason: 'unreadable' } }
      return parseMcpConfig(buffer.subarray(0, bytesRead).toString('utf8'), file)
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      const entry = await lstat(path).catch(() => null)
      if (!entry) return null
    }
    return {
      servers: [],
      error: {
        source,
        reason: code === 'EACCES' || code === 'EPERM' ? 'permission' : 'unreadable',
      },
    }
  }
}

async function readMcpConfigs(files: readonly McpConfigFile[]) {
  const configured: ConfiguredMcp[] = []
  const errors: McpDiscovery['errors'] = []
  const firstFound = new Set<string>()
  for (const file of files) {
    if (file.firstOf && firstFound.has(file.firstOf)) continue
    const result = await readMcpConfig(file)
    if (!result) continue
    if (file.firstOf) firstFound.add(file.firstOf)
    configured.push(...result.servers)
    if (result.error) errors.push(result.error)
  }

  return { configured, errors }
}

export async function readOwnMcpServers(files: readonly McpConfigFile[]): Promise<OwnServer[]> {
  const { configured } = await readMcpConfigs(
    files.map((file) => ({ ...file, respectProjectDisabled: true })),
  )
  const entries = new Map<string, OwnServer>()
  for (const { name, spec } of configured) entries.set(name, { name, endpoint: endpointOf(spec) })
  return [...entries.values()]
}

interface Discovered {
  row: McpDiscoveryRow
  endpoints: Map<string, ConfiguredMcp>
  fingerprint: string
}

function key(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function keyDifferences(endpoints: readonly ConfiguredMcp[]): string[] {
  const names = new Set(endpoints.flatMap(({ secrets }) => Object.keys(secrets)))
  return [...names].filter(
    (name) => new Set(endpoints.map(({ secrets }) => secrets[name])).size > 1,
  )
}

function safeName(name: string): string {
  return name.trim().toLowerCase()
}

export function collectMcpServers(configured: readonly ConfiguredMcp[]): Discovered[] {
  const groups = new Map<string, ConfiguredMcp[]>()
  for (const server of configured) {
    const fingerprint = key(mcpFingerprint(server.spec))
    const group = groups.get(fingerprint) ?? []
    group.push(server)
    groups.set(fingerprint, group)
  }
  return [...groups].map(([fingerprint, servers]) => {
    const primary = servers[0]!
    const endpoints = new Map<string, ConfiguredMcp>()
    const sources: McpDiscoverySource[] = []
    for (const server of servers) {
      const sourceKey = key([server.source, server.name])
      if (endpoints.has(sourceKey)) continue
      endpoints.set(sourceKey, server)
      sources.push({
        ...server.source,
        name: server.name,
        id: sourceKey,
        keys: Object.keys(server.secrets),
        spec: server.spec,
      })
    }
    const differentKeys = keyDifferences([...endpoints.values()])
    return {
      endpoints,
      fingerprint,
      row: {
        id: randomUUID(),
        name: primary.name,
        spec: primary.spec,
        sources,
        differentKeys,
        existing: [],
        nameConflict: false,
        isNew: false,
      },
    }
  })
}

function sameEndpoints(before: Discovered, after: Discovered): boolean {
  return JSON.stringify([...before.endpoints]) === JSON.stringify([...after.endpoints])
}

export interface PreparedMcpImport {
  server: MarketServer
  secrets: Record<string, string>
  project?: string
}

interface SeenMcpFile {
  version: 1
  fingerprints: string[]
}

const MAX_SEEN = 2000

export function seenMcpFile(dataPath: string, log: LogFn): JsonFile<SeenMcpFile> {
  return new JsonFile<SeenMcpFile>({
    file: path.join(dataPath, 'state', 'mcp-discovery.json'),
    version: 1,
    migrations: {},
    log,
    empty: () => ({ version: 1, fingerprints: [] }),
    parse: ({ fingerprints }) =>
      Array.isArray(fingerprints) &&
      fingerprints.length <= MAX_SEEN &&
      fingerprints.every((id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id))
        ? { version: 1, fingerprints }
        : 'invalid fingerprints',
  })
}

export class McpDiscoveryService {
  private active: Promise<McpDiscovery> | undefined
  private groups = new Map<string, Discovered>()
  private known = new Set<string>()
  private loaded = false
  private fresh = new Set<string>()
  private notice: string | null = null
  private watches = new Map<string, { files: Set<string>; watch: FSWatcher }>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly deps: {
      files(): McpConfigFile[]
      seen?: JsonFile<SeenMcpFile>
      library(): readonly MarketServer[]
      changed(): void
    },
  ) {}

  scan(): Promise<McpDiscovery> {
    this.active ??= this.read().finally(() => {
      this.active = undefined
    })
    return this.active
  }

  dismiss(notice: string): void {
    if (this.notice !== notice) return
    this.notice = null
    this.fresh.clear()
    this.deps.changed()
  }

  prepare(choices: readonly McpImportChoice[]): PreparedMcpImport[] {
    const library = this.deps.library()
    const byId = new Map([...this.groups.values()].map((group) => [group.row.id, group]))
    const names = new Set(library.map(({ name }) => safeName(name)))
    const used = new Set<string>()
    return choices.map((choice) => {
      const group = byId.get(choice.id)
      if (!group)
        throw new Error('The MCP configuration changed. Review it again before importing.')
      const name = choice.name.trim()
      if (!MARKET_NAME.test(name) || name === 'kettu' || names.has(safeName(name))) {
        throw new Error('Choose an available MCP server name.')
      }
      const selection = choice.sourceId && group.endpoints.get(choice.sourceId)
      if ((choice.sourceId || group.row.differentKeys.length > 0 || choice.another) && !selection) {
        throw new Error('Choose which configuration to import.')
      }
      const source = selection || group.endpoints.values().next().value!
      const endpointId = [...group.endpoints].find(([, endpoint]) => endpoint === source)![0]
      const variant = group.row.id + ':' + endpointId
      if (used.has(variant)) throw new Error('Import each source only once.')
      const exists = library.some((entry) => key(mcpFingerprint(entry.spec)) === group.fingerprint)
      if (
        (exists || [...used].some((entry) => entry.startsWith(group.row.id + ':'))) &&
        (!choice.another || group.row.differentKeys.length === 0)
      ) {
        throw new Error('This MCP server is already in your library.')
      }
      const origins = [...group.endpoints.values()].map(({ source }) => source)
      if (
        exists &&
        library.some(
          (entry) => JSON.stringify(entry.importedWith) === JSON.stringify(source.source),
        )
      )
        throw new Error('This configuration is already in your library.')
      names.add(safeName(name))
      used.add(variant)
      return {
        server: {
          ...importedServer('manual:' + randomUUID(), source, name, choice.agents, origins),
          ...(group.row.differentKeys.length > 0 ? { importedWith: source.source } : {}),
        },
        secrets: source.secrets,
        project: source.source.project,
      }
    })
  }

  stop(): void {
    clearTimeout(this.timer)
    for (const { watch } of this.watches.values()) watch.close()
    this.watches.clear()
  }

  async flush(): Promise<void> {
    await this.deps.seen?.flush()
  }

  private async read(): Promise<McpDiscovery> {
    if (!this.loaded) {
      const seen = await this.deps.seen?.load().catch(() => undefined)
      this.known = new Set(seen?.fingerprints ?? [])
      this.loaded = true
    }
    let learned = false
    const files = this.deps.files()
    await this.watchFiles(files)
    const read = await readMcpConfigs(files)
    // Kettu's own entries, written for an agent's terminal, are the library's already.
    const configured = read.configured.filter(({ spec }) => !isBridgeSpec(spec))
    const errors = read.errors

    const library = this.deps.library()
    const fingerprints = new Map<string, string[]>()
    const names = new Set(library.map(({ name }) => safeName(name)))
    for (const server of library) {
      const fingerprint = key(mcpFingerprint(server.spec))
      const kept = fingerprints.get(fingerprint) ?? []
      kept.push(server.id)
      fingerprints.set(fingerprint, kept)
    }
    const current = new Map<string, Discovered>()
    const servers = collectMcpServers(configured).map((group) => {
      const { row, fingerprint } = group
      const before = this.groups.get(fingerprint)
      if (before && sameEndpoints(before, group)) row.id = before.row.id
      row.existing = fingerprints.get(fingerprint) ?? []
      for (const source of row.sources) {
        const configured = group.endpoints.get(source.id)
        source.imported = library.some(
          (entry) =>
            row.existing.includes(entry.id) &&
            JSON.stringify(entry.importedWith) === JSON.stringify(configured?.source),
        )
      }
      row.nameConflict =
        names.has(safeName(row.name)) || !MARKET_NAME.test(row.name) || row.name === 'kettu'
      if (!this.known.has(fingerprint) && row.existing.length === 0) {
        this.fresh.add(fingerprint)
        this.notice = randomUUID()
      }
      if (!this.known.has(fingerprint)) learned = true
      this.known.add(fingerprint)
      row.isNew = this.fresh.has(fingerprint) && row.existing.length === 0
      current.set(fingerprint, group)
      return row
    })
    this.groups = current
    if (learned) {
      this.known = new Set([...this.known].slice(-MAX_SEEN))
      this.deps.seen?.save({ version: 1, fingerprints: [...this.known] })
    }
    return { servers, errors, notice: servers.some(({ isNew }) => isNew) ? this.notice : null }
  }

  private async watchFiles(files: readonly McpConfigFile[]): Promise<void> {
    const wanted = new Map<string, Set<string>>()
    const found = new Map<string, boolean>()
    for (const file of files) {
      let entry = file.path
      let folder = path.dirname(entry)
      for (;;) {
        let exists = found.get(folder)
        if (exists === undefined) {
          exists = await stat(folder).then(
            (info) => info.isDirectory(),
            () => false,
          )
          found.set(folder, exists)
        }
        if (exists || folder === entry) break
        entry = folder
        folder = path.dirname(folder)
      }
      const names = wanted.get(folder) ?? new Set()
      names.add(path.basename(entry))
      wanted.set(folder, names)
    }
    for (const [folder, entry] of this.watches) {
      if (wanted.has(folder)) continue
      entry.watch.close()
      this.watches.delete(folder)
    }
    for (const [folder, names] of wanted) {
      const existing = this.watches.get(folder)
      if (existing) {
        existing.files = names
        continue
      }
      try {
        const watcher = watch(folder, { persistent: false }, (_event, name) => {
          const current = this.watches.get(folder)
          if (name !== null && !current?.files.has(name.toString())) return
          clearTimeout(this.timer)
          this.timer = setTimeout(() => this.deps.changed(), 150)
          this.timer.unref()
        })
        this.watches.set(folder, { files: names, watch: watcher })
        watcher.on('error', () => {
          watcher.close()
          if (this.watches.get(folder)?.watch === watcher) this.watches.delete(folder)
        })
      } catch {
        // Read failures are reported by the scan even when the folder cannot be watched.
      }
    }
  }
}
