// The Kettu account's Marketplace API, at `<account>/api/v1/marketplace`, with the signed-in
// account's access token. Main and the daemon make the calls the agent host asks for, so the token
// never leaves them.

import {
  DIRECTORY_CURSOR,
  HANDLE,
  LISTING_ID,
  VERSION,
  type ListingChange,
  type ListingVisibility,
  type MarketCall,
  type MarketCallAnswer,
  type MarketDirectory,
  type MarketFailure,
  type MarketListing,
  type MarketMine,
  type MarketProblem,
  type MarketPublisher,
  type MarketVersionFiles,
  type MineListing,
  type MineVersion,
  type PublishAdds,
  type PublishHarness,
  type PublishKind,
  type PublishManifest,
  type PublishResult,
  type VersionCheck,
  type VersionFile,
  type VersionStatus,
} from '@shared/market-publish'
import { locale, t } from './i18n'

const TIMEOUT_MS = 120_000
const MAX_MESSAGE = 500
const MAX_PROBLEMS = 100
const MAX_CHECKS = 50

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** A failed call, as `MarketFailure` says it. */
export class MarketApiError extends Error {
  constructor(readonly failure: MarketFailure) {
    super(failure.message)
    this.name = 'MarketApiError'
  }
}

/** The service did not take the access token: refreshing it may help, once. */
export class MarketUnauthorized extends MarketApiError {
  constructor(message: string) {
    super({ code: 'unauthorized', status: 401, message })
    this.name = 'MarketUnauthorized'
  }
}

type Fields = Record<string, unknown>

function record(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : null
}

/** What an answer the Marketplace gave was meant to hold, which the failure names. */
type Answered =
  'publisher' | 'listing' | 'version' | 'versionFiles' | 'mine' | 'directory' | 'request'

function unexpected(what: Answered): MarketApiError {
  return new MarketApiError({
    code: 'unexpected',
    status: null,
    message: t('market.unexpected', { what: t(`market.answered.${what}`) }),
  })
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const KINDS: readonly PublishKind[] = ['skill', 'workflow', 'plugin', 'mcp-server', 'agent-plugin']
const VISIBILITIES: readonly ListingVisibility[] = ['public', 'private', 'unlisted']

function kindOf(value: unknown): PublishKind | null {
  return KINDS.includes(value as PublishKind) ? (value as PublishKind) : null
}

function harnessOf(value: unknown): { harness?: PublishHarness } {
  return value === 'claude-code' || value === 'codex' ? { harness: value } : {}
}

function optionalText(key: 'about', value: unknown): { about?: string } {
  return typeof value === 'string' ? { [key]: value } : {}
}

function parsePublisher(value: unknown): MarketPublisher {
  const fields = record(value)
  const handle = text(fields?.handle)
  const since = text(fields?.since)
  if (handle === null || !HANDLE.test(handle) || since === null) throw unexpected('publisher')
  return { handle, since }
}

function parseAdds(value: unknown): { adds?: PublishAdds[] } {
  if (!Array.isArray(value)) return {}
  const adds = value.flatMap((item: unknown) => {
    const fields = record(item)
    const label = text(fields?.label)
    const items = Array.isArray(fields?.items)
      ? fields.items.filter((i) => typeof i === 'string')
      : []
    return label === null ? [] : [{ label, items: items as string[] }]
  })
  return { adds }
}

function parseServer(value: unknown): { server?: Record<string, unknown> } {
  const server = record(value)
  return server ? { server } : {}
}

/** The fields every listing has, mine or another account's. */
function listingBase(value: unknown, what: Answered) {
  const fields = record(value)
  const id = text(fields?.id)
  const handle = text(fields?.handle)
  const slug = text(fields?.slug)
  const name = text(fields?.name)
  const kind = kindOf(fields?.kind)
  const visibility = fields?.visibility as ListingVisibility
  if (
    !fields ||
    id === null ||
    !LISTING_ID.test(id) ||
    handle === null ||
    slug === null ||
    name === null ||
    kind === null ||
    !VISIBILITIES.includes(visibility)
  ) {
    throw unexpected(what)
  }
  return {
    fields,
    base: {
      id,
      handle,
      slug,
      name,
      kind,
      ...harnessOf(fields.harness),
      ...(fields.installable === false ? { installable: false as const } : {}),
      description: text(fields.description) ?? '',
      ...optionalText('about', fields.about),
      visibility,
      official: fields.official === true,
    },
  }
}

function parseChecks(value: unknown): VersionCheck[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_CHECKS).flatMap((item: unknown) => {
    const fields = record(item)
    const check = text(fields?.check)
    if (check === null || (fields?.result !== 'passed' && fields?.result !== 'skipped')) return []
    const target = text(fields.target)
    const note = text(fields.note)
    return [
      {
        check: check.slice(0, MAX_MESSAGE),
        ...(target !== null ? { target: target.slice(0, MAX_MESSAGE) } : {}),
        result: fields.result,
        ...(note !== null ? { note: note.slice(0, MAX_MESSAGE) } : {}),
      },
    ]
  })
}

const STATUSES: readonly VersionStatus[] = ['live', 'withdrawn', 'held', 'refused']

/** A status this app does not know is `unknown`, which counts as not live. */
function statusOf(value: unknown): VersionStatus {
  return STATUSES.includes(value as VersionStatus) ? (value as VersionStatus) : 'unknown'
}

function parseRefusal(value: unknown): { refusal?: { reason: string; at: string } } {
  const fields = record(value)
  const reason = text(fields?.reason)
  const at = text(fields?.at)
  return reason === null || at === null
    ? {}
    : { refusal: { reason: reason.slice(0, MAX_MESSAGE), at } }
}

function parseVersion(value: unknown): MineVersion {
  const fields = record(value)
  const version = text(fields?.version)
  const publishedAt = text(fields?.publishedAt)
  if (!fields || version === null || publishedAt === null) throw unexpected('version')
  const status = statusOf(fields.status)
  return {
    version,
    notes: text(fields.notes) ?? '',
    status,
    bytes: isCount(fields.bytes) ? fields.bytes : 0,
    files: isCount(fields.files) ? fields.files : 0,
    checks: parseChecks(fields.checks),
    ...(typeof fields.agent === 'string' ? { agent: fields.agent } : {}),
    ...(typeof fields.session === 'string' ? { session: fields.session } : {}),
    ...(typeof fields.script === 'boolean' ? { script: fields.script } : {}),
    ...(Array.isArray(fields.permissions)
      ? { permissions: fields.permissions.filter((p): p is string => typeof p === 'string') }
      : {}),
    ...(status === 'refused' ? parseRefusal(fields.refusal) : {}),
    publishedAt,
  }
}

export function parseMineListing(value: unknown): MineListing {
  const { fields, base } = listingBase(value, 'listing')
  const installs = record(fields.installs)
  const takenDown = record(fields.takenDown)
  const days = Array.isArray(installs?.days) ? installs.days.filter(isCount) : []
  return {
    ...base,
    current: text(fields.current),
    versions: Array.isArray(fields.versions) ? fields.versions.map(parseVersion) : [],
    installs: {
      total: isCount(installs?.total) ? installs.total : 0,
      week: isCount(installs?.week) ? installs.week : 0,
      days,
    },
    takenDown: takenDown
      ? { reason: text(takenDown.reason) ?? '', at: text(takenDown.at) ?? '' }
      : null,
    createdAt: text(fields.createdAt) ?? '',
    updatedAt: text(fields.updatedAt) ?? '',
  }
}

function parseListing(value: unknown): MarketListing {
  const { fields, base } = listingBase(value, 'listing')
  const version = text(fields.version)
  if (version === null) throw unexpected('listing')
  return {
    ...base,
    version,
    versions: Array.isArray(fields.versions)
      ? fields.versions.filter((v): v is string => typeof v === 'string')
      : [version],
    ...parseAdds(fields.adds),
    ...parseServer(fields.server),
    installs: isCount(fields.installs) ? fields.installs : 0,
    updatedAt: text(fields.updatedAt) ?? '',
    mine: fields.mine === true,
  }
}

function parseVersionFiles(body: Fields | null): MarketVersionFiles {
  if (!Array.isArray(body?.files)) throw unexpected('versionFiles')
  const files: VersionFile[] = body.files.map((item: unknown) => {
    const fields = record(item)
    const path = text(fields?.path)
    const sha256 = text(fields?.sha256)
    if (path === null || sha256 === null || !isCount(fields?.size)) {
      throw unexpected('versionFiles')
    }
    return { path, size: fields.size, sha256 }
  })
  return { files, ...parseServer(body.server) }
}

function parseProblems(value: unknown): MarketProblem[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, MAX_PROBLEMS).flatMap((item: unknown) => {
    const fields = record(item)
    const message = text(fields?.message)
    if (message === null) return []
    const path = text(fields?.path)
    return [{ ...(path !== null ? { path } : {}), message: message.slice(0, MAX_MESSAGE) }]
  })
}

/** What the call sent that an error names, which the service's answer does not repeat. */
interface Sent {
  version?: string
}

/** The most problems of a failed check the sentence lists; `problems` holds them all. */
const MAX_LISTED_PROBLEMS = 5

/** A size in the interface language, such as 8.4 MB. */
function sizeText(bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return new Intl.NumberFormat(locale(), {
    style: 'unit',
    unit: units[unit],
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value)
}

/** What a failed check found, one problem a line, as the service wrote each. */
function problemLines(problems: readonly MarketProblem[]): string {
  const lines = problems
    .slice(0, MAX_LISTED_PROBLEMS)
    .map((problem) => `- ${problem.path ? `${problem.path}: ` : ''}${problem.message}`)
  if (problems.length > MAX_LISTED_PROBLEMS) {
    lines.push(t('market.failure.moreProblems', { count: problems.length - MAX_LISTED_PROBLEMS }))
  }
  return lines.join('\n')
}

/** The sentence for an error code the service gives, in the user's language; null for any other. */
function failureText(
  code: string,
  status: number,
  found: { problems?: MarketProblem[]; bytes?: number; limit?: number },
  sent: Sent,
): string | null {
  switch (code) {
    case 'not_found':
      return t('market.failure.notFound')
    case 'taken_down':
      // Taken down for good is answered 410; a publish to one is refused 403.
      return t(status === 403 ? 'market.failure.takenDownNoVersions' : 'market.failure.takenDown')
    case 'check_failed':
      return found.problems?.length
        ? t('market.failure.checkFailedWith', { problems: problemLines(found.problems) })
        : t('market.failure.checkFailed')
    case 'too_large':
      return t('market.failure.tooLarge')
    case 'storage_full':
      return found.bytes !== undefined && found.limit !== undefined
        ? t('market.failure.storageFullUsed', {
            used: sizeText(found.bytes),
            limit: sizeText(found.limit),
          })
        : t('market.failure.storageFull')
    case 'version_exists':
      return sent.version
        ? t('market.failure.versionExists', { version: sent.version })
        : t('market.failure.versionExistsAny')
    case 'withdrawn':
      return t('market.failure.withdrawn')
    case 'handle_taken':
      return t('market.failure.handleTaken')
    case 'no_publisher':
      return t('market.failure.noPublisher')
    case 'too_many_listings':
      return t('market.failure.tooManyListings')
    case 'conflict':
      return t('market.failure.conflict')
    case 'script_not_allowed':
      return t('market.failure.scriptNotAllowed')
    case 'kind_closed':
      return t('market.failure.kindClosed')
    default:
      return null
  }
}

/**
 * The service's error body, `{ error: <code>, message, ... }`, as a failure. Its `message` is
 * English, so a code Kettu knows gets a sentence of its own, and the service's words stay for a
 * code it does not.
 */
function failureOf(status: number, body: Fields | null, sent: Sent = {}): MarketFailure {
  const code = text(body?.error) ?? (status === 404 ? 'not_found' : 'failed')
  const problems = parseProblems(body?.problems)
  const bytes = isCount(body?.bytes) ? body.bytes : undefined
  const limit = isCount(body?.limit) ? body.limit : undefined
  const message =
    failureText(code, status, { problems, bytes, limit }, sent) ??
    text(body?.message)?.slice(0, MAX_MESSAGE) ??
    t('market.answeredStatus', { status })
  return {
    code,
    status,
    message,
    ...(problems ? { problems } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }
}

function segment(value: string, what: string): string {
  if (value === '' || value === '.' || value === '..' || value.includes('/')) {
    throw new MarketApiError({ code: 'invalid', status: null, message: `Not a ${what}.` })
  }
  return encodeURIComponent(value)
}

function listing(id: string): string {
  if (!LISTING_ID.test(id)) {
    throw new MarketApiError({ code: 'invalid', status: null, message: 'Not a listing id.' })
  }
  return id
}

function version(value: string): string {
  if (!VERSION.test(value)) {
    throw new MarketApiError({ code: 'invalid', status: null, message: 'Not a version.' })
  }
  return value
}

export interface MarketApiDeps {
  /** The account service's base, which serves `/api/v1/marketplace`. */
  base: string
  token: string
  fetch: Fetch
}

export interface PublishFile {
  path: string
  bytes: Uint8Array
}

export class MarketApi {
  constructor(private readonly deps: MarketApiDeps) {}

  async publisher(): Promise<MarketPublisher | null> {
    const body = await this.json('/publisher', { method: 'GET' })
    return body?.publisher == null ? null : parsePublisher(body.publisher)
  }

  async setPublisher(handle: string): Promise<MarketPublisher> {
    const body = await this.json('/publisher', { method: 'PUT', json: { handle } })
    return parsePublisher(body?.publisher)
  }

  /**
   * A new listing, or a new version of one: one part per file, named by its path. A 202 answers
   * that the version is stored and held for review, which `held` names.
   */
  async publish(manifest: PublishManifest, files: readonly PublishFile[]): Promise<PublishResult> {
    const data = new FormData()
    data.append('manifest', JSON.stringify(manifest))
    for (const file of files) {
      data.append(file.path, new Blob([file.bytes as Uint8Array<ArrayBuffer>]), file.path)
    }
    const { status, body } = await this.answer(
      '/versions',
      { method: 'POST', body: data },
      { version: manifest.version },
    )
    const listing = parseMineListing(body?.listing)
    if (status !== 202) return listing
    const held = text(body?.held)
    if (held === null || !VERSION.test(held)) throw unexpected('listing')
    return { ...listing, held }
  }

  async update(id: string, change: ListingChange): Promise<MineListing> {
    const body = await this.json(`/listings/${listing(id)}`, { method: 'PATCH', json: change })
    return parseMineListing(body?.listing)
  }

  async withdraw(id: string, at: string): Promise<MineListing> {
    const body = await this.json(`/listings/${listing(id)}/versions/${version(at)}/withdraw`, {
      method: 'POST',
    })
    return parseMineListing(body?.listing)
  }

  async remove(id: string): Promise<void> {
    await this.json(`/listings/${listing(id)}`, { method: 'DELETE' })
  }

  async mine(): Promise<MarketMine> {
    const body = await this.json('/mine', { method: 'GET' })
    const storage = record(body?.storage)
    if (!Array.isArray(body?.listings) || !storage) throw unexpected('mine')
    return {
      publisher: body.publisher == null ? null : parsePublisher(body.publisher),
      listings: body.listings.map(parseMineListing),
      storage: {
        bytes: isCount(storage.bytes) ? storage.bytes : 0,
        limit: isCount(storage.limit) ? storage.limit : 0,
      },
    }
  }

  async directory(query: {
    q?: string
    kind?: PublishKind
    cursor?: string
  }): Promise<MarketDirectory> {
    const params = new URLSearchParams()
    if (query.q) params.set('q', query.q)
    if (query.kind) params.set('kind', query.kind)
    if (query.cursor) params.set('cursor', query.cursor)
    const search = params.toString()
    const body = await this.json(`/directory${search ? `?${search}` : ''}`, { method: 'GET' })
    if (!Array.isArray(body?.items)) throw unexpected('directory')
    return { items: body.items.map(parseListing), next: text(body.next) }
  }

  async listing(id: string): Promise<MarketListing> {
    const body = await this.json(`/listings/${listing(id)}`, { method: 'GET' })
    return parseListing(body?.listing)
  }

  async version(id: string, at: string): Promise<MarketVersionFiles> {
    return parseVersionFiles(
      await this.json(`/listings/${listing(id)}/versions/${version(at)}`, { method: 'GET' }),
    )
  }

  /** A file's bytes, with the SHA-256 the service says it has; the caller checks it. */
  async file(
    id: string,
    at: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; sha256: string | null }> {
    const parts = path.split('/').map((part) => segment(part, 'file path'))
    const response = await this.send(
      `/listings/${listing(id)}/versions/${version(at)}/files/${parts.join('/')}`,
      { method: 'GET' },
    )
    if (!response.ok) await this.refused(response)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { bytes, sha256: response.headers.get('x-content-sha256') }
  }

  async countInstall(id: string, at: string, reason: 'install' | 'update'): Promise<void> {
    await this.json(`/listings/${listing(id)}/installs`, {
      method: 'POST',
      json: { version: version(at), reason },
    })
  }

  async report(id: string, message: string): Promise<void> {
    await this.json(`/listings/${listing(id)}/reports`, { method: 'POST', json: { message } })
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    const headers = {
      ...Object.fromEntries(new Headers(init.headers)),
      authorization: `Bearer ${this.deps.token}`,
    }
    try {
      return await this.deps.fetch(`${this.deps.base}/api/v1/marketplace${path}`, {
        ...init,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw new MarketApiError({
        code: 'network',
        status: null,
        message: t('market.unreachable', { reason: (error as Error).message }),
      })
    }
  }

  /** Throws the failure an error answer says. */
  private async refused(response: Response, sent: Sent = {}): Promise<never> {
    const raw = await response.text().catch(() => '')
    let body: Fields | null
    try {
      body = raw ? record(JSON.parse(raw)) : null
    } catch {
      body = null
    }
    const failure = failureOf(response.status, body, sent)
    if (response.status === 401 || failure.code === 'unauthorized') {
      throw new MarketUnauthorized(failure.message)
    }
    throw new MarketApiError(failure)
  }

  /** The answer's JSON, null for an empty one. */
  private async json(
    path: string,
    init: RequestInit & { json?: unknown },
    sent: Sent = {},
  ): Promise<Fields | null> {
    return (await this.answer(path, init, sent)).body
  }

  /** The status of a successful answer with its JSON, null for an empty one. */
  private async answer(
    path: string,
    { json, ...init }: RequestInit & { json?: unknown },
    sent: Sent = {},
  ): Promise<{ status: number; body: Fields | null }> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (json !== undefined) headers['content-type'] = 'application/json'
    const response = await this.send(path, {
      ...init,
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    })
    if (!response.ok) return this.refused(response, sent)
    const raw = await response.text().catch(() => '')
    if (!raw) return { status: response.status, body: null }
    try {
      const body = record(JSON.parse(raw))
      if (!body) throw new Error('not an object')
      return { status: response.status, body }
    } catch {
      throw unexpected('request')
    }
  }
}

/** Runs `call` with a fresh access token, refreshed once when the service refuses it. */
export type WithToken = <T>(call: (token: string) => Promise<T>) => Promise<T>

export interface MarketCallsDeps {
  base: string
  fetch: Fetch
  /** Throws when the account is signed out or Kettu's services are off. */
  withToken: WithToken
  /** Whether an error `withToken` threw means there is no sign-in to use. */
  signedOut: (error: unknown) => boolean
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

/**
 * A call as the agent host sent it, with each argument of the type its kind takes; null for any
 * other. Ids, versions and paths are checked again where they go into a URL.
 */
export function marketCallOf(value: unknown): MarketCall | null {
  const call = record(value)
  if (!call) return null
  const id = (): boolean => isText(call.id, 64)
  const at = (): boolean => isText(call.version, 64)
  switch (call.kind) {
    case 'publisher':
    case 'mine':
      return call as MarketCall
    case 'set-publisher':
      return isText(call.handle, 64) ? (call as MarketCall) : null
    case 'publish':
      return record(call.manifest) &&
        Array.isArray(call.files) &&
        call.files.every(
          (file) => isText(record(file)?.path, 1024) && typeof record(file)?.data === 'string',
        )
        ? (call as MarketCall)
        : null
    case 'update':
      return id() && record(call.change) ? (call as MarketCall) : null
    case 'withdraw':
    case 'version':
      return id() && at() ? (call as MarketCall) : null
    case 'delete':
    case 'listing':
      return id() ? (call as MarketCall) : null
    case 'directory':
      return (call.q === undefined || typeof call.q === 'string') &&
        (call.cursor === undefined ||
          (typeof call.cursor === 'string' && DIRECTORY_CURSOR.test(call.cursor))) &&
        (call.listingKind === undefined || kindOf(call.listingKind) !== null)
        ? (call as MarketCall)
        : null
    case 'file':
      return id() && at() && isText(call.path, 1024) ? (call as MarketCall) : null
    case 'install':
      return id() && at() && (call.reason === 'install' || call.reason === 'update')
        ? (call as MarketCall)
        : null
    case 'report':
      return id() && isText(call.message, 4000) ? (call as MarketCall) : null
    default:
      return null
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function bytesOf(data: string): Uint8Array {
  if (!BASE64.test(data))
    throw new MarketApiError({ code: 'invalid', status: null, message: 'A file is not base64.' })
  return new Uint8Array(Buffer.from(data, 'base64'))
}

/** Makes one call the agent host asked for; every failure comes back as an answer. */
export async function runMarketCall(
  call: MarketCall,
  deps: MarketCallsDeps,
): Promise<MarketCallAnswer> {
  try {
    const result = await deps.withToken((token) =>
      perform(new MarketApi({ base: deps.base, token, fetch: deps.fetch }), call),
    )
    return { result }
  } catch (error) {
    if (error instanceof MarketApiError) return { error: error.failure }
    if (deps.signedOut(error)) {
      return {
        error: {
          code: 'signed_out',
          status: null,
          message: t('market.signedOut'),
        },
      }
    }
    return { error: { code: 'failed', status: null, message: (error as Error).message } }
  }
}

async function perform(api: MarketApi, call: MarketCall): Promise<unknown> {
  switch (call.kind) {
    case 'publisher':
      return api.publisher()
    case 'set-publisher':
      return api.setPublisher(call.handle)
    case 'mine':
      return api.mine()
    case 'publish':
      return api.publish(
        call.manifest,
        call.files.map((file) => ({ path: file.path, bytes: bytesOf(file.data) })),
      )
    case 'update':
      return api.update(call.id, call.change)
    case 'withdraw':
      return api.withdraw(call.id, call.version)
    case 'delete':
      await api.remove(call.id)
      return null
    case 'directory':
      return api.directory({
        ...(call.q ? { q: call.q } : {}),
        ...(call.listingKind ? { kind: call.listingKind } : {}),
        ...(call.cursor ? { cursor: call.cursor } : {}),
      })
    case 'listing':
      return api.listing(call.id)
    case 'version':
      return api.version(call.id, call.version)
    case 'file': {
      const { bytes, sha256 } = await api.file(call.id, call.version, call.path)
      return { data: Buffer.from(bytes).toString('base64'), sha256 }
    }
    case 'install':
      await api.countInstall(call.id, call.version, call.reason)
      return null
    case 'report':
      await api.report(call.id, call.message)
      return null
    default:
      throw new MarketApiError({ code: 'invalid', status: null, message: 'Unknown call.' })
  }
}
