// MCP bundles (`.mcpb`): a zip with a manifest.json that says how to run the server inside it and
// what the user fills in. Every entry is checked before anything is written, and one bad entry
// refuses the whole bundle; the manifest is read only for what Kettu uses, and what it would run
// is worked out without running anything.

import path from 'node:path'
import type { Readable } from 'node:stream'
import JSZip from 'jszip'
import type { BundleInput, BundleType } from '@shared/market-community'
import type { McpValue } from '@shared/marketplace'
import type { Platform } from '@shared/platform'
import { HostError } from '../errors'
import { t } from '../i18n'
import { safeFilePath } from './community'

export const BUNDLE_LIMITS = {
  /** A bundle from an https URL; an uploaded one is held to the version's own limit. */
  download: 50 * 1024 * 1024,
  entries: 2000,
  unpacked: 200 * 1024 * 1024,
} as const

const MANIFEST = 'manifest.json'
const MANIFEST_VERSIONS = new Set(['0.1', '0.2', '0.3', '0.4'])
const TYPES = new Set<BundleType>(['node', 'python', 'uv', 'binary'])
const INPUT_TYPES = new Set<BundleInput['type']>([
  'string',
  'number',
  'boolean',
  'directory',
  'file',
])
const PLATFORMS = new Set(['darwin', 'win32', 'linux'])
const CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_TEXT = 4096
const MAX_ARGS = 200
const MAX_INPUTS = 64
const MAX_VALUE = 16_384
const VARIABLE = /\$\{([^}]*)\}/g
const USER = /^user_config\.(.+)$/
// The type bits of a zip entry's Unix mode.
const TYPE_BITS = 0o170000
const REGULAR = 0o100000
const DIRECTORY = 0o040000
// A signed bundle carries its signature after the zip, between these marks.
const SIGNATURE = Buffer.from('MCPB_SIG_V1')

/** A file of an unpacked bundle, with the mode it is written with. */
export interface BundleFile {
  path: string
  data: Buffer
  mode: number
}

function refuse(message: string): HostError {
  return new HostError('invalid_params', message)
}

function bad(reason: string): HostError {
  return refuse(t('marketBundle.invalid', { reason }))
}

/**
 * The bundle's files and manifest, checked entry by entry before any is inflated: a path that
 * could leave its folder, two names that differ only in case, a link or any other entry that is
 * not a plain file or folder, too many entries or too much once inflated refuse it whole.
 */
export async function unpackBundle(
  data: Buffer,
  limits: { entries: number; unpacked: number } = BUNDLE_LIMITS,
): Promise<{ files: BundleFile[]; manifest: Record<string, unknown> }> {
  const signed = data.lastIndexOf(SIGNATURE)
  const zipped = signed > 0 ? data.subarray(0, signed) : data
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(zipped, { checkCRC32: true })
  } catch {
    throw bad(t('marketBundle.notZip'))
  }
  const entries = Object.values(zip.files)
  if (entries.length > limits.entries) throw bad(t('marketBundle.tooMany'))
  const seen = new Set<string>()
  const wanted: JSZip.JSZipObject[] = []
  for (const entry of entries) {
    // JSZip renames an entry with `..` in it; the name it came with is what is checked.
    const name = (entry.unsafeOriginalName ?? entry.name).replace(/\/$/, '')
    if (!safeFilePath(name) || name !== entry.name.replace(/\/$/, '')) {
      throw bad(t('marketBundle.unsafePath', { path: name.slice(0, 200) }))
    }
    const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : null
    const type = mode === null ? 0 : mode & TYPE_BITS
    if (type !== 0 && type !== (entry.dir ? DIRECTORY : REGULAR)) {
      throw bad(t('marketBundle.notFile', { path: name }))
    }
    const key = name.toLowerCase()
    if (seen.has(key)) throw bad(t('marketBundle.unsafePath', { path: name }))
    seen.add(key)
    if (!entry.dir) wanted.push(entry)
  }
  const files: BundleFile[] = []
  let total = 0
  for (const entry of wanted) {
    const chunks: Buffer[] = []
    const stream = entry.nodeStream('nodebuffer') as unknown as Readable
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        total += chunk.byteLength
        if (total > limits.unpacked) {
          stream.destroy()
          reject(bad(t('marketBundle.tooLarge')))
          return
        }
        chunks.push(chunk)
      })
      stream.on('error', () => reject(bad(t('marketBundle.notZip'))))
      stream.on('end', () => resolve())
    })
    const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0o644
    files.push({
      path: entry.name,
      data: Buffer.concat(chunks),
      mode: mode & 0o111 ? 0o755 : 0o644,
    })
  }
  const manifestFile = files.find((file) => file.path === MANIFEST)
  if (!manifestFile) throw bad(t('marketBundle.noManifest'))
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestFile.data.toString('utf8'))
  } catch {
    throw bad(t('marketBundle.noManifest'))
  }
  if (!isRecord(manifest)) throw bad(t('marketBundle.noManifest'))
  return { files, manifest }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function line(value: unknown, what: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) {
    throw bad(t('marketBundle.field', { field: what }))
  }
  return value
}

/** How the manifest says to start the server, merged with this platform's override. */
interface McpConfig {
  command: string | null
  args: string[]
  env: Record<string, string>
}

interface UserConfig {
  type: BundleInput['type']
  title: string
  description?: string
  required: boolean
  multiple: boolean
  sensitive: boolean
  default?: string
  min?: number
  max?: number
}

/** The manifest's fields Kettu uses, each checked. */
export interface BundleManifest {
  name: string
  displayName: string | null
  version: string
  type: BundleType
  entryPoint: string
  config: McpConfig | null
  userConfig: Map<string, UserConfig>
  platforms: string[] | null
  nodeRange: string | null
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGS) {
    throw bad(t('marketBundle.field', { field: what }))
  }
  return value.map((item) => line(item, what))
}

function envOf(value: unknown, what: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.keys(value).length > MAX_INPUTS) {
    throw bad(t('marketBundle.field', { field: what }))
  }
  const env: Record<string, string> = {}
  for (const [name, text] of Object.entries(value)) {
    if (!ENV_NAME.test(name)) throw bad(t('marketBundle.field', { field: `${what}.${name}` }))
    env[name] = line(text, `${what}.${name}`)
  }
  return env
}

function configOf(value: unknown, platform: Platform): McpConfig | null {
  if (value === undefined) return null
  if (!isRecord(value)) throw bad(t('marketBundle.field', { field: 'server.mcp_config' }))
  const where = 'server.mcp_config'
  const config: McpConfig = {
    command: value.command === undefined ? null : line(value.command, `${where}.command`),
    args: value.args === undefined ? [] : stringList(value.args, `${where}.args`),
    env: envOf(value.env, `${where}.env`),
  }
  const overrides = value.platform_overrides
  if (overrides === undefined) return config
  if (!isRecord(overrides))
    throw bad(t('marketBundle.field', { field: `${where}.platform_overrides` }))
  const own = overrides[platform]
  if (own === undefined) return config
  if (!isRecord(own)) throw bad(t('marketBundle.field', { field: `${where}.platform_overrides` }))
  const at = `${where}.platform_overrides.${platform}`
  return {
    command: own.command === undefined ? config.command : line(own.command, `${at}.command`),
    args: own.args === undefined ? config.args : stringList(own.args, `${at}.args`),
    env: { ...config.env, ...envOf(own.env, `${at}.env`) },
  }
}

function defaultOf(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return line(value, `user_config.${key}.default`)
  if (Array.isArray(value)) return stringList(value, `user_config.${key}.default`).join('\n')
  throw bad(t('marketBundle.field', { field: `user_config.${key}.default` }))
}

function userConfigOf(value: unknown): Map<string, UserConfig> {
  const out = new Map<string, UserConfig>()
  if (value === undefined) return out
  if (!isRecord(value) || Object.keys(value).length > MAX_INPUTS) {
    throw bad(t('marketBundle.field', { field: 'user_config' }))
  }
  for (const [key, raw] of Object.entries(value)) {
    const where = `user_config.${key}`
    if (!CONFIG_KEY.test(key) || !isRecord(raw))
      throw bad(t('marketBundle.field', { field: where }))
    const type = raw.type as BundleInput['type']
    if (!INPUT_TYPES.has(type)) throw bad(t('marketBundle.field', { field: `${where}.type` }))
    const number = (field: 'min' | 'max'): number | undefined => {
      const n = raw[field]
      if (n === undefined) return undefined
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw bad(t('marketBundle.field', { field: `${where}.${field}` }))
      }
      return n
    }
    const description = raw.description === undefined ? undefined : String(raw.description)
    out.set(key, {
      type,
      title: raw.title === undefined ? key : line(raw.title, `${where}.title`, 200),
      ...(description ? { description: description.slice(0, 1000) } : {}),
      required: raw.required === true,
      multiple: raw.multiple === true,
      sensitive: raw.sensitive === true,
      ...(defaultOf(raw.default, key) !== undefined
        ? { default: defaultOf(raw.default, key) }
        : {}),
      ...(number('min') !== undefined ? { min: number('min') } : {}),
      ...(number('max') !== undefined ? { max: number('max') } : {}),
    })
  }
  return out
}

/** The manifest's fields Kettu uses, or why the bundle is refused. */
export function readManifest(raw: Record<string, unknown>, platform: Platform): BundleManifest {
  const version = raw.manifest_version ?? raw.dxt_version
  if (typeof version !== 'string' || !MANIFEST_VERSIONS.has(version)) {
    throw bad(t('marketBundle.field', { field: 'manifest_version' }))
  }
  const name = line(raw.name, 'name', 200)
  const own = line(raw.version, 'version', 100)
  if (!name.trim() || !own.trim()) throw bad(t('marketBundle.field', { field: 'name' }))
  const server = raw.server
  if (!isRecord(server)) throw bad(t('marketBundle.field', { field: 'server' }))
  const type = server.type as BundleType
  if (!TYPES.has(type)) throw bad(t('marketBundle.field', { field: 'server.type' }))
  const entryPoint = line(server.entry_point, 'server.entry_point')
  if (!safeFilePath(entryPoint)) {
    throw bad(t('marketBundle.unsafePath', { path: entryPoint.slice(0, 200) }))
  }
  const compatibility = isRecord(raw.compatibility) ? raw.compatibility : {}
  const platforms =
    compatibility.platforms === undefined
      ? null
      : stringList(compatibility.platforms, 'compatibility.platforms')
  const runtimes = isRecord(compatibility.runtimes) ? compatibility.runtimes : {}
  return {
    name,
    displayName: typeof raw.display_name === 'string' ? raw.display_name.slice(0, 200) : null,
    version: own,
    type,
    entryPoint,
    config: configOf(server.mcp_config, platform),
    userConfig: userConfigOf(raw.user_config),
    platforms,
    nodeRange: typeof runtimes.node === 'string' ? runtimes.node : null,
  }
}

/** What the host gives a plan to work out what will run. */
export interface PlanContext {
  /** Where the bundle is installed: every path it runs stays inside. */
  dir: string
  platform: Platform
  home: string
  /** The bundle's file paths. */
  files: ReadonlySet<string>
  /** The version of Kettu's own Node.js. */
  nodeVersion: string
  /** A command on the host's PATH, or null when it is not there. */
  find(command: string): Promise<string | null>
}

/** How a checked bundle runs, with `${user_config.KEY}` left in the arguments to fill at commit. */
export interface BundleSetup {
  type: BundleType
  command: string
  runtime: 'node' | null
  args: string[]
  env: McpValue[]
  inputs: BundleInput[]
  /** A file the bundle runs as a program, which is written runnable. */
  program: string | null
  runs: string
  blocked: string | null
}

function within(dir: string, file: string): boolean {
  const root = path.resolve(dir)
  const target = path.resolve(file)
  return target === root || target.startsWith(root + path.sep)
}

/** `>=x.y.z` against a version; any other range is not checked. */
function meetsNode(range: string, version: string): boolean {
  const match = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range)
  if (!match) return true
  const want = [match[1], match[2], match[3]].map((part) => Number(part ?? 0))
  const have = version.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i]!
  }
  return true
}

/**
 * What the bundle runs on this host: its command, arguments and environment with every path
 * resolved inside `dir`, the values it asks for, and why it cannot run here when it cannot.
 */
export async function planBundle(manifest: BundleManifest, ctx: PlanContext): Promise<BundleSetup> {
  const { dir, platform } = ctx
  const sep = platform === 'win32' ? '\\' : '/'
  const fixed: Record<string, string> = {
    __dirname: dir,
    HOME: ctx.home,
    DESKTOP: path.join(ctx.home, 'Desktop'),
    DOCUMENTS: path.join(ctx.home, 'Documents'),
    DOWNLOADS: path.join(ctx.home, 'Downloads'),
    '/': sep,
    pathSeparator: sep,
  }
  if (!ctx.files.has(manifest.entryPoint)) {
    throw bad(t('marketBundle.noEntry', { path: manifest.entryPoint }))
  }
  let blocked: string | null = null
  const block = (reason: string) => (blocked ??= reason)

  if (manifest.platforms && !manifest.platforms.includes(platform)) {
    block(
      t('marketBundle.platform', {
        platforms: manifest.platforms.filter((p) => PLATFORMS.has(p)).join(', '),
      }),
    )
  }

  // Fills the fixed variables of one value; a user_config variable is left for the caller.
  const fill = (value: string, where: string): string =>
    value.replace(VARIABLE, (whole, name: string) => {
      if (name in fixed) return fixed[name]!
      const user = USER.exec(name)
      if (user && manifest.userConfig.has(user[1]!)) return whole
      throw bad(t('marketBundle.variable', { variable: whole, where }))
    })
  // A value that named the bundle's folder stays inside it.
  const inside = (raw: string, value: string): string => {
    if (raw.includes('${__dirname}') && !within(dir, value.split(/[=]/).at(-1)!)) {
      throw bad(t('marketBundle.unsafePath', { path: raw.slice(0, 200) }))
    }
    return value
  }
  // A bare path of a file in the bundle, such as `server/index.js`, is read from its folder.
  const own = (value: string): string =>
    !value.includes('${') && ctx.files.has(value) ? path.join(dir, ...value.split('/')) : value

  const config = manifest.config
  let command: string
  let args: string[]
  let runtime: 'node' | null = null
  let program: string | null = null
  if (manifest.type === 'uv') {
    command = config?.command ?? 'uv'
    args = config ? config.args : ['run', '--directory', '${__dirname}', manifest.entryPoint]
  } else if (manifest.type === 'binary') {
    command = config?.command ?? `\${__dirname}/${manifest.entryPoint}`
    args = config?.args ?? []
  } else {
    command = config?.command ?? (manifest.type === 'node' ? 'node' : 'python3')
    args = config?.args ?? ['${__dirname}/' + manifest.entryPoint]
  }
  if (args.length > MAX_ARGS)
    throw bad(t('marketBundle.field', { field: 'server.mcp_config.args' }))

  const inputs = new Map<string, BundleInput>()
  const input = (key: string): BundleInput => {
    const found = inputs.get(key)
    if (found) return found
    const config = manifest.userConfig.get(key)!
    const made: BundleInput = {
      key,
      title: config.title,
      ...(config.description ? { description: config.description } : {}),
      type: config.type,
      secret: config.sensitive,
      required: config.required,
      multiple: config.multiple,
      ...(config.default !== undefined
        ? { default: fill(config.default, `user_config.${key}`) }
        : {}),
      ...(config.min !== undefined ? { min: config.min } : {}),
      ...(config.max !== undefined ? { max: config.max } : {}),
      env: null,
      args: false,
    }
    inputs.set(key, made)
    return made
  }

  // The command: Kettu's own Node.js, a program on PATH, or a file of the bundle.
  const filledCommand = fill(command, 'server.mcp_config.command')
  if (filledCommand.includes('${user_config.')) {
    throw bad(t('marketBundle.variable', { variable: command, where: 'command' }))
  }
  let resolved = own(filledCommand)
  if (
    command.includes('${__dirname}') ||
    resolved !== filledCommand ||
    manifest.type === 'binary'
  ) {
    if (platform === 'win32' && !path.extname(resolved)) resolved += '.exe'
    if (!within(dir, resolved)) throw bad(t('marketBundle.unsafePath', { path: command }))
    const relative = path.relative(dir, resolved).split(path.sep).join('/')
    if (!ctx.files.has(relative)) throw bad(t('marketBundle.noEntry', { path: relative }))
    program = relative
  } else if (manifest.type === 'node' && filledCommand === 'node') {
    runtime = 'node'
    if (manifest.nodeRange && !meetsNode(manifest.nodeRange, ctx.nodeVersion)) {
      block(t('marketBundle.node', { range: manifest.nodeRange, version: ctx.nodeVersion }))
    }
  } else if (/[\\/]/.test(filledCommand)) {
    throw bad(t('marketBundle.unsafePath', { path: command }))
  } else {
    const names =
      filledCommand === 'python' || filledCommand === 'python3'
        ? ['python3', 'python']
        : [filledCommand]
    let found: string | null = null
    for (const name of names) {
      if (await ctx.find(name)) {
        found = name
        break
      }
    }
    if (found) resolved = found
    else if (manifest.type === 'uv' || filledCommand === 'uv') block(t('marketBundle.needsUv'))
    else if (manifest.type === 'python') block(t('marketBundle.needsPython'))
    else block(t('marketBundle.needsCommand', { command: filledCommand }))
  }

  const outArgs: string[] = []
  for (const [i, raw] of args.entries()) {
    const where = `server.mcp_config.args[${i}]`
    const value = inside(raw, own(fill(raw, where)))
    for (const match of value.matchAll(VARIABLE)) {
      const key = USER.exec(match[1]!)![1]!
      const made = input(key)
      if (made.secret) block(t('marketBundle.secretArg', { title: made.title }))
      made.args = true
    }
    outArgs.push(value)
  }

  const env: McpValue[] = []
  for (const [name, raw] of Object.entries(config?.env ?? {})) {
    const where = `server.mcp_config.env.${name}`
    const value = fill(raw, where)
    const vars = [...value.matchAll(VARIABLE)]
    if (vars.length === 0) {
      env.push({ name, value })
      continue
    }
    const tail = vars.length === 1 && value.endsWith(vars[0]![0]) ? vars[0]! : null
    if (!tail) {
      block(t('marketBundle.mixed', { name }))
      continue
    }
    const made = input(USER.exec(tail[1]!)![1]!)
    if (made.env !== null) {
      block(t('marketBundle.mixed', { name }))
      continue
    }
    made.env = name
    const prefix = value.slice(0, value.length - tail[0].length)
    env.push({
      name,
      input: true,
      secret: made.secret,
      required: made.required,
      ...(made.description ? { description: made.description } : {}),
      ...(prefix ? { prefix } : {}),
      title: made.title,
      kind: made.type,
      ...(made.default !== undefined && !made.secret ? { default: made.default } : {}),
      ...(made.min !== undefined ? { min: made.min } : {}),
      ...(made.max !== undefined ? { max: made.max } : {}),
    })
  }

  const runCommand = runtime === 'node' ? 'node' : program ? program : resolved
  const shown = outArgs.map((arg) =>
    arg
      .split(dir + path.sep)
      .join('')
      .replace(VARIABLE, (_, name: string) => `<${inputs.get(USER.exec(name)![1]!)!.title}>`),
  )
  return {
    type: manifest.type,
    command: program ? path.join(dir, ...program.split('/')) : resolved,
    runtime,
    args: outArgs,
    env,
    inputs: [...manifest.userConfig.keys()].flatMap((key) => inputs.get(key) ?? []),
    program,
    runs: [runCommand, ...shown].join(' '),
    blocked,
  }
}

/**
 * The arguments with the user's values in place of `${user_config.KEY}`: a value the user left
 * empty takes its default, an argument with nothing to fill is left out, and a list fills one
 * argument per value. Refused when a required value is missing or one is not of its kind.
 */
export function fillArgs(setup: BundleSetup, values: Readonly<Record<string, string>>): string[] {
  const byKey = new Map(setup.inputs.map((input) => [input.key, input]))
  const valuesOf = (key: string): string[] => {
    const input = byKey.get(key)
    if (!input || !input.args || input.secret)
      throw refuse(t('marketBundle.badValue', { title: key }))
    const given = values[key]?.trim() || input.default?.trim() || ''
    const list = input.multiple
      ? given
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean)
      : [given]
    const kept = list.filter((v) => v !== '')
    if (kept.length === 0) {
      if (input.required) throw refuse(t('marketBundle.missing', { title: input.title }))
      return []
    }
    for (const value of kept) {
      if (value.length > MAX_VALUE || /[\0\r\n]/.test(value)) {
        throw refuse(t('marketBundle.badValue', { title: input.title }))
      }
      if (input.type === 'number') {
        const n = Number(value)
        if (
          !Number.isFinite(n) ||
          (input.min !== undefined && n < input.min) ||
          (input.max !== undefined && n > input.max)
        ) {
          throw refuse(t('marketBundle.badValue', { title: input.title }))
        }
      }
      if (input.type === 'boolean' && value !== 'true' && value !== 'false') {
        throw refuse(t('marketBundle.badValue', { title: input.title }))
      }
    }
    return kept
  }
  const out: string[] = []
  for (const arg of setup.args) {
    const vars = [...arg.matchAll(VARIABLE)]
    if (vars.length === 0) {
      out.push(arg)
      continue
    }
    // A list expands only where it is the whole argument.
    if (vars.length === 1 && vars[0]![0] === arg) {
      out.push(...valuesOf(USER.exec(vars[0]![1]!)![1]!))
      continue
    }
    let empty = false
    const filled = arg.replace(VARIABLE, (_, name: string) => {
      const list = valuesOf(USER.exec(name)![1]!)
      if (list.length === 0) empty = true
      return list.join(' ')
    })
    if (!empty) out.push(filled)
  }
  if (out.length > MAX_ARGS) throw refuse(t('marketBundle.badValue', { title: 'args' }))
  return out
}
