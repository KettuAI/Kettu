// The Kettu Marketplace as the host installs from it: its public listings and the account's own
// Only me ones, read through main or the daemon; a version's files, downloaded only on Install and
// each checked against the SHA-256 the service gave before anything is written; the plugins, kept
// in a local marketplace of each harness that the harness installs them from; and the workflows,
// written into the workflow library to wait for the user's approval.

import { createHash, randomUUID } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import {
  KETTU_PLUGINS,
  type BundleRef,
  type CommunityDirectory,
  type CommunityInstalled,
  type CommunityItem,
  type CommunityListing,
  type CommunityPlugin,
  type CommunityStanding,
  type CommunityWorkflow,
} from '@shared/market-community'
import {
  HANDLE,
  LISTING_ID,
  PUBLISH_LIMITS,
  VERSION,
  type MarketAccount,
  type MarketCall,
  type MarketListing,
  type MarketResults,
  type MineListing,
  type PublishHarness,
  type PublishKind,
  type VersionFile,
} from '@shared/market-publish'
import type { CatalogServer, InstalledPlugin, PluginScope } from '@shared/marketplace'
import { harnessOf, type AgentId } from '@shared/thread'
import { WORKFLOW_FILE_BYTES, type WorkflowEntry } from '@shared/workflow'
import { HostError } from '../errors'
import { t } from '../i18n'
import { JsonFile, type LogFn } from '../storage'
import { parseWorkflow } from '../workflow/format'
import type { CommunityOrigin } from '../workflow/library'
import { WORKFLOW_FILE, utf8 } from './publish-check'
import { MarketCallError } from './publish-tools'
import { catalogServer } from './registry'

const DIRECTORY_MS = 5 * 60_000
const STANDING_MS = 10 * 60_000
const DIRECTORIES = 30
const MAX_PATH = 512
const PARALLEL = 4
const SHA256 = /^[0-9a-f]{64}$/
// A plugin's name as the harnesses take it in a marketplace, and so its folder's name.
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PARTIAL = '.partial-'

const MANIFESTS: Record<PublishHarness, string> = {
  'claude-code': '.claude-plugin/plugin.json',
  codex: '.codex-plugin/plugin.json',
}

/** A file of a version, downloaded and checked. */
export interface DownloadedFile {
  path: string
  data: Buffer
}

/**
 * Whether a path the service names stays inside the folder it is written to on every system: one
 * relative path with `/` between its parts, none of them empty, `.`, `..` or `.git`, and no
 * character Windows would read as a drive, a stream or a device.
 */
export function safeFilePath(file: string): boolean {
  if (file.length === 0 || file.length > MAX_PATH) return false
  if (/[\\:*?"<>|#]/.test(file) || /\p{Cc}/u.test(file)) return false
  return file
    .split('/')
    .every(
      (part) =>
        part !== '' && part !== '.' && part !== '..' && part !== '.git' && !/[. ]$/.test(part),
    )
}

/** Whether the host may show and install a listing: anyone's, unless it is another's Only me. */
export function offered(listing: Pick<MarketListing, 'visibility' | 'mine'>): boolean {
  return listing.visibility !== 'private' || listing.mine === true
}

function refuse(message: string): HostError {
  return new HostError('invalid_params', message)
}

/** The files of a version as the service lists them, or why none of them is written. */
export function checkFileList(files: readonly VersionFile[]): void {
  if (files.length > PUBLISH_LIMITS.files) throw refuse(t('marketCommunity.tooLarge'))
  let bytes = 0
  const seen = new Set<string>()
  for (const file of files) {
    if (!safeFilePath(file.path)) {
      throw refuse(t('marketCommunity.badPath', { path: file.path.slice(0, MAX_PATH) }))
    }
    // Two paths that differ only in case are one file on macOS and Windows.
    const key = file.path.toLowerCase()
    if (seen.has(key)) throw refuse(t('marketCommunity.badPath', { path: file.path }))
    seen.add(key)
    if (!SHA256.test(file.sha256.toLowerCase())) {
      throw refuse(t('marketCommunity.mismatch', { path: file.path }))
    }
    bytes += file.size
    if (bytes > PUBLISH_LIMITS.bytes) throw refuse(t('marketCommunity.tooLarge'))
  }
}

/** Whether downloaded bytes are the file the version lists, by size and SHA-256. */
export function matches(file: VersionFile, data: Buffer, sent: string | null): boolean {
  if (data.byteLength !== file.size) return false
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== file.sha256.toLowerCase()) return false
  return sent === null || sent.toLowerCase() === actual
}

/** The service keeps no modes, so a script, which starts with `#!`, gets its run bit back. */
export function modeOf(data: Buffer): number {
  return data[0] === 0x23 && data[1] === 0x21 ? 0o755 : 0o644
}

/**
 * Writes files as `dir`, in place of what was there: into a folder beside it first, which is
 * renamed into place only once every file is written, so a failure leaves the old one.
 */
export async function writeFolder(dir: string, files: readonly DownloadedFile[]): Promise<void> {
  const partial = path.join(path.dirname(dir), `${PARTIAL}${randomUUID()}`)
  const root = path.resolve(partial)
  try {
    for (const file of files) {
      const target = path.resolve(root, ...file.path.split('/'))
      // Checked again where it is written, whatever the list said.
      if (!target.startsWith(root + path.sep)) {
        throw refuse(t('marketCommunity.badPath', { path: file.path }))
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, file.data, { mode: modeOf(file.data) })
    }
    await mkdir(root, { recursive: true })
    await rm(dir, { recursive: true, force: true })
    await rename(root, dir)
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function exists(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => null)) !== null
}

/** Renames a folder, or copies it and removes the old one when it is on another volume. */
async function moveFolder(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

/** Moves each plugin folder of one local marketplace into another that lacks it. */
async function movePlugins(from: string, to: string): Promise<void> {
  const names = await readdir(path.join(from, 'plugins')).catch(() => [])
  await mkdir(path.join(to, 'plugins'), { recursive: true })
  for (const name of names) {
    if (!PLUGIN_NAME.test(name)) continue
    const target = path.join(to, 'plugins', name)
    if (!(await exists(target))) await moveFolder(path.join(from, 'plugins', name), target)
  }
}

/**
 * The entries of a local marketplace's file that another Kettu data folder wrote, whose plugin
 * folders are still there; none when the file cannot be read.
 */
async function otherEntries(
  local: LocalMarketplace,
  ours: ReadonlySet<string>,
): Promise<{ name: string }[]> {
  let listed: unknown
  try {
    listed = (JSON.parse(await readFile(local.file, 'utf8')) as { plugins?: unknown }).plugins
  } catch {
    return []
  }
  const kept: { name: string }[] = []
  for (const entry of Array.isArray(listed) ? listed : []) {
    const name = (entry as { name?: unknown } | null)?.name
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name) || ours.has(name.toLowerCase())) {
      continue
    }
    if (await exists(path.join(local.dir, 'plugins', name))) kept.push(entry as { name: string })
  }
  return kept
}

/** The plugins installed from the Kettu Marketplace, by listing id. */
export interface CommunityRecords {
  version: 1
  plugins: Record<string, CommunityPlugin>
}

export function parseCommunityFile(data: Record<string, unknown>): CommunityRecords | string {
  const { plugins } = data
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
    return 'plugins is not an object'
  }
  const kept: Record<string, CommunityPlugin> = {}
  for (const [id, value] of Object.entries(plugins)) {
    const o = (value ?? {}) as Record<string, unknown>
    if (
      LISTING_ID.test(id) &&
      o.listingId === id &&
      (o.harness === 'claude-code' || o.harness === 'codex') &&
      typeof o.name === 'string' &&
      PLUGIN_NAME.test(o.name) &&
      typeof o.version === 'string' &&
      VERSION.test(o.version) &&
      typeof o.handle === 'string' &&
      HANDLE.test(o.handle) &&
      typeof o.slug === 'string' &&
      HANDLE.test(o.slug)
    ) {
      kept[id] = {
        listingId: id,
        harness: o.harness,
        name: o.name,
        version: o.version,
        handle: o.handle,
        slug: o.slug,
      }
    }
  }
  return { version: 1, plugins: kept }
}

export function communityFile(userDataPath: string, log: LogFn): JsonFile<CommunityRecords> {
  return new JsonFile<CommunityRecords>({
    file: path.join(userDataPath, 'state', 'market-community.json'),
    version: 1,
    migrations: {},
    parse: parseCommunityFile,
    empty: () => ({ version: 1, plugins: {} }),
    log,
  })
}

/** A harness's local marketplace of the Kettu Marketplace's plugins. */
export interface LocalMarketplace {
  /** Its folder, which the harness adds as a marketplace. */
  dir: string
  /** Its marketplace file, which Codex installs from. */
  file: string
}

export interface CommunityDeps {
  userDataPath: string
  /**
   * `<home>/.kettu/plugins`, where each harness's local marketplace lives: the harness reads the
   * plugins it installed from there, so it must outlive the app's data. Every Kettu data folder on
   * the computer shares it.
   */
  pluginsRoot: string
  file: JsonFile<CommunityRecords>
  log: LogFn
  /** The host's Kettu account, while it is signed in with Kettu's services on. */
  account(): MarketAccount | null
  /** Makes an API call through main or the daemon; throws `MarketCallError`. */
  call<K extends MarketCall['kind']>(
    call: Extract<MarketCall, { kind: K }>,
  ): Promise<MarketResults[K]>
  /** The listings of the skills and MCP servers the settings keep from the Kettu Marketplace. */
  kept(): string[]
  /** Installs, or updates, a plugin of a local marketplace through the agent's harness. */
  installPlugin(
    agentId: AgentId,
    local: LocalMarketplace,
    name: string,
    scope: PluginScope,
    projectPath: string | null,
  ): Promise<InstalledPlugin>
  /** Whether any agent of the harness still has the plugin, as its harness lists them now. */
  pluginInstalled(harness: PublishHarness, pluginId: string): Promise<boolean>
  /**
   * Writes a workflow listing's file into the workflow library, unapproved, or refuses it; `updated`
   * when it replaced the version the library had.
   */
  installWorkflow(
    text: string,
    origin: CommunityOrigin,
  ): Promise<{ entry: WorkflowEntry; updated: boolean }>
  now?: () => number
}

/** A workflow listing's step names and those that wait for the user, when its version lists them. */
function flowOf(listing: MarketListing): Pick<CommunityItem, 'steps' | 'waits'> {
  const of = (label: string) => listing.adds?.find((group) => group.label === label)?.items
  const steps = of('steps')
  return steps && steps.length > 0 ? { steps, waits: of('waits') ?? [] } : {}
}

/** The row a listing shows as. */
function itemOf(listing: MarketListing): CommunityItem {
  return {
    id: listing.id,
    handle: listing.handle,
    slug: listing.slug,
    name: listing.name,
    kind: listing.kind,
    ...(listing.harness ? { harness: listing.harness } : {}),
    description: listing.description,
    visibility: listing.visibility,
    official: listing.official,
    version: listing.version,
    installs: listing.visibility === 'private' ? null : listing.installs,
    updatedAt: listing.updatedAt,
    ...(listing.kind === 'workflow' ? flowOf(listing) : {}),
  }
}

function mineItem(listing: MineListing): CommunityItem {
  return {
    id: listing.id,
    handle: listing.handle,
    slug: listing.slug,
    name: listing.name,
    kind: listing.kind,
    ...(listing.harness ? { harness: listing.harness } : {}),
    description: listing.description,
    visibility: listing.visibility,
    official: listing.official,
    version: listing.current,
    installs: null,
    updatedAt: listing.updatedAt,
  }
}

function matchesQuery(item: CommunityItem, q: string): boolean {
  const needle = q.trim().toLocaleLowerCase()
  if (!needle) return true
  return [item.name, item.description, item.handle, item.slug]
    .join(' ')
    .toLocaleLowerCase()
    .includes(needle)
}

/** An MCP server's `server.json` as Kettu would install it, under the listing's own name. */
export function communityServer(
  listing: MarketListing,
  server: Record<string, unknown> | undefined,
): CatalogServer | null {
  const entry = server ? catalogServer({ server }) : null
  if (!entry) return null
  return {
    ...entry,
    id: `kettu:${listing.id}`,
    title: listing.name,
    publisher: listing.handle,
    official: false,
    description: listing.description,
    version: listing.version,
    updated: listing.updatedAt || null,
    brand: null,
  }
}

const BUNDLE = '.mcpb'

/** The version's one uploaded MCP bundle, when its files are that and nothing else. */
export function uploadedBundle(files: readonly VersionFile[]): BundleRef | null {
  if (files.length !== 1) return null
  const [file] = files as [VersionFile]
  if (!file.path.toLowerCase().endsWith(BUNDLE) || !safeFilePath(file.path)) return null
  if (!SHA256.test(file.sha256.toLowerCase())) return null
  return { from: 'upload', path: file.path, size: file.size, sha256: file.sha256.toLowerCase() }
}

/** The https `mcpb` package a `server.json` names with its file's SHA-256; null without one. */
export function urlBundle(server: Record<string, unknown> | undefined): BundleRef | null {
  const packages = Array.isArray(server?.packages) ? (server.packages as unknown[]) : []
  for (const item of packages) {
    if (typeof item !== 'object' || item === null) continue
    const { registryType, identifier, fileSha256 } = item as Record<string, unknown>
    if (registryType !== 'mcpb' || typeof identifier !== 'string') continue
    if (typeof fileSha256 !== 'string' || !SHA256.test(fileSha256.toLowerCase())) continue
    const url = identifier.length <= 2048 ? URL.parse(identifier) : null
    if (url?.protocol !== 'https:') continue
    return { from: 'url', url: url.toString(), sha256: fileSha256.toLowerCase() }
  }
  return null
}

export class MarketCommunityService {
  private readonly directories = new Map<string, { at: number; result: CommunityDirectory }>()
  private readonly standings = new Map<string, { at: number; standing: CommunityStanding }>()
  private kept: CommunityRecords | null = null
  private loading: Promise<CommunityRecords> | null = null
  /** One plugin install at a time, since they share each harness's marketplace file. */
  private installing: Promise<unknown> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly deps: CommunityDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * A page of the public listings, and on the first one the account's own Only me listings, each
   * matching `q` and of `kind` when given; read again after five minutes or on `refresh`.
   */
  async directory(
    query: { q?: string; kind?: PublishKind; cursor?: string },
    refresh = false,
  ): Promise<CommunityDirectory> {
    const account = this.deps.account()
    if (!account) return { signedIn: false, items: [], next: null, yours: [], error: null }
    const group = [account.email, query.q ?? '', query.kind ?? ''].join('\0')
    const key = `${group}\0${query.cursor ?? ''}`
    // A refreshed first page drops the group's later pages, so no page mixes old and new orders.
    if (refresh && !query.cursor) {
      for (const cached of [...this.directories.keys()]) {
        if (cached.startsWith(`${group}\0`) && cached !== key) this.directories.delete(cached)
      }
    }
    const hit = this.directories.get(key)
    if (hit && !refresh && this.now() - hit.at < DIRECTORY_MS) return hit.result
    const [page, mine] = await Promise.allSettled([
      this.deps.call({
        kind: 'directory',
        ...(query.q ? { q: query.q } : {}),
        ...(query.kind ? { listingKind: query.kind } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      }),
      query.cursor ? Promise.resolve(null) : this.deps.call({ kind: 'mine' }),
    ])
    const failure = [page, mine].find((answer) => answer.status === 'rejected')
    const reason = failure?.status === 'rejected' ? (failure.reason as unknown) : null
    if (reason instanceof MarketCallError && reason.failure.code === 'signed_out') {
      return { signedIn: false, items: [], next: null, yours: [], error: null }
    }
    const items =
      page.status === 'fulfilled'
        ? page.value.items.filter((listing) => listing.visibility === 'public').map(itemOf)
        : []
    const yours =
      mine.status === 'fulfilled' && mine.value
        ? mine.value.listings
            .filter(
              (listing) =>
                listing.visibility === 'private' &&
                listing.current !== null &&
                listing.takenDown === null,
            )
            .map(mineItem)
            .filter((item) => (query.kind ? item.kind === query.kind : true))
            .filter((item) => matchesQuery(item, query.q ?? ''))
        : []
    const result: CommunityDirectory = {
      signedIn: true,
      items,
      next: page.status === 'fulfilled' ? page.value.next : null,
      yours,
      error: reason ? (reason as Error).message : null,
    }
    if (!reason) {
      this.directories.delete(key)
      this.directories.set(key, { at: this.now(), result })
      if (this.directories.size > DIRECTORIES) {
        this.directories.delete(this.directories.keys().next().value!)
      }
    }
    return result
  }

  /** A listing's page; nothing of its files is read. */
  async listing(id: string): Promise<CommunityListing> {
    const found = await this.read(id)
    if (found.state !== 'listed') return found
    const { listing } = found
    const server = listing.kind === 'mcp-server' ? communityServer(listing, listing.server) : null
    let bundle: BundleRef | null = null
    if (listing.kind === 'mcp-server' && !server) {
      // Only the version's list of files is read: nothing is downloaded before Install.
      const version = await this.api(() =>
        this.deps.call({ kind: 'version', id: listing.id, version: listing.version }),
      )
      bundle = uploadedBundle(version.files) ?? urlBundle(listing.server)
    }
    return { state: 'listed', listing, server, bundle }
  }

  /**
   * A workflow listing's flow, for its page before it is added. Of its current version only
   * `workflow.yaml` is downloaded, checked against the size and SHA-256 the version lists and read
   * by the workflow format; nothing is written to the host and nothing counts as an install.
   */
  async workflow(id: string): Promise<CommunityWorkflow> {
    const listing = await this.listed(id)
    if (listing.kind !== 'workflow') throw refuse(t('marketCommunity.otherKind'))
    const { version } = listing
    const listed = await this.api(() =>
      this.deps.call({ kind: 'version', id: listing.id, version }),
    )
    checkFileList(listed.files)
    const file = listed.files.find((item) => item.path === WORKFLOW_FILE)
    if (!file) return { version, workflow: null, problem: t('marketCommunity.noWorkflow') }
    if (file.size > WORKFLOW_FILE_BYTES) throw refuse(t('marketCommunity.tooLarge'))
    const answer = await this.api(() =>
      this.deps.call({ kind: 'file', id: listing.id, version, path: file.path }),
    )
    const data = Buffer.from(answer.data, 'base64')
    if (!matches(file, data, answer.sha256)) {
      throw refuse(t('marketCommunity.mismatch', { path: file.path }))
    }
    const text = utf8(data)
    if (text === null) return { version, workflow: null, problem: t('marketCommunity.noWorkflow') }
    const read = parseWorkflow(text)
    return read.workflow
      ? { version, workflow: read.workflow, problem: null }
      : { version, workflow: null, problem: read.problems[0]?.message ?? '' }
  }

  /**
   * A listing's current version, downloaded and checked: every path stays in its folder and
   * every file has the size and SHA-256 the version lists, or nothing comes back.
   */
  async download(
    id: string,
    kind: PublishKind,
  ): Promise<{ listing: MarketListing; files: DownloadedFile[] }> {
    const listing = await this.listed(id)
    if (listing.kind !== kind) throw refuse(t('marketCommunity.otherKind'))
    const version = await this.api(() =>
      this.deps.call({ kind: 'version', id: listing.id, version: listing.version }),
    )
    checkFileList(version.files)
    const files: DownloadedFile[] = new Array<DownloadedFile>(version.files.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < version.files.length) {
        const at = next++
        const file = version.files[at]!
        const answer = await this.api(() =>
          this.deps.call({
            kind: 'file',
            id: listing.id,
            version: listing.version,
            path: file.path,
          }),
        )
        const data = Buffer.from(answer.data, 'base64')
        if (!matches(file, data, answer.sha256)) {
          throw refuse(t('marketCommunity.mismatch', { path: file.path }))
        }
        files[at] = { path: file.path, data }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker))
    return { listing, files }
  }

  /**
   * Installs a plugin listing into one agent through its harness, or updates it to the current
   * version: its files go to the harness's local marketplace, which the agent gets first.
   */
  installPlugin(
    id: string,
    agentId: AgentId,
    scope: PluginScope,
    projectPath: string | null,
  ): Promise<InstalledPlugin> {
    const run = this.installing.then(
      () => this.installPluginNow(id, agentId, scope, projectPath),
      () => this.installPluginNow(id, agentId, scope, projectPath),
    )
    this.installing = run.catch(() => undefined)
    return run
  }

  /**
   * Adds a workflow listing's current version to the workflow library, or updates the one it has:
   * every file is checked before its `workflow.yaml` is read, and the library refuses one that does
   * not read. It waits there for the user's approval.
   */
  async installWorkflow(id: string): Promise<WorkflowEntry> {
    const { listing, files } = await this.download(id, 'workflow')
    const file = files.find((item) => item.path === WORKFLOW_FILE)
    const text = file ? utf8(file.data) : null
    if (text === null) throw refuse(t('marketCommunity.noWorkflow'))
    const { entry, updated } = await this.deps.installWorkflow(text, {
      kind: 'community',
      listingId: listing.id,
      version: listing.version,
      handle: listing.handle,
      slug: listing.slug,
      official: listing.official,
    })
    void this.count(listing.id, listing.version, updated ? 'update' : 'install')
    return entry
  }

  /** The plugins installed from the Kettu Marketplace and where each installed item stands. */
  async installed(refresh = false): Promise<CommunityInstalled> {
    const file = await this.load()
    const plugins = Object.values(file.plugins)
    const ids = [...new Set([...this.deps.kept(), ...plugins.map((p) => p.listingId)])]
    const standings: Record<string, CommunityStanding> = {}
    if (!this.deps.account()) return { plugins, standings }
    await Promise.all(
      ids.map(async (id) => {
        standings[id] = await this.standing(id, refresh)
      }),
    )
    return { plugins, standings }
  }

  /** Counts an install or update of a version once; a failure is only logged. */
  async count(id: string, version: string | null, reason: 'install' | 'update'): Promise<void> {
    if (!version || !VERSION.test(version) || !this.deps.account()) return
    this.standings.delete(id)
    try {
      await this.deps.call({ kind: 'install', id, version, reason })
    } catch (error) {
      this.deps.log(
        'warn',
        `Could not count an ${reason} of ${id} ${version}: ${(error as Error).message}`,
      )
    }
  }

  async report(id: string, message: string): Promise<void> {
    if (!this.deps.account()) throw new HostError('auth_required', t('marketCommunity.signedOut'))
    await this.api(() => this.deps.call({ kind: 'report', id, message }))
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  /**
   * Moves the local marketplaces this data folder kept before into the plugins folder, once, and
   * leaves a link at each old place for the registrations that still name it. Resolves to the
   * harnesses whose marketplace moved, whose agents the caller points at the new place.
   */
  moveLegacy(): Promise<PublishHarness[]> {
    const run = this.installing.then(() => this.moveLegacyNow())
    this.installing = run.catch(() => undefined)
    return run
  }

  private async moveLegacyNow(): Promise<PublishHarness[]> {
    const moved: PublishHarness[] = []
    for (const harness of Object.keys(MANIFESTS) as PublishHarness[]) {
      const legacy = path.join(this.deps.userDataPath, 'marketplace', 'kettu-plugins', harness)
      // Not there, or already the link a move left.
      if (!(await lstat(legacy).catch(() => null))?.isDirectory()) continue
      const local = this.local(harness)
      try {
        if (await exists(local.dir)) {
          await movePlugins(legacy, local.dir)
          await this.writeMarketplace(harness, Object.values((await this.load()).plugins), null)
          await rm(legacy, { recursive: true, force: true })
        } else {
          await mkdir(path.dirname(local.dir), { recursive: true })
          await moveFolder(legacy, local.dir)
        }
        await symlink(local.dir, legacy, 'junction')
        moved.push(harness)
      } catch (error) {
        this.deps.log(
          'warn',
          `Could not move ${legacy} to ${local.dir}: ${(error as Error).message}`,
        )
      }
    }
    return moved
  }

  /** A harness's local marketplace, in the plugins folder. */
  local(harness: PublishHarness): LocalMarketplace {
    const dir = path.join(this.deps.pluginsRoot, harness)
    const file =
      harness === 'claude-code'
        ? path.join(dir, '.claude-plugin', 'marketplace.json')
        : path.join(dir, '.agents', 'plugins', 'marketplace.json')
    return { dir, file }
  }

  private async installPluginNow(
    id: string,
    agentId: AgentId,
    scope: PluginScope,
    projectPath: string | null,
  ): Promise<InstalledPlugin> {
    const harness = harnessOf(agentId)
    if (harness !== 'claude-code' && harness !== 'codex') {
      throw refuse('Only Claude Code and Codex have plugins')
    }
    const { listing, files } = await this.download(id, 'plugin')
    if (listing.harness !== harness) throw refuse(t('marketCommunity.otherHarness'))
    const name = pluginName(files, MANIFESTS[harness])
    const kept = await this.load()
    const before = kept.plugins[listing.id]
    const other = Object.values(kept.plugins).find(
      (plugin) =>
        plugin.listingId !== listing.id &&
        plugin.harness === harness &&
        plugin.name.toLowerCase() === name.toLowerCase(),
    )
    if (other) {
      if (await this.deps.pluginInstalled(harness, `${other.name}@${KETTU_PLUGINS}`)) {
        throw new HostError(
          'conflict',
          t('marketCommunity.nameTaken', { name, other: `@${other.handle}/${other.slug}` }),
        )
      }
      delete kept.plugins[other.listingId]
    }
    const local = this.local(harness)
    // A plugin that was another name before keeps its old folder for the agents that have it.
    await writeFolder(path.join(local.dir, 'plugins', name), files)
    const record: CommunityPlugin = {
      listingId: listing.id,
      harness,
      name,
      version: listing.version,
      handle: listing.handle,
      slug: listing.slug,
    }
    kept.plugins[listing.id] = record
    await this.writeMarketplace(harness, Object.values(kept.plugins), listing)
    const installed = await this.deps.installPlugin(
      agentId,
      await this.resolvedLocal(harness),
      name,
      scope,
      projectPath,
    )
    this.deps.file.save(kept)
    void this.count(listing.id, listing.version, before ? 'update' : 'install')
    return installed
  }

  /** The local marketplace's folder and file as the harnesses are given them. */
  async resolvedLocal(harness: PublishHarness): Promise<LocalMarketplace> {
    const local = this.local(harness)
    return { dir: await realpath(local.dir), file: await realpath(local.file) }
  }

  /**
   * The harness's marketplace file, listing every plugin installed from the Kettu Marketplace:
   * this data folder's, and those another one listed whose folders are still there.
   */
  private async writeMarketplace(
    harness: PublishHarness,
    plugins: readonly CommunityPlugin[],
    latest: MarketListing | null,
  ): Promise<void> {
    const local = this.local(harness)
    const ours = plugins
      .filter((plugin) => plugin.harness === harness)
      .map((plugin) => {
        const description = plugin.listingId === latest?.id ? latest.description : undefined
        const source = `./plugins/${plugin.name}`
        return harness === 'claude-code'
          ? {
              name: plugin.name,
              source,
              version: plugin.version,
              author: { name: plugin.handle },
              ...(description ? { description } : {}),
            }
          : {
              name: plugin.name,
              source: { source: 'local', path: source },
              policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            }
      })
    const names = new Set(ours.map((entry) => entry.name.toLowerCase()))
    const entries = [...ours, ...(await otherEntries(local, names))].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    const manifest =
      harness === 'claude-code'
        ? { name: KETTU_PLUGINS, owner: { name: 'Kettu Marketplace' }, plugins: entries }
        : {
            name: KETTU_PLUGINS,
            interface: { displayName: 'Kettu Marketplace' },
            plugins: entries,
          }
    await mkdir(path.dirname(local.file), { recursive: true })
    const partial = `${local.file}${PARTIAL}${randomUUID()}`
    await writeFile(partial, `${JSON.stringify(manifest, null, 2)}\n`)
    await rename(partial, local.file)
  }

  private async standing(id: string, refresh: boolean): Promise<CommunityStanding> {
    const hit = this.standings.get(id)
    if (hit && !refresh && this.now() - hit.at < STANDING_MS) return hit.standing
    let standing: CommunityStanding
    try {
      const found = await this.read(id)
      standing =
        found.state === 'listed'
          ? {
              state: found.listing.visibility === 'unlisted' ? 'unlisted' : 'listed',
              current: found.listing.version,
              versions: found.listing.versions,
            }
          : found
    } catch (error) {
      return { state: 'unknown', error: (error as Error).message }
    }
    this.standings.set(id, { at: this.now(), standing })
    return standing
  }

  /** A listing the host may install, or why not. */
  private async listed(id: string): Promise<MarketListing> {
    const found = await this.read(id)
    if (found.state === 'listed') return found.listing
    throw new HostError(
      'not_found',
      found.state === 'taken-down' ? t('marketCommunity.takenDown') : t('marketCommunity.gone'),
    )
  }

  private async read(
    id: string,
  ): Promise<{ state: 'listed'; listing: MarketListing } | { state: 'taken-down' | 'gone' }> {
    if (!LISTING_ID.test(id)) throw refuse('Not a listing of the Kettu Marketplace')
    if (!this.deps.account()) throw new HostError('auth_required', t('marketCommunity.signedOut'))
    let listing: MarketListing
    try {
      listing = await this.deps.call({ kind: 'listing', id })
    } catch (error) {
      if (error instanceof MarketCallError) {
        if (error.failure.code === 'taken_down') return { state: 'taken-down' }
        if (error.failure.code === 'not_found' || error.failure.status === 404) {
          return { state: 'gone' }
        }
      }
      throw this.failure(error)
    }
    // Another account's Only me listing never shows, whatever answered.
    if (listing.id !== id || !offered(listing)) return { state: 'gone' }
    return { state: 'listed', listing }
  }

  /** Runs an API call, its refusal given as the request's. */
  private async api<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw this.failure(error)
    }
  }

  private failure(error: unknown): Error {
    if (error instanceof HostError) return error
    if (!(error instanceof MarketCallError)) return error as Error
    const { code, message } = error.failure
    if (code === 'signed_out') return new HostError('auth_required', t('marketCommunity.signedOut'))
    if (code === 'taken_down') return new HostError('not_found', t('marketCommunity.takenDown'))
    if (code === 'withdrawn') return new HostError('conflict', t('marketCommunity.withdrawn'))
    return new HostError('unavailable', t('marketCommunity.failed', { reason: message }))
  }

  private load(): Promise<CommunityRecords> {
    if (this.kept) return Promise.resolve(this.kept)
    this.loading ??= this.deps.file.load().then(
      (file) => (this.kept = file),
      (error: unknown) => {
        this.deps.log(
          'warn',
          `Could not read the Kettu Marketplace's plugins: ${(error as Error).message}`,
        )
        return (this.kept = { version: 1, plugins: {} })
      },
    )
    return this.loading
  }
}

/** A plugin's name from its manifest, which its folder and marketplace entry take. */
function pluginName(files: readonly DownloadedFile[], manifest: string): string {
  const file = files.find((item) => item.path === manifest)
  if (!file) throw refuse(t('marketCommunity.noManifest', { file: manifest }))
  let name: unknown
  try {
    name = (JSON.parse(file.data.toString('utf8')) as { name?: unknown }).name
  } catch {
    throw refuse(t('marketCommunity.noManifest', { file: manifest }))
  }
  if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) {
    throw refuse(t('marketCommunity.noManifest', { file: manifest }))
  }
  return name
}
