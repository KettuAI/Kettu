import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../log'
import type { IdentityCipher } from '../remote-identity'
import { Account, NotSignedIn } from './index'
import { AccountApi, type AccountFetch } from './service'
import { accountFile, readAccount, writeAccount } from './store'

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const plainCipher: IdentityCipher = {
  available: async () => false,
  encrypt: async (text) => Buffer.from(text),
  decrypt: async (encrypted) => ({ result: encrypted.toString(), shouldReEncrypt: false }),
  plainText: () => true,
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

/** The account service as far as these tests reach it. */
function service() {
  return vi.fn<AccountFetch>(async (url) => {
    switch (new URL(url).pathname) {
      case '/api/oauth/token':
        return json({ access_token: 'access-1', refresh_token: 'refresh-2', expires_in: 3600 })
      case '/api/v1/me':
        return json({
          account: { id: 'acct-1', email: 'me@example.com', name: null, avatarUrl: null },
          subscription: { status: 'active' },
        })
      case '/api/v1/reports':
        return json({ id: 'KR-7F3K2Q' })
      default:
        return new Response(null, { status: 200 })
    }
  })
}

describe("the Kettu account with Kettu's services off", () => {
  let dir: string
  let file: string
  let cloud: boolean
  let fetch: ReturnType<typeof service>
  let openBrowser: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
  let avatar: ReturnType<typeof vi.fn<(url: string) => Promise<string | null>>>

  const load = (): Promise<Account> =>
    Account.load({
      file,
      api: new AccountApi('https://www.kettu.sh', fetch),
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
      avatar,
      failureText: () => 'Failed',
      cloud: () => cloud,
      changed: () => {},
      log: silent,
    })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kettu-account-'))
    file = accountFile(dir)
    cloud = true
    fetch = service()
    openBrowser = vi.fn(async () => {})
    avatar = vi.fn(async () => null)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function signedIn(): Promise<Account> {
    await writeAccount(file, {
      profile: {
        id: 'acct-1',
        email: 'me@example.com',
        name: null,
        avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      },
      subscription: 'active',
      token: 'refresh-1',
      encrypted: false,
      plainText: true,
    })
    const account = await load()
    // An access token held from while the services were on.
    expect((await account.currentToken())?.token).toBe('access-1')
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockClear()
    return account
  }

  it('sends no request and hands out no token it holds', async () => {
    const account = await signedIn()
    cloud = false

    expect(await account.currentToken()).toBeNull()
    const call = vi.fn(async (token: string) => token)
    await expect(account.withAccessToken(call, () => true)).rejects.toBeInstanceOf(NotSignedIn)
    expect(call).not.toHaveBeenCalled()
    await account.check()
    const upload = { bundle: new Uint8Array(4), description: 'x', version: '1.0.0', platform: 'x' }
    expect(await account.submitReport(upload)).toEqual({ ok: false, reason: 'signed_out' })

    expect(fetch).not.toHaveBeenCalled()
    expect(avatar).not.toHaveBeenCalled()
  })

  it('signs out here alone, without asking the service', async () => {
    const account = await signedIn()
    cloud = false

    expect((await account.signOut()).state).toBe('signed-out')
    expect(fetch).not.toHaveBeenCalled()
    expect(await readAccount(file, () => {})).toBeNull()
  })

  it('opens no browser to sign in', async () => {
    const account = await load()
    cloud = false

    expect((await account.signIn()).state).toBe('signed-out')
    expect(openBrowser).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
