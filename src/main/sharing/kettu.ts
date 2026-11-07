// Kettu's own sharing service as a target: the pages of the Kettu account the host is signed in to,
// published through the sharing API with that account's access token. The service gives every
// address; nothing here builds one.

import { ACCESS_CODE, SHARE_ACCESS, type ShareAccess, type SharingFailure } from '@shared/sharing'
import { SharingError, type PageFile, type Published, type SharingProvider } from './provider'
import { KETTU_PAGE, pageUrl } from './store'

const TIMEOUT_MS = 120_000
const MAX_MESSAGE = 500

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** Who can open a page as the service says, and whether it takes no code for now. */
export interface KettuAccess {
  access: ShareAccess
  code: string | null
  codeLocked: boolean
}

/** A page as the service lists it. */
export interface KettuPage extends KettuAccess {
  id: string
  url: string
  bytes: number
}

/** The account's pages and its cloud storage, in bytes. */
export interface KettuPages {
  pages: KettuPage[]
  used: number
  limit: number
}

/** The service refused the access token: refreshing it may help, once. */
export class KettuUnauthorized extends SharingError {
  constructor(message: string) {
    super('signed_out', message)
    this.name = 'KettuUnauthorized'
  }
}

/** The service's error codes that have a failure of their own. */
const FAILURES: Partial<Record<string, SharingFailure>> = {
  storage_full: 'storage_full',
  page_too_large: 'page_too_large',
  taken_down: 'taken_down',
  rate_limited: 'rate_limited',
  account_disabled: 'signed_out',
  not_found: 'not_found',
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const isSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * The level a page answer names; a service from before levels names none, and its pages are
 * public. A code comes only with the `code` level.
 */
function accessOf(body: Record<string, unknown> | null): KettuAccess {
  const raw = body?.access
  if (raw !== undefined && !SHARE_ACCESS.includes(raw as ShareAccess)) {
    throw unexpected('the page’s level')
  }
  const access = (raw ?? 'public') as ShareAccess
  const code = access === 'code' ? body?.code : null
  if (code !== null && (typeof code !== 'string' || !ACCESS_CODE.test(code))) {
    throw unexpected('the page’s access code')
  }
  return { access, code: code as string | null, codeLocked: body?.codeLocked === true }
}

export interface KettuShareDeps {
  /** The sharing API's base, the account service's own: `<base>/api/v1/shares`. */
  base: string
  token: string
  fetch: Fetch
}

export class KettuShare implements SharingProvider {
  constructor(private readonly deps: KettuShareDeps) {}

  async publish(
    files: readonly PageFile[],
    _headers: Record<string, string>,
    access: ShareAccess,
  ): Promise<Published> {
    const body = await this.request(`?access=${access}`, { method: 'POST', body: form(files) })
    const id = body?.id
    const url = pageUrl(body?.url)
    if (typeof id !== 'string' || !KETTU_PAGE.test(id) || url === null) {
      throw unexpected('the page it published')
    }
    const { access: given, code } = accessOf(body)
    return { url, ref: id, access: given, code }
  }

  /** Changes who can open the page, or draws it a new access code; what the service says now. */
  async setAccess(
    ref: string,
    change: { access?: ShareAccess; newCode?: true },
  ): Promise<KettuAccess> {
    const body = await this.request(`/${page(ref)}`, {
      method: 'PATCH',
      body: JSON.stringify(change),
      json: true,
    })
    return accessOf(body)
  }

  /**
   * A one-time address that opens the page for its publisher without its code or a sign-in, on
   * the page's own host only.
   */
  async openLink(ref: string, pageAddress: string): Promise<string> {
    const body = await this.request(`/${page(ref)}/open`, { method: 'POST' })
    const url = pageUrl(body?.url)
    if (url === null || new URL(url).origin !== new URL(pageAddress).origin) {
      throw unexpected('the address that opens the page')
    }
    return url
  }

  async update(ref: string, files: readonly PageFile[]): Promise<void> {
    await this.request(`/${page(ref)}`, { method: 'PUT', body: form(files) })
  }

  async unpublish(ref: string): Promise<void> {
    try {
      await this.request(`/${page(ref)}`, { method: 'DELETE' })
    } catch (error) {
      if (error instanceof SharingError && error.failure === 'not_found') return
      throw error
    }
  }

  async existing(refs: readonly string[]): Promise<Set<string>> {
    const { pages } = await this.list()
    const wanted = new Set(refs)
    return new Set(pages.map((entry) => entry.id).filter((id) => wanted.has(id)))
  }

  /** How many people look at each page now, by its ref; another account's pages answer none. */
  async visitors(refs: readonly string[]): Promise<Map<string, number>> {
    const body = await this.request(`/visitors?ids=${refs.map(page).join(',')}`, { method: 'GET' })
    const counts = record(body?.visitors)
    if (!counts) throw unexpected('its visitors')
    const found = new Map<string, number>()
    for (const ref of refs) {
      const count = counts[ref]
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0) found.set(ref, count)
    }
    return found
  }

  /** Every page of the account, with the address the service gives it now, and the storage. */
  async list(): Promise<KettuPages> {
    const body = await this.request('', { method: 'GET' })
    const usage = record(body?.usage)
    if (!Array.isArray(body?.pages) || !usage || !isSize(usage.bytes) || !isSize(usage.limit)) {
      throw unexpected('its pages')
    }
    const pages: KettuPage[] = []
    for (const raw of body.pages as unknown[]) {
      const entry = record(raw)
      const url = pageUrl(entry?.url)
      if (!entry || typeof entry.id !== 'string' || !KETTU_PAGE.test(entry.id) || url === null) {
        throw unexpected('its pages')
      }
      pages.push({
        id: entry.id,
        url,
        bytes: isSize(entry.bytes) ? entry.bytes : 0,
        ...accessOf(entry),
      })
    }
    return { pages, used: usage.bytes, limit: usage.limit }
  }

  /** The answer's JSON, null for an empty one; any error as a `SharingError`. */
  private async request(
    path: string,
    { json = false, ...init }: RequestInit & { json?: boolean },
  ): Promise<Record<string, unknown> | null> {
    let response: Response
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.deps.token}`,
    }
    if (json) headers['content-type'] = 'application/json'
    try {
      response = await this.deps.fetch(`${this.deps.base}/api/v1/shares${path}`, {
        ...init,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw new SharingError('network', `Could not reach Kettu: ${(error as Error).message}`)
    }
    const text = await response.text().catch(() => '')
    let body: Record<string, unknown> | null
    try {
      body = text ? record(JSON.parse(text)) : null
    } catch {
      body = null
    }
    if (response.ok) {
      if (text && !body) throw unexpected('the request')
      return body
    }
    const code = typeof body?.error === 'string' ? body.error : null
    const said = typeof body?.message === 'string' ? body.message.slice(0, MAX_MESSAGE) : null
    if (response.status === 401 || code === 'unauthorized') {
      throw new KettuUnauthorized(said ?? 'Kettu did not take the sign-in.')
    }
    const failure =
      (code ? FAILURES[code] : undefined) ?? (response.status === 404 ? 'not_found' : 'failed')
    throw new SharingError(failure, said ?? `Kettu answered ${response.status}`, said)
  }
}

/** One part per file, named by its path from the page's root. */
function form(files: readonly PageFile[]): FormData {
  const data = new FormData()
  for (const file of files) {
    data.append(file.path, new Blob([file.bytes as Uint8Array<ArrayBuffer>]), file.path)
  }
  return data
}

function page(ref: string): string {
  if (!KETTU_PAGE.test(ref)) throw new SharingError('failed', 'Not a Kettu page id.')
  return ref
}

function unexpected(what: string): SharingError {
  return new SharingError('failed', `The sharing service answered ${what} in a form not understood`)
}
