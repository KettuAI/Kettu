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
  PUBLISH_LIMITS,
  VERSION,
  toHandle,
  type MarketProblem,
  type PublishAdds,
  type PublishHarness,
  type PublishKind,
} from '@shared/market-publish'
import { parseWorkflow } from '../workflow/format'
import { officialNamed } from '../workflow/library'
import { frontmatter } from './frontmatter'
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
  harness: PublishHarness | null
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

const CLAUDE_PLUGIN = '.claude-plugin/plugin.json'
const CODEX_PLUGIN = '.codex-plugin/plugin.json'
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
function nameProblem(name: string): string | null {
  if (name.length > MAX_NAME) return 'Its name is too long.'
  // Control characters and backslashes read differently on each system.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(name))
    return 'Its name holds a backslash or control character.'
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
        problems.push({
          path: relative,
          message: 'It is a link. Replace it with the file itself, or remove it.',
        })
        continue
      }
      const bad = nameProblem(entry.name)
      if (bad || relative.length > MAX_PATH) {
        problems.push({ path: relative, message: bad ?? 'Its path is too long.' })
        continue
      }
      if (entry.isDirectory()) {
        await visit(full, relative)
        continue
      }
      if (!entry.isFile()) continue
      const size = (await lstat(full)).size
      if (files.length + 1 > PUBLISH_LIMITS.files) {
        problems.push({
          message: `The folder holds more than ${PUBLISH_LIMITS.files} files, the most a version may have.`,
        })
        throw new Over()
      }
      if (bytes + size > PUBLISH_LIMITS.bytes) {
        problems.push({
          message: `The folder is larger than ${PUBLISH_LIMITS.bytes / (1024 * 1024)} MB, the most a version may be.`,
        })
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
    if (!value) problems.push({ path: file.path, message: 'It is not a JSON object.' })
    return value
  } catch {
    problems.push({ path: file.path, message: 'It is not valid JSON.' })
    return null
  }
}

/** The commands, agents, skills, hooks and servers a plugin's files add, and what they run. */
function pluginParts(
  files: readonly CheckedFile[],
  manifest: Fields,
  problems: MarketProblem[],
): { adds: PublishAdds[]; runs: string[] } {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const names = (dir: string, deep: boolean): string[] =>
    files
      .filter((file) => file.path.startsWith(`${dir}/`) && file.path.endsWith('.md'))
      .map((file) => file.path.slice(dir.length + 1, -3))
      .filter((name) => deep || !name.includes('/'))
      .sort()
  const skills = files
    .filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.path))
    .map((file) => file.path.split('/')[1]!)
    .sort()
  const hooksFile = record(json(byPath.get('hooks/hooks.json'), problems)?.hooks)
  const hooks = { ...(hooksFile ?? {}), ...(record(manifest.hooks) ?? {}) }
  const serversFile = record(json(byPath.get('.mcp.json'), problems)?.mcpServers)
  const servers = { ...(serversFile ?? {}), ...(record(manifest.mcpServers) ?? {}) }
  const runs: string[] = []
  for (const groups of Object.values(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(record(group)?.hooks)
        ? (record(group)!.hooks as unknown[])
        : []) {
        const command = text(record(hook)?.command)
        if (command) runs.push(command)
      }
    }
  }
  for (const server of Object.values(servers)) {
    const fields = record(server)
    const url = text(fields?.url)
    const command = text(fields?.command)
    const args = Array.isArray(fields?.args) ? fields.args.filter((a) => typeof a === 'string') : []
    if (url) runs.push(url)
    else if (command) runs.push([command, ...args].join(' '))
  }
  const adds: PublishAdds[] = [
    { label: 'commands', items: names('commands', true) },
    { label: 'agents', items: names('agents', false) },
    { label: 'skills', items: skills },
    { label: 'hooks', items: Object.keys(hooks).sort() },
    { label: 'servers', items: Object.keys(servers).sort() },
  ].filter((group) => group.items.length > 0)
  return { adds, runs: [...new Set(runs)] }
}

function missing(file: string, field: string): MarketProblem {
  return { path: file, message: `It has no ${field}.` }
}

function readSkill(check: FolderCheck, file: CheckedFile): void {
  const fields = frontmatter(file.data.toString('utf8'))
  const name = text(fields.name)
  const description = text(fields.description)
  if (!name) check.problems.push(missing(SKILL_FILE, 'name in its front matter'))
  else if (!SKILL_NAME.test(name)) {
    check.problems.push({
      path: SKILL_FILE,
      message: `The name "${name}" must be lowercase letters, digits and hyphens.`,
    })
  }
  if (!description) check.problems.push(missing(SKILL_FILE, 'description in its front matter'))
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
 * A workflow, read by the library's own parser: any problem it finds, or an official workflow's
 * name, keeps it from being published. Its README is the listing's text.
 */
function readWorkflow(check: FolderCheck, file: CheckedFile): void {
  const source = utf8(file.data)
  if (source === null) {
    check.problems.push({ path: WORKFLOW_FILE, message: 'It is not UTF-8 text.' })
    return
  }
  const read = parseWorkflow(source)
  if (!read.workflow) {
    for (const problem of read.problems) {
      check.problems.push({
        path: WORKFLOW_FILE,
        message: problem.at ? `${problem.at}: ${problem.message}` : problem.message,
      })
    }
    return
  }
  const { workflow } = read
  const official = officialNamed(workflow.name)
  if (official) {
    check.problems.push({
      path: WORKFLOW_FILE,
      message: `An official workflow is named "${official}". Give this one another name.`,
    })
  }
  const slug = toHandle(workflow.name)
  if (HANDLE.test(slug)) check.slug = slug
  else {
    check.problems.push({
      path: WORKFLOW_FILE,
      message: `The name "${workflow.name}" has no Latin letters or digits to name the listing by. Name it in English and give other languages under locales.`,
    })
  }
  check.name = workflow.name
  if (workflow.description.trim()) Object.assign(check, describe(workflow.description))
  else check.problems.push(missing(WORKFLOW_FILE, 'description'))
  const readme = check.files.find((item) => item.path === README)
  const about = readme?.text ? readme.data.toString('utf8').trim() : ''
  if (about.length > LISTING_ABOUT_CHARS) {
    check.problems.push({
      path: README,
      message: `It is longer than ${LISTING_ABOUT_CHARS} characters, the most a listing's text may be.`,
    })
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

function readPlugin(check: FolderCheck, file: CheckedFile, harness: PublishHarness): void {
  const manifest = json(file, check.problems)
  if (!manifest) return
  const ui = record(manifest.interface)
  const name = text(manifest.name)
  const description = text(manifest.description) ?? text(ui?.shortDescription)
  const version = text(manifest.version)
  if (!name) check.problems.push(missing(file.path, 'name'))
  if (!description) check.problems.push(missing(file.path, 'description'))
  if (!version) check.problems.push(missing(file.path, 'version'))
  else if (!VERSION.test(version)) {
    check.problems.push({
      path: file.path,
      message: `"${version}" is not a version such as 1.0.0.`,
    })
  } else check.version = version
  if (name) {
    check.slug = toHandle(name)
    check.name = text(ui?.displayName) ?? displayTitle(name)
  }
  if (description) Object.assign(check, describe(description))
  check.harness = harness
  Object.assign(check, pluginParts(check.files, manifest, check.problems))
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
    check.problems.push({
      path: SERVER_FILE,
      message: `"${version}" is not a version such as 1.0.0.`,
    })
  } else check.version = version
  check.server = server
  const bundled = check.files.length > 0
  const spec = bundled ? null : catalogServer({ server })
  if (!bundled && !spec) {
    check.problems.push({
      path: SERVER_FILE,
      message: 'It names no package or https remote that Kettu can run.',
    })
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
    check.problems.push({ path: file.path, message: 'It is not an MCP bundle Kettu can read.' })
    return
  }
  if (!manifest) {
    check.problems.push({ path: file.path, message: 'It has no manifest.json.' })
    return
  }
  const name = text(manifest.name)
  const description = text(manifest.description)
  const version = text(manifest.version)
  if (!name) check.problems.push(missing(`${file.path} manifest.json`, 'name'))
  if (!description) check.problems.push(missing(`${file.path} manifest.json`, 'description'))
  if (!version || !VERSION.test(version)) {
    check.problems.push(missing(`${file.path} manifest.json`, 'version such as 1.0.0'))
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
      check.problems.push({
        path: file.path,
        message: `Line ${line} looks like ${what}. Remove it, and revoke it if it is real.`,
      })
    }
  }
}

/** Checks the folder or MCP bundle at `target`, an absolute path. */
export async function checkFolder(target: string): Promise<FolderCheck> {
  const check: FolderCheck = {
    path: target,
    kind: null,
    harness: null,
    manifest: null,
    slug: null,
    name: null,
    description: null,
    about: null,
    version: null,
    server: null,
    adds: [],
    runs: [],
    files: [],
    bytes: 0,
    problems: [],
  }
  let info
  try {
    info = await lstat(target)
  } catch {
    check.problems.push({ message: `Nothing is at ${target}.` })
    return check
  }
  if (info.isSymbolicLink()) {
    check.problems.push({ message: 'The path is a link. Give the folder it points to instead.' })
    return check
  }
  if (info.isFile()) {
    if (!target.endsWith(BUNDLE)) {
      check.problems.push({ message: 'Publish a folder, or an MCP bundle (.mcpb) file.' })
      return check
    }
    if (info.size > PUBLISH_LIMITS.bytes) {
      check.problems.push({
        message: `The bundle is larger than ${PUBLISH_LIMITS.bytes / (1024 * 1024)} MB, the most a version may be.`,
      })
      return check
    }
    const file = checked(path.basename(target), await readFile(target))
    Object.assign(check, { kind: 'mcp-server', manifest: file.path, files: [file] })
    await readBundle(check, file)
    check.bytes = file.size
    return finish(check)
  }
  if (!info.isDirectory()) {
    check.problems.push({ message: 'Publish a folder, or an MCP bundle (.mcpb) file.' })
    return check
  }
  const at = (file: string) => path.join(target, ...file.split('/'))
  const [claude, codex, skill, server, workflow] = await Promise.all(
    [CLAUDE_PLUGIN, CODEX_PLUGIN, SKILL_FILE, SERVER_FILE, WORKFLOW_FILE].map((file) =>
      exists(at(file)),
    ),
  )
  if (claude && codex) {
    check.problems.push({
      message:
        'The folder is both a Claude Code and a Codex plugin. Publish each from a folder of its own.',
    })
    return check
  }
  if (claude || codex || skill) {
    check.files = await walk(target, check.problems)
    check.bytes = check.files.reduce((sum, file) => sum + file.size, 0)
    const manifest = claude ? CLAUDE_PLUGIN : codex ? CODEX_PLUGIN : SKILL_FILE
    check.kind = skill && !claude && !codex ? 'skill' : 'plugin'
    check.manifest = manifest
    const file = check.files.find((item) => item.path === manifest)
    // Past the limits the walk stopped before reaching it; that problem is said already.
    if (file && check.kind === 'skill') readSkill(check, file)
    else if (file) readPlugin(check, file, claude ? 'claude-code' : 'codex')
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
      check.problems.push({ message: 'The folder holds more than one MCP bundle. Keep one.' })
    } else if (bundles[0]) {
      const size = (await lstat(at(bundles[0].name))).size
      if (size > PUBLISH_LIMITS.bytes) {
        check.problems.push({
          path: bundles[0].name,
          message: `It is larger than ${PUBLISH_LIMITS.bytes / (1024 * 1024)} MB, the most a version may be.`,
        })
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
  check.problems.push({
    message:
      'Kettu cannot tell what this folder is. A skill has a SKILL.md, a workflow a workflow.yaml, a plugin a .claude-plugin/plugin.json or .codex-plugin/plugin.json, and an MCP server a server.json.',
  })
  return check
}

async function readSmall(
  file: string,
  relative: string,
  problems: MarketProblem[],
): Promise<CheckedFile | null> {
  const size = (await lstat(file)).size
  if (size > MANIFEST_BYTES) {
    problems.push({ path: relative, message: 'It is too large to be a manifest.' })
    return null
  }
  return checked(relative, await readFile(file))
}

/** The checks every kind shares: the secrets, the about text and the service's part names. */
function finish(check: FolderCheck): FolderCheck {
  scan(check, check.files)
  if (check.about && check.about.length > LISTING_ABOUT_CHARS) {
    check.problems.push({
      path: check.manifest ?? undefined,
      message: `The description is longer than ${LISTING_ABOUT_CHARS} characters.`,
    })
  }
  // The upload's own part is named so.
  if (check.files.some((file) => file.path === 'manifest')) {
    check.problems.push({
      path: 'manifest',
      message: 'A file at the top may not be named manifest. Rename it.',
    })
  }
  return check
}
