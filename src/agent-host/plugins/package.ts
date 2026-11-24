// A plugin package as read from its files: the manifest, the skills in `skills/`, the MCP servers
// of `mcp.json`, the icon in `assets/`, and Kettu's own items in `sh.kettu/`. Reading runs
// nothing; an item that does not read is left out with a warning, and only the manifest, Kettu's
// entry in it or an unsafe path refuses the package.

import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PLUGIN_FOLDERS,
  PLUGIN_ITEM_NAME,
  PLUGIN_NAMESPACE,
  type PluginContents,
  type PluginFolder,
  type PluginItem,
  type PluginSkill,
} from '@shared/plugins'
import { t } from '../i18n'
import { frontmatter } from '../marketplace/frontmatter'
import { SKILL_FILE, SKILL_MD_BYTES, skillFields } from '../marketplace/skill-catalog'
import { parseWorkflow, problemText } from '../workflow/format'
import { parseManifest, refusal, type PluginManifest } from './manifest'
import { parseServers, type PortableServer } from './mcp'

/** A file of a package, by its path inside it with `/` between its parts. */
export interface PackageFile {
  path: string
  data: Buffer
  mode: number
}

export interface PackageLimits {
  files: number
  bytes: number
}

export const PACKAGE_LIMITS: PackageLimits = { files: 2_000, bytes: 50 * 1024 * 1024 }
export const MANIFEST_FILE = 'plugin.json'
const MANIFEST_BYTES = 256 * 1024
const ITEM_BYTES = 256 * 1024
const ICON_BYTES = 512 * 1024
// PNG is the format every client shows; SVG is left out, since it can carry active content.
const ICONS: readonly [string, string][] = [
  ['assets/icon.png', 'image/png'],
  ['assets/icon.webp', 'image/webp'],
  ['assets/icon.jpg', 'image/jpeg'],
]
/** The file a folder item of each kind is defined by. */
const ENTRY_FILES: Record<PluginFolder, string> = {
  commands: 'command.md',
  roles: 'role.md',
  workflows: 'workflow.yaml',
  themes: 'theme.json',
  templates: 'template.json',
}
/** The extensions a single-file item of each kind may have; null takes any. */
const FILE_TYPES: Record<PluginFolder, readonly string[] | null> = {
  commands: ['.md'],
  roles: ['.md'],
  workflows: ['.yaml', '.yml'],
  themes: ['.json'],
  templates: null,
}

/** A package read whole: what it holds, and what installing it needs beyond that. */
export interface PluginPackage {
  manifest: PluginManifest
  contents: PluginContents
  servers: PortableServer[]
  files: PackageFile[]
}

/** Whether a path stays inside the package on every system. */
export function safePackagePath(file: string): boolean {
  if (file.length === 0 || file.length > 512 || /[\\\0]/.test(file) || /^[A-Za-z]:/.test(file)) {
    return false
  }
  return file.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function text(file: PackageFile, max: number): string {
  return file.data.subarray(0, max).toString('utf8')
}

function oneLine(value: string | undefined, max = 1_024): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** The skills of `skills/`: each immediate subfolder with a SKILL.md that reads. */
function readSkills(files: readonly PackageFile[], warnings: string[]): PluginSkill[] {
  const skills: PluginSkill[] = []
  for (const file of files) {
    const parts = file.path.split('/')
    if (parts.length !== 3 || parts[0] !== 'skills' || parts[2] !== SKILL_FILE) continue
    const folder = `skills/${parts[1]!}`
    try {
      const fields = skillFields(text(file, SKILL_MD_BYTES), parts[1]!)
      if (skills.some((skill) => skill.name === fields.name)) {
        throw new Error(t('plugins.reason.duplicate', { name: fields.name }))
      }
      skills.push({ ...fields, path: folder })
    } catch (error) {
      warnings.push(t('plugins.warn.item', { path: folder, reason: (error as Error).message }))
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function jsonFields(source: string): { name?: string; description?: string } | null {
  try {
    const raw = JSON.parse(source) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const { name, description } = raw as Record<string, unknown>
    return {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof description === 'string' ? { description } : {}),
    }
  } catch {
    return null
  }
}

/** An item's own name and description from the file that defines it, or why it does not read. */
function itemFields(
  kind: PluginFolder,
  file: PackageFile,
): { title?: string; description: string } | string {
  const lower = file.path.toLowerCase()
  if (file.data.length > ITEM_BYTES && kind !== 'templates') return t('plugins.reason.tooLarge')
  if (kind === 'workflows') {
    const read = parseWorkflow(file.data.toString('utf8'))
    if (!read.workflow) {
      const problem = read.problems[0]
      return problem ? `${problem.at} ${problemText(problem)}`.trim() : t('plugins.reason.entry')
    }
    return { title: read.workflow.name, description: '' }
  }
  if (lower.endsWith('.md')) {
    const fields = frontmatter(text(file, ITEM_BYTES))
    const title = oneLine(fields.name, 100)
    return { ...(title ? { title } : {}), description: oneLine(fields.description) }
  }
  if (lower.endsWith('.json')) {
    const fields = jsonFields(text(file, ITEM_BYTES))
    if (fields === null) return t('plugins.reason.entry')
    const title = oneLine(fields.name, 100)
    return { ...(title ? { title } : {}), description: oneLine(fields.description) }
  }
  return { description: '' }
}

/** The items of one `sh.kettu/` subfolder: each file, or folder with the kind's own file, is one. */
function readItems(
  kind: PluginFolder,
  files: readonly PackageFile[],
  warnings: string[],
): PluginItem[] {
  const prefix = `${PLUGIN_NAMESPACE}/${kind}/`
  const items: PluginItem[] = []
  const seen = new Set<string>()
  const leftOut = (at: string, reason: string): void => {
    warnings.push(t('plugins.warn.item', { path: at, reason }))
  }
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue
    const parts = file.path.slice(prefix.length).split('/')
    const first = parts[0]!
    let name: string
    if (parts.length === 1) {
      const ext = path.posix.extname(first)
      const types = FILE_TYPES[kind]
      if (first.startsWith('.')) continue
      if (types && !types.includes(ext.toLowerCase())) {
        leftOut(file.path, t('plugins.reason.type', { types: types.join(', ') }))
        continue
      }
      name = ext ? first.slice(0, -ext.length) : first
    } else if (parts.length === 2 && parts[1] === ENTRY_FILES[kind]) {
      name = first
    } else {
      continue
    }
    const at = `${prefix}${first}`
    if (!PLUGIN_ITEM_NAME.test(name)) {
      leftOut(at, t('plugins.reason.name'))
      continue
    }
    if (seen.has(name.toLowerCase())) {
      leftOut(at, t('plugins.reason.duplicate', { name }))
      continue
    }
    const fields = itemFields(kind, file)
    if (typeof fields === 'string') {
      leftOut(at, fields)
      continue
    }
    seen.add(name.toLowerCase())
    items.push({ name, ...fields, path: file.path })
  }
  // A folder without its kind's file holds nothing Kettu can list.
  const folders = new Set(
    files
      .filter(
        (file) => file.path.startsWith(prefix) && file.path.slice(prefix.length).includes('/'),
      )
      .map((file) => file.path.slice(prefix.length).split('/')[0]!),
  )
  for (const folder of folders) {
    if (!files.some((file) => file.path === `${prefix}${folder}/${ENTRY_FILES[kind]}`)) {
      leftOut(`${prefix}${folder}`, t('plugins.reason.noFile', { file: ENTRY_FILES[kind] }))
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name))
}

function readIcon(files: readonly PackageFile[]): string | null {
  for (const [file, type] of ICONS) {
    const icon = files.find((item) => item.path === file)
    if (icon && icon.data.length > 0 && icon.data.length <= ICON_BYTES) {
      return `data:${type};base64,${icon.data.toString('base64')}`
    }
  }
  return null
}

/**
 * Reads a package from its files. Throws with the reason when it has no manifest Kettu installs,
 * or a file's path could leave the package.
 */
export function readPackage(files: readonly PackageFile[], appVersion: string): PluginPackage {
  for (const file of files) {
    if (!safePackagePath(file.path)) {
      throw refusal(t('plugins.unsafePath', { path: file.path.slice(0, 200) }))
    }
  }
  const manifestFile = files.find((file) => file.path === MANIFEST_FILE)
  if (!manifestFile) throw refusal(t('plugins.noManifest'))
  if (manifestFile.data.length > MANIFEST_BYTES) throw refusal(t('plugins.notJson'))
  const manifest = parseManifest(manifestFile.data.toString('utf8'), appVersion)
  const warnings = [...manifest.warnings]
  const kettu = manifest.kettu
  if (kettu?.script && !files.some((file) => file.path === kettu.script)) {
    throw refusal(t('plugins.noScript', { path: kettu.script }))
  }
  const skills = readSkills(files, warnings)
  const mcp = files.find((file) => file.path === 'mcp.json')
  const servers = mcp ? parseServers(text(mcp, MANIFEST_BYTES), manifest.spec, files, warnings) : []
  const folder = (kind: PluginFolder): PluginItem[] => readItems(kind, files, warnings)
  const hooks = files.some((file) => file.path === 'hooks.json' || file.path.startsWith('hooks/'))
  if (hooks) warnings.push(t('plugins.warn.hooks'))
  const unknown = new Set(
    files
      .filter((file) => file.path.startsWith(`${PLUGIN_NAMESPACE}/`))
      .map((file) => file.path.split('/')[1]!)
      .filter((name) => !(PLUGIN_FOLDERS as readonly string[]).includes(name)),
  )
  // The script and what it loads may live anywhere in the namespace's folder.
  const scriptTop = kettu?.script?.startsWith(`${PLUGIN_NAMESPACE}/`)
    ? kettu.script.split('/')[1]
    : undefined
  for (const name of unknown) {
    if (name === scriptTop) continue
    warnings.push(
      t('plugins.warn.item', {
        path: `${PLUGIN_NAMESPACE}/${name}`,
        reason: t('plugins.reason.unknownFolder'),
      }),
    )
  }
  const contents: PluginContents = {
    name: manifest.name,
    title: manifest.displayName ?? manifest.name,
    description: oneLine(manifest.description, 2_000),
    version: manifest.version,
    author: manifest.author,
    homepage: manifest.homepage,
    repository: manifest.repository,
    license: manifest.license,
    titles: kettu?.titles ?? {},
    descriptions: kettu?.descriptions ?? {},
    kettu: kettu?.kettu ?? null,
    icon: readIcon(files),
    skills,
    servers: servers.map(({ name, type, runs }) => ({ name, type, runs })),
    commands: folder('commands'),
    roles: folder('roles'),
    workflows: folder('workflows'),
    themes: folder('themes'),
    templates: folder('templates'),
    script: kettu?.script && kettu.api !== null ? { entry: kettu.script, api: kettu.api } : null,
    permissions: kettu?.permissions ?? [],
    events: kettu?.events ?? [],
    settings: kettu?.settings ?? [],
    tools: kettu?.tools ?? [],
    views: kettu?.views ?? [],
    actions: kettu?.actions ?? [],
    mentions: kettu?.mentions ?? [],
    links: kettu?.links ?? [],
    channels: kettu?.channels ?? [],
    hooks,
    warnings,
  }
  return { manifest, contents, servers, files: [...files] }
}

/**
 * A folder's files for a package. A link anywhere in it refuses the folder, so nothing is read
 * from outside it; `.git` is passed over.
 */
export async function readPackageFolder(
  root: string,
  limits: PackageLimits = PACKAGE_LIMITS,
): Promise<PackageFile[]> {
  const files: PackageFile[] = []
  let bytes = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (prefix === '' && entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) throw refusal(t('plugins.link', { path: relative }))
      if (entry.isDirectory()) {
        await walk(full, relative)
        continue
      }
      if (!entry.isFile()) continue
      const info = await lstat(full)
      bytes += info.size
      if (files.length >= limits.files || bytes > limits.bytes) {
        throw refusal(
          t('plugins.tooLarge', { files: limits.files, mb: limits.bytes / (1024 * 1024) }),
        )
      }
      files.push({ path: relative, data: await readFile(full), mode: info.mode })
    }
  }
  await walk(root, '')
  return files
}
