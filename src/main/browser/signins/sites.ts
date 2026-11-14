// Which sites a profile has sign-ins for, read from its cookies' hosts and times alone, and how
// the list groups them: recent ones picked, email, banking and single sign-on left out unless
// picked, Google's never brought.

import { getDomain, getDomainWithoutSuffix } from 'tldts'
import type { SignInSite, SignInSiteGroup, SignInSiteKind } from '@shared/signins'

/** Sites used within this long are picked for the user. */
export const RECENT_MS = 30 * 24 * 60 * 60 * 1000

/** How a cookie may be sent across sites, in Electron's names. */
export type CookieSameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict'

/** A cookie as a browser's database holds it, without its value. */
export interface CookieMeta {
  /** With a leading dot for a cookie its subdomains get too. */
  host: string
  name: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** Seconds since the epoch; null for a cookie that ends with the browser's session. */
  expires: number | null
  sameSite: CookieSameSite
  /** When it was last sent or set, in ms since the epoch. */
  lastUsed: number
}

/** A cookie to write into Kettu's browser. */
export interface BroughtCookie extends CookieMeta {
  value: string
}

const EMAIL = new Set([
  'aol.com',
  'fastmail.com',
  'fastmail.fm',
  'gmail.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'hey.com',
  'hotmail.com',
  'hushmail.com',
  'icloud.com',
  'live.com',
  'mail.com',
  'mail.ru',
  'mailbox.org',
  'office.com',
  'office365.com',
  'outlook.com',
  'posteo.de',
  'proton.me',
  'protonmail.com',
  'qq.com',
  'superhuman.com',
  'tuta.com',
  'tutanota.com',
  'web.de',
  'yahoo.com',
  'yandex.com',
  'yandex.ru',
  'yeah.net',
  'zoho.com',
  'zohomail.com',
  '126.com',
  '163.com',
])

const BANKING = new Set([
  'abchina.com',
  'alipay.com',
  'americanexpress.com',
  'barclays.co.uk',
  'binance.com',
  'boc.cn',
  'ccb.com',
  'chase.com',
  'citi.com',
  'cmbchina.com',
  'coinbase.com',
  'commbank.com.au',
  'discover.com',
  'etrade.com',
  'fidelity.com',
  'hsbc.co.uk',
  'hsbc.com',
  'icbc.com.cn',
  'ing.com',
  'kraken.com',
  'lloydsbank.com',
  'monzo.com',
  'n26.com',
  'natwest.com',
  'paypal.com',
  'pnc.com',
  'rbc.com',
  'revolut.com',
  'robinhood.com',
  'santander.com',
  'schwab.com',
  'scotiabank.com',
  'td.com',
  'vanguard.com',
  'venmo.com',
  'wellsfargo.com',
  'wise.com',
])

// Identity providers and password managers: a sign-in there opens many others.
const SSO = new Set([
  '1password.com',
  'apple.com',
  'auth0.com',
  'bitwarden.com',
  'cyberark.cloud',
  'dashlane.com',
  'duosecurity.com',
  'jumpcloud.com',
  'lastpass.com',
  'microsoftonline.com',
  'okta-emea.com',
  'okta.com',
  'oktapreview.com',
  'onelogin.com',
  'pingidentity.com',
  'pingone.com',
])

/**
 * The site a cookie's host belongs to: its registrable domain, or the whole name under a private
 * suffix such as `github.io`. Null for an address or `localhost`, which no sign-in is kept for.
 */
export function siteOf(host: string): string | null {
  const name = host.replace(/^\./, '').toLowerCase()
  if (!name || name === 'localhost') return null
  return getDomain(name, { allowPrivateDomains: true, detectIp: true, validateHostname: true })
}

/** Google ties its sign-in to the browser it was made in, so it is never brought. */
export function isGoogleSite(site: string): boolean {
  return getDomainWithoutSuffix(site) === 'google' || site === 'youtube.com' || site === 'gmail.com'
}

/** Email, banking and single sign-on, which are left out unless the user picks them. */
export function siteKind(site: string): SignInSiteKind | null {
  if (EMAIL.has(site)) return 'email'
  if (BANKING.has(site) || (getDomainWithoutSuffix(site) ?? '').includes('bank')) return 'banking'
  if (SSO.has(site)) return 'sso'
  return null
}

/** Whether a cookie looks like part of a sign-in: one pages cannot read, still valid. */
function signInLike(cookie: CookieMeta, nowSeconds: number): boolean {
  return cookie.httpOnly && (cookie.expires === null || cookie.expires > nowSeconds)
}

/**
 * The sites with sign-ins among a profile's cookies, most recently used first. A site counts when
 * it has a valid cookie pages cannot read; one whose such cookies are all sent across sites, as
 * an ad network's are, goes with the rest rather than the recent ones.
 */
export function signInSites(cookies: Iterable<CookieMeta>, now: number): SignInSite[] {
  const nowSeconds = now / 1000
  const found = new Map<string, { lastUsed: number; sameSiteOnly: boolean }>()
  for (const cookie of cookies) {
    if (!signInLike(cookie, nowSeconds)) continue
    const site = siteOf(cookie.host)
    if (!site) continue
    const entry = found.get(site) ?? { lastUsed: 0, sameSiteOnly: false }
    entry.lastUsed = Math.max(entry.lastUsed, cookie.lastUsed)
    if (cookie.sameSite !== 'no_restriction') entry.sameSiteOnly = true
    found.set(site, entry)
  }
  return [...found]
    .map(([site, { lastUsed, sameSiteOnly }]) => {
      const kind = siteKind(site)
      return { site, lastUsed, kind, group: groupOf(site, kind, lastUsed, sameSiteOnly, now) }
    })
    .sort((a, b) => b.lastUsed - a.lastUsed || a.site.localeCompare(b.site))
}

function groupOf(
  site: string,
  kind: SignInSiteKind | null,
  lastUsed: number,
  sameSiteOnly: boolean,
  now: number,
): SignInSiteGroup {
  if (isGoogleSite(site)) return 'google'
  if (kind) return 'held'
  if (sameSiteOnly && now - lastUsed <= RECENT_MS) return 'recent'
  return 'other'
}

/** The sites picked when the list opens: the recent ones. */
export function defaultPicks(sites: readonly SignInSite[]): string[] {
  return sites.filter((site) => site.group === 'recent').map((site) => site.site)
}

/**
 * The sites that may be brought out of those asked for: each once, never Google's, and only
 * names a site can have.
 */
export function bringable(sites: Iterable<string>): Set<string> {
  const kept = new Set<string>()
  for (const site of sites) {
    if (siteOf(site) === site && !isGoogleSite(site)) kept.add(site)
  }
  return kept
}

/** Whether a cookie belongs to one of the chosen sites. */
export function inSites(host: string, chosen: ReadonlySet<string>): boolean {
  const site = siteOf(host)
  return site !== null && chosen.has(site) && !isGoogleSite(site)
}
