import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Fetch } from './cloudflare'
import { Sharing, type SharingDeps } from './index'
import { SharingStore, type TokenCipher } from './store'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const OTHER = 'fedcba9876543210fedcba9876543210'
const TOKEN = 'cfut_example-token'

const cipher: TokenCipher = {
  encrypt: async (text) => `sealed:${text}`,
  decrypt: async (text) => text.slice('sealed:'.length),
}

interface Call {
  url: string
  method: string
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function page(accounts: unknown[]): Response {
  return ok(accounts)
}

function refused(): Response {
  return new Response(
    JSON.stringify({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }] }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
}

function missing(): Response {
  return new Response(
    JSON.stringify({ success: false, errors: [{ code: 10007, message: 'Not found' }] }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  )
}

function server(answer: (call: Call) => Response): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: Fetch = async (url, init) => {
    const call: Call = { url, method: init.method ?? 'GET' }
    calls.push(call)
    return answer(call)
  }
  return { fetch, calls }
}

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

async function load(
  fetch: Fetch,
  overrides: Partial<SharingDeps> = {},
): Promise<{ sharing: Sharing; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kettu-sharing-connect-'))
  dirs.push(dir)
  const sharing = await Sharing.load({
    userDataPath: dir,
    contentDir: join(dir, 'content'),
    host: {
      content: async () => ({ kind: 'not_found' }),
      ids: async () => new Set<string>(),
    },
    cipher,
    encryptionAvailable: async () => true,
    plainText: () => false,
    fetch,
    ...overrides,
  })
  return { sharing, dir }
}

function path(call: Call): string {
  return new URL(call.url).pathname.replace('/client/v4', '')
}

describe('connect', () => {
  it('finds the only account, keeps it and reports it', async () => {
    const { fetch, calls } = server((call) => {
      if (path(call) === '/accounts') return page([{ id: ACCOUNT, name: 'Team' }])
      return ok({ subdomain: 'team' })
    })
    const { sharing, dir } = await load(fetch)

    await expect(sharing.connect(TOKEN, null)).resolves.toEqual({
      status: {
        cloudflare: { accountId: ACCOUNT, subdomain: 'team', plainText: false },
        published: [],
      },
    })
    expect(calls.map(path)).toEqual(['/accounts', `/accounts/${ACCOUNT}/workers/subdomain`])
    expect(calls.some((call) => call.url.includes('/user/tokens/verify'))).toBe(false)

    await sharing.flush()
    const stored = await SharingStore.load(dir, cipher)
    expect(stored.account()).toMatchObject({ accountId: ACCOUNT, subdomain: 'team' })
    await expect(stored.token()).resolves.toBe(TOKEN)
  })

  it('answers with the accounts when several can be published to, keeping none', async () => {
    const { fetch } = server((call) => {
      if (path(call) === '/accounts') {
        return page([
          { id: ACCOUNT, name: 'Zulu' },
          { id: OTHER, name: 'Alpha' },
        ])
      }
      return ok({ subdomain: path(call).startsWith(`/accounts/${ACCOUNT}`) ? 'zulu' : 'alpha' })
    })
    const { sharing, dir } = await load(fetch)

    await expect(sharing.connect(TOKEN, null)).resolves.toEqual({
      accounts: [
        { id: OTHER, name: 'Alpha', subdomain: 'alpha' },
        { id: ACCOUNT, name: 'Zulu', subdomain: 'zulu' },
      ],
    })
    expect(sharing.status().cloudflare).toBeNull()
    await sharing.flush()
    const stored = await SharingStore.load(dir, cipher)
    expect(stored.account()).toBeNull()
  })

  it('reads only the chosen account and keeps it', async () => {
    const { fetch, calls } = server(() => ok({ subdomain: 'team' }))
    const { sharing, dir } = await load(fetch)

    await expect(sharing.connect(TOKEN, ACCOUNT)).resolves.toMatchObject({
      status: { cloudflare: { accountId: ACCOUNT, subdomain: 'team', plainText: false } },
    })
    expect(calls.map(path)).toEqual([`/accounts/${ACCOUNT}/workers/subdomain`])

    await sharing.flush()
    const stored = await SharingStore.load(dir, cipher)
    expect(stored.account()).toMatchObject({ accountId: ACCOUNT, subdomain: 'team' })
  })

  it('is invalid_token when the token reaches no account', async () => {
    const { fetch } = server(() => page([]))
    const { sharing } = await load(fetch)

    await expect(sharing.connect(TOKEN, null)).resolves.toEqual({
      failed: 'invalid_token',
      message: 'The token reaches no account it can publish to.',
    })
  })

  it('is no_subdomain when the only account has none', async () => {
    const { fetch } = server((call) => {
      if (path(call) === '/accounts') return page([{ id: ACCOUNT, name: 'Team' }])
      return missing()
    })
    const { sharing } = await load(fetch)

    await expect(sharing.connect(TOKEN, null)).resolves.toMatchObject({ failed: 'no_subdomain' })
  })

  it('is no_subdomain for a chosen account without one', async () => {
    const { fetch } = server(() => missing())
    const { sharing } = await load(fetch)

    await expect(sharing.connect(TOKEN, ACCOUNT)).resolves.toMatchObject({
      failed: 'no_subdomain',
    })
  })

  it('is invalid_token when Cloudflare refuses the token', async () => {
    const { fetch } = server(() => refused())
    const { sharing } = await load(fetch)

    await expect(sharing.connect(TOKEN, ACCOUNT)).resolves.toMatchObject({
      failed: 'invalid_token',
    })
  })

  it('fails a malformed token before any request', async () => {
    const { fetch, calls } = server(() => ok({}))
    const { sharing } = await load(fetch)

    await expect(sharing.connect('not a token', null)).resolves.toMatchObject({ failed: 'failed' })
    expect(calls).toEqual([])
  })

  it('fails a malformed account ID before any request', async () => {
    const { fetch, calls } = server(() => ok({}))
    const { sharing } = await load(fetch)

    await expect(sharing.connect(TOKEN, 'nope')).resolves.toMatchObject({ failed: 'failed' })
    expect(calls).toEqual([])
  })

  it('fails before any request when the system cannot encrypt the token', async () => {
    const { fetch, calls } = server(() => ok({}))
    const { sharing } = await load(fetch, { encryptionAvailable: async () => false })

    await expect(sharing.connect(TOKEN, null)).resolves.toMatchObject({ failed: 'encryption' })
    expect(calls).toEqual([])
  })
})
