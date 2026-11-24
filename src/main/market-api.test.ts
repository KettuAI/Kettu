import { describe, expect, it } from 'vitest'
import type { PublishManifest } from '@shared/market-publish'
import {
  MarketApi,
  MarketUnauthorized,
  marketCallOf,
  runMarketCall,
  type Fetch,
} from './market-api'

const BASE = 'https://www.kettu.sh'
const LISTING = {
  id: 'abcdefgh23',
  handle: 'amigoer',
  slug: 'changelog-writer',
  name: 'Changelog writer',
  kind: 'skill',
  description: 'One line per change.',
  visibility: 'public',
  current: '1.0.0',
  versions: [
    { version: '1.0.0', notes: '', status: 'live', bytes: 10, files: 1, publishedAt: '2026-11-14' },
  ],
  installs: { total: 3, week: 1, days: [0, 1] },
  takenDown: null,
  createdAt: '2026-11-14',
  updatedAt: '2026-11-14',
}

interface Sent {
  url: string
  init: RequestInit
}

function fake(answer: (sent: Sent) => Response): { fetch: Fetch; sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    fetch: async (url, init) => {
      const request = { url, init }
      sent.push(request)
      return answer(request)
    },
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function api(fetch: Fetch, token = 't1'): MarketApi {
  return new MarketApi({ base: BASE, token, fetch })
}

describe('MarketApi requests', () => {
  it('sends the token to the Marketplace API, never following a redirect', async () => {
    const { fetch, sent } = fake(() => json(200, { publisher: { handle: 'amigoer', since: 'x' } }))
    expect(await api(fetch).publisher()).toEqual({ handle: 'amigoer', since: 'x' })
    expect(sent[0]!.url).toBe(`${BASE}/api/v1/marketplace/publisher`)
    expect(sent[0]!.init.method).toBe('GET')
    expect(sent[0]!.init.redirect).toBe('error')
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer t1')
  })

  it('answers no publisher before one is set, and sets one as JSON', async () => {
    const none = fake(() => json(200, { publisher: null }))
    expect(await api(none.fetch).publisher()).toBeNull()
    const set = fake(() => json(200, { publisher: { handle: 'amigoer', since: 'x' } }))
    await api(set.fetch).setPublisher('amigoer')
    expect(set.sent[0]!.init.method).toBe('PUT')
    expect(set.sent[0]!.init.body).toBe('{"handle":"amigoer"}')
    expect((set.sent[0]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    )
  })

  it('publishes the manifest and one part per file, named by its path', async () => {
    const { fetch, sent } = fake(() => json(201, { listing: LISTING }))
    const manifest: PublishManifest = {
      slug: 'changelog-writer',
      name: 'Changelog writer',
      kind: 'skill',
      description: 'One line per change.',
      version: '1.0.0',
      visibility: 'public',
    }
    const listing = await api(fetch).publish(manifest, [
      { path: 'SKILL.md', bytes: new TextEncoder().encode('# hi') },
      { path: 'examples/a.md', bytes: new Uint8Array([1, 2]) },
    ])
    expect(listing.id).toBe('abcdefgh23')
    expect(sent[0]!.url).toBe(`${BASE}/api/v1/marketplace/versions`)
    const form = sent[0]!.init.body as FormData
    expect(JSON.parse(form.get('manifest') as string)).toEqual(manifest)
    expect(await (form.get('SKILL.md') as Blob).text()).toBe('# hi')
    expect((form.get('examples/a.md') as Blob).size).toBe(2)
  })

  it('answers a held version with the version the service holds, and nothing else without one', async () => {
    const manifest: PublishManifest = {
      slug: 'changelog-writer',
      name: 'Changelog writer',
      kind: 'skill',
      description: 'One line per change.',
      version: '1.1.0',
    }
    const held = fake(() => json(202, { listing: LISTING, held: '1.1.0' }))
    expect((await api(held.fetch).publish(manifest, [])).held).toBe('1.1.0')
    const listed = fake(() => json(201, { listing: LISTING }))
    expect((await api(listed.fetch).publish(manifest, [])).held).toBeUndefined()
    for (const body of [{ listing: LISTING }, { listing: LISTING, held: 7 }]) {
      const odd = fake(() => json(202, body))
      await expect(api(odd.fetch).publish(manifest, [])).rejects.toMatchObject({
        failure: { code: 'unexpected' },
      })
    }
  })

  it('sends the token with every request, a file download included', async () => {
    const { fetch, sent } = fake(({ url }) =>
      url.includes('/files/') ? new Response('old') : json(200, { files: [] }),
    )
    const client = api(fetch)
    await client.version('abcdefgh23', '1.0.0')
    await client.file('abcdefgh23', '1.0.0', 'SKILL.md')
    for (const request of sent) {
      expect(new Headers(request.init.headers).get('authorization')).toBe('Bearer t1')
    }
  })

  it('unlists, withdraws and reads a version and its files at their own paths', async () => {
    const { fetch, sent } = fake(({ url }) =>
      url.includes('/files/')
        ? new Response('old', { headers: { 'x-content-sha256': 'abc' } })
        : url.endsWith('/1.0.0')
          ? json(200, { files: [{ path: 'SKILL.md', size: 3, sha256: 'abc' }] })
          : json(200, { listing: LISTING }),
    )
    const client = api(fetch)
    await client.update('abcdefgh23', { visibility: 'unlisted' })
    await client.withdraw('abcdefgh23', '1.0.0')
    expect((await client.version('abcdefgh23', '1.0.0')).files).toHaveLength(1)
    const file = await client.file('abcdefgh23', '1.0.0', 'docs/a b.md')
    expect(new TextDecoder().decode(file.bytes)).toBe('old')
    expect(file.sha256).toBe('abc')
    expect(sent.map((s) => `${s.init.method} ${s.url.slice(BASE.length)}`)).toEqual([
      'PATCH /api/v1/marketplace/listings/abcdefgh23',
      'POST /api/v1/marketplace/listings/abcdefgh23/versions/1.0.0/withdraw',
      'GET /api/v1/marketplace/listings/abcdefgh23/versions/1.0.0',
      'GET /api/v1/marketplace/listings/abcdefgh23/versions/1.0.0/files/docs/a%20b.md',
    ])
  })

  it('puts nothing that is not an id, a version or a file path into a URL', async () => {
    const { fetch, sent } = fake(() => json(200, { listing: LISTING }))
    const client = api(fetch)
    await expect(client.update('../mine', {})).rejects.toMatchObject({
      failure: { code: 'invalid' },
    })
    await expect(client.version('abcdefgh23', '1.0.0/../x')).rejects.toThrow()
    await expect(client.file('abcdefgh23', '1.0.0', '../secret')).rejects.toThrow()
    expect(sent).toEqual([])
  })
})

describe('MarketApi listings', () => {
  it('reads each version’s checks for its publisher, leaving out what is not a check', async () => {
    const checks = [
      { check: 'skill', target: 'SKILL.md', result: 'passed' },
      { check: 'package', target: 'npm x@1.0.0', result: 'skipped', note: 'npm did not answer' },
      { check: 'secrets', result: 'unknown' },
      'paths',
    ]
    const { fetch } = fake(() =>
      json(200, {
        publisher: { handle: 'amigoer', since: 'x' },
        listings: [{ ...LISTING, versions: [{ ...LISTING.versions[0], checks }] }],
        storage: { bytes: 1, limit: 2 },
      }),
    )
    const mine = await api(fetch).mine()
    expect(mine.listings[0]!.versions[0]!.checks).toEqual([
      { check: 'skill', target: 'SKILL.md', result: 'passed' },
      { check: 'package', target: 'npm x@1.0.0', result: 'skipped', note: 'npm did not answer' },
    ])
  })
})

describe('MarketApi versions', () => {
  it('reads held and refused versions, and treats a state it does not know as not live', async () => {
    const versions = [
      { ...LISTING.versions[0], version: '1.1.0', status: 'held' },
      {
        ...LISTING.versions[0],
        version: '1.2.0',
        status: 'refused',
        refusal: { reason: 'It reads a secret.', at: '2026-11-25' },
      },
      { ...LISTING.versions[0], version: '1.3.0', status: 'refused', refusal: 'no' },
      { ...LISTING.versions[0], version: '1.4.0', status: 'archived' },
      // Only a refused version carries a refusal.
      {
        ...LISTING.versions[0],
        version: '1.5.0',
        status: 'live',
        refusal: { reason: 'x', at: 'y' },
      },
    ]
    const { fetch } = fake(() =>
      json(200, {
        publisher: null,
        listings: [{ ...LISTING, versions }],
        storage: { bytes: 1, limit: 2 },
      }),
    )
    const read = (await api(fetch).mine()).listings[0]!.versions
    expect(read.map((v) => [v.version, v.status, v.refusal])).toEqual([
      ['1.1.0', 'held', undefined],
      ['1.2.0', 'refused', { reason: 'It reads a secret.', at: '2026-11-25' }],
      ['1.3.0', 'refused', undefined],
      ['1.4.0', 'unknown', undefined],
      ['1.5.0', 'live', undefined],
    ])
  })
})

describe('MarketApi errors', () => {
  it('carries the service’s code, problems and limits', async () => {
    const checked = fake(() =>
      json(422, {
        error: 'check_failed',
        message: 'The version did not pass its checks',
        problems: [{ path: 'SKILL.md', message: 'No description' }, { message: 'Too big' }],
      }),
    )
    await expect(api(checked.fetch).publish({} as PublishManifest, [])).rejects.toMatchObject({
      failure: {
        code: 'check_failed',
        status: 422,
        problems: [{ path: 'SKILL.md', message: 'No description' }, { message: 'Too big' }],
      },
    })
    const full = fake(() =>
      json(403, { error: 'storage_full', message: 'Full', bytes: 5, limit: 4 }),
    )
    await expect(api(full.fetch).mine()).rejects.toMatchObject({
      failure: { code: 'storage_full', bytes: 5, limit: 4 },
    })
    const taken = fake(() => json(409, { error: 'version_exists', message: 'Exists' }))
    await expect(api(taken.fetch).publisher()).rejects.toMatchObject({
      failure: {
        code: 'version_exists',
        status: 409,
        message: 'This version was already published.',
      },
    })
    const unknown = fake(() => json(500, { error: 'brand_new', message: 'The service’s words' }))
    await expect(api(unknown.fetch).publisher()).rejects.toMatchObject({
      failure: { code: 'brand_new', message: 'The service’s words' },
    })
  })

  it('tells a refused token apart, and a network failure or an answer not understood', async () => {
    const refused = fake(() => json(401, { error: 'unauthorized', message: 'No' }))
    await expect(api(refused.fetch).mine()).rejects.toBeInstanceOf(MarketUnauthorized)
    const down: Fetch = () => Promise.reject(new Error('offline'))
    await expect(api(down).mine()).rejects.toMatchObject({ failure: { code: 'network' } })
    const odd = fake(() => new Response('<html>', { status: 200 }))
    await expect(api(odd.fetch).mine()).rejects.toMatchObject({ failure: { code: 'unexpected' } })
    const wrong = fake(() => json(200, { listings: 'no' }))
    await expect(api(wrong.fetch).mine()).rejects.toMatchObject({ failure: { code: 'unexpected' } })
  })
})

describe('MarketApi directory', () => {
  it('puts the cursor only in the directory’s cursor parameter', async () => {
    const { fetch, sent } = fake(() => json(200, { items: [], next: null }))
    await api(fetch).directory({ q: 'notes', kind: 'skill', cursor: 'a+b/c=' })
    const url = new URL(sent[0]!.url)
    expect(url.origin + url.pathname).toBe(`${BASE}/api/v1/marketplace/directory`)
    expect(url.searchParams.get('cursor')).toBe('a+b/c=')
    expect([...url.searchParams.keys()].sort()).toEqual(['cursor', 'kind', 'q'])
  })

  it('marks only a listing the service says is Kettu’s own as official', async () => {
    const item = { ...LISTING, version: '1.0.0', versions: ['1.0.0'], installs: 3 }
    const items = [
      { ...item, handle: 'kettu-labs', official: true },
      { ...item, handle: 'kettu-lab', official: 'yes' },
      item,
    ]
    const { fetch } = fake(() => json(200, { items, next: null }))
    const directory = await api(fetch).directory({})
    expect(directory.items.map((l) => [l.handle, l.official])).toEqual([
      ['kettu-labs', true],
      ['kettu-lab', false],
      ['amigoer', false],
    ])
  })
})

describe('runMarketCall', () => {
  class SignedOut extends Error {}

  it('refreshes a refused token once through withToken, then answers', async () => {
    const tokens: string[] = []
    const { fetch } = fake(({ init }) => {
      const token = (init.headers as Record<string, string>).authorization
      tokens.push(token)
      return token === 'Bearer old'
        ? json(401, { error: 'unauthorized', message: 'Expired' })
        : json(200, { publisher: null, listings: [LISTING], storage: { bytes: 1, limit: 2 } })
    })
    const answer = await runMarketCall(
      { kind: 'mine' },
      {
        base: BASE,
        fetch,
        withToken: async (run) => {
          try {
            return await run('old')
          } catch (error) {
            if (!(error instanceof MarketUnauthorized)) throw error
            return run('new')
          }
        },
        signedOut: () => false,
      },
    )
    expect(tokens).toEqual(['Bearer old', 'Bearer new'])
    expect('result' in answer && (answer.result as { listings: unknown[] }).listings).toHaveLength(
      1,
    )
  })

  it('answers signed_out without reaching the service while signed out or in Local mode', async () => {
    const { fetch, sent } = fake(() => json(200, {}))
    const answer = await runMarketCall(
      { kind: 'publisher' },
      {
        base: BASE,
        fetch,
        withToken: () => Promise.reject(new SignedOut()),
        signedOut: (error) => error instanceof SignedOut,
      },
    )
    expect(answer).toEqual({ error: expect.objectContaining({ code: 'signed_out' }) })
    expect(sent).toEqual([])
  })

  it('sends a publish’s files from base64, and answers a service error as an error', async () => {
    const { fetch, sent } = fake(() => json(409, { error: 'version_exists', message: 'Exists' }))
    const answer = await runMarketCall(
      {
        kind: 'publish',
        manifest: { slug: 's', name: 'S', kind: 'skill', description: 'd', version: '1.0.0' },
        files: [{ path: 'SKILL.md', data: Buffer.from('hello').toString('base64') }],
      },
      { base: BASE, fetch, withToken: (run) => run('t'), signedOut: () => false },
    )
    expect(answer).toEqual({ error: expect.objectContaining({ code: 'version_exists' }) })
    expect(await ((sent[0]!.init.body as FormData).get('SKILL.md') as Blob).text()).toBe('hello')
  })
})

describe('marketCallOf', () => {
  it('takes the calls the host makes and nothing else', () => {
    expect(marketCallOf({ kind: 'mine' })).toEqual({ kind: 'mine' })
    expect(marketCallOf({ kind: 'set-publisher', handle: 'a' })).not.toBeNull()
    expect(marketCallOf({ kind: 'set-publisher', handle: 7 })).toBeNull()
    expect(marketCallOf({ kind: 'publish', manifest: {}, files: [{ path: 'a' }] })).toBeNull()
    expect(marketCallOf({ kind: 'update', id: 'x' })).toBeNull()
    expect(marketCallOf({ kind: 'drop-tables' })).toBeNull()
    expect(marketCallOf('mine')).toBeNull()
  })

  it('takes a directory cursor only as the service gives it', () => {
    expect(marketCallOf({ kind: 'directory', cursor: 'MTIuYWJjZGVmZ2gyMw' })).not.toBeNull()
    for (const cursor of ['a?b', 'a&b=c', 'a#b', 'a%2F', 'a b', '..', '../x', 'x'.repeat(257)]) {
      expect(marketCallOf({ kind: 'directory', cursor })).toBeNull()
    }
  })
})
