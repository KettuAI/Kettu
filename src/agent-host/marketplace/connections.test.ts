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

function setup() {
  const kept: [string, string | null][] = []
  const changes: {
    serverId: string
    connection: MarketConnection
    loginId?: string
    error?: string
  }[] = []
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
    now: () => 0,
  })
  return { service, kept, changes }
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
})
