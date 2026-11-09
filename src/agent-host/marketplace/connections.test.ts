import { describe, expect, it } from 'vitest'
import type { MarketConnection, MarketServer } from '@shared/marketplace'
import { MarketConnectionsService, RENEW_EARLY_MS } from './connections'
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

function setup(options: { refresh?: 'ok' | 'refuse'; now?: number; probe?: number } = {}) {
  const state = { now: options.now ?? 0, renewals: 0 }
  const kept: [string, string | null][] = []
  const changes: {
    serverId: string
    connection: MarketConnection
    loginId?: string
    error?: string
  }[] = []
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    if (url === MCP) return new Response('{}', { status: options.probe ?? 200 })
    if (url.startsWith(`${AS}/.well-known/`)) {
      return Response.json({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        response_types_supported: ['code'],
      })
    }
    if (url === `${AS}/token` && init.method === 'POST') {
      state.renewals++
      return options.refresh === 'refuse'
        ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({
            access_token: `access-${state.renewals + 1}`,
            token_type: 'Bearer',
            expires_in: 3600,
          })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
  const service = new MarketConnectionsService({
    log: () => {},
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
    fetch: fetcher,
    now: () => state.now,
  })
  return { service, state, kept, changes }
}

describe('MarketConnectionsService', () => {
  it("reads main's copy, keeping a newer change of its own and a clear main has not confirmed", () => {
    const { service } = setup()
    expect(service.view()).toEqual({ 'com.notion/mcp': { state: 'disconnected' } })
    service.load({ 'com.notion/mcp': JSON.stringify(signIn({ account: 'ada' })) })
    expect(service.view()['com.notion/mcp']).toEqual({ state: 'connected', account: 'ada' })
    expect(service.access(server)).toBe('proxy')

    service.disconnect('com.notion/mcp')
    // A push that left before main got the clear still holds the sign-in; it does not come back.
    service.load({ 'com.notion/mcp': JSON.stringify(signIn({ account: 'ada' })) })
    expect(service.view()['com.notion/mcp']).toEqual({ state: 'disconnected' })
    service.load({})
    service.load({ 'com.notion/mcp': JSON.stringify(signIn({ savedAt: 1_000_000 })) })
    expect(service.view()['com.notion/mcp']).toEqual({ state: 'connected', account: null })
    service.load({})
    expect(service.view()['com.notion/mcp']).toEqual({ state: 'disconnected' })
    service.load(undefined)
  })

  it('leaves out a sign-in made for another address of the server', () => {
    const { service } = setup()
    service.load({
      'com.notion/mcp': JSON.stringify(signIn({ url: 'https://old.example.com/mcp' })),
    })
    expect(service.access(server)).toBeNull()
  })

  it('renews a token five minutes before it expires, once for every request waiting', async () => {
    const { service, state, kept, changes } = setup()
    service.load({ 'com.notion/mcp': JSON.stringify(signIn()) })
    state.now = 3_600_000 - RENEW_EARLY_MS - 1
    expect(await service.token('com.notion/mcp')).toBe('access-1')
    state.now = 3_600_000 - RENEW_EARLY_MS + 1
    const [a, b] = await Promise.all([
      service.token('com.notion/mcp'),
      service.token('com.notion/mcp'),
    ])
    expect([a, b]).toEqual(['access-2', 'access-2'])
    expect(state.renewals).toBe(1)
    expect(kept).toHaveLength(1)
    expect(JSON.parse(kept[0]![1]!).tokens).toMatchObject({
      access: 'access-2',
      refresh: 'refresh-1',
    })
    expect(changes.at(-1)).toMatchObject({ connection: { state: 'connected' } })
  })

  it('hands out the token another request renewed after a 401, and renews only once', async () => {
    const { service, state } = setup()
    service.load({ 'com.notion/mcp': JSON.stringify(signIn()) })
    expect(await service.refused('com.notion/mcp', 'access-1')).toBe('access-2')
    expect(await service.refused('com.notion/mcp', 'access-1')).toBe('access-2')
    expect(state.renewals).toBe(1)
  })

  it('needs connecting again when the token cannot be renewed, and tells the clients', async () => {
    const { service, kept, changes } = setup({ refresh: 'refuse' })
    service.load({ 'com.notion/mcp': JSON.stringify(signIn()) })
    expect(await service.refused('com.notion/mcp', 'access-1')).toBeNull()
    expect(service.view()['com.notion/mcp']).toEqual({
      state: 'needs-reconnect',
      reason: 'The service refused to renew the token: invalid_grant',
    })
    expect(service.access(server)).toBeNull()
    expect(await service.token('com.notion/mcp')).toBeNull()
    expect(JSON.parse(kept.at(-1)![1]!)).toHaveProperty('reconnect')
    expect(changes.at(-1)).toMatchObject({
      serverId: 'com.notion/mcp',
      connection: { state: 'needs-reconnect' },
    })
  })

  it('connects a server that answers without a sign-in as open, after it answers', async () => {
    const { service, kept, changes } = setup({ probe: 200 })
    const start = await service.connect('com.notion/mcp')
    expect(start).toEqual({ loginId: start.loginId, kind: 'open' })
    expect(changes).toEqual([])
    await new Promise((resolve) => setImmediate(resolve))
    expect(changes).toEqual([
      {
        serverId: 'com.notion/mcp',
        connection: { state: 'connected', account: null },
        loginId: start.loginId,
      },
    ])
    expect(service.access(server)).toBe('open')
    expect(JSON.parse(kept[0]![1]!)).toMatchObject({ kind: 'open', url: MCP })
    expect(kept[0]![1]).not.toContain('token')
  })

  it('reports a server that cannot be signed in to, and refuses one Kettu does not keep', async () => {
    const { service, changes } = setup({ probe: 500 })
    await expect(service.connect('com.notion/mcp')).rejects.toThrow(/answered 500/)
    expect(service.view()['com.notion/mcp']).toEqual({
      state: 'error',
      message: 'The server answered 500',
    })
    expect(changes).toHaveLength(1)
    await expect(service.connect('io.github.acme/other')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('forgets a sign-in on disconnect, here and with main', () => {
    const { service, kept, changes } = setup()
    service.load({ 'com.notion/mcp': JSON.stringify(signIn()) })
    service.disconnect('com.notion/mcp')
    expect(kept).toEqual([['com.notion/mcp', null]])
    expect(changes).toEqual([{ serverId: 'com.notion/mcp', connection: { state: 'disconnected' } }])
    expect(service.access(server)).toBeNull()
  })
})
