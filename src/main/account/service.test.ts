import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_URL,
  AccountApi,
  accountBaseUrl,
  AccountNetworkError,
  AccountServiceError,
  clientInfo,
  newPkce,
} from './service'

function answering(status: number, body: unknown): AccountApi {
  return new AccountApi('https://kettu.test', async () =>
    Response.json(body, { status, headers: { 'content-type': 'application/json' } }),
  )
}

describe('accountBaseUrl', () => {
  it('is the project’s own service unless KETTU_ACCOUNT_URL names another', () => {
    expect(accountBaseUrl({})).toBe(ACCOUNT_URL)
    expect(accountBaseUrl({ KETTU_ACCOUNT_URL: ' ' })).toBe(ACCOUNT_URL)
    expect(accountBaseUrl({ KETTU_ACCOUNT_URL: 'http://localhost:4321/' })).toBe(
      'http://localhost:4321',
    )
  })

  it('refuses what is not an http or https URL', () => {
    expect(() => accountBaseUrl({ KETTU_ACCOUNT_URL: 'kettu.sh' })).toThrow(/KETTU_ACCOUNT_URL/)
    expect(() => accountBaseUrl({ KETTU_ACCOUNT_URL: 'file:///etc' })).toThrow(/KETTU_ACCOUNT_URL/)
  })
})

describe('newPkce', () => {
  it('makes a 43-character verifier and its S256 challenge', () => {
    const { verifier, challenge } = newPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(newPkce().verifier).not.toBe(verifier)
  })
})

describe('clientInfo', () => {
  it('cuts each field to what the service takes', () => {
    const info = clientInfo({
      kind: 'daemon',
      name: 'x'.repeat(120),
      os: ' Ubuntu 24.04.1 LTS ',
      arch: 'x64',
      version: null,
    })
    expect(info.name).toHaveLength(100)
    expect(info.os).toBe('Ubuntu 24.04.1 LTS')
  })
})

describe('AccountApi', () => {
  it('reads the reason of invalid_grant and the interval of slow_down', async () => {
    const grant = answering(400, {
      error: 'invalid_grant',
      error_description: 'This client was signed out from the account page.',
      reason: 'signed_out_from_account_page',
    })
    await expect(grant.refresh('kettu-desktop', 'r')).rejects.toMatchObject({
      code: 'invalid_grant',
      reason: 'signed_out_from_account_page',
    })
    const slow = answering(400, { error: 'slow_down', error_description: 'slower', interval: 10 })
    await expect(slow.pollDevice('d')).rejects.toMatchObject({ code: 'slow_down', interval: 10 })
  })

  it('tells an unreachable service from one that answered', async () => {
    const offline = new AccountApi('https://kettu.test', () =>
      Promise.reject(new TypeError('fetch failed')),
    )
    await expect(offline.me('a')).rejects.toBeInstanceOf(AccountNetworkError)
    const broken = new AccountApi(
      'https://kettu.test',
      async () => new Response('Bad gateway', { status: 502 }),
    )
    const error = await broken.me('a').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AccountServiceError)
    expect(error).toMatchObject({ code: 'server_error', status: 502 })
  })

  it('refuses an account it cannot read', async () => {
    await expect(answering(200, { account: { id: 'a' } }).me('a')).rejects.toMatchObject({
      code: 'server_error',
    })
  })

  it('sends the token request form-encoded, with the bearer token for the account', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const api = new AccountApi(
      'https://kettu.test',
      async (url, init) => {
        seen.push({ url, init })
        return Response.json(
          url.endsWith('/token')
            ? { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' }
            : {
                account: { id: 'acc', email: 'a@b.c', name: null, avatarUrl: null },
                subscription: { status: 'none' },
              },
        )
      },
      () => 1000,
    )
    expect(
      await api.exchangeCode({
        code: 'c',
        redirectUri: 'http://127.0.0.1:1/callback',
        verifier: 'v',
      }),
    ).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      accessExpiresAt: 1000 + 3540_000,
    })
    expect(seen[0]!.url).toBe('https://kettu.test/api/oauth/token')
    expect(Object.fromEntries(seen[0]!.init.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'kettu-desktop',
      code: 'c',
      redirect_uri: 'http://127.0.0.1:1/callback',
      code_verifier: 'v',
    })
    expect(await api.me('a')).toEqual({
      account: { id: 'acc', email: 'a@b.c', name: null, avatarUrl: null },
      subscription: 'none',
    })
    expect(seen[1]!.init.headers).toMatchObject({ authorization: 'Bearer a' })
  })
})
