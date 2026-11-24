// Turns a Claude Code or Codex plugin into a Kettu plugin: its skills are copied as they are, its
// MCP servers rewritten to the format's portable form, its commands become Kettu commands and its
// agents roles. Hooks do not come over, and the result names each one with the reason. The new
// package is written to a folder of its own; the folder it came from is never changed.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stringify } from 'yaml'
import { VERSION } from '@shared/market-publish'
import type {
  ConvertFrom,
  ConvertLeftOut,
  ConvertNote,
  ConvertText,
  PluginConversion,
  PluginConverted,
} from '@shared/plugin-convert'
import { PLUGIN_ITEM_NAME, PLUGIN_NAME, PLUGIN_NAMESPACE } from '@shared/plugins'
import {
  COMMAND_FILE_BYTES,
  isRecord,
  names,
  parseCommand,
  readFrontMatter,
} from '../commands/format'
import { HostError } from '../errors'
import { t, type HostKey } from '../i18n'
import { english, logText, user } from '../localized-error'
import { frontmatter } from '../marketplace/frontmatter'
import { skillFields } from '../marketplace/skill-catalog'
import { ROLE_FILE_BYTES, parseRole } from '../roles/format'
import { packagePath } from './manifest'
import { parseServers } from './mcp'
import { MANIFEST_FILE, readPackage, readPackageFolder, type PackageFile } from './package'

/** The manifest each harness's plugin is told by; a folder with both is taken as Claude Code's. */
export const HARNESS_MANIFESTS: readonly { from: ConvertFrom; file: string }[] = [
  { from: 'claude-code', file: '.claude-plugin/plugin.json' },
  { from: 'codex', file: '.codex-plugin/plugin.json' },
]

const SPEC = '1.0.0'
const SCHEMA = `https://agent-plugins.org/schemas/${SPEC}/plugin.schema.json`
const MCP_SCHEMA = `https://agent-plugins.org/schemas/${SPEC}/mcp.schema.json`
const TEXT_MAX = 2_000
const TITLE_MAX = 100
const NAME_MAX = 64
const ARGUMENT_MAX = 10
const HOOKS_LISTED = 30
const ICON_BYTES = 512 * 1024
const ICONS: Readonly<Record<string, string>> = {
  '.png': 'assets/icon.png',
  '.webp': 'assets/icon.webp',
  '.jpg': 'assets/icon.jpg',
  '.jpeg': 'assets/icon.jpg',
}
const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
// A harness's own variable for the plugin's folder and data folder, and Kettu's.
const PLUGIN_VARS = /\$\{(?:CLAUDE_)?PLUGIN_(ROOT|DATA)\}/g
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g
// What a harness's own files, never the package's, are called.
const SOURCE_ONLY = [
  '.claude-plugin/',
  '.codex-plugin/',
  'commands/',
  'agents/',
  'hooks/',
  'output-styles/',
  'node_modules/',
]
const SOURCE_FILES = ['.mcp.json', '.lsp.json', '.app.json', 'hooks.json', 'settings.json']

type Params = Record<string, string | number>

function said(key: HostKey, params?: Params): ConvertText {
  const message = english(key, params)
  const text = user(key, params)
  return text === message ? { message } : { message, text }
}

/** An error whose text is the user's language, and whose log text is English. */
function saidError(error: unknown): ConvertText {
  const message = logText(error)
  const text = (error as Error).message
  return text === message ? { message } : { message, text }
}

function refused(reason: string): HostError {
  return new HostError('invalid_params', t('plugins.convert.refused', { reason }))
}

/** What the conversion did, as it builds up. */
class Run {
  readonly out = new Map<string, PackageFile>()
  readonly leftOut: ConvertLeftOut[] = []
  readonly notes: ConvertNote[] = []
  /** The paths of the source that the conversion read and dealt with, so they are not copied. */
  readonly used = new Set<string>()
  readonly byPath: Map<string, PackageFile>

  constructor(
    readonly files: readonly PackageFile[],
    readonly from: ConvertFrom,
  ) {
    this.byPath = new Map(files.map((file) => [file.path, file]))
  }

  put(file: string, data: string | Buffer, mode = 0o644): void {
    this.out.set(file, { path: file, data: Buffer.from(data), mode })
  }

  left(kind: ConvertLeftOut['kind'], name: string, why: ConvertText): void {
    this.leftOut.push({ kind, name, ...why })
  }

  note(name: string, what: ConvertText): void {
    this.notes.push({ name, ...what })
  }

  text(file: string): string | null {
    const found = this.byPath.get(file)
    if (!found) return null
    this.used.add(file)
    return found.data.toString('utf8').replace(/^\uFEFF/, '')
  }

  json(file: string): unknown {
    const source = this.text(file)
    if (source === null) return null
    try {
      return JSON.parse(source) as unknown
    } catch {
      return null
    }
  }
}

function str(value: unknown, max = TEXT_MAX): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null
}

/** The paths a manifest field names, from a string or a list; each starting with `./`. */
function pathsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of list) {
    const inner = packagePath(typeof item === 'string' ? item.replace(/\/+$/, '') : item)
    if (inner !== null && !out.includes(inner)) out.push(inner)
  }
  return out
}

function under(run: Run, dir: string): PackageFile[] {
  return run.files.filter((file) => file.path.startsWith(`${dir}/`))
}

function baseName(file: string): string {
  return path.posix.basename(file)
}

/** A plugin's name as the format has it, from the harness's and the folder's. */
function pluginName(raw: unknown, folder: string): { name: string; from: string } | null {
  for (const source of [str(raw), folder]) {
    if (source === null) continue
    const name = source
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[-.]+/, '')
      .slice(0, NAME_MAX)
      .replace(/[-.]+$/, '')
    if (PLUGIN_NAME.test(name)) return { name, from: source }
  }
  return null
}

function authorOf(raw: unknown): Record<string, string> | null {
  if (typeof raw === 'string') {
    const name = str(raw.replace(/\s*[<(].*$/, ''))
    return name === null ? null : { name }
  }
  if (!isRecord(raw)) return null
  const out: Record<string, string> = {}
  for (const key of ['name', 'email', 'url']) {
    const value = str(raw[key])
    if (value !== null) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

function repositoryOf(raw: unknown): string | null {
  return str(raw) ?? (isRecord(raw) ? str(raw.url) : null)
}

/** The manifest of the Kettu plugin, and its name. */
function manifestOf(
  run: Run,
  source: Record<string, unknown>,
  folder: string,
): { json: Record<string, unknown>; name: string } {
  const named = pluginName(source.name, folder)
  if (!named) throw refused(t('plugins.convert.noName'))
  if (named.name !== named.from) {
    run.note(
      MANIFEST_FILE,
      said('plugins.convert.note.renamed', { from: named.from, to: named.name }),
    )
  }
  let version = str(source.version)
  if (version === null) {
    run.note(MANIFEST_FILE, said('plugins.convert.note.noVersion'))
    version = '1.0.0'
  } else if (!VERSION.test(version)) {
    run.note(
      MANIFEST_FILE,
      said('plugins.convert.note.badVersion', { version: version.slice(0, 50) }),
    )
    version = '1.0.0'
  }
  const face = isRecord(source.interface) ? source.interface : {}
  const title = str(face.displayName, TITLE_MAX)
  const keywords = Array.isArray(source.keywords)
    ? source.keywords.filter((word): word is string => typeof word === 'string')
    : []
  const author = authorOf(source.author)
  const entries: [string, unknown][] = [
    ['$schema', SCHEMA],
    ['name', named.name],
    ['version', version],
    ['description', str(source.description) ?? str(face.shortDescription) ?? undefined],
    ['author', author ?? undefined],
    ['homepage', str(source.homepage) ?? undefined],
    ['repository', repositoryOf(source.repository) ?? undefined],
    ['license', str(source.license) ?? undefined],
    ['keywords', keywords.length > 0 ? keywords : undefined],
    ['extensions', { [PLUGIN_NAMESPACE]: { format: 1, ...(title !== null ? { title } : {}) } }],
  ]
  return {
    json: Object.fromEntries(entries.filter(([, value]) => value !== undefined)),
    name: named.name,
  }
}

/** The Codex logo as the package's icon, when it is one Kettu shows. */
function copyIcon(run: Run, source: Record<string, unknown>): void {
  const face = isRecord(source.interface) ? source.interface : {}
  for (const field of ['logo', 'composerIcon']) {
    const inner = packagePath(face[field])
    const file = inner === null ? undefined : run.byPath.get(inner)
    const target = file ? ICONS[path.posix.extname(file.path).toLowerCase()] : undefined
    if (!file || !target || file.data.length === 0 || file.data.length > ICON_BYTES) continue
    if (Object.keys(ICONS).some((ext) => run.byPath.has(`assets/icon${ext}`))) return
    run.put(target, file.data)
    return
  }
}

/** The skill folders of the source: `skills/<name>/`, and the folders its manifest adds. */
function skillFolders(
  run: Run,
  source: Record<string, unknown>,
): { dir: string; folder: string }[] {
  const found: { dir: string; folder: string }[] = []
  const add = (dir: string, folder: string) => {
    if (!found.some((item) => item.dir === dir)) found.push({ dir, folder })
  }
  const children = (root: string) => {
    const seen = new Set<string>()
    for (const file of under(run, root)) {
      const parts = file.path.slice(root.length + 1).split('/')
      if (parts.length === 2 && parts[1] === 'SKILL.md' && !seen.has(parts[0]!)) {
        seen.add(parts[0]!)
        add(`${root}/${parts[0]!}`, parts[0]!)
      }
    }
  }
  children('skills')
  for (const root of pathsOf(source.skills)) {
    if (run.byPath.has(`${root}/SKILL.md`)) add(root, baseName(root))
    else children(root)
  }
  return found
}

/** Gives a SKILL.md without a name in its front matter its folder's, which a listing needs. */
function named(text: string, folder: string): string {
  if (frontmatter(text).name) return text
  const open = /^(\uFEFF?---[ \t]*\r?\n)/.exec(text)
  return open ? `${open[1]!}name: ${folder}\n${text.slice(open[0].length)}` : text
}

function convertSkills(run: Run, source: Record<string, unknown>): void {
  const taken = new Set<string>()
  for (const { dir, folder } of skillFolders(run, source)) {
    for (const file of under(run, dir)) run.used.add(file.path)
    const text = run.text(`${dir}/SKILL.md`)!
    try {
      skillFields(text, folder)
    } catch (error) {
      run.left('skill', folder, saidError(error))
      continue
    }
    if (taken.has(folder)) {
      run.left('skill', folder, said('plugins.convert.left.nameTaken', { name: folder }))
      continue
    }
    taken.add(folder)
    const fixed = named(text, folder)
    if (fixed !== text) run.note(folder, said('plugins.convert.note.skillName', { name: folder }))
    for (const file of under(run, dir)) {
      const rest = file.path.slice(dir.length + 1)
      run.out.set(`skills/${folder}/${rest}`, {
        path: `skills/${folder}/${rest}`,
        data: rest === 'SKILL.md' && fixed !== text ? Buffer.from(fixed) : file.data,
        mode: file.mode,
      })
    }
  }
}

/** What a plugin's folder is called in a command, a hook or a server, as `${PLUGIN_ROOT}`. */
function kettuVars(text: string): string {
  return text.replace(PLUGIN_VARS, (_, which: string) => `\${PLUGIN_${which}}`)
}

function textsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textsOf)
  if (isRecord(value)) return Object.values(value).flatMap(textsOf)
  return []
}

/** The `${NAME}` references to the user's environment in some texts. */
function envRefs(texts: readonly string[]): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(ENV_REF)) {
      if (!/^(?:CLAUDE_)?PLUGIN_(?:ROOT|DATA)$/.test(match[1]!)) found.add(match[1]!)
    }
  }
  return [...found]
}

type Fields = Record<string, unknown>

/** The servers a source names: its `.mcp.json`, then what its manifest adds, a later one winning. */
function serverEntries(run: Run, source: Fields): Map<string, unknown> {
  const servers = new Map<string, unknown>()
  const take = (value: unknown) => {
    if (!isRecord(value)) return
    const table = isRecord(value.mcpServers) ? value.mcpServers : value
    for (const [name, config] of Object.entries(table)) servers.set(name, config)
  }
  take(run.json('.mcp.json'))
  const field = source.mcpServers
  for (const item of Array.isArray(field) ? field : [field]) {
    if (typeof item === 'string') {
      const inner = packagePath(item)
      if (inner !== null) take(run.json(inner))
    } else take(item)
  }
  return servers
}

const STDIO_FIELDS = ['type', 'command', 'args', 'env', 'cwd']
const REMOTE_FIELDS = ['type', 'url', 'headers']

function remoteType(raw: Fields): 'stdio' | 'streamable-http' | 'sse' | null {
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : null
  if (type === 'stdio') return 'stdio'
  if (type === 'sse') return 'sse'
  if (type === 'http' || type === 'streamable-http' || type === 'streamable_http') {
    return 'streamable-http'
  }
  if (type !== null) return null
  if (typeof raw.command === 'string') return 'stdio'
  return typeof raw.url === 'string' ? 'streamable-http' : null
}

function expand(value: unknown): unknown {
  if (typeof value === 'string') return kettuVars(value)
  if (Array.isArray(value)) return value.map(expand)
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]))
  return value
}

/** A server in the portable form, or why it cannot be carried. */
function portable(raw: unknown): { entry: Fields; dropped: string[] } | ConvertText {
  if (!isRecord(raw)) return said('plugins.convert.left.serverEntry')
  const type = remoteType(raw)
  if (type === null) {
    return said(
      typeof raw.type === 'string'
        ? 'plugins.convert.left.serverType'
        : 'plugins.convert.left.serverNone',
    )
  }
  const stdio = type === 'stdio'
  const source: Fields = { ...raw }
  // Codex writes a remote server's headers as `http_headers`.
  if (!stdio && source.headers === undefined && source.http_headers !== undefined) {
    source.headers = source.http_headers
  }
  const allowed = stdio ? STDIO_FIELDS : REMOTE_FIELDS
  const entry: Fields = { type }
  for (const key of allowed) {
    if (key !== 'type' && source[key] !== undefined) entry[key] = expand(source[key])
  }
  // A file of the plugin is a path inside it, which the format writes as `./`.
  if (typeof entry.command === 'string') {
    const root = /^\$\{PLUGIN_ROOT\}\/(.+)$/.exec(entry.command)
    if (root) entry.command = `./${root[1]!}`
  }
  const dropped = Object.keys(raw).filter(
    (key) => !allowed.includes(key) && !(key === 'http_headers' && !stdio),
  )
  return { entry, dropped }
}

function convertServers(run: Run, source: Fields): void {
  const kept: [string, Fields][] = []
  for (const [name, raw] of serverEntries(run, source)) {
    const made = portable(raw)
    if ('message' in made) {
      run.left('server', name, made)
      continue
    }
    const warnings: string[] = []
    const read = parseServers(
      JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { [name]: made.entry } }),
      SPEC,
      [...run.out.values(), ...run.files].map((file) => ({ path: file.path })),
      warnings,
    )
    if (read.length === 0) {
      run.left('server', name, { message: warnings[0] ?? '' })
      continue
    }
    kept.push([name, made.entry])
    if (made.dropped.length > 0) {
      run.note(name, said('plugins.convert.note.serverFields', { fields: made.dropped.join(', ') }))
    }
    const used = envRefs(textsOf(made.entry))
    if (used.length > 0) {
      run.note(name, said('plugins.convert.note.serverEnv', { vars: used.join(', ') }))
    }
  }
  if (kept.length === 0) return
  kept.sort(([a], [b]) => a.localeCompare(b))
  run.put(
    'mcp.json',
    `${JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: Object.fromEntries(kept) }, null, 2)}\n`,
  )
}

/** The markdown files a harness keeps commands or agents in: its folder, and the paths its manifest adds. */
function markdownSources(
  run: Run,
  folder: string,
  extra: unknown,
): { file: string; name: string }[] {
  const found: { file: string; name: string }[] = []
  const add = (file: string, name: string) => {
    if (!found.some((item) => item.file === file)) found.push({ file, name })
  }
  const fromDir = (dir: string) => {
    for (const file of under(run, dir)) {
      if (!file.path.toLowerCase().endsWith('.md')) continue
      const rest = file.path.slice(dir.length + 1).replace(/\.md$/i, '')
      add(file.path, rest.split('/').join('-'))
    }
  }
  fromDir(folder)
  for (const item of pathsOf(extra)) {
    if (run.byPath.has(item)) add(item, baseName(item).replace(/\.md$/i, ''))
    else fromDir(item)
  }
  return found
}

interface Argument {
  name: string
  help: string
  required: boolean
}

/** The arguments an `argument-hint` such as `<file> [focus]` shows: `<>` needs one, `[]` does not. */
function hinted(hint: unknown): Argument[] {
  if (typeof hint !== 'string') return []
  const out: Argument[] = []
  for (const match of hint.matchAll(/([<[])\s*([^>\]]+?)\s*[>\]]/g)) {
    let name = match[2]!
      .replace(/^-+/, '')
      .replace(/\.\.\.$/, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
    name = name
      .replace(/^[-_\d]+/, '')
      .replace(/-+$/, '')
      .slice(0, 32)
    if (!ARGUMENT_NAME.test(name) || name === 'arguments' || out.some((a) => a.name === name)) {
      name = `arg${out.length + 1}`
    }
    out.push({ name, help: '', required: match[1] === '<' })
    if (out.length === ARGUMENT_MAX) break
  }
  return out
}

/** The prompt with `$ARGUMENTS` and the positional `$1` written as Kettu's placeholders. */
function promptOf(body: string, hint: Argument[]): { body: string; args: Argument[] } {
  const args = [...hint]
  // `$0` or `$ARGUMENTS[0]` means the first argument is counted from 0; otherwise from 1.
  const zero = /\$ARGUMENTS\[0\]|\$0(?!\d)/.test(body)
  let used = false
  const ensure = (index: number): string => {
    while (args.length <= index && args.length < ARGUMENT_MAX) {
      args.push({ name: `arg${args.length + 1}`, help: '', required: false })
    }
    return args[Math.min(index, args.length - 1)]!.name
  }
  let text = body.replace(
    /\$ARGUMENTS\[(\d+)\]|\$(\d+)(?!\d)/g,
    (_, bracket?: string, plain?: string) => {
      const number = Number(bracket ?? plain)
      const index = bracket !== undefined || zero ? number : number - 1
      if (index < 0) return _
      used = true
      return `{{${ensure(index)}}}`
    },
  )
  text = text.replace(/\$ARGUMENTS(?!\[)/g, () => {
    used = true
    return '{{arguments}}'
  })
  // Claude Code adds the arguments to a prompt that has no place for them.
  if (!used && hint.length > 0) text = `${text.trimEnd()}\n\nARGUMENTS: {{arguments}}`
  return { body: text, args }
}

function firstLine(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^#+\s*/, '').trim()
    if (text !== '') return text.slice(0, 200)
  }
  return null
}

function dropped(data: Fields, kept: readonly string[]): string[] {
  return Object.keys(data)
    .filter((key) => !kept.includes(key))
    .sort()
}

function pluginRootNote(run: Run, name: string, text: string): void {
  const found = text.match(PLUGIN_VARS)
  if (found) run.note(name, said('plugins.convert.note.pluginRoot', { variable: found[0] }))
}

function convertCommands(run: Run, source: Fields): void {
  const taken = new Set<string>()
  for (const { file, name } of markdownSources(run, 'commands', source.commands)) {
    const text = run.text(file)!
    const reject = (why: ConvertText) => run.left('command', `/${name}`, why)
    if (!PLUGIN_ITEM_NAME.test(name)) {
      reject(said('plugins.reason.name'))
      continue
    }
    if (taken.has(name.toLowerCase())) {
      reject(said('plugins.convert.left.nameTaken', { name }))
      continue
    }
    const read = readFrontMatter(text)
    if ('reason' in read) {
      reject({ message: read.reason })
      continue
    }
    const { data } = read
    const { body, args } = promptOf(read.body.trim(), hinted(data['argument-hint']))
    const description =
      typeof data.description === 'string' ? data.description : (firstLine(body) ?? '')
    const front = stringify(
      {
        description: description.replace(/\s+/g, ' ').trim(),
        ...(args.length > 0
          ? {
              arguments: args.map(({ name: arg, help, required }) => ({
                name: arg,
                ...(help ? { help } : {}),
                ...(required ? {} : { required: false }),
              })),
            }
          : {}),
      },
      { lineWidth: 0 },
    )
    const converted = `---\n${front}---\n${body}\n`
    const parsed = parseCommand(converted)
    if (!parsed.ok || Buffer.byteLength(converted) > COMMAND_FILE_BYTES) {
      reject(parsed.ok ? said('plugins.reason.tooLarge') : { message: parsed.reason })
      continue
    }
    taken.add(name.toLowerCase())
    run.put(`${PLUGIN_NAMESPACE}/commands/${name}.md`, converted)
    const left = dropped(data, ['description', 'argument-hint', 'name'])
    if (left.length > 0) {
      run.note(`/${name}`, said('plugins.convert.note.commandFields', { fields: left.join(', ') }))
    }
    if (/!`[^`\n]+`/.test(body)) run.note(`/${name}`, said('plugins.convert.note.commandShell'))
    pluginRootNote(run, `/${name}`, text)
  }
}

const ROLE_KEPT = ['name', 'description', 'model', 'effort', 'skills']

function convertAgents(run: Run, source: Fields): void {
  const taken = new Set<string>()
  for (const { file, name } of markdownSources(run, 'agents', source.agents)) {
    const text = run.text(file)!
    const reject = (why: ConvertText) => run.left('agent', name, why)
    if (!PLUGIN_ITEM_NAME.test(name)) {
      reject(said('plugins.reason.name'))
      continue
    }
    if (taken.has(name.toLowerCase())) {
      reject(said('plugins.convert.left.nameTaken', { name }))
      continue
    }
    const read = readFrontMatter(text)
    if ('reason' in read) {
      reject({ message: read.reason })
      continue
    }
    const { data } = read
    const model = str(data.model, 200)
    const effort = str(data.effort, 200)
    const needs = names(data.skills, 'skills')
    const suggests = {
      ...(model !== null && model !== 'inherit' ? { model } : {}),
      ...(effort !== null ? { effort } : {}),
    }
    const front = stringify(
      {
        ...(str(data.name, TITLE_MAX) !== null ? { name: str(data.name, TITLE_MAX) } : {}),
        ...(str(data.description) !== null ? { description: str(data.description) } : {}),
        // A model of Claude Code is only a model there.
        ...(Object.keys(suggests).length > 0 ? { agent: 'claude-code' } : {}),
        ...suggests,
        ...(Array.isArray(needs) && needs.length > 0 ? { skills: needs } : {}),
      },
      { lineWidth: 0 },
    )
    const converted = `---\n${front}---\n${read.body.trim()}\n`
    const parsed = parseRole(converted)
    if (!parsed.ok || Buffer.byteLength(converted) > ROLE_FILE_BYTES) {
      reject(parsed.ok ? said('plugins.reason.tooLarge') : { message: parsed.reason })
      continue
    }
    taken.add(name.toLowerCase())
    run.put(`${PLUGIN_NAMESPACE}/roles/${name}.md`, converted)
    if (Object.keys(suggests).length > 0) run.note(name, said('plugins.convert.note.roleAgent'))
    const left = dropped(data, ROLE_KEPT)
    if (left.length > 0) {
      run.note(name, said('plugins.convert.note.roleFields', { fields: left.join(', ') }))
    }
    pluginRootNote(run, name, text)
  }
}

interface HookRef {
  event: string
  matcher: string | null
  type: string
  /** The command, prompt or address the hook runs. */
  what: string | null
}

function hooksIn(config: unknown, found: HookRef[]): void {
  if (!isRecord(config)) return
  const table = isRecord(config.hooks) ? config.hooks : config
  for (const [event, groups] of Object.entries(table)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isRecord(group)) continue
      const matcher =
        typeof group.matcher === 'string' && group.matcher !== '' ? group.matcher : null
      const handlers: unknown[] = Array.isArray(group.hooks) ? group.hooks : [group]
      for (const handler of handlers) {
        if (!isRecord(handler)) continue
        const what = [handler.command, handler.prompt, handler.url, handler.tool].find(
          (value): value is string => typeof value === 'string',
        )
        const type =
          typeof handler.type === 'string'
            ? handler.type
            : typeof handler.command === 'string'
              ? 'command'
              : 'unknown'
        found.push({ event, matcher, type, what: what ?? null })
      }
    }
  }
}

function hooksOf(run: Run, source: Fields): HookRef[] {
  const found: HookRef[] = []
  hooksIn(run.json('hooks/hooks.json'), found)
  hooksIn(run.json('hooks.json'), found)
  const field = source.hooks
  for (const item of Array.isArray(field) ? field : [field]) {
    if (typeof item === 'string') {
      const inner = packagePath(item)
      if (inner !== null) hooksIn(run.json(inner), found)
    } else hooksIn(item, found)
  }
  return found
}

function hookReason(hook: HookRef): HostKey {
  if (hook.type === 'command') {
    return hook.event === 'PreToolUse'
      ? 'plugins.convert.left.hookBeforeTool'
      : 'plugins.convert.left.hookCommand'
  }
  if (hook.type === 'prompt' || hook.type === 'agent') return 'plugins.convert.left.hookModel'
  if (hook.type === 'http') return 'plugins.convert.left.hookWeb'
  return 'plugins.convert.left.hookOther'
}

/** The files of the plugin that a hook's command names, which only hooks used are then not copied. */
function hookFiles(hooks: readonly HookRef[]): Set<string> {
  const files = new Set<string>()
  for (const hook of hooks) {
    if (hook.type !== 'command' || hook.what === null) continue
    for (const match of hook.what.matchAll(/\$\{(?:CLAUDE_)?PLUGIN_ROOT\}\/([^\s"'`;|&)]+)/g)) {
      files.add(match[1]!)
    }
  }
  return files
}

function describeHook(hook: HookRef): string {
  const place = hook.matcher === null ? hook.event : `${hook.event} (${hook.matcher})`
  return hook.what === null ? place : `${place}: ${hook.what.replace(/\s+/g, ' ').slice(0, 80)}`
}

function leaveOutHooks(run: Run, hooks: readonly HookRef[]): void {
  for (const hook of hooks.slice(0, HOOKS_LISTED)) {
    run.left('hook', describeHook(hook), said(hookReason(hook)))
  }
  if (hooks.length > HOOKS_LISTED) {
    run.left(
      'hook',
      '...',
      said('plugins.convert.left.hookMore', { count: hooks.length - HOOKS_LISTED }),
    )
  }
}

/** Parts of a harness's plugin that Kettu has no counterpart for. */
const UNSUPPORTED: readonly { prefix: string; reason: HostKey }[] = [
  { prefix: '.lsp.json', reason: 'plugins.convert.left.lsp' },
  { prefix: 'output-styles/', reason: 'plugins.convert.left.outputStyles' },
  { prefix: '.app.json', reason: 'plugins.convert.left.apps' },
  { prefix: 'settings.json', reason: 'plugins.convert.left.settings' },
]

function leaveOutUnsupported(run: Run): void {
  for (const { prefix, reason } of UNSUPPORTED) {
    const there = run.files.some((file) =>
      prefix.endsWith('/') ? file.path.startsWith(prefix) : file.path === prefix,
    )
    if (there) run.left('file', prefix, said(reason))
  }
}

function copyRest(run: Run, hookOnly: ReadonlySet<string>): void {
  for (const file of run.files) {
    const first = file.path.split('/')[0]!
    if (run.used.has(file.path) || baseName(file.path) === '.DS_Store') continue
    if (SOURCE_FILES.includes(file.path) || SOURCE_ONLY.some((dir) => file.path.startsWith(dir))) {
      continue
    }
    if (hookOnly.has(file.path)) {
      run.left('file', file.path, said('plugins.convert.left.hookScript'))
      continue
    }
    if (file.path === MANIFEST_FILE || file.path === 'mcp.json' || first === PLUGIN_NAMESPACE) {
      run.left('file', file.path, said('plugins.convert.left.nameTakenFile'))
      continue
    }
    if (!run.out.has(file.path)) run.out.set(file.path, file)
  }
  if (run.files.some((file) => file.path.startsWith('bin/'))) {
    run.note('bin/', said('plugins.convert.note.bin'))
  }
}

/** The files a carried server's command, arguments or folder names, inside the package. */
function serverFiles(run: Run): Set<string> {
  const file = run.out.get('mcp.json')
  const used = new Set<string>()
  if (!file) return used
  const text = file.data.toString('utf8')
  for (const match of text.matchAll(/(?:\$\{PLUGIN_ROOT\}\/|\.\/)([^\s"'`;|&)\\]+)/g)) {
    used.add(match[1]!)
  }
  return used
}

export interface HarnessConversion {
  from: ConvertFrom
  /** The Kettu plugin's name. */
  name: string
  files: PackageFile[]
  conversion: PluginConversion
}

/**
 * Converts a harness plugin's files into a Kettu plugin's. Throws when the plugin has no manifest
 * Kettu can read, or what was made does not read as a Kettu plugin.
 */
export function convertHarnessPlugin(
  files: readonly PackageFile[],
  from: ConvertFrom,
  folder: string,
  appVersion: string,
): HarnessConversion {
  const run = new Run(files, from)
  const manifestPath = HARNESS_MANIFESTS.find((item) => item.from === from)!.file
  const read = run.json(manifestPath)
  if (!isRecord(read)) throw refused(t('plugins.convert.badManifest', { path: manifestPath }))
  const { json, name } = manifestOf(run, read, folder)
  run.put(MANIFEST_FILE, `${JSON.stringify(json, null, 2)}\n`)
  copyIcon(run, read)
  convertSkills(run, read)
  convertServers(run, read)
  convertCommands(run, read)
  convertAgents(run, read)
  const hooks = hooksOf(run, read)
  leaveOutHooks(run, hooks)
  leaveOutUnsupported(run)
  const used = serverFiles(run)
  copyRest(
    run,
    new Set([...hookFiles(hooks)].filter((file) => !used.has(file) && run.byPath.has(file))),
  )
  let contents
  try {
    contents = readPackage([...run.out.values()], appVersion).contents
  } catch (error) {
    throw refused(t('plugins.convert.unreadable', { reason: (error as Error).message }))
  }
  for (const warning of contents.warnings) run.note('', { message: warning })
  const carried = [
    { label: 'skills', items: contents.skills.map((skill) => skill.name) },
    { label: 'servers', items: contents.servers.map((server) => server.name) },
    { label: 'commands', items: contents.commands.map((item) => item.name) },
    { label: 'roles', items: contents.roles.map((item) => item.name) },
  ].filter((group) => group.items.length > 0)
  return {
    from,
    name,
    files: [...run.out.values()],
    conversion: { from, carried, leftOut: run.leftOut, notes: run.notes },
  }
}

/** Which harness a folder's files are a plugin of, by the manifest each keeps. */
export function harnessOf(files: readonly { path: string }[]): ConvertFrom | null {
  return (
    HARNESS_MANIFESTS.find((item) => files.some((file) => file.path === item.file))?.from ?? null
  )
}

/**
 * Writes files into a new folder at `base`, or `base-2`, `base-3` and on when it is taken, and
 * gives its path. Nothing that already exists is touched.
 */
export async function writeConverted(base: string, files: readonly PackageFile[]): Promise<string> {
  await mkdir(path.dirname(base), { recursive: true })
  for (let n = 1; n < 100; n++) {
    const dir = n === 1 ? base : `${base}-${n}`
    try {
      await mkdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      for (const file of files) {
        const target = path.join(dir, ...file.path.split('/'))
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, file.data, { mode: file.mode & 0o777 })
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
    return dir
  }
  throw refused(t('plugins.convert.noFolder', { path: base }))
}

/**
 * Converts the Claude Code or Codex plugin in a folder into a Kettu plugin written next to it, in
 * a new folder named for it with `-kettu` added. The plugin's own folder is only read.
 */
export async function convertFolder(source: string, appVersion: string): Promise<PluginConverted> {
  const root = path.resolve(source)
  const files = (await readPackageFolder(root)).filter(
    (file) => baseName(file.path) !== '.DS_Store',
  )
  const from = harnessOf(files)
  if (!from) throw refused(t('plugins.convert.notHarness', { path: root }))
  const made = convertHarnessPlugin(files, from, path.basename(root), appVersion)
  const dir = await writeConverted(`${root}-kettu`, made.files)
  return { path: dir, name: made.name, conversion: made.conversion }
}
