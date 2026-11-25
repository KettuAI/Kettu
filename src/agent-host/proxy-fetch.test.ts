import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from './find-command'
import { isLoopback, proxyEnvFor, proxyFetch } from './proxy-fetch'

const servers: Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

/**
 * A proxy that answers plain http requests itself, as the origin would, and refuses tunnels;
 * what it was asked is in `seen` and `tunnels`.
 */
async function proxy(answer: (seen: Seen, res: ServerResponse) => void): Promise<{
  url: string
  seen: Seen[]
  tunnels: string[]
}> {
  const seen: Seen[] = []
  const tunnels: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const request = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }
      seen.push(request)
      answer(request, res)
    })
  })
  server.on('connect', (req: IncomingMessage, socket) => {
    tunnels.push(req.url ?? '')
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, tunnels }
}

describe('which requests take the proxy', () => {
  it('knows the addresses of this computer', () => {
    for (const host of ['localhost', 'LOCALHOST.', 'app.localhost', '127.0.0.1', '127.9.8.7']) {
      expect(isLoopback(host), host).toBe(true)
    }
    for (const url of ['http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/']) {
      expect(isLoopback(new URL(url).hostname), url).toBe(true)
    }
    for (const host of ['example.com', 'localhost.example.com', '10.0.0.1', '192.168.1.2']) {
      expect(isLoopback(host), host).toBe(false)
    }
  })

  it('hands Node.js the proxy of the scheme, never one for this computer', () => {
    const env: Env = { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: '.corp' }
    expect(proxyEnvFor(new URL('https://example.com/'), env, 'darwin')).toEqual({
      HTTPS_PROXY: 'http://proxy:8080',
      NO_PROXY: '.corp',
    })
    expect(proxyEnvFor(new URL('http://example.com/'), env, 'darwin')).toBeNull()
    expect(proxyEnvFor(new URL('https://localhost:4000/'), env, 'darwin')).toBeNull()
    expect(proxyEnvFor(new URL('https://127.0.0.1/'), env, 'darwin')).toBeNull()
    expect(proxyEnvFor(new URL('https://example.com/'), {}, 'darwin')).toBeNull()
  })

  it('reads lowercase variables, and any case on Windows', () => {
    expect(
      proxyEnvFor(new URL('http://example.com/'), { http_proxy: 'http://p:1' }, 'linux'),
    ).toEqual({ HTTP_PROXY: 'http://p:1' })
    expect(
      proxyEnvFor(new URL('https://example.com/'), { Https_Proxy: 'http://p:2' }, 'win32'),
    ).toEqual({ HTTPS_PROXY: 'http://p:2' })
    expect(
      proxyEnvFor(new URL('https://example.com/'), { Https_Proxy: 'http://p:2' }, 'darwin'),
    ).toBeNull()
  })
})

describe('a fetch through the proxy', () => {
  it('leaves a request with no proxy to the platform fetch', async () => {
    const platform = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('direct', { status: 200 }))
    const fetcher = proxyFetch(() => ({}), 'darwin')
    expect(await (await fetcher('https://example.com/a')).text()).toBe('direct')
    expect(platform).toHaveBeenCalledWith('https://example.com/a', undefined)
  })

  it("sends this computer's requests straight there, whatever the proxy", async () => {
    const via = await proxy((_seen, res) => res.end('from the proxy'))
    const local = await proxy((_seen, res) => res.end('local'))
    const fetcher = proxyFetch(() => ({ HTTP_PROXY: via.url, HTTPS_PROXY: via.url }), 'darwin')
    expect(await (await fetcher(`${local.url}/x`)).text()).toBe('local')
    expect(via.seen).toEqual([])
    expect(via.tunnels).toEqual([])
  })

  it('reads the proxy at each request', async () => {
    const first = await proxy((_seen, res) => res.end('first'))
    const second = await proxy((_seen, res) => res.end('second'))
    let current = first.url
    const fetcher = proxyFetch(() => ({ HTTP_PROXY: current }), 'darwin')
    expect(await (await fetcher('http://kettu.test/')).text()).toBe('first')
    current = second.url
    expect(await (await fetcher('http://kettu.test/')).text()).toBe('second')
  })

  it('sends the method, headers and body, and reads the answer as fetch does', async () => {
    const via = await proxy((_seen, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(gzipSync(JSON.stringify({ ok: true })))
    })
    const fetcher = proxyFetch(() => ({ HTTP_PROXY: via.url }), 'darwin')
    const response = await fetcher('http://kettu.test/token', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
      body: new URLSearchParams({ grant_type: 'code' }),
    })
    expect(response.status).toBe(201)
    expect(response.ok).toBe(true)
    expect(response.url).toBe('http://kettu.test/token')
    expect(await response.json()).toEqual({ ok: true })
    const [seen] = via.seen
    expect(seen?.method).toBe('POST')
    expect(seen?.url).toBe('http://kettu.test/token')
    expect(seen?.headers.authorization).toBe('Bearer t')
    expect(seen?.headers['content-type']).toContain('application/x-www-form-urlencoded')
    expect(seen?.headers['user-agent']).toBe('node')
    expect(seen?.body).toBe('grant_type=code')
  })

  it('drops the credentials on a redirect to another origin, and the body on a 303', async () => {
    const via = await proxy((seen, res) => {
      if (seen.url === 'http://kettu.test/start') {
        res.writeHead(303, { location: 'http://other.test/next' })
        return res.end()
      }
      res.end('done')
    })
    const fetcher = proxyFetch(() => ({ HTTP_PROXY: via.url }), 'darwin')
    const response = await fetcher('http://kettu.test/start', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' },
      body: 'payload',
    })
    expect(await response.text()).toBe('done')
    expect(response.redirected).toBe(true)
    expect(response.url).toBe('http://other.test/next')
    const next = via.seen[1]
    expect(next?.method).toBe('GET')
    expect(next?.headers.authorization).toBeUndefined()
    expect(next?.headers['content-type']).toBeUndefined()
    expect(next?.body).toBe('')
  })

  it('keeps the credentials on a redirect within the origin', async () => {
    const via = await proxy((seen, res) => {
      if (seen.url === 'http://kettu.test/a') {
        res.writeHead(302, { location: '/b' })
        return res.end()
      }
      res.end('b')
    })
    const fetcher = proxyFetch(() => ({ HTTP_PROXY: via.url }), 'darwin')
    await (await fetcher('http://kettu.test/a', { headers: { authorization: 'Bearer t' } })).text()
    expect(via.seen[1]?.url).toBe('http://kettu.test/b')
    expect(via.seen[1]?.headers.authorization).toBe('Bearer t')
  })

  it('refuses a redirect when asked to, and hands it back when asked for it', async () => {
    const via = await proxy((_seen, res) => {
      res.writeHead(302, { location: 'http://elsewhere.test/' })
      res.end()
    })
    const fetcher = proxyFetch(() => ({ HTTP_PROXY: via.url }), 'darwin')
    await expect(fetcher('http://kettu.test/', { redirect: 'error' })).rejects.toThrow(TypeError)
    const manual = await fetcher('http://kettu.test/', { redirect: 'manual' })
    expect(manual.status).toBe(302)
    expect(manual.headers.get('location')).toBe('http://elsewhere.test/')
    expect(via.seen).toHaveLength(2)
  })

  it('ends with the reason of an abort, before or during the answer', async () => {
    const via = await proxy((_seen, res) => {
      res.writeHead(200)
      res.write('partial')
    })
    const fetcher = proxyFetch(() => ({ HTTP_PROXY: via.url }), 'darwin')
    const early = AbortSignal.abort(new Error('stopped'))
    await expect(fetcher('http://kettu.test/', { signal: early })).rejects.toThrow('stopped')
    const controller = new AbortController()
    const response = await fetcher('http://kettu.test/', { signal: controller.signal })
    const text = response.text()
    controller.abort(new Error('cancelled'))
    await expect(text).rejects.toThrow('cancelled')
  })

  it('fails with the reason when the proxy cannot be reached or refuses the tunnel', async () => {
    const dead = proxyFetch(() => ({ HTTPS_PROXY: 'http://127.0.0.1:9' }), 'darwin')
    await expect(dead('https://kettu.test/')).rejects.toThrow(/ECONNREFUSED/)
    const via = await proxy((_seen, res) => res.end())
    const refusing = proxyFetch(() => ({ HTTPS_PROXY: via.url }), 'darwin')
    await expect(refusing('https://kettu.test/')).rejects.toThrow(/tunnel/)
    expect(via.tunnels).toEqual(['kettu.test:443'])
  })
})
