import { describe, expect, it } from 'vitest'
import type { MarketServer } from '@shared/marketplace'
import { mcpServers as acpServers } from '../acp/connection'
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

const notion: MarketServer = {
  id: 'com.notion/mcp',
  name: 'notion',
  title: 'Notion',
  source: 'registry',
  version: '1.0.1',
  spec: { type: 'http', transport: 'sse', url: 'https://mcp.notion.com/sse', headers: [] },
  agents: 'all',
  on: true,
}

const keys = (values: Record<string, Record<string, string>>) => parseMarketKeys(values)!

const posix = { platform: 'darwin' as const }

describe('libraryServers', () => {
  it('fills each input from the keys, with its prefix, and marks the servers holding one', () => {
    const held = keys({
      [github.id]: { Authorization: 'ghp_secret' },
      [context7.id]: { CONTEXT7_API_KEY: 'c7-secret' },
    })
    expect(libraryServers([github, context7], held, 'codex', ALL_TRANSPORTS, posix)).toEqual([
      {
        type: 'http',
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: [
          { name: 'Authorization', value: 'Bearer ghp_secret' },
          { name: 'X-Toolsets', value: 'repos,issues' },
        ],
        secret: true,
      },
      {
        type: 'stdio',
        name: 'context7',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@4.6.0'],
        env: [
          { name: 'CONTEXT7_API_KEY', value: 'c7-secret' },
          { name: 'CONTEXT7_REGION', value: 'eu' },
        ],
        secret: true,
      },
    ])
  })

  it('leaves out a server whose required input has no value, and an optional one empty', () => {
    const servers = libraryServers([github, context7], keys({}), 'codex', ALL_TRANSPORTS, posix)
    expect(servers).toEqual([
      {
        type: 'stdio',
        name: 'context7',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@4.6.0'],
        env: [{ name: 'CONTEXT7_REGION', value: 'eu' }],
      },
    ])
  })

  it('leaves out servers that are off or meant for other agents', () => {
    const held = keys({ [github.id]: { Authorization: 'ghp_secret' } })
    const off = { ...github, on: false }
    expect(libraryServers([off, context7], held, 'codex', ALL_TRANSPORTS, posix)).toHaveLength(1)
    expect(libraryServers([github, context7], held, 'claude-code', ALL_TRANSPORTS, posix)).toEqual([
      expect.objectContaining({ name: 'github' }),
    ])
  })

  it('gives each agent only the transports it speaks', () => {
    const held = keys({ [github.id]: { Authorization: 'ghp_secret' } })
    const all = [github, context7, notion]
    const codex = { mcpHttp: true, mcpSse: false, mcpStdio: true }
    expect(libraryServers(all, held, 'codex', codex, posix).map((s) => s.name)).toEqual([
      'github',
      'context7',
    ])
    const stdioOnly = { mcpHttp: false, mcpSse: false, mcpStdio: true }
    expect(libraryServers(all, held, 'codex', stdioOnly, posix).map((s) => s.name)).toEqual([
      'context7',
    ])
    expect(libraryServers([notion], held, 'codex', ALL_TRANSPORTS, posix)).toEqual([
      { type: 'sse', name: 'notion', url: 'https://mcp.notion.com/sse', headers: [] },
    ])
  })

  it("renames a server whose name another already has, such as Kettu's own", () => {
    const named = { ...notion, name: 'kettu' }
    const servers = libraryServers([named], keys({}), 'codex', ALL_TRANSPORTS, {
      ...posix,
      taken: ['kettu'],
    })
    expect(servers.map((s) => s.name)).toEqual(['kettu-2'])
  })

  it('starts npx through cmd on Windows', () => {
    const [server] = libraryServers([context7], keys({}), 'codex', ALL_TRANSPORTS, {
      platform: 'win32',
    })
    expect(server).toMatchObject({
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@upstash/context7-mcp@4.6.0'],
    })
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

describe('ACP mapping', () => {
  it('passes stdio servers with their environment as pairs, and URLs with their headers', () => {
    const held = keys({
      [github.id]: { Authorization: 'ghp_secret' },
      [context7.id]: { CONTEXT7_API_KEY: 'c7-secret' },
    })
    const servers = libraryServers([github, context7, notion], held, 'codex', ALL_TRANSPORTS, posix)
    expect(acpServers(servers)).toEqual([
      {
        type: 'http',
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: [
          { name: 'Authorization', value: 'Bearer ghp_secret' },
          { name: 'X-Toolsets', value: 'repos,issues' },
        ],
      },
      {
        name: 'context7',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@4.6.0'],
        env: [
          { name: 'CONTEXT7_API_KEY', value: 'c7-secret' },
          { name: 'CONTEXT7_REGION', value: 'eu' },
        ],
      },
      { type: 'sse', name: 'notion', url: 'https://mcp.notion.com/sse', headers: [] },
    ])
  })
})
