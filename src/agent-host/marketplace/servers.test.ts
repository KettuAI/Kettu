import { describe, expect, it } from 'vitest'
import type { MarketServer } from '@shared/marketplace'
import type { Access } from './connections'
import { proxyPath } from './proxy'
import { ALL_TRANSPORTS, keyState, libraryServers, parseMarketKeys } from './servers'

const github: MarketServer = {
  id: 'io.github.github/github-mcp-server',
  name: 'github',
  title: 'GitHub',
  source: 'registry',
  version: '2.1.0',
  spec: {
    type: 'http',
    transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: [
      { name: 'Authorization', input: true, secret: true, required: true, prefix: 'Bearer ' },
      { name: 'X-Toolsets', value: 'repos,issues' },
    ],
  },
  agents: 'all',
  on: true,
}

const context7: MarketServer = {
  id: 'io.github.upstash/context7',
  name: 'context7',
  title: 'Context7',
  source: 'registry',
  version: '4.6.0',
  spec: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@4.6.0'],
    env: [
      { name: 'CONTEXT7_API_KEY', input: true, secret: true, required: false },
      { name: 'CONTEXT7_REGION', value: 'eu' },
    ],
  },
  agents: ['codex'],
  on: true,
}

const keys = (values: Record<string, Record<string, string>>) => parseMarketKeys(values)!

describe('libraryServers with OAuth servers', () => {
  const linear: MarketServer = {
    id: 'app.linear/linear',
    name: 'linear',
    title: 'Linear',
    source: 'registry',
    version: '1.0.2',
    spec: {
      type: 'http',
      transport: 'streamable-http',
      url: 'https://mcp.linear.app/mcp',
      headers: [{ name: 'X-Read-Only', value: 'true' }],
      oauth: { flow: 'browser' },
    },
    agents: 'all',
    on: true,
  }
  const legacy: MarketServer = {
    ...linear,
    id: 'com.example/sse',
    name: 'legacy',
    spec: {
      type: 'http',
      transport: 'sse',
      url: 'https://x.example/sse',
      headers: [],
      oauth: { flow: 'browser' },
    },
  }
  const oauth = (access: Access) => ({
    access: () => access,
    bearer: () => ({ origin: 'http://127.0.0.1:4567', token: 'session-token' }),
  })

  it("goes through the proxy with the session's bearer while connected, never on a command line", () => {
    const servers = libraryServers([linear, legacy], new Map(), 'codex', ALL_TRANSPORTS, {
      platform: 'darwin',
      oauth: oauth('proxy'),
    })
    expect(servers).toEqual([
      {
        type: 'http',
        name: 'linear',
        url: `http://127.0.0.1:4567${proxyPath(linear.id)}`,
        headers: [{ name: 'Authorization', value: 'Bearer session-token' }],
        secret: true,
      },
    ])
    expect(JSON.stringify(servers)).not.toContain('mcp.linear.app')
  })
})

describe('keyState', () => {
  it('names the inputs that have a value, never the values', () => {
    const held = keys({
      [github.id]: { Authorization: 'ghp_secret', Unknown: 'x' },
      'manual:gone': { TOKEN: 'y' },
    })
    const state = keyState([github, context7], held)
    expect(state).toEqual({ [github.id]: ['Authorization'], [context7.id]: [] })
    expect(JSON.stringify(state)).not.toContain('ghp_secret')
  })
})

describe('parseMarketKeys', () => {
  it('keeps strings by server and input, dropping empty values', () => {
    const parsed = parseMarketKeys({ a: { X: 'one', Y: '' } })
    expect(parsed?.get('a')).toEqual(new Map([['X', 'one']]))
  })

  it('refuses anything but strings by name by server', () => {
    expect(parseMarketKeys(null)).toBeNull()
    expect(parseMarketKeys([])).toBeNull()
    expect(parseMarketKeys({ a: 'x' })).toBeNull()
    expect(parseMarketKeys({ a: { X: 1 } })).toBeNull()
    expect(parseMarketKeys({ '': { X: 'x' } })).toBeNull()
    expect(parseMarketKeys({ a: { X: 'x'.repeat(20_000) } })).toBeNull()
  })
})
