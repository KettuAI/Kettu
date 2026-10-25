// `published-artifacts.json`: the Cloudflare account main publishes with, its token encrypted, and
// the pages it has published. Main owns the file; the renderer sees neither the token nor a path.

import { join } from 'node:path'
import { ARTIFACT_ID } from '@shared/artifacts'
import { CLOUDFLARE_ACCOUNT_ID } from '@shared/sharing'
import { JsonFileWriter, quarantineFile, readJsonFile } from '../json-file'
import { createLogger } from '../log'

const log = createLogger('sharing')

const VERSION = 1
const MAX_PUBLISHED = 10_000
const MAX_TOKEN_CHARS = 16_384
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const WORKER = /^ob-[a-z2-7]{16}$/
const MAX_URL_CHARS = 2_048

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

/** One published artifact: the Worker that serves it and the version it shows. */
export interface PublishedPage {
  id: string
  worker: string
  url: string
  version: number
  publishedAt: number
  accountId: string
}

interface SharingFile {
  version: 1
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

function parsePage(raw: unknown): PublishedPage | null {
  if (!isRecord(raw)) return null
  const { id, worker, url, version, publishedAt, accountId } = raw
  if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) return null
  if (typeof worker !== 'string' || !WORKER.test(worker)) return null
  if (typeof url !== 'string' || url.length > MAX_URL_CHARS || !url.startsWith('https://')) {
    return null
  }
  if (!Number.isSafeInteger(version) || (version as number) < 1) return null
  if (!Number.isSafeInteger(publishedAt) || (publishedAt as number) < 0) return null
  if (typeof accountId !== 'string' || !CLOUDFLARE_ACCOUNT_ID.test(accountId)) return null
  return {
    id,
    worker,
    url,
    version: version as number,
    publishedAt: publishedAt as number,
    accountId,
  }
}

function parseFile(raw: unknown): SharingFile | null {
  if (!isRecord(raw) || raw.version !== VERSION) return null
  const account = raw.account === null ? null : parseAccount(raw.account)
  if (raw.account !== null && account === null) return null
  if (!Array.isArray(raw.published) || raw.published.length > MAX_PUBLISHED) return null
  const published: PublishedPage[] = []
  const ids = new Set<string>()
  for (const value of raw.published) {
    const page = parsePage(value)
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
    if (read.kind === 'ok') state = parseFile(read.value) ?? empty
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

/** The pages whose artifact the host no longer has, for main to take down at launch. */
export function pagesToUnpublish(
  pages: readonly PublishedPage[],
  artifactIds: ReadonlySet<string>,
  accountId: string,
): PublishedPage[] {
  return pages.filter((page) => page.accountId === accountId && !artifactIds.has(page.id))
}

/** The pages whose Worker Cloudflare no longer has, which main forgets without a request. */
export function pagesToForget(
  pages: readonly PublishedPage[],
  workers: ReadonlySet<string>,
  accountId: string,
): PublishedPage[] {
  return pages.filter((page) => page.accountId === accountId && !workers.has(page.worker))
}
