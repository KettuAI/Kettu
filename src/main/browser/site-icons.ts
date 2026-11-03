// The icons of the sites Kettu's own browser opened, which links in replies show. A site is
// recorded when a session's page or a link in Kettu opens it, and its icon comes only through the
// browser's own partition, so drawing a link never contacts its site.

import { BlockList, isIPv4, isIPv6 } from 'node:net'
import { join } from 'node:path'
import type { SiteIconEvent, SiteIconMap } from '@shared/ipc'
import { JsonFileWriter, readJsonFile } from '../json-file'
import { createLogger, describeError } from '../log'
import { readBody } from '../theme-catalog'
import { originOf } from './origins'

const log = createLogger('site-icons')

/** The largest icon kept; links draw them at 14 to 32 px. */
export const MAX_ICON_BYTES = 16 * 1024
/** The most sites kept; the one opened longest ago goes first. */
export const MAX_SITES = 200
/** The least time between two loads for one site, however often its page changes its icon. */
export const LOAD_GAP_MS = 5_000

const TIMEOUT_MS = 10_000
const WRITE_DELAY_MS = 2_000
// Percent-encoding takes up to three characters a byte, so no fit icon's address is longer.
const MAX_DATA_URL_LENGTH = MAX_ICON_BYTES * 3 + 256
const IMAGE_TYPE = /^image\/[a-z0-9.+-]+$/
const STORED_ICON = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/

export type IconFetch = (url: string, init: RequestInit) => Promise<Response>

interface Site {
  icon: string | null
  /** The address the icon came from, so a page naming it again does not load it again. */
  source: string | null
}

/** A site's icon loads: the one in flight and the one waiting for the gap to pass. */
interface Loading {
  /** When the last load started. */
  started: number
  current: { source: string; controller: AbortController } | null
  /** The latest address named within the gap, loaded once it has passed. */
  waiting: string | null
  timer: ReturnType<typeof setTimeout> | null
}

export interface SiteIconsDeps {
  /** Loads through the browser's partition, with its cache. */
  fetch: IconFetch
  changed(event: SiteIconEvent): void
}

const PRIVATE_NETWORKS = new BlockList()
PRIVATE_NETWORKS.addAddress('0.0.0.0')
PRIVATE_NETWORKS.addSubnet('127.0.0.0', 8)
PRIVATE_NETWORKS.addSubnet('10.0.0.0', 8)
PRIVATE_NETWORKS.addSubnet('172.16.0.0', 12)
PRIVATE_NETWORKS.addSubnet('192.168.0.0', 16)
PRIVATE_NETWORKS.addSubnet('169.254.0.0', 16)
PRIVATE_NETWORKS.addAddress('::', 'ipv6')
PRIVATE_NETWORKS.addAddress('::1', 'ipv6')
PRIVATE_NETWORKS.addSubnet('fc00::', 7, 'ipv6')
PRIVATE_NETWORKS.addSubnet('fe80::', 10, 'ipv6')

/** Whether a URL's host is this computer or on a private network, by its name or address. */
function isPrivateHost(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (isIPv4(host)) return PRIVATE_NETWORKS.check(host, 'ipv4')
  return isIPv6(host) && PRIVATE_NETWORKS.check(host, 'ipv6')
}

/**
 * The icon a page names that may be kept: its first http(s) or `data:` one. A page on the
 * internet cannot make main load from this computer or a private network.
 */
export function pickFavicon(favicons: readonly unknown[], pageUrl: string): string | null {
  const page = URL.parse(pageUrl)
  const local = page !== null && isPrivateHost(page)
  for (const favicon of favicons) {
    if (typeof favicon !== 'string') continue
    const url = URL.parse(favicon)
    if (url?.protocol === 'data:') return favicon
    if (url?.protocol !== 'http:' && url?.protocol !== 'https:') continue
    if (local || !isPrivateHost(url)) return favicon
  }
  return null
}

/** A `data:` icon as it is kept: an image type, base64, and small enough; null otherwise. */
export function dataIcon(url: string): string | null {
  if (url.length > MAX_DATA_URL_LENGTH) return null
  const match = /^data:([^,]*),(.*)$/s.exec(url)
  if (!match) return null
  const [type = '', ...params] = match[1]!.split(';').map((part) => part.trim().toLowerCase())
  if (!IMAGE_TYPE.test(type)) return null
  let bytes: Buffer
  if (params.includes('base64')) {
    const text = match[2]!.replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
    bytes = Buffer.from(text, 'base64')
  } else {
    try {
      bytes = Buffer.from(decodeURIComponent(match[2]!), 'utf8')
    } catch {
      return null
    }
  }
  return iconOf(type, bytes)
}

function iconOf(type: string, bytes: Buffer): string | null {
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null
  return `data:${type};base64,${bytes.toString('base64')}`
}

/** `state/site-icons.json`, oldest first, with anything unfit left out. */
export function parseSiteIcons(raw: unknown): Map<string, Site> {
  const sites = new Map<string, Site>()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return sites
  const list = (raw as Record<string, unknown>).sites
  if (!Array.isArray(list)) return sites
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const { origin, icon, source } = entry as Record<string, unknown>
    if (typeof origin !== 'string' || originOf(origin) !== origin) continue
    const kept =
      typeof icon === 'string' &&
      STORED_ICON.test(icon) &&
      icon.length <= Math.ceil(MAX_ICON_BYTES / 3) * 4 + 64
    sites.delete(origin)
    sites.set(origin, {
      icon: kept ? icon : null,
      source: kept && typeof source === 'string' ? source : null,
    })
  }
  while (sites.size > MAX_SITES) sites.delete(sites.keys().next().value!)
  return sites
}

export class SiteIcons {
  private sites = new Map<string, Site>()
  /** Icons loaded for a link's site that the site was never opened for, by origin. */
  private readonly linked = new Map<string, string>()
  private readonly loading = new Map<string, Loading>()
  /** Sites a link already asked an icon for, so one run asks each of them once. */
  private readonly asked = new Set<string>()
  private fileRead = false
  /** What was asked before the file was read, done in order once it is. */
  private readonly queued: (() => void)[] = []
  private readonly writer: JsonFileWriter
  /** Settles once the file is read. */
  readonly ready: Promise<void>

  private constructor(
    path: string,
    private readonly deps: SiteIconsDeps,
  ) {
    this.writer = new JsonFileWriter(path, log, WRITE_DELAY_MS)
    this.ready = this.readFile(path)
  }

  /**
   * Starts reading the file leniently: what does not fit is left out, and the file is never moved
   * aside. Until it is read, changes wait for it and `all` answers once it is.
   */
  static open(userDataPath: string, deps: SiteIconsDeps): SiteIcons {
    return new SiteIcons(join(userDataPath, 'state', 'site-icons.json'), deps)
  }

  /** Every recorded site's icon by its origin; null for a site opened without one. */
  async all(): Promise<SiteIconMap> {
    await this.ready
    const icons: SiteIconMap = {}
    for (const [origin, site] of this.sites) icons[origin] = site.icon
    return icons
  }

  /** A session's page opened `pageUrl`. */
  visited(pageUrl: string): void {
    this.whenRead(() => this.record(pageUrl))
  }

  /**
   * The page at `pageUrl` named its icons; the first fit one is loaded and kept for its origin.
   * A site starts at most one load per `LOAD_GAP_MS`, a `data:` icon's included, as a page that
   * draws its icon on a canvas names a new one each frame; what its page names in between waits,
   * and only the latest of it loads.
   */
  async favicons(pageUrl: string, favicons: readonly unknown[]): Promise<void> {
    const origin = originOf(pageUrl)
    const source = pickFavicon(favicons, pageUrl)
    if (origin === null || source === null) return
    if (!this.fileRead) await this.ready
    if (!this.sites.has(origin)) this.record(pageUrl)
    await this.request(origin, source)
  }

  /**
   * A link in a reply has no icon for its site: tries the icon at the site's own root, once per
   * run, without counting the site as opened, which the first-visit confirmation reads. Only
   * public http(s) sites, so a reply cannot make main request this computer.
   */
  async link(url: string): Promise<void> {
    const site = URL.parse(url)
    if (site === null) return
    if (site.protocol !== 'http:' && site.protocol !== 'https:') return
    if (site.username !== '' || site.password !== '') return
    if (isPrivateHost(site)) return
    const origin = originOf(url)
    if (origin === null || this.asked.has(origin)) return
    if (this.linked.has(origin) || this.sites.get(origin)?.icon) return
    this.asked.add(origin)
    const icon = await this.fetchIcon(`${origin}/favicon.ico`, new AbortController().signal)
    if (icon === null) return
    this.linked.set(origin, icon)
    this.deps.changed({ kind: 'link', origin, icon })
  }

  /** Forgets every site, with the browser's other data, and writes that at once. */
  async clear(): Promise<void> {
    this.whenRead(() => {
      for (const loading of this.loading.values()) stop(loading)
      this.loading.clear()
      this.linked.clear()
      this.sites.clear()
      this.deps.changed({ kind: 'cleared' })
      this.save()
    })
    await this.flush()
  }

  async flush(): Promise<void> {
    await this.ready
    await this.writer.flush()
  }

  private async readFile(path: string): Promise<void> {
    try {
      const read = await readJsonFile(path)
      if (read.kind === 'ok') this.sites = parseSiteIcons(read.value)
      else if (read.kind === 'unreadable')
        log.warn(`Could not read site-icons.json: ${read.reason}`)
    } finally {
      this.fileRead = true
      for (const run of this.queued.splice(0)) run()
    }
  }

  private whenRead(run: () => void): void {
    if (this.fileRead) run()
    else this.queued.push(run)
  }

  private loadingOf(origin: string): Loading {
    let loading = this.loading.get(origin)
    if (!loading) {
      loading = { started: -Infinity, current: null, waiting: null, timer: null }
      this.loading.set(origin, loading)
    }
    return loading
  }

  private record(pageUrl: string): void {
    const origin = originOf(pageUrl)
    if (origin === null) return
    const site = this.sites.get(origin)
    this.sites.delete(origin)
    this.sites.set(origin, site ?? { icon: null, source: null })
    if (!site) this.deps.changed({ kind: 'set', origin, icon: null })
    while (this.sites.size > MAX_SITES) {
      const oldest = this.sites.keys().next().value!
      this.sites.delete(oldest)
      const loading = this.loading.get(oldest)
      if (loading) stop(loading)
      this.loading.delete(oldest)
      this.deps.changed({ kind: 'removed', origin: oldest })
    }
    this.save()
  }

  /** Starts `source`'s load, or holds it to the site's gap and loads the latest one asked. */
  private request(origin: string, source: string): Promise<void> | void {
    const loading = this.loadingOf(origin)
    if (this.sites.get(origin)?.source === source) {
      stop(loading)
    } else if (loading.current?.source === source) {
      unwait(loading)
    } else {
      const wait = loading.started + LOAD_GAP_MS - Date.now()
      if (wait <= 0) return this.load(origin, loading, source)
      loading.waiting = source
      loading.timer ??= setTimeout(() => {
        const next = loading.waiting
        unwait(loading)
        if (next !== null && this.sites.get(origin)?.source !== next) {
          void this.load(origin, loading, next)
        }
      }, wait)
    }
  }

  /** Loads `source` for the site, stopping the load in flight. */
  private async load(origin: string, loading: Loading, source: string): Promise<void> {
    loading.current?.controller.abort()
    loading.started = Date.now()
    if (source.startsWith('data:')) {
      loading.current = null
      this.keep(origin, source, dataIcon(source))
      return
    }
    const current = { source, controller: new AbortController() }
    loading.current = current
    const icon = await this.fetchIcon(source, current.controller.signal)
    if (loading.current !== current) return
    loading.current = null
    this.keep(origin, source, icon)
  }

  private keep(origin: string, source: string, icon: string | null): void {
    const site = this.sites.get(origin)
    if (!icon || !site) return
    site.source = source
    if (site.icon === icon) return
    site.icon = icon
    this.deps.changed({ kind: 'set', origin, icon })
    this.save()
  }

  private async fetchIcon(url: string, signal: AbortSignal): Promise<string | null> {
    try {
      const response = await this.deps.fetch(url, {
        // A page names any address as its icon; cookies would make that a signed-in request.
        credentials: 'omit',
        cache: 'force-cache',
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      })
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
      if (!response.ok || !IMAGE_TYPE.test(type)) {
        void response.body?.cancel()
        return null
      }
      const bytes = await readBody(response, MAX_ICON_BYTES)
      return bytes ? iconOf(type, bytes) : null
    } catch (error) {
      if (!signal.aborted) log.info(`Could not load a site's icon: ${describeError(error)}`)
      return null
    }
  }

  private save(): void {
    const sites = [...this.sites].map(([origin, { icon, source }]) => ({ origin, icon, source }))
    this.writer.schedule({ version: 1, sites })
  }
}

function unwait(loading: Loading): void {
  if (loading.timer) clearTimeout(loading.timer)
  loading.timer = null
  loading.waiting = null
}

/** Stops the load in flight and the one waiting; the gap still counts from the last start. */
function stop(loading: Loading): void {
  unwait(loading)
  loading.current?.controller.abort()
  loading.current = null
}
