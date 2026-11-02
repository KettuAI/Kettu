import { getDomain } from 'tldts'
import {
  isLinkSite,
  MAX_LINK_SITES,
  type LinkDestination,
  type SettingsFile,
} from '@shared/settings'
import { readableRest } from '@renderer/features/browser/address'

/** The settings a link's click follows. */
export type LinkPrefs = Pick<
  SettingsFile['thread'],
  'openLinksIn' | 'confirmLinks' | 'alwaysOpenIn'
>

/** What the place a link is drawn in offers. */
export interface LinkContext {
  /** A session's thread, whose page in Kettu's browser a link may open in. */
  session: boolean
}

function webUrl(url: string): URL | null {
  const parsed = URL.parse(url)
  return parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed : null
}

/**
 * Whether the address carries a user name or a password, whose text before "@" can pass for
 * another site.
 */
export function hasUserinfo(url: string): boolean {
  const parsed = URL.parse(url)
  return !!parsed && (parsed.username !== '' || parsed.password !== '')
}

/**
 * Whether a link goes to this computer: a loopback address, `localhost` or a `*.localhost` name,
 * or `0.0.0.0`, which dev servers print for listening on every interface.
 */
export function isLocalLink(url: string): boolean {
  const host = webUrl(url)?.hostname
  if (!host) return false
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}

/** A link's host, split where its registrable domain starts (Public Suffix List). */
export interface LinkHost {
  /** What comes before the registrable domain, such as "docs."; empty when the host is it. */
  prefix: string
  /** The registrable domain, or the whole host when it has none, such as an IP address. */
  domain: string
  /** ":8080" for an address that names a port. */
  port: string
}

/** The host as the URL parser reads it, so text before "@" never passes for it. */
export function linkHost(url: string): LinkHost | null {
  const parsed = webUrl(url)
  if (!parsed) return null
  const host = parsed.hostname
  const domain = getDomain(host, { allowPrivateDomains: true })
  const split = !!domain && domain !== host && host.endsWith(`.${domain}`)
  return {
    prefix: split ? host.slice(0, host.length - domain.length) : '',
    domain: split ? domain : host,
    port: parsed.port ? `:${parsed.port}` : '',
  }
}

/**
 * The site "Always open" remembers a link by: its registrable domain, or the whole host where
 * that is the domain, as on `*.vercel.app`. Null for a host that cannot be remembered.
 */
export function linkSite(url: string): string | null {
  const host = linkHost(url)
  if (!host) return null
  return isLinkSite(host.domain) ? host.domain : null
}

/** Where "Always open" sends the link's site, if the user chose a place for it. */
export function rememberedDestination(
  url: string,
  alwaysOpenIn: LinkPrefs['alwaysOpenIn'],
): LinkDestination | undefined {
  // Spares the Public Suffix List lookup on every link drawn while no site is remembered.
  if (Object.keys(alwaysOpenIn).length === 0) return undefined
  const site = linkSite(url)
  return site !== null && Object.hasOwn(alwaysOpenIn, site) ? alwaysOpenIn[site] : undefined
}

export function otherDestination(destination: LinkDestination): LinkDestination {
  return destination === 'browser' ? 'session' : 'browser'
}

/**
 * Where a plain click opens a link: a local address in the session's browser, a remembered site
 * where it was sent, else the setting's place, the default browser for Ask. Outside a session
 * only the default browser is offered.
 */
export function defaultDestination(
  url: string,
  prefs: LinkPrefs,
  context: LinkContext,
): LinkDestination {
  if (!context.session) return 'browser'
  if (isLocalLink(url)) return 'session'
  return (
    rememberedDestination(url, prefs.alwaysOpenIn) ??
    (prefs.openLinksIn === 'session' ? 'session' : 'browser')
  )
}

/**
 * Whether the "Open link?" dialog asks first: always for an address with a user name or a
 * password, never for a local address in a session, and otherwise unless the site was remembered,
 * while the setting is Ask, or while "Ask before opening a site for the first time" is on and the
 * site is not `known`, that is, never opened from Kettu.
 */
export function asksBeforeOpening(
  url: string,
  prefs: LinkPrefs,
  context: LinkContext,
  known: boolean,
): boolean {
  if (hasUserinfo(url)) return true
  if (context.session && isLocalLink(url)) return false
  if (rememberedDestination(url, prefs.alwaysOpenIn)) return false
  if (prefs.openLinksIn === 'ask' && context.session) return true
  return prefs.confirmLinks && !known
}

export interface LinkPlan {
  destination: LinkDestination
  ask: boolean
}

/** What choosing a place for the link does, as its menu does; outside a session only the browser. */
export function planLinkOpenIn(
  url: string,
  prefs: LinkPrefs,
  context: LinkContext,
  known: boolean,
  destination: LinkDestination,
): LinkPlan {
  return {
    destination: context.session ? destination : 'browser',
    ask: asksBeforeOpening(url, prefs, context, known),
  }
}

/** What a click does; `other` is a Mod-click (Cmd on macOS), which takes the other place. */
export function planLinkOpen(
  url: string,
  prefs: LinkPrefs,
  context: LinkContext,
  known: boolean,
  other: boolean,
): LinkPlan {
  const destination = defaultDestination(url, prefs, context)
  return planLinkOpenIn(
    url,
    prefs,
    context,
    known,
    other ? otherDestination(destination) : destination,
  )
}

/** The remembered sites with `site` sent to `destination`, newest last, within the limit. */
export function rememberSite(
  alwaysOpenIn: LinkPrefs['alwaysOpenIn'],
  site: string,
  destination: LinkDestination,
): LinkPrefs['alwaysOpenIn'] {
  const entries = Object.entries(alwaysOpenIn).filter(([known]) => known !== site)
  entries.push([site, destination])
  return Object.fromEntries(entries.slice(-MAX_LINK_SITES))
}

/** The remembered sites without `site`, in their order. */
export function forgetSite(
  alwaysOpenIn: LinkPrefs['alwaysOpenIn'],
  site: string,
): LinkPrefs['alwaysOpenIn'] {
  return Object.fromEntries(Object.entries(alwaysOpenIn).filter(([known]) => known !== site))
}

/** Whether a link's text is its address, as an autolink or a pasted URL writes it. */
export function isBareLink(text: string, url: string): boolean {
  const shown = text.trim()
  if (!shown || !webUrl(url)) return false
  const plain = (value: string) => value.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return shown === url || plain(shown) === plain(url)
}

/** A bare address as a link shows it: the host, then the rest without a lone "/". */
export function bareParts(url: string): { host: string; rest: string } | null {
  const parsed = webUrl(url)
  if (!parsed) return null
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`
  return { host: parsed.host, rest: rest === '/' ? '' : readableRest(rest) }
}

const ESCAPED: Record<string, string> = { '(': '%28', ')': '%29', '<': '%3C', '>': '%3E' }

/** The link as Markdown: an autolink for a bare address, else `[text](url)`, escaped. */
export function markdownLink(text: string, url: string): string {
  const target = (webUrl(url)?.href ?? url).replace(/[\s()<>]/g, (char) => ESCAPED[char] ?? '%20')
  if (isBareLink(text, url)) return `<${target}>`
  const label = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\[\]]/g, (char) => `\\${char}`)
  return `[${label || target}](${target})`
}
