// Kettu's extension for Pi: where a session's tokens go, which of Kettu's tools Pi declares, and
// the model scope it passes on.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServer } from '../connection'
import {
  DIRECT_TOOLS,
  NAVIGATE_COMMAND,
  NAVIGATE_READY_STATUS,
  NAVIGATE_STATUS,
  NAVIGATE_VARIABLE,
  piExtension,
  piServers,
} from './extension'

const HELD = Symbol.for('kettu.session')
const dirs: string[] = []

afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[HELD]
  delete process.env.KETTU_MCP_SERVERS
  delete process.env.KETTU_MODEL_SCOPE
  delete process.env[NAVIGATE_VARIABLE]
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function written() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-pi-'))
  dirs.push(dir)
  const file = await piExtension(dir)
  // A query string makes each test load the module afresh.
  const url = `${pathToFileURL(file).href}?${dirs.length}`
  return ((await import(url)) as { default: (pi: unknown) => void }).default
}

const KETTU: McpServer = {
  type: 'http',
  name: 'kettu',
  url: 'http://127.0.0.1:4100/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer session-token' }],
  secret: true,
}

describe("the servers a session hands Pi's extension", () => {
  it('declares the plan, memory and artifact tools of Kettu, and defers the rest', () => {
    const [server] = piServers([KETTU])
    expect(server).toEqual({
      name: 'kettu',
      config: {
        url: 'http://127.0.0.1:4100/mcp',
        headers: { Authorization: 'Bearer session-token' },
        exposure: 'deferred',
        toolExposure: Object.fromEntries(DIRECT_TOOLS.map((tool) => [tool, 'direct'])),
      },
    })
    expect(DIRECT_TOOLS).toEqual(
      expect.arrayContaining(['set_plan', 'remember', 'read_memory', 'create_artifact']),
    )
  })

  it("leaves another server's exposure to Pi, and SSE out", () => {
    const servers = piServers([
      { type: 'stdio', name: 'files', command: 'npx', args: ['-y', 'fs'], env: [] },
      {
        type: 'stdio',
        name: 'keyed',
        command: '/bin/x',
        args: [],
        env: [{ name: 'API_KEY', value: 'k' }],
      },
      { type: 'sse', name: 'old', url: 'http://x/sse', headers: [] },
      { type: 'http', name: 'docs', url: 'https://docs.example/mcp', headers: [] },
    ])
    expect(servers).toEqual([
      { name: 'files', config: { command: 'npx', args: ['-y', 'fs'] } },
      { name: 'keyed', config: { command: '/bin/x', args: [], env: { API_KEY: 'k' } } },
      { name: 'docs', config: { url: 'https://docs.example/mcp' } },
    ])
  })

  it('gives each server a name Pi takes, counting `-` and `_` as the same', () => {
    const names = piServers([
      { type: 'http', name: 'my server', url: 'http://a', headers: [] },
      { type: 'http', name: 'my-server', url: 'http://b', headers: [] },
      { type: 'http', name: 'my_server', url: 'http://c', headers: [] },
    ]).map((server) => server.name)
    expect(names).toEqual(['my_server', 'my-server_2', 'my_server_3'])
  })
})

describe("Kettu's extension for Pi", () => {
  it('registers the servers, and takes them out of the environment', async () => {
    const servers = piServers([KETTU])
    process.env.KETTU_MCP_SERVERS = JSON.stringify(servers)
    const extension = await written()
    const registered: unknown[] = []
    extension({ registerMcpServer: (...args: unknown[]) => registered.push(args) })
    expect(registered).toEqual([[servers[0]!.name, servers[0]!.config]])
    expect(process.env.KETTU_MCP_SERVERS).toBeUndefined()
  })

  it('does nothing in a Pi without MCP, and still takes the servers out', async () => {
    process.env.KETTU_MCP_SERVERS = JSON.stringify(piServers([KETTU]))
    const extension = await written()
    expect(() => extension({})).not.toThrow()
    expect(process.env.KETTU_MCP_SERVERS).toBeUndefined()
  })

  it('goes on without a server Pi refuses, and without servers it cannot read', async () => {
    process.env.KETTU_MCP_SERVERS = JSON.stringify([
      { name: 'bad', config: {} },
      { name: 'good', config: { url: 'http://g' } },
    ])
    const extension = await written()
    const registered: string[] = []
    extension({
      registerMcpServer: (name: string) => {
        if (name === 'bad') throw new Error('invalid config')
        registered.push(name)
      },
    })
    expect(registered).toEqual(['good'])
    delete (globalThis as Record<symbol, unknown>)[HELD]
    process.env.KETTU_MCP_SERVERS = 'not json'
    const again = await written()
    expect(() => again({ registerMcpServer: () => registered.push('none') })).not.toThrow()
    expect(registered).toEqual(['good'])
  })

  it('keeps the servers for a reload, which loads it again in the same process', async () => {
    process.env.KETTU_MCP_SERVERS = JSON.stringify(piServers([KETTU]))
    const extension = await written()
    const registered: unknown[] = []
    const pi = { registerMcpServer: (...args: unknown[]) => registered.push(args) }
    extension(pi)
    extension(pi)
    expect(registered).toHaveLength(2)
  })

  it('reports the models Pi scoped the session to, once per process', async () => {
    process.env.KETTU_MODEL_SCOPE = '1'
    const extension = await written()
    const handlers: ((event: unknown, ctx: unknown) => void)[] = []
    extension({ on: (_name: string, handler: (typeof handlers)[number]) => handlers.push(handler) })
    expect(process.env.KETTU_MODEL_SCOPE).toBeUndefined()
    const statuses: unknown[] = []
    const ctx = {
      scopedModels: [
        { model: { provider: 'anthropic', id: 'claude-sonnet-5' } },
        { model: { provider: 'openai', id: 'gpt-6/mini' }, thinkingLevel: 'high' },
      ],
      ui: { setStatus: (...args: unknown[]) => statuses.push(args) },
    }
    handlers[0]!({}, ctx)
    handlers[0]!({}, ctx)
    expect(statuses).toEqual([
      [
        'kettu.model-scope',
        JSON.stringify({ models: ['anthropic/claude-sonnet-5', 'openai/gpt-6/mini'] }),
      ],
    ])
  })

  it('reports no models for a Pi without a scope, and nothing without the variable', async () => {
    process.env.KETTU_MODEL_SCOPE = '1'
    const extension = await written()
    const handlers: ((event: unknown, ctx: unknown) => void)[] = []
    extension({ on: (_name: string, handler: (typeof handlers)[number]) => handlers.push(handler) })
    const statuses: unknown[] = []
    handlers[0]!({}, { ui: { setStatus: (...args: unknown[]) => statuses.push(args) } })
    expect(statuses).toEqual([['kettu.model-scope', JSON.stringify({ models: [] })]])
    delete (globalThis as Record<symbol, unknown>)[HELD]
    const plain = await written()
    const none: unknown[] = []
    plain({ on: (...args: unknown[]) => none.push(args) })
    expect(none).toEqual([])
  })

  it('registers internal tree navigation when enabled and reports outcome via status', async () => {
    process.env[NAVIGATE_VARIABLE] = '1'
    const extension = await written()
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
    const hooks: ((event: unknown, ctx: unknown) => void)[] = []
    extension({
      registerCommand: (
        name: string,
        spec: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => commands.set(name, spec),
      on: (_name: string, handler: (typeof hooks)[number]) => hooks.push(handler),
    })
    expect(process.env[NAVIGATE_VARIABLE]).toBeUndefined()
    expect(commands.has(NAVIGATE_COMMAND)).toBe(true)

    const statuses: [string, string][] = []
    const navigated: [string, unknown][] = []
    const ctx = {
      navigateTree: async (targetId: string, options: unknown) => {
        navigated.push([targetId, options])
        if (targetId === 'fail') throw new Error('Entry fail not found')
        return { cancelled: targetId === 'cancel' }
      },
      ui: {
        setStatus: (key: string, text: string) => statuses.push([key, text]),
      },
    }

    hooks[0]!({}, ctx)
    expect(statuses).toEqual([[NAVIGATE_READY_STATUS, '1']])

    const cmd = commands.get(NAVIGATE_COMMAND)!
    await cmd.handler(JSON.stringify({ reqId: 'r1', targetId: 'leaf-a' }), ctx)
    await cmd.handler(JSON.stringify({ reqId: 'r2', targetId: 'cancel' }), ctx)
    await cmd.handler(JSON.stringify({ reqId: 'r3', targetId: 'fail' }), ctx)

    expect(navigated).toEqual([
      ['leaf-a', { summarize: false }],
      ['cancel', { summarize: false }],
      ['fail', { summarize: false }],
    ])
    expect(statuses.slice(1)).toEqual([
      [NAVIGATE_STATUS, JSON.stringify({ reqId: 'r1', ok: true, cancelled: false })],
      [NAVIGATE_STATUS, JSON.stringify({ reqId: 'r2', ok: true, cancelled: true })],
      [NAVIGATE_STATUS, JSON.stringify({ reqId: 'r3', ok: false, error: 'Entry fail not found' })],
    ])
  })
})
