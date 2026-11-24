// The Marketplace's skills: the catalog of the skill repositories the app lists, each unpacked into
// the host's data and checked again a day on; the skills Kettu keeps on the host, copied from that
// catalog, a GitHub folder or a local one; what each agent is handed at a session's start, Kettu's
// own skills with them; and the skills the agents have of their own, read only.

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
import {
  MARKET_KEPT_MS,
  SKILL_NAME,
  catalogSkillId,
  skillRepositoryId,
  type AgentOwnSkill,
  type CatalogSkill,
  type MarketSkill,
  type MarketSkillRepository,
  type MarketSkills,
  type SkillRepository,
  type SkillSource,
} from '@shared/marketplace'
import type { Platform } from '@shared/platform'
import { harnessOf, type AgentId } from '@shared/thread'
import type { SkillsListResponse } from '../codex/protocol'
import type { SessionOptions } from '../connection'
import { HostError } from '../errors'
import type { Env } from '../find-command'
import { kettuSkills, type GuideFlags } from '../guide/guide'
import { kettuSkillDirs, kettuSkillRoot, writeKettuSkills } from '../guide/skill-files'
import { t } from '../i18n'
import { JsonFile, type LogFn } from '../storage'
import { kettuId } from '@shared/market-community'
import type { MarketListing } from '@shared/market-publish'
import { skillRoute, type SessionSkill } from './skill-tools'
import { modeOf, type DownloadedFile } from './community'
import { frontmatter } from './frontmatter'
import { logText } from '../localized-error'
import {
  SKILL_FILE,
  SKILL_MD_BYTES,
  SKILL_REPOSITORIES,
  repositoryId,
  repositorySkills,
  repositoryUrl,
  skillFields,
  type CatalogEntry,
  type SkillRepositorySpec,
} from './skill-catalog'
import {
  branchHead,
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

export { SKILL_NAME }

/** A copied skill's folder stays this long without an entry, which the settings add after it. */
export const PRUNE_GRACE_MS = 10 * 60_000
const TAR_LIMITS: TarLimits = {
  downloadBytes: 64 * 1024 * 1024,
  unpackedBytes: 256 * 1024 * 1024,
  timeoutMs: 120_000,
}
const SKILL_LIMITS: FolderLimits = { files: 1_000, bytes: 50 * 1024 * 1024 }
const PARTIAL = '.partial-'
const MAX_PATH = 512
const MAX_LICENSE = 512
const MAX_TOOLS = 64
const MAX_TOOL = 200

/** A repository's copy as last unpacked: its skills at one commit. */
export interface RepositoryCopy {
  /** When the copy was last known to be its branch's: read, or the branch found where it was. */
  fetchedAt: number | null
  commit: string | null
  /** GitHub's ETag for the branch's commit, sent back with the next check. */
  etag: string | null
  /** The folder under the repository's catalog folder that holds the copy. */
  dir: string | null
  skills: CatalogEntry[]
}

/** The catalog as last read: each repository's copy, by `<owner>/<repo>`. */
export interface SkillsCatalogFile {
  version: 2
  repositories: Record<string, RepositoryCopy>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/\p{Cc}/u.test(value)

export const SKILLS_CATALOG_MIGRATIONS = {
  // Version 1 kept Anthropic's repository alone, without licenses or tools: its copy stays listed,
  // and with no commit the next read downloads it again.
  1: (data: Record<string, unknown>): Record<string, unknown> => ({
    repositories: {
      'anthropics/skills': {
        fetchedAt: null,
        commit: null,
        etag: null,
        dir: data.dir ?? null,
        skills: Array.isArray(data.skills)
          ? data.skills.map((item: unknown) =>
              isRecord(item)
                ? { ...item, path: `skills/${String(item.name)}`, license: null, allowedTools: [] }
                : item,
            )
          : data.skills,
      },
    },
  }),
}

function parseCopy(raw: unknown): RepositoryCopy | string {
  if (!isRecord(raw)) return 'is not an object'
  const { fetchedAt, commit, etag, dir, skills } = raw
  if (fetchedAt !== null && typeof fetchedAt !== 'number') return 'fetchedAt is not a time'
  if (commit !== null && typeof commit !== 'string') return 'commit is not a string'
  if (etag !== null && !isText(etag, MAX_PATH)) return 'etag is not a string'
  if (dir !== null && (typeof dir !== 'string' || !/^[A-Za-z0-9-]+$/.test(dir))) {
    return 'dir is not a folder name'
  }
  if (!Array.isArray(skills)) return 'skills is not a list'
  const kept = skills.flatMap((item: unknown): CatalogEntry[] => {
    if (!isRecord(item)) return []
    const { name, description, path: folder, license, allowedTools } = item
    if (typeof name !== 'string' || !SKILL_NAME.test(name) || typeof description !== 'string') {
      return []
    }
    if (!isText(folder, MAX_PATH) || (license !== null && !isText(license, MAX_LICENSE))) return []
    if (!Array.isArray(allowedTools) || allowedTools.length > MAX_TOOLS) return []
    if (!allowedTools.every((tool) => isText(tool, MAX_TOOL))) return []
    return [{ name, description, path: folder, license, allowedTools: allowedTools as string[] }]
  })
  return { fetchedAt, commit, etag, dir, skills: kept }
}

export function parseSkillsCatalogFile(data: Record<string, unknown>): SkillsCatalogFile | string {
  if (!isRecord(data.repositories)) return 'repositories is not an object'
  const repositories: Record<string, RepositoryCopy> = {}
  for (const [id, raw] of Object.entries(data.repositories)) {
    if (!skillRepositoryId(id)) return `${id} is not a repository`
    const copy = parseCopy(raw)
    if (typeof copy === 'string') return `${id} ${copy}`
    repositories[id] = copy
  }
  return { version: 2, repositories }
}

export function skillsCatalogFile(userDataPath: string, log: LogFn): JsonFile<SkillsCatalogFile> {
  return new JsonFile<SkillsCatalogFile>({
    file: path.join(userDataPath, 'state', 'market-skills.json'),
    version: 2,
    migrations: SKILLS_CATALOG_MIGRATIONS,
    parse: parseSkillsCatalogFile,
    empty: () => ({ version: 2, repositories: {} }),
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
  try {
    return skillFields(text, fallback)
  } catch (error) {
    throw new HostError('invalid_params', (error as Error).message)
  }
}

/** The skill Kettu keeps under another id with this name, which an agent would take for it. */
function sameName(kept: readonly MarketSkill[], id: string, name: string): MarketSkill | null {
  return kept.find((skill) => skill.name === name && skill.id !== id) ?? null
}

/** A plugin's links by name: `first` as named, then `rest`, a taken name numbered from 2. */
function linkNames(
  first: readonly [string, string][],
  rest: readonly [string, string][],
): Map<string, string> {
  const wanted = new Map(first)
  for (const [name, target] of rest) {
    let link = name
    for (let n = 2; wanted.has(link); n++) link = `${name}-${n}`
    wanted.set(link, target)
  }
  return wanted
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
  /** A skill listing of the Kettu Marketplace, its current version downloaded and checked. */
  kettu(id: string): Promise<{ listing: MarketListing; files: DownloadedFile[] }>
  /**
   * The features that decide which of Kettu's own skills an agent that reaches Kettu's server is
   * handed; without it, none.
   */
  ownSkills?(): GuideFlags
  /** Whether Kettu's server is on for the agent, as a process of it that starts now takes it. */
  kettuOn?(agentId: AgentId): boolean
  /** The catalog's repositories; the app's list when not given. */
  repositories?: readonly SkillRepositorySpec[]
  fetch?: typeof fetch
  now?: () => number
}

/** What a read of a repository left: whether there is a copy, and whether it is old. */
interface CopyState {
  read: boolean
  stale: boolean
}

/** A copied skill's files, each by its path inside the skill's folder. */
type SkillFiles = Pick<TarFile, 'path' | 'data' | 'mode'>[]

export class MarketSkillsService {
  private kept: SkillsCatalogFile | null = null
  private loading: Promise<SkillsCatalogFile> | null = null
  /** The reads under way, by repository. */
  private readonly reading = new Map<string, Promise<void>>()
  /** Why each repository's last read failed, until one succeeds. */
  private readonly failures = new Map<string, string>()
  /** The kept skills' folders on disk, by folder name. */
  private present = new Set<string>()
  /** Each Claude Code agent's generated plugin of the Marketplace's skills. */
  private readonly plugins = new Map<AgentId, string>()
  /** The same with Kettu's own skills, for a session that reaches Kettu's server. */
  private readonly kettuPlugins = new Map<AgentId, string>()
  /** The Claude Code agents whose plugins are written. */
  private readonly written = new Set<AgentId>()
  /**
   * The folders of Kettu's own skills handed to agents since the host started: they may still read
   * them, so a sync keeps them until the next start.
   */
  private readonly handedOwn = new Set<string>()
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

  /** Where Kettu's own skills are kept. */
  private get kettuRoot(): string {
    return path.join(this.root, 'kettu-skills')
  }

  private get specs(): readonly SkillRepositorySpec[] {
    return this.deps.repositories ?? SKILL_REPOSITORIES
  }

  private catalogDir(spec: SkillRepositorySpec, dir: string): string {
    return path.join(this.root, 'catalog', `${spec.owner}-${spec.repo}`, dir)
  }

  /**
   * The catalog and the agents' own skills; every repository is read at once, each again a day on
   * or on `refresh`. `cached` reads none and takes the copies there are, however old, saying
   * which are, and which repositories have none yet.
   */
  async skills(refresh = false, cached = false): Promise<MarketSkills> {
    const [states, own] = await Promise.all([
      Promise.all(this.specs.map((spec) => this.readRepository(spec, refresh, cached))),
      this.ownSkills(),
    ])
    const kept = await this.load()
    const repositories = this.specs.map((spec, i) => this.repositoryOf(spec, states[i]!))
    const catalog = this.specs.flatMap((spec, i) => this.catalogOf(spec, kept, states[i]!))
    const failed = repositories.filter((repository) => repository.error !== null)
    const error =
      failed.length === 0 ? null : failed.map((r) => `${r.id}: ${r.error ?? ''}`).join('; ')
    const stale = states.some((state) => state.stale || !state.read)
    const flags = this.deps.ownSkills?.()
    const builtIn = flags
      ? kettuSkills(flags).map(({ name, description }) => ({ name, description }))
      : []
    return { catalog, own, error, ...(cached && { stale }), repositories, builtIn }
  }

  /** One repository of the catalog, read as `skills` reads each. */
  async repository(id: string, refresh = false): Promise<MarketSkillRepository> {
    const spec = this.specs.find((item) => repositoryId(item) === id)
    if (!spec) throw new HostError('not_found', t('marketSkills.notInCatalog', { id }))
    const state = await this.readRepository(spec, refresh, false)
    const kept = await this.load()
    return { repository: this.repositoryOf(spec, state), skills: this.catalogOf(spec, kept, state) }
  }

  private repositoryOf(spec: SkillRepositorySpec, state: CopyState): SkillRepository {
    const id = repositoryId(spec)
    return {
      id,
      publisher: spec.publisher,
      trust: spec.trust,
      url: repositoryUrl(spec),
      read: state.read,
      error: this.failures.get(id) ?? null,
      ...(state.stale && { stale: true }),
    }
  }

  private catalogOf(
    spec: SkillRepositorySpec,
    kept: SkillsCatalogFile,
    state: CopyState,
  ): CatalogSkill[] {
    const copy = kept.repositories[repositoryId(spec)]
    if (!copy || !state.read) return []
    return copy.skills.map((skill) => ({
      id: `${repositoryId(spec)}:${skill.name}`,
      name: skill.name,
      description: skill.description,
      publisher: spec.publisher,
      official: spec.trust === 'official',
      trust: spec.trust,
      repository: repositoryUrl(spec),
      path: skill.path,
      version: copy.commit,
      license: skill.license,
      allowedTools: skill.allowedTools,
    }))
  }

  /** Copies a skill's files onto the host and returns the entry the settings then keep. */
  async add(source: SkillSource): Promise<MarketSkill> {
    if (source.kind === 'catalog') return this.addFromCatalog(source.id)
    if (source.kind === 'github') return this.addFromGithub(source.url)
    if (source.kind === 'kettu') return this.addFromKettu(source.id)
    return this.addFromFolder(source.path)
  }

  /**
   * Copies a skill a plugin brings onto the host, by the id the settings then keep it under;
   * refused when another skill Kettu keeps has its name.
   */
  async keepFiles(id: string, name: string, files: SkillFiles): Promise<void> {
    skillInfo(skillText(files), name)
    await this.keep(id, name, files)
  }

  /** The skill folders the agent gets, each holding one skill, in the settings' order. */
  roots(agentId: AgentId): string[] {
    return this.deps
      .settings()
      .filter((skill) => skillFor(skill, agentId) && this.present.has(skillFolder(skill.id)))
      .map((skill) => path.join(this.store, skillFolder(skill.id)))
  }

  /** Kettu's own skill roots, for an agent that reaches Kettu's server. */
  private kettuRoots(): string[] {
    const flags = this.deps.ownSkills?.()
    if (!flags) return []
    const root = kettuSkillRoot(this.kettuRoot, flags)
    this.handedOwn.add(path.basename(root))
    return [root]
  }

  /** The folder of each of Kettu's own skills, for a plugin to link. */
  private kettuDirs(flags: GuideFlags): [string, string][] {
    this.handedOwn.add(path.basename(kettuSkillRoot(this.kettuRoot, flags)))
    return [...kettuSkillDirs(this.kettuRoot, flags)]
  }

  /** Whether the agent loads skill folders itself, Kettu's own skills among them. */
  loadsSkills(agentId: AgentId): boolean {
    return skillRoute(agentId) === 'folder'
  }

  /**
   * The skills a session of the agent reads with Kettu's skill tools, those a workflow step names
   * in `step` with them; null for an agent that loads skill folders itself.
   */
  sessionSkills(agentId: AgentId, step: readonly string[] = []): SessionSkill[] | null {
    if (skillRoute(agentId) === 'folder') return null
    const given = this.deps
      .settings()
      .filter((skill) => skillFor(skill, agentId) && this.present.has(skillFolder(skill.id)))
    return [...given, ...this.stepSkills(agentId, step)].map((skill) => ({
      name: skill.name,
      description: skill.description,
      dir: path.join(this.store, skillFolder(skill.id), skill.name),
    }))
  }

  /**
   * What an attach of the agent's session gets: skill folders for Codex and Pi, a plugin for
   * Claude Code; with Kettu's own skills when `kettu`, the session reaching Kettu's server, and the skills a
   * workflow step names in `step`, which its session gets whatever agent does it. Waits for a
   * sync under way, so the first sessions after a start get what it writes.
   */
  async sessionOptions(
    agentId: AgentId,
    kettu: boolean,
    step: readonly string[] = [],
  ): Promise<Pick<SessionOptions, 'skillRoots' | 'localPlugins'>> {
    await this.syncing
    const harness = harnessOf(agentId)
    const added = this.stepSkills(agentId, step)
    if (harness === 'codex' || harness === 'pi') {
      return {
        skillRoots: [
          ...(kettu ? this.kettuRoots() : []),
          ...this.roots(agentId),
          ...added.map((skill) => path.join(this.store, skillFolder(skill.id))),
        ],
      }
    }
    if (harness === 'claude-code') {
      // An agent added since the last sync, as one found on a first start is.
      if (!this.written.has(agentId)) await this.queued(() => this.writePlugins(agentId))
      if (added.length > 0) {
        const plugin = await this.stepPlugin(agentId, kettu, added)
        if (plugin) return { localPlugins: [plugin] }
      }
      const plugin = (kettu ? this.kettuPlugins : this.plugins).get(agentId)
      return plugin ? { localPlugins: [plugin] } : {}
    }
    return {}
  }

  /** The skills a step names that are on and on disk, and that the agent does not get anyway. */
  private stepSkills(agentId: AgentId, names: readonly string[]): MarketSkill[] {
    if (names.length === 0) return []
    return this.deps
      .settings()
      .filter(
        (skill) =>
          skill.on &&
          (names.includes(skill.name) || names.includes(skill.id)) &&
          !skillFor(skill, agentId) &&
          this.present.has(skillFolder(skill.id)),
      )
  }

  /**
   * Claude Code's plugin for a step's session: the agent's own skills, Kettu's first when `kettu`,
   * and the step's. Its folder is named by what it adds, so the step's sessions share it.
   */
  private async stepPlugin(
    agentId: AgentId,
    kettu: boolean,
    added: readonly MarketSkill[],
  ): Promise<string | null> {
    const ids = new Set(added.map((skill) => skill.id))
    const key = createHash('sha256')
      .update(JSON.stringify([kettu, [...ids].sort()]))
      .digest('hex')
      .slice(0, 12)
    const folder = path.join(this.root, 'claude', `${skillFolder(agentId)}-step-${key}`)
    const made = new Map<AgentId, string>()
    await this.queued(async () => {
      const market: [string, string][] = []
      for (const skill of this.deps.settings()) {
        const dir = skillFolder(skill.id)
        if (!this.present.has(dir) || (!skillFor(skill, agentId) && !ids.has(skill.id))) continue
        market.push([skill.name, path.join(this.store, dir, skill.name)])
      }
      const own = kettu ? this.deps.ownSkills?.() : undefined
      const first = own ? this.kettuDirs(own) : []
      try {
        await this.writeClaudePlugin(made, agentId, folder, linkNames(first, market))
      } catch (error) {
        this.deps.log('warn', `Could not write a step's skills: ${(error as Error).message}`)
      }
    })
    return made.get(agentId) ?? null
  }

  /** OpenCode's environment as its process starts, with the agent's skill folders. */
  launchEnv(agentId: AgentId, env: Env): Env {
    if (harnessOf(agentId) !== 'opencode') return env
    const own = this.deps.kettuOn?.(agentId) ? this.kettuRoots() : []
    return opencodeEnv(env, [...own, ...this.roots(agentId)], this.deps.log)
  }

  /**
   * Brings the disk in line with the settings: Kettu's own skills are written for this version,
   * the folders of skills that left the settings go after the grace, and each Claude Code agent's
   * plugins link the skills it gets. One sync runs at a time.
   */
  sync(): Promise<void> {
    return this.queued(() => this.syncNow())
  }

  private queued(run: () => Promise<void>): Promise<void> {
    this.syncing = this.syncing.then(run, run)
    return this.syncing
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  private async syncNow(): Promise<void> {
    const flags = this.deps.ownSkills?.()
    if (flags) {
      try {
        await writeKettuSkills(this.kettuRoot, flags, this.handedOwn)
      } catch (error) {
        this.deps.log('warn', `Could not write Kettu's own skills: ${(error as Error).message}`)
      }
    }
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
        if (harnessOf(agentId) === 'claude-code') await this.writeClaudePlugins(agentId)
      }
    } catch (error) {
      this.deps.log(
        'warn',
        `Could not bring the Marketplace's skills up to date: ${(error as Error).message}`,
      )
    }
  }

  /** The agent's plugins, written outside a sync; a failure leaves its sessions without them. */
  private async writePlugins(agentId: AgentId): Promise<void> {
    try {
      await this.writeClaudePlugins(agentId)
    } catch (error) {
      this.deps.log('warn', `Could not write ${agentId}'s skills: ${(error as Error).message}`)
    }
  }

  /**
   * The agent's two plugins: one of the Marketplace's skills it gets, and one with Kettu's own
   * skills first, for a session that reaches Kettu's server. Both are named `kettu`.
   */
  private async writeClaudePlugins(agentId: AgentId): Promise<void> {
    const market: [string, string][] = []
    for (const skill of this.deps.settings()) {
      const dir = skillFolder(skill.id)
      if (!skillFor(skill, agentId) || !this.present.has(dir)) continue
      market.push([skill.name, path.join(this.store, dir, skill.name)])
    }
    const folder = path.join(this.root, 'claude', skillFolder(agentId))
    await this.writeClaudePlugin(this.plugins, agentId, folder, linkNames([], market))
    const own = this.deps.ownSkills?.()
    const first = own ? this.kettuDirs(own) : []
    await this.writeClaudePlugin(
      this.kettuPlugins,
      agentId,
      `${folder}-kettu`,
      linkNames(first, market),
    )
    this.written.add(agentId)
  }

  /**
   * A plugin of skills: `.claude-plugin/plugin.json` and a link in `skills/` to each skill it
   * holds, junctions on Windows. None when it holds no skill.
   */
  private async writeClaudePlugin(
    plugins: Map<AgentId, string>,
    agentId: AgentId,
    folder: string,
    wanted: Map<string, string>,
  ): Promise<void> {
    if (wanted.size === 0) {
      plugins.delete(agentId)
      await rm(folder, { recursive: true, force: true })
      return
    }
    await mkdir(path.join(folder, '.claude-plugin'), { recursive: true })
    const manifest = `${JSON.stringify({ name: 'kettu', description: "Kettu's skills", version: '1.0.0' }, null, 2)}\n`
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
    plugins.set(agentId, folder)
  }

  private async addFromCatalog(id: string): Promise<MarketSkill> {
    const parsed = catalogSkillId(id)
    const spec = parsed && this.specs.find((item) => repositoryId(item) === parsed.repository)
    if (!parsed || !spec) {
      throw new HostError('invalid_params', t('marketSkills.notInCatalog', { id }))
    }
    const state = await this.readRepository(spec, false, false)
    const copy = (await this.load()).repositories[parsed.repository]
    const listed = state.read ? copy?.skills.find((skill) => skill.name === parsed.name) : undefined
    if (!copy?.dir || !listed) {
      const failure = this.failures.get(parsed.repository)
      throw new HostError(
        failure ? 'unavailable' : 'not_found',
        failure ?? t('marketSkills.noSuchSkill', { name: parsed.name }),
      )
    }
    const files = await readFolder(path.join(this.catalogDir(spec, copy.dir), listed.name))
    const info = skillInfo(skillText(files), listed.name)
    await this.keep(id, info.name, files)
    return {
      id,
      name: info.name,
      description: info.description,
      source: 'catalog',
      origin: repositoryUrl(spec),
      version: copy.commit,
      agents: 'all',
      on: true,
    }
  }

  private async addFromGithub(url: string): Promise<MarketSkill> {
    const source = githubSource(url)
    if (!source) {
      throw new HostError('invalid_params', t('marketSkills.needsGithub'))
    }
    const tarball = await this.download(tarballUrl(source))
    const dirs = skillDirs(tarball, source.path)
    if (dirs.length === 0) {
      throw new HostError('not_found', t('marketSkills.noSkillFile', { file: SKILL_FILE, url }))
    }
    if (dirs.length > 1) {
      throw new HostError(
        'invalid_params',
        t('marketSkills.manySkills', { url, count: dirs.length }),
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

  /** Nothing is written unless every file of the version matched what the service listed. */
  private async addFromKettu(listingId: string): Promise<MarketSkill> {
    const { listing, files } = await this.deps.kettu(listingId)
    const copied = files.map((file) => ({ ...file, mode: modeOf(file.data) }))
    const info = skillInfo(skillText(copied), listing.slug)
    const id = kettuId(listing.id)
    await this.keep(id, info.name, copied)
    return {
      id,
      name: info.name,
      description: info.description,
      source: 'kettu',
      origin: `@${listing.handle}/${listing.slug}`,
      version: listing.version,
      agents: 'all',
      on: true,
    }
  }

  private async addFromFolder(folder: string): Promise<MarketSkill> {
    const info = await stat(folder).catch(() => null)
    if (!info?.isDirectory()) {
      throw new HostError('not_found', t('marketSkills.notFolder', { folder }))
    }
    const files = await readFolder(folder)
    if (!files.some((file) => file.path === SKILL_FILE)) {
      throw new HostError(
        'invalid_params',
        t('marketSkills.folderNoSkillFile', { folder, file: SKILL_FILE }),
      )
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

  /**
   * Writes a skill's files as `<store>/<folder of id>/<name>/`, in place of any copy before; none
   * when another skill Kettu keeps has its name, since an agent keeps only one of the two.
   */
  private async keep(id: string, name: string, files: SkillFiles): Promise<void> {
    const other = sameName(this.deps.settings(), id, name)
    if (other) {
      throw new HostError('conflict', t('marketSkills.nameTaken', { name, from: other.origin }))
    }
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

  /**
   * Reads a repository again when its copy is a day old or `refresh` asks; `cached` never reads.
   * One read of a repository runs at a time, and a failure is kept for its listing.
   */
  private async readRepository(
    spec: SkillRepositorySpec,
    refresh: boolean,
    cached: boolean,
  ): Promise<CopyState> {
    const id = repositoryId(spec)
    const copy = (await this.load()).repositories[id]
    const there = await this.hasCopy(spec, copy)
    const old = !copy?.fetchedAt || this.now() - copy.fetchedAt >= MARKET_KEPT_MS.skills
    if (cached || (there && !refresh && !old)) return { read: there, stale: there && old }
    let reading = this.reading.get(id)
    if (!reading) {
      reading = this.readRepositoryNow(spec).finally(() => this.reading.delete(id))
      this.reading.set(id, reading)
    }
    await reading
    return { read: await this.hasCopy(spec, (await this.load()).repositories[id]), stale: false }
  }

  private async hasCopy(spec: SkillRepositorySpec, copy: RepositoryCopy | undefined) {
    if (!copy?.dir) return false
    return (await stat(this.catalogDir(spec, copy.dir)).catch(() => null)) !== null
  }

  /**
   * Checks the branch's commit and downloads the tarball only when it moved, or when GitHub would
   * not say; the skills are unpacked beside the copy before, which goes once they are in place.
   */
  private async readRepositoryNow(spec: SkillRepositorySpec): Promise<void> {
    const id = repositoryId(spec)
    const copy = (await this.load()).repositories[id]
    let head: { commit: string; etag: string | null } | null = null
    const partial = this.catalogDir(spec, `${PARTIAL.slice(1)}${randomUUID()}`)
    try {
      if (copy?.commit && (await this.hasCopy(spec, copy))) {
        const answer = await branchHead(spec, copy.etag, this.deps.fetch)
        if (
          answer.kind === 'unchanged' ||
          (answer.kind === 'commit' && answer.commit === copy.commit)
        ) {
          const etag = answer.kind === 'commit' ? answer.etag : copy.etag
          this.saveCopy(id, { ...copy, fetchedAt: this.now(), etag })
          this.failures.delete(id)
          return
        }
        if (answer.kind === 'commit') head = answer
        else
          this.deps.log(
            'info',
            `Downloading ${id}, since GitHub did not say its commit: ${answer.reason}`,
          )
      }
      const tarball = await this.download(
        tarballUrl({ owner: spec.owner, repo: spec.repo, ref: spec.branch, path: '' }),
      )
      const dir = tarball.commit ?? `at-${this.now()}`
      const { skills, left } = repositorySkills(tarball, spec, SKILL_LIMITS)
      for (const skill of left) {
        this.deps.log('warn', `The skills catalog left out ${id}/${skill.path}: ${skill.reason}`)
      }
      for (const skill of skills)
        await writeFiles(path.join(partial, skill.entry.name), skill.files)
      await rm(this.catalogDir(spec, dir), { recursive: true, force: true })
      await mkdir(partial, { recursive: true })
      await rename(partial, this.catalogDir(spec, dir))
      this.saveCopy(id, {
        fetchedAt: this.now(),
        commit: tarball.commit,
        etag: head && head.commit === tarball.commit ? head.etag : null,
        dir,
        skills: skills.map((skill) => skill.entry),
      })
      if (copy?.dir && copy.dir !== dir) {
        await rm(this.catalogDir(spec, copy.dir), { recursive: true, force: true })
      }
      this.failures.delete(id)
    } catch (error) {
      await rm(partial, { recursive: true, force: true })
      this.failures.set(id, (error as Error).message)
      this.deps.log('warn', `The skills of ${id} are from before: ${logText(error)}`)
    }
  }

  private saveCopy(id: string, copy: RepositoryCopy): void {
    const kept = this.kept ?? { version: 2, repositories: {} }
    this.kept = { version: 2, repositories: { ...kept.repositories, [id]: copy } }
    this.deps.file.save(this.kept)
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
        const kept = [this.store, this.kettuRoot].map((dir) => path.resolve(dir) + path.sep)
        return codexOwnSkills(response, agentId, (file) =>
          kept.some((dir) => path.resolve(file).startsWith(dir)),
        )
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
        return (this.kept = { version: 2, repositories: {} })
      },
    )
    return this.loading
  }
}

function skillText(files: SkillFiles): string {
  const file = files.find((item) => item.path === SKILL_FILE)
  if (!file) {
    throw new HostError('invalid_params', t('marketSkills.noFile', { file: SKILL_FILE }))
  }
  return file.data.subarray(0, SKILL_MD_BYTES).toString('utf8')
}

async function writeFiles(dir: string, files: SkillFiles): Promise<void> {
  const root = path.resolve(dir)
  for (const file of files) {
    const target = path.resolve(root, ...file.path.split('/'))
    if (!target.startsWith(root + path.sep)) {
      throw new HostError('invalid_params', t('marketSkills.outside', { path: file.path }))
    }
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
        throw new HostError('invalid_params', t('marketSkills.link', { path: relative }))
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
          t('marketSkills.tooManyFiles', { count: SKILL_LIMITS.files }),
        )
      }
      if (bytes > SKILL_LIMITS.bytes) {
        throw new HostError(
          'invalid_params',
          t('marketSkills.tooLarge', { mb: SKILL_LIMITS.bytes / (1024 * 1024) }),
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

/**
 * The skills Codex has of its own: the user's, the admin's and its plugins', without Codex's
 * built-in ones and without those `isKettus` says Kettu hands it.
 */
function codexOwnSkills(
  response: SkillsListResponse,
  agentId: AgentId,
  isKettus: (path: string) => boolean,
): AgentOwnSkill[] {
  const seen = new Set<string>()
  return response.data
    .flatMap((entry) => entry.skills)
    .filter((skill) => skill.scope !== 'system' && !isKettus(skill.path))
    .filter((skill) => !seen.has(skill.path) && seen.add(skill.path))
    .map((skill) => ({
      agentId,
      name: skill.name,
      description: skill.shortDescription ?? skill.description,
      path: skill.path,
      enabled: skill.enabled,
      plugin: skill.pluginId ?? null,
    }))
}
