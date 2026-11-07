// Publishing artifacts online: main holds the accounts, reads the version from the agent host, and
// talks to the target, so the renderer never names a URL and never sees a token. Pages go to
// Kettu's own sharing service with the host's Kettu account, or to the user's Cloudflare account.

import { readFile } from 'node:fs/promises'
import { ARTIFACT_ENTRY, isHtmlPath } from '@shared/artifact-files'
import {
  type ArtifactTypeInfo,
  type ArtifactTypeName,
  CONTENT_ENTRIES,
  VIEWER_PREFIX,
  viewerPage,
} from '@shared/artifact-types'
import { ARTIFACT_ID } from '@shared/artifacts'
import type { Locale } from '@shared/locale'
import type { ArtifactContentFile, ArtifactContentResult } from '@shared/host-control'
import {
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_TOKEN,
  SHARING_TARGETS,
  type CloudflareAccountChoice,
  type SharingConnectResult,
  type SharingFailure,
  type SharingResult,
  type SharingStatus,
  type SharingTarget,
} from '@shared/sharing'
import { NotSignedIn } from '../account'
import { AccountNetworkError } from '../account/service'
import { isInside } from '../artifacts/protocol'
import { createLogger } from '../log'
import { accountSubdomain, Cloudflare, findAccounts, type Fetch } from './cloudflare'
import { KettuShare } from './kettu'
import { pageHeaders, withMeta } from './page'
import { SharingError, type PageFile, type SharingProvider } from './provider'
import {
  pagesToForget,
  pagesToUnpublish,
  SharingStore,
  type PublishedPage,
  type TokenCipher,
} from './store'

const log = createLogger('sharing')

/** What main needs from the agent host: the version's files and every artifact it has. */
export interface SharingHost {
  content(id: string, version: number | null): Promise<ArtifactContentResult>
  ids(): Promise<Set<string> | null>
}

export interface ViewerFile {
  path: string
  file: string
}

/** The Kettu account the host is signed in to, which publishes to Kettu. */
export interface KettuAccess {
  /** The sharing API's base, the account service's: `<base>/api/v1/shares`. */
  base: string
  /** The signed-in account; null when signed out. */
  account(): { id: string; email: string } | null
  /**
   * Runs `call` with the account's access token, refreshed and tried once more when the service
   * refuses it; throws `NotSignedIn` when signed out.
   */
  withToken<T>(call: (token: string) => Promise<T>): Promise<T>
}

export interface SharingDeps {
  userDataPath: string
  /** `artifacts/content/` in the data folder. */
  contentDir: string
  host: SharingHost
  kettu: KettuAccess
  cipher: TokenCipher
  /** Whether the system can encrypt the token; false on a machine without a secret store. */
  encryptionAvailable(): Promise<boolean>
  /** Whether the token would be stored without the system's encryption, as on Linux. */
  plainText(): boolean
  fetch: Fetch
  random?(size: number): Buffer
  now?(): number
  /** Told of every change, for the windows; no token is part of the status. */
  changed?(status: SharingStatus): void
  /**
   * The files of a type's viewer by their paths under the viewers' folder, with the grammars of
   * the code languages its content names, which a typed artifact's page publishes with its
   * content; none without them.
   */
  viewerFiles?(type: ArtifactTypeName, languages: readonly string[]): Promise<ViewerFile[]>
  /** The language a published type viewer speaks. */
  locale?(): Locale
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

function isTarget(value: unknown): value is SharingTarget {
  return SHARING_TARGETS.includes(value as SharingTarget)
}

/** The Kettu account's storage as the service last said, for the account it answered for. */
interface Storage {
  accountId: string
  used: number
  limit: number
}

/**
 * The published artifacts, their accounts, and the calls the renderer's sharing channels make.
 * Publishing is the user's own action: no agent reaches these calls.
 */
export class Sharing {
  private reconciling: Promise<void> | null = null
  private storage: Storage | null = null
  /** The Kettu account the status was last made for, to notice another one signing in. */
  private kettuSeen: string | null = null

  private constructor(
    private readonly deps: SharingDeps,
    private readonly store: SharingStore,
  ) {
    this.kettuSeen = deps.kettu.account()?.id ?? null
  }

  static async load(deps: SharingDeps): Promise<Sharing> {
    return new Sharing(deps, await SharingStore.load(deps.userDataPath, deps.cipher))
  }

  /** What the interface shows; the tokens stay in main. */
  status(): SharingStatus {
    const cloudflare = this.store.account()
    const kettu = this.deps.kettu.account()
    const storage = kettu && this.storage?.accountId === kettu.id ? this.storage : null
    return {
      kettu: {
        account: kettu ? { email: kettu.email } : null,
        storage: storage ? { used: storage.used, limit: storage.limit } : null,
      },
      cloudflare: cloudflare
        ? {
            accountId: cloudflare.accountId,
            subdomain: cloudflare.subdomain,
            plainText: cloudflare.plainText,
          }
        : null,
      published: this.store.published().map((page) => {
        const owner = page.target === 'kettu' ? kettu?.id : cloudflare?.accountId
        const otherAccount = page.accountId !== owner
        return {
          id: page.id,
          url: page.url,
          version: page.version,
          publishedAt: page.publishedAt,
          target: page.target,
          otherAccount,
          accountEmail: otherAccount ? page.accountEmail : null,
        }
      }),
    }
  }

  /**
   * The Kettu account signed in, out or changed: the status follows, and a newly signed-in
   * account's pages and storage are read.
   */
  kettuChanged(): void {
    const id = this.deps.kettu.account()?.id ?? null
    if (id === this.kettuSeen) return
    this.kettuSeen = id
    this.storage = null
    this.deps.changed?.(this.status())
    if (id !== null) void this.refresh()
  }

  /**
   * Reads the Kettu account's pages, as the share panel and Settings › Sharing do when they show:
   * the addresses the service gives now, the pages it no longer has, and the storage.
   */
  async refresh(): Promise<SharingStatus> {
    try {
      if (await this.listKettu()) this.deps.changed?.(this.status())
    } catch (error) {
      log.warn(`Could not list the pages published to Kettu: ${(error as Error).message}`)
    }
    return this.status()
  }

  /**
   * Checks the token with Cloudflare and keeps the account it reaches. With an account ID it reads
   * that account alone; without one it answers with the accounts when the token reaches several,
   * since choosing one is the user's.
   */
  async connect(rawToken: unknown, rawAccountId: unknown): Promise<SharingConnectResult> {
    const token = typeof rawToken === 'string' ? rawToken.trim() : ''
    if (!CLOUDFLARE_TOKEN.test(token)) return failed('failed', 'The API token is not valid.')
    let accountId: string | null = null
    if (rawAccountId !== null) {
      accountId = typeof rawAccountId === 'string' ? rawAccountId.trim().toLowerCase() : ''
      if (!CLOUDFLARE_ACCOUNT_ID.test(accountId)) {
        return failed('failed', 'The account ID must be 32 hexadecimal characters.')
      }
    }
    try {
      if (!(await this.deps.encryptionAvailable())) {
        return failed('encryption', 'This system cannot encrypt the token.')
      }
      if (accountId !== null) {
        const subdomain = await accountSubdomain(this.deps.fetch, token, accountId)
        if (subdomain === null) {
          return failed('no_subdomain', 'The account has no workers.dev subdomain.')
        }
        return await this.keep(accountId, subdomain, token)
      }
      const accounts = await findAccounts(this.deps.fetch, token)
      if (accounts.length === 0) {
        return failed('invalid_token', 'The token reaches no account it can publish to.')
      }
      if (accounts.length > 1) return { accounts }
      const [only] = accounts as [CloudflareAccountChoice]
      if (only.subdomain === null) {
        return failed('no_subdomain', 'The account has no workers.dev subdomain.')
      }
      return await this.keep(only.id, only.subdomain, token)
    } catch (error) {
      return this.failure(error)
    }
  }

  private async keep(accountId: string, subdomain: string, token: string): Promise<SharingResult> {
    await this.store.connect(accountId, subdomain, token, this.deps.plainText())
    return this.report()
  }

  /** Forgets the Cloudflare account and its token; published pages stay as they are. */
  remove(): SharingStatus {
    this.store.removeAccount()
    const status = this.status()
    this.deps.changed?.(status)
    return status
  }

  /**
   * Publishes a version at a new URL of the target, Kettu unless another is named; publishing an
   * already published artifact updates it where it lives.
   */
  async publish(rawId: unknown, rawVersion: unknown, rawTarget: unknown): Promise<SharingResult> {
    const wanted = target(rawId, rawVersion)
    if (!wanted) return failed('failed', 'Not an artifact id and version.')
    if (!isTarget(rawTarget)) return failed('failed', 'Not a place to publish to.')
    const page = this.store.page(wanted.id)
    if (page) return this.deploy(page, wanted.version)
    const owner = this.owner(rawTarget)
    if (!owner) return failed(rawTarget === 'kettu' ? 'signed_out' : 'no_account')
    try {
      const content = await this.readFiles(wanted.id, wanted.version)
      const published = await this.at(rawTarget, owner.id, (provider) =>
        provider.publish(content.files, pageHeaders()),
      )
      this.store.put({
        id: wanted.id,
        target: rawTarget,
        ref: published.ref,
        url: published.url,
        version: content.version,
        publishedAt: this.now(),
        accountId: owner.id,
        accountEmail: owner.email,
      })
      return await this.changedAt(rawTarget)
    } catch (error) {
      return this.failure(error)
    }
  }

  /** Replaces the page at its URL with a later version; the earlier one stays reachable nowhere. */
  async update(rawId: unknown, rawVersion: unknown): Promise<SharingResult> {
    const wanted = target(rawId, rawVersion)
    if (!wanted) return failed('failed', 'Not an artifact id and version.')
    const page = this.store.page(wanted.id)
    if (!page) return failed('not_found', 'This artifact is not published.')
    return this.deploy(page, wanted.version)
  }

  /** Takes the page down where it lives, so the URL stops working; one already gone is done. */
  async unpublish(rawId: unknown): Promise<SharingResult> {
    if (typeof rawId !== 'string' || !ARTIFACT_ID.test(rawId)) {
      return failed('failed', 'Not an artifact id.')
    }
    const page = this.store.page(rawId)
    if (!page) return { status: this.status() }
    try {
      await this.at(page.target, page.accountId, (provider) => provider.unpublish(page.ref))
      this.store.forget(page.id)
      return await this.changedAt(page.target)
    } catch (error) {
      return this.failure(error)
    }
  }

  /**
   * At launch and after a host restart: takes down the pages whose artifact the host no longer has,
   * and forgets the ones their target no longer has. A failure leaves the entry for the next launch.
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

  private async deploy(page: PublishedPage, version: number): Promise<SharingResult> {
    let content: { files: PageFile[]; version: number }
    try {
      content = await this.readFiles(page.id, version)
    } catch (error) {
      return this.failure(error)
    }
    try {
      await this.at(page.target, page.accountId, (provider) =>
        provider.update(page.ref, content.files, pageHeaders()),
      )
      // Unpublished while the files were on their way: the entry stays gone.
      const current = this.store.page(page.id)
      if (current) this.store.put({ ...current, version: content.version, publishedAt: this.now() })
      return await this.changedAt(page.target)
    } catch (error) {
      if (error instanceof SharingError && error.failure === 'not_found') {
        // Deleted at the target, as in Cloudflare's dashboard; the entry would name it forever.
        this.store.forget(page.id)
        const status = this.status()
        this.deps.changed?.(status)
        return failed('not_found', error.detail ?? error.message)
      }
      return this.failure(error)
    }
  }

  private async doReconcile(): Promise<void> {
    const ids = await this.deps.host.ids()
    if (!ids) return
    let changed = false
    for (const target of SHARING_TARGETS) {
      const owner = this.owner(target)
      if (!owner) continue
      for (const page of pagesToUnpublish(this.store.published(), ids, target, owner.id)) {
        try {
          await this.at(target, owner.id, (provider) => provider.unpublish(page.ref))
          this.store.forget(page.id)
          changed = true
        } catch (error) {
          log.warn(`Could not unpublish ${page.id}: ${(error as Error).message}`)
        }
      }
    }
    try {
      if (await this.listKettu()) changed = true
    } catch (error) {
      log.warn(`Could not list the pages published to Kettu: ${(error as Error).message}`)
    }
    const cloudflare = this.owner('cloudflare')
    const kept = cloudflare
      ? this.store
          .published()
          .filter((page) => page.target === 'cloudflare' && page.accountId === cloudflare.id)
      : []
    if (cloudflare && kept.length > 0) {
      try {
        const workers = await this.at('cloudflare', cloudflare.id, (provider) =>
          provider.existing(kept.map((page) => page.ref)),
        )
        for (const page of pagesToForget(kept, workers, 'cloudflare', cloudflare.id)) {
          this.store.forget(page.id)
          changed = true
        }
      } catch (error) {
        log.warn(`Could not list the published Workers: ${(error as Error).message}`)
      }
    }
    if (changed) this.deps.changed?.(this.status())
  }

  /**
   * Reads the signed-in Kettu account's pages: takes the address the service gives each one now,
   * forgets the ones it no longer has and keeps its storage. Whether anything changed.
   */
  private async listKettu(): Promise<boolean> {
    const owner = this.owner('kettu')
    if (!owner) return false
    const started = this.now()
    const listed = await this.deps.kettu.withToken((token) => this.kettuShare(token).list())
    if (this.owner('kettu')?.id !== owner.id) return false
    const before = this.storage
    this.storage = { accountId: owner.id, used: listed.used, limit: listed.limit }
    let changed =
      before?.accountId !== owner.id || before.used !== listed.used || before.limit !== listed.limit
    const urls = new Map(listed.pages.map((page) => [page.id, page.url]))
    const mine = this.store
      .published()
      .filter((page) => page.target === 'kettu' && page.accountId === owner.id)
    for (const page of mine) {
      const url = urls.get(page.ref)
      if (url === undefined) {
        // A page published while the list was on its way is not in it yet.
        if (page.publishedAt >= started) continue
        this.store.forget(page.id)
        changed = true
      } else if (url !== page.url) {
        this.store.put({ ...page, url })
        changed = true
      }
    }
    return changed
  }

  /** The account a target publishes with now, or null when it has none. */
  private owner(target: SharingTarget): { id: string; email: string | null } | null {
    if (target === 'kettu') return this.deps.kettu.account()
    const account = this.store.account()
    return account ? { id: account.accountId, email: null } : null
  }

  /**
   * Runs `call` with the target's provider for the account a page belongs to, refused when that
   * is not the account the target publishes with now.
   */
  private async at<T>(
    target: SharingTarget,
    accountId: string,
    call: (provider: SharingProvider) => Promise<T>,
  ): Promise<T> {
    const owner = this.owner(target)
    if (!owner) {
      throw target === 'kettu'
        ? new SharingError('signed_out', 'Not signed in to a Kettu account.')
        : new SharingError('no_account', 'No Cloudflare account is connected.')
    }
    if (owner.id !== accountId) {
      throw new SharingError('other_account', 'The page was published with another account.')
    }
    if (target === 'kettu') {
      return this.deps.kettu.withToken((token) => call(this.kettuShare(token)))
    }
    const account = this.store.account()!
    return call(
      new Cloudflare({
        accountId: account.accountId,
        subdomain: account.subdomain,
        token: await this.tokenOf(),
        fetch: this.deps.fetch,
        ...(this.deps.random ? { random: this.deps.random } : {}),
      }),
    )
  }

  private kettuShare(token: string): KettuShare {
    return new KettuShare({ base: this.deps.kettu.base, token, fetch: this.deps.fetch })
  }

  /** The status after a change at `target`; Kettu's storage is read again, as the change moved it. */
  private async changedAt(target: SharingTarget): Promise<SharingResult> {
    if (target === 'kettu') {
      try {
        await this.listKettu()
      } catch (error) {
        log.warn(`Could not list the pages published to Kettu: ${(error as Error).message}`)
      }
    }
    return this.report()
  }

  /** The version's files as they are published: each HTML file with the policy in it. */
  private async readFiles(
    id: string,
    version: number,
  ): Promise<{ files: PageFile[]; version: number }> {
    const found = await this.deps.host.content(id, version)
    if (found.kind === 'not_found') {
      throw new SharingError('not_found', 'The agent host no longer has this version.')
    }
    if (found.kind === 'failed') {
      throw new SharingError('unavailable', 'The agent host did not answer.')
    }
    const files: PageFile[] = []
    if (found.type) files.push(...(await this.viewerOf(found.type, found.version, found.files)))
    for (const file of found.files) {
      if (!isInside(this.deps.contentDir, file.file)) {
        throw new SharingError('failed', 'The artifact file is not in the artifacts folder.')
      }
      try {
        const bytes = isHtmlPath(file.path)
          ? Buffer.from(withMeta(await readFile(file.file, 'utf8')), 'utf8')
          : await readFile(file.file)
        files.push({ path: file.path, bytes })
      } catch (error) {
        throw new SharingError('failed', `Could not read the artifact: ${(error as Error).message}`)
      }
    }
    return { files, version: found.version }
  }

  /**
   * A typed version's page: its type's viewer, which reads the content files beside it as they
   * are published, without the runtime, so it shows them and offers no editing.
   */
  private async viewerOf(
    type: ArtifactTypeInfo,
    version: number,
    content: ArtifactContentFile[],
  ): Promise<PageFile[]> {
    const page = viewerPage(type, version, this.deps.locale?.() ?? 'en', '')
    const viewers =
      (await this.deps.viewerFiles?.(type.name, await this.codeLanguages(type, content))) ?? []
    if (!page || viewers.length === 0) {
      throw new SharingError('failed', 'This build has no viewer for the artifact’s type.')
    }
    const files: PageFile[] = [{ path: ARTIFACT_ENTRY, bytes: Buffer.from(withMeta(page), 'utf8') }]
    for (const viewer of viewers) {
      try {
        files.push({ path: `${VIEWER_PREFIX}${viewer.path}`, bytes: await readFile(viewer.file) })
      } catch (error) {
        throw new SharingError('failed', `Could not read the viewer: ${(error as Error).message}`)
      }
    }
    return files
  }

  /** The code languages a document's fences name, whose grammars its viewer loads. */
  private async codeLanguages(
    type: ArtifactTypeInfo,
    content: ArtifactContentFile[],
  ): Promise<string[]> {
    const entry = content.find((file) => file.path === CONTENT_ENTRIES[type.name])
    if (type.name !== 'document' || !entry || !isInside(this.deps.contentDir, entry.file)) return []
    try {
      const { fenceLanguages } = await import('@shared/artifact-document')
      return fenceLanguages(await readFile(entry.file, 'utf8'))
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
    if (error instanceof NotSignedIn) return failed('signed_out', error.message)
    if (error instanceof AccountNetworkError) return failed('network', error.message)
    return failed('failed', error instanceof Error ? error.message : String(error))
  }
}
