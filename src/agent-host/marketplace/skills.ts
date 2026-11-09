// The Marketplace's skills: the catalog of Anthropic's skills repository, unpacked into the host's
// data and kept for a day; the skills Kettu keeps on the host, copied from that catalog, a GitHub
// folder or a local one; what each agent is handed at a session's start; and the skills the agents
// have of their own, read only.

import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentOwnSkill,
  CatalogSkill,
  MarketSkill,
  MarketSkills,
  SkillSource,
} from '@shared/marketplace'
import type { Platform } from '@shared/platform'
import { harnessOf, type AgentId } from '@shared/thread'
import type { SkillsListResponse } from '../codex/protocol'
import type { SessionOptions } from '../connection'
import { HostError } from '../errors'
import type { Env } from '../find-command'
import { JsonFile, type LogFn } from '../storage'
import { codexOwnSkills } from './codex-plugins'
import { frontmatter } from './frontmatter'
import {
  downloadTarball,
  folderFiles,
  githubSource,
  readTarball,
  tarballUrl,
  type FolderLimits,
  type TarFile,
  type Tarball,
  type TarLimits,
} from './tarball'

const CATALOG_URL = 'https://codeload.github.com/anthropics/skills/tar.gz/refs/heads/main'
const CATALOG_REPOSITORY = 'https://github.com/anthropics/skills'
const CATALOG_PREFIX = 'anthropics/skills:'
const CATALOG_FOLDER = 'skills'
const DAY_MS = 24 * 60 * 60_000
/** A copied skill's folder stays this long without an entry, which the settings add after it. */
export const PRUNE_GRACE_MS = 10 * 60_000
const TAR_LIMITS: TarLimits = {
  downloadBytes: 64 * 1024 * 1024,
  unpackedBytes: 256 * 1024 * 1024,
  timeoutMs: 120_000,
}
const SKILL_LIMITS: FolderLimits = { files: 1_000, bytes: 50 * 1024 * 1024 }
const SKILL_FILE = 'SKILL.md'
const SKILL_MD_BYTES = 256 * 1024
// A skill's name as the Agent Skills specification has it.
const SKILL_NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
const DESCRIPTION_CHARS = 1024
const PARTIAL = '.partial-'

/** The catalog as last unpacked: the skills of the repository at one commit. */
export interface SkillsCatalogFile {
  version: 1
  fetchedAt: number | null
  commit: string | null
  /** The folder under the catalog's own that holds this copy. */
  dir: string | null
  skills: { name: string; description: string }[]
}

export function parseSkillsCatalogFile(data: Record<string, unknown>): SkillsCatalogFile | string {
  const { fetchedAt, commit, dir, skills } = data
  if (fetchedAt !== null && typeof fetchedAt !== 'number') return 'fetchedAt is not a time'
  if (commit !== null && typeof commit !== 'string') return 'commit is not a string'
  if (dir !== null && (typeof dir !== 'string' || !/^[A-Za-z0-9-]+$/.test(dir))) {
    return 'dir is not a folder name'
  }
  if (!Array.isArray(skills)) return 'skills is not a list'
  const kept = skills.flatMap((item: unknown) => {
    const { name, description } = (item ?? {}) as Record<string, unknown>
    return typeof name === 'string' && SKILL_NAME.test(name) && typeof description === 'string'
      ? [{ name, description }]
      : []
  })
  return { version: 1, fetchedAt, commit, dir, skills: kept }
}

export function skillsCatalogFile(userDataPath: string, log: LogFn): JsonFile<SkillsCatalogFile> {
  return new JsonFile<SkillsCatalogFile>({
    file: path.join(userDataPath, 'state', 'market-skills.json'),
    version: 1,
    migrations: {},
    parse: parseSkillsCatalogFile,
    empty: () => ({ version: 1, fetchedAt: null, commit: null, dir: null, skills: [] }),
    log,
  })
}

/** The folder a kept skill lives under, from its id alone: one root that holds that one skill. */
export function skillFolder(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `${slug}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

/** Whether a kept skill goes to an agent. */
export function skillFor(skill: MarketSkill, agentId: AgentId): boolean {
  return skill.on && (skill.agents === 'all' || skill.agents.includes(agentId))
}

/**
 * The folders under `root` that hold no skill the settings keep, and were not written in the last
 * ten minutes, since the settings name a new skill only after its files are copied.
 */
export function prunable(
  folders: readonly { name: string; modifiedAt: number }[],
  kept: ReadonlySet<string>,
  now: number,
): string[] {
  return folders
    .filter((folder) => !kept.has(folder.name) && now - folder.modifiedAt >= PRUNE_GRACE_MS)
    .map((folder) => folder.name)
}

/** The folders of an archive that hold a SKILL.md, under `under`, deepest last. */
export function skillDirs(tarball: Tarball, under: string): string[] {
  const prefix = under === '' ? '' : `${under}/`
  return tarball.files
    .map((file) => file.path)
    .filter(
      (file) =>
        file === `${prefix}${SKILL_FILE}` ||
        (file.startsWith(prefix) && file.endsWith(`/${SKILL_FILE}`)),
    )
    .map((file) => file.slice(0, Math.max(0, file.length - SKILL_FILE.length - 1)))
    .sort()
}

/** A skill's name and description from its SKILL.md, or why it is not a skill Kettu keeps. */
export function skillInfo(text: string, fallback: string): { name: string; description: string } {
  const fields = frontmatter(text)
  const name = (fields.name ?? fallback).trim()
  const description = (fields.description ?? '').replace(/\s+/g, ' ').trim()
  if (!SKILL_NAME.test(name)) {
    throw new HostError(
      'invalid_params',
      `"${name}" is not a skill name: lowercase letters, digits and hyphens`,
    )
  }
  if (description === '')
    throw new HostError('invalid_params', `The skill ${name} has no description`)
  return { name, description: description.slice(0, DESCRIPTION_CHARS) }
}

/**
 * OpenCode's environment with Kettu's skill folders added to `OPENCODE_CONFIG_CONTENT`, the
 * configuration it reads beside the user's files; the user's own value keeps what it says.
 */
export function opencodeEnv(env: Env, roots: readonly string[], log?: LogFn): Env {
  if (roots.length === 0) return env
  const own = env.OPENCODE_CONFIG_CONTENT
  let config: Record<string, unknown> = {}
  if (own !== undefined && own.trim() !== '') {
    try {
      const parsed = JSON.parse(own) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
      config = parsed as Record<string, unknown>
    } catch {
      log?.('warn', 'OPENCODE_CONFIG_CONTENT is not a JSON object; OpenCode gets no Kettu skills')
      return env
    }
  }
  const skills = config.skills
  const before = Array.isArray(skills)
    ? skills
    : typeof skills === 'object' &&
        skills !== null &&
        Array.isArray((skills as { paths?: unknown }).paths)
      ? (skills as { paths: unknown[] }).paths
      : []
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, skills: [...before, ...roots] }),
  }
}

export interface SkillsDeps {
  userDataPath: string
  file: JsonFile<SkillsCatalogFile>
  log: LogFn
  platform: Platform
  home: string
  /** The skills the settings keep. */
  settings(): readonly MarketSkill[]
  /** The agents that are turned on. */
  agents(): AgentId[]
  /** The agent's own configuration folder. */
  configFolder(agentId: AgentId): string | null
  /** Codex's own skills from the agent's app-server; null when it is not installed. */
  codexSkills(agentId: AgentId): Promise<SkillsListResponse | null>
  fetch?: typeof fetch
  now?: () => number
}

/** A copied skill's files, each by its path inside the skill's folder. */
type SkillFiles = Pick<TarFile, 'path' | 'data' | 'mode'>[]

export class MarketSkillsService {
  private kept: SkillsCatalogFile | null = null
  private loading: Promise<SkillsCatalogFile> | null = null
  private reading: Promise<string | null> | null = null
  /** The kept skills' folders on disk, by folder name. */
  private present = new Set<string>()
  /** Each agent's generated Claude Code plugin. */
  private readonly plugins = new Map<AgentId, string>()
  private syncing: Promise<void> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly deps: SkillsDeps) {
    this.now = deps.now ?? Date.now
  }

  private get root(): string {
    return path.join(this.deps.userDataPath, 'marketplace')
  }

  private get store(): string {
    return path.join(this.root, 'skills')
  }

  private catalogDir(dir: string): string {
    return path.join(this.root, 'catalog', 'anthropics-skills', dir)
  }

  /** The catalog and the agents' own skills; the catalog is read again a day on, or on `refresh`. */
  async skills(refresh = false): Promise<MarketSkills> {
    const [error, own] = await Promise.all([this.readCatalog(refresh), this.ownSkills()])
    const kept = await this.load()
    const catalog = kept.skills.map((skill): CatalogSkill => ({
      id: `${CATALOG_PREFIX}${skill.name}`,
      name: skill.name,
      description: skill.description,
      publisher: 'Anthropic',
      official: true,
      repository: CATALOG_REPOSITORY,
      path: `${CATALOG_FOLDER}/${skill.name}`,
      version: kept.commit,
    }))
    return { catalog, own, error }
  }

  /** Copies a skill's files onto the host and returns the entry the settings then keep. */
  async add(source: SkillSource): Promise<MarketSkill> {
    if (source.kind === 'catalog') return this.addFromCatalog(source.id)
    if (source.kind === 'github') return this.addFromGithub(source.url)
    return this.addFromFolder(source.path)
  }

  /** The skill folders the agent gets, each holding one skill, in the settings' order. */
  roots(agentId: AgentId): string[] {
    return this.deps
      .settings()
      .filter((skill) => skillFor(skill, agentId) && this.present.has(skillFolder(skill.id)))
      .map((skill) => path.join(this.store, skillFolder(skill.id)))
  }

  /** What an attach of the agent's session gets: skill folders for Codex, a plugin for Claude Code. */
  sessionOptions(agentId: AgentId): Pick<SessionOptions, 'skillRoots' | 'localPlugins'> {
    const harness = harnessOf(agentId)
    if (harness === 'codex') return { skillRoots: this.roots(agentId) }
    if (harness === 'claude-code') {
      const plugin = this.plugins.get(agentId)
      return plugin ? { localPlugins: [plugin] } : {}
    }
    return {}
  }

  /** OpenCode's environment as its process starts, with the agent's skill folders. */
  launchEnv(agentId: AgentId, env: Env): Env {
    return harnessOf(agentId) === 'opencode'
      ? opencodeEnv(env, this.roots(agentId), this.deps.log)
      : env
  }

  /**
   * Brings the disk in line with the settings: the folders of skills that left them go after the
   * grace, and each Claude Code agent's plugin links the skills it gets. One sync runs at a time.
   */
  sync(): Promise<void> {
    this.syncing = this.syncing.then(
      () => this.syncNow(),
      () => this.syncNow(),
    )
    return this.syncing
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  private async syncNow(): Promise<void> {
    try {
      await mkdir(this.store, { recursive: true })
      const entries = await readdir(this.store, { withFileTypes: true })
      const folders = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => ({
            name: entry.name,
            modifiedAt: (await stat(path.join(this.store, entry.name))).mtimeMs,
          })),
      )
      const kept = new Set(this.deps.settings().map((skill) => skillFolder(skill.id)))
      for (const name of prunable(folders, kept, this.now())) {
        await rm(path.join(this.store, name), { recursive: true, force: true })
      }
      this.present = new Set(
        folders
          .map((folder) => folder.name)
          .filter((name) => kept.has(name) && !name.startsWith(PARTIAL)),
      )
      for (const agentId of this.deps.agents()) {
        if (harnessOf(agentId) === 'claude-code') await this.writeClaudePlugin(agentId)
      }
    } catch (error) {
      this.deps.log(
        'warn',
        `Could not bring the Marketplace's skills up to date: ${(error as Error).message}`,
      )
    }
  }

  /**
   * The agent's plugin of Kettu's skills: `.claude-plugin/plugin.json` and a link in `skills/` to
   * each skill it gets, junctions on Windows. None when it gets no skill.
   */
  private async writeClaudePlugin(agentId: AgentId): Promise<void> {
    const folder = path.join(this.root, 'claude', skillFolder(agentId))
    const wanted = new Map<string, string>()
    for (const skill of this.deps.settings()) {
      const dir = skillFolder(skill.id)
      if (!skillFor(skill, agentId) || !this.present.has(dir)) continue
      let name = skill.name
      for (let n = 2; wanted.has(name); n++) name = `${skill.name}-${n}`
      wanted.set(name, path.join(this.store, dir, skill.name))
    }
    if (wanted.size === 0) {
      this.plugins.delete(agentId)
      await rm(folder, { recursive: true, force: true })
      return
    }
    await mkdir(path.join(folder, '.claude-plugin'), { recursive: true })
    const manifest = `${JSON.stringify({ name: 'kettu', description: 'Skills Kettu adds from its Marketplace', version: '1.0.0' }, null, 2)}\n`
    await writeFile(path.join(folder, '.claude-plugin', 'plugin.json'), manifest)
    const links = path.join(folder, 'skills')
    await mkdir(links, { recursive: true })
    for (const entry of await readdir(links)) {
      const link = path.join(links, entry)
      const target = await readlink(link).catch(() => null)
      if (target !== null && wanted.get(entry) === target) {
        wanted.delete(entry)
        continue
      }
      await rm(link, { recursive: true, force: true })
    }
    for (const [name, target] of wanted) {
      await symlink(
        target,
        path.join(links, name),
        this.deps.platform === 'win32' ? 'junction' : 'dir',
      )
    }
    this.plugins.set(agentId, folder)
  }

  private async addFromCatalog(id: string): Promise<MarketSkill> {
    if (!id.startsWith(CATALOG_PREFIX))
      throw new HostError('invalid_params', `${id} is not in the catalog`)
    let kept = await this.load()
    if (kept.dir === null) {
      await this.readCatalog(false)
      kept = await this.load()
    }
    const name = id.slice(CATALOG_PREFIX.length)
    const listed = kept.skills.find((skill) => skill.name === name)
    if (!listed || kept.dir === null)
      throw new HostError('not_found', `The catalog has no skill ${name}`)
    const files = await readFolder(path.join(this.catalogDir(kept.dir), name))
    const info = skillInfo(skillText(files), name)
    await this.keep(id, info.name, files)
    return {
      id,
      name: info.name,
      description: info.description,
      source: 'catalog',
      origin: CATALOG_REPOSITORY,
      version: kept.commit,
      agents: 'all',
      on: true,
    }
  }

  private async addFromGithub(url: string): Promise<MarketSkill> {
    const source = githubSource(url)
    if (!source) {
      throw new HostError('invalid_params', 'Give a github.com repository, or a folder in one')
    }
    const tarball = await this.download(tarballUrl(source))
    const dirs = skillDirs(tarball, source.path)
    if (dirs.length === 0) throw new HostError('not_found', `There is no ${SKILL_FILE} in ${url}`)
    if (dirs.length > 1) {
      throw new HostError(
        'invalid_params',
        `${url} holds ${dirs.length} skills; give the folder of one of them`,
      )
    }
    const folder = dirs[0]!
    const files = await this.within(() => folderFiles(tarball, folder, SKILL_LIMITS))
    const info = skillInfo(skillText(files), folder.split('/').pop() || source.repo)
    const id = `github:${source.owner}/${source.repo}${folder ? `/${folder}` : ''}`
    await this.keep(id, info.name, files)
    return {
      id,
      name: info.name,
      description: info.description,
      source: 'github',
      origin: `https://github.com/${source.owner}/${source.repo}`,
      version: tarball.commit ?? source.ref,
      agents: 'all',
      on: true,
    }
  }

  private async addFromFolder(folder: string): Promise<MarketSkill> {
    const info = await stat(folder).catch(() => null)
    if (!info?.isDirectory()) throw new HostError('not_found', `${folder} is not a folder`)
    const files = await readFolder(folder)
    if (!files.some((file) => file.path === SKILL_FILE)) {
      throw new HostError('invalid_params', `${folder} has no ${SKILL_FILE}`)
    }
    const skill = skillInfo(skillText(files), path.basename(folder))
    const id = `local:${randomUUID()}`
    await this.keep(id, skill.name, files)
    return {
      id,
      name: skill.name,
      description: skill.description,
      source: 'local',
      origin: folder,
      version: null,
      agents: 'all',
      on: true,
    }
  }

  /** Writes a skill's files as `<store>/<folder of id>/<name>/`, in place of any copy before. */
  private async keep(id: string, name: string, files: SkillFiles): Promise<void> {
    const dir = skillFolder(id)
    const partial = path.join(this.store, `${PARTIAL}${randomUUID()}`)
    try {
      await writeFiles(path.join(partial, name), files)
      await rm(path.join(this.store, dir), { recursive: true, force: true })
      await rename(partial, path.join(this.store, dir))
    } catch (error) {
      await rm(partial, { recursive: true, force: true })
      throw error
    }
    this.present.add(dir)
  }

  private async download(url: string): Promise<Tarball> {
    return this.within(async () => {
      const gz = await downloadTarball(url, TAR_LIMITS, this.deps.fetch)
      return readTarball(gz, TAR_LIMITS)
    })
  }

  /** Runs a read of a repository, its failures given as the request's. */
  private async within<T>(run: () => T | Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof HostError) throw error
      throw new HostError('unavailable', (error as Error).message)
    }
  }

  /** Reads the catalog again when it is a day old or `refresh` asks; the reason when it could not. */
  private readCatalog(refresh: boolean): Promise<string | null> {
    this.reading ??= this.readCatalogNow(refresh).finally(() => (this.reading = null))
    return this.reading
  }

  private async readCatalogNow(refresh: boolean): Promise<string | null> {
    const kept = await this.load()
    const fresh =
      kept.fetchedAt !== null &&
      kept.dir !== null &&
      this.now() - kept.fetchedAt < DAY_MS &&
      (await stat(this.catalogDir(kept.dir)).catch(() => null)) !== null
    if (fresh && !refresh) return null
    const partial = this.catalogDir(`${PARTIAL.slice(1)}${randomUUID()}`)
    try {
      const tarball = await this.download(CATALOG_URL)
      const dir = tarball.commit ?? `at-${this.now()}`
      const skills: SkillsCatalogFile['skills'] = []
      for (const folder of skillDirs(tarball, CATALOG_FOLDER)) {
        const name = folder.slice(CATALOG_FOLDER.length + 1)
        if (name.includes('/')) continue
        try {
          const files = folderFiles(tarball, folder, SKILL_LIMITS)
          const info = skillInfo(skillText(files), name)
          if (info.name !== name) throw new Error(`its SKILL.md names it ${info.name}`)
          await writeFiles(path.join(partial, name), files)
          skills.push(info)
        } catch (error) {
          this.deps.log('warn', `The skills catalog left out ${name}: ${(error as Error).message}`)
        }
      }
      await rm(this.catalogDir(dir), { recursive: true, force: true })
      await mkdir(partial, { recursive: true })
      await rename(partial, this.catalogDir(dir))
      const previous = kept.dir
      this.kept = { version: 1, fetchedAt: this.now(), commit: tarball.commit, dir, skills }
      this.deps.file.save(this.kept)
      if (previous !== null && previous !== dir) {
        await rm(this.catalogDir(previous), { recursive: true, force: true })
      }
      return null
    } catch (error) {
      await rm(partial, { recursive: true, force: true })
      const message = (error as Error).message
      this.deps.log('warn', `The skills catalog is from before: ${message}`)
      return message
    }
  }

  /** The skills each agent that is turned on has of its own, read only. */
  private async ownSkills(): Promise<AgentOwnSkill[]> {
    const lists = await Promise.all(
      this.deps.agents().map(async (agentId) => {
        try {
          return await this.ownSkillsOf(agentId)
        } catch (error) {
          this.deps.log(
            'warn',
            `Could not read ${agentId}'s own skills: ${(error as Error).message}`,
          )
          return []
        }
      }),
    )
    return lists.flat()
  }

  private async ownSkillsOf(agentId: AgentId): Promise<AgentOwnSkill[]> {
    const harness = harnessOf(agentId)
    const config = this.deps.configFolder(agentId)
    const { home } = this.deps
    const agents = path.join(home, '.agents', 'skills')
    switch (harness) {
      case 'codex': {
        const response = await this.deps.codexSkills(agentId)
        if (!response) return []
        const store = path.resolve(this.store) + path.sep
        return codexOwnSkills(response, agentId, (file) => path.resolve(file).startsWith(store))
      }
      case 'claude-code':
        return config ? readSkillFolders(agentId, [path.join(config, 'skills')], 1) : []
      case 'opencode':
        return readSkillFolders(
          agentId,
          [
            ...(config ? [path.join(config, 'skills')] : []),
            path.join(home, '.claude', 'skills'),
            agents,
          ],
          1,
        )
      case 'pi':
        // Pi finds the folders with a SKILL.md at any depth under its own.
        return readSkillFolders(
          agentId,
          [...(config ? [path.join(config, 'skills')] : []), agents],
          3,
        )
      default:
        return []
    }
  }

  private load(): Promise<SkillsCatalogFile> {
    if (this.kept) return Promise.resolve(this.kept)
    this.loading ??= this.deps.file.load().then(
      (file) => (this.kept = file),
      (error: unknown) => {
        this.deps.log('warn', `Could not read the skills catalog: ${(error as Error).message}`)
        return (this.kept = { version: 1, fetchedAt: null, commit: null, dir: null, skills: [] })
      },
    )
    return this.loading
  }
}

function skillText(files: SkillFiles): string {
  const file = files.find((item) => item.path === SKILL_FILE)
  if (!file) throw new HostError('invalid_params', `The skill has no ${SKILL_FILE}`)
  return file.data.subarray(0, SKILL_MD_BYTES).toString('utf8')
}

async function writeFiles(dir: string, files: SkillFiles): Promise<void> {
  for (const file of files) {
    const target = path.join(dir, ...file.path.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    // Scripts keep their run bit; nothing else of the archive's modes comes along.
    await writeFile(target, file.data, { mode: file.mode & 0o111 ? 0o755 : 0o644 })
  }
}

/** A local folder's files, refusing a link and stopping at the limits. */
async function readFolder(root: string): Promise<SkillFiles> {
  const files: SkillFiles = []
  let bytes = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) {
        throw new HostError(
          'invalid_params',
          `The skill holds a link, which Kettu does not copy: ${relative}`,
        )
      }
      if (entry.isDirectory()) {
        await walk(full, relative)
        continue
      }
      if (!entry.isFile()) continue
      const info = await lstat(full)
      bytes += info.size
      if (files.length >= SKILL_LIMITS.files) {
        throw new HostError(
          'invalid_params',
          `The skill holds more than ${SKILL_LIMITS.files} files`,
        )
      }
      if (bytes > SKILL_LIMITS.bytes) {
        throw new HostError(
          'invalid_params',
          `The skill is larger than ${SKILL_LIMITS.bytes / (1024 * 1024)} MB`,
        )
      }
      files.push({ path: relative, data: await readFile(full), mode: info.mode })
    }
  }
  await walk(root, '')
  return files
}

/** The skills in `roots`, each a folder with a SKILL.md, found down to `depth` levels. */
async function readSkillFolders(
  agentId: AgentId,
  roots: readonly string[],
  depth: number,
): Promise<AgentOwnSkill[]> {
  const out: AgentOwnSkill[] = []
  const seen = new Set<string>()
  const visit = async (dir: string, level: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      const folder = path.join(dir, entry.name)
      const file = path.join(folder, SKILL_FILE)
      const text = await readText(file)
      if (text !== null) {
        if (seen.has(folder)) continue
        seen.add(folder)
        const fields = frontmatter(text)
        out.push({
          agentId,
          name: (fields.name ?? entry.name).trim() || entry.name,
          description: (fields.description ?? '').replace(/\s+/g, ' ').trim(),
          path: file,
          enabled: true,
          plugin: null,
        })
      } else if (level < depth) {
        await visit(folder, level + 1)
      }
    }
  }
  for (const root of roots) await visit(root, 1)
  return out
}

/** The start of a file, which holds a SKILL.md's frontmatter; null when it is no file. */
async function readText(file: string): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
    if (!(await handle.stat()).isFile()) return null
    const buffer = Buffer.alloc(SKILL_MD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SKILL_MD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}
