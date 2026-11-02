// The icons of the sites Kettu's own browser opened, which links in replies show. A site is
// recorded only when a session's page opens it, and its icon comes through the browser's own
// partition, so drawing a link never contacts its site.

import { join } from 'node:path'
import type { SiteIconEvent, SiteIconMap } from '@shared/ipc'
import { JsonFileWriter, readJsonFile } from '../json-file'
import { createLogger, describeError } from '../log'
import { readBody } from '../theme-catalog'
import { originOf } from './origins'

const log = createLogger('site-icons')

/** The largest icon kept. */
export const MAX_ICON_BYTES = 64 * 1024
/** The most sites kept; the one opened longest ago goes first. */
export const MAX_SITES = 200

const TIMEOUT_MS = 10_000
const WRITE_DELAY_MS = 2_000
const IMAGE_TYPE = /^image\/[a-z0-9.+-]+$/
const STORED_ICON = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/

export type IconFetch = (url: string, init: RequestInit) => Promise<Response>

interface Site {
  icon: string | null
  /** The address the icon came from, so a page naming it again does not load it again. */
  source: string | null
}

export interface SiteIconsDeps {
  /** Loads through the browser's partition, with its cache and cookies. */
  fetch: IconFetch
  changed(event: SiteIconEvent): void
}

/** The icon a page names that may be kept: its first http(s) or `data:` one. */
export function pickFavicon(favicons: readonly unknown[]): string | null {
  for (const favicon of favicons) {
    if (typeof favicon !== 'string') continue
    const protocol = URL.parse(favicon)?.protocol
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'data:') return favicon
  }
  return null
}

/** A `data:` icon as it is kept: an image type, base64, and small enough; null otherwise. */
export function dataIcon(url: string): string | null {
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
  /** The load each site waits for, so only the latest one lands. */
  private readonly loads = new Map<string, number>()
  private nextLoad = 0

  private constructor(
    private readonly sites: Map<string, Site>,
    private readonly writer: JsonFileWriter,
    private readonly deps: SiteIconsDeps,
  ) {}

  /** Reads the file leniently: what does not fit is left out, and the file is never moved aside. */
  static async load(userDataPath: string, deps: SiteIconsDeps): Promise<SiteIcons> {
    const path = join(userDataPath, 'state', 'site-icons.json')
    const read = await readJsonFile(path)
    let sites = new Map<string, Site>()
    if (read.kind === 'ok') sites = parseSiteIcons(read.value)
    else if (read.kind === 'unreadable') log.warn(`Could not read site-icons.json: ${read.reason}`)
    return new SiteIcons(sites, new JsonFileWriter(path, log, WRITE_DELAY_MS), deps)
  }

  /** Every recorded site's icon by its origin; null for a site opened without one. */
  all(): SiteIconMap {
    const icons: SiteIconMap = {}
    for (const [origin, site] of this.sites) icons[origin] = site.icon
    return icons
  }

  /** A session's page opened `pageUrl`. */
  visited(pageUrl: string): void {
    const origin = originOf(pageUrl)
    if (origin === null) return
    const site = this.sites.get(origin)
    this.sites.delete(origin)
    this.sites.set(origin, site ?? { icon: null, source: null })
    if (!site) this.deps.changed({ kind: 'set', origin, icon: null })
    while (this.sites.size > MAX_SITES) {
      const oldest = this.sites.keys().next().value!
      this.sites.delete(oldest)
      this.loads.delete(oldest)
      this.deps.changed({ kind: 'removed', origin: oldest })
    }
    this.save()
  }

  /** The page at `pageUrl` named its icons; the first fit one is loaded and kept for its origin. */
  async favicons(pageUrl: string, favicons: readonly unknown[]): Promise<void> {
    const origin = originOf(pageUrl)
    const source = pickFavicon(favicons)
    if (origin === null || source === null) return
    if (!this.sites.has(origin)) this.visited(pageUrl)
    if (this.sites.get(origin)?.source === source) return
    const load = ++this.nextLoad
    this.loads.set(origin, load)
    const icon = source.startsWith('data:') ? dataIcon(source) : await this.read(source)
    const site = this.sites.get(origin)
    if (this.loads.get(origin) !== load || !site) return
    this.loads.delete(origin)
    if (!icon) return
    site.icon = icon
    site.source = source
    this.deps.changed({ kind: 'set', origin, icon })
    this.save()
  }

  /** Forgets every site, with the browser's other data. */
  clear(): void {
    this.sites.clear()
    this.loads.clear()
    this.deps.changed({ kind: 'cleared' })
    this.save()
  }

  flush(): Promise<void> {
    return this.writer.flush()
  }

  private async read(url: string): Promise<string | null> {
    try {
      const response = await this.deps.fetch(url, {
        credentials: 'include',
        cache: 'force-cache',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
      if (!response.ok || !IMAGE_TYPE.test(type)) {
        void response.body?.cancel()
        return null
      }
      const bytes = await readBody(response, MAX_ICON_BYTES)
      return bytes ? iconOf(type, bytes) : null
    } catch (error) {
      log.info(`Could not load a site's icon: ${describeError(error)}`)
      return null
    }
  }

  private save(): void {
    const sites = [...this.sites].map(([origin, { icon, source }]) => ({ origin, icon, source }))
    this.writer.schedule({ version: 1, sites })
  }
}
