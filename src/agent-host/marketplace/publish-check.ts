// The check a folder goes through before it is published to the Kettu Marketplace, the same as the
// service's: what it is, its name, description and version, the files that would upload, what the
// install adds and runs, and every problem that keeps it from being published. Nothing here
// uploads; a folder with a problem never does.

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { displayTitle, specRuns } from '@shared/marketplace'
import {
  HANDLE,
  LISTING_ABOUT_CHARS,
  LISTING_DESCRIPTION_CHARS,
  LISTING_NAME_CHARS,
  PUBLISH_LIMITS,
  VERSION,
  toHandle,
  type MarketProblem,
  type PublishAdds,
  type PublishKind,
} from '@shared/market-publish'
import type { ConvertFrom } from '@shared/plugin-convert'
import type { PluginContents } from '@shared/plugins'
import type { HostKey } from '../i18n'
import { HARNESS_MANIFESTS } from '../plugins/convert'
import { MANIFEST_FILE, readPackage, type PackageFile } from '../plugins/package'
import { parseWorkflow, problemText } from '../workflow/format'
import { frontmatter } from './frontmatter'
import { problem, problemOf, problemWith } from './localized-error'
import { catalogServer } from './registry'
import { SKILL_NAME } from './skills'

export interface CheckedFile {
  /** From the folder, with `/` between its parts. */
  path: string
  size: number
  sha256: string
  data: Buffer
  text: boolean
}

export interface FolderCheck {
  /** The folder, or the MCP bundle, as it was found. */
  path: string
  kind: PublishKind | null
  /** The file it was told from, such as `SKILL.md`. */
  manifest: string | null
  slug: string | null
  name: string | null
  /** One line, and the whole text when that is longer. */
  description: string | null
  about: string | null
  /** The version its manifest names; a skill and a workflow name none. */
  version: string | null
  /** An MCP server's `server.json`. */
  server: Record<string, unknown> | null
  adds: PublishAdds[]
  runs: string[]
  /** For a Kettu plugin: what its package holds, as the plugin reader reads it. */
  plugin: PluginContents | null
  /** The harness whose plugin this folder is, which converts into a Kettu plugin. */
  convertible: ConvertFrom | null
  /** What would upload. */
  files: CheckedFile[]
  bytes: number
  problems: MarketProblem[]
}

// Never uploaded: a repository's own data and the Finder's.
const SKIPPED = new Set(['.git', '.DS_Store'])
const MANIFEST_BYTES = 1024 * 1024
const MAX_PATH = 512
const MAX_NAME = 255
const TEXT_SNIFF = 8000
const SECRETS_PER_FILE = 5
const BUNDLE = '.mcpb'

const HARNESS_NAMES: Record<ConvertFrom, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
const SKILL_FILE = 'SKILL.md'
const SERVER_FILE = 'server.json'
export const WORKFLOW_FILE = 'workflow.yaml'
const README = 'README.md'

/**
 * A private key: its header and then its body, on the next lines or after an escaped `\n` as in a
 * JSON string. The header alone is how documentation shows one, which the Marketplace takes too.
 */
const PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\r?\n|(?:\\r)?\\n)(?:[A-Za-z-]+:[^\r\n\\]*(?:\r?\n|(?:\\r)?\\n))*(?:\s|\\[rn])*[A-Za-z0-9+/=]{40,}/g

/** What a secret looks like in a text file, in the order a line is tried. */
const SECRETS: { what: string; pattern: RegExp }[] = [
  {
    what: 'a GitHub token',
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  },
  { what: 'an Anthropic API key', pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/ },
  { what: 'an OpenRouter API key', pattern: /(?<![A-Za-z0-9_-])sk-or-v1-[a-f0-9]{64}/ },
  // DeepSeek's and others' keys: `sk-` and 32 hex digits.
  {
    what: 'a DeepSeek-style API key',
    pattern: /(?<![A-Za-z0-9_-])sk-[a-f0-9]{32}(?![A-Za-z0-9_-])/,
  },
  {
    what: 'an OpenAI API key',
    pattern: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/,
  },
  {
    what: 'an AWS access key',
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/,
  },
  { what: 'a Slack token', pattern: /(?<![A-Za-z0-9_])xox[abposr]-[A-Za-z0-9-]{10,}/ },
  { what: 'a Stripe key', pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { what: 'a Google API key', pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/ },
  { what: 'an npm token', pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/ },
  { what: 'a GitLab token', pattern: /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/ },
  { what: 'a Hugging Face token', pattern: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{34,}/ },
]

/** The words for each kind of secret, as the catalog has them. */
const SECRET_NAMES: Record<string, HostKey> = {
  'a private key': 'marketPublish.check.secret.privateKey',
  'a GitHub token': 'marketPublish.check.secret.github',
  'an Anthropic API key': 'marketPublish.check.secret.anthropic',
  'an OpenRouter API key': 'marketPublish.check.secret.openrouter',
  'a DeepSeek-style API key': 'marketPublish.check.secret.deepseek',
  'an OpenAI API key': 'marketPublish.check.secret.openai',
  'an AWS access key': 'marketPublish.check.secret.aws',
  'a Slack token': 'marketPublish.check.secret.slack',
  'a Stripe key': 'marketPublish.check.secret.stripe',
  'a Google API key': 'marketPublish.check.secret.google',
  'an npm token': 'marketPublish.check.secret.npm',
  'a GitLab token': 'marketPublish.check.secret.gitlab',
  'a Hugging Face token': 'marketPublish.check.secret.huggingFace',
}

/** A run of one character, or AWS's documented example key, which no real secret is. */
function placeholder(match: string): boolean {
  return /(.)\1{11,}/.test(match) || match.includes('EXAMPLE')
}

/**
 * Where a text holds something that looks like a secret: the line and what it looks like, never the
 * secret itself.
 */
export function findSecrets(text: string): { line: number; what: string }[] {
  const keys = new Set<number>()
  for (const match of text.matchAll(PRIVATE_KEY)) {
    if (!placeholder(match[0])) keys.add(lineAt(text, match.index))
  }
  const found: { line: number; what: string }[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length && found.length < SECRETS_PER_FILE; index++) {
    if (keys.has(index + 1)) {
      found.push({ line: index + 1, what: 'a private key' })
      continue
    }
    const line = lines[index]!
    for (const { what, pattern } of SECRETS) {
      const match = pattern.exec(line)
      if (match && !placeholder(match[0])) {
        found.push({ line: index + 1, what })
        break
      }
    }
  }
  return found
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1))
    line++
  return line
}

function isText(data: Buffer): boolean {
  return !data.subarray(0, TEXT_SNIFF).includes(0)
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function checked(relative: string, data: Buffer): CheckedFile {
  return { path: relative, size: data.length, sha256: sha256(data), data, text: isText(data) }
}

/** Why a file's name cannot go to the service as part of a path; null when it can. */
function nameProblem(name: string): HostKey | null {
  if (name.length > MAX_NAME) return 'marketPublish.check.nameTooLong'
  // Control characters and backslashes read differently on each system.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return 'marketPublish.check.nameCharacters'
  return null
}

class Over extends Error {}

/** The files under `root` that would upload, stopping at the first problem with the limits. */
async function walk(root: string, problems: MarketProblem[]): Promise<CheckedFile[]> {
  const files: CheckedFile[] = []
  let bytes = 0
  const visit = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        problems.push(problem(relative, 'marketPublish.check.link'))
        continue
      }
      const bad = nameProblem(entry.name)
      if (bad || relative.length > MAX_PATH) {
        problems.push(problem(relative, bad ?? 'marketPublish.check.pathTooLong'))
        continue
      }
      if (entry.isDirectory()) {
        await visit(full, relative)
        continue
      }
      if (!entry.isFile()) continue
      const size = (await lstat(full)).size
      if (files.length + 1 > PUBLISH_LIMITS.files) {
        problems.push(
          problem(undefined, 'marketPublish.check.tooManyFiles', { count: PUBLISH_LIMITS.files }),
        )
        throw new Over()
      }
      if (bytes + size > PUBLISH_LIMITS.bytes) {
        problems.push(
          problem(undefined, 'marketPublish.check.folderTooLarge', {
            mb: PUBLISH_LIMITS.bytes / (1024 * 1024),
          }),
        )
        throw new Over()
      }
      bytes += size
      files.push(checked(relative, await readFile(full)))
    }
  }
  try {
    await visit(root, '')
  } catch (error) {
    if (!(error instanceof Over)) throw error
  }
  return files
}

type Fields = Record<string, unknown>

function record(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * One line of a description for the listing's row, its first sentence or else cut at a word, and
 * the whole when that is longer.
 */
export function describe(full: string): { description: string; about: string | null } {
  const flat = full.replace(/\s+/g, ' ').trim()
  if (flat.length <= LISTING_DESCRIPTION_CHARS) return { description: flat, about: null }
  const sentence = flat.indexOf('. ') + 1
  const space = flat.lastIndexOf(' ', LISTING_DESCRIPTION_CHARS - 1)
  const description =
    sentence > 0 && sentence <= LISTING_DESCRIPTION_CHARS
      ? flat.slice(0, sentence)
      : `${flat.slice(0, space > 0 ? space : LISTING_DESCRIPTION_CHARS - 1).trimEnd()}…`
  return { description, about: full.trim() }
}

function json(file: CheckedFile | undefined, problems: MarketProblem[]): Fields | null {
  if (!file) return null
  try {
    const value = record(JSON.parse(file.data.toString('utf8')))
    if (!value) problems.push(problem(file.path, 'marketPublish.check.notJsonObject'))
    return value
  } catch {
    problems.push(problem(file.path, 'marketPublish.check.notJson'))
    return null
  }
}

function missing(
  file: string,
  field: 'name' | 'description' | 'version' | 'versionNumber' | 'nameFront' | 'descriptionFront',
): MarketProblem {
  return problem(file, `marketPublish.check.missing.${field}`)
}

function readSkill(check: FolderCheck, file: CheckedFile): void {
  const fields = frontmatter(file.data.toString('utf8'))
  const name = text(fields.name)
  const description = text(fields.description)
  if (!name) check.problems.push(missing(SKILL_FILE, 'nameFront'))
  else if (!SKILL_NAME.test(name)) {
    check.problems.push(problem(SKILL_FILE, 'marketPublish.check.skillName', { name }))
  }
  if (!description) check.problems.push(missing(SKILL_FILE, 'descriptionFront'))
  if (!name || !SKILL_NAME.test(name)) return
  check.slug = toHandle(name)
  check.name = displayTitle(name)
  check.adds = [{ label: 'skills', items: [name] }]
  if (description) Object.assign(check, describe(description))
}

/** The bytes as UTF-8 text; null when they are not. */
export function utf8(data: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return null
  }
}

/**
 * A workflow, read by the library's own parser: any problem it finds keeps it from being
 * published. Its README is the listing's text.
 */
function readWorkflow(check: FolderCheck, file: CheckedFile): void {
  const source = utf8(file.data)
  if (source === null) {
    check.problems.push(problem(WORKFLOW_FILE, 'marketPublish.check.notUtf8'))
    return
  }
  const read = parseWorkflow(source)
  if (!read.workflow) {
    for (const found of read.problems) {
      const at = found.at ? `${found.at}: ` : ''
      check.problems.push({
        path: WORKFLOW_FILE,
        ...problemOf(`${at}${found.message}`, `${at}${problemText(found)}`),
      })
    }
    return
  }
  const { workflow } = read
  const slug = toHandle(workflow.name)
  if (HANDLE.test(slug)) check.slug = slug
  else {
    check.problems.push(
      problem(WORKFLOW_FILE, 'marketPublish.check.workflowName', { name: workflow.name }),
    )
  }
  check.name = workflow.name
  if (workflow.description.trim()) Object.assign(check, describe(workflow.description))
  else check.problems.push(missing(WORKFLOW_FILE, 'description'))
  const readme = check.files.find((item) => item.path === README)
  const about = readme?.text ? readme.data.toString('utf8').trim() : ''
  if (about.length > LISTING_ABOUT_CHARS) {
    check.problems.push(
      problem(README, 'marketPublish.check.readmeTooLong', { count: LISTING_ABOUT_CHARS }),
    )
  } else if (about) check.about = about
  const named = (kind: 'mcp' | 'skills') => [
    ...new Set(workflow.steps.flatMap((step) => step.tools[kind])),
  ]
  check.adds = [
    { label: 'steps', items: workflow.steps.map((step) => step.name) },
    {
      label: 'waits',
      items: workflow.steps
        .filter((step) => step.by === 'you' || step.youReview)
        .map((s) => s.name),
    },
    { label: 'servers', items: named('mcp') },
    { label: 'skills', items: named('skills') },
  ].filter((group) => group.items.length > 0)
}

/** An MCP server's `server.json`, which the registry's schema describes. */
function readServer(check: FolderCheck, file: CheckedFile): void {
  const server = json(file, check.problems)
  if (!server) return
  const name = text(server.name)
  const description = text(server.description)
  const version = text(server.version)
  if (!name) check.problems.push(missing(SERVER_FILE, 'name'))
  if (!description) check.problems.push(missing(SERVER_FILE, 'description'))
  if (!version) check.problems.push(missing(SERVER_FILE, 'version'))
  else if (!VERSION.test(version)) {
    check.problems.push(problem(SERVER_FILE, 'marketPublish.check.badVersion', { version }))
  } else check.version = version
  check.server = server
  const bundled = check.files.length > 0
  const spec = bundled ? null : catalogServer({ server })
  if (!bundled && !spec) {
    check.problems.push(problem(SERVER_FILE, 'marketPublish.check.serverNotRunnable'))
  }
  if (spec) check.runs = [specRuns(spec.spec)]
  if (name) {
    const short = name.split('/').at(-1) ?? name
    check.slug = toHandle(short)
    check.name = text(server.title) ?? displayTitle(check.slug)
    check.adds = [{ label: 'servers', items: [check.name] }]
  }
  if (description) Object.assign(check, describe(description))
}

/** An MCP bundle on its own: its `manifest.json` gives what a `server.json` would. */
async function readBundle(check: FolderCheck, file: CheckedFile): Promise<void> {
  let manifest: Fields | null = null
  try {
    const zip = await JSZip.loadAsync(file.data)
    const entry = zip.file('manifest.json')
    if (entry) manifest = record(JSON.parse(await entry.async('string')))
  } catch {
    check.problems.push(problem(file.path, 'marketPublish.check.notBundle'))
    return
  }
  if (!manifest) {
    check.problems.push(problem(file.path, 'marketPublish.check.bundleNoManifest'))
    return
  }
  const name = text(manifest.name)
  const description = text(manifest.description)
  const version = text(manifest.version)
  if (!name) check.problems.push(missing(`${file.path} manifest.json`, 'name'))
  if (!description) check.problems.push(missing(`${file.path} manifest.json`, 'description'))
  if (!version || !VERSION.test(version)) {
    check.problems.push(missing(`${file.path} manifest.json`, 'versionNumber'))
  } else check.version = version
  const config = record(record(manifest.server)?.mcp_config)
  const command = text(config?.command)
  const args = Array.isArray(config?.args) ? config.args.filter((a) => typeof a === 'string') : []
  if (command) check.runs = [[command, ...args].join(' ')]
  if (!name || !check.version) return
  check.slug = toHandle(name)
  check.name = text(manifest.display_name) ?? displayTitle(check.slug)
  check.adds = [{ label: 'servers', items: [check.name] }]
  if (description) Object.assign(check, describe(description))
  // No packages: the bundle is the version's own file, and an mcpb package names an https URL.
  check.server = {
    name: check.slug,
    title: check.name,
    description: description ?? '',
    version: check.version,
  }
}

/** The names an `mcp.json` declares, whether or not each reads. */
function declaredServers(file: CheckedFile | undefined): string[] {
  if (!file) return []
  try {
    const raw = record(JSON.parse(file.data.toString('utf8').replace(/^\uFEFF/, '')))
    const servers = record(raw?.mcpServers)
    return servers ? Object.keys(servers) : []
  } catch {
    return []
  }
}

const PLUGIN_GROUPS = [
  ['skills', 'skills'],
  ['servers', 'servers'],
  ['commands', 'commands'],
  ['roles', 'roles'],
  ['workflows', 'workflows'],
  ['themes', 'themes'],
  ['templates', 'templates'],
] as const

/** What an install adds, as the service lists it: the items by kind, then a script's permissions. */
function pluginAdds(contents: PluginContents): PublishAdds[] {
  const adds: PublishAdds[] = PLUGIN_GROUPS.map(([label, key]) => ({
    label,
    items: contents[key].map((item) => item.name),
  })).filter((group) => group.items.length > 0)
  if (contents.script) adds.push({ label: 'script', items: contents.permissions })
  return adds
}

/** A Kettu plugin: its package read by the plugin reader, so it publishes as it installs. */
function readPlugin(check: FolderCheck, appVersion: string): void {
  const manifest = check.files.find((file) => file.path === MANIFEST_FILE)
  // Past the limits the walk stopped before reaching it; that problem is said already.
  if (!manifest) return
  const files: PackageFile[] = check.files.map((file) => ({
    path: file.path,
    data: file.data,
    mode: 0o644,
  }))
  let contents: PluginContents
  try {
    contents = readPackage(files, appVersion).contents
  } catch (error) {
    const reason = (error as Error).message
    check.problems.push(problem(MANIFEST_FILE, 'marketPublish.check.pluginRead', { reason }))
    return
  }
  check.plugin = contents
  check.slug = toHandle(contents.name)
  // The listing's one name is the plugin's own title in English, else its display name or name.
  check.name = contents.titles.en ?? contents.title
  if (check.name.length > LISTING_NAME_CHARS) {
    check.problems.push(
      problem(MANIFEST_FILE, 'marketPublish.check.pluginTitle', { count: LISTING_NAME_CHARS }),
    )
  }
  if (contents.description) Object.assign(check, describe(contents.description))
  else check.problems.push(missing(MANIFEST_FILE, 'description'))
  if (!contents.version) check.problems.push(missing(MANIFEST_FILE, 'version'))
  else if (!VERSION.test(contents.version)) {
    check.problems.push(
      problem(MANIFEST_FILE, 'marketPublish.check.badVersion', { version: contents.version }),
    )
  } else check.version = contents.version
  const skills = new Set(contents.skills.map((skill) => skill.path))
  for (const file of check.files) {
    const folder = /^(skills\/[^/]+)\/SKILL\.md$/.exec(file.path)?.[1]
    if (folder && !skills.has(folder)) {
      check.problems.push(problem(file.path, 'marketPublish.check.pluginSkill', { folder }))
    }
  }
  const servers = new Set(contents.servers.map((server) => server.name))
  for (const name of declaredServers(check.files.find((file) => file.path === 'mcp.json'))) {
    if (!servers.has(name)) {
      check.problems.push(problem('mcp.json', 'marketPublish.check.pluginServer', { name }))
    }
  }
  check.adds = pluginAdds(contents)
  check.runs = contents.servers.map((server) => server.runs)
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile()
  } catch {
    return false
  }
}

function scan(check: FolderCheck, files: readonly CheckedFile[]): void {
  for (const file of files) {
    if (!file.text) continue
    for (const { line, what } of findSecrets(file.data.toString('utf8'))) {
      const named = SECRET_NAMES[what]
      check.problems.push(
        problemWith(file.path, (say) =>
          say('marketPublish.check.secret.found', { line, what: named ? say(named) : what }),
        ),
      )
    }
  }
}

/**
 * Checks the folder or MCP bundle at `target`, an absolute path. `appVersion` is the Kettu version
 * a plugin's own range is checked against.
 */
export async function checkFolder(target: string, appVersion: string): Promise<FolderCheck> {
  const check: FolderCheck = {
    path: target,
    kind: null,
    manifest: null,
    slug: null,
    name: null,
    description: null,
    about: null,
    version: null,
    server: null,
    adds: [],
    runs: [],
    plugin: null,
    convertible: null,
    files: [],
    bytes: 0,
    problems: [],
  }
  let info
  try {
    info = await lstat(target)
  } catch {
    check.problems.push(problem(undefined, 'marketPublish.check.nothingAt', { path: target }))
    return check
  }
  if (info.isSymbolicLink()) {
    check.problems.push(problem(undefined, 'marketPublish.check.pathIsLink'))
    return check
  }
  if (info.isFile()) {
    if (!target.endsWith(BUNDLE)) {
      check.problems.push(problem(undefined, 'marketPublish.check.folderOrBundle'))
      return check
    }
    if (info.size > PUBLISH_LIMITS.bytes) {
      check.problems.push(
        problem(undefined, 'marketPublish.check.bundleTooLarge', {
          mb: PUBLISH_LIMITS.bytes / (1024 * 1024),
        }),
      )
      return check
    }
    const file = checked(path.basename(target), await readFile(target))
    Object.assign(check, { kind: 'mcp-server', manifest: file.path, files: [file] })
    await readBundle(check, file)
    check.bytes = file.size
    return finish(check)
  }
  if (!info.isDirectory()) {
    check.problems.push(problem(undefined, 'marketPublish.check.folderOrBundle'))
    return check
  }
  const at = (file: string) => path.join(target, ...file.split('/'))
  const [kettuPlugin, skill, server, workflow] = await Promise.all(
    [MANIFEST_FILE, SKILL_FILE, SERVER_FILE, WORKFLOW_FILE].map((file) => exists(at(file))),
  )
  if (kettuPlugin) {
    check.files = await walk(target, check.problems)
    check.bytes = check.files.reduce((sum, file) => sum + file.size, 0)
    check.kind = 'agent-plugin'
    check.manifest = MANIFEST_FILE
    readPlugin(check, appVersion)
    return finish(check)
  }
  for (const { from, file } of HARNESS_MANIFESTS) {
    if (!(await exists(at(file)))) continue
    check.convertible = from
    check.problems.push(
      problem(undefined, 'marketPublish.check.harnessPlugin', { harness: HARNESS_NAMES[from] }),
    )
    return check
  }
  if (skill) {
    check.files = await walk(target, check.problems)
    check.bytes = check.files.reduce((sum, file) => sum + file.size, 0)
    check.kind = 'skill'
    check.manifest = SKILL_FILE
    const file = check.files.find((item) => item.path === SKILL_FILE)
    // Past the limits the walk stopped before reaching it; that problem is said already.
    if (file) readSkill(check, file)
    return finish(check)
  }
  if (server) {
    check.kind = 'mcp-server'
    check.manifest = SERVER_FILE
    const manifestFile = await readSmall(at(SERVER_FILE), SERVER_FILE, check.problems)
    // Only a bundle beside it uploads; the program a server.json names is not Kettu's to host.
    const bundles = (await readdir(target, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith(BUNDLE),
    )
    if (bundles.length > 1) {
      check.problems.push(problem(undefined, 'marketPublish.check.manyBundles'))
    } else if (bundles[0]) {
      const size = (await lstat(at(bundles[0].name))).size
      if (size > PUBLISH_LIMITS.bytes) {
        check.problems.push(
          problem(bundles[0].name, 'marketPublish.check.fileTooLarge', {
            mb: PUBLISH_LIMITS.bytes / (1024 * 1024),
          }),
        )
      } else {
        check.files = [checked(bundles[0].name, await readFile(at(bundles[0].name)))]
        check.bytes = check.files[0]!.size
      }
    }
    if (manifestFile) {
      readServer(check, manifestFile)
      scan(check, [manifestFile])
    }
    return finish(check)
  }
  if (workflow) {
    check.files = await walk(target, check.problems)
    check.bytes = check.files.reduce((sum, file) => sum + file.size, 0)
    check.kind = 'workflow'
    check.manifest = WORKFLOW_FILE
    const file = check.files.find((item) => item.path === WORKFLOW_FILE)
    if (file) readWorkflow(check, file)
    return finish(check)
  }
  check.problems.push(problem(undefined, 'marketPublish.check.unknownFolder'))
  return check
}

async function readSmall(
  file: string,
  relative: string,
  problems: MarketProblem[],
): Promise<CheckedFile | null> {
  const size = (await lstat(file)).size
  if (size > MANIFEST_BYTES) {
    problems.push(problem(relative, 'marketPublish.check.manifestTooLarge'))
    return null
  }
  return checked(relative, await readFile(file))
}

/** The checks every kind shares: the secrets, the about text and the service's part names. */
function finish(check: FolderCheck): FolderCheck {
  scan(check, check.files)
  if (check.about && check.about.length > LISTING_ABOUT_CHARS) {
    check.problems.push(
      problem(check.manifest ?? undefined, 'marketPublish.check.aboutTooLong', {
        count: LISTING_ABOUT_CHARS,
      }),
    )
  }
  // The upload's own part is named so.
  if (check.files.some((file) => file.path === 'manifest')) {
    check.problems.push(problem('manifest', 'marketPublish.check.manifestName'))
  }
  return check
}
