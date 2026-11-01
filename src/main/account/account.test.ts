import { readFile, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccountStatus } from '@shared/account'
import type { Locale } from '@shared/locale'
import { tempFolder } from '../../agent-host/testing/temp'
import type { IdentityCipher } from '../remote-identity'
import { Account, type AccountOptions } from '.'
import { AccountApi } from './service'
import { accountFile } from './store'
import { startFakeAccountService, type FakeAccountService } from './testing/fake-service'

/** The system's encryption, as a prefix the test can see. */
const CIPHER: IdentityCipher = {
  available: async () => true,
  encrypt: async (text) => Buffer.from(`sealed:${text}`),
  decrypt: async (encrypted) => ({
    result: encrypted.toString().replace(/^sealed:/, ''),
    shouldReEncrypt: false,
  }),
  plainText: () => false,
}

const QUIET = { info: () => {}, warn: () => {}, error: () => {} }

let service: FakeAccountService

beforeEach(async () => {
  service = await startFakeAccountService()
})

afterEach(async () => {
  await service.close()
})

type SetupOptions = Omit<Partial<AccountOptions>, 'locale'> & { locale?: Locale; dir?: string }

async function setup({ locale = 'en', dir: given, ...options }: SetupOptions = {}) {
  const dir = given ?? (await tempFolder('kettu-account-'))
  const clock = { now: Date.now() }
  const browser: string[] = []
  const statuses: AccountStatus[] = []
  let fronted = 0
  const account = await Account.load({
    file: accountFile(dir),
    api: new AccountApi(
      service.base,
      (url, init) => fetch(url, init),
      () => clock.now,
    ),
    cipher: CIPHER,
    clientInfo: async () => ({
      kind: 'desktop',
      name: 'Ada’s MacBook',
      os: 'macOS 26.1',
      arch: 'arm64',
      version: '0.3.0',
    }),
    openBrowser: async (url) => void browser.push(url),
    bringToFront: () => void fronted++,
    avatar: async () => null,
    failureText: () => 'Kettu could not finish signing in.',
    changed: (status) => void statuses.push(status),
    log: QUIET,
    now: () => clock.now,
    locale: () => locale,
    ...options,
  })
  return { account, dir, clock, browser, statuses, fronted: () => fronted }
}

async function until(check: () => boolean): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 3000) throw new Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The browser after the user continued on the sign-in page: it goes to the app's redirect. */
function continueInBrowser(signInUrl: string): Promise<Response> {
  return fetch(service.authorize(signInUrl), { redirect: 'manual' })
}

async function signedIn(options: Parameters<typeof setup>[0] = {}) {
  const run = await setup(options)
  await run.account.signIn()
  await continueInBrowser(run.browser.at(-1)!)
  await until(() => run.account.status().state === 'signed-in')
  return run
}

describe('Account sign-in', () => {
  it('signs in through the browser with PKCE and a loopback redirect', async () => {
    const { account, browser, statuses, fronted, dir } = await setup()
    expect(await account.signIn()).toEqual({ state: 'signing-in' })
    const url = new URL(browser[0]!)
    expect(`${url.origin}${url.pathname}`).toBe(`${service.base}/signin/app/`)
    const params = url.searchParams
    expect(params.get('client_id')).toBe('kettu-desktop')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(params.get('state')!.length).toBeGreaterThanOrEqual(32)
    expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(JSON.parse(params.get('client_info')!)).toEqual({
      kind: 'desktop',
      name: 'Ada’s MacBook',
      os: 'macOS 26.1',
      arch: 'arm64',
      version: '0.3.0',
    })

    const answer = await continueInBrowser(browser[0]!)
    expect(answer.status).toBe(302)
    expect(answer.headers.get('location')).toBe(`${service.base}/signin/app/?done=1`)
    expect(answer.headers.get('referrer-policy')).toBe('no-referrer')
    await until(() => account.status().state === 'signed-in')
    expect(account.status()).toEqual({
      state: 'signed-in',
      account: { id: 'acc_1', email: 'ada@example.com', name: 'Ada Lovelace', avatar: null },
      subscription: 'none',
      manageUrl: `${service.base}/account/`,
      plainText: false,
    })
    expect(statuses.map((status) => status.state)).toEqual(['signing-in', 'signed-in'])
    expect(fronted()).toBe(1)
    // The port closes once the browser has its answer.
    await expect(fetch(params.get('redirect_uri')!)).rejects.toThrow()

    const file = accountFile(dir)
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(stored.encrypted).toBe(true)
    expect(Buffer.from(stored.token as string, 'base64').toString()).toMatch(/^sealed:/)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('opens the Chinese pages when the app is in Chinese', async () => {
    const { account, browser } = await setup({ locale: 'zh-CN' })
    await account.signIn()
    expect(new URL(browser[0]!).pathname).toBe('/zh-CN/signin/app/')
    const answer = await continueInBrowser(browser[0]!)
    expect(answer.headers.get('location')).toBe(`${service.base}/zh-CN/signin/app/?done=1`)
    await until(() => account.status().state === 'signed-in')
    expect(account.status()).toMatchObject({ manageUrl: `${service.base}/zh-CN/account/` })
  })

  it('refuses a callback with another state and keeps waiting', async () => {
    const { account, browser } = await setup()
    await account.signIn()
    const redirect = new URL(browser[0]!).searchParams.get('redirect_uri')!
    const forged = await fetch(`${redirect}?code=stolen&state=guessed`, { redirect: 'manual' })
    expect(forged.status).toBe(400)
    expect(account.status()).toEqual({ state: 'signing-in' })
    expect(service.requests).not.toContain('POST /api/oauth/token')

    await continueInBrowser(browser[0]!)
    await until(() => account.status().state === 'signed-in')
  })

  it('sends the browser back to the cancelled page when the user cancels there', async () => {
    const { account, browser, fronted } = await setup()
    await account.signIn()
    const params = new URL(browser[0]!).searchParams
    const answer = await fetch(
      `${params.get('redirect_uri')}?error=access_denied&state=${params.get('state')}`,
      { redirect: 'manual' },
    )
    expect(answer.status).toBe(302)
    expect(answer.headers.get('location')).toBe(`${service.base}/signin/app/?cancelled=1`)
    await until(() => account.status().state === 'signed-out')
    expect(account.status()).toEqual({ state: 'signed-out', reason: null, failure: null })
    expect(fronted()).toBe(1)
  })

  it('stops waiting after the timeout and closes the port', async () => {
    const { account, browser } = await setup({ timeoutMs: 50 })
    await account.signIn()
    await until(() => account.status().state === 'signed-out')
    expect(account.status()).toEqual({ state: 'signed-out', reason: null, failure: 'timeout' })
    const redirect = new URL(browser[0]!).searchParams.get('redirect_uri')!
    await expect(fetch(redirect)).rejects.toThrow()
  })

  it('closes the port on Cancel', async () => {
    const { account, browser } = await setup()
    await account.signIn()
    account.cancelSignIn()
    expect(account.status()).toEqual({ state: 'signed-out', reason: null, failure: null })
    const redirect = new URL(browser[0]!).searchParams.get('redirect_uri')!
    await expect(fetch(redirect)).rejects.toThrow()
  })

  it('says why in the app and the browser when the code cannot be exchanged', async () => {
    const { account, browser, dir } = await setup()
    await account.signIn()
    service.disabled = true
    const answer = await continueInBrowser(browser[0]!)
    expect(answer.status).toBe(502)
    expect(await answer.text()).toBe('Kettu could not finish signing in.')
    expect(account.status()).toEqual({ state: 'signed-out', reason: null, failure: 'disabled' })
    await expect(stat(accountFile(dir))).rejects.toThrow()
  })

  it('cannot open the sign-in page without a browser', async () => {
    const { account } = await setup({ openBrowser: () => Promise.reject(new Error('No browser')) })
    expect(await account.signIn()).toEqual({ state: 'signed-out', reason: null, failure: 'local' })
  })
})

describe('Account tokens', () => {
  it('refreshes the access token when the service refuses it, keeping the new refresh token', async () => {
    const { account } = await signedIn()
    service.expireAccessTokens()
    expect((await account.check()).state).toBe('signed-in')
    expect(service.refreshed).toHaveLength(1)

    // The token used next is the one the refresh gave, as the service rotates it on every use.
    service.expireAccessTokens()
    await account.check()
    expect(service.refreshed).toHaveLength(2)
    expect(service.refreshed[1]).not.toBe(service.refreshed[0])
    expect(service.families[0]!.revoked).toBeNull()
  })

  it('refreshes once for checks that need it at the same time', async () => {
    const { account } = await signedIn()
    service.expireAccessTokens()
    const results = await Promise.all([account.check(), account.check(), account.check()])
    expect(results.map((status) => status.state)).toEqual(['signed-in', 'signed-in', 'signed-in'])
    expect(service.refreshed).toHaveLength(1)
    expect(service.families[0]!.revoked).toBeNull()
  })

  it('refreshes an access token past its time before using it', async () => {
    const { account, clock } = await signedIn()
    const before = service.requests.length
    clock.now += 2 * 60 * 60_000
    await account.check()
    expect(service.requests.slice(before)).toEqual(['POST /api/oauth/token', 'GET /api/v1/me'])
  })

  it('stays signed in from its file after a restart, without the network', async () => {
    const { dir } = await signedIn()
    const before = service.requests.length
    const { account } = await setup({ dir })
    expect(account.status()).toMatchObject({
      state: 'signed-in',
      account: { email: 'ada@example.com' },
    })
    expect(service.requests).toHaveLength(before)
    expect((await account.check()).state).toBe('signed-in')
    expect(service.refreshed).toHaveLength(1)
  })

  it('takes up a changed name and subscription', async () => {
    const { account } = await signedIn()
    service.account = { ...service.account, name: 'Ada King' }
    service.subscription = 'active'
    expect(await account.check()).toMatchObject({
      account: { name: 'Ada King' },
      subscription: 'active',
    })
  })

  it.each([
    ['signed_out_from_account_page', 'account-page'],
    ['signed_out_by_admin', 'admin'],
    ['account_disabled', 'disabled'],
    ['refresh_token_reused', 'reused'],
    ['authorization_code_reused', 'reused'],
    ['expired', 'expired'],
    ['signed_out', 'invalid'],
  ])('signs out and says why when the service ended the sign-in with %s', async (reason, why) => {
    const { account, dir, statuses } = await signedIn()
    service.revokeAll(reason)
    expect(await account.check()).toEqual({ state: 'signed-out', reason: why, failure: null })
    expect(statuses.at(-1)).toEqual({ state: 'signed-out', reason: why, failure: null })
    await expect(stat(accountFile(dir))).rejects.toThrow()
  })

  it('signs out when the service no longer knows the sign-in, as after the account was deleted', async () => {
    const { account } = await signedIn()
    service.forgetAll()
    expect(await account.check()).toEqual({ state: 'signed-out', reason: 'invalid', failure: null })
  })

  it('signs out when the account is disabled', async () => {
    const { account } = await signedIn()
    service.disabled = true
    expect(await account.check()).toEqual({
      state: 'signed-out',
      reason: 'disabled',
      failure: null,
    })
  })

  it('stays signed in while the service cannot be reached', async () => {
    const { account } = await signedIn()
    await service.close()
    expect((await account.check()).state).toBe('signed-in')
  })
})

describe('Account sign-out', () => {
  it('revokes the refresh token and forgets the sign-in', async () => {
    const { account, dir } = await signedIn()
    const stored = JSON.parse(await readFile(accountFile(dir), 'utf8')) as { token: string }
    const token = Buffer.from(stored.token, 'base64')
      .toString()
      .replace(/^sealed:/, '')
    expect(await account.signOut()).toEqual({ state: 'signed-out', reason: null, failure: null })
    expect(service.revoked).toEqual([token])
    expect(service.families[0]!.revoked).toBe('signed_out')
    await expect(stat(accountFile(dir))).rejects.toThrow()
  })

  it('forgets the sign-in when the service cannot be reached', async () => {
    const { account, dir } = await signedIn()
    await service.close()
    expect((await account.signOut()).state).toBe('signed-out')
    await expect(stat(accountFile(dir))).rejects.toThrow()
  })
})
