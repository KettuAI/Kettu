import { describe, expect, it, vi } from 'vitest'
import { AccountServiceError, WEB_CLIENT, type Me, type TokenSet } from '@shared/account-api'
import { CALLBACK_PATH, challengeOf, HostedAccount, type AccountEnv } from './account'

const ORIGIN = 'https://app.kettu.sh'
const SITE = 'https://www.kettu.sh'

const ME: Me = {
  account: { id: 'acct_1', email: 'ada@example.com', name: 'Ada', avatarUrl: '/api/v1/avatars/a' },
  subscription: 'none',
  plan: null,
  usage: null,
}

interface Shared {
  record: unknown
  /** The tabs' one lock, a chain of what holds it. */
  held: Promise<unknown>
}

function tab(
  shared: Shared,
  api: AccountEnv['api'],
  at: string,
): { account: HostedAccount; session: Map<string, string>; assigned: string[] } {
  const session = new Map<string, string>()
  const assigned: string[] = []
  const url = new URL(at, ORIGIN)
  const env: AccountEnv = {
    api,
    record: {
      get: async () => shared.record,
      put: async (value) => {
        shared.record = structuredClone(value)
      },
      remove: async () => {
        shared.record = undefined
      },
    },
    session: {
      getItem: (key) => session.get(key) ?? null,
      setItem: (key, value) => void session.set(key, value),
      removeItem: (key) => void session.delete(key),
    },
    lock: (work) => {
      const run = shared.held.then(work, work)
      shared.held = run.catch(() => undefined)
      return run
    },
    page: {
      origin: ORIGIN,
      pathname: url.pathname,
      href: url.href,
      assign: (to) => assigned.push(to),
    },
    broadcast: () => {},
    changed: () => {},
  }
  const account = new HostedAccount({
    accountUrl: SITE,
    client: { name: 'Safari · iPhone', os: 'iPhone', version: '1.0.0' },
    locale: () => 'en',
    env,
  })
  return { account, session, assigned }
}

function tokens(n: number): TokenSet {
  return { accessToken: `a${n}`, refreshToken: `r${n}`, accessExpiresAt: Date.now() + 3_600_000 }
}

function api(overrides: Partial<AccountEnv['api']> = {}): AccountEnv['api'] {
  return {
    exchangeCode: vi.fn(async () => tokens(1)),
    refresh: vi.fn(async () => tokens(2)),
    revoke: vi.fn(async () => {}),
    me: vi.fn(async () => ME),
    ...overrides,
  }
}

const SIGNED_IN = {
  refreshToken: 'r1',
  profile: { id: 'acct_1', email: 'ada@example.com', name: 'Ada', avatarUrl: null },
  subscription: 'none',
  plan: null,
  usage: null,
}

describe('PKCE', () => {
  it('derives the S256 challenge of RFC 7636', async () => {
    expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })
})

describe('HostedAccount sign-in', () => {
  it('sends the browser to the app sign-in page as kettu-web, with the challenge of what it keeps', async () => {
    const shared: Shared = { record: undefined, held: Promise.resolve() }
    const { account, session, assigned } = tab(shared, api(), '/pair')
    await account.load()
    await account.signIn('/pair#code')
    const url = new URL(assigned[0]!)
    expect(`${url.origin}${url.pathname}`).toBe(`${SITE}/signin/app/`)
    const pending = JSON.parse([...session.values()][0]!) as Record<string, string>
    expect(pending.back).toBe('/pair#code')
    expect(url.searchParams.get('client_id')).toBe(WEB_CLIENT)
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${CALLBACK_PATH}`)
    expect(url.searchParams.get('state')).toBe(pending.state)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(await challengeOf(pending.verifier!))
    expect(JSON.parse(url.searchParams.get('client_info')!)).toMatchObject({ kind: 'web' })
  })

  it('never sends the browser back to another site', async () => {
    const shared: Shared = { record: undefined, held: Promise.resolve() }
    const { account, session } = tab(shared, api(), '/')
    await account.signIn('//evil.example/x')
    expect(JSON.parse([...session.values()][0]!).back).toBe('/')
  })

  it('takes the code only with the state it sent, and keeps the refresh token', async () => {
    const shared: Shared = { record: undefined, held: Promise.resolve() }
    const service = api()
    const first = tab(shared, service, '/')
    await first.account.signIn('/pair#code')
    const pending = JSON.parse([...first.session.values()][0]!) as Record<string, string>

    const forged = tab(shared, service, `${CALLBACK_PATH}?code=c1&state=other`)
    for (const [key, value] of first.session) forged.session.set(key, value)
    await forged.account.load()
    expect(service.exchangeCode).not.toHaveBeenCalled()
    expect(forged.account.status().state).toBe('signed-out')

    const back = tab(shared, service, `${CALLBACK_PATH}?code=c1&state=${pending.state}`)
    for (const [key, value] of first.session) back.session.set(key, value)
    expect(await back.account.load()).toBe('/pair#code')
    expect(service.exchangeCode).toHaveBeenCalledWith({
      code: 'c1',
      redirectUri: `${ORIGIN}${CALLBACK_PATH}`,
      verifier: pending.verifier,
      clientId: WEB_CLIENT,
    })
    expect(back.account.status()).toMatchObject({
      state: 'signed-in',
      account: { email: 'ada@example.com', avatar: `${SITE}/api/v1/avatars/a` },
    })
    expect(shared.record).toMatchObject({ refreshToken: 'r1' })
    // The code is spent with its state.
    expect(back.session.size).toBe(0)
  })

  it('reads a devices-full stop on the website as that failure', async () => {
    const shared: Shared = { record: undefined, held: Promise.resolve() }
    const first = tab(shared, api(), '/')
    await first.account.signIn('/')
    const pending = JSON.parse([...first.session.values()][0]!) as Record<string, string>
    const back = tab(shared, api(), `${CALLBACK_PATH}?error=device_limit&state=${pending.state}`)
    for (const [key, value] of first.session) back.session.set(key, value)
    await back.account.load()
    expect(back.account.status()).toMatchObject({
      state: 'signed-out',
      failure: 'device-limit',
      devicesUrl: `${SITE}/account/devices/`,
    })
  })
})

describe('HostedAccount refresh', () => {
  it('lets two tabs refresh in turn, never with the same refresh token twice', async () => {
    const shared: Shared = { record: structuredClone(SIGNED_IN), held: Promise.resolve() }
    const used = new Set<string>()
    let n = 1
    const refresh = vi.fn(async (_client: string, token: string) => {
      if (used.has(token))
        throw new AccountServiceError('invalid_grant', 'reused', 400, 'refresh_token_reused')
      used.add(token)
      // The answer takes a moment, so a tab that did not wait would read the old token meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 5))
      return tokens(++n)
    })
    const one = tab(shared, api({ refresh }), '/')
    const two = tab(shared, api({ refresh }), '/')
    await Promise.all([one.account.load(), two.account.load()])
    const [a, b] = await Promise.all([one.account.accessToken(), two.account.accessToken()])
    expect([a, b].sort()).toEqual(['a2', 'a3'])
    expect(refresh.mock.calls.map(([, token]) => token)).toEqual(['r1', 'r2'])
    expect(shared.record).toMatchObject({ refreshToken: 'r3' })
    expect(one.account.status().state).toBe('signed-in')
    expect(two.account.status().state).toBe('signed-in')
  })

  it('signs out with the reason when the service ended the sign-in', async () => {
    const shared: Shared = { record: structuredClone(SIGNED_IN), held: Promise.resolve() }
    const refresh = vi.fn(async () => {
      throw new AccountServiceError('invalid_grant', 'ended', 400, 'signed_out_from_account_page')
    })
    const { account } = tab(shared, api({ refresh }), '/')
    await account.load()
    expect(await account.accessToken()).toBeNull()
    expect(account.status()).toMatchObject({ state: 'signed-out', reason: 'account-page' })
    expect(shared.record).toBeUndefined()
  })

  it('learns from a refused access token that the sign-in was ended, and why', async () => {
    const shared: Shared = { record: structuredClone(SIGNED_IN), held: Promise.resolve() }
    let refreshed = 0
    const service = api({
      me: vi.fn(async () => {
        throw new AccountServiceError('unauthorized', 'revoked', 401)
      }),
      refresh: vi.fn(async () => {
        if (refreshed++ === 0) return tokens(2)
        throw new AccountServiceError('invalid_grant', 'ended', 400, 'signed_out_from_account_page')
      }),
    })
    const { account } = tab(shared, service, '/')
    await account.load()
    expect(await account.check()).toMatchObject({ state: 'signed-out', reason: 'account-page' })
    expect(shared.record).toBeUndefined()
  })

  it('keeps the sign-in when the service cannot be reached', async () => {
    const shared: Shared = { record: structuredClone(SIGNED_IN), held: Promise.resolve() }
    const refresh = vi.fn(async () => {
      throw new Error('offline')
    })
    const { account } = tab(shared, api({ refresh }), '/')
    await account.load()
    expect(await account.accessToken()).toBeNull()
    expect(account.status().state).toBe('signed-in')
    expect(shared.record).toMatchObject({ refreshToken: 'r1' })
  })

  it('revokes the newest refresh token on sign-out', async () => {
    const shared: Shared = { record: structuredClone(SIGNED_IN), held: Promise.resolve() }
    const service = api()
    const one = tab(shared, service, '/')
    await one.account.load()
    // Another tab refreshed meanwhile.
    shared.record = { ...SIGNED_IN, refreshToken: 'r9' }
    await one.account.signOut()
    expect(service.revoke).toHaveBeenCalledWith(WEB_CLIENT, 'r9')
    expect(shared.record).toBeUndefined()
  })
})
