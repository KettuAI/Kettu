// `state/brought-sign-ins.json`: the sites whose sign-ins were brought from another browser, from
// which browser and profile and when, for Settings to list. It holds no cookie.

import { join } from 'node:path'
import { isSignInBrowserId, type BroughtSite } from '@shared/signins'
import { JsonFileWriter, readJsonFile } from '../../json-file'
import type { Logger } from '../../log'
import { siteOf } from './sites'

/** The most sites kept; the one brought longest ago goes first. */
export const MAX_BROUGHT = 2_000
const MAX_NAME = 200

/** The sites in the file, with anything unfit left out, newest first and each once. */
export function parseBrought(raw: unknown): BroughtSite[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  const stored = (raw as Record<string, unknown>).sites
  if (!Array.isArray(stored)) return []
  const sites = new Map<string, BroughtSite>()
  for (const item of stored) {
    if (typeof item !== 'object' || item === null) continue
    const { site, browser, profile, at } = item as Record<string, unknown>
    if (typeof site !== 'string' || siteOf(site) !== site) continue
    if (!isSignInBrowserId(browser)) continue
    if (typeof profile !== 'string' || profile.length > MAX_NAME) continue
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    const known = sites.get(site)
    if (!known || known.at < at) sites.set(site, { site, browser, profile, at })
  }
  return newestFirst([...sites.values()])
}

function newestFirst(sites: BroughtSite[]): BroughtSite[] {
  return sites.sort((a, b) => b.at - a.at || a.site.localeCompare(b.site)).slice(0, MAX_BROUGHT)
}

export class BroughtStore {
  private constructor(
    private sites: BroughtSite[],
    private readonly writer: JsonFileWriter,
  ) {}

  static async load(userDataPath: string, log: Logger): Promise<BroughtStore> {
    const path = join(userDataPath, 'state', 'brought-sign-ins.json')
    const read = await readJsonFile(path)
    let sites: BroughtSite[] = []
    if (read.kind === 'ok') sites = parseBrought(read.value)
    else if (read.kind === 'unreadable')
      log.warn(`Could not read brought-sign-ins.json: ${read.reason}`)
    return new BroughtStore(sites, new JsonFileWriter(path, log))
  }

  list(): BroughtSite[] {
    return [...this.sites]
  }

  /** Records sites brought now, each replacing an earlier record of it. */
  add(sites: readonly BroughtSite[]): void {
    if (sites.length === 0) return
    const fresh = new Set(sites.map((site) => site.site))
    this.sites = newestFirst([...sites, ...this.sites.filter((site) => !fresh.has(site.site))])
    this.save()
  }

  remove(site: string): void {
    const kept = this.sites.filter((known) => known.site !== site)
    if (kept.length === this.sites.length) return
    this.sites = kept
    this.save()
  }

  clear(): void {
    if (this.sites.length === 0) return
    this.sites = []
    this.save()
  }

  flush(): Promise<void> {
    return this.writer.flush()
  }

  private save(): void {
    this.writer.schedule({ version: 1, sites: this.sites })
  }
}
