import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { inThreadWorker } from '../testing/thread-worker'
import { ThreadStore } from '../threads/store'
import { ArtifactService, BODY_BYTES, sessionServiceName } from './service'
import { ArtifactStore } from './store'
import { INSTRUCTIONS } from './tools'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup() {
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
    turnRunning: () => false,
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
  const connect = async (sessionId: string, project: string) => {
    const [server] = service.servers(sessionId, project)
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
    const req = http.request(url, { method: options.method ?? 'POST', headers: options.headers })
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
    expect(service.servers('s3', '/p', 'overbench-1a2b')[0]).toMatchObject({
      name: 'overbench-1a2b',
    })
    expect(sessionServiceName('1A2B3C4D-0000-4000-8000-000000000000')).toBe('overbench-1a2b')
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
    const tooBig = await send(url, {
      headers: headers(token),
      body: call('x'.repeat(BODY_BYTES)),
    }).catch((error: NodeJS.ErrnoException) => ({ status: error.code ?? 'error' }))
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(tooBig.status)
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
