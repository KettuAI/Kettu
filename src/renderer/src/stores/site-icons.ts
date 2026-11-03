import { create } from 'zustand'
import type { DefaultBrowser, SiteIconEvent, SiteIconMap } from '@shared/ipc'

interface SiteIconsStore {
  /** The icon of each site opened from Kettu, by origin; null for one without. */
  sites: SiteIconMap
  /** Icons loaded for links' sites, which the sites were not opened for, by origin. */
  linked: SiteIconMap
  /** The system's default browser, once main has read it. */
  browser: DefaultBrowser | null
}

export const useSiteIconsStore = create<SiteIconsStore>()(() => ({
  sites: {},
  linked: {},
  browser: null,
}))

function apply(sites: SiteIconMap, event: SiteIconEvent): SiteIconMap {
  if (event.kind === 'cleared') return {}
  if (event.kind === 'link') return sites
  const next = { ...sites }
  if (event.kind === 'set') next[event.origin] = event.icon
  else delete next[event.origin]
  return next
}

function applyLinked(linked: SiteIconMap, event: SiteIconEvent): SiteIconMap {
  if (event.kind === 'cleared') return {}
  if (event.kind !== 'link') return linked
  return { ...linked, [event.origin]: event.icon }
}

let started = false

/** Reads the icons and the default browser once, then follows the icons main records. */
export function loadSiteIcons(): void {
  if (started) return
  started = true
  // Events that come before the first read are applied on top of it.
  const early: SiteIconEvent[] = []
  let loaded = false
  window.kettu.browser.onSiteIcon((event) => {
    if (!loaded) early.push(event)
    else
      useSiteIconsStore.setState((s) => ({
        sites: apply(s.sites, event),
        linked: applyLinked(s.linked, event),
      }))
  })
  void window.kettu.browser
    .siteIcons()
    .catch(() => ({}))
    .then((sites) => {
      loaded = true
      useSiteIconsStore.setState({
        sites: early.reduce(apply, sites),
        linked: early.reduce(applyLinked, {}),
      })
    })
  void window.kettu.app
    .defaultBrowser()
    .catch(() => ({ name: null, icon: null }))
    .then((browser) => useSiteIconsStore.setState({ browser }))
}

/**
 * The recorded icon of the site `url` is on: its own origin's, else the same host's over the
 * other scheme. Null for a site opened without one, undefined for one never opened.
 */
export function iconFor(sites: SiteIconMap, url: string): string | null | undefined {
  const parsed = URL.parse(url)
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return undefined
  const own = parsed.origin
  if (Object.hasOwn(sites, own)) return sites[own]
  const other = `${parsed.protocol === 'https:' ? 'http:' : 'https:'}//${parsed.host}`
  return Object.hasOwn(sites, other) ? sites[other] : undefined
}

/** The recorded icon of the site a link goes to; see `iconFor`. */
export function useSiteIcon(url: string): string | null | undefined {
  return useSiteIconsStore((s) => iconFor(s.sites, url) ?? iconFor(s.linked, url))
}

const asked = new Set<string>()

/**
 * Asks once for a link's site icon when Kettu has none for it, so a link shows the site's icon
 * before its page has opened. The site stays unopened; main keeps to public sites.
 */
export function requestSiteIcon(url: string): void {
  const parsed = URL.parse(url)
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return
  if (asked.has(parsed.origin)) return
  const { sites, linked } = useSiteIconsStore.getState()
  if (iconFor(sites, url) || iconFor(linked, url)) return
  asked.add(parsed.origin)
  void window.kettu.browser.loadSiteIcon(url).catch(() => {})
}

export function useDefaultBrowser(): DefaultBrowser {
  return useSiteIconsStore((s) => s.browser) ?? NO_BROWSER
}

const NO_BROWSER: DefaultBrowser = { name: null, icon: null }
