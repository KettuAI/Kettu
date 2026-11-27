// An agent's CLI in a terminal, or an app, using Kettu's MCP library: with the user's consent, per
// agent or app, Kettu imports its own servers, backs its file up and puts one bridge entry per server
// in it.
// It keeps a record of what it wrote, with a digest of each entry, and changes only those keys:
// an entry changed outside Kettu is the user's to decide on and is never written back unasked.
// Backups and the entries an agent had before are sealed with a key kept in the key store, since
// they may hold the keys the file had written in it.

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { AgentId, HarnessId } from '@shared/agents'
import { MARKET_NAME, serverFor, type MarketServer } from '@shared/marketplace'
import { mcpFingerprint } from '@shared/mcp-fingerprint'
import type { McpConfigSource } from '@shared/mcp-discovery'
import {
  MCP_TERMINAL_APPS,
  terminalApp,
  type McpTerminalApp,
  type McpTerminalBackup,
  type McpTerminalChoice,
  type McpTerminalDrift,
  type McpTerminalFileChange,
  type McpTerminalOffPlan,
  type McpTerminalPlan,
  type McpTerminalRow,
  type McpTerminalTarget,
} from '@shared/mcp-terminal'
import { addLogSecret } from '@shared/log/process-log'
import { JsonFile, type LogFn } from '../storage'
import {
  configuredMcp,
  McpConfigError,
  object,
  type ConfiguredMcp,
  type McpConfigFile,
} from './mcp-config'
import {
  bridgeArgs,
  bridgeEntry,
  editKey,
  editServers,
  entryDigest,
  isBridgeEntry,
  maskedServers,
  mergeList,
  mergeToolMap,
  parseTerminalText,
  serversAt,
  serversKey,
  terminalFormat,
  valueAt,
  type BridgeLaunch,
  type EntryEdit,
  type TerminalFormat,
} from './mcp-terminal-files'
import { endpointOf } from './servers'

type Dictionary = Record<string, unknown>

/** Backups kept per agent besides the one from before the takeover. */
const MAX_BACKUPS = 20
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
/** Claude Code treats its config lock as stale past this, as proper-lockfile does by default. */
const CLAUDE_LOCK_STALE_MS = 10_000
const CLAUDE_LOCK_WAIT_MS = 5_000

/** An agent, or an app installed on this computer, whose file a takeover changes. */
export type TerminalOwner =
  | { id: AgentId; harness: HarnessId; app: null; folder: string | null }
  | { id: `app:${McpTerminalApp}`; harness: null; app: McpTerminalApp; folder: null }

/**
 * Whether a library server goes into an owner's file: an app gets only the servers for every
 * agent, since it is no agent the user could give one to.
 */
export function terminalGets(server: MarketServer, target: McpTerminalTarget): boolean {
  return terminalApp(target)
    ? server.on && server.agents === 'all'
    : serverFor(server, target as AgentId)
}

interface Entry {
  serverId: string
  digest: string
}

interface BackupRecord {
  id: string
  at: number
  reason: McpTerminalBackup['reason']
  first: boolean
  /** Each file as it was, by its sealed copy, or null when it did not exist. */
  files: { path: string; blob: string | null }[]
  /** What Kettu's record held then, so restoring the files restores it too. */
  entries: Record<string, Entry>
  tools: string[]
  kept: string[]
  on: boolean
}

interface Target {
  on: boolean
  file: string
  since: number
  entries: Record<string, Entry>
  /** Names the user kept the file's own version of, which Kettu does not write. */
  kept: string[]
  /** What Kettu wrote into the agent's own tool setting. */
  tools: string[]
  /** The sealed copy of the entries Kettu replaced, by name, as they were. */
  originals: string | null
  backups: BackupRecord[]
}

interface Ledger {
  version: 1
  /** By agent id, or `app:<id>` for an app. */
  agents: Record<string, Target>
}

function isRecord(value: unknown): value is Dictionary {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

function isEntries(value: unknown): value is Record<string, Entry> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        isRecord(entry) && typeof entry.serverId === 'string' && typeof entry.digest === 'string',
    )
  )
}

const BLOB = /^[0-9a-f-]{36}$/

function isBackup(value: unknown): value is BackupRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.at === 'number' &&
    ['takeover', 'update', 'apply', 'restore', 'off'].includes(value.reason as string) &&
    typeof value.first === 'boolean' &&
    typeof value.on === 'boolean' &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        typeof file.path === 'string' &&
        (file.blob === null || (typeof file.blob === 'string' && BLOB.test(file.blob))),
    ) &&
    isEntries(value.entries) &&
    strings(value.tools) &&
    strings(value.kept)
  )
}

function isTarget(value: unknown): value is Target {
  return (
    isRecord(value) &&
    typeof value.on === 'boolean' &&
    typeof value.file === 'string' &&
    typeof value.since === 'number' &&
    isEntries(value.entries) &&
    strings(value.kept) &&
    strings(value.tools) &&
    (value.originals === null ||
      (typeof value.originals === 'string' && BLOB.test(value.originals))) &&
    Array.isArray(value.backups) &&
    value.backups.every(isBackup)
  )
}

export function terminalLedgerFile(dataPath: string, log: LogFn): JsonFile<Ledger> {
  return new JsonFile<Ledger>({
    file: path.join(dataPath, 'state', 'mcp-terminal.json'),
    version: 1,
    migrations: {},
    log,
    empty: () => ({ version: 1, agents: {} }),
    parse: ({ agents }) =>
      isRecord(agents) && Object.values(agents).every(isTarget)
        ? { version: 1, agents: agents as Record<string, Target> }
        : 'invalid agents',
  })
}

/** AES-256-GCM with the key store's backup key: what a backup or an original holds stays sealed. */
export function seal(key: Buffer, text: string): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

export function unseal(key: Buffer, sealed: Buffer): string {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('A sealed copy is too short')
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES))
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  return Buffer.concat([
    decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8')
}

/** The backup key from the key store's text, or null when it is not one. */
export function backupKey(text: unknown): Buffer | null {
  if (typeof text !== 'string') return null
  const key = Buffer.from(text, 'base64')
  return key.length === KEY_BYTES ? key : null
}

/** A text file written whole: to its real place when it is a link, keeping its mode. */
async function writeInPlace(file: string, text: string): Promise<void> {
  const target = await realpath(file).catch(() => file)
  const mode = await stat(target).then(
    (info) => info.mode & 0o777,
    () => 0o600,
  )
  await mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.kettu-${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, text, { mode })
    await chmod(temp, mode)
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Claude Code's own lock on its config file: proper-lockfile's, a folder `<file>.lock` made with
 * mkdir and stale after 10 s, as Claude Code 2.1.332 takes it (`lockfilePath: <file>.lock`,
 * `realpath: false`) around each save of `~/.claude.json`.
 */
export async function withClaudeLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`
  const until = Date.now() + CLAUDE_LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const held = await stat(lock).catch(() => null)
      if (held && Date.now() - held.mtimeMs > CLAUDE_LOCK_STALE_MS) {
        await rmdir(lock).catch(() => {})
        continue
      }
      if (Date.now() > until) {
        throw new Error('Claude Code is writing its file; try again', { cause: error })
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  try {
    return await run()
  } finally {
    await rmdir(lock).catch(() => {})
  }
}

/** What an entry runs or connects to, for the dialogs; values written in it masked. */
function describe(configured: ConfiguredMcp | null, raw: unknown): string {
  const spec = configured?.spec
  if (!spec) {
    const entry = object(raw)
    return typeof entry?.url === 'string' ? entry.url : ''
  }
  if (spec.type === 'http') return spec.url
  const secrets = Object.values(configured.secrets)
  const words = [spec.command, ...spec.args].map((word) =>
    secrets.reduce((text, secret) => (secret ? text.split(secret).join('••••') : text), word),
  )
  return words.join(' ')
}

function parsed(name: string, raw: unknown, source: McpConfigSource): ConfiguredMcp | null {
  try {
    return configuredMcp(name, raw, source)
  } catch {
    return null
  }
}

const fingerprintOf = (server: MarketServer): string => mcpFingerprint(endpointOf(server.spec))

/** A name the library takes for an entry of the agent's own: its own name where it is free. */
export function importName(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 40)
  if (!base) base = 'server'
  const free = (candidate: string) =>
    MARKET_NAME.test(candidate) && candidate !== 'kettu' && !taken.has(candidate)
  if (free(base)) return base
  for (let n = 2; ; n++) if (free(`${base}-${n}`)) return `${base}-${n}`
}

/** How Claude Code names a server's tools in a permission rule. */
function claudeRule(entry: string, tool: string): string {
  return `mcp__${entry.replace(/[^a-zA-Z0-9_-]/g, '_')}__${tool}`
}

export interface McpTerminalDeps {
  dataPath: string
  log: LogFn
  ledger: JsonFile<Ledger>
  library(): readonly MarketServer[]
  /** The agents on this computer, then the apps installed on it. */
  owners(): Promise<readonly TerminalOwner[]>
  /** The agent's or app's own user-level MCP files, as discovery reads them. */
  files(target: McpTerminalTarget): McpConfigFile[]
  /** Claude Code's settings file for this agent, where turned-off tools are denied. */
  claudeSettings(agentId: AgentId): string
  /** How an entry starts the bridge, or null when this build has none. */
  launch(): BridgeLaunch | null
  /** The data folder the bridge is told of, when it is not the one it finds by itself. */
  dataArg(): string | null
  /** The key store's backup key, or null when it cannot keep one now. */
  key(): Buffer | null
  /**
   * Imports these entries of the file into the library, for this agent or, for an app, for every
   * agent, and waits for it.
   */
  importOwn(
    target: McpTerminalTarget,
    items: readonly { source: McpConfigSource; name: string }[],
  ): Promise<void>
  /** Gives library servers to this agent too, and waits for the library to say so. */
  giveTo(agentId: AgentId, serverIds: readonly string[]): Promise<void>
  changed(): void
}

/** One read of an agent's or app's file, with what Kettu's record makes of it. */
interface Reading {
  owner: TerminalOwner
  file: McpConfigFile
  format: TerminalFormat
  text: string
  existed: boolean
  config: Dictionary
  container: string[]
  servers: Dictionary
}

/** The tool setting a harness has outside the entries. */
interface ToolSetting {
  file: string
  key: string[]
  kind: 'list' | 'map'
  item(entry: string, tool: string): string
}

/** Thrown when a plan no longer matches the file, so the user reviews it again. */
export class McpTerminalStale extends Error {}

export class McpTerminal {
  private ledger: Ledger | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: McpTerminalDeps) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  private async load(): Promise<Ledger> {
    this.ledger ??= await this.deps.ledger.load().catch((error: unknown) => {
      this.deps.log('warn', `Could not read the terminal MCP record: ${(error as Error).message}`)
      return { version: 1 as const, agents: {} }
    })
    return this.ledger
  }

  private async save(ledger: Ledger): Promise<void> {
    this.ledger = ledger
    this.deps.ledger.save(ledger)
    await this.deps.ledger.flush()
  }

  /** Whether an agent's terminal uses Kettu's servers now, as the bridge asks on each connect. */
  isOn(targetId: string): boolean {
    return this.ledger?.agents[targetId]?.on === true
  }

  private async owner(target: McpTerminalTarget): Promise<TerminalOwner> {
    const owner = (await this.deps.owners()).find((item) => item.id === target)
    if (!owner) throw new Error('No such agent or app on this computer')
    return owner
  }

  /** The file a target's servers are taken over in: the first that exists, else the first. */
  private async fileOf(target: McpTerminalTarget): Promise<McpConfigFile | null> {
    const files = this.deps.files(target).filter((file) => !file.project)
    for (const file of files) {
      if (
        await stat(file.path).then(
          (info) => info.isFile(),
          () => false,
        )
      )
        return file
    }
    return files[0] ?? null
  }

  private async read(id: McpTerminalTarget, target?: Target): Promise<Reading> {
    const owner = await this.owner(id)
    const file = await this.fileFor(id, target)
    if (!file) throw new McpConfigError('unreadable')
    const format = terminalFormat(file.layout)
    if (!format) throw new McpConfigError('unreadable')
    const read = await readText(file.path)
    const text = read ?? ''
    const config = parseTerminalText(text, format)
    const container = serversKey(config, file.layout)
    if (!container) throw new McpConfigError('invalid-server')
    return {
      owner,
      file,
      format,
      text,
      existed: read !== null,
      config,
      container,
      servers: serversAt(config, container),
    }
  }

  private async fileFor(id: McpTerminalTarget, target?: Target): Promise<McpConfigFile | null> {
    return target
      ? (this.deps.files(id).find((item) => item.path === target.file) ?? (await this.fileOf(id)))
      : await this.fileOf(id)
  }

  /** The tool setting outside the entries; apps have none Kettu writes, so the router filters. */
  private toolSetting(reading: Reading): ToolSetting | null {
    const { owner } = reading
    if (owner.app) return null
    switch (owner.harness) {
      case 'claude-code':
        return {
          file: this.deps.claudeSettings(owner.id),
          key: ['permissions', 'deny'],
          kind: 'list',
          item: claudeRule,
        }
      case 'opencode':
        return {
          file: reading.file.path,
          key: ['tools'],
          kind: 'map',
          item: (entry, tool) => `${entry}_${tool}`,
        }
      default:
        return null
    }
  }

  private source(reading: Reading, name: string): McpConfigSource {
    return sourceIn(reading.owner, reading.file.path, name)
  }

  private entryValue(reading: Reading, launch: BridgeLaunch, server: MarketServer): unknown {
    return this.bridgeValue(reading, launch, server.name, server.toolsOff ?? [])
  }

  private bridgeValue(
    reading: Reading,
    launch: BridgeLaunch,
    name: string,
    toolsOff: readonly string[],
  ): unknown {
    const { owner } = reading
    const args = bridgeArgs(launch, name, owner.id, this.deps.dataArg())
    return bridgeEntry(
      reading.file.layout,
      owner.app ? { app: owner.app } : { harness: owner.harness },
      launch.command,
      args,
      toolsOff,
    )
  }

  /** Entries Kettu wrote that changed or went away outside Kettu, which it leaves alone. */
  private drift(reading: Reading, target: Target): McpTerminalDrift[] {
    const out: McpTerminalDrift[] = []
    for (const [name, entry] of Object.entries(target.entries)) {
      if (!(name in reading.servers)) {
        out.push({ name, kind: 'removed' })
        continue
      }
      const raw = reading.servers[name]
      if (entryDigest(raw) === entry.digest) continue
      const configured = parsed(name, raw, this.source(reading, name))
      out.push({
        name,
        kind: 'changed',
        command: describe(configured, raw),
        ...(configured && Object.keys(configured.secrets).length > 0 ? { keys: true } : {}),
      })
    }
    return out
  }

  /**
   * What Kettu's entries should be now: each server for the agent once, under the name its entry
   * has, an entry of the agent's own that is the same server replaced, the one an entry replaced
   * put back once its server no longer goes here, and no entry the user kept or changed outside
   * Kettu touched.
   */
  private compute(
    reading: Reading,
    target: Target,
    launch: BridgeLaunch,
    force: ReadonlySet<string> = new Set(),
    originals: Dictionary = {},
  ): {
    edits: EntryEdit[]
    entries: Record<string, Entry>
    replaced: Dictionary
    restored: string[]
  } {
    const given = this.deps.library().filter((server) => terminalGets(server, reading.owner.id))
    const byId = new Map(given.map((server) => [server.id, server]))
    const drifted = new Set(
      this.drift(reading, target)
        .map(({ name }) => name)
        .filter((name) => !force.has(name)),
    )
    const kept = new Set(target.kept)
    const edits: EntryEdit[] = []
    const entries: Record<string, Entry> = {}
    const replaced: Dictionary = {}
    const restored: string[] = []
    const placed = new Set<string>()
    const place = (name: string, server: MarketServer, current: unknown): void => {
      const value = this.entryValue(reading, launch, server)
      const digest = entryDigest(value)
      if (entryDigest(current) !== digest) edits.push({ name, value })
      entries[name] = { serverId: server.id, digest }
      placed.add(server.id)
    }
    for (const [name, entry] of Object.entries(target.entries)) {
      if (!drifted.has(name)) continue
      entries[name] = entry
      placed.add(entry.serverId)
    }
    for (const [name, entry] of Object.entries(target.entries)) {
      if (drifted.has(name)) continue
      const server = byId.get(entry.serverId)
      if (!server && name in originals) {
        // No longer going here: the entry it replaced comes back, as turning it off would do.
        edits.push({ name, value: originals[name] })
        restored.push(name)
        continue
      }
      if (!server || placed.has(server.id) || kept.has(name)) {
        if (name in reading.servers) edits.push({ name, value: undefined })
        continue
      }
      place(name, server, reading.servers[name])
    }
    for (const [name, raw] of Object.entries(reading.servers)) {
      if (name in target.entries || kept.has(name)) continue
      if (isBridgeEntry(raw)) {
        // Kettu's own entry from a write its record missed: it is taken back as Kettu's.
        const entry = object(raw)
        const words = Array.isArray(entry?.command)
          ? (entry.command as unknown[]).slice(1)
          : Array.isArray(entry?.args)
            ? (entry.args as unknown[])
            : []
        const server = given.find(
          (item) =>
            !placed.has(item.id) &&
            words[2] === item.name &&
            words[words.indexOf('--agent') + 1] === reading.owner.id,
        )
        if (server) place(name, server, raw)
        continue
      }
      const configured = parsed(name, raw, this.source(reading, name))
      if (!configured) continue
      const print = mcpFingerprint(endpointOf(configured.spec))
      const server = given.find((item) => !placed.has(item.id) && fingerprintOf(item) === print)
      if (!server) continue
      replaced[name] = raw
      place(name, server, raw)
    }
    for (const server of given) {
      if (placed.has(server.id)) continue
      if (server.name in reading.servers || kept.has(server.name)) continue
      place(server.name, server, undefined)
    }
    return { edits, entries, replaced, restored }
  }

  private toolItems(setting: ToolSetting, entries: Record<string, Entry>): string[] {
    const library = new Map(this.deps.library().map((server) => [server.id, server]))
    return Object.entries(entries).flatMap(([name, entry]) =>
      (library.get(entry.serverId)?.toolsOff ?? []).map((tool) => setting.item(name, tool)),
    )
  }

  /** The tool setting's file with Kettu's items set to `ours`, or null when nothing changes. */
  private async toolEdit(
    setting: ToolSetting,
    previous: readonly string[],
    ours: readonly string[],
    text?: string,
  ): Promise<{ text: string; before: string; existed: boolean } | null> {
    const read = text ?? (await readText(setting.file))
    const before = read ?? ''
    const config = parseTerminalText(before, 'json')
    const current = valueAt(config, setting.key)
    const next =
      setting.kind === 'list'
        ? mergeList(current, previous, ours)
        : mergeToolMap(current, previous, ours)
    if (next === null) return null
    const value =
      setting.kind === 'list' && next.length === 0 && Array.isArray(current) && current.length === 0
        ? undefined
        : next
    return { text: editKey(before, setting.key, value), before, existed: read !== null }
  }

  private async sealText(text: string): Promise<string> {
    const key = this.deps.key()
    if (!key) throw new Error('Kettu cannot keep a sealed backup on this computer now')
    const id = randomUUID()
    const folder = path.join(this.deps.dataPath, 'mcp-terminal')
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeFile(path.join(folder, `${id}.bin`), seal(key, text), { mode: 0o600 })
    return id
  }

  private async unsealText(id: string): Promise<string> {
    const key = this.deps.key()
    if (!key) throw new Error('Kettu cannot open its sealed backups on this computer now')
    return unseal(key, await readFile(path.join(this.deps.dataPath, 'mcp-terminal', `${id}.bin`)))
  }

  private async dropBlob(id: string | null): Promise<void> {
    if (!id) return
    await rm(path.join(this.deps.dataPath, 'mcp-terminal', `${id}.bin`), { force: true })
  }

  private async originals(target: Target): Promise<Dictionary> {
    if (!target.originals) return {}
    const value: unknown = JSON.parse(await this.unsealText(target.originals))
    return isRecord(value) ? value : {}
  }

  /**
   * Writes the files after a backup of each, the record after them: a write the record missed is
   * found again by its bridge entry, while a record of a write that never happened would read as
   * entries removed outside Kettu.
   */
  private async write(
    targetId: McpTerminalTarget,
    target: Target,
    reason: McpTerminalBackup['reason'],
    writes: { path: string; before: string; existed: boolean; text: string; claude: boolean }[],
    next: Target,
  ): Promise<void> {
    const ledger = await this.load()
    if (writes.length > 0) {
      const files: BackupRecord['files'] = []
      for (const item of writes) {
        files.push({
          path: item.path,
          blob: item.existed ? await this.sealText(item.before) : null,
        })
      }
      const record: BackupRecord = {
        id: randomUUID(),
        at: Date.now(),
        reason,
        first: reason === 'takeover',
        files,
        entries: target.entries,
        tools: target.tools,
        kept: target.kept,
        on: target.on,
      }
      try {
        for (const item of writes) {
          const put = () => writeInPlace(item.path, item.text)
          await (item.claude ? withClaudeLock(item.path, put) : put())
        }
      } catch (error) {
        for (const file of files) await this.dropBlob(file.blob)
        throw error
      }
      const backups = [...next.backups, record]
      const first = backups.filter((backup) => backup.first).slice(-1)
      const rest = backups.filter((backup) => !backup.first)
      const dropped = rest.slice(0, Math.max(0, rest.length - MAX_BACKUPS))
      const kept = [...first, ...rest.slice(dropped.length)]
      for (const old of [...dropped, ...backups.filter((b) => b.first && !first.includes(b))]) {
        for (const file of old.files) await this.dropBlob(file.blob)
      }
      next = { ...next, backups: kept }
    }
    await this.save({ ...ledger, agents: { ...ledger.agents, [targetId]: next } })
  }

  /** Brings an agent's file in line with the library, for a takeover that is on. */
  private async syncOne(
    targetId: McpTerminalTarget,
    force: ReadonlySet<string> = new Set(),
    reason: McpTerminalBackup['reason'] = 'update',
  ): Promise<void> {
    const ledger = await this.load()
    const target = ledger.agents[targetId]
    const launch = this.deps.launch()
    if (!target || !launch) return
    if (!target.on) {
      if (Object.keys(target.entries).length > 0) await this.offNow(targetId, target)
      return
    }
    const reading = await this.read(targetId, target)
    const stored = await this.originals(target)
    const { edits, entries, replaced, restored } = this.compute(
      reading,
      target,
      launch,
      force,
      stored,
    )
    let originals = target.originals
    if (Object.keys(replaced).length > 0 || restored.length > 0) {
      const kept: Dictionary = { ...stored, ...replaced }
      for (const name of restored) delete kept[name]
      originals = Object.keys(kept).length > 0 ? await this.sealText(JSON.stringify(kept)) : null
    }
    const writes: Parameters<McpTerminal['write']>[3] = []
    let text = reading.text
    if (edits.length > 0) {
      text = editServers(reading.text, reading.format, reading.container, edits)
      writes.push({
        path: reading.file.path,
        before: reading.text,
        existed: reading.existed,
        text,
        claude: reading.file.layout === 'claude',
      })
    }
    const setting = this.toolSetting(reading)
    let tools = target.tools
    if (setting) {
      const ours = this.toolItems(setting, entries)
      const same = setting.file === reading.file.path
      const edit = await this.toolEdit(setting, target.tools, ours, same ? text : undefined)
      if (edit) {
        if (same && writes[0]) writes[0].text = edit.text
        else writes.push({ path: setting.file, ...edit, claude: false })
      }
      tools = ours
    }
    const next: Target = { ...target, entries, tools, originals }
    if (writes.length === 0 && entryDigest(next) === entryDigest(target)) return
    try {
      await this.write(targetId, target, reason, writes, next)
    } catch (error) {
      if (originals !== target.originals) await this.dropBlob(originals)
      throw error
    }
    if (originals !== target.originals) await this.dropBlob(target.originals)
  }

  /** Every takeover that is on, brought in line: at start, and whenever the library changes. */
  sync(): Promise<void> {
    return this.run(async () => {
      const ledger = await this.load()
      for (const targetId of Object.keys(ledger.agents)) {
        try {
          await this.syncOne(targetId as McpTerminalTarget)
        } catch (error) {
          this.deps.log(
            'warn',
            `Could not update ${targetId}'s MCP file: ${(error as Error).message}`,
          )
        }
      }
      this.deps.changed()
    })
  }

  /**
   * The rows of Terminal and apps: every agent and installed app on this computer, with what Kettu
   * did. An app reading the same file as an agent before it is that agent's row, not one of its own.
   */
  rows(): Promise<McpTerminalRow[]> {
    return this.run(async () => {
      const ledger = await this.load()
      const rows: McpTerminalRow[] = []
      const byFile = new Map<string, McpTerminalRow>()
      for (const owner of await this.deps.owners()) {
        const target = ledger.agents[owner.id]
        const file = await this.fileFor(owner.id, target)
        if (!file) continue
        const earlier = byFile.get(path.resolve(file.path))
        if (earlier && owner.app && !target) {
          earlier.shared = [...(earlier.shared ?? []), owner.app]
          continue
        }
        const row: McpTerminalRow = {
          target: owner.id,
          file: file.path,
          on: target?.on === true,
          own: 0,
          backedUpAt: target?.backups.length
            ? Math.max(...target.backups.map((backup) => backup.at))
            : null,
          changed: 0,
        }
        if (!terminalFormat(file.layout)) row.unsupported = 'format'
        else if (!this.deps.launch()) row.unsupported = 'no-bridge'
        try {
          if (terminalFormat(file.layout)) {
            const reading = await this.read(owner.id, target)
            row.own = Object.entries(reading.servers).filter(
              ([name, raw]) => !target?.entries[name] && !isBridgeEntry(raw),
            ).length
            if (target) row.changed = this.drift(reading, target).length
          }
        } catch (error) {
          row.error = error instanceof McpConfigError ? error.reason : 'unreadable'
        }
        rows.push(row)
        byFile.set(path.resolve(file.path), row)
      }
      return rows
    })
  }

  /** What turning it on would do, written nowhere yet. */
  plan(targetId: McpTerminalTarget): Promise<McpTerminalPlan> {
    // The agent's own entries stay here: they may hold keys written in the file.
    return this.run(async () => {
      const next = await this.planNow(targetId)
      return {
        target: next.target,
        id: next.id,
        files: next.files,
        imports: next.imports,
        entries: next.entries,
      }
    })
  }

  private async planNow(
    targetId: McpTerminalTarget,
  ): Promise<McpTerminalPlan & { own: Own[]; owner: TerminalOwner }> {
    const launch = this.deps.launch()
    if (!launch) throw new Error('This build has no MCP bridge')
    if (!this.deps.key()) throw new Error('Kettu cannot keep a sealed backup on this computer now')
    const reading = await this.read(targetId)
    await this.notShared(reading)
    const library = this.deps.library()
    const own = this.ownEntries(reading, library)
    const secrets = own.flatMap(({ configured }) => Object.values(configured?.secrets ?? {}))
    // As it will be once the agent's own servers are in the library, for this agent.
    const after: Dictionary = { ...reading.servers }
    const entries: McpTerminalPlan['entries'] = []
    for (const item of own) {
      if (!item.libraryName) continue
      after[item.name] = this.bridgeValue(
        reading,
        launch,
        item.libraryName,
        item.server?.toolsOff ?? [],
      )
      entries.push({ name: item.name, replaces: true })
    }
    const covered = new Set(own.map((item) => item.server?.id).filter(Boolean))
    for (const server of library) {
      if (!terminalGets(server, reading.owner.id) || covered.has(server.id)) continue
      if (server.name in reading.servers) continue
      after[server.name] = this.entryValue(reading, launch, server)
      entries.push({ name: server.name, replaces: false })
    }
    const files: McpTerminalFileChange[] = [
      {
        path: reading.file.path,
        keys: [reading.container.join('.')],
        kind: 'servers',
        before: maskedServers(reading.servers, reading.format, secrets),
        after: maskedServers(after, reading.format, secrets),
      },
    ]
    const setting = this.toolSetting(reading)
    if (setting) {
      const byName = new Map(library.map((server) => [server.name, server]))
      const ours = entries.flatMap(({ name, replaces }) => {
        const server = replaces ? own.find((item) => item.name === name)?.server : byName.get(name)
        return (server?.toolsOff ?? []).map((tool) => setting.item(name, tool))
      })
      if (ours.length > 0) {
        const text = await readText(setting.file)
        const current = valueAt(parseTerminalText(text ?? '', 'json'), setting.key)
        const merged =
          setting.kind === 'list' ? mergeList(current, [], ours) : mergeToolMap(current, [], ours)
        files.push({
          path: setting.file,
          keys: [setting.key.join('.')],
          kind: 'tools',
          tools: ours.length,
          before: JSON.stringify(current ?? null, null, 2),
          after: JSON.stringify(merged ?? current ?? null, null, 2),
        })
      }
    }
    const imports = own
      .filter((item) => !item.server && item.libraryName)
      .map((item) => ({
        name: item.name,
        command: describe(item.configured, item.raw),
        keys: Object.keys(item.configured?.secrets ?? {}).length > 0,
      }))
    const id = createHash('sha256')
      .update(
        JSON.stringify([
          reading.text,
          files.map((file) => file.after),
          launch,
          library.map((server) => [server.id, server.name, server.agents, server.on]),
        ]),
      )
      .digest('hex')
    return { target: targetId, id, files, imports, entries, own, owner: reading.owner }
  }

  /**
   * One file has one record: an app reading an agent's file is turned on through that agent, and
   * an agent not while an app's record of its file is on.
   */
  private async notShared(reading: Reading): Promise<void> {
    const file = path.resolve(reading.file.path)
    const ledger = await this.load()
    for (const owner of await this.deps.owners()) {
      // Only an app and an agent can share a file.
      if (!owner.app === !reading.owner.app) continue
      if (owner.app && !ledger.agents[owner.id]?.on) continue
      const other = await this.fileFor(owner.id, ledger.agents[owner.id])
      if (other && path.resolve(other.path) === file) {
        throw new Error(
          owner.app
            ? `${MCP_TERMINAL_APPS[owner.app]} uses this same file through Kettu; turn it off there first`
            : 'An agent reads this same file; turn it on for that agent',
        )
      }
    }
  }

  /** The file's own entries, with the library server each is or the name it is imported as. */
  private ownEntries(reading: Reading, library: readonly MarketServer[]): Own[] {
    const names = new Set(library.map((server) => server.name))
    const out: Own[] = []
    for (const [name, raw] of Object.entries(reading.servers)) {
      if (isBridgeEntry(raw)) continue
      const configured = parsed(name, raw, this.source(reading, name))
      if (!configured) {
        out.push({ name, raw, configured: null, server: null, libraryName: null })
        continue
      }
      const print = mcpFingerprint(endpointOf(configured.spec))
      const server = library.find((item) => fingerprintOf(item) === print) ?? null
      // An app takes only what every agent gets, so a server kept for some agents stays its own.
      if (server && (!server.on || (reading.owner.app && server.agents !== 'all'))) {
        out.push({ name, raw, configured, server: null, libraryName: null })
        continue
      }
      const libraryName = server?.name ?? importName(name, names)
      if (!server) names.add(libraryName)
      out.push({ name, raw, configured, server, libraryName })
    }
    return out
  }

  /**
   * Turns it on as the plan said: the agent's own servers go into the library first, then the
   * file is backed up and its entries replaced. Refused when the file changed since the plan.
   */
  turnOn(targetId: McpTerminalTarget, planId: string): Promise<void> {
    return this.run(async () => {
      const plan = await this.planNow(targetId)
      if (plan.id !== planId) throw new McpTerminalStale('The file changed. Review it again.')
      const imports = plan.own.filter((item) => !item.server && item.libraryName)
      if (imports.length > 0) {
        await this.deps.importOwn(
          targetId,
          imports.map((item) => ({
            source: sourceIn(plan.owner, plan.files[0]!.path, item.name),
            name: item.libraryName!,
          })),
        )
      }
      const { owner } = plan
      const give = plan.own
        .map((item) => item.server)
        .filter((server): server is MarketServer => !!server && !terminalGets(server, owner.id))
      if (give.length > 0 && !owner.app)
        await this.deps.giveTo(
          owner.id,
          give.map((server) => server.id),
        )
      const ledger = await this.load()
      const file = plan.files[0]!.path
      const before = ledger.agents[targetId]
      const target: Target = {
        on: true,
        file,
        since: Date.now(),
        entries: {},
        kept: [],
        tools: [],
        originals: null,
        backups: before?.backups ?? [],
      }
      const reading = await this.read(targetId, target)
      const launch = this.deps.launch()!
      const { edits, entries, replaced } = this.compute(reading, target, launch)
      const originals =
        Object.keys(replaced).length > 0 ? await this.sealText(JSON.stringify(replaced)) : null
      const writes: Parameters<McpTerminal['write']>[3] = []
      let text = reading.text
      if (edits.length > 0) {
        text = editServers(reading.text, reading.format, reading.container, edits)
      }
      writes.push({
        path: reading.file.path,
        before: reading.text,
        existed: reading.existed,
        text,
        claude: reading.file.layout === 'claude',
      })
      const setting = this.toolSetting(reading)
      let tools: string[] = []
      if (setting) {
        tools = this.toolItems(setting, entries)
        const same = setting.file === reading.file.path
        const edit = await this.toolEdit(setting, [], tools, same ? text : undefined)
        if (edit) {
          if (same) writes[0]!.text = edit.text
          else writes.push({ path: setting.file, ...edit, claude: false })
        }
      }
      try {
        await this.write(targetId, { ...target, on: false }, 'takeover', writes, {
          ...target,
          entries,
          tools,
          originals,
        })
      } catch (error) {
        await this.dropBlob(originals)
        throw error
      }
      if (before?.originals) await this.dropBlob(before.originals)
      this.deps.changed()
    })
  }

  /** What turning it off puts back and removes. */
  offPlan(targetId: McpTerminalTarget): Promise<McpTerminalOffPlan> {
    return this.run(async () => {
      const target = (await this.load()).agents[targetId]
      if (!target) return { target: targetId, back: [], removed: [], tools: 0 }
      const originals = await this.originals(target)
      const reading = await this.read(targetId, target).catch(() => null)
      const changed = new Set(reading ? this.drift(reading, target).map(({ name }) => name) : [])
      const back: McpTerminalOffPlan['back'] = []
      const removed: string[] = []
      for (const name of Object.keys(target.entries)) {
        if (changed.has(name)) continue
        if (name in originals) {
          const configured = parsed(name, originals[name], { path: target.file, entryName: name })
          back.push({
            name,
            command: describe(configured, originals[name]),
            keys: Object.keys(configured?.secrets ?? {}).length > 0,
          })
        } else removed.push(name)
      }
      return { target: targetId, back, removed, tools: target.tools.length }
    })
  }

  /** Turns it off: Kettu's entries go, the agent's own come back as they were, keys included. */
  turnOff(targetId: McpTerminalTarget): Promise<void> {
    return this.run(async () => {
      const target = (await this.load()).agents[targetId]
      if (!target) return
      await this.offNow(targetId, target)
      this.deps.changed()
    })
  }

  private async offNow(targetId: McpTerminalTarget, target: Target): Promise<void> {
    const ledger = await this.load()
    const offTarget: Target = { ...target, on: false }
    let reading: Reading
    try {
      reading = await this.read(targetId, target)
    } catch (error) {
      // Kept as written, for a later try; meanwhile the bridge answers with no tools.
      await this.save({ ...ledger, agents: { ...ledger.agents, [targetId]: offTarget } })
      throw error
    }
    const originals = await this.originals(target)
    const changed = new Set(this.drift(reading, target).map(({ name }) => name))
    const edits: EntryEdit[] = []
    for (const name of Object.keys(target.entries)) {
      if (changed.has(name)) continue
      edits.push({ name, value: name in originals ? originals[name] : undefined })
    }
    const writes: Parameters<McpTerminal['write']>[3] = []
    let text = reading.text
    const live = edits.filter(({ name, value }) => value !== undefined || name in reading.servers)
    if (live.length > 0) text = editServers(reading.text, reading.format, reading.container, live)
    if (text !== reading.text) {
      writes.push({
        path: reading.file.path,
        before: reading.text,
        existed: reading.existed,
        text,
        claude: reading.file.layout === 'claude',
      })
    }
    const setting = this.toolSetting(reading)
    if (setting && target.tools.length > 0) {
      const same = setting.file === reading.file.path
      const edit = await this.toolEdit(setting, target.tools, [], same ? text : undefined)
      if (edit) {
        if (same && writes[0]) writes[0].text = edit.text
        else if (same) {
          writes.push({
            path: reading.file.path,
            before: reading.text,
            existed: reading.existed,
            text: edit.text,
            claude: false,
          })
        } else writes.push({ path: setting.file, ...edit, claude: false })
      }
    }
    try {
      await this.write(targetId, target, 'off', writes, {
        ...offTarget,
        entries: {},
        tools: [],
        kept: [],
        originals: null,
      })
    } catch (error) {
      await this.save({ ...ledger, agents: { ...ledger.agents, [targetId]: offTarget } })
      throw error
    }
    await this.dropBlob(target.originals)
  }

  /** The entries Kettu wrote that changed outside Kettu. */
  drifts(targetId: McpTerminalTarget): Promise<McpTerminalDrift[]> {
    return this.run(async () => {
      const target = (await this.load()).agents[targetId]
      if (!target) return []
      return this.drift(await this.read(targetId, target), target)
    })
  }

  /** The user's choice for each changed entry: keep the file's, or put Kettu's back. */
  resolve(targetId: McpTerminalTarget, choices: Record<string, McpTerminalChoice>): Promise<void> {
    return this.run(async () => {
      const ledger = await this.load()
      const target = ledger.agents[targetId]
      if (!target?.on) return
      const reading = await this.read(targetId, target)
      const drifted = new Set(this.drift(reading, target).map(({ name }) => name))
      const entries = { ...target.entries }
      const kept = new Set(target.kept)
      const force = new Set<string>()
      for (const [name, choice] of Object.entries(choices)) {
        if (!drifted.has(name)) continue
        if (choice === 'file') {
          delete entries[name]
          kept.add(name)
        } else force.add(name)
      }
      await this.save({
        ...ledger,
        agents: { ...ledger.agents, [targetId]: { ...target, entries, kept: [...kept] } },
      })
      await this.syncOne(targetId, force, 'apply')
      this.deps.changed()
    })
  }

  backups(targetId: McpTerminalTarget): Promise<McpTerminalBackup[]> {
    return this.run(async () => {
      const target = (await this.load()).agents[targetId]
      // Newest first; the first backup is kept at the front of the record whatever its time.
      return (target?.backups ?? [])
        .map((backup, index) => ({ backup, index }))
        .sort((a, b) => b.backup.at - a.backup.at || b.index - a.index)
        .map(({ backup }) => ({
          id: backup.id,
          at: backup.at,
          reason: backup.reason,
          servers: Object.keys(backup.entries).length,
          first: backup.first,
        }))
    })
  }

  /**
   * Puts every file of a backup back as it was then, after backing up what they hold now. The one
   * from before the takeover turns it off.
   */
  restore(targetId: McpTerminalTarget, backupId: string): Promise<void> {
    return this.run(async () => {
      const ledger = await this.load()
      const target = ledger.agents[targetId]
      const backup = target?.backups.find((item) => item.id === backupId)
      if (!target || !backup) throw new Error('No such backup')
      const writes: Parameters<McpTerminal['write']>[3] = []
      for (const file of backup.files) {
        const now = await readText(file.path)
        const text = file.blob ? await this.unsealText(file.blob) : ''
        writes.push({
          path: file.path,
          before: now ?? '',
          existed: now !== null,
          text,
          claude: file.path === target.file && (await this.isClaude(targetId)),
        })
      }
      const next: Target = backup.first
        ? { ...target, on: false, entries: {}, tools: [], kept: [], originals: null }
        : {
            ...target,
            on: backup.on,
            entries: backup.entries,
            tools: backup.tools,
            kept: backup.kept,
          }
      await this.write(targetId, target, 'restore', writes, next)
      if (backup.first) await this.dropBlob(target.originals)
      this.deps.changed()
    })
  }

  private async isClaude(targetId: McpTerminalTarget): Promise<boolean> {
    return (
      (await this.deps.owners()).find((owner) => owner.id === targetId)?.harness === 'claude-code'
    )
  }

  /** The names of the entries Kettu wrote into an agent's file, for its own sessions. */
  written(targetId: McpTerminalTarget): string[] {
    return Object.keys(this.ledger?.agents[targetId]?.entries ?? {})
  }
}

/** Where an entry of an owner's file comes from, as discovery names it. */
function sourceIn(owner: TerminalOwner, file: string, name: string): McpConfigSource {
  return owner.app
    ? { path: file, app: MCP_TERMINAL_APPS[owner.app], entryName: name }
    : { path: file, agentId: owner.id, entryName: name }
}

interface Own {
  name: string
  raw: unknown
  configured: ConfiguredMcp | null
  /** The library server it is, when the library has it already. */
  server: MarketServer | null
  /** What the library calls it once imported; null when it stays the agent's own. */
  libraryName: string | null
}

/** A fresh key for the bridge's connect file; it is masked wherever logs could show it. */
export function newTerminalKey(): string {
  const key = randomBytes(32).toString('base64url')
  addLogSecret(key)
  return key
}

export const CONNECT_FILE = 'mcp-bridge.txt'

/**
 * The data folder an entry names with `--data`, or null for the desktop app's default, which the
 * bridge finds by itself as Electron names it.
 */
export function bridgeDataArg(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
  dataPath: string,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix
  let base: string | null
  if (platform === 'darwin') base = p.join(home, 'Library', 'Application Support')
  else if (platform === 'win32') base = env.APPDATA ?? null
  else {
    const xdg = env.XDG_CONFIG_HOME
    base = xdg && p.isAbsolute(xdg) ? xdg : p.join(home, '.config')
  }
  if (base && p.resolve(base, 'Kettu') === p.resolve(dataPath)) return null
  return dataPath
}

/** The file the bridge reads in a terminal: only the user may read it. */
export async function writeConnectFile(dataPath: string, url: string, key: string): Promise<void> {
  const file = path.join(dataPath, CONNECT_FILE)
  const temp = `${file}.${process.pid}.tmp`
  await mkdir(dataPath, { recursive: true })
  try {
    await writeFile(temp, `kettu-mcp-bridge 1\nurl=${url}\nkey=${key}\n`, { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
