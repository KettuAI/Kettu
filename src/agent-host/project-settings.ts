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

/**
 * Whether the user's own Grok trusts the repository `cwd` is in, by its trust store: Grok keeps a
 * folder's trust by its repository's root and then loads the folder's MCP servers itself.
 */
export async function grokTrusted(
  storeFile: string,
  cwd: string,
  platform: Platform = process.platform as Platform,
): Promise<boolean> {
  const text = await readText(storeFile)
  if (text === null) return false
  let folders: unknown
  try {
    folders = (parseToml(text) as Record<string, unknown>).folders
  } catch {
    return false
  }
  if (!isRecord(folders)) return false
  const p = platform === 'win32' ? path.win32 : path.posix
  const trusted = new Set<string>()
  for (const [folder, entry] of Object.entries(folders)) {
    if (isRecord(entry) && entry.trusted === true) trusted.add(p.resolve(folder))
  }
  for (const folder of await projectRoots(cwd, platform)) {
    const real = await realpath(folder).catch(() => folder)
    if (trusted.has(folder) || trusted.has(real)) return true
  }
  return false
}

/**
 * Whether the user's own Gemini CLI trusts `cwd`, as it decides: the user's variables first, then
 * its folder trust being off in the user's settings, then the most specific rule of its trust
 * list, a parent rule covering the folder it names the parent of. Unknown is not trusted.
 */
export async function geminiTrusted(
  files: { trustList: string; settings: string },
  cwd: string,
  variable: (name: string) => string | undefined,
): Promise<boolean> {
  if (variable('GEMINI_RESTRICTED_MODE') === 'true') return false
  const workspace = variable('GEMINI_CLI_TRUST_WORKSPACE')
  if (workspace === 'false') return false
  if (workspace === 'true') return true
  const settingsText = await readText(files.settings)
  if (settingsText !== null) {
    const settings: unknown = parseJsonc(settingsText, [], { allowTrailingComma: true })
    const security = isRecord(settings) && isRecord(settings.security) ? settings.security : {}
    if (isRecord(security.folderTrust) && security.folderTrust.enabled === false) return true
  }
  const text = await readText(files.trustList)
  if (text === null) return false
  const rules: unknown = parseJsonc(text, [], { allowTrailingComma: true })
  if (!isRecord(rules)) return false
  const real = async (folder: string) => path.resolve(await realpath(folder).catch(() => folder))
  const location = await real(cwd)
  let longest = -1
  let level: unknown
  for (const [rule, trust] of Object.entries(rules)) {
    const effective = await real(trust === 'TRUST_PARENT' ? path.dirname(rule) : rule)
    const inside = location === effective || location.startsWith(effective + path.sep)
    if (inside && rule.length > longest) {
      longest = rule.length
      level = trust
    }
  }
  return level === 'TRUST_FOLDER' || level === 'TRUST_PARENT'
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

/** What a folder makes a harness run that nothing holds back, which the card only names. */
export interface FolderNotice {
  servers: DeclaredMcpServer[]
  items: DeclaredItem[]
  files: string[]
  digest: string
}

/** Where each harness that has no switch for a folder's own config finds what it runs. */
const NOTICE_PLACES: Partial<
  Record<HarnessId, { kind: 'hook' | 'plugin'; folder: string; only?: string }[]>
> = {
  antigravity: [{ kind: 'hook', folder: '.agents', only: 'hooks.json' }],
  cline: [
    { kind: 'plugin', folder: '.cline/plugins' },
    { kind: 'hook', folder: '.clinerules/hooks' },
    { kind: 'hook', folder: '.cline/hooks' },
  ],
  copilot: [{ kind: 'hook', folder: '.github/hooks' }],
}

/**
 * What `cwd` and its repository's root make a harness run on its first message that no switch
 * holds back: Antigravity's hooks and MCP servers, Cline's plugins and hooks, Copilot's hooks.
 * Null for any other harness, or a folder with none of them.
 */
export async function folderNotice(
  harness: HarnessId,
  cwd: string,
  platform: Platform,
): Promise<FolderNotice | null> {
  const places = NOTICE_PLACES[harness]
  if (!places) return null
  const p = platform === 'win32' ? path.win32 : path.posix
  const base = p.resolve(cwd)
  const roots = [...new Set([base, (await projectRoots(cwd, platform))[0] ?? base])]
  const items: DeclaredItem[] = []
  const files: string[] = []
  const servers: DeclaredMcpServer[] = []
  for (const root of roots) {
    for (const place of places) {
      const folder = p.join(root, ...place.folder.split('/'))
      const found = (await filesUnder(folder, base, platform)).filter(
        (file) => !place.only || p.basename(file) === place.only,
      )
      for (const file of found) {
        items.push({ kind: place.kind, target: clip(file) })
        files.push(file)
      }
    }
    if (harness === 'antigravity') {
      const file = p.join(root, '.agents', 'mcp_config.json')
      const read = await readMcpConfig({ path: file, layout: 'standard', project: root })
      for (const server of read?.servers ?? []) {
        servers.push({ name: server.name, target: targetOf(server.spec) })
      }
      if ((read?.servers.length ?? 0) > 0) files.push(p.relative(base, file))
    }
  }
  if (items.length === 0 && servers.length === 0) return null
  const unique = [...new Set(files)]
  return {
    servers,
    items,
    files: unique,
    digest: sha([servers, await filesDigest(base, unique, platform)]),
  }
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
    case 'kilo':
      return openCodeSettings(harness, cwd, platform)
    case 'qwen':
      return qwenSettings(cwd, platform)
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

/** Where OpenCode, and Kilo Code, which reads OpenCode's files too, keep a project's config. */
const OPENCODE_FAMILY = {
  opencode: { configs: ['opencode.json', 'opencode.jsonc'], folders: ['.opencode'] },
  kilo: {
    configs: ['kilo.json', 'kilo.jsonc', 'opencode.json', 'opencode.jsonc'],
    folders: ['.kilo', '.opencode'],
  },
} as const
/** The names a dotenv file sets, never their values. */
function dotenvNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]/.exec(line)
    if (match) names.push(match[1]!)
  }
  return names
}

/**
 * Qwen Code's project config, which it loads only in a folder it trusts: `.env` and `.qwen/.env`
 * from the repository's root down to `cwd`, with the variables named, and `.qwen/settings.json`
 * with its `env` named, besides the servers Kettu runs, and the other files under `.qwen`.
 */
async function qwenSettings(cwd: string, platform: Platform): Promise<FolderSettings | null> {
  const p = platform === 'win32' ? path.win32 : path.posix
  const base = p.resolve(cwd)
  const items: DeclaredItem[] = []
  const files: string[] = []
  const parts: unknown[] = []
  for (const root of await projectRoots(cwd, platform)) {
    for (const file of [p.join(root, '.env'), p.join(root, '.qwen', '.env')]) {
      const text = await readText(file)
      if (text === null) continue
      const relative = p.relative(base, file)
      files.push(relative)
      for (const name of dotenvNames(text)) items.push({ kind: 'env', target: clip(name) })
      parts.push([relative, sha(text)])
    }
    const config = p.join(root, '.qwen', 'settings.json')
    const text = await readText(config)
    if (text !== null) {
      const parsed: unknown = parseJsonc(text, [], { allowTrailingComma: true })
      const data = isRecord(parsed) ? parsed : {}
      const rest = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'mcpServers'))
      if (Object.keys(rest).length > 0 || !isRecord(parsed)) {
        files.push(p.relative(base, config))
        if (!isRecord(parsed)) items.push({ kind: 'setting', target: p.relative(base, config) })
        for (const [key, value] of Object.entries(rest)) {
          if (key === 'env' && isRecord(value)) {
            for (const name of Object.keys(value)) items.push({ kind: 'env', target: clip(name) })
          } else items.push({ kind: 'setting', target: clip(key) })
        }
        parts.push([p.relative(base, config), isRecord(parsed) ? rest : sha(text)])
      }
    }
    const folder = p.join(root, '.qwen')
    const under = (await filesUnder(folder, base, platform)).filter(
      (file) =>
        !['settings.json', '.env'].includes(p.basename(file)) ||
        p.dirname(file) !== p.relative(base, folder),
    )
    for (const file of under) {
      items.push({ kind: 'setting', target: clip(file) })
      files.push(file)
    }
    parts.push(await filesDigest(base, under, platform))
  }
  if (items.length === 0) return null
  return { harness: 'qwen', items, files: [...new Set(files)], digest: sha(parts) }
}

const OPENCODE_CODE_FOLDERS = new Set(['plugin', 'plugins', 'tool', 'tools'])

/**
 * OpenCode's project config: `opencode.json[c]` and `.opencode` from the repository's root down to
 * `cwd`, with plugins, provider addresses, shell, formatter and language server commands, remote
 * instructions and references named, and every file under `.opencode`, whose plugins and tools
 * run as code; Kilo Code's adds `kilo.json[c]` and `.kilo`. Neither loads any of it with its
 * project config turned off.
 */
async function openCodeSettings(
  harness: keyof typeof OPENCODE_FAMILY,
  cwd: string,
  platform: Platform,
): Promise<FolderSettings | null> {
  const { configs: names, folders } = OPENCODE_FAMILY[harness]
  const isConfig = (file: string): boolean => (names as readonly string[]).includes(file)
  const p = platform === 'win32' ? path.win32 : path.posix
  const base = p.resolve(cwd)
  const items: DeclaredItem[] = []
  const files: string[] = []
  const parts: unknown[] = []
  for (const root of await projectRoots(cwd, platform)) {
    const configs = [
      ...names.map((name) => p.join(root, name)),
      ...folders.flatMap((folder) => names.map((name) => p.join(root, folder, name))),
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
    for (const name of folders) {
      const folder = p.join(root, name)
      const under = (await filesUnder(folder, base, platform)).filter(
        (file) => !isConfig(p.basename(file)),
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
  }
  if (items.length === 0) return null
  return { harness, items, files: [...new Set(files)], digest: sha(parts) }
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
  /** Whether the harness loads the folder by the user's own trust in it, with nothing to ask. */
  ownTrust?: boolean
  /** What the harness runs of the folder's that nothing holds back, which the card only names. */
  notice?: FolderNotice | null
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
    declared.ownTrust === true ||
    (declared.settings !== null &&
      settingsAllowed === true &&
      (declared.turnsOff || own.every((server) => started.includes(server))))
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
