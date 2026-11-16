import { describe, expect, it } from 'vitest'
import type { MarketConnection, MarketServer } from '@shared/marketplace'
import { MarketConnectionsService } from './connections'
import type { SignIn } from './oauth'

const MCP = 'https://mcp.example.com/mcp'
const AS = 'https://auth.example.com'

const server: MarketServer = {
  id: 'com.notion/mcp',
  name: 'notion',
  title: 'Notion',
  source: 'registry',
  version: '1.0.1',
  spec: {
    type: 'http',
    transport: 'streamable-http',
    url: MCP,
    headers: [],
    oauth: { flow: 'browser' },
  },
  agents: 'all',
  on: true,
}

const signIn = (extra: Partial<SignIn> = {}): SignIn => ({
  v: 1,
  url: MCP,
  savedAt: 10,
  kind: 'browser',
  account: null,
  issuer: AS,
  resource: MCP,
  client: { client_id: 'kettu-client' },
  tokens: { access: 'access-1', refresh: 'refresh-1', type: 'Bearer', expiresAt: 3_600_000 },
  ...extra,
})

type Handler = (init: RequestInit) => Response | Promise<Response>

/** A fetch that answers from handlers by method and address; a missing route is a network error. */
function fakeFetch(routes: Record<string, Handler>): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const handler = routes[`${init.method ?? 'GET'} ${url.origin}${url.pathname}`]
    if (!handler) throw new TypeError('fetch failed')
    return handler(init)
  }) as typeof fetch
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

/** An authorization server whose token endpoint renews `refresh-1` and refuses anything else. */
const authRoutes: Record<string, Handler> = {
  [`GET ${AS}/.well-known/oauth-authorization-server`]: () =>
    json({
      issuer: AS,
      authorization_endpoint: `${AS}/authorize`,
      token_endpoint: `${AS}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    }),
  [`POST ${AS}/token`]: (init) =>
    new URLSearchParams(String(init.body)).get('refresh_token') === 'refresh-1'
      ? json({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600 })
      : json({ error: 'invalid_grant' }, 400),
}

function setup(options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const logged: string[] = []
  const kept: [string, string | null][] = []
  const changes: {
    serverId: string
    connection: MarketConnection
    loginId?: string
    error?: string
  }[] = []
  const service = new MarketConnectionsService({
    log: (_level, message) => logged.push(message),
    servers: () => [server],
    headers: () => ({}),
    keep: (serverId, text) => kept.push([serverId, text]),
    changed: (serverId, connection, loginId, error) =>
      changes.push({
        serverId,
        connection,
        ...(loginId ? { loginId } : {}),
        ...(error ? { error } : {}),
      }),
    now: options.now ?? (() => 0),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  return { service, kept, changes, logged }
}

describe('MarketConnectionsService', () => {
  it('leaves out a sign-in made for another address of the server', () => {
    const { service } = setup()
    service.load({
      'com.notion/mcp': JSON.stringify(signIn({ url: 'https://old.example.com/mcp' })),
    })
    expect(service.access(server)).toBeNull()
  })

  it('forgets a sign-in on disconnect, here and with main', () => {
    const { service, kept, changes } = setup()
    service.load({ 'com.notion/mcp': JSON.stringify(signIn()) })
    service.disconnect('com.notion/mcp')
    expect(kept).toEqual([['com.notion/mcp', null]])
    expect(changes).toEqual([{ serverId: 'com.notion/mcp', connection: { state: 'disconnected' } }])
    expect(service.access(server)).toBeNull()
  })

  describe('renewing a token', () => {
    // Expires within the five minutes before which it is renewed.
    const expiring = (extra: Partial<SignIn> = {}) =>
      signIn({
        tokens: { access: 'access-1', refresh: 'refresh-1', type: 'Bearer', expiresAt: 60_000 },
        ...extra,
      })

    it('hands out the renewed token and keeps it', async () => {
      const { service, kept } = setup({ fetch: fakeFetch(authRoutes) })
      service.load({ 'com.notion/mcp': JSON.stringify(expiring()) })
      expect(await service.token('com.notion/mcp')).toBe('access-2')
      expect(JSON.parse(kept.at(-1)![1]!).tokens.access).toBe('access-2')
    })

    it('needs reconnecting when the service refuses the refresh token', async () => {
      const { service } = setup({ fetch: fakeFetch(authRoutes) })
      const stale = expiring({
        tokens: { access: 'access-1', refresh: 'stale', type: 'Bearer', expiresAt: 60_000 },
      })
      service.load({ 'com.notion/mcp': JSON.stringify(stale) })
      expect(await service.refused('com.notion/mcp', 'access-1')).toBeNull()
      expect(service.view()['com.notion/mcp']?.state).toBe('needs-reconnect')
      expect(service.access(server)).toBeNull()
    })

    it('stays connected when the renewal fails on the way, and renews later', async () => {
      let time = 0
      let reachable = false
      const routes = fakeFetch(authRoutes)
      // What Cloudflare Access served once: no OAuth metadata, then a partial OpenID configuration.
      const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
        if (reachable) return routes(input, init)
        const url = new URL(String(input))
        if (url.pathname === '/.well-known/openid-configuration') {
          return json({ issuer: AS, jwks_uri: `${AS}/certs` })
        }
        throw new TypeError('fetch failed')
      }) as typeof fetch
      const { service, kept, logged } = setup({ fetch: flaky, now: () => time })
      service.load({ 'com.notion/mcp': JSON.stringify(expiring()) })

      expect(await service.token('com.notion/mcp')).toBe('access-1')
      expect(service.view()['com.notion/mcp']?.state).toBe('connected')
      expect(service.access(server)).toBe('proxy')
      expect(kept).toEqual([])
      expect(logged.some((line) => line.includes('com.notion/mcp'))).toBe(true)

      reachable = true
      time = 30_000
      expect(await service.token('com.notion/mcp')).toBe('access-2')
      expect(service.view()['com.notion/mcp']?.state).toBe('connected')
    })

    it('gives no expired token when the renewal fails on the way', async () => {
      const { service } = setup({ fetch: fakeFetch({}), now: () => 120_000 })
      service.load({ 'com.notion/mcp': JSON.stringify(expiring()) })
      expect(await service.token('com.notion/mcp')).toBeNull()
      expect(service.access(server)).toBe('proxy')
    })
  })
})
