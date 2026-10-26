import { describe, expect, it } from 'vitest'
import {
  accountSubdomain,
  assetHash,
  CLOUDFLARE_API,
  Cloudflare,
  COMPATIBILITY_DATE,
  type Fetch,
  findAccounts,
  listAccounts,
  WORKER_MODULE,
  workerName,
} from './cloudflare'
import { headersFile, pageHeaders, withMeta } from './page'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const OTHER = 'fedcba9876543210fedcba9876543210'
const TOKEN = 'test-token'
const WORKER = 'ob-aaaaaaaaaaaaaaaa'
const HTML = '<html><head><title>Report</title></head><body>Hi</body></html>'
const PAGE = withMeta(HTML)
const HEADERS = headersFile(pageHeaders())

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function ok(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fail(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function listing(accounts: unknown[], totalCount?: number): Response {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: accounts,
      ...(totalCount === undefined ? {} : { result_info: { total_count: totalCount } }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function hex(value: number): string {
  return value.toString(16).padStart(32, '0')
}

function listed(count: number): { id: string; name: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    id: hex(index + 1),
    name: `Account ${index + 1}`,
  }))
}

function apiPath(call: Call): string {
  return new URL(call.url).pathname.replace('/client/v4', '')
}

function server(answer: (call: Call) => Response): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: Fetch = async (url, init) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    }
    calls.push(call)
    return answer(call)
  }
  return { fetch, calls }
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

interface Part {
  text: string
  type: string
}

async function parts(body: unknown): Promise<Map<string, Part>> {
  const form = body as FormData
  const out = new Map<string, Part>()
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') out.set(name, { text: value, type: '' })
    else out.set(name, { text: await value.text(), type: value.type })
  }
  return out
}

function cloudflare(fetch: Fetch): Cloudflare {
  return new Cloudflare({
    accountId: ACCOUNT,
    subdomain: 'team',
    token: TOKEN,
    fetch,
    random: () => Buffer.alloc(10, 0),
  })
}

const INDEX_HASH = assetHash(base64(PAGE), 'html')
const HEADERS_HASH = assetHash(base64(HEADERS), '')
const SCRIPTS = `${CLOUDFLARE_API}/accounts/${ACCOUNT}/workers/scripts`

/** The answers a publish makes, in order: session, upload, script, subdomain. */
function published(call: Call): Response {
  const path = new URL(call.url).pathname
  if (path.endsWith('/assets-upload-session')) {
    return ok({ jwt: 'upload-token', buckets: [[INDEX_HASH, HEADERS_HASH]] })
  }
  if (path.endsWith('/workers/assets/upload')) return ok({ jwt: 'completion-token' })
  if (path.endsWith(`/scripts/${WORKER}`) && call.method === 'PUT') {
    return ok({ id: WORKER })
  }
  if (path.endsWith(`/scripts/${WORKER}/subdomain`)) return ok({ enabled: true })
  if (path.endsWith(`/scripts/${WORKER}`) && call.method === 'DELETE') return ok({ id: WORKER })
  throw new Error(`Unexpected request ${call.method} ${call.url}`)
}

describe('workerName', () => {
  it('is ob- and 16 base32 characters, from random bytes only', () => {
    expect(workerName(() => Buffer.alloc(10, 0))).toBe(WORKER)
    expect(workerName(() => Buffer.alloc(10, 255))).toBe('ob-7777777777777777')
  })
})

describe('publish', () => {
  it('opens an upload session, uploads both files, deploys the module and turns workers.dev on', async () => {
    const { fetch, calls } = server(published)

    await expect(cloudflare(fetch).publish(PAGE, pageHeaders())).resolves.toEqual({
      url: `https://${WORKER}.team.workers.dev/`,
      ref: WORKER,
    })

    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ['POST', `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/assets-upload-session`],
      ['POST', `/client/v4/accounts/${ACCOUNT}/workers/assets/upload`],
      ['PUT', `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`],
      ['POST', `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/subdomain`],
    ])
    expect(new URL(calls[1]!.url).search).toBe('?base64=true')
    expect(calls.map((call) => call.headers.Authorization)).toEqual([
      `Bearer ${TOKEN}`,
      'Bearer upload-token',
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ])

    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      manifest: {
        '/index.html': { hash: INDEX_HASH, size: Buffer.byteLength(PAGE) },
        '/_headers': { hash: HEADERS_HASH, size: Buffer.byteLength(HEADERS) },
      },
    })

    const upload = await parts(calls[1]!.body)
    expect(upload.get(INDEX_HASH)).toEqual({
      text: base64(PAGE),
      type: 'text/html; charset=utf-8',
    })
    expect(upload.get(HEADERS_HASH)).toEqual({
      text: base64(HEADERS),
      type: 'text/plain; charset=utf-8',
    })

    const script = await parts(calls[2]!.body)
    expect(JSON.parse(script.get('metadata')!.text)).toEqual({
      main_module: 'index.js',
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [{ name: 'ASSETS', type: 'assets' }],
      assets: { jwt: 'completion-token', config: { _headers: HEADERS } },
    })
    expect(script.get('index.js')).toEqual({
      text: WORKER_MODULE,
      type: 'application/javascript+module',
    })

    expect(JSON.parse(calls[3]!.body as string)).toEqual({
      enabled: true,
      previews_enabled: false,
    })
  })

  it('takes the Worker down again when it cannot turn its route on', async () => {
    const { fetch, calls } = server((call) => {
      if (new URL(call.url).pathname.endsWith('/subdomain')) {
        return fail(400, 10000, 'Authentication error')
      }
      return published(call)
    })

    await expect(cloudflare(fetch).publish(PAGE, pageHeaders())).rejects.toMatchObject({
      failure: 'invalid_token',
    })
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${SCRIPTS}/${WORKER}`,
    })
  })
})

describe('update', () => {
  it('uploads the new version to the same Worker and never asks for a route again', async () => {
    const { fetch, calls } = server(published)

    await cloudflare(fetch).update(WORKER, PAGE, pageHeaders())

    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ['POST', `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/assets-upload-session`],
      ['POST', `/client/v4/accounts/${ACCOUNT}/workers/assets/upload`],
      ['PUT', `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`],
    ])
  })
})

describe('unpublish', () => {
  it('deletes the Worker', async () => {
    const { fetch, calls } = server((call) => {
      expect(call.method).toBe('DELETE')
      return ok({ id: WORKER })
    })
    await cloudflare(fetch).unpublish(WORKER)
    expect(calls.map((call) => call.url)).toEqual([`${SCRIPTS}/${WORKER}`])
  })

  it('counts a Worker Cloudflare no longer has as gone', async () => {
    const { fetch } = server(() => fail(404, 10007, 'This script does not exist'))
    await expect(cloudflare(fetch).unpublish(WORKER)).resolves.toBeUndefined()
  })
})

describe('failures', () => {
  it('maps a refused token', async () => {
    const { fetch } = server(() => fail(401, 1000, 'Invalid API Token'))
    await expect(cloudflare(fetch).publish(PAGE, pageHeaders())).rejects.toMatchObject({
      failure: 'invalid_token',
      detail: 'Invalid API Token',
    })
  })

  it('names the Worker limit', async () => {
    const { fetch } = server((call) => {
      if (call.method === 'DELETE') return ok({})
      return fail(400, 10037, 'You have exceeded the maximum number of Workers')
    })
    await expect(cloudflare(fetch).publish(PAGE, pageHeaders())).rejects.toMatchObject({
      failure: 'worker_limit',
    })
  })

  it('maps an unreachable network', async () => {
    const fetch: Fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.cloudflare.com')
    }
    await expect(cloudflare(fetch).publish(PAGE, pageHeaders())).rejects.toMatchObject({
      failure: 'network',
    })
  })
})

describe('listAccounts', () => {
  it('asks for 50 a page and follows pages until a short one', async () => {
    const first = listed(50)
    const second = [{ id: ACCOUNT, name: 'Team' }]
    const { fetch, calls } = server((call) => {
      return new URL(call.url).searchParams.get('page') === '1' ? listing(first) : listing(second)
    })

    await expect(listAccounts(fetch, TOKEN)).resolves.toEqual([...first, ...second])
    expect(calls.map((call) => new URL(call.url).search)).toEqual([
      '?per_page=50&page=1',
      '?per_page=50&page=2',
    ])
  })

  it('stops once result_info.total_count is reached', async () => {
    const { fetch, calls } = server(() => listing(listed(50), 50))

    await expect(listAccounts(fetch, TOKEN)).resolves.toHaveLength(50)
    expect(calls).toHaveLength(1)
  })

  it('fails after 20 full pages', async () => {
    const { fetch, calls } = server(() => listing(listed(50), 10_000))

    await expect(listAccounts(fetch, TOKEN)).rejects.toMatchObject({
      failure: 'failed',
      message: 'Cloudflare listed more than 1,000 accounts for this token.',
    })
    expect(calls).toHaveLength(20)
  })

  it('skips entries without a 32-hex id or a name', async () => {
    const { fetch } = server(() =>
      listing([
        { id: ACCOUNT, name: 'Team' },
        { id: 'nope', name: 'Bad id' },
        { id: OTHER },
        { name: 'No id' },
        null,
        'entry',
        { id: OTHER, name: 'Other' },
      ]),
    )

    await expect(listAccounts(fetch, TOKEN)).resolves.toEqual([
      { id: ACCOUNT, name: 'Team' },
      { id: OTHER, name: 'Other' },
    ])
  })

  it('maps a refusal to invalid_token', async () => {
    const { fetch } = server(() => fail(403, 9109, 'Invalid access token'))

    await expect(listAccounts(fetch, TOKEN)).rejects.toMatchObject({ failure: 'invalid_token' })
  })
})

describe('accountSubdomain', () => {
  it('reads the account subdomain', async () => {
    const { fetch, calls } = server(() => ok({ subdomain: 'team' }))

    await expect(accountSubdomain(fetch, TOKEN, ACCOUNT)).resolves.toBe('team')
    expect(calls.map((call) => call.url)).toEqual([
      `${CLOUDFLARE_API}/accounts/${ACCOUNT}/workers/subdomain`,
    ])
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('is null when Cloudflare answers 404 or code 10007', async () => {
    for (const answer of [
      () => fail(404, 10007, 'Not found'),
      () => fail(400, 10007, 'Not found'),
    ]) {
      const { fetch } = server(answer)
      await expect(accountSubdomain(fetch, TOKEN, ACCOUNT)).resolves.toBeNull()
    }
  })

  it('is null when the subdomain is empty', async () => {
    const { fetch } = server(() => ok({ subdomain: '' }))

    await expect(accountSubdomain(fetch, TOKEN, ACCOUNT)).resolves.toBeNull()
  })

  it('rejects a value that is no DNS label', async () => {
    const { fetch } = server(() => ok({ subdomain: 'Not A Label' }))

    await expect(accountSubdomain(fetch, TOKEN, ACCOUNT)).rejects.toMatchObject({
      failure: 'failed',
    })
  })
})

describe('findAccounts', () => {
  it('drops an account that refuses the token and keeps one without a subdomain', async () => {
    const { fetch } = server((call) => {
      if (apiPath(call) === '/accounts') {
        return listing([
          { id: hex(1), name: 'Alpha' },
          { id: hex(2), name: 'Refused' },
          { id: hex(3), name: 'No subdomain' },
        ])
      }
      if (apiPath(call) === `/accounts/${hex(1)}/workers/subdomain`) {
        return ok({ subdomain: 'team' })
      }
      if (apiPath(call) === `/accounts/${hex(2)}/workers/subdomain`) {
        return fail(403, 9109, 'Invalid access token')
      }
      return fail(404, 10007, 'Not found')
    })

    await expect(findAccounts(fetch, TOKEN)).resolves.toEqual([
      { id: hex(1), name: 'Alpha', subdomain: 'team' },
      { id: hex(3), name: 'No subdomain', subdomain: null },
    ])
  })

  it('fails the whole lookup when an account has a network error', async () => {
    const { fetch } = server((call) => {
      if (apiPath(call) === '/accounts') return listing([{ id: ACCOUNT, name: 'Team' }])
      throw new Error('getaddrinfo ENOTFOUND api.cloudflare.com')
    })

    await expect(findAccounts(fetch, TOKEN)).rejects.toMatchObject({ failure: 'network' })
  })

  it('never has more than four requests open at once', async () => {
    const accounts = listed(12)
    let open = 0
    let most = 0
    const fetch: Fetch = async (url) => {
      if (new URL(url).pathname === '/client/v4/accounts') return listing(accounts)
      open++
      most = Math.max(most, open)
      await new Promise((resolve) => setTimeout(resolve, 5))
      open--
      return ok({ subdomain: 'team' })
    }

    await expect(findAccounts(fetch, TOKEN)).resolves.toHaveLength(12)
    expect(most).toBe(4)
  })

  it('sorts by name, ignoring case', async () => {
    const { fetch } = server((call) => {
      if (apiPath(call) === '/accounts') {
        return listing([
          { id: hex(1), name: 'Zulu' },
          { id: hex(2), name: 'alpha' },
          { id: hex(3), name: 'Bravo' },
        ])
      }
      return ok({ subdomain: 'team' })
    })

    const found = await findAccounts(fetch, TOKEN)
    expect(found.map((account) => account.name)).toEqual(['alpha', 'Bravo', 'Zulu'])
  })

  it('never calls GET /user/tokens/verify', async () => {
    const { fetch, calls } = server((call) => {
      if (apiPath(call) === '/accounts') return listing([{ id: ACCOUNT, name: 'Team' }])
      return ok({ subdomain: 'team' })
    })

    await findAccounts(fetch, TOKEN)
    expect(calls.some((call) => call.url.includes('/user/tokens/verify'))).toBe(false)
  })
})

describe('existing', () => {
  it('keeps the pages Cloudflare still lists', async () => {
    const { fetch, calls } = server((call) => {
      expect(call.method).toBe('GET')
      return ok([{ id: WORKER }, { id: 'ob-bbbbbbbbbbbbbbbb' }])
    })
    await expect(cloudflare(fetch).existing([WORKER, 'ob-cccccccccccccccc'])).resolves.toEqual(
      new Set([WORKER]),
    )
    expect(calls.map((call) => call.url)).toEqual([SCRIPTS])
  })
})
