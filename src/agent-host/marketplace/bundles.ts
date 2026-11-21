// Installing a server listing's MCP bundle in two steps. Prepare downloads it on Install, checks
// it and unpacks it into a staging folder, then says what it would run and what it asks for;
// nothing of it runs. Commit moves it to its own folder by listing and version and gives the
// spec the settings keep. What is installed is recorded, so an update fills in the same values,
// and a folder no server uses any longer is removed.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  kettuId,
  type BundlePlan,
  type BundleRef,
  type CommunityListing,
} from '@shared/market-community'
import { LISTING_ID, VERSION, type MarketListing, type PublishKind } from '@shared/market-publish'
import type { CatalogServer, MarketServer } from '@shared/marketplace'
import type { Platform } from '@shared/platform'
import { HostError } from '../errors'
import { t } from '../i18n'
import { JsonFile, type LogFn } from '../storage'
import { safeFilePath, type DownloadedFile } from './community'
import {
  BUNDLE_LIMITS,
  fillArgs,
  planBundle,
  readManifest,
  unpackBundle,
  type BundleFile,
  type BundleSetup,
} from './mcpb'

const PARTIAL = '.partial-'
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STAGED_MS = 15 * 60_000
// A committed folder is kept this long before the settings must name its server.
const FRESH_MS = 10 * 60_000
const CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const MAX_ARG = 16_384

/** A bundle installed for a server, by the server's id. */
export interface BundleRecord {
  listingId: string
  version: string
  dir: string
  /** The values its arguments were given, by key; never a secret's. */
  args: Record<string, string>
}

export interface BundleRecords {
  version: 1
  servers: Record<string, BundleRecord>
}

export function parseBundlesFile(data: Record<string, unknown>): BundleRecords | string {
  const { servers } = data
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return 'servers is not an object'
  }
  const kept: Record<string, BundleRecord> = {}
  for (const [id, value] of Object.entries(servers)) {
    const o = (value ?? {}) as Record<string, unknown>
    const args = o.args as Record<string, unknown> | undefined
    if (
      typeof o.listingId !== 'string' ||
      !LISTING_ID.test(o.listingId) ||
      id !== kettuId(o.listingId) ||
      typeof o.version !== 'string' ||
      !VERSION.test(o.version) ||
      typeof o.dir !== 'string' ||
      !path.isAbsolute(o.dir) ||
      typeof args !== 'object' ||
      args === null ||
      Array.isArray(args) ||
      !Object.entries(args).every(
        ([key, text]) =>
          CONFIG_KEY.test(key) &&
          typeof text === 'string' &&
          text.length <= MAX_ARG &&
          !text.includes('\0'),
      )
    ) {
      continue
    }
    kept[id] = {
      listingId: o.listingId,
      version: o.version,
      dir: o.dir,
      args: args as Record<string, string>,
    }
  }
  return { version: 1, servers: kept }
}

export function bundlesFile(userDataPath: string, log: LogFn): JsonFile<BundleRecords> {
  return new JsonFile<BundleRecords>({
    file: path.join(userDataPath, 'state', 'market-bundles.json'),
    version: 1,
    migrations: {},
    parse: parseBundlesFile,
    empty: () => ({ version: 1, servers: {} }),
    log,
  })
}

/** Whether a token can name a staged bundle. */
export function bundleToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

function refuse(message: string): HostError {
  return new HostError('invalid_params', message)
}

/** Downloads an https bundle, at most `max` bytes, that must have the SHA-256 given. */
export async function fetchBundle(
  fetcher: typeof fetch,
  url: string,
  sha256: string,
  max: number,
): Promise<Buffer> {
  let response: Response
  try {
    response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  } catch (error) {
    throw new HostError(
      'unavailable',
      t('marketBundle.downloadFailed', { reason: (error as Error).message }),
    )
  }
  const final = URL.parse(response.url || url)
  if (final?.protocol !== 'https:') {
    throw new HostError(
      'unavailable',
      t('marketBundle.downloadFailed', { reason: t('marketBundle.notHttps') }),
    )
  }
  if (!response.ok || !response.body) {
    throw new HostError(
      'unavailable',
      t('marketBundle.downloadFailed', { reason: `HTTP ${response.status}` }),
    )
  }
  const tooBig = () => refuse(t('marketBundle.tooBig', { mb: Math.round(max / (1024 * 1024)) }))
  if (Number(response.headers.get('content-length') ?? 0) > max) throw tooBig()
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw tooBig()
    }
    chunks.push(value)
  }
  const data = Buffer.concat(chunks)
  if (createHash('sha256').update(data).digest('hex') !== sha256.toLowerCase()) {
    throw refuse(t('marketBundle.mismatch'))
  }
  return data
}

/** Writes a bundle's files into a new folder, each checked to stay inside it. */
async function writeFiles(dir: string, files: readonly BundleFile[], program: string | null) {
  const root = path.resolve(dir)
  await mkdir(root, { recursive: true })
  for (const file of files) {
    const target = path.resolve(root, ...file.path.split('/'))
    if (!target.startsWith(root + path.sep)) {
      throw refuse(t('marketBundle.invalid', { reason: file.path }))
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, file.data, { mode: file.path === program ? 0o755 : file.mode })
  }
}

export interface BundlesDeps {
  userDataPath: string
  file: JsonFile<BundleRecords>
  log: LogFn
  platform: Platform
  home: string
  nodeVersion: string
  /** A listing's page and its current version's files, as the Kettu Marketplace gives them. */
  listing(id: string): Promise<CommunityListing>
  /** A listing's current version and its files, which it reads again. */
  download(
    id: string,
    kind: PublishKind,
  ): Promise<{ listing: MarketListing; files: DownloadedFile[] }>
  /** A command on the agents' PATH, or null. */
  find(command: string): Promise<string | null>
  /** The servers the settings keep now. */
  servers(): readonly MarketServer[]
  fetch?: typeof fetch
  now?: () => number
}

interface Staged {
  dir: string
  final: string
  listing: MarketListing
  setup: BundleSetup
  timer: ReturnType<typeof setTimeout>
}

export class MarketBundlesService {
  private readonly staged = new Map<string, Staged>()
  /** Folders committed this run, by when, until the settings name their server. */
  private readonly fresh = new Map<string, number>()
  private records: BundleRecords | null = null
  private sweeping: Promise<void> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly deps: BundlesDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Where every bundle lives, by listing and version. */
  get root(): string {
    return path.join(this.deps.userDataPath, 'marketplace', 'mcpb')
  }

  /**
   * Downloads and checks a server listing's bundle and stages it. Nothing runs; a bundle that
   * cannot run here says why and stages nothing.
   */
  async prepare(id: string): Promise<BundlePlan> {
    const page = await this.deps.listing(id)
    if (page.state !== 'listed') {
      throw new HostError(
        'not_found',
        page.state === 'taken-down' ? t('marketCommunity.takenDown') : t('marketCommunity.gone'),
      )
    }
    const { listing, bundle } = page
    if (!bundle || !safeFilePath(listing.version)) throw refuse(t('marketBundle.noBundle'))
    const data = await this.bytes(listing, bundle)
    const { files, manifest } = await unpackBundle(data)
    const read = readManifest(manifest, this.deps.platform)
    const final = path.join(this.root, listing.id, listing.version)
    const setup = await planBundle(read, {
      dir: final,
      platform: this.deps.platform,
      home: this.deps.home,
      files: new Set(files.map((file) => file.path)),
      nodeVersion: this.deps.nodeVersion,
      find: (command) => this.deps.find(command),
    })
    const records = await this.load()
    const plan: BundlePlan = {
      token: null,
      name: read.displayName ?? read.name,
      version: listing.version,
      type: setup.type,
      runs: setup.runs,
      inputs: setup.inputs,
      blocked: setup.blocked,
      previous: records.servers[kettuId(listing.id)]?.args ?? null,
    }
    if (setup.blocked) return plan
    const token = randomUUID()
    const dir = path.join(this.root, `${PARTIAL}${token}`)
    try {
      await writeFiles(dir, files, setup.program)
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
    const timer = setTimeout(() => void this.cancel(token), STAGED_MS)
    timer.unref?.()
    this.staged.set(token, { dir, final, listing, setup, timer })
    return { ...plan, token }
  }

  /** Moves a staged bundle into place with the values its arguments take, and gives its server. */
  async commit(token: string, values: Readonly<Record<string, string>>): Promise<CatalogServer> {
    const staged = this.staged.get(token)
    if (!staged) throw refuse(t('marketBundle.expired'))
    const { setup, listing, final } = staged
    const args = fillArgs(setup, values)
    this.staged.delete(token)
    clearTimeout(staged.timer)
    try {
      await rm(final, { recursive: true, force: true })
      await mkdir(path.dirname(final), { recursive: true })
      await rename(staged.dir, final)
    } catch (error) {
      await rm(staged.dir, { recursive: true, force: true })
      throw error
    }
    this.fresh.set(final, this.now())
    const kept = Object.fromEntries(
      setup.inputs
        .filter((input) => input.args && !input.secret && values[input.key]?.trim())
        .map((input) => [input.key, values[input.key]!.trim()]),
    )
    const records = await this.load()
    records.servers[kettuId(listing.id)] = {
      listingId: listing.id,
      version: listing.version,
      dir: final,
      args: kept,
    }
    this.deps.file.save(records)
    void this.sweep()
    return {
      id: kettuId(listing.id),
      title: listing.name,
      publisher: listing.handle,
      official: false,
      description: listing.description,
      version: listing.version,
      updated: listing.updatedAt || null,
      repository: null,
      website: null,
      brand: null,
      spec: {
        type: 'stdio',
        command: setup.runtime === 'node' ? 'node' : setup.command,
        args,
        env: setup.env,
        ...(setup.runtime ? { runtime: setup.runtime } : {}),
      },
    }
  }

  /** Removes a staged bundle; one already gone or committed is left. */
  async cancel(token: string): Promise<void> {
    const staged = this.staged.get(token)
    if (!staged) return
    this.staged.delete(token)
    clearTimeout(staged.timer)
    await rm(staged.dir, { recursive: true, force: true })
  }

  /**
   * Removes every bundle folder no server in the settings uses, the records of servers gone from
   * them and staging folders left over; one that cannot be removed now waits for the next sweep.
   */
  sweep(): Promise<void> {
    this.sweeping = this.sweeping.then(
      () => this.sweepNow(),
      () => this.sweepNow(),
    )
    return this.sweeping
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  private async sweepNow(): Promise<void> {
    try {
      const records = await this.load()
      const servers = this.deps.servers()
      const named = new Set(servers.map((server) => server.id))
      const keep = new Set<string>()
      const root = path.resolve(this.root)
      // A folder a spec runs from, as the first two parts below the root.
      for (const server of servers) {
        if (server.spec.type !== 'stdio') continue
        for (const part of [server.spec.command, ...server.spec.args]) {
          const at = path.resolve(part)
          if (!at.startsWith(root + path.sep)) continue
          const [listing, version] = path.relative(root, at).split(path.sep)
          if (listing && version) keep.add(path.join(root, listing, version))
        }
      }
      let changed = false
      for (const [id, record] of Object.entries(records.servers)) {
        const fresh = this.fresh.get(record.dir)
        if (named.has(id)) {
          this.fresh.delete(record.dir)
          keep.add(path.resolve(record.dir))
        } else if (fresh !== undefined && this.now() - fresh < FRESH_MS) {
          keep.add(path.resolve(record.dir))
        } else {
          delete records.servers[id]
          changed = true
        }
      }
      if (changed) this.deps.file.save(records)
      const staging = new Set([...this.staged.values()].map((staged) => path.resolve(staged.dir)))
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const at = path.join(root, entry.name)
        if (!entry.isDirectory() || entry.name.startsWith(PARTIAL)) {
          if (!staging.has(at)) await this.remove(at)
          continue
        }
        const versions = await readdir(at, { withFileTypes: true }).catch(() => [])
        let left = 0
        for (const version of versions) {
          const dir = path.join(at, version.name)
          if (keep.has(dir)) left++
          else await this.remove(dir)
        }
        if (left === 0) await this.remove(at)
      }
    } catch (error) {
      this.deps.log('warn', `Could not clean up MCP bundles: ${(error as Error).message}`)
    }
  }

  private async remove(target: string): Promise<void> {
    try {
      await rm(target, { recursive: true, force: true })
    } catch (error) {
      this.deps.log('warn', `Could not remove ${target}: ${(error as Error).message}`)
    }
  }

  /** The bundle the page named, at the version it named; a newer one is refused for a retry. */
  private async bytes(listing: MarketListing, bundle: BundleRef): Promise<Buffer> {
    if (bundle.from === 'url') {
      return fetchBundle(
        this.deps.fetch ?? fetch,
        bundle.url,
        bundle.sha256,
        BUNDLE_LIMITS.download,
      )
    }
    // Each file is checked against its version's list as it downloads, but the list is read
    // again: the version must still be the one the page named, and the file the one it listed.
    const downloaded = await this.deps.download(listing.id, 'mcp-server')
    if (downloaded.listing.version !== listing.version) throw refuse(t('marketBundle.changed'))
    const file = downloaded.files.length === 1 ? downloaded.files[0] : undefined
    if (!file || file.path !== bundle.path) throw refuse(t('marketBundle.noBundle'))
    const sha256 = createHash('sha256').update(file.data).digest('hex')
    if (file.data.byteLength !== bundle.size || sha256 !== bundle.sha256.toLowerCase()) {
      throw refuse(t('marketBundle.mismatch'))
    }
    return file.data
  }

  private async load(): Promise<BundleRecords> {
    if (this.records) return this.records
    try {
      this.records = await this.deps.file.load()
    } catch (error) {
      this.deps.log('warn', `Could not read the MCP bundles: ${(error as Error).message}`)
      this.records = { version: 1, servers: {} }
    }
    return this.records
  }
}
