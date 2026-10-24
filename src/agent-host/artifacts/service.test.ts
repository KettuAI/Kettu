import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import { afterEach, describe, expect, it } from 'vitest'
import { inThreadWorker } from '../testing/thread-worker'
import { ThreadStore } from '../threads/store'
import { ArtifactService, BODY_BYTES, type AgentProcess } from './service'
import { ArtifactStore } from './store'
import { INSTRUCTIONS } from './tools'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** An agent process whose exit the test decides. */
function agentProcess(): AgentProcess & { exit(): void } {
  let exit = (): void => {}
  const closed = new Promise<void>((resolve) => (exit = resolve))
  return { closed, exit: () => exit() }
}

async function setup(sessionOf: (process: AgentProcess, id: string) => string | null = () => null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-artifact-service-'))
  const contentDir = path.join(dir, 'artifacts', 'content')
  const logs: string[] = []
  const log = (_level: string, message: string): void => void logs.push(message)
  const threads = new ThreadStore({
    file: path.join(dir, 'state', 'threads.db'),
    contentDir,
    createWorker: inThreadWorker,
    log,
  })
  const store = new ArtifactStore({
    threads,
    contentDir,
    log,
    changed: () => {},
    version: () => {},
    activity: () => {},
  })
  const service = new ArtifactService({
    store,
    sessionTitle: () => 'A session',
    runningTurn: () => null,
    sessionOf,
    log,
    appVersion: '0.0.0-test',
  })
  await service.start()
  const clients: Client[] = []
  cleanups.push(async () => {
    for (const client of clients) await client.close().catch(() => {})
    await service.stop()
    await threads.close()
    rmSync(dir, { recursive: true, force: true })
  })
  /** Connects the official MCP client with what an attach passed. */
  const connect = async (sessionId: string, project: string, given?: McpServer[]) => {
    const [server] = given ?? service.servers(sessionId, project)
    if (!server || !('headers' in server) || !('url' in server)) throw new Error('No server')
    const client = new Client({ name: 'test-agent', version: '1.0.0' })
    const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]))
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
    )
    clients.push(client)
    return { client, server, token: headers.Authorization!.slice('Bearer '.length) }
  }
  return { service, store, logs, connect }
}

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** A raw request, so a test chooses every header itself. */
function send(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    // A connection of its own: before Node 24.20, a keep-alive agent took back the socket of a
    // body whose write failed after the answer, and the write's EPIPE went unhandled
    // (https://github.com/nodejs/node/pull/64847).
    const req = http.request(url, {
      method: options.method ?? 'POST',
      headers: options.headers,
      agent: false,
    })
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      )
    })
    // A refusal may close the socket before the whole body is sent.
    req.on('error', reject)
    req.end(options.body)
  })
}

const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-06-18',
    ...extra,
  }
}

describe('the artifacts service', () => {
  it('listens on 127.0.0.1 and passes a token of 32 random bytes to each attach', async () => {
    const { service } = await setup()
    expect(service.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const [one] = service.servers('s1', '/p')
    const [two] = service.servers('s2', '/p')
    expect(one).toMatchObject({ type: 'http', name: 'overbench', url: service.url })
    const token = (server: typeof one) =>
      (server as { headers: { value: string }[] }).headers[0]!.value
    expect(token(one)).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/)
    expect(token(one)).not.toBe(token(two))
  })

  it('keeps a session token while the session stays, and makes a new one after', async () => {
    const { service } = await setup()
    const token = (sessionId: string) =>
      (service.servers(sessionId, '/p')[0] as { headers: { value: string }[] }).headers[0]!.value
    const first = token('s1')
    expect(token('s1')).toBe(first)
    service.revoke('s1')
    expect(token('s1')).not.toBe(first)
  })

  it('tells agents what it is for and serves the seven tools', async () => {
    const { connect } = await setup()
    const { client } = await connect('s1', '/p')
    expect(client.getInstructions()).toBe(INSTRUCTIONS)
    expect(client.getServerVersion()).toMatchObject({ name: 'overbench', version: '0.0.0-test' })
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toHaveLength(7)
    expect(tools.find((tool) => tool.name === 'delete_artifact')?.annotations).toMatchObject({
      destructiveHint: true,
    })
  })

  it('creates, updates and reads through the MCP client, errors included', async () => {
    const { connect } = await setup()
    const { client } = await connect('s1', '/p')
    await client.listTools()
    const created = await client.callTool({
      name: 'create_artifact',
      arguments: { title: 'Report', html: '<p>one</p>' },
    })
    const { id } = created.structuredContent as { id: string }
    expect(created.content).toEqual([
      { type: 'text', text: `Created ${id} version 1, a single page.` },
    ])
    await client.callTool({
      name: 'update_artifact',
      arguments: { id, base_version: 1, edits: [{ old_text: 'one', new_text: 'two' }] },
    })
    const read = await client.callTool({ name: 'read_artifact', arguments: { id } })
    expect(read.structuredContent).toMatchObject({ version: 2, html: '<p>two</p>' })
    // The client checks a refusal against the output schema too.
    const stale = await client.callTool({
      name: 'update_artifact',
      arguments: { id, base_version: 1, html: '<p>x</p>' },
    })
    expect(stale).toMatchObject({ isError: true, structuredContent: { code: 'conflict' } })
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(
      /Unknown tool/,
    )
  })

  it('keeps each token to its own session and project', async () => {
    const { connect } = await setup()
    const a = await connect('s1', '/projects/a')
    const b = await connect('s2', '/projects/b')
    const created = await a.client.callTool({
      name: 'create_artifact',
      arguments: { title: 'Only in A', html: '<p>a</p>' },
    })
    const { id } = created.structuredContent as { id: string }
    expect(await b.client.callTool({ name: 'read_artifact', arguments: { id } })).toMatchObject({
      isError: true,
      structuredContent: { code: 'not_found' },
    })
    expect(
      (await a.client.callTool({ name: 'list_artifacts', arguments: {} })).structuredContent,
    ).toMatchObject({ artifacts: [{ id }] })
    expect(
      (await b.client.callTool({ name: 'list_artifacts', arguments: {} })).structuredContent,
    ).toEqual({ artifacts: [] })
  })

  it('answers 401 without a known token, and once a token has ended', async () => {
    const { service, connect } = await setup()
    const url = service.url!
    const { token } = await connect('s1', '/p')
    expect((await send(url, { headers: headers(token), body: LIST })).status).toBe(200)
    for (const authorization of [undefined, 'Bearer ', `Basic ${token}`, `Bearer ${token}x`]) {
      const given = headers(token)
      if (authorization === undefined) delete given.Authorization
      else given.Authorization = authorization
      const reply = await send(url, { headers: given, body: LIST })
      expect(reply.status).toBe(401)
      expect(reply.headers['www-authenticate']).toBe('Bearer')
    }
    service.revoke('s1')
    expect((await send(url, { headers: headers(token), body: LIST })).status).toBe(401)
    const [next] = service.servers('s1', '/p')
    const nextToken = (next as { headers: { value: string }[] }).headers[0]!.value.slice(7)
    expect((await send(url, { headers: headers(nextToken), body: LIST })).status).toBe(200)
    expect((await send(url, { headers: headers(token), body: LIST })).status).toBe(401)
  })

  it('refuses web pages, other hosts, other methods and other paths', async () => {
    const { service, connect } = await setup()
    const url = service.url!
    const { token } = await connect('s1', '/p')
    const origin = await send(url, {
      headers: headers(token, { Origin: 'http://127.0.0.1:5173' }),
      body: LIST,
    })
    expect(origin.status).toBe(403)
    const nullOrigin = await send(url, { headers: headers(token, { Origin: 'null' }), body: LIST })
    expect(nullOrigin.status).toBe(403)
    const port = new URL(url).port
    for (const host of [`localhost:${port}`, `evil.example:${port}`, '127.0.0.1']) {
      const reply = await send(url, { headers: headers(token, { Host: host }), body: LIST })
      expect(reply.status).toBe(403)
    }
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const reply = await send(url, { method, headers: headers(token) })
      expect(reply.status).toBe(405)
      expect(reply.headers.allow).toBe('POST')
    }
    const other = await send(url.replace('/mcp', '/.well-known/oauth-protected-resource'), {
      method: 'GET',
      headers: headers(token),
    })
    expect(other.status).toBe(404)
    expect((await send(`${url}?x=1`, { headers: headers(token), body: LIST })).status).toBe(404)
  })

  it('takes JSON only, in bodies of at most 6 MiB', async () => {
    const { service, connect } = await setup()
    const url = service.url!
    const { token } = await connect('s1', '/p')
    const text = await send(url, {
      headers: headers(token, { 'Content-Type': 'text/plain' }),
      body: LIST,
    })
    expect(text.status).toBe(415)
    const form = await send(url, {
      headers: headers(token, { 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: LIST,
    })
    expect(form.status).toBe(415)
    const broken = await send(url, { headers: headers(token), body: '{"jsonrpc":' })
    expect(broken.status).toBe(400)

    const call = (html: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'create_artifact', arguments: { title: 'Big', html } },
      })
    // A declared length over the limit is refused before any of the body is read, so none is sent:
    // the service would close the connection while it was still being written.
    const tooBig = await send(url, {
      headers: headers(token, { 'Content-Length': String(BODY_BYTES + 1) }),
    })
    expect(tooBig.status).toBe(413)
    // Within the request limit, the HTML limit answers as a tool error.
    const html = await send(url, {
      headers: headers(token),
      body: call('x'.repeat(5 * 1024 * 1024 + 1)),
    })
    expect(html.status).toBe(200)
    expect(JSON.parse(html.body)).toMatchObject({
      result: { isError: true, structuredContent: { code: 'too_large' } },
    })
  })

  it('answers a probe for a newer protocol at once, so the client falls back', async () => {
    const { service, connect } = await setup()
    const { token } = await connect('s1', '/p')
    const discover = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'server/discover',
      params: {},
    })
    const legacy = await send(service.url!, { headers: headers(token), body: discover })
    expect(legacy.status).toBe(200)
    expect(JSON.parse(legacy.body)).toMatchObject({ id: 9, error: { code: -32601 } })
    // Claude Code sends the probe with the version it would speak.
    const newer = await send(service.url!, {
      headers: headers(token, { 'MCP-Protocol-Version': '2026-07-28' }),
      body: discover,
    })
    expect(newer.status).toBeGreaterThanOrEqual(400)
    expect(JSON.parse(newer.body)).toMatchObject({ error: { code: expect.any(Number) } })
  })

  it('gives an agent process one token per folder and tells the session from each call', async () => {
    const agent = agentProcess()
    const other = agentProcess()
    const ids = new Map([
      ['acp-1', 's1'],
      ['acp-2', 's2'],
      ['child-of-2', 's2'],
    ])
    const { service, store, connect } = await setup((process, id) =>
      process === agent ? (ids.get(id) ?? null) : null,
    )
    const one = service.folderServers(agent, '/p', 's1')
    expect(service.folderServers(agent, '/p', 's2')).toEqual(one)
    expect(one).toEqual([
      expect.objectContaining({ type: 'http', name: 'overbench', url: service.url }),
    ])
    const token = (servers: McpServer[]) =>
      (servers[0] as { headers: { value: string }[] }).headers[0]!.value
    expect(token(service.folderServers(agent, '/q', 's3'))).not.toBe(token(one))
    expect(token(service.folderServers(other, '/p', 's4'))).not.toBe(token(one))

    const { client } = await connect('s1', '/p', one)
    const created = await client.callTool({
      name: 'create_artifact',
      arguments: { title: 'Shared folder', html: '<p>1</p>' },
      _meta: { 'ai.opencode/sessionID': 'acp-1' },
    })
    const { id } = created.structuredContent as { id: string }
    await client.callTool({
      name: 'update_artifact',
      arguments: { id, base_version: 1, html: '<p>2</p>' },
      _meta: { 'ai.opencode/sessionID': 'child-of-2' },
    })
    const versions = await store.versions(id, { project: '/p' })
    expect(versions.map((v) => v.author)).toEqual(['s2', 's1'])
  })

  it('refuses a call that names no session of its process and folder', async () => {
    const agent = agentProcess()
    const ids = new Map([
      ['acp-1', 's1'],
      ['acp-3', 's3'],
    ])
    const { service, connect } = await setup((process, id) =>
      process === agent ? (ids.get(id) ?? null) : null,
    )
    const servers = service.folderServers(agent, '/p', 's1')
    service.folderServers(agent, '/q', 's3')
    const { client } = await connect('s1', '/p', servers)
    expect((await client.listTools()).tools).toHaveLength(7)
    const list = (meta?: Record<string, unknown>) =>
      client.callTool({ name: 'list_artifacts', arguments: {}, ...(meta ? { _meta: meta } : {}) })
    expect(await list({ 'ai.opencode/sessionID': 'acp-1' })).toMatchObject({
      structuredContent: { artifacts: [] },
    })
    // No id, an id OverBench does not know, one of another folder, and one that is not text.
    for (const meta of [
      undefined,
      { 'ai.opencode/sessionID': 'acp-9' },
      { 'ai.opencode/sessionID': 'acp-3' },
      { 'ai.opencode/sessionID': 1 },
    ]) {
      await expect(list(meta)).rejects.toThrow(/names no session of this agent in this folder/)
    }
  })

  it('ends a folder token when its last session leaves, or its process exits', async () => {
    const agent = agentProcess()
    const other = agentProcess()
    const { service } = await setup()
    const url = service.url!
    const token = (servers: McpServer[]) =>
      (servers[0] as { headers: { value: string }[] }).headers[0]!.value.slice('Bearer '.length)
    const shared = token(service.folderServers(agent, '/p', 's1'))
    service.folderServers(agent, '/p', 's2')
    service.revoke('s1')
    expect((await send(url, { headers: headers(shared), body: LIST })).status).toBe(200)
    service.revoke('s2')
    expect((await send(url, { headers: headers(shared), body: LIST })).status).toBe(401)
    const next = token(service.folderServers(agent, '/p', 's1'))
    expect(next).not.toBe(shared)

    const elsewhere = token(service.folderServers(agent, '/q', 's3'))
    const kept = token(service.folderServers(other, '/p', 's4'))
    agent.exit()
    await new Promise((resolve) => setImmediate(resolve))
    for (const ended of [next, elsewhere]) {
      expect((await send(url, { headers: headers(ended), body: LIST })).status).toBe(401)
    }
    expect((await send(url, { headers: headers(kept), body: LIST })).status).toBe(200)
  })

  it('ends every token when it stops', async () => {
    const { service, connect } = await setup()
    const { token } = await connect('s1', '/p')
    await service.stop()
    expect(service.url).toBeNull()
    expect(service.servers('s1', '/p')).toEqual([])
    await service.start()
    const reply = await send(service.url!, { headers: headers(token), body: LIST })
    expect(reply.status).toBe(401)
  })
})

describe('send', () => {
  it('leaves no error unhandled when the server answers and closes during the body', async () => {
    // Answers before reading the body, then closes, as the service does for an oversized body
    // whose drain times out.
    const server = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.once('data', () => {
        socket.pause()
        socket.write('HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n')
        setTimeout(() => socket.destroy(), 30)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const { port } = server.address() as net.AddressInfo
    // More than the loopback buffers take, so the write is still pending when the socket closes.
    const reply = await send(`http://127.0.0.1:${port}/`, { body: 'x'.repeat(16 * 1024 * 1024) })
    expect(reply.status).toBe(413)
    // The failed write of the rest of the body surfaces after the answer.
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
})
