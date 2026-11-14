// Main's side of bringing sign-ins: asks the worker what the user's browsers hold, writes the
// cookies of the chosen sites into Kettu's browser, keeps the record Settings lists, and offers
// a site's sign-in when Kettu's browser lacks one.

import type {
  BroughtSite,
  SignInChoice,
  SignInOffer,
  SignInRequest,
  SignInResult,
  SignInSite,
  SignInSource,
} from '@shared/signins'
import type { Logger } from '../../log'
import type { BroughtStore } from './brought'
import type { WorkerRequest } from './protocol'
import type { IndexEntry, ReadResult, SourceListing } from './reader'
import { bringable, isGoogleSite, siteOf } from './sites'
import {
  hasSignIn,
  removeSiteCookies,
  sitesWithCookies,
  writeCookies,
  type CookieJar,
} from './write'

/** How long the sites of the user's browsers are trusted before they are read again. */
export const INDEX_MS = 5 * 60 * 1000

export interface SignInsDeps {
  /** Runs one request in a worker of its own. */
  run(request: Exclude<WorkerRequest, { op: 'cancel' }>): Promise<unknown>
  /** Stops a read that waits for the keychain. */
  cancel(): void
  /** The cookies of Kettu's browser. */
  jar: CookieJar
  store: BroughtStore
  /** The icon of a browser's app, as a PNG data URL. */
  icon(app: string): Promise<string | null>
  /** The brought sites changed. */
  changed(): void
  log: Logger
  now?: () => number
}

export class SignIns {
  private profileNames = new Map<string, string>()
  private index: { at: number; sites: Map<string, IndexEntry> } | null = null
  private indexing: Promise<Map<string, IndexEntry>> | null = null
  private reading: Promise<SignInResult> | null = null

  constructor(private readonly deps: SignInsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  async sources(): Promise<SignInSource[]> {
    const listings = (await this.deps.run({ op: 'sources' })) as SourceListing[]
    for (const source of listings) {
      for (const profile of source.profiles) {
        this.profileNames.set(`${source.browser}\0${profile.id}`, profile.name)
      }
    }
    return Promise.all(
      listings.map(async ({ app, ...source }) => ({
        ...source,
        icon: app ? await this.deps.icon(app).catch(() => null) : null,
      })),
    )
  }

  /** A profile's sites; throws for a profile this computer does not have. */
  async sites(choice: SignInChoice): Promise<SignInSite[]> {
    const sites = (await this.deps.run({ op: 'sites', choice })) as SignInSite[] | null
    if (!sites) throw new Error('That browser profile is not on this computer')
    return sites
  }

  /** Brings the chosen sites' sign-ins; one read runs at a time, a new one stopping the last. */
  async bring(request: SignInRequest): Promise<SignInResult> {
    if (this.reading) this.deps.cancel()
    const reading = this.read(request)
    this.reading = reading
    try {
      return await reading
    } finally {
      if (this.reading === reading) this.reading = null
    }
  }

  private async read(request: SignInRequest): Promise<SignInResult> {
    const chosen = bringable(request.sites)
    let result: ReadResult
    try {
      result = (await this.deps.run({
        op: 'read',
        request: { ...request, sites: [...chosen] },
      })) as ReadResult
    } catch (error) {
      if ((error as Error).message === 'cancelled') return { ok: false, reason: 'cancelled' }
      this.deps.log.warn(`Could not read the sign-ins: ${(error as Error).message}`)
      return { ok: false, reason: 'unreadable' }
    }
    if (!result.ok) return result
    const written = await writeCookies(this.deps.jar, result.cookies, chosen, this.now() / 1000)
    this.deps.log.info(
      `Brought ${written.written} cookies of ${written.sites.length} sites from ${request.browser}` +
        (written.failed > 0 ? `; ${written.failed} were refused` : ''),
    )
    const profile =
      this.profileNames.get(`${request.browser}\0${request.profile}`) ?? request.profile
    const at = this.now()
    this.deps.store.add(
      written.sites.map((site) => ({ site, browser: request.browser, profile, at })),
    )
    if (written.sites.length > 0) this.deps.changed()
    return { ok: true, sites: written.sites }
  }

  cancel(): void {
    if (this.reading) this.deps.cancel()
  }

  /**
   * The brought sites Kettu's browser still has cookies for; one cleared with the browsing data, or
   * signed out of everywhere, is forgotten.
   */
  async brought(): Promise<BroughtSite[]> {
    const sites = this.deps.store.list()
    if (sites.length === 0) return []
    let held: Set<string>
    try {
      held = await sitesWithCookies(this.deps.jar)
    } catch {
      return sites
    }
    for (const site of sites) if (!held.has(site.site)) this.deps.store.remove(site.site)
    return sites.filter((site) => held.has(site.site))
  }

  /** Signs Kettu's browser out of a site by deleting its cookies, and forgets it was brought. */
  async remove(site: string): Promise<void> {
    await removeSiteCookies(this.deps.jar, site)
    this.deps.store.remove(site)
    this.deps.changed()
  }

  /**
   * The sign-in one of the user's browsers has for the site `url` is on, when Kettu's browser has
   * none there; null otherwise, and always for Google's.
   */
  async offer(url: string): Promise<SignInOffer | null> {
    let host: string
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
      host = parsed.hostname
    } catch {
      return null
    }
    const site = siteOf(host)
    if (!site || isGoogleSite(site)) return null
    if (await hasSignIn(this.deps.jar, site, this.now() / 1000)) return null
    const entry = (await this.sitesIndex()).get(site)
    if (!entry) return null
    const { browser, browserName, profile, profileName, keychain } = entry
    return { site, browser, browserName, profile, profileName, keychain }
  }

  /** The newest index of the user's sites; a stale one is used while a fresh one is read. */
  private async sitesIndex(): Promise<Map<string, IndexEntry>> {
    const index = this.index
    if (index && this.now() - index.at < INDEX_MS) return index.sites
    const refresh = this.refreshIndex()
    return index ? index.sites : refresh
  }

  private refreshIndex(): Promise<Map<string, IndexEntry>> {
    if (!this.indexing) {
      const indexing = this.readIndex()
      this.indexing = indexing
      void indexing.finally(() => {
        if (this.indexing === indexing) this.indexing = null
      })
    }
    return this.indexing
  }

  private async readIndex(): Promise<Map<string, IndexEntry>> {
    try {
      const entries = (await this.deps.run({ op: 'index' })) as IndexEntry[]
      const sites = new Map<string, IndexEntry>()
      for (const entry of entries) {
        const known = sites.get(entry.site)
        if (!known || known.lastUsed < entry.lastUsed) sites.set(entry.site, entry)
      }
      this.index = { at: this.now(), sites }
      return sites
    } catch (error) {
      this.deps.log.warn(`Could not read the browsers' sites: ${(error as Error).message}`)
      return this.index?.sites ?? new Map<string, IndexEntry>()
    }
  }
}
