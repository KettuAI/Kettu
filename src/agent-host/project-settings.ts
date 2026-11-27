// What a folder declares for itself that an agent would run or change: the MCP servers of every
// harness's project files, which Kettu runs once the user agrees, and, per harness, the rest of
// its project settings (plugins, hooks, commands, environment, providers), which wait for the same
// answer. Only names, commands and addresses are shown on the card; values never are.

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseToml } from '@decimalturn/toml-patch'
import { parse as parseJsonc } from 'jsonc-parser'
import type { HarnessId } from '@shared/agents'
import type { McpSpec, McpValue } from '@shared/marketplace'
import type { Platform } from '@shared/platform'
import type { DeclaredItem, DeclaredMcpServer } from '@shared/thread'
import { readMcpConfig } from './marketplace/mcp-discovery'
import { claudeProjectMcpPaths, projectMcpConfigPaths } from './marketplace/mcp-config-paths'
import type { ConfiguredMcp } from './marketplace/mcp-config'

const TARGET_CHARS = 300
const MAX_FILE_BYTES = 1024 * 1024
const MAX_LISTED = 200

/** A server a folder's own files declare, by its content digest, and how to run it. */
export interface FolderServer extends DeclaredMcpServer {
  digest: string
  namesDigest: string
  spec: McpSpec
  /** The values its files give, which Kettu passes to its process or requests and shows nowhere. */
  secrets: Record<string, string>
  /** The folder's files that declare it, relative to the folder. */
  files: string[]
}

/** What else the folder's files make one harness run or change, and a digest any change changes. */
export interface FolderSettings {
  harness: HarnessId
  items: DeclaredItem[]
  files: string[]
  digest: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clip(text: string): string {
  return text.length > TARGET_CHARS ? `${text.slice(0, TARGET_CHARS - 1)}…` : text
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * A server's content as its answer is kept: the command and arguments, or the URL, and its
 * variables and headers with their values, since one changed value such as `NODE_OPTIONS` can make
 * the same command run another program. Only this hash is kept, never a value.
 */
export function serverDigest(
  spec: McpSpec,
  secrets: Readonly<Record<string, string>> = {},
): string {
  const entries = (values: readonly McpValue[]) =>
    values
      .map((v): [string, string | null] => [
        v.name,
        'value' in v ? v.value : Object.hasOwn(secrets, v.name) ? secrets[v.name]! : null,
      ])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return sha(
    spec.type === 'stdio'
      ? ['stdio', spec.command, spec.args, entries(spec.env)]
      : ['http', spec.transport ?? 'streamable-http', spec.url, entries(spec.headers)],
  )
}

/** The digest an earlier version kept answers by, of the names alone, to take those answers over. */
export function namesDigest(spec: McpSpec): string {
  const names = (values: readonly { name: string }[]) => values.map((v) => v.name).sort()
  return sha(
    spec.type === 'stdio'
      ? ['stdio', spec.command, spec.args, names(spec.env)]
      : ['http', spec.transport ?? 'streamable-http', spec.url, names(spec.headers)],
  )
}

function targetOf(spec: McpSpec): string {
  return clip(spec.type === 'stdio' ? [spec.command, ...spec.args].join(' ') : spec.url)
}

/**
 * The servers `cwd`'s own files declare for any harness: `.mcp.json` there and in every folder
 * above it, the nearer one winning a name, and the other harnesses' project files in `cwd`. The
 * same server in several files is one.
 */
export async function folderServers(cwd: string, platform: Platform): Promise<FolderServer[]> {
  const p = platform === 'win32' ? path.win32 : path.posix
  const root = p.resolve(cwd)
  const claude = claudeProjectMcpPaths(root, platform).reverse()
  const others = projectMcpConfigPaths(root, platform).filter(
    (file) => p.basename(file.path) !== '.mcp.json',
  )
  const byDigest = new Map<string, FolderServer>()
  const names = new Set<string>()
  const add = (configured: ConfiguredMcp, file: string): void => {
    const digest = serverDigest(configured.spec, configured.secrets)
    const relative = p.relative(root, file) || p.basename(file)
    const known = byDigest.get(digest)
    if (known) {
      if (!known.files.includes(relative)) known.files.push(relative)
      return
    }
    byDigest.set(digest, {
      name: configured.name,
      target: targetOf(configured.spec),
      digest,
      namesDigest: namesDigest(configured.spec),
      spec: configured.spec,
      secrets: { ...configured.secrets },
      files: [relative],
    })
  }
  for (const file of claude) {
    const read = await readMcpConfig(file)
    for (const server of read?.servers ?? []) {
      if (names.has(server.name)) continue
      names.add(server.name)
      add(server, file.path)
    }
  }
  for (const file of others) {
    const read = await readMcpConfig(file)
    for (const server of read?.servers ?? []) add(server, file.path)
  }
  return [...byDigest.values()]
}

/**
 * The folders a harness reads its project config from for `cwd`: `cwd` and each folder above it
 * up to the nearest one holding `.git`, farthest first; `cwd` alone outside a repository.
 */
export async function projectRoots(
  cwd: string,
  platform: Platform = process.platform as Platform,
): Promise<string[]> {
  const p = platform === 'win32' ? path.win32 : path.posix
  const dirs: string[] = []
  let dir = p.resolve(cwd)
  for (;;) {
    dirs.push(dir)
    if (await exists(p.join(dir, '.git'))) return dirs.reverse()
    const parent = p.dirname(dir)
    if (parent === dir) return [p.resolve(cwd)]
    dir = parent
  }
}

/**
 * Whether the user's own Codex config marks `cwd`, or a folder above it up to its repository's
 * root, untrusted. A thread's own trust level wins over the user's, so such a folder is never
 * given "trusted".
 */
export async function codexUntrusted(
  configFile: string,
  cwd: string,
  platform: Platform = process.platform as Platform,
): Promise<boolean> {
  const text = await readText(configFile)
  if (text === null) return false
  let projects: unknown
  try {
    projects = (parseToml(text) as Record<string, unknown>).projects
  } catch {
    return false
  }
  if (!isRecord(projects)) return false
  const p = platform === 'win32' ? path.win32 : path.posix
  const marked = new Set<string>()
  for (const [folder, entry] of Object.entries(projects)) {
    if (isRecord(entry) && entry.trust_level === 'untrusted') marked.add(p.resolve(folder))
  }
  if (marked.size === 0) return false
  for (const folder of await projectRoots(cwd, platform)) {
    const real = await realpath(folder).catch(() => folder)
    if (marked.has(folder) || marked.has(real)) return true
  }
  return false
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  )
}

async function readText(file: string): Promise<string | null> {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return stat.isFile() ? '' : null
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** The files under `dir`, a level or two down, relative to `base`; none past a bound. */
async function filesUnder(dir: string, base: string, platform: Platform, depth = 2) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const out: string[] = []
  const walk = async (folder: string, left: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_LISTED) return
      const full = p.join(folder, entry.name)
      if (entry.isDirectory()) {
        if (left > 1 && entry.name !== 'node_modules') await walk(full, left - 1)
      } else out.push(p.relative(base, full))
    }
  }
  await walk(dir, depth)
  return out
}

/** A digest of files by name and content, for a settings digest that any change changes. */
async function filesDigest(base: string, files: readonly string[], platform: Platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const parts: [string, string][] = []
  for (const file of files) {
    const text = await readText(p.join(base, file))
    parts.push([file, text === null ? '' : sha(text)])
  }
  return parts
}

/**
 * What `cwd`'s own files make `harness` run or change besides MCP servers, for the harnesses
 * whose project settings Kettu holds behind a switch; null when they declare nothing.
 */
export async function folderSettings(
  harness: HarnessId,
  cwd: string,
  platform: Platform,
): Promise<FolderSettings | null> {
  switch (harness) {
    case 'codex':
      return codexSettings(cwd, platform)
    case 'opencode':
      return openCodeSettings(cwd, platform)
    default:
      return null
  }
}

/**
 * Codex's project layer: `.codex/config.toml` from the repository's root down to `cwd`, its keys
 * besides `mcp_servers` and the variables `shell_environment_policy` sets, and every other file
 * under `.codex`, such as exec-policy rules. Codex loads all of it only in a trusted folder.
 */
async function codexSettings(cwd: string, platform: Platform): Promise<FolderSettings | null> {
  const p = platform === 'win32' ? path.win32 : path.posix
  const base = p.resolve(cwd)
  const items: DeclaredItem[] = []
  const files: string[] = []
  const parts: unknown[] = []
  for (const root of await projectRoots(cwd, platform)) {
    const folder = p.join(root, '.codex')
    const config = p.join(folder, 'config.toml')
    const text = await readText(config)
    if (text !== null) {
      let data: Record<string, unknown> = {}
      let readable = true
      try {
        const parsed: unknown = parseToml(text)
        if (isRecord(parsed)) data = parsed
      } catch {
        readable = false
      }
      const rest = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'mcp_servers'))
      const keys = Object.keys(rest)
      if (!readable || keys.length > 0) files.push(p.relative(base, config) || config)
      if (!readable) items.push({ kind: 'setting', target: p.relative(base, config) })
      for (const key of keys) {
        const value = rest[key]
        if (key === 'shell_environment_policy' && isRecord(value) && isRecord(value.set)) {
          for (const name of Object.keys(value.set)) items.push({ kind: 'env', target: clip(name) })
        }
        items.push({ kind: 'setting', target: clip(key) })
      }
      parts.push([p.relative(base, config), readable ? rest : sha(text)])
    }
    const other = (await filesUnder(folder, base, platform)).filter(
      (file) => p.basename(file) !== 'config.toml' || p.dirname(file) !== p.relative(base, folder),
    )
    for (const file of other) {
      items.push({ kind: file.includes('rules') ? 'command' : 'setting', target: clip(file) })
      files.push(file)
    }
    parts.push(await filesDigest(base, other, platform))
  }
  if (items.length === 0) return null
  return { harness: 'codex', items, files: [...new Set(files)], digest: sha(parts) }
}

const OPENCODE_CONFIGS = ['opencode.json', 'opencode.jsonc']
const OPENCODE_CODE_FOLDERS = new Set(['plugin', 'plugins', 'tool', 'tools'])

/**
 * OpenCode's project config: `opencode.json[c]` and `.opencode` from the repository's root down to
 * `cwd`, with plugins, provider addresses, shell, formatter and language server commands, remote
 * instructions and references named, and every file under `.opencode`, whose plugins and tools
 * run as code. OpenCode loads none of it with its project config turned off.
 */
async function openCodeSettings(cwd: string, platform: Platform): Promise<FolderSettings | null> {
  const p = platform === 'win32' ? path.win32 : path.posix
  const base = p.resolve(cwd)
  const items: DeclaredItem[] = []
  const files: string[] = []
  const parts: unknown[] = []
  for (const root of await projectRoots(cwd, platform)) {
    const configs = [
      ...OPENCODE_CONFIGS.map((name) => p.join(root, name)),
      ...OPENCODE_CONFIGS.map((name) => p.join(root, '.opencode', name)),
    ]
    for (const config of configs) {
      const text = await readText(config)
      if (text === null) continue
      const relative = p.relative(base, config)
      const parsed: unknown = parseJsonc(text, [], { allowTrailingComma: true })
      const data = isRecord(parsed) ? parsed : {}
      const rest = Object.fromEntries(
        Object.entries(data).filter(([key]) => key !== 'mcp' && key !== '$schema'),
      )
      if (Object.keys(rest).length === 0 && isRecord(parsed)) continue
      files.push(relative)
      if (!isRecord(parsed)) items.push({ kind: 'setting', target: relative })
      items.push(...openCodeItems(rest))
      parts.push([relative, isRecord(parsed) ? rest : sha(text)])
    }
    const folder = p.join(root, '.opencode')
    const under = (await filesUnder(folder, base, platform)).filter(
      (file) => !OPENCODE_CONFIGS.includes(p.basename(file)),
    )
    for (const file of under) {
      const top = p.relative(folder, p.join(base, file)).split(p.sep)[0] ?? ''
      items.push({
        kind: OPENCODE_CODE_FOLDERS.has(top) ? 'plugin' : 'setting',
        target: clip(file),
      })
      files.push(file)
    }
    parts.push(await filesDigest(base, under, platform))
  }
  if (items.length === 0) return null
  return { harness: 'opencode', items, files: [...new Set(files)], digest: sha(parts) }
}

function openCodeItems(config: Record<string, unknown>): DeclaredItem[] {
  const items: DeclaredItem[] = []
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap((item) => (typeof item === 'string' ? [item] : []))
      : typeof value === 'string'
        ? [value]
        : []
  const commands = (value: unknown, label: string): void => {
    for (const [name, entry] of Object.entries(isRecord(value) ? value : {})) {
      const command = isRecord(entry) ? strings(entry.command).join(' ') : ''
      items.push({
        kind: 'command',
        target: clip(`${label} ${name}${command ? `: ${command}` : ''}`),
      })
    }
  }
  for (const [key, value] of Object.entries(config)) {
    switch (key) {
      case 'plugin':
        for (const plugin of strings(value)) items.push({ kind: 'plugin', target: clip(plugin) })
        break
      case 'provider':
        for (const [id, provider] of Object.entries(isRecord(value) ? value : {})) {
          const options = isRecord(provider) && isRecord(provider.options) ? provider.options : {}
          const url = typeof options.baseURL === 'string' ? options.baseURL : null
          items.push(
            url
              ? { kind: 'provider', target: clip(url) }
              : { kind: 'setting', target: `provider.${id}` },
          )
          if (isRecord(provider) && isRecord(provider.env)) {
            for (const name of Object.keys(provider.env)) items.push({ kind: 'env', target: name })
          }
        }
        break
      case 'shell':
        items.push({ kind: 'command', target: clip(strings(value).join(' ') || key) })
        break
      case 'formatter':
        commands(value, 'formatter')
        break
      case 'lsp':
        commands(value, 'lsp')
        break
      case 'instructions':
        for (const item of strings(value)) {
          items.push({ kind: /^https?:/.test(item) ? 'provider' : 'setting', target: clip(item) })
        }
        break
      default:
        items.push({ kind: 'setting', target: clip(key) })
    }
  }
  return items
}

/** What a folder's own files declare, as the host reads it for a session's agent. */
export interface FolderDeclared {
  /** The servers of every harness's project files, which Kettu runs once allowed. */
  servers: FolderServer[]
  /** The agent's harness's other project settings, where Kettu holds them behind a switch. */
  settings: FolderSettings | null
  /** The names of the servers the agent's harness itself would start from those files. */
  harnessServers: string[]
  /** The digests of those servers, by content, whatever name another file gives one. */
  harnessDigests: string[]
  /**
   * Whether the harness turns those servers off one by one when it loads the folder. One that
   * cannot loads the folder only once every one of them may start, and then runs them itself, so
   * Kettu hands it none of them.
   */
  turnsOff: boolean
}

/**
 * What a session's attach hands on of what its folder declares: the servers nobody answered for
 * and the harness's settings when nobody answered for them, both asked about; the servers Kettu
 * runs for the session; whether the harness may load the folder; and the servers it then runs
 * itself. Nothing applies before the user allowed it.
 */
export function folderHandOff(
  declared: FolderDeclared,
  allowed: (server: FolderServer) => boolean | null,
  settingsAllowed: boolean | null,
): {
  unanswered: FolderServer[]
  askSettings: FolderSettings | null
  servers: FolderServer[]
  trusted: boolean
  selfRun: string[]
} {
  const unanswered = declared.servers.filter((server) => allowed(server) === null)
  const askSettings = declared.settings && settingsAllowed === null ? declared.settings : null
  const own = declared.servers.filter((server) => declared.harnessDigests.includes(server.digest))
  const started = declared.servers.filter((server) => allowed(server) === true)
  const trusted =
    declared.settings !== null &&
    settingsAllowed === true &&
    (declared.turnsOff || own.every((server) => started.includes(server)))
  return {
    unanswered,
    askSettings,
    // A harness that loads the folder and cannot turn its servers off runs them itself.
    servers:
      trusted && !declared.turnsOff ? started.filter((server) => !own.includes(server)) : started,
    trusted,
    selfRun: declared.turnsOff ? [] : own.map((server) => server.name),
  }
}
