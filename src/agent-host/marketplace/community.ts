// The Kettu Marketplace as the host installs from it: its public listings and the account's own
// Only me ones, read through main or the daemon; a version's files, downloaded for install or preview and
// each checked against the SHA-256 the service gave before anything is written; and the workflows,
// written into the workflow library to wait for the user's approval. Plugin listings are left out:
// Kettu no longer installs the harnesses' plugins.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  BundleRef,
  CommunityDirectory,
  CommunityInstalled,
  CommunityItem,
  CommunityListing,
  CommunityStanding,
  CommunityWorkflow,
} from '@shared/market-community'
import {
  LISTING_ID,
  PUBLISH_LIMITS,
  VERSION,
  type MarketAccount,
  type MarketCall,
  type MarketListing,
  type MarketResults,
  type MineListing,
  type PublishKind,
  type VersionFile,
} from '@shared/market-publish'
import type { CatalogServer } from '@shared/marketplace'
import {
  WORKFLOW_FILE_BYTES,
  type Workflow,
  type WorkflowEntry,
  type WorkflowStep,
} from '@shared/workflow'
import { HostError } from '../errors'
import { t } from '../i18n'
import type { LogFn } from '../storage'
import { parseWorkflow, problemText } from '../workflow/format'
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
const PARTIAL = '.partial-'

type WorkflowSummary = Pick<Workflow, 'name' | 'description' | 'when' | 'locales'> & {
  steps: Pick<WorkflowStep, 'id' | 'name' | 'by' | 'youReview'>[]
}

export type WorkflowCatalog = {
  status: 'available' | 'signed_out' | 'unavailable'
  items: (CommunityItem & { workflow: WorkflowSummary | null })[]
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

export interface CommunityDeps {
  userDataPath: string
  log: LogFn
  /** The host's Kettu account, while it is signed in with Kettu's services on. */
  account(): MarketAccount | null
  /** Makes an API call through main or the daemon; throws `MarketCallError`. */
  call<K extends MarketCall['kind']>(
    call: Extract<MarketCall, { kind: K }>,
  ): Promise<MarketResults[K]>
  /** The listings of the skills and MCP servers the settings keep from the Kettu Marketplace. */
  kept(): string[]
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
    ...(listing.kind === 'agent-plugin' && listing.adds ? { adds: listing.adds } : {}),
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
  private workflowCatalog: {
    email: string
    expires: number
    result: Promise<WorkflowCatalog>
  } | null = null
  private readonly workflowSummaries = new Map<
    string,
    { version: string; summary: Promise<WorkflowSummary | null> }
  >()
  private readonly standings = new Map<string, { at: number; standing: CommunityStanding }>()
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
        ? page.value.items
            .filter((listing) => listing.visibility === 'public' && listing.kind !== 'plugin')
            .map(itemOf)
        : []
    const yours =
      mine.status === 'fulfilled' && mine.value
        ? mine.value.listings
            .filter(
              (listing) =>
                listing.visibility === 'private' &&
                listing.kind !== 'plugin' &&
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

  /** The whole public workflow catalog, with no search text or private listings. */
  async publicWorkflows(): Promise<WorkflowCatalog> {
    const email = this.deps.account()?.email
    if (!email) return { status: 'signed_out', items: [] }
    let cached = this.workflowCatalog
    if (!cached || cached.email !== email || cached.expires <= this.now()) {
      cached = {
        email,
        expires: this.now() + DIRECTORY_MS,
        result: this.readPublicWorkflows(),
      }
      this.workflowCatalog = cached
    }
    try {
      const catalog = await cached.result
      return this.deps.account()?.email === email ? catalog : { status: 'signed_out', items: [] }
    } catch (error) {
      if (this.workflowCatalog === cached) this.workflowCatalog = null
      if (!this.deps.account() || (error instanceof HostError && error.code === 'auth_required')) {
        return { status: 'signed_out', items: [] }
      }
      return { status: 'unavailable', items: [] }
    }
  }

  private async readPublicWorkflows(): Promise<WorkflowCatalog> {
    const byId = new Map<string, MarketListing>()
    const cursors = new Set<string>()
    let cursor: string | null = null
    do {
      const page = await this.api(() =>
        this.deps.call({
          kind: 'directory',
          listingKind: 'workflow',
          ...(cursor ? { cursor } : {}),
        }),
      )
      for (const item of page.items) {
        if (
          item.visibility === 'public' &&
          item.kind === 'workflow' &&
          LISTING_ID.test(item.id) &&
          VERSION.test(item.version)
        ) {
          byId.set(item.id, item)
        }
      }
      cursor = page.next
      if (cursor === null) break
      if (cursors.has(cursor)) throw new Error('The Marketplace repeated a directory page.')
      cursors.add(cursor)
    } while (cursor)

    for (const id of this.workflowSummaries.keys()) {
      if (!byId.has(id)) this.workflowSummaries.delete(id)
    }
    const listings = [...byId.values()].sort(
      (a, b) => Number(b.official) - Number(a.official) || b.installs - a.installs,
    )
    const items: WorkflowCatalog['items'] = new Array(listings.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < listings.length) {
        const index = next++
        const listing = listings[index]!
        items[index] = { ...itemOf(listing), workflow: await this.workflowSummary(listing) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, listings.length) }, worker))
    return { status: 'available', items }
  }

  private async workflowSummary(listing: MarketListing): Promise<WorkflowSummary | null> {
    const { id, version } = listing
    const hit = this.workflowSummaries.get(id)
    if (hit?.version === version) return hit.summary
    const summary = this.readWorkflowVersion(id, version)
      .then(({ workflow }) => {
        if (!workflow) return null
        const { name, description, when, locales, steps } = workflow
        return {
          name,
          description,
          when,
          locales,
          steps: steps.map(({ id, name, by, youReview }) => ({ id, name, by, youReview })),
        }
      })
      .catch((error: unknown) => {
        if (this.workflowSummaries.get(id)?.summary === summary) this.workflowSummaries.delete(id)
        if (error instanceof HostError && error.code === 'auth_required') throw error
        return null
      })
    this.workflowSummaries.set(id, { version, summary })
    return summary
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
    return this.readWorkflowVersion(listing.id, listing.version)
  }

  /**
   * The `workflow.yaml` of one version of a workflow listing, checked against the size and SHA-256
   * the version lists; null when the version has none that reads as text.
   */
  async workflowText(id: string, version: string): Promise<string | null> {
    if (!LISTING_ID.test(id) || !VERSION.test(version)) {
      throw refuse(t('marketCommunity.notListing'))
    }
    const listed = await this.api(() => this.deps.call({ kind: 'version', id, version }))
    checkFileList(listed.files)
    const file = listed.files.find((item) => item.path === WORKFLOW_FILE)
    if (!file) return null
    if (file.size > WORKFLOW_FILE_BYTES) throw refuse(t('marketCommunity.tooLarge'))
    const answer = await this.api(() =>
      this.deps.call({ kind: 'file', id, version, path: file.path }),
    )
    const data = Buffer.from(answer.data, 'base64')
    if (!matches(file, data, answer.sha256)) {
      throw refuse(t('marketCommunity.mismatch', { path: file.path }))
    }
    return utf8(data)
  }

  /**
   * Adds one version of a workflow listing to the library, as `installWorkflow` adds the current
   * one, and counts it; the text is the one `workflowText` read and its caller checked.
   */
  async addWorkflowVersion(
    listing: { id: string; version: string; handle: string; slug: string; official: boolean },
    text: string,
  ): Promise<WorkflowEntry> {
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

  private async readWorkflowVersion(id: string, version: string): Promise<CommunityWorkflow> {
    const text = await this.workflowText(id, version)
    if (text === null) return { version, workflow: null, problem: t('marketCommunity.noWorkflow') }
    const read = parseWorkflow(text)
    return read.workflow
      ? { version, workflow: read.workflow, problem: null }
      : { version, workflow: null, problem: read.problems[0] ? problemText(read.problems[0]) : '' }
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
   * Adds a workflow listing's current version to the workflow library, or updates the one it has:
   * every file is checked before its `workflow.yaml` is read, and the library refuses one that does
   * not read. It waits there for the user's approval.
   */
  async installWorkflow(id: string): Promise<WorkflowEntry> {
    const { listing, files } = await this.download(id, 'workflow')
    const file = files.find((item) => item.path === WORKFLOW_FILE)
    const text = file ? utf8(file.data) : null
    if (text === null) throw refuse(t('marketCommunity.noWorkflow'))
    return this.addWorkflowVersion(listing, text)
  }

  /** Where each item installed from the Kettu Marketplace stands with its listing. */
  async installed(refresh = false): Promise<CommunityInstalled> {
    const standings: Record<string, CommunityStanding> = {}
    if (!this.deps.account()) return { plugins: [], standings }
    await Promise.all(
      [...new Set(this.deps.kept())].map(async (id) => {
        standings[id] = await this.standing(id, refresh)
      }),
    )
    return { plugins: [], standings }
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
    if (!LISTING_ID.test(id)) throw refuse(t('marketCommunity.notListing'))
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
    // Another account's Only me listing never shows, whatever answered; nor does a plugin's.
    if (listing.id !== id || !offered(listing) || listing.kind === 'plugin') {
      return { state: 'gone' }
    }
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
}
