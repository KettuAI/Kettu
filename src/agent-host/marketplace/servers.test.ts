import { describe, expect, it } from 'vitest'
import type { MarketServer } from '@shared/marketplace'
import type { Access } from './connections'
import { serverPath } from '../mcp-router/router'
import {
  ALL_TRANSPORTS,
  BRIDGE_ENV,
  keyState,
  libraryServers,
  parseMarketKeys,
  serverCommand,
  serverMasker,
} from './servers'

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

const ROUTER = 'http://127.0.0.1:4567'
const router = () => {
  const allowed: string[] = []
  const gated: string[] = []
  return {
    access: {
      origin: ROUTER,
      token: 'session-token',
      allow: (ids: readonly string[]) => void allowed.push(...ids),
      gate: (ids: readonly string[]) => void gated.push(...ids),
    },
    allowed,
    gated,
  }
}
const BRIDGE = '/Applications/Kettu.app/Contents/Resources/helpers/kettu-mcp-bridge'
const STDIO_ONLY = { mcpHttp: false, mcpSse: false, mcpStdio: true }

describe('libraryServers through the router', () => {
  const held = keys({
    [github.id]: { Authorization: 'ghp_secret' },
    [context7.id]: { CONTEXT7_API_KEY: 'c7_secret' },
  })

  it("hands each server by its own name and path with the session's token, never a key", () => {
    const { access, allowed } = router()
    const servers = libraryServers([github, context7], held, 'codex', ALL_TRANSPORTS, {
      platform: 'darwin',
      router: access,
      bridge: BRIDGE,
    })
    expect(servers).toEqual([
      {
        type: 'http',
        name: 'github',
        url: `${ROUTER}${serverPath(github.id)}`,
        headers: [{ name: 'Authorization', value: 'Bearer session-token' }],
        secret: true,
      },
      {
        type: 'http',
        name: 'context7',
        url: `${ROUTER}${serverPath(context7.id)}`,
        headers: [{ name: 'Authorization', value: 'Bearer session-token' }],
        secret: true,
      },
    ])
    expect(allowed).toEqual([github.id, context7.id])
    const text = JSON.stringify(servers)
    for (const secret of ['ghp_secret', 'c7_secret', 'githubcopilot.com', 'context7-mcp']) {
      expect(text).not.toContain(secret)
    }
  })

  it('gives an agent that speaks only stdio the bridge, its token in the environment only', () => {
    const { access, allowed } = router()
    const servers = libraryServers([github], held, 'kimi', STDIO_ONLY, {
      platform: 'darwin',
      router: access,
      bridge: BRIDGE,
    })
    expect(servers).toEqual([
      {
        type: 'stdio',
        name: 'github',
        command: BRIDGE,
        args: ['mcp', 'connect', 'github', '--agent', 'kimi'],
        env: [
          { name: BRIDGE_ENV.url, value: ROUTER },
          { name: BRIDGE_ENV.token, value: 'session-token' },
        ],
        secret: true,
      },
    ])
    expect(allowed).toEqual([github.id])
    expect(JSON.stringify(servers)).not.toContain('ghp_secret')
  })

  it('hands a command to a stdio-only agent itself when the build has no bridge, and says so', () => {
    const { access, allowed } = router()
    const fell: string[] = []
    const servers = libraryServers([github, context7], held, 'codex', STDIO_ONLY, {
      platform: 'darwin',
      router: access,
      bridge: null,
      fellBack: (server) => void fell.push(server.name),
    })
    expect(servers.map((server) => [server.type, server.name])).toEqual([['stdio', 'context7']])
    expect(fell).toEqual(['github', 'context7'])
    expect(allowed).toEqual([])
  })

  it('hands a command set to run by each agent to it as before, its keys with it', () => {
    const { access, allowed } = router()
    const own = { ...context7, run: { mode: 'agent' as const } }
    const [server] = libraryServers([own], held, 'codex', ALL_TRANSPORTS, {
      platform: 'darwin',
      router: access,
    })
    expect(server).toEqual({
      type: 'stdio',
      name: 'context7',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@4.6.0'],
      env: [
        { name: 'CONTEXT7_API_KEY', value: 'c7_secret' },
        { name: 'CONTEXT7_REGION', value: 'eu' },
      ],
      secret: true,
    })
    expect(allowed).toEqual([])
  })

  it('leaves out a server whose required key has no value, and one that is not signed in', () => {
    const { access } = router()
    const linear: MarketServer = {
      ...github,
      id: 'app.linear/linear',
      name: 'linear',
      spec: {
        type: 'http',
        transport: 'sse',
        url: 'https://x.example/sse',
        headers: [],
        oauth: { flow: 'browser' },
      },
    }
    const servers = libraryServers([github, linear], new Map(), 'codex', ALL_TRANSPORTS, {
      platform: 'darwin',
      router: access,
      oauth: { access: (): Access => null },
    })
    expect(servers).toEqual([])
  })

  it('puts the servers whose tools are large or unknown behind the gateway', () => {
    const { access, allowed, gated } = router()
    const small = [{ name: 'resolve', description: 'Resolves.', inputSchema: { type: 'object' } }]
    const large = Array.from({ length: 80 }, (_, n) => ({ ...small[0], name: `tool_${n}` }))
    const docs = { ...context7, agents: 'all' as const }
    const known = new Map<string, unknown[] | null>([
      [github.id, large],
      [docs.id, small],
    ])
    const servers = libraryServers([github, docs], held, 'antigravity', ALL_TRANSPORTS, {
      platform: 'darwin',
      router: access,
      gateway: { known: (server) => known.get(server.id) ?? null },
    })
    expect(servers.map((server) => server.name)).toEqual(['context7'])
    expect(allowed).toEqual([docs.id])
    expect(gated).toEqual([github.id])
  })
})

describe("libraryServers beside the agent's own servers", () => {
  const held = keys({ [github.id]: { Authorization: 'ghp_secret' } })

  it("takes the name of the same server in the agent's file, so it runs once, as Kettu's", () => {
    const { access } = router()
    const clashes: string[] = []
    const servers = libraryServers([github, context7], held, 'codex', ALL_TRANSPORTS, {
      platform: 'darwin',
      router: access,
      own: [
        { name: 'gh', endpoint: { type: 'http', url: 'https://api.githubcopilot.com/mcp' } },
        { name: 'context7', endpoint: { type: 'stdio', command: 'uvx', args: ['context7'] } },
      ],
      conflict: (server, own) => void clashes.push(`${server.name}:${own}`),
    })
    expect(servers.map((server) => server.name)).toEqual(['gh', 'context7'])
    expect(clashes).toEqual(['context7:context7'])
  })

  it('prefers the exact library name and lists extra same-server aliases and project duplicates in replaces', () => {
    const { access } = router()
    const servers = libraryServers([github, context7], held, 'codex', ALL_TRANSPORTS, {
      platform: 'darwin',
      router: access,
      own: [
        { name: 'gh-alias', endpoint: { type: 'http', url: 'https://api.githubcopilot.com/mcp' } },
        { name: 'github', endpoint: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } },
      ],
      projectOwn: [
        {
          name: 'proj-docs',
          endpoint: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@4.6.0'] },
        },
      ],
    })
    expect(servers.map((server) => ({ name: server.name, replaces: server.replaces }))).toEqual([
      { name: 'github', replaces: ['gh-alias'] },
      // Untrusted project `.mcp.json` names never rename the library server; they go in `replaces`.
      { name: 'context7', replaces: ['proj-docs'] },
    ])
  })
})

describe('serverCommand', () => {
  const echo: MarketServer = {
    id: 'kettu:abcdefgh23',
    name: 'echo',
    title: 'Echo',
    source: 'kettu',
    version: '1.0.0',
    spec: {
      type: 'stdio',
      command: 'node',
      args: ['/data/marketplace/mcpb/abcdefgh23/1.0.0/server/index.js'],
      env: [{ name: 'ECHO_KEY', input: true, secret: true, required: true }],
      runtime: 'node',
    },
    agents: 'all',
    on: true,
  }
  const node = {
    command: '/Applications/Kettu.app/Contents/MacOS/Kettu',
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }

  it("runs a bundle on Kettu's own Node.js, over the login shell's environment", () => {
    const held = keys({ [echo.id]: { ECHO_KEY: 'k' } })
    expect(serverCommand(echo, held, { PATH: '/usr/bin', ECHO_KEY: 'shell' }, node)).toEqual({
      command: node.command,
      args: ['/data/marketplace/mcpb/abcdefgh23/1.0.0/server/index.js'],
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', ECHO_KEY: 'k' },
    })
    expect(typeof serverCommand(echo, held, {}, undefined)).toBe('string')
    expect(typeof serverCommand(echo, new Map(), {}, node)).toBe('string')
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

describe('libraryServers by project', () => {
  const held = keys({ [github.id]: { Authorization: 'ghp_secret' } })
  const names = (server: MarketServer, project: string) =>
    libraryServers([server], held, 'codex', ALL_TRANSPORTS, {
      platform: 'darwin',
      router: router().access,
      project,
    }).map((entry) => entry.name)

  it('hands a server set to some projects only to sessions of those, and the rest the others', () => {
    const only: MarketServer = { ...github, projects: { mode: 'only', paths: ['/work/app'] } }
    expect(names(only, '/work/app')).toEqual(['github'])
    expect(names(only, '/work/other')).toEqual([])
    const except: MarketServer = { ...github, projects: { mode: 'except', paths: ['/work/app'] } }
    expect(names(except, '/work/app')).toEqual([])
    expect(names(except, '/work/other')).toEqual(['github'])
    expect(names(github, '/anywhere')).toEqual(['github'])
  })

  it('still hands a server a workflow step names, whatever its projects', () => {
    const only: MarketServer = { ...github, projects: { mode: 'only', paths: ['/work/app'] } }
    const servers = libraryServers([only], held, 'codex', ALL_TRANSPORTS, {
      platform: 'darwin',
      router: router().access,
      project: '/work/other',
      also: ['github'],
    })
    expect(servers.map((entry) => entry.name)).toEqual(['github'])
  })
})

describe('serverMasker', () => {
  it("masks a server's key values and fixed values in what its process printed", () => {
    const server: MarketServer = {
      ...context7,
      spec: {
        type: 'stdio',
        command: 'npx',
        args: [],
        env: [
          { name: 'CONTEXT7_API_KEY', input: true, secret: true, required: false },
          { name: 'DATABASE_URI', value: 'postgres://app:hunter2hunter2@db/app' },
        ],
      },
    }
    const mask = serverMasker(server, keys({ [server.id]: { CONTEXT7_API_KEY: 'c7-key-value' } }))
    const out = mask(
      'auth with c7-key-value failed\nconnecting to postgres://app:hunter2hunter2@db/app',
    )
    expect(out).not.toContain('c7-key-value')
    expect(out).not.toContain('hunter2hunter2')
    expect(out).toContain('auth with')
  })

  it('masks what a reference to the environment stands for, too', () => {
    const server: MarketServer = {
      ...context7,
      spec: {
        type: 'stdio',
        command: 'npx',
        args: [],
        env: [{ name: 'API_TOKEN', value: '${NOTES_TOKEN}' }],
      },
    }
    const mask = serverMasker(server, keys({}), undefined, {
      env: { NOTES_TOKEN: 'notes-token-from-shell' },
      platform: 'darwin',
    })
    expect(mask('sent notes-token-from-shell')).not.toContain('notes-token-from-shell')
  })
})
