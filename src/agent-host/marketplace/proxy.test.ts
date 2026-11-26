import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { MarketServer } from '@shared/marketplace'
import { ArtifactService, type ArtifactServiceDeps } from '../artifacts/service'
import { Answers } from '../mcp-router/answers'
import { McpRouter, serverPath } from '../mcp-router/router'
import { McpProxy, proxyPath } from './proxy'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

interface Seen {
  method: string
  headers: http.IncomingHttpHeaders
  body: string
}

/** The remote MCP server: it takes `valid` tokens, answers JSON or an event stream. */
async function upstream(valid: Set<string>) {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', headers: req.headers, body })
      if (!valid.has(req.headers.authorization?.slice('Bearer '.length) ?? '')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' }).end()
        return
      }
      if (req.method === 'DELETE') {
        res.writeHead(204).end()
        return
      }
      if (req.method === 'GET' || body.includes('tools/list')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'up-1' })
        res.write('id: 1\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n')
        setTimeout(() => {
          res.end('id: 2\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n')
        }, 20)
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'up-1' })
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen }
}

async function setup(options: {
  valid: string[]
  token: string
  renewed: string | null
  handed?: boolean
}) {
  const remote = await upstream(new Set(options.valid))
  const server: MarketServer = {
    id: 'com.notion/mcp',
    name: 'notion',
    title: 'Notion',
    source: 'registry',
    version: '1.0.1',
    spec: {
      type: 'http',
      transport: 'streamable-http',
      url: remote.url,
      headers: [{ name: 'X-Read-Only', value: 'true' }],
      oauth: { flow: 'browser' },
    },
    agents: 'all',
    on: true,
  }
  const refused: string[] = []
  const tokens = {
    signsIn: () => true,
    headers: () => ({ 'X-Read-Only': 'true' }),
    token: async () => options.token,
    refused: async (_: string, used: string) => {
      refused.push(used)
      return options.renewed
    },
  }
  const proxy = new McpProxy(tokens)
  const router = new McpRouter({
    ...tokens,
    servers: () => [server],
    command: () => 'not a command',
    proxy,
    answers: new Answers(null),
    appVersion: '0.0.0',
    home: '/',
    log: () => {},
  })
  const service = new ArtifactService({
    log: () => {},
    plan: {},
    sessions: {},
    router,
  } as unknown as ArtifactServiceDeps)
  await service.start()
  closers.push(() => service.stop())
  const bearer = service.routerAccess('s1', '/repo', null)!
  if (options.handed !== false) bearer.allow([server.id])
  const url = `${bearer.origin}${serverPath(server.id)}`
  const ask = (init: RequestInit & { headers?: Record<string, string> } = {}, to = url) =>
    fetch(to, {
      method: 'POST',
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      ...init,
      headers: {
        Authorization: `Bearer ${bearer.token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  return { remote, service, bearer, url, ask, refused }
}

describe('the router to a remote server', () => {
  it('refuses a page, a name that only resolves here, and a server the session was not given', async () => {
    const { ask, remote, url } = await setup({
      valid: ['access-1'],
      token: 'access-1',
      renewed: null,
    })
    expect((await ask({ headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    const port = new URL(url).port
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: new URL(url).pathname,
          method: 'POST',
          headers: { Host: `evil.example:${port}` },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(rebound).toBe(403)
    expect(remote.seen).toHaveLength(0)
    const other = await setup({
      valid: ['access-1'],
      token: 'access-1',
      renewed: null,
      handed: false,
    })
    expect((await other.ask()).status).toBe(403)
    expect(other.remote.seen).toHaveLength(0)
  })

  it('still answers the path sessions started before the router used', async () => {
    const { ask, url } = await setup({ valid: ['access-1'], token: 'access-1', renewed: null })
    const old = url.replace(/\/servers\/([0-9a-f]+)$/, (_, digest: string) =>
      proxyPath('com.notion/mcp') === `/proxy/${digest}` ? `/proxy/${digest}` : '',
    )
    expect(old).toContain('/proxy/')
    expect((await ask({}, old)).status).toBe(200)
  })
})

describe('the proxy to an OAuth server', () => {
  it("forwards with the sign-in's token in place of the agent's, and the MCP headers both ways", async () => {
    const { remote, ask } = await setup({ valid: ['access-1'], token: 'access-1', renewed: null })
    const answer = await ask({
      headers: { 'Mcp-Session-Id': 'up-1', 'Mcp-Protocol-Version': '2025-06-18', Cookie: 'x=1' },
    })
    expect(answer.status).toBe(200)
    expect(answer.headers.get('mcp-session-id')).toBe('up-1')
    expect(await answer.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    const sent = remote.seen[0]!
    expect(sent.headers).toMatchObject({
      authorization: 'Bearer access-1',
      'mcp-session-id': 'up-1',
      'mcp-protocol-version': '2025-06-18',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-read-only': 'true',
    })
    expect(sent.headers).not.toHaveProperty('cookie')
    expect(sent.body).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}')
  })

  it('streams an event stream back as it comes, and passes Last-Event-ID on a GET', async () => {
    const { remote, ask } = await setup({ valid: ['access-1'], token: 'access-1', renewed: null })
    const answer = await ask({ body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' })
    expect(answer.headers.get('content-type')).toBe('text/event-stream')
    const text = await answer.text()
    expect(text).toContain('notifications/progress')
    expect(text).toContain('"id":2')
    const resumed = await ask({ method: 'GET', body: null, headers: { 'Last-Event-ID': '1' } })
    expect(resumed.status).toBe(200)
    await resumed.text()
    expect(remote.seen[1]!.headers['last-event-id']).toBe('1')
    const ended = await ask({ method: 'DELETE', body: null, headers: { 'Mcp-Session-Id': 'up-1' } })
    expect(ended.status).toBe(204)
  })

  it('renews once when the server refuses the token, then answers with the new one', async () => {
    const { remote, ask, refused } = await setup({
      valid: ['access-2'],
      token: 'access-1',
      renewed: 'access-2',
    })
    const answer = await ask()
    expect(answer.status).toBe(200)
    expect(refused).toEqual(['access-1'])
    expect(remote.seen.map((seen) => seen.headers.authorization)).toEqual([
      'Bearer access-1',
      'Bearer access-2',
    ])
  })

  it('answers 401 when the token cannot be renewed', async () => {
    const { ask } = await setup({ valid: [], token: 'access-1', renewed: null })
    const answer = await ask()
    expect(answer.status).toBe(401)
    expect(await answer.text()).toMatch(/connecting again/)
  })

  it("refuses a request without the session's bearer, or to a server it does not proxy", async () => {
    const { url, ask, remote, bearer } = await setup({
      valid: ['access-1'],
      token: 'access-1',
      renewed: null,
    })
    expect((await ask({ headers: { Authorization: 'Bearer forged' } })).status).toBe(401)
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401)
    const elsewhere = url.replace(/[0-9a-f]+$/, '0'.repeat(24))
    expect(
      (
        await fetch(elsewhere, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer.token}` },
        })
      ).status,
    ).toBe(404)
    expect(remote.seen).toHaveLength(0)
  })

  it("does not let a token made for the library alone reach Kettu's own server", async () => {
    const { service, bearer } = await setup({ valid: [], token: 'x', renewed: null })
    const own = await fetch(`${bearer.origin}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(own.status).toBe(403)
    // Once Kettu's own server is on for the session, the same token reaches both.
    const [entry] = service.servers('s1', '/repo')
    expect(entry && 'headers' in entry ? entry.headers[0]!.value : null).toBe(
      `Bearer ${bearer.token}`,
    )
  })
})
