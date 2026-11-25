// Plan limits read with the sign-in a harness keeps itself, for a harness that offers no read of
// its own. The stored credential is read in memory for one request to its vendor's listed endpoint
// and dropped: it is never kept, logged, refreshed, or put into an error or a result.

import { readFile } from 'node:fs/promises'
import type { Platform } from '@shared/platform'
import { getEnv, type Env } from '../find-command'
import { t } from '../i18n'
import { proxyFetch } from '../proxy-fetch'
import { versionAtLeast } from '../versions'
import { readBody, type VendorUsage } from './common'

/** Where a read looks for the harness's sign-in, and how it asks. */
export interface SignInPlace {
  env: Env
  home: string
  platform: Platform
  now: number
  /** Through the proxy `env` names by default. */
  fetch?: typeof globalThis.fetch
  /** Runs the harness so it renews its own token; Kettu never refreshes one itself. */
  renew?: () => Promise<void>
}

export interface StoredSignInReader {
  /**
   * The harness version whose sign-in location and reply were checked. Later versions read too,
   * and a reply one of them changed fails the read.
   */
  version: string
  read(place: SignInPlace): Promise<VendorUsage>
}

/** A read that failed. Its message says only what failed, never what was read or answered. */
export class UsageReadError extends Error {
  override name = 'UsageReadError'

  constructor(
    message: string,
    /** The vendor's HTTP status, when it answered with an error. */
    readonly status?: number,
  ) {
    super(message)
  }
}

const TIMEOUT_MS = 10_000

/** A variable of the agent's environment, trimmed; undefined when unset or blank. */
export function variable(place: SignInPlace, name: string): string | undefined {
  const value = getEnv(place.env, name, place.platform)?.trim()
  return value ? value : undefined
}

/** A file of the harness's sign-in; null when there is none. */
export async function readSignInFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new UsageReadError(t('usageRead.storedUnreadable'))
  }
}

/** JSON that may hold a credential, parsed without ever quoting it in an error. */
export function parseSignIn(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new UsageReadError(t('usageRead.storedUnreadable'))
  }
}

export interface VendorRequest {
  /** The vendor, for the error. */
  vendor: string
  /** The origins the credential may go to: the vendor's listed endpoints. */
  origins: readonly string[]
  url: string
  method?: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  /** How long the vendor may take, when a read is worth less than the default wait. */
  timeoutMs?: number
}

/**
 * Asks a listed vendor endpoint and returns its JSON. A request to any other origin is refused
 * before it is sent; redirects are refused too, so the credential cannot follow one elsewhere.
 */
export async function askVendor(request: VendorRequest, place: SignInPlace): Promise<unknown> {
  const { vendor } = request
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    throw new UsageReadError(t('usageRead.endpointNotListed', { vendor }))
  }
  if (url.protocol !== 'https:' || !request.origins.includes(url.origin)) {
    throw new UsageReadError(t('usageRead.endpointNotListed', { vendor }))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? TIMEOUT_MS)
  let response: Response
  try {
    const fetcher = place.fetch ?? proxyFetch(() => place.env, place.platform)
    response = await fetcher(url.href, {
      method: request.method ?? 'GET',
      headers: { accept: 'application/json', ...request.headers },
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: 'error',
      signal: controller.signal,
    })
  } catch {
    clearTimeout(timer)
    throw new UsageReadError(t('usageRead.unreachable', { vendor }))
  }
  try {
    if (response.status === 401 || response.status === 403) {
      throw new UsageReadError(t('usageRead.notAccepted', { vendor }), response.status)
    }
    if (!response.ok) {
      throw new UsageReadError(
        t('usageRead.answered', { vendor, status: response.status }),
        response.status,
      )
    }
    let text: string
    try {
      text = await readBody(response)
    } catch {
      throw new UsageReadError(t('usageRead.replyUnreadable', { vendor }))
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new UsageReadError(t('usageRead.replyUnreadable', { vendor }))
    }
  } finally {
    clearTimeout(timer)
    // Nothing else of a refused answer is read, since it may echo what was sent.
    if (!response.bodyUsed) await response.body?.cancel().catch(() => {})
  }
}

/** Whether a reader is open for this harness version: the checked one or a later one. */
export function readerOpen(
  reader: StoredSignInReader,
  version: string | null | undefined,
): boolean {
  return versionAtLeast(version, reader.version)
}
