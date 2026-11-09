import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  browserLogin,
  deviceLogin,
  isCancelled,
  parseSignIn,
  probe,
  renew,
  type SignIn,
} from './oauth'

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

/** A fetch that answers from handlers by method and address, as the services would. */
function fakeFetch(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; body: string }[] = []
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const body =
      init.body instanceof URLSearchParams ? init.body.toString() : String(init.body ?? '')
    calls.push({ method, url: url.href, body })
    const key = `${method} ${url.origin}${url.pathname}`
    const handler = routes[key]
    if (!handler) return new Response('not found', { status: 404 })
    return handler(url, init)
  }) as typeof fetch
  return { fetcher, calls }
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const MCP = 'https://mcp.example.com/mcp'
const AS = 'https://auth.example.com'
const PRM = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'

function authorizationServer(options: { pkce?: boolean } = {}) {
  const seen = {
    registration: null as Record<string, unknown> | null,
    challenge: '',
    tokens: [] as URLSearchParams[],
  }
  const { fetcher, calls } = fakeFetch({
    [`POST ${MCP}`]: () =>
      new Response('', {
        status: 401,
        headers: { 'WWW-Authenticate': `Bearer resource_metadata="${PRM}", scope="read"` },
      }),
    [`GET ${PRM}`]: () =>
      json({ resource: MCP, authorization_servers: [AS], scopes_supported: ['read', 'write'] }),
    [`GET ${AS}/.well-known/oauth-authorization-server`]: () =>
      json({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        registration_endpoint: `${AS}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(options.pkce === false ? {} : { code_challenge_methods_supported: ['S256'] }),
      }),
    [`POST ${AS}/register`]: (_, init) => {
      seen.registration = JSON.parse(String(init.body)) as Record<string, unknown>
      return json({ ...seen.registration, client_id: 'kettu-client' }, 201)
    },
    [`POST ${AS}/token`]: (_, init) => {
      const form = new URLSearchParams(String(init.body))
      seen.tokens.push(form)
      if (form.get('grant_type') === 'refresh_token') {
        return form.get('refresh_token') === 'refresh-1'
          ? json({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600 })
          : json({ error: 'invalid_grant' }, 400)
      }
      const verifier = form.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (form.get('code') !== 'the-code' || challenge !== seen.challenge) {
        return json({ error: 'invalid_grant' }, 400)
      }
      return json({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    },
  })
  return { fetcher, calls, seen }
}

describe('probe', () => {
  it('tells a server that needs a sign-in, with where its metadata is', async () => {
    const { fetcher } = authorizationServer()
    const asked = await probe(MCP, {}, fetcher)
    expect(asked).toEqual({ kind: 'oauth', resourceMetadataUrl: new URL(PRM), scope: 'read' })
  })

  it('tells one that answers without a sign-in, and ends the session it started', async () => {
    const { fetcher, calls } = fakeFetch({
      [`POST ${MCP}`]: () =>
        json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'Mcp-Session-Id': 's1' }),
      [`DELETE ${MCP}`]: () => new Response(null, { status: 204 }),
    })
    expect(await probe(MCP, { 'X-Read-Only': 'true' }, fetcher)).toEqual({ kind: 'open' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE'])
  })
})

describe('browserLogin', () => {
  it('discovers, registers Kettu, and exchanges the code with PKCE for the resource', async () => {
    const { fetcher, seen } = authorizationServer()
    const asked = await probe(MCP, {}, fetcher)
    if (asked.kind !== 'oauth') throw new Error('expected a sign-in')
    const login = await browserLogin({ url: MCP, probe: asked, fetch: fetcher, now: () => 1_000 })
    const page = new URL(login.url)
    expect(page.origin + page.pathname).toBe(`${AS}/authorize`)
    const redirect = page.searchParams.get('redirect_uri')!
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(Object.fromEntries(page.searchParams)).toMatchObject({
      client_id: 'kettu-client',
      code_challenge_method: 'S256',
      scope: 'read',
      resource: MCP,
    })
    expect(seen.registration).toMatchObject({
      client_name: 'Kettu',
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
    })
    seen.challenge = page.searchParams.get('code_challenge')!

    // Another page that knows the port but not the state proves nothing.
    const forged = await fetch(`${redirect}?code=the-code&state=guess`)
    expect(forged.status).toBe(400)
    const back = await fetch(`${redirect}?code=the-code&state=${page.searchParams.get('state')}`)
    expect(back.status).toBe(200)
    const sign = await login.done
    expect(sign).toMatchObject({
      kind: 'browser',
      url: MCP,
      issuer: AS,
      resource: MCP,
      client: { client_id: 'kettu-client' },
      tokens: { access: 'access-1', refresh: 'refresh-1', expiresAt: 1_000 + 3600_000 },
    })
    expect(seen.tokens[0]!.get('resource')).toBe(MCP)
    // The listener is gone with the sign-in.
    await expect(fetch(`${redirect}?code=x&state=y`)).rejects.toThrow()
  })

  it('refuses an authorization server that does not offer S256', async () => {
    const { fetcher } = authorizationServer({ pkce: false })
    await expect(
      browserLogin({ url: MCP, probe: { kind: 'oauth' }, fetch: fetcher, now: () => 0 }),
    ).rejects.toThrow(/S256/)
  })

  it('gives up after its limit, and ends at once when cancelled', async () => {
    const { fetcher } = authorizationServer()
    const late = await browserLogin({
      url: MCP,
      probe: { kind: 'oauth' },
      fetch: fetcher,
      now: () => 0,
      timeoutMs: 20,
    })
    await expect(late.done).rejects.toThrow(/five minutes/)
    const cancelled = await browserLogin({
      url: MCP,
      probe: { kind: 'oauth' },
      fetch: fetcher,
      now: () => 0,
    })
    cancelled.cancel()
    const error = await cancelled.done.catch((reason: unknown) => reason)
    expect(isCancelled(error)).toBe(true)
  })
})

describe('renew', () => {
  const sign: SignIn = {
    v: 1,
    url: MCP,
    savedAt: 1,
    kind: 'browser',
    account: null,
    issuer: AS,
    resource: MCP,
    client: { client_id: 'kettu-client' },
    tokens: { access: 'access-1', refresh: 'refresh-1', type: 'Bearer', expiresAt: 10 },
  }

  it('renews with the refresh token, keeping it when the service sends none', async () => {
    const { fetcher, seen } = authorizationServer()
    const next = await renew(sign, fetcher, () => 5_000)
    expect(next.tokens).toEqual({
      access: 'access-2',
      refresh: 'refresh-1',
      type: 'Bearer',
      expiresAt: 5_000 + 3600_000,
    })
    expect(seen.tokens[0]!.get('client_id')).toBe('kettu-client')
    expect(seen.tokens[0]!.get('resource')).toBe(MCP)
  })

  it('fails when the service refuses or there is nothing to renew with', async () => {
    const { fetcher } = authorizationServer()
    await expect(
      renew({ ...sign, tokens: { ...sign.tokens!, refresh: 'stale' } }, fetcher, () => 0),
    ).rejects.toThrow()
    await expect(
      renew({ ...sign, tokens: { access: 'a', type: 'Bearer' } }, fetcher, () => 0),
    ).rejects.toThrow(/cannot be renewed/)
  })
})

describe('deviceLogin', () => {
  const GITHUB_MCP = 'https://api.githubcopilot.com/mcp/'

  function github(answers: Record<string, unknown>[]) {
    const polls: URLSearchParams[] = []
    const { fetcher, calls } = fakeFetch({
      'GET https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp': () =>
        json({
          resource: GITHUB_MCP,
          authorization_servers: ['https://github.com/login/oauth'],
          scopes_supported: ['repo', 'read:org'],
        }),
      'GET https://github.com/.well-known/oauth-authorization-server/login/oauth': () =>
        json({
          issuer: 'https://github.com/login/oauth',
          authorization_endpoint: 'https://github.com/login/oauth/authorize',
          token_endpoint: 'https://github.com/login/oauth/access_token',
          device_authorization_endpoint: 'https://github.com/login/device/code',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        }),
      'POST https://github.com/login/device/code': () =>
        json({
          device_code: 'device-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
      'POST https://github.com/login/oauth/access_token': (_, init) => {
        polls.push(new URLSearchParams(String(init.body)))
        return json(answers.shift() ?? { error: 'expired_token' })
      },
      'GET https://api.github.com/user': (_, init) =>
        new Headers(init.headers).get('authorization') === 'Bearer gho_token'
          ? json({ login: 'octocat' })
          : json({}, 401),
    })
    return { fetcher, calls, polls }
  }

  it('shows the code, polls through pending and slow_down, then names the account', async () => {
    const { fetcher, calls, polls } = github([
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: 'gho_token', token_type: 'bearer', scope: 'repo,read:org' },
    ])
    const waits: number[] = []
    const login = await deviceLogin({
      url: GITHUB_MCP,
      fetch: fetcher,
      now: () => 1_000,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(login).toMatchObject({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresAt: 1_000 + 900_000,
    })
    const started = calls.find((call) => call.url === 'https://github.com/login/device/code')!
    expect(new URLSearchParams(started.body).get('client_id')).toBe('Ov23liLvsqnYGSdgcs3U')
    expect(new URLSearchParams(started.body).get('scope')).toBe('repo read:org')
    const sign = await login.done
    expect(waits).toEqual([5_000, 5_000, 10_000])
    expect(polls[0]!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(sign).toMatchObject({
      kind: 'device',
      account: 'octocat',
      issuer: 'https://github.com/login/oauth',
      client: { client_id: 'Ov23liLvsqnYGSdgcs3U' },
      tokens: { access: 'gho_token', type: 'bearer' },
    })
    // GitHub's tokens of this app do not expire.
    expect(sign.tokens).not.toHaveProperty('expiresAt')
  })

  it('ends on an expired code, a denial, or a cancel', async () => {
    const sleep = async () => {}
    const expired = await deviceLogin({
      url: GITHUB_MCP,
      fetch: github([{ error: 'expired_token' }]).fetcher,
      now: () => 0,
      sleep,
    })
    await expect(expired.done).rejects.toThrow(/expired/)
    const denied = await deviceLogin({
      url: GITHUB_MCP,
      fetch: github([{ error: 'access_denied' }]).fetcher,
      now: () => 0,
      sleep,
    })
    await expect(denied.done).rejects.toThrow(/denied/)
    const cancelled = await deviceLogin({
      url: GITHUB_MCP,
      fetch: github([{ error: 'authorization_pending' }]).fetcher,
      now: () => 0,
      sleep,
    })
    cancelled.cancel()
    expect(isCancelled(await cancelled.done.catch((error: unknown) => error))).toBe(true)
  })

  it('refuses a service Kettu has no app with', async () => {
    const { fetcher } = fakeFetch({
      [`GET ${PRM}`]: () => json({ resource: MCP, authorization_servers: [AS] }),
    })
    await expect(deviceLogin({ url: MCP, fetch: fetcher, now: () => 0 })).rejects.toThrow(
      /no app registered/,
    )
  })
})

describe('parseSignIn', () => {
  it('reads back what the host kept and refuses anything else', () => {
    const sign: SignIn = {
      v: 1,
      url: MCP,
      savedAt: 3,
      kind: 'device',
      account: 'octocat',
      issuer: 'https://github.com/login/oauth',
      client: { client_id: 'Ov23liLvsqnYGSdgcs3U' },
      tokens: { access: 'gho_token', type: 'bearer' },
    }
    expect(parseSignIn(JSON.stringify(sign))).toEqual(sign)
    expect(parseSignIn(JSON.stringify({ ...sign, tokens: undefined }))).toBeNull()
    expect(
      parseSignIn(JSON.stringify({ v: 1, url: MCP, savedAt: 1, kind: 'open', account: null })),
    ).toEqual({ v: 1, url: MCP, savedAt: 1, kind: 'open', account: null })
    expect(parseSignIn('{"v":2}')).toBeNull()
    expect(parseSignIn('not json')).toBeNull()
  })
})
