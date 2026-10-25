// Publishing artifacts online: main holds the account, reads the version from the agent host, and
// talks to the target, so the renderer never names a URL and never sees the token.

import { readFile } from 'node:fs/promises'
import { ARTIFACT_ID } from '@shared/artifacts'
import type { ArtifactContentResult } from '@shared/host-control'
import {
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_TOKEN,
  type SharingFailure,
  type SharingResult,
  type SharingStatus,
} from '@shared/sharing'
import { isInside } from '../artifacts/protocol'
import { createLogger } from '../log'
import { Cloudflare, verifyAccount, type Fetch } from './cloudflare'
import { pageHeaders, withMeta } from './page'
import { SharingError, type SharingProvider } from './provider'
import {
  pagesToForget,
  pagesToUnpublish,
  SharingStore,
  type PublishedPage,
  type StoredAccount,
  type TokenCipher,
} from './store'

const log = createLogger('sharing')

/** What main needs from the agent host: the version's file and every artifact it has. */
export interface SharingHost {
  content(id: string, version: number | null): Promise<ArtifactContentResult>
  ids(): Promise<Set<string> | null>
}

export interface SharingDeps {
  userDataPath: string
  /** `artifacts/content/` in the data folder. */
  contentDir: string
  host: SharingHost
  cipher: TokenCipher
  /** Whether the system can encrypt the token; false on a machine without a secret store. */
  encryptionAvailable(): Promise<boolean>
  /** Whether the token would be stored without the system's encryption, as on Linux. */
  plainText(): boolean
  fetch: Fetch
  random?(size: number): Buffer
  now?(): number
  /** Told of every change, for the windows; the token is not part of the status. */
  changed?(status: SharingStatus): void
}

function failed(failure: SharingFailure, message: string | null = null): SharingResult {
  return { failed: failure, message }
}

/** An artifact id and a version number from the renderer, checked. */
function target(id: unknown, version: unknown): { id: string; version: number } | null {
  if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) return null
  if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 1e9) {
    return null
  }
  return { id, version: version as number }
}

/**
 * The published artifacts, their account, and the calls the renderer's sharing channels make.
 * Publishing is the user's own action: no agent reaches these calls.
 */
export class Sharing {
  private reconciling: Promise<void> | null = null

  private constructor(
    private readonly deps: SharingDeps,
    private readonly store: SharingStore,
  ) {}

  static async load(deps: SharingDeps): Promise<Sharing> {
    return new Sharing(deps, await SharingStore.load(deps.userDataPath, deps.cipher))
  }

  /** What the interface shows; the token stays in main. */
  status(): SharingStatus {
    const account = this.store.account()
    return {
      cloudflare: account
        ? {
            accountId: account.accountId,
            subdomain: account.subdomain,
            plainText: account.plainText,
          }
        : null,
      published: this.store.published().map((page) => ({
        id: page.id,
        url: page.url,
        version: page.version,
        publishedAt: page.publishedAt,
        otherAccount: page.accountId !== account?.accountId,
      })),
    }
  }

  /** Checks the account and token with Cloudflare, then keeps them. */
  async connect(rawAccountId: unknown, rawToken: unknown): Promise<SharingResult> {
    const accountId = typeof rawAccountId === 'string' ? rawAccountId.trim().toLowerCase() : ''
    const token = typeof rawToken === 'string' ? rawToken.trim() : ''
    if (!CLOUDFLARE_ACCOUNT_ID.test(accountId)) {
      return failed('failed', 'The account ID must be 32 hexadecimal characters.')
    }
    if (!CLOUDFLARE_TOKEN.test(token)) return failed('failed', 'The API token is not valid.')
    try {
      if (!(await this.deps.encryptionAvailable())) {
        return failed('encryption', 'This system cannot encrypt the token.')
      }
      const subdomain = await verifyAccount(this.deps.fetch, accountId, token)
      await this.store.connect(accountId, subdomain, token, this.deps.plainText())
      return this.report()
    } catch (error) {
      return this.failure(error)
    }
  }

  /** Forgets the account and its token; published pages stay as they are. */
  remove(): SharingStatus {
    this.store.removeAccount()
    const status = this.status()
    this.deps.changed?.(status)
    return status
  }

  /** Publishes a version at a new URL; publishing an already published artifact updates it. */
  async publish(rawId: unknown, rawVersion: unknown): Promise<SharingResult> {
    const wanted = target(rawId, rawVersion)
    if (!wanted) return failed('failed', 'Not an artifact id and version.')
    const account = this.store.account()
    if (!account) return failed('no_account')
    const page = this.store.page(wanted.id)
    if (page) {
      if (page.accountId !== account.accountId) return failed('other_account')
      return this.deploy(account, page, wanted.version)
    }
    try {
      const token = await this.tokenOf()
      const content = await this.readHtml(wanted.id, wanted.version)
      const published = await this.provider(account, token).publish(
        withMeta(content.html),
        pageHeaders(),
      )
      this.store.put({
        id: wanted.id,
        worker: published.ref,
        url: published.url,
        version: content.version,
        publishedAt: this.now(),
        accountId: account.accountId,
      })
      return this.report()
    } catch (error) {
      return this.failure(error)
    }
  }

  /** Replaces the page at its URL with a later version; the earlier one stays reachable nowhere. */
  async update(rawId: unknown, rawVersion: unknown): Promise<SharingResult> {
    const wanted = target(rawId, rawVersion)
    if (!wanted) return failed('failed', 'Not an artifact id and version.')
    const account = this.store.account()
    if (!account) return failed('no_account')
    const page = this.store.page(wanted.id)
    if (!page) return failed('not_found', 'This artifact is not published.')
    if (page.accountId !== account.accountId) return failed('other_account')
    return this.deploy(account, page, wanted.version)
  }

  /** Deletes the Worker, so the URL stops working; a page already gone counts as done. */
  async unpublish(rawId: unknown): Promise<SharingResult> {
    if (typeof rawId !== 'string' || !ARTIFACT_ID.test(rawId)) {
      return failed('failed', 'Not an artifact id.')
    }
    const page = this.store.page(rawId)
    if (!page) return { status: this.status() }
    const account = this.store.account()
    if (!account) return failed('no_account')
    if (page.accountId !== account.accountId) return failed('other_account')
    try {
      const token = await this.tokenOf()
      await this.provider(account, token).unpublish(page.worker)
      this.store.forget(page.id)
      return this.report()
    } catch (error) {
      return this.failure(error)
    }
  }

  /**
   * At launch and after a host restart: takes down the pages whose artifact the host no longer has,
   * and forgets the ones Cloudflare no longer has. A failure leaves the entry for the next launch.
   */
  reconcile(): Promise<void> {
    this.reconciling ??= this.doReconcile()
      .catch((error: unknown) =>
        log.warn(`Could not reconcile published artifacts: ${(error as Error).message}`),
      )
      .finally(() => {
        this.reconciling = null
      })
    return this.reconciling
  }

  flush(): Promise<void> {
    return this.store.flush()
  }

  private async deploy(
    account: StoredAccount,
    page: PublishedPage,
    version: number,
  ): Promise<SharingResult> {
    try {
      const token = await this.tokenOf()
      const content = await this.readHtml(page.id, version)
      await this.provider(account, token).update(page.worker, withMeta(content.html), pageHeaders())
      this.store.put({ ...page, version: content.version, publishedAt: this.now() })
      return this.report()
    } catch (error) {
      if (error instanceof SharingError && error.failure === 'not_found') {
        // The Worker was deleted in Cloudflare's dashboard; the entry would name it forever.
        this.store.forget(page.id)
        const status = this.status()
        this.deps.changed?.(status)
        return failed('not_found', error.detail ?? error.message)
      }
      return this.failure(error)
    }
  }

  private async doReconcile(): Promise<void> {
    const account = this.store.account()
    if (!account) return
    const ids = await this.deps.host.ids()
    if (!ids) return
    let token: string
    try {
      token = await this.tokenOf()
    } catch (error) {
      log.warn(`Could not read the sharing token: ${(error as Error).message}`)
      return
    }
    const provider = this.provider(account, token)
    let changed = false
    for (const page of pagesToUnpublish(this.store.published(), ids, account.accountId)) {
      try {
        await provider.unpublish(page.worker)
        this.store.forget(page.id)
        changed = true
      } catch (error) {
        log.warn(`Could not unpublish ${page.id}: ${(error as Error).message}`)
      }
    }
    const kept = this.store.published().filter((page) => page.accountId === account.accountId)
    if (kept.length > 0) {
      try {
        const workers = await provider.existing(kept.map((page) => page.worker))
        for (const page of pagesToForget(kept, workers, account.accountId)) {
          this.store.forget(page.id)
          changed = true
        }
      } catch (error) {
        log.warn(`Could not list the published Workers: ${(error as Error).message}`)
      }
    }
    if (changed) this.deps.changed?.(this.status())
  }

  private async readHtml(id: string, version: number): Promise<{ html: string; version: number }> {
    const found = await this.deps.host.content(id, version)
    if (found.kind === 'not_found') {
      throw new SharingError('not_found', 'The agent host no longer has this version.')
    }
    if (found.kind === 'failed') {
      throw new SharingError('unavailable', 'The agent host did not answer.')
    }
    if (!isInside(this.deps.contentDir, found.path)) {
      throw new SharingError('failed', 'The artifact file is not in the artifacts folder.')
    }
    try {
      return { html: await readFile(found.path, 'utf8'), version: found.version }
    } catch (error) {
      throw new SharingError('failed', `Could not read the artifact: ${(error as Error).message}`)
    }
  }

  private async tokenOf(): Promise<string> {
    let token: string | null
    try {
      token = await this.store.token()
    } catch (error) {
      throw new SharingError(
        'encryption',
        `The saved token could not be read: ${(error as Error).message}`,
      )
    }
    if (!token) throw new SharingError('no_account', 'No Cloudflare account is connected.')
    return token
  }

  private provider(account: StoredAccount, token: string): SharingProvider {
    return new Cloudflare({
      accountId: account.accountId,
      subdomain: account.subdomain,
      token,
      fetch: this.deps.fetch,
      ...(this.deps.random ? { random: this.deps.random } : {}),
    })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private report(): SharingResult {
    const status = this.status()
    this.deps.changed?.(status)
    return { status }
  }

  private failure(error: unknown): SharingResult {
    if (error instanceof SharingError) {
      return failed(error.failure, error.detail ?? error.message)
    }
    return failed('failed', error instanceof Error ? error.message : String(error))
  }
}
