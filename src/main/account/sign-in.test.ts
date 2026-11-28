import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../log'
import type { IdentityCipher } from '../remote-identity'
import { Account } from './index'
import { AccountApi, type AccountFetch } from './service'
import { accountFile } from './store'

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const plainCipher: IdentityCipher = {
  available: async () => false,
  encrypt: async (text) => Buffer.from(text),
  decrypt: async (encrypted) => ({ result: encrypted.toString(), shouldReEncrypt: false }),
  plainText: () => true,
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Account.signIn', () => {
  let dir: string
  let file: string
  let cloud: boolean
  let openBrowser: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
  let fetchMock: ReturnType<typeof vi.fn<AccountFetch>>
  let statuses: ReturnType<Account['status']>[]
  let accounts: Account[]

  const load = async (): Promise<Account> => {
    const account = await Account.load({
      file,
      api: new AccountApi('https://www.kettu.sh', fetchMock),
      cipher: plainCipher,
      clientInfo: async () => ({
        kind: 'desktop',
        name: 'Test',
        os: 'test',
        arch: 'x64',
        version: '1.0.0',
      }),
      locale: () => 'en',
      openBrowser,
      bringToFront: () => {},
      avatar: async () => null,
      failureText: () => 'Failed',
      cloud: () => cloud,
      changed: (status) => {
        statuses.push(status)
      },
      log: silent,
    })
    accounts.push(account)
    return account
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kettu-signin-'))
    file = accountFile(dir)
    cloud = true
    statuses = []
    accounts = []
    openBrowser = vi.fn(async () => {})
    fetchMock = vi.fn<AccountFetch>(async (url) => {
      switch (new URL(url).pathname) {
        case '/api/oauth/token':
          return json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 })
        case '/api/v1/me':
          return json({
            account: { id: 'acct-1', email: 'me@example.com', name: 'Me', avatarUrl: null },
            subscription: { status: 'active' },
          })
        default:
          return new Response(null, { status: 200 })
      }
    })
  })

  afterEach(async () => {
    for (const account of accounts) account.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('reopens the pending sign-in URL in the browser when called again while signing-in', async () => {
    const account = await load()

    const first = await account.signIn()
    expect(first.state).toBe('signing-in')
    expect(openBrowser).toHaveBeenCalledTimes(1)
    const firstUrl = openBrowser.mock.calls[0]![0]

    const second = await account.signIn()
    expect(second.state).toBe('signing-in')
    expect(openBrowser).toHaveBeenCalledTimes(2)
    expect(openBrowser.mock.calls[1]![0]).toBe(firstUrl)

    // The original loopback callback still completes the sign-in.
    const parsed = new URL(firstUrl)
    const redirectUri = parsed.searchParams.get('redirect_uri')!
    const state = parsed.searchParams.get('state')!
    const response = await fetch(`${redirectUri}?code=auth-code-1&state=${state}`, {
      redirect: 'manual',
    })
    expect(response.status).toBe(302)
    await vi.waitFor(() => {
      expect(account.status().state).toBe('signed-in')
    })
  })

  it('does not open the browser twice while the first openBrowser call is still in flight', async () => {
    const gate = deferred()
    openBrowser.mockImplementation(() => gate.promise)
    const account = await load()

    const first = account.signIn()
    await vi.waitFor(() => {
      expect(openBrowser).toHaveBeenCalledTimes(1)
    })
    const second = await account.signIn()
    expect(second.state).toBe('signing-in')
    expect(openBrowser).toHaveBeenCalledTimes(1)

    gate.resolve()
    expect((await first).state).toBe('signing-in')
  })

  it('reports local failure and clears signing-in if reopening the browser fails', async () => {
    openBrowser.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('no browser'))
    const account = await load()

    expect((await account.signIn()).state).toBe('signing-in')
    const failed = await account.signIn()
    expect(failed).toEqual({ state: 'signed-out', reason: null, failure: 'local' })
    expect(account.status()).toEqual({ state: 'signed-out', reason: null, failure: 'local' })
  })

  it('does not reopen the browser once the callback is already exchanging the code', async () => {
    const tokenGate = deferred<Response>()
    fetchMock.mockImplementation(async (url) => {
      if (new URL(url).pathname === '/api/oauth/token') return tokenGate.promise
      return json({
        account: { id: 'acct-1', email: 'me@example.com', name: 'Me', avatarUrl: null },
        subscription: { status: 'active' },
      })
    })
    const account = await load()
    await account.signIn()
    const firstUrl = openBrowser.mock.calls[0]![0]
    const parsed = new URL(firstUrl)
    const redirectUri = parsed.searchParams.get('redirect_uri')!
    const state = parsed.searchParams.get('state')!

    const callbackPromise = fetch(`${redirectUri}?code=auth-code-1&state=${state}`, {
      redirect: 'manual',
    })
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    // While exchanging the authorization code, another signIn() does not re-launch the browser.
    await account.signIn()
    expect(openBrowser).toHaveBeenCalledTimes(1)

    tokenGate.resolve(
      json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
    )
    const response = await callbackPromise
    expect(response.status).toBe(302)
    await vi.waitFor(() => {
      expect(account.status().state).toBe('signed-in')
    })
  })
})
