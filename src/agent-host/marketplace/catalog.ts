// The Marketplace's catalog: the servers the app's own lists name, read from the official MCP
// Registry and kept for a day in the host's state, and the registry's search as the user types.
// When the registry cannot be reached, the catalog comes from what was kept, with the reason.

import path from 'node:path'
import type {
  CatalogSection,
  CatalogServer,
  MarketCatalog,
  MarketSearch,
} from '@shared/marketplace'
import { JsonFile, type LogFn } from '../storage'
import { catalogServer, REGISTRY_URL, type Listing } from './registry'

const DAY_MS = 24 * 60 * 60_000
const SEARCH_MS = 5 * 60_000
const SEARCHES = 50
const SEARCH_LIMIT = 30
const TIMEOUT_MS = 15_000
const ENTRY_BYTES = 1024 * 1024
const SEARCH_BYTES = 4 * 1024 * 1024
const PARALLEL = 6

const BEARER = { Authorization: 'Bearer ' }

/** The servers the app's own lists name, with what they add to the registry's entries. */
export const LISTINGS: Readonly<Record<string, Listing>> = {
  'io.github.github/github-mcp-server': { official: true, brand: 'github', prefixes: BEARER },
  'io.github.microsoft/playwright-mcp': {
    official: true,
    brand: 'playwright',
    title: 'Playwright',
  },
  'io.github.upstash/context7': { official: true, prefixes: BEARER },
  'com.notion/mcp': { official: true, brand: 'notion', title: 'Notion' },
  'app.linear/linear': { official: true, brand: 'linear' },
  'io.github.getsentry/sentry-mcp': { official: true, brand: 'sentry' },
  'com.stripe/mcp': { official: true, brand: 'stripe', title: 'Stripe' },
  'com.supabase/mcp': { official: true, brand: 'supabase' },
  'com.cloudflare.mcp/mcp': { official: true, brand: 'cloudflare', title: 'Cloudflare Docs' },
  'com.atlassian/atlassian-mcp-server': { official: true, brand: 'jira' },
  'com.figma.mcp/mcp': { official: true, brand: 'figma' },
  'com.vercel/vercel-mcp': { official: true, brand: 'vercel', title: 'Vercel' },
  'io.github.ChromeDevTools/chrome-devtools-mcp': { official: true },
  'com.gitlab/mcp': { official: true, title: 'GitLab' },
  'io.github.timescale/pg-aiguide': { brand: 'postgresql', title: 'Postgres AI Guide' },
  'com.neon/mcp': { official: true, title: 'Neon', prefixes: BEARER },
  'io.prisma/mcp': { official: true, prefixes: BEARER },
  'io.github.ClickHouse/mcp-clickhouse': { official: true },
  'io.github.PostHog/mcp': { official: true, prefixes: BEARER },
  'com.airtable/mcp': { official: true, title: 'Airtable' },
  'com.zapier/mcp': { official: true },
  'net.todoist/mcp': { official: true },
  'com.canva.mcp/mcp': { official: true },
  'io.github.miroapp/mcp-server': { official: true },
  'com.webflow/mcp': { official: true, title: 'Webflow' },
}

/** The catalog's sections, by the ids the app's copy titles them with, each in its order. */
export const SECTIONS: readonly { id: string; ids: readonly string[] }[] = [
  {
    id: 'featured',
    ids: [
      'io.github.github/github-mcp-server',
      'com.notion/mcp',
      'app.linear/linear',
      'com.figma.mcp/mcp',
      'io.github.microsoft/playwright-mcp',
      'io.github.upstash/context7',
      'io.github.getsentry/sentry-mcp',
      'com.stripe/mcp',
    ],
  },
  {
    id: 'development',
    ids: [
      'io.github.github/github-mcp-server',
      'io.github.microsoft/playwright-mcp',
      'io.github.upstash/context7',
      'io.github.getsentry/sentry-mcp',
      'io.github.ChromeDevTools/chrome-devtools-mcp',
      'com.vercel/vercel-mcp',
      'com.cloudflare.mcp/mcp',
      'com.gitlab/mcp',
      'com.stripe/mcp',
    ],
  },
  {
    id: 'data',
    ids: [
      'com.supabase/mcp',
      'com.neon/mcp',
      'io.github.timescale/pg-aiguide',
      'io.prisma/mcp',
      'io.github.ClickHouse/mcp-clickhouse',
      'io.github.PostHog/mcp',
    ],
  },
  {
    id: 'productivity',
    ids: [
      'com.notion/mcp',
      'app.linear/linear',
      'com.atlassian/atlassian-mcp-server',
      'com.airtable/mcp',
      'net.todoist/mcp',
      'com.zapier/mcp',
    ],
  },
  {
    id: 'design',
    ids: [
      'com.figma.mcp/mcp',
      'com.canva.mcp/mcp',
      'io.github.miroapp/mcp-server',
      'com.webflow/mcp',
    ],
  },
]

/** What the registry answered for each listed server, kept as it came. */
export interface CatalogFile {
  version: 1
  fetchedAt: number | null
  entries: Record<string, unknown>
}

export function parseCatalogFile(data: Record<string, unknown>): CatalogFile | string {
  const { fetchedAt, entries } = data
  if (fetchedAt !== null && (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt))) {
    return 'fetchedAt is not a time'
  }
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    return 'entries is not an object'
  }
  return { version: 1, fetchedAt, entries: entries as Record<string, unknown> }
}

export function catalogFile(userDataPath: string, log: LogFn): JsonFile<CatalogFile> {
  return new JsonFile<CatalogFile>({
    file: path.join(userDataPath, 'state', 'market-catalog.json'),
    version: 1,
    migrations: {},
    parse: parseCatalogFile,
    empty: () => ({ version: 1, fetchedAt: null, entries: {} }),
    log,
  })
}

/** A read the registry did not answer, as the catalog explains it. */
class RegistryError extends Error {}

/** The body of a response, as JSON, read only up to `limit` bytes. */
async function cappedJson(response: Response, limit: number): Promise<unknown> {
  const length = Number(response.headers.get('content-length'))
  if (length > limit || !response.body) {
    void response.body?.cancel()
    throw new RegistryError(`The MCP Registry sent more than ${limit} bytes`)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      void reader.cancel()
      throw new RegistryError(`The MCP Registry sent more than ${limit} bytes`)
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RegistryError('The MCP Registry sent something other than JSON')
  }
}

/** Builds the sections from the entries the registry gave for the listed names. */
export function catalogSections(entries: Record<string, unknown>): CatalogSection[] {
  const read = new Map<string, CatalogServer | null>()
  const server = (id: string): CatalogServer | null => {
    if (!read.has(id)) {
      const entry = Object.hasOwn(entries, id) ? entries[id] : undefined
      const parsed = catalogServer(entry, LISTINGS[id])
      read.set(id, parsed?.id === id ? parsed : null)
    }
    return read.get(id) ?? null
  }
  return SECTIONS.map((section) => ({
    id: section.id,
    items: section.ids.flatMap((id) => server(id) ?? []),
  }))
}

export interface CatalogOptions {
  file: JsonFile<CatalogFile>
  log: LogFn
  fetch?: typeof fetch
  now?: () => number
}

export class MarketCatalogService {
  private kept: CatalogFile | null = null
  private loading: Promise<CatalogFile> | null = null
  private reading: Promise<MarketCatalog> | null = null
  private readonly searches = new Map<string, { at: number; result: MarketSearch }>()
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: CatalogOptions) {
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  /** The catalog, from the day's copy unless `refresh` asks the registry again. */
  async catalog(refresh = false): Promise<MarketCatalog> {
    const kept = await this.load()
    if (!refresh && kept.fetchedAt !== null && this.now() - kept.fetchedAt < DAY_MS) {
      return { sections: catalogSections(kept.entries), fetchedAt: kept.fetchedAt, error: null }
    }
    this.reading ??= this.read().finally(() => (this.reading = null))
    return this.reading
  }

  /**
   * The registry's runnable servers whose name has `query` in it, after the listed servers the
   * day's copy has that match it by name or title, which the registry's alphabetical page of
   * results may not reach.
   */
  async search(query: string): Promise<MarketSearch> {
    const key = query.toLowerCase()
    const hit = this.searches.get(key)
    if (hit && this.now() - hit.at < SEARCH_MS) return hit.result
    const kept = await this.load()
    const listed = Object.keys(LISTINGS).flatMap((id) => {
      if (!Object.hasOwn(kept.entries, id)) return []
      const server = catalogServer(kept.entries[id], LISTINGS[id])
      const matches =
        server?.id.toLowerCase().includes(key) || server?.title.toLowerCase().includes(key)
      return server && matches ? [server] : []
    })
    let found: CatalogServer[]
    try {
      const params = new URLSearchParams({
        search: query,
        version: 'latest',
        limit: String(SEARCH_LIMIT),
      })
      const answer = await this.get(`${REGISTRY_URL}/servers?${params}`, SEARCH_BYTES)
      const servers = isRecord(answer) && Array.isArray(answer.servers) ? answer.servers : []
      found = servers.flatMap((entry: unknown) => {
        const id = isRecord(entry) && isRecord(entry.server) ? entry.server.name : undefined
        const listing =
          typeof id === 'string' && Object.hasOwn(LISTINGS, id) ? LISTINGS[id] : undefined
        return catalogServer(entry, listing) ?? []
      })
    } catch (error) {
      return { query, items: listed, error: (error as Error).message }
    }
    const shown = new Set(listed.map((server) => server.id))
    const rest = found.filter((server) => !shown.has(server.id))
    // A listed server the day's copy lacks still comes before the others.
    rest.sort(
      (a, b) => Number(Object.hasOwn(LISTINGS, b.id)) - Number(Object.hasOwn(LISTINGS, a.id)),
    )
    const result: MarketSearch = { query, items: [...listed, ...rest], error: null }
    this.searches.delete(key)
    this.searches.set(key, { at: this.now(), result })
    if (this.searches.size > SEARCHES) this.searches.delete(this.searches.keys().next().value!)
    return result
  }

  flush(): Promise<void> {
    return this.options.file.flush()
  }

  private load(): Promise<CatalogFile> {
    if (this.kept) return Promise.resolve(this.kept)
    this.loading ??= this.options.file.load().then(
      (file) => (this.kept = file),
      (error: unknown) => {
        this.options.log(
          'warn',
          `Could not read the Marketplace catalog: ${(error as Error).message}`,
        )
        return (this.kept = { version: 1, fetchedAt: null, entries: {} })
      },
    )
    return this.loading
  }

  /**
   * Asks the registry for each listed server. A name it no longer has is left out; any other
   * failure keeps the copy from before for the servers it hit, and the file is not rewritten.
   */
  private async read(): Promise<MarketCatalog> {
    const kept = await this.load()
    const ids = [...new Set(SECTIONS.flatMap((section) => section.ids))]
    const entries: Record<string, unknown> = {}
    const failures: string[] = []
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++]!
        try {
          const entry = await this.get(
            `${REGISTRY_URL}/servers/${encodeURIComponent(id)}/versions/latest`,
            ENTRY_BYTES,
          )
          if (entry !== null) entries[id] = entry
        } catch (failure) {
          failures.push((failure as Error).message)
          if (Object.hasOwn(kept.entries, id)) entries[id] = kept.entries[id]
        }
      }
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker))
    const error = failures[0]
    if (error !== undefined) {
      this.options.log('warn', `The Marketplace catalog is from before: ${error}`)
      return { sections: catalogSections(entries), fetchedAt: kept.fetchedAt, error }
    }
    const fetchedAt = this.now()
    this.kept = { version: 1, fetchedAt, entries }
    this.options.file.save(this.kept)
    return { sections: catalogSections(entries), fetchedAt, error: null }
  }

  /** A GET of the registry's JSON; null when it has no such server. */
  private async get(url: string, limit: number): Promise<unknown> {
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetch(url, { signal, headers: { accept: 'application/json' } })
    } catch (error) {
      if (signal.aborted) {
        throw new RegistryError(`The MCP Registry did not answer in ${TIMEOUT_MS / 1000} s`)
      }
      throw new RegistryError(`Could not reach the MCP Registry: ${(error as Error).message}`)
    }
    if (response.status === 404) {
      void response.body?.cancel()
      return null
    }
    if (!response.ok) {
      void response.body?.cancel()
      throw new RegistryError(`The MCP Registry answered ${response.status}`)
    }
    try {
      return await cappedJson(response, limit)
    } catch (error) {
      if (error instanceof RegistryError) throw error
      if (signal.aborted) {
        throw new RegistryError(`The MCP Registry did not answer in ${TIMEOUT_MS / 1000} s`)
      }
      throw new RegistryError(`Could not read the MCP Registry: ${(error as Error).message}`)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
