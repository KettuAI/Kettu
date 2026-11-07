// `published-artifacts.json`: the Cloudflare account main publishes with, its token encrypted, and
// the pages it has published, each with the target and account it lives in. Main owns the file;
// the renderer sees neither the token nor a path.

import { join } from 'node:path'
import { ARTIFACT_ID } from '@shared/artifacts'
import {
  ACCESS_CODE,
  CLOUDFLARE_ACCOUNT_ID,
  SHARE_ACCESS,
  type ShareAccess,
  type SharingTarget,
} from '@shared/sharing'
import { JsonFileWriter, quarantineFile, readJsonFile } from '../json-file'
import { createLogger } from '../log'

const log = createLogger('sharing')

const VERSION = 2
const MAX_PUBLISHED = 10_000
const MAX_TOKEN_CHARS = 16_384
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const WORKER = /^ob-[a-z2-7]{16}$/
/** A page's id at Kettu's sharing service: 20 lowercase base32 characters. */
export const KETTU_PAGE = /^[a-z2-7]{20}$/
/** A Kettu account's id as the account service gives it. */
export const KETTU_ACCOUNT = /^[A-Za-z0-9-]{1,64}$/
const MAX_URL_CHARS = 2_048
const MAX_EMAIL_CHARS = 320

/**
 * A page's address as a target gave it: https, or http on a loopback name, which only a
 * development copy of the service gives.
 */
export function pageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL_CHARS) return null
  const url = URL.parse(raw)
  if (!url || url.username || url.password) return null
  if (url.protocol === 'https:') return url.href
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
  return url.protocol === 'http:' && local ? url.href : null
}

/** Encrypts and decrypts the token; the asynchronous half of Electron's safeStorage in main. */
export interface TokenCipher {
  encrypt(plainText: string): Promise<string>
  decrypt(encrypted: string): Promise<string>
}

/** The account as the file keeps it: the token is the cipher's own text, never the token itself. */
export interface StoredAccount {
  accountId: string
  subdomain: string
  token: string
  /** The system stores the token without its encryption, as on Linux without a keyring. */
  plainText: boolean
}

/**
 * One published artifact: where it lives, what the target knows it by (Kettu's page id or the
 * Cloudflare Worker's name), the version it shows and the account it was published with.
 */
export interface PublishedPage {
  id: string
  target: SharingTarget
  ref: string
  url: string
  version: number
  publishedAt: number
  /** The Kettu account's id, or the Cloudflare account's. */
  accountId: string
  /** The Kettu account's email when it was published, to name it once another one signs in. */
  accountEmail: string | null
  /** As the service last said, kept to show it offline; public on Cloudflare. */
  access: ShareAccess
  /** The access code while the level is `code`. */
  code: string | null
}

export interface SharingFile {
  version: 2
  account: StoredAccount | null
  published: PublishedPage[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAccount(raw: unknown): StoredAccount | null {
  if (!isRecord(raw)) return null
  const { accountId, subdomain, token, plainText } = raw
  if (typeof accountId !== 'string' || !CLOUDFLARE_ACCOUNT_ID.test(accountId)) return null
  if (typeof subdomain !== 'string' || !SUBDOMAIN.test(subdomain)) return null
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null
  if (typeof plainText !== 'boolean') return null
  return { accountId, subdomain, token, plainText }
}

/** A page of the file at `version`: those of version 1 were all published to Cloudflare. */
function parsePage(raw: unknown, version: 1 | 2): PublishedPage | null {
  if (!isRecord(raw)) return null
  const { id, url: rawUrl, publishedAt, accountId } = raw
  const target = version === 1 ? 'cloudflare' : raw.target
  const ref = version === 1 ? raw.worker : raw.ref
  const accountEmail = version === 1 ? null : raw.accountEmail
  if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) return null
  const url = pageUrl(rawUrl)
  if (url === null) return null
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) return null
  if (!Number.isSafeInteger(publishedAt) || (publishedAt as number) < 0) return null
  if (typeof accountId !== 'string' || typeof ref !== 'string') return null
  if (target === 'cloudflare') {
    // Cloudflare's addresses are always https.
    if (!WORKER.test(ref) || !CLOUDFLARE_ACCOUNT_ID.test(accountId)) return null
    if (!url.startsWith('https://') || accountEmail !== null) return null
  } else if (target === 'kettu') {
    if (!KETTU_PAGE.test(ref) || !KETTU_ACCOUNT.test(accountId)) return null
    if (
      accountEmail !== null &&
      (typeof accountEmail !== 'string' || accountEmail.length > MAX_EMAIL_CHARS)
    ) {
      return null
    }
  } else {
    return null
  }
  // Entries from before levels have none, and were public.
  const access = raw.access === undefined ? 'public' : raw.access
  const code = raw.code === undefined ? null : raw.code
  if (!SHARE_ACCESS.includes(access as ShareAccess)) return null
  if (code !== null && (typeof code !== 'string' || !ACCESS_CODE.test(code))) return null
  if ((access === 'code') !== (code !== null)) return null
  if (target === 'cloudflare' && access !== 'public') return null
  return {
    id,
    target,
    ref,
    url,
    version: raw.version as number,
    publishedAt: publishedAt as number,
    accountId,
    accountEmail: accountEmail as string | null,
    access: access as ShareAccess,
    code: code as string | null,
  }
}

/** The file as main keeps it, from version 1 or 2; null for anything else. */
export function parseSharingFile(raw: unknown): SharingFile | null {
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== VERSION)) return null
  const fileVersion = raw.version
  const account = raw.account === null ? null : parseAccount(raw.account)
  if (raw.account !== null && account === null) return null
  if (!Array.isArray(raw.published) || raw.published.length > MAX_PUBLISHED) return null
  const published: PublishedPage[] = []
  const ids = new Set<string>()
  for (const value of raw.published) {
    const page = parsePage(value, fileVersion)
    // One page per artifact: a duplicate would let one overwrite the other's entry.
    if (!page || ids.has(page.id)) return null
    ids.add(page.id)
    published.push(page)
  }
  return { version: VERSION, account, published }
}

/**
 * Owns `published-artifacts.json`. The token is encrypted before it reaches the file and decrypted
 * only when main needs it for a request.
 */
export class SharingStore {
  private constructor(
    private state: SharingFile,
    private readonly cipher: TokenCipher,
    private readonly writer: JsonFileWriter,
  ) {}

  static async load(userDataPath: string, cipher: TokenCipher): Promise<SharingStore> {
    const path = join(userDataPath, 'published-artifacts.json')
    const empty: SharingFile = { version: VERSION, account: null, published: [] }
    const read = await readJsonFile(path)
    let state = empty
    if (read.kind === 'ok') state = parseSharingFile(read.value) ?? empty
    if (read.kind === 'unreadable' || (read.kind === 'ok' && state === empty)) {
      log.warn(
        `published-artifacts.json is invalid${read.kind === 'unreadable' ? `: ${read.reason}` : ''}`,
      )
      try {
        log.warn(`Moved the invalid file to ${await quarantineFile(path)}`)
      } catch (error) {
        log.error('Could not move the invalid published-artifacts.json aside', error)
      }
    }
    return new SharingStore(state, cipher, new JsonFileWriter(path, log))
  }

  account(): StoredAccount | null {
    return this.state.account
  }

  /** The token in the clear, or null without an account; only main's network calls see it. */
  async token(): Promise<string | null> {
    const account = this.state.account
    return account ? this.cipher.decrypt(account.token) : null
  }

  /** Keeps an account whose token and subdomain the caller has already checked. */
  async connect(
    accountId: string,
    subdomain: string,
    token: string,
    plainText: boolean,
  ): Promise<void> {
    const encrypted = await this.cipher.encrypt(token)
    this.state = {
      ...this.state,
      account: { accountId, subdomain, token: encrypted, plainText },
    }
    this.save()
  }

  /** Forgets the account; the pages it published stay where they are. */
  removeAccount(): void {
    if (!this.state.account) return
    this.state = { ...this.state, account: null }
    this.save()
  }

  published(): readonly PublishedPage[] {
    return this.state.published
  }

  page(id: string): PublishedPage | undefined {
    return this.state.published.find((page) => page.id === id)
  }

  /** Adds a page, or replaces the entry of the same artifact. */
  put(page: PublishedPage): void {
    const published = this.state.published.filter((entry) => entry.id !== page.id)
    this.state = { ...this.state, published: [...published, page] }
    this.save()
  }

  forget(id: string): void {
    const published = this.state.published.filter((page) => page.id !== id)
    if (published.length === this.state.published.length) return
    this.state = { ...this.state, published }
    this.save()
  }

  flush(): Promise<void> {
    return this.writer.flush()
  }

  private save(): void {
    this.writer.schedule(this.state)
  }
}

/** The pages of a target and account whose artifact the host no longer has, to take down. */
export function pagesToUnpublish(
  pages: readonly PublishedPage[],
  artifactIds: ReadonlySet<string>,
  target: SharingTarget,
  accountId: string,
): PublishedPage[] {
  return pages.filter(
    (page) => page.target === target && page.accountId === accountId && !artifactIds.has(page.id),
  )
}

/** The pages of a target and account the target no longer has, which main forgets. */
export function pagesToForget(
  pages: readonly PublishedPage[],
  refs: ReadonlySet<string>,
  target: SharingTarget,
  accountId: string,
): PublishedPage[] {
  return pages.filter(
    (page) => page.target === target && page.accountId === accountId && !refs.has(page.ref),
  )
}
