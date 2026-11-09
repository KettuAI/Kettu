import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempFolder } from '../testing/temp'
import { catalogFile, LISTINGS, MarketCatalogService, parseCatalogFile, SECTIONS } from './catalog'
import { REGISTRY_URL } from './registry'

const DAY = 24 * 60 * 60_000

function entry(name: string, extra: Record<string, unknown> = {}): unknown {
  return {
    server: {
      name,
      version: '1.0.0',
      description: `${name} server`,
      remotes: [{ type: 'streamable-http', url: `https://mcp.example.com/${name}` }],
      ...extra,
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
  }
}

interface Registry {
  /** What the registry answers for a URL: a body, a status, or a thrown failure. */
  answer: (url: string) => unknown
  asked: string[]
}

function registry(): Registry & { fetch: typeof fetch } {
  const state: Registry = {
    answer: (url) => {
      const match = /\/servers\/([^/]+)\/versions\/latest$/.exec(url)
      return match ? entry(decodeURIComponent(match[1]!)) : { servers: [] }
    },
    asked: [],
  }
  const fake = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    state.asked.push(url)
    const answer = state.answer(url)
    if (answer instanceof Error) throw answer
    if (typeof answer === 'number') return new Response('nope', { status: answer })
    return new Response(JSON.stringify(answer), { status: 200 })
  }
  return Object.assign(state, { fetch: fake as typeof fetch })
}

async function service(
  dir: string,
  fake: Registry & { fetch: typeof fetch },
  clock: { now: number },
) {
  const logs: string[] = []
  const catalog = new MarketCatalogService({
    file: catalogFile(dir, (_level, message) => logs.push(message)),
    log: (_level, message) => logs.push(message),
    fetch: fake.fetch,
    now: () => clock.now,
  })
  return { catalog, logs }
}

const listed = [...new Set(SECTIONS.flatMap((section) => section.ids))]

describe('MarketCatalogService', () => {
  it('reads every listed server once and keeps the catalog for a day', async () => {
    const dir = await tempFolder('kettu-market-')
    const fake = registry()
    const clock = { now: 1_000 }
    const { catalog } = await service(dir, fake, clock)
    const first = await catalog.catalog()
    expect(first.error).toBeNull()
    expect(first.fetchedAt).toBe(1_000)
    expect(first.sections.map((section) => section.id)).toEqual(SECTIONS.map((s) => s.id))
    expect(fake.asked).toHaveLength(listed.length)
    expect(fake.asked).toContain(
      `${REGISTRY_URL}/servers/${encodeURIComponent('io.github.github/github-mcp-server')}/versions/latest`,
    )
    const github = first.sections[0]!.items.find(
      (s) => s.id === 'io.github.github/github-mcp-server',
    )
    expect(github).toMatchObject({ official: true, brand: 'github' })

    clock.now += DAY - 1
    await catalog.catalog()
    expect(fake.asked).toHaveLength(listed.length)
    await catalog.catalog(true)
    expect(fake.asked).toHaveLength(listed.length * 2)
    clock.now += DAY
    await catalog.catalog()
    expect(fake.asked).toHaveLength(listed.length * 3)
  })

  it('keeps what the registry answered in the state folder for the next run', async () => {
    const dir = await tempFolder('kettu-market-')
    const fake = registry()
    const clock = { now: 5_000 }
    const { catalog } = await service(dir, fake, clock)
    await catalog.catalog()
    await catalog.flush()
    const stored = JSON.parse(
      await readFile(path.join(dir, 'state', 'market-catalog.json'), 'utf8'),
    )
    expect(stored).toMatchObject({ version: 1, fetchedAt: 5_000 })
    expect(Object.keys(stored.entries).sort()).toEqual([...listed].sort())

    const later = await service(dir, registry(), { now: 6_000 })
    const kept = await later.catalog.catalog()
    expect(kept).toMatchObject({ fetchedAt: 5_000, error: null })
    expect(kept.sections.flatMap((s) => s.items)).not.toHaveLength(0)
  })

  it('serves the copy from before with the reason when the registry fails', async () => {
    const dir = await tempFolder('kettu-market-')
    const fake = registry()
    const clock = { now: 1_000 }
    const { catalog } = await service(dir, fake, clock)
    const fresh = await catalog.catalog()
    fake.answer = () => 503
    const failed = await catalog.catalog(true)
    expect(failed.error).toBe('The MCP Registry answered 503')
    expect(failed.fetchedAt).toBe(1_000)
    expect(failed.sections).toEqual(fresh.sections)

    fake.answer = () => new TypeError('getaddrinfo ENOTFOUND')
    const offline = await catalog.catalog(true)
    expect(offline.error).toContain('Could not reach the MCP Registry')
    expect(offline.sections).toEqual(fresh.sections)
  })

  it('has nothing to show and says why when the registry never answered', async () => {
    const dir = await tempFolder('kettu-market-')
    const fake = registry()
    fake.answer = () => 500
    const { catalog } = await service(dir, fake, { now: 1 })
    const result = await catalog.catalog()
    expect(result.fetchedAt).toBeNull()
    expect(result.error).toBe('The MCP Registry answered 500')
    expect(result.sections.every((section) => section.items.length === 0)).toBe(true)
  })

  it('leaves out a listed server the registry no longer has', async () => {
    const dir = await tempFolder('kettu-market-')
    const fake = registry()
    const gone = encodeURIComponent('com.notion/mcp')
    const answer = fake.answer
    fake.answer = (url) => (url.includes(gone) ? 404 : answer(url))
    const { catalog } = await service(dir, fake, { now: 1 })
    const result = await catalog.catalog()
    expect(result.error).toBeNull()
    expect(result.sections.flatMap((s) => s.items).some((s) => s.id === 'com.notion/mcp')).toBe(
      false,
    )
  })

  it('refuses an answer larger than it reads', async () => {
    const dir = await tempFolder('kettu-market-')
    const fake = registry()
    fake.answer = () => ({ servers: [], padding: 'x'.repeat(5 * 1024 * 1024) })
    const { catalog } = await service(dir, fake, { now: 1 })
    const result = await catalog.search('github')
    expect(result.error).toMatch(/more than/)
  })

  it("searches the registry's latest versions, listed servers first, and keeps results briefly", async () => {
    const dir = await tempFolder('kettu-market-')
    const fake = registry()
    const clock = { now: 1 }
    const { catalog } = await service(dir, fake, clock)
    await catalog.catalog()
    fake.answer = (url) =>
      url.includes('/servers?')
        ? {
            servers: [
              entry('ai.example/github-tools'),
              entry('io.github.acme/unrunnable', { remotes: [] }),
            ],
          }
        : 404
    fake.asked.length = 0
    const result = await catalog.search('github')
    expect(fake.asked).toEqual([`${REGISTRY_URL}/servers?search=github&version=latest&limit=30`])
    expect(result.error).toBeNull()
    expect(result.items[0]).toMatchObject({
      id: 'io.github.github/github-mcp-server',
      official: true,
    })
    expect(result.items.map((s) => s.id)).toContain('ai.example/github-tools')
    expect(result.items.map((s) => s.id)).not.toContain('io.github.acme/unrunnable')

    await catalog.search('GitHub')
    expect(fake.asked).toHaveLength(1)
    clock.now += 10 * 60_000
    await catalog.search('github')
    expect(fake.asked).toHaveLength(2)
  })
})

describe('parseCatalogFile', () => {
  it('takes the stored answers and refuses another shape', () => {
    expect(parseCatalogFile({ version: 1, fetchedAt: 3, entries: { a: {} } })).toEqual({
      version: 1,
      fetchedAt: 3,
      entries: { a: {} },
    })
    expect(parseCatalogFile({ version: 1, fetchedAt: null, entries: {} })).toMatchObject({
      fetchedAt: null,
    })
    expect(typeof parseCatalogFile({ version: 1, fetchedAt: 'soon', entries: {} })).toBe('string')
    expect(typeof parseCatalogFile({ version: 1, fetchedAt: 1, entries: [] })).toBe('string')
  })

  it('reads a stored entry through the same checks as a fresh one', async () => {
    const dir = await tempFolder('kettu-market-')
    await mkdir(path.join(dir, 'state'), { recursive: true })
    const bad = { server: { name: 'io.github.github/github-mcp-server', version: '1' } }
    await writeFile(
      path.join(dir, 'state', 'market-catalog.json'),
      JSON.stringify({
        version: 1,
        fetchedAt: 10,
        entries: { 'io.github.github/github-mcp-server': bad },
      }),
    )
    const { catalog } = await service(dir, registry(), { now: 11 })
    const kept = await catalog.catalog()
    expect(kept.sections.flatMap((s) => s.items)).toEqual([])
    expect(Object.keys(LISTINGS)).toContain('io.github.github/github-mcp-server')
  })
})
