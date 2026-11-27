import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { MarketServer } from '@shared/marketplace'
import type { Platform } from '@shared/platform'
import { ArtifactService, type ArtifactServiceDeps } from '../artifacts/service'
import { Answers } from './answers'
import { ToolChanges } from './tool-changes'
import {
  BRIDGE_UPGRADE,
  McpRouter,
  routingHeaders,
  serverPath,
  type RouterCall,
  type ServerCommand,
} from './router'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

/** A remote server on the old SSE transport that takes only `valid` tokens. */
async function sseServer(valid: Set<string>) {
  const seen: { method: string; authorization: string }[] = []
  const sessions = new Map<string, SSEServerTransport>()
  const httpServer = http.createServer((req, res) => {
    const authorization = req.headers.authorization ?? ''
    seen.push({ method: req.method ?? '', authorization })
    if (!valid.has(authorization.slice('Bearer '.length))) {
      res.writeHead(401).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res)
      sessions.set(transport.sessionId, transport)
      const server = new Server(
        { name: 'sse-docs', version: '1.0.0' },
        { capabilities: { tools: {} } },
      )
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [{ name: 'lookup', description: 'Looks up.', inputSchema: { type: 'object' } }],
      }))
      server.setRequestHandler(CallToolRequestSchema, (request) => ({
        content: [{ type: 'text', text: `found ${String(request.params.arguments?.q)}` }],
      }))
      void server.connect(transport)
      return
    }
    const transport = sessions.get(url.searchParams.get('sessionId') ?? '')
    if (req.method === 'POST' && transport) {
      void transport.handlePostMessage(req, res)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections()
        httpServer.close(() => resolve())
      }),
  )
  const port = (httpServer.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/sse`, seen }
}

/** A remote Streamable HTTP server, stateless, that takes only the bearer `valid`. */
async function streamableServer(valid: string) {
  const seen: string[] = []
  const httpServer = http.createServer((req, res) => {
    const authorization = req.headers.authorization ?? ''
    seen.push(authorization)
    if (authorization !== `Bearer ${valid}`) {
      res.writeHead(401).end()
      return
    }
    const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        { name: 'read', inputSchema: { type: 'object' } },
        { name: 'wipe', inputSchema: { type: 'object' } },
      ],
    }))
    server.setRequestHandler(CallToolRequestSchema, (request) => ({
      content: [{ type: 'text', text: `did ${request.params.name}` }],
    }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    void server.connect(transport).then(() => transport.handleRequest(req, res))
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections()
        httpServer.close(() => resolve())
      }),
  )
  const port = (httpServer.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/mcp`, seen }
}

/** A command server: newline JSON-RPC on its standard input and output, its key in its env. */
const COMMAND_SERVER = `
const readline = require('node:readline')
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'echo', version: '1.0.0' },
    } })
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'where', inputSchema: { type: 'object' } },
      { name: 'erase', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
    ] } })
  } else if (message.method === 'tools/call' && message.params.name === 'erase') {
    process.stderr.write('erased\\n')
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'erased' }] } })
  } else if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text',
      text: process.cwd() + '|' + (process.env.ECHO_KEY === 'k-secret') }] } })
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } })
  }
})
`

async function setup(
  servers: MarketServer[],
  tokens: { token?: string; renewed?: string } = {},
  given: readonly MarketServer[] = servers,
  tools?: ToolChanges,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kettu-router-'))
  closers.push(() => rm(dir, { recursive: true, force: true }))
  const script = path.join(dir, 'echo.cjs')
  await writeFile(script, COMMAND_SERVER)
  const refused: string[] = []
  const calls: RouterCall[] = []
  const deps = {
    signsIn: (server: MarketServer) => server.spec.type === 'http' && !!server.spec.oauth,
    headers: () => ({}),
    token: async () => tokens.token ?? null,
    refused: async (_: string, used: string) => {
      refused.push(used)
      return tokens.renewed ?? null
    },
  }
  const router = new McpRouter({
    ...deps,
    servers: () => servers,
    called: (call: RouterCall) => void calls.push(call),
    command: (): ServerCommand => ({
      command: process.execPath,
      args: [script],
      env: { PATH: process.env.PATH ?? '', ECHO_KEY: 'k-secret' },
    }),
    answers: new Answers(null),
    ...(tools ? { tools } : {}),
    appVersion: '0.0.0',
    home: dir,
    log: () => {},
    processes: { platform: process.platform as Platform },
  })
  closers.push(() => router.close())
  const service = new ArtifactService({
    log: () => {},
    plan: {},
    sessions: {},
    router,
  } as unknown as ArtifactServiceDeps)
  await service.start()
  closers.push(() => service.stop())
  const access = service.routerAccess('s1', dir, null)!
  access.allow(given.map((server) => server.id))
  return { dir, access, refused, router, calls }
}

async function agentClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'agent', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  closers.push(() => client.close())
  return client
}

/** What the bridge does: an Upgrade on the service's port, then newline JSON-RPC. */
function bridge(origin: string, name: string, headers: Record<string, string>) {
  const { port } = new URL(origin)
  const socket = net.connect(Number(port), '127.0.0.1')
  closers.push(async () => void socket.destroy())
  const lines: unknown[] = []
  let text = ''
  const head = new Promise<string>((resolve) => {
    let upgraded = false
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (!upgraded) {
        const end = text.indexOf('\r\n\r\n')
        if (end < 0) return
        upgraded = true
        resolve(text.slice(0, end))
        text = text.slice(end + 4)
      }
      let newline: number
      while ((newline = text.indexOf('\n')) >= 0) {
        if (newline > 0) lines.push(JSON.parse(text.slice(0, newline)))
        text = text.slice(newline + 1)
      }
    })
    socket.on('end', () => {
      if (!upgraded) resolve(text)
    })
  })
  const request = Object.entries({
    Host: `127.0.0.1:${port}`,
    Connection: 'Upgrade',
    Upgrade: BRIDGE_UPGRADE,
    ...headers,
  })
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join('')
  socket.write(`GET /bridge/${encodeURIComponent(name)} HTTP/1.1\r\n${request}\r\n`)
  const send = (message: unknown) => socket.write(JSON.stringify(message) + '\n')
  const answer = async (id: number) => {
    for (let wait = 0; wait < 200; wait++) {
      const found = lines.find((line) => (line as { id?: number }).id === id)
      if (found) return found as { result?: Record<string, unknown>; error?: { message: string } }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`No answer to ${id}`)
  }
  return { head, send, answer }
}

const echo: MarketServer = {
  id: 'manual:echo',
  name: 'echo',
  title: 'Echo',
  source: 'manual',
  version: '1.0.0',
  spec: { type: 'stdio', command: 'echo-mcp', args: [], env: [] },
  agents: 'all',
  on: true,
}

const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'kimi', version: '1' },
}

describe('the bridge connection', () => {
  it("answers a command server's tools over the upgraded stream, run in the session's folder", async () => {
    const { access, dir } = await setup([echo])
    const line = bridge(access.origin, 'echo', { Authorization: `Bearer ${access.token}` })
    expect(await line.head).toMatch(/^HTTP\/1\.1 101 /)
    line.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT })
    expect((await line.answer(1)).result).toMatchObject({ serverInfo: { name: 'echo' } })
    line.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    line.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'where', arguments: {} },
    })
    const called = (await line.answer(2)).result as { content: { text: string }[] }
    const [cwd, keyed] = called.content[0]!.text.split('|')
    expect(path.basename(cwd!)).toBe(path.basename(dir))
    expect(keyed).toBe('true')
  })

  it('refuses a token Kettu did not give, a page, another host and a server not given', async () => {
    const other = { ...echo, id: 'manual:other', name: 'other' }
    const { access } = await setup([echo, other], {}, [echo])
    const status = async (name: string, headers: Record<string, string>) =>
      (await bridge(access.origin, name, headers).head).split('\r\n')[0]
    const auth = { Authorization: `Bearer ${access.token}` }
    expect(await status('echo', { Authorization: 'Bearer guessed' })).toMatch(/ 401 /)
    expect(await status('echo', { ...auth, Origin: 'https://evil.example' })).toMatch(/ 403 /)
    expect(await status('echo', { ...auth, Host: 'evil.example' })).toMatch(/ 403 /)
    expect(await status('other', auth)).toMatch(/ 403 /)
    expect(await status('missing', auth)).toMatch(/ 404 /)
  })
})

describe('what an agent may use of a server', () => {
  it('leaves a tool turned off out of the list and refuses a call to it', async () => {
    const servers = [{ ...echo, toolsOff: ['erase'] }]
    const { access, calls } = await setup(servers)
    const client = await agentClient(`${access.origin}${serverPath(echo.id)}`, access.token)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['where'])
    await expect(client.callTool({ name: 'erase', arguments: {} })).rejects.toThrow(
      /turned off in Kettu/,
    )
    expect(calls.map((call) => [call.outcome.tool, call.outcome.result])).toEqual([
      ['erase', 'refused'],
    ])
  })

  it('serves no tools and refuses every call while the server is off for the session', async () => {
    const { access, router } = await setup([echo])
    const client = await agentClient(`${access.origin}${serverPath(echo.id)}`, access.token)
    expect((await client.listTools()).tools).toHaveLength(2)
    router.setSessionOff('s1', echo.id, true)
    expect((await client.listTools()).tools).toEqual([])
    await expect(client.callTool({ name: 'where', arguments: {} })).rejects.toThrow(
      /turned off for this session/,
    )
    router.setSessionOff('s1', echo.id, false)
    expect((await client.listTools()).tools).toHaveLength(2)
  })

  it("records a call's metadata without what was sent or returned, and keeps its stderr", async () => {
    const { access, calls, router } = await setup([echo])
    const client = await agentClient(`${access.origin}${serverPath(echo.id)}`, access.token)
    await client.callTool({ name: 'erase', arguments: { path: '/private/notes-arg' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ serverId: echo.id, sessionId: 's1' })
    expect(calls[0]!.outcome).toMatchObject({ tool: 'erase', result: 'ok' })
    const text = JSON.stringify(calls)
    expect(text).not.toContain('/private/notes-arg')
    expect(text).not.toContain('erased')
    for (let wait = 0; wait < 40 && router.logsOf(echo.id)[0]?.text !== 'erased\n'; wait++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(router.logsOf(echo.id)).toMatchObject([{ serverId: echo.id, text: 'erased\n' }])
  })
})

describe('tools that changed since the user accepted them', () => {
  /** What the user accepted of echo: `where` with another description, and no `erase`. */
  function accepted(serverId: string): ToolChanges {
    const tools = new ToolChanges(null)
    tools.seen(
      serverId,
      [{ name: 'where', description: 'Says where.', inputSchema: { type: 'object' } }],
      'list',
    )
    return tools
  }

  it('leaves a changed and a new tool of an untrusted server out of the list and refuses them', async () => {
    const tools = accepted(echo.id)
    const { access, calls } = await setup([echo], {}, [echo], tools)
    const client = await agentClient(`${access.origin}${serverPath(echo.id)}`, access.token)
    expect((await client.listTools()).tools).toEqual([])
    await expect(client.callTool({ name: 'where', arguments: {} })).rejects.toThrow(
      /changed since the user accepted it/,
    )
    await expect(client.callTool({ name: 'erase', arguments: {} })).rejects.toThrow(/is new/)
    expect(calls.map((call) => call.outcome.result)).toEqual(['refused', 'refused'])
    expect(tools.changes(echo.id, 'hold')).toMatchObject({ added: ['erase'], changed: ['where'] })
  })

  it('hands a tool on once the user accepts it, the rest still held', async () => {
    const tools = accepted(echo.id)
    const { access } = await setup([echo], {}, [echo], tools)
    const client = await agentClient(`${access.origin}${serverPath(echo.id)}`, access.token)
    expect((await client.listTools()).tools).toEqual([])
    tools.accept(echo.id, ['where'])
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['where'])
    const result = await client.callTool({ name: 'where', arguments: {} })
    expect(result.isError).not.toBe(true)
    await expect(client.callTool({ name: 'erase', arguments: {} })).rejects.toThrow(/is new/)
  })

  it('only notes the change for a registry server, whose tools agents keep', async () => {
    const registry: MarketServer = { ...echo, id: 'com.example/echo', source: 'registry' }
    const tools = accepted(registry.id)
    const { access } = await setup([registry], {}, [registry], tools)
    const client = await agentClient(`${access.origin}${serverPath(registry.id)}`, access.token)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['where', 'erase'])
    await client.callTool({ name: 'erase', arguments: {} })
    expect(tools.changes(registry.id, 'note')).toMatchObject({ added: ['erase'] })
  })

  it('takes the first list it sees of a server as accepted', async () => {
    const tools = new ToolChanges(null)
    const { access } = await setup([echo], {}, [echo], tools)
    const client = await agentClient(`${access.origin}${serverPath(echo.id)}`, access.token)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['where', 'erase'])
    expect(tools.changes(echo.id, 'hold')).toBeNull()
    await client.callTool({ name: 'erase', arguments: {} })
  })
})

describe('a remote server on SSE', () => {
  const docs = (url: string, oauth: boolean): MarketServer => ({
    id: 'com.example/docs',
    name: 'docs',
    title: 'Docs',
    source: 'registry',
    version: '1.0.0',
    spec: {
      type: 'http',
      transport: 'sse',
      url,
      headers: [],
      ...(oauth ? { oauth: { flow: 'browser' as const } } : {}),
    },
    agents: 'all',
    on: true,
  })

  it('is offered to an agent as Streamable HTTP, with the sign-in renewed once on a 401', async () => {
    const remote = await sseServer(new Set(['fresh']))
    const { access, refused } = await setup([docs(remote.url, true)], {
      token: 'stale',
      renewed: 'fresh',
    })
    const client = await agentClient(
      `${access.origin}${serverPath('com.example/docs')}`,
      access.token,
    )
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['lookup'])
    const result = await client.callTool({ name: 'lookup', arguments: { q: 'mcp' } })
    expect(result.content).toEqual([{ type: 'text', text: 'found mcp' }])
    expect(refused[0]).toBe('stale')
    expect(remote.seen.every((seen) => !seen.authorization.includes(access.token))).toBe(true)
  })

  it('never reaches the server for a caller without the session token', async () => {
    const remote = await sseServer(new Set(['fresh']))
    const { access } = await setup([docs(remote.url, true)], { token: 'fresh' })
    const answer = await fetch(`${access.origin}${serverPath('com.example/docs')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }),
    })
    expect(answer.status).toBe(401)
    expect(remote.seen).toHaveLength(0)
  })
})

describe('a remote Streamable HTTP server', () => {
  it("is forwarded with the user's sign-in, never the session's token, its tools filtered", async () => {
    const remote = await streamableServer('fresh')
    const notes: MarketServer = {
      id: 'com.example/notes',
      name: 'notes',
      title: 'Notes',
      source: 'registry',
      version: '1.0.0',
      spec: {
        type: 'http',
        transport: 'streamable-http',
        url: remote.url,
        headers: [],
        oauth: { flow: 'browser' },
      },
      agents: 'all',
      on: true,
      toolsOff: ['wipe'],
    }
    const { access } = await setup([notes], { token: 'fresh' })
    const client = await agentClient(`${access.origin}${serverPath(notes.id)}`, access.token)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['read'])
    const result = await client.callTool({ name: 'read', arguments: {} })
    expect(result.content).toEqual([{ type: 'text', text: 'did read' }])
    await expect(client.callTool({ name: 'wipe', arguments: {} })).rejects.toThrow(/turned off/)
    expect(remote.seen.length).toBeGreaterThan(0)
    expect(remote.seen.every((seen) => seen === 'Bearer fresh')).toBe(true)
  })
})

describe('a remote server that needs sign-in', () => {
  it('answers the agent with an error that says to sign in in Kettu, never an HTTP 401', async () => {
    const remote = await streamableServer('fresh')
    const notes: MarketServer = {
      id: 'com.example/notes',
      name: 'notes',
      title: 'Notes',
      source: 'registry',
      version: '1.0.0',
      spec: {
        type: 'http',
        transport: 'streamable-http',
        url: remote.url,
        headers: [],
        oauth: { flow: 'browser' },
      },
      agents: 'all',
      on: true,
    }
    const { access } = await setup([notes])
    const answer = await fetch(`${access.origin}${serverPath(notes.id)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }),
    })
    expect(answer.status).not.toBe(401)
    expect(await answer.text()).toContain(
      "notes needs sign-in; sign in to it in Kettu's Marketplace",
    )
    expect(remote.seen).toHaveLength(0)
  })
})

describe('routingHeaders', () => {
  it("names a stateless request's method and target, and nothing for a legacy one", () => {
    const modern = new Headers()
    routingHeaders(
      modern,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'lookup',
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
        },
      }),
    )
    expect(modern.get('mcp-method')).toBe('tools/call')
    expect(modern.get('mcp-name')).toBe('lookup')
    const legacy = new Headers()
    routingHeaders(legacy, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect(legacy.get('mcp-method')).toBeNull()
  })
})
