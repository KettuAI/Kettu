// Writing brought cookies into the partition of Kettu's browser, and taking a site's out again.
// Only cookies of the sites the user chose are ever written, and none is logged.

import type { Cookie, CookiesGetFilter, CookiesSetDetails } from 'electron'
import { inSites, siteOf, type BroughtCookie } from './sites'

/** The part of a session's cookies this file uses, so tests can stand in for Electron's. */
export interface CookieJar {
  set(details: CookiesSetDetails): Promise<void>
  get(filter: CookiesGetFilter): Promise<Cookie[]>
  remove(url: string, name: string): Promise<void>
  flushStore(): Promise<void>
}

/**
 * What Electron takes to set a brought cookie as the browser held it: a domain cookie with its
 * domain, a host-only cookie without one, its expiry and how it may be sent. Null for one that has
 * expired or whose host is no name.
 */
export function cookieDetails(cookie: BroughtCookie, nowSeconds: number): CookiesSetDetails | null {
  if (cookie.expires !== null && cookie.expires <= nowSeconds) return null
  const domainCookie = cookie.host.startsWith('.')
  const host = domainCookie ? cookie.host.slice(1) : cookie.host
  if (!host || !/^[a-z0-9._-]+$/i.test(host)) return null
  const path = cookie.path.startsWith('/') ? cookie.path : '/'
  // A cookie sent across sites must be secure; Chromium would refuse it otherwise.
  const sameSite =
    cookie.sameSite === 'no_restriction' && !cookie.secure ? 'unspecified' : cookie.sameSite
  return {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite,
    ...(domainCookie ? { domain: cookie.host } : {}),
    ...(cookie.expires !== null ? { expirationDate: cookie.expires } : {}),
  }
}

/** Writes the cookies of the chosen sites, and says which sites got at least one. */
export async function writeCookies(
  jar: CookieJar,
  cookies: readonly BroughtCookie[],
  chosen: ReadonlySet<string>,
  nowSeconds: number,
): Promise<{ sites: string[]; written: number; failed: number }> {
  const sites = new Set<string>()
  let written = 0
  let failed = 0
  for (const cookie of cookies) {
    // The worker read only these; a cookie of another site is never written whatever it sends.
    if (!inSites(cookie.host, chosen)) continue
    const details = cookieDetails(cookie, nowSeconds)
    if (!details) continue
    try {
      await jar.set(details)
      written++
      sites.add(siteOf(cookie.host)!)
    } catch {
      failed++
    }
  }
  if (written > 0) await jar.flushStore()
  return { sites: [...sites].sort(), written, failed }
}

/** The cookies Kettu's browser has for a site and its subdomains, and no other site's. */
async function siteCookies(jar: CookieJar, site: string): Promise<Cookie[]> {
  // Electron's domain filter gives only the cookies a request to that host would carry, never a
  // subdomain's own, so every cookie is read and grouped by site here.
  const cookies = await jar.get({})
  return cookies.filter((cookie) => cookie.domain && siteOf(cookie.domain) === site)
}

/** Deletes every cookie Kettu's browser has for a site, so it is signed out there. */
export async function removeSiteCookies(jar: CookieJar, site: string): Promise<number> {
  let removed = 0
  for (const cookie of await siteCookies(jar, site)) {
    const host = cookie.domain!.replace(/^\./, '')
    const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
    await jar.remove(url, cookie.name)
    removed++
  }
  if (removed > 0) await jar.flushStore()
  return removed
}

/** The sites Kettu's browser holds any cookie of. */
export async function sitesWithCookies(jar: CookieJar): Promise<Set<string>> {
  const sites = new Set<string>()
  for (const cookie of await jar.get({})) {
    const site = cookie.domain ? siteOf(cookie.domain) : null
    if (site) sites.add(site)
  }
  return sites
}

/** Whether Kettu's browser holds what looks like a sign-in for a site. */
export async function hasSignIn(
  jar: CookieJar,
  site: string,
  nowSeconds: number,
): Promise<boolean> {
  return (await siteCookies(jar, site)).some(
    (cookie) =>
      cookie.httpOnly &&
      (cookie.session || cookie.expirationDate === undefined || cookie.expirationDate > nowSeconds),
  )
}
