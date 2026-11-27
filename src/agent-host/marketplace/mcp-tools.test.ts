import { describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/agents'
import type { CatalogServer, MarketServer } from '@shared/marketplace'
import type { McpServerInsight } from '@shared/mcp-insight'
import type { McpRestore } from '@shared/mcp-switch'
import type { McpChangeOutcome } from '@shared/thread'
import {
  ADD_MCP_SERVER,
  CHECK_MCP_SERVER,
  LIST_MCP_SERVERS,
  McpStaleUndo,
  McpTools,
  READ_MCP_SERVER,
  SWITCH_MCP_SERVERS,
  type McpAnswer,
  type McpAsk,
} from './mcp-tools'

const CALLER = { sessionId: 's1', project: '/p' }
const KEY = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

function text(result: CallToolResult): string {
  return result.content.map((part) => ('text' in part ? part.text : '')).join('\n')
}

function agent(id: AgentId, name: string): AgentStatus {
  return { id, name, registered: true } as AgentStatus
}

const AGENTS = [agent('claude-code', 'Claude Code'), agent('codex', 'Codex')]

function github(overrides: Partial<MarketServer> = {}): MarketServer {
  return {
    id: 'io.github.github/github-mcp-server',
    name: 'github',
    title: 'GitHub',
    source: 'registry',
    version: '1.0.0',
    spec: {
      type: 'http',
      transport: 'streamable-http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: [
        { name: 'Authorization', input: true, secret: true, required: true, prefix: 'Bearer ' },
        { name: 'X-Team', value: 'kept-team-value' },
        { name: 'X-Ref', value: '${TEAM_REF}' },
      ],
    },
    agents: 'all',
    on: true,
    ...overrides,
  }
}

const INSIGHT: McpServerInsight = {
  serverId: 'io.github.github/github-mcp-server',
  state: { state: 'idle' },
  tools: [
    {
      name: 'create_issue',
      summary: 'Creates an issue.',
      bytes: 10,
      tags: ['changes'],
      off: false,
    },
    { name: 'get_me', summary: 'Who you are.', bytes: 10, tags: ['read-only'], off: false },
  ],
  agents: [],
  changes: null,
}

const CATALOG: CatalogServer = {
  id: 'io.github.example/notes',
  title: 'Notes',
  publisher: 'Example',
  official: false,
  description: '',
  version: '2.0.0',
  updated: null,
  repository: null,
  website: null,
  brand: null,
  spec: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@example/notes@2.0.0'],
    env: [{ name: 'NOTES_TOKEN', input: true, secret: true, required: true }],
  },
}

function harness(start: MarketServer[] = [github()], insight: McpServerInsight = INSIGHT) {
  let servers = start
  const puts: MarketServer[][] = []
  const asked: McpAsk[] = []
  const settled: { outcome: McpChangeOutcome; restore?: McpRestore[] }[] = []
  const checks: string[] = []
  let answer: (given: McpAnswer) => void = () => {}
  const tools = new McpTools({
    servers: () => servers,
    insight: (id) => (id === insight.serverId ? insight : null),
    lastCheck: () => null,
    check: async (server) => {
      checks.push(server.id)
      return { state: 'connected', tools: 3, startMs: 1, initializeMs: 1, toolsMs: 1 }
    },
    failedCalls: async (serverId) => [
      {
        at: 0,
        serverId,
        sessionId: null,
        agentId: null,
        tool: 'create_issue',
        ms: 5,
        bytes: 0,
        result: 'error',
        error: `bad token ${KEY}`,
      },
    ],
    logs: (serverId) => [
      {
        instance: 'i1',
        serverId,
        sessionId: null,
        folder: '/p',
        running: true,
        text: `starting\nAuthorization: Bearer ${KEY}\n`,
      },
    ],
    mask: () => (value) => value.split(KEY).join('<redacted>'),
    keysSet: () => [],
    agents: () => AGENTS,
    project: async (path) => (path === '/p' || path === '/q' ? path : null),
    sessionFolder: () => '/p',
    detectSignIn: async () => null,
    catalogServer: async (id) => (id === CATALOG.id ? CATALOG : null),
    put: async (next) => {
      puts.push(next)
      const byId = new Map(servers.map((server) => [server.id, server]))
      for (const server of next) byId.set(server.id, server)
      servers = [...byId.values()]
    },
    ask: (_, ask) => {
      asked.push(ask)
      return { entryId: 'e1', answer: new Promise((resolve) => (answer = resolve)) }
    },
    settle: (_, __, outcome, restore) => settled.push({ outcome, restore }),
    newId: () => 'fixed',
  })
  return {
    tools,
    puts,
    asked,
    settled,
    checks,
    servers: () => servers,
    setServers: (next: MarketServer[]) => (servers = next),
    answer: (given: McpAnswer) => answer(given),
  }
}

describe('reading the library', () => {
  it('lists, reads and checks without asking', async () => {
    const h = harness()
    expect(text(await h.tools.call(CALLER, LIST_MCP_SERVERS, {}))).toContain('github "GitHub"')
    await h.tools.call(CALLER, READ_MCP_SERVER, { server: 'github' })
    expect(text(await h.tools.call(CALLER, CHECK_MCP_SERVER, { server: 'github' }))).toContain(
      'connected, 3 tools',
    )
    expect(h.asked).toEqual([])
    expect(h.puts).toEqual([])
  })

  // A key the user stored, a fixed value and a key in an error or in stderr never reach the agent.
  it('shows no key in what it reads', async () => {
    const h = harness()
    const result = await h.tools.call(CALLER, READ_MCP_SERVER, { server: 'github' })
    const all = JSON.stringify(result)
    expect(all).not.toContain(KEY)
    expect(all).not.toContain('kept-team-value')
    expect(text(result)).toContain('X-Ref: ${TEAM_REF}')
    expect(text(result)).toContain('Authorization: in the key store, not set')
  })
})

// A tool held back until the user accepts its change must never read as one an agent can use.
describe('tools held back until the user accepts their change', () => {
  const held: McpServerInsight = {
    ...INSIGHT,
    serverId: 'manual:notes',
    tools: [
      ...INSIGHT.tools!,
      {
        name: 'delete_repo',
        summary: 'Deletes a repository.',
        bytes: 10,
        tags: [],
        off: false,
        change: 'added',
        held: true,
      },
    ],
  }
  const notes = (): MarketServer => github({ id: 'manual:notes', name: 'notes', source: 'manual' })

  it('marks them in what is listed, read and checked', async () => {
    const h = harness([notes()], held)
    expect(text(await h.tools.call(CALLER, LIST_MCP_SERVERS, {}))).toContain(
      "3 tools, 1 held back until the user accepts the change on the server's page",
    )
    const read = await h.tools.call(CALLER, READ_MCP_SERVER, { server: 'notes' })
    expect(text(read)).toContain('- delete_repo (new, held back until the user accepts')
    expect(read.structuredContent).toMatchObject({
      toolsHeld: 1,
      toolList: expect.arrayContaining([
        expect.objectContaining({ name: 'delete_repo', held: true }),
      ]),
    })
    expect(text(await h.tools.call(CALLER, CHECK_MCP_SERVER, { server: 'notes' }))).toContain(
      '1 of them held back',
    )
  })

  it('refuses to turn one on, which would not hand it to agents', async () => {
    const h = harness([notes()], held)
    const result = await h.tools.call(CALLER, SWITCH_MCP_SERVERS, {
      changes: [{ server: 'notes', tool: 'delete_repo', on: true }],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Nothing was done: delete_repo of notes is held back')
    expect(h.asked).toEqual([])
    expect(h.puts).toEqual([])
  })
})

// An MCP server runs with the user's permissions for every agent, so no mode lets these act unasked.
describe('the MCP tools that change the library', () => {
  const calls: [string, string, Record<string, unknown>][] = [
    ['add', ADD_MCP_SERVER, { config: 'npx -y @modelcontextprotocol/server-memory' }],
    ['add', ADD_MCP_SERVER, { catalog: CATALOG.id }],
    ['switch', SWITCH_MCP_SERVERS, { changes: [{ server: 'github', on: false, agent: 'codex' }] }],
  ]

  for (const [action, name, args] of calls) {
    it(`${name} ${JSON.stringify(args)} changes nothing until the user approves`, async () => {
      const h = harness()
      const pending = h.tools.call(CALLER, name, args)
      await vi.waitFor(() => expect(h.asked).toHaveLength(1))
      expect(h.asked[0]!.action).toBe(action)
      expect(h.puts).toEqual([])
      h.answer({ decision: 'confirm' })
      const result = await pending
      expect(result.isError).toBeUndefined()
      expect(h.puts).toHaveLength(1)
      expect(h.settled[0]!.outcome).toEqual({ kind: 'done' })
    })

    it(`${name} ${JSON.stringify(args)} does nothing when declined, unanswered or ended`, async () => {
      for (const decision of ['decline', 'expired', 'ended'] as const) {
        const h = harness()
        const pending = h.tools.call(CALLER, name, args)
        await vi.waitFor(() => expect(h.asked).toHaveLength(1))
        h.answer({ decision })
        expect(text(await pending)).toMatch(/nothing was done/i)
        expect(h.puts).toEqual([])
        expect(h.settled).toEqual([])
      }
    })
  }

  it('asks once for a call repeated with the same arguments while the card waits', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const args = { changes: [{ server: 'github', on: false }] }
      const first = h.tools.call(CALLER, SWITCH_MCP_SERVERS, args)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(text(await first)).toContain('has not answered')
      const again = h.tools.call(CALLER, SWITCH_MCP_SERVERS, args)
      h.answer({ decision: 'confirm' })
      await again
      expect(h.asked).toHaveLength(1)
      expect(h.puts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('checks an added server once it is in the library, and records what it found', async () => {
    const h = harness()
    const pending = h.tools.call(CALLER, ADD_MCP_SERVER, { catalog: CATALOG.id })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    h.answer({ decision: 'confirm' })
    await pending
    await vi.waitFor(() => expect(h.settled).toHaveLength(2))
    expect(h.checks).toEqual([CATALOG.id])
    expect(h.settled[1]!.outcome).toEqual({
      kind: 'done',
      check: { state: 'connected', tools: 3 },
    })
  })
})

describe('keys an agent passes', () => {
  it('refuses a value where only a reference or an empty key is taken', async () => {
    for (const config of [
      JSON.stringify({
        mcpServers: {
          gh: { url: 'https://x.test/mcp', headers: { Authorization: `Bearer ${KEY}` } },
        },
      }),
      JSON.stringify({
        mcpServers: { db: { command: 'db-mcp', env: { DB_PASSWORD: 'hunter22' } } },
      }),
      'claude mcp add notes -e NOTES_TOKEN=abcdef123456 -- notes-mcp',
      `https://x.test/mcp?api_key=${KEY}`,
      `npx -y some-mcp --token ${KEY}`,
    ]) {
      const h = harness()
      const result = await h.tools.call(CALLER, ADD_MCP_SERVER, { config })
      expect(result.isError, config).toBe(true)
      expect(JSON.stringify(result)).not.toContain(KEY)
      expect(h.asked).toEqual([])
    }
  })

  it('takes references, and empty keys for the user to fill in on the server page', async () => {
    const h = harness([])
    const config = JSON.stringify({
      mcpServers: {
        gh: {
          url: 'https://x.test/mcp',
          headers: { Authorization: 'Bearer ${GITHUB_TOKEN}', 'X-Key': '' },
        },
      },
    })
    const pending = h.tools.call(CALLER, ADD_MCP_SERVER, { config })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(h.asked[0]!.server!.values).toEqual([
      { name: 'Authorization', state: 'reference', reference: 'Bearer ${GITHUB_TOKEN}' },
      { name: 'X-Key', state: 'unset' },
    ])
    h.answer({ decision: 'confirm' })
    await pending
    const added = h.puts[0]![0]!
    expect(added.source).toBe('manual')
    expect(added.spec.type === 'http' && added.spec.headers).toEqual([
      { name: 'Authorization', value: 'Bearer ${GITHUB_TOKEN}' },
      { name: 'X-Key', input: true, secret: true, required: true },
    ])
  })
})

describe('undoing switches', () => {
  async function switchOff(h: ReturnType<typeof harness>, changes: unknown[]) {
    const pending = h.tools.call(CALLER, SWITCH_MCP_SERVERS, { changes })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    h.answer({ decision: 'confirm' })
    await pending
    return h.settled[0]!.restore!
  }

  it('puts back only what this change did', async () => {
    const h = harness()
    const restore = await switchOff(h, [
      { server: 'github', on: false, agent: 'codex' },
      { server: 'github', on: false, tool: 'create_issue' },
    ])
    expect(h.servers()[0]).toMatchObject({ agents: ['claude-code'], toolsOff: ['create_issue'] })
    // The user turns the whole server off meanwhile, which Undo leaves as it is.
    h.setServers([{ ...h.servers()[0]!, on: false }])
    await h.tools.undo(restore)
    const back = h.servers()[0]!
    expect(back.agents).toBe('all')
    expect(back.toolsOff).toBeUndefined()
    expect(back.on).toBe(false)
  })

  it('puts back nothing once a part it set changed again', async () => {
    const h = harness()
    const restore = await switchOff(h, [{ server: 'github', on: false, agent: 'codex' }])
    h.setServers([{ ...h.servers()[0]!, agents: [] }])
    const puts = h.puts.length
    await expect(h.tools.undo(restore)).rejects.toBeInstanceOf(McpStaleUndo)
    expect(h.puts).toHaveLength(puts)
  })

  it('applies to the library as it is when approved, keeping what the user changed meanwhile', async () => {
    const h = harness()
    const pending = h.tools.call(CALLER, SWITCH_MCP_SERVERS, {
      changes: [{ server: 'github', on: false, project: '/q' }],
    })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    h.setServers([{ ...h.servers()[0]!, toolsOff: ['get_me'] }])
    h.answer({ decision: 'confirm' })
    await pending
    expect(h.servers()[0]).toMatchObject({
      toolsOff: ['get_me'],
      projects: { mode: 'except', paths: ['/q'] },
    })
  })
})
