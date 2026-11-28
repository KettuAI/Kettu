import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect, createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Transport } from '@shared/remote/transport'
import { HandshakeLimits } from './limits'
import { MAX_HTTP_CONNECTIONS, MAX_HTTP_CONNECTIONS_PER_SOURCE, WebServer } from './web'

const TOKEN = 'A'.repeat(43)

let dir: string
let listener: Server
let web: WebServer
let base: string
let asked: { version: number | null; path: string }[]
let strict: boolean

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-web-frames-'))
  const files: Record<string, string> = {
    'index.html': '<!doctype html><html><head></head><body><p>hi</p></body></html>',
    'style.css': 'p{}',
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  asked = []
  strict = false
  web = new WebServer({
    root: null,
    server: {
      accept: () => {},
      refusedOne: () => {},
      frameFile: async (token, version, wanted) => {
        asked.push({ version, path: wanted })
        const text = token === TOKEN ? files[wanted] : undefined
        return text === undefined
          ? null
          : { file: path.join(dir, wanted), size: text.length, strict }
      },
    },
    limits: new HandshakeLimits(),
    log: () => {},
  })
  listener = createServer((socket) => web.take(socket))
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterEach(async () => {
  web.endAll()
  await new Promise((resolve) => listener.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

describe("the direct port's artifact frames", () => {
  it("serves a frame's files with their types, sandboxed to the frame's own folder", async () => {
    const page = await fetch(`${base}/frame/${TOKEN}/_kettu/v/2/index.html?page=0.1`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toContain('<style>')
    const csp = page.headers.get('content-security-policy')!
    expect(csp).toMatch(/^sandbox allow-scripts /)
    const own = `${new URL(base).host}/frame/${TOKEN}/`
    expect(csp).toContain(`script-src ${own} 'unsafe-inline'`)
    expect(csp).toContain(`connect-src ${own} `)
    expect(csp).not.toContain("'self' ")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(page.headers.get('access-control-allow-origin')).toBeNull()
    const css = await fetch(`${base}/frame/${TOKEN}/style.css`, { headers: { Origin: 'null' } })
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(css.headers.get('x-content-type-options')).toBe('nosniff')
    expect(css.headers.get('access-control-allow-origin')).toBe('null')
    expect(css.headers.get('cross-origin-resource-policy')).toBeNull()
    expect(await css.text()).toBe('p{}')
    expect(asked).toEqual([
      { version: 2, path: 'index.html' },
      { version: null, path: 'style.css' },
    ])
  })

  it('names no CDN in the frames of an artifact that reads beyond it', async () => {
    const loose = await fetch(`${base}/frame/${TOKEN}/index.html`)
    expect(loose.headers.get('content-security-policy')).toContain('https://cdn.jsdelivr.net')
    strict = true
    const tight = (await fetch(`${base}/frame/${TOKEN}/index.html`)).headers.get(
      'content-security-policy',
    )!
    expect(tight).toMatch(/^sandbox allow-scripts /)
    expect(tight).not.toContain('https:')
    expect(tight).toContain(`connect-src ${new URL(base).host}/frame/${TOKEN}/;`)
  })

  it.each([
    `/frame/${'B'.repeat(43)}/index.html`,
    `/frame/${TOKEN}/missing.css`,
    `/frame/${TOKEN}/_kettu/runtime.js`,
  ])('answers %s with not found, which the frame may read', async (pathname) => {
    const missing = await fetch(`${base}${pathname}`, { headers: { Origin: 'null' } })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('access-control-allow-origin')).toBe('null')
  })
})

describe('the direct port web client SPA routes with cache-busting query params', () => {
  it('serves index.html with no-cache for root and subpaths carrying _refresh query params', async () => {
    const webRoot = mkdtempSync(path.join(os.tmpdir(), 'kettu-web-root-'))
    mkdirSync(path.join(webRoot, 'assets'), { recursive: true })
    writeFileSync(
      path.join(webRoot, 'index.html'),
      '<!doctype html><html><body>kettu-web</body></html>',
    )
    writeFileSync(path.join(webRoot, 'assets', 'app-abc123.js'), 'console.log("ok")')

    const spaWeb = new WebServer({
      root: webRoot,
      server: {
        accept: () => {},
        refusedOne: () => {},
        frameFile: async () => null,
      },
      limits: new HandshakeLimits(),
      log: () => {},
    })
    const spaListener = createServer((socket) => spaWeb.take(socket))
    await new Promise<void>((resolve) => spaListener.listen(0, '127.0.0.1', resolve))
    const addr = spaListener.address()
    const spaBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

    try {
      for (const route of [
        '/?_refresh=1732776000000',
        '/pair?_refresh=1732776000000',
        '/session/1?x=1&_refresh=2',
      ]) {
        const res = await fetch(`${spaBase}${route}`)
        expect(res.status, route).toBe(200)
        expect(res.headers.get('cache-control'), route).toBe('no-cache')
        expect(res.headers.get('content-type'), route).toBe('text/html; charset=utf-8')
        expect(await res.text(), route).toContain('kettu-web')
      }

      const asset = await fetch(`${spaBase}/assets/app-abc123.js`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    } finally {
      spaWeb.endAll()
      await new Promise((resolve) => spaListener.close(resolve))
      rmSync(webRoot, { recursive: true, force: true })
    }
  })
})

describe('WebServer per-source and global HTTP connection limits', () => {
  interface LimitHarness {
    port: number
    accepted: Transport[]
    openPartial(remoteAddress: string): Promise<{ client: Socket; serverSocket: Socket }>
    httpGet(remoteAddress: string, pathname: string): Promise<{ status: number; body: string }>
    openChannel(remoteAddress: string): Promise<{ ws: WebSocket; serverSocket: Socket }>
    closeAndWait(client: Socket, serverSocket: Socket): Promise<void>
    cleanup(): Promise<void>
  }

  async function startLimitServer(options?: { requestTimeoutMs?: number }): Promise<LimitHarness> {
    const webRoot = mkdtempSync(path.join(os.tmpdir(), 'kettu-web-limits-'))
    writeFileSync(
      path.join(webRoot, 'index.html'),
      '<!doctype html><html><body>kettu-web</body></html>',
    )
    const accepted: Transport[] = []
    const limitsWeb = new WebServer({
      root: webRoot,
      server: {
        accept: (transport) => {
          accepted.push(transport)
        },
        refusedOne: () => {},
        frameFile: async () => null,
      },
      limits: new HandshakeLimits(),
      log: () => {},
      requestTimeoutMs: options?.requestTimeoutMs ?? 30_000,
    })

    const pendingRemotes: string[] = []
    const pendingTaken: ((socket: Socket) => void)[] = []
    const clients = new Set<Socket>()

    const limitListener = createServer((socket) => {
      const assigned = pendingRemotes.shift()
      if (assigned !== undefined) {
        Object.defineProperty(socket, 'remoteAddress', {
          configurable: true,
          get: () => (socket.destroyed ? undefined : assigned),
        })
      }
      limitsWeb.take(socket)
      pendingTaken.shift()?.(socket)
    })

    await new Promise<void>((resolve) => limitListener.listen(0, '127.0.0.1', resolve))
    const addr = limitListener.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const openPartial = async (
      remoteAddress: string,
    ): Promise<{ client: Socket; serverSocket: Socket }> => {
      pendingRemotes.push(remoteAddress)
      const taken = new Promise<Socket>((resolve) => pendingTaken.push(resolve))
      const client = connect({ host: '127.0.0.1', port })
      clients.add(client)
      client.on('error', () => {})
      client.once('close', () => clients.delete(client))
      client.once('connect', () => {
        client.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
      })
      const serverSocket = await taken
      return { client, serverSocket }
    }

    const httpGet = async (
      remoteAddress: string,
      pathname: string,
    ): Promise<{ status: number; body: string }> => {
      pendingRemotes.push(remoteAddress)
      const taken = new Promise<Socket>((resolve) => pendingTaken.push(resolve))
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: pathname,
            agent: false,
            headers: { Connection: 'close' },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            )
          },
        )
        req.on('error', reject)
        req.end()
      })
      const serverSocket = await taken
      const result = await response
      if (!serverSocket.destroyed) {
        await new Promise<void>((resolve) => serverSocket.once('close', () => resolve()))
      }
      return result
    }

    const openChannel = async (
      remoteAddress: string,
    ): Promise<{ ws: WebSocket; serverSocket: Socket }> => {
      pendingRemotes.push(remoteAddress)
      const taken = new Promise<Socket>((resolve) => pendingTaken.push(resolve))
      const ws = new WebSocket(`ws://127.0.0.1:${port}/channel`, {
        headers: { Origin: `http://127.0.0.1:${port}` },
      })
      const opened = new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
      const serverSocket = await taken
      await opened
      return { ws, serverSocket }
    }

    const closeAndWait = async (client: Socket, serverSocket: Socket): Promise<void> => {
      const closed = serverSocket.destroyed
        ? Promise.resolve()
        : new Promise<void>((resolve) => serverSocket.once('close', () => resolve()))
      client.destroy()
      await closed
    }

    return {
      port,
      accepted,
      openPartial,
      httpGet,
      openChannel,
      closeAndWait,
      cleanup: async () => {
        for (const client of clients) client.destroy()
        for (const transport of accepted) transport.close()
        limitsWeb.endAll()
        await new Promise((resolve) => limitListener.close(resolve))
        rmSync(webRoot, { recursive: true, force: true })
      },
    }
  }

  it('drops excess partial HTTP connections from one source while another source fetches / and upgrades /channel', async () => {
    const h = await startLimitServer()
    try {
      const held: { client: Socket; serverSocket: Socket }[] = []
      for (let i = 0; i < MAX_HTTP_CONNECTIONS_PER_SOURCE; i++) {
        const pair = await h.openPartial('192.0.2.10')
        expect(pair.serverSocket.destroyed).toBe(false)
        held.push(pair)
      }

      // Same IPv4 and its IPv4-mapped IPv6 address are both dropped once the per-source cap is full.
      const overflowV4 = await h.openPartial('192.0.2.10')
      expect(overflowV4.serverSocket.destroyed).toBe(true)
      const overflowMapped = await h.openPartial('::ffff:192.0.2.10')
      expect(overflowMapped.serverSocket.destroyed).toBe(true)

      // A second source can still fetch / and upgrade /channel to a WebSocket.
      const page = await h.httpGet('192.0.2.20', '/')
      expect(page.status).toBe(200)
      expect(page.body).toContain('kettu-web')

      const channel = await h.openChannel('192.0.2.20')
      expect(h.accepted.length).toBe(1)
      channel.ws.close()
      await new Promise<void>((resolve) => channel.ws.once('close', () => resolve()))

      // Closing a partial connection frees the source's slot cleanly.
      await h.closeAndWait(held[0]!.client, held[0]!.serverSocket)
      const recovered = await h.httpGet('192.0.2.10', '/')
      expect(recovered.status).toBe(200)
      expect(recovered.body).toContain('kettu-web')
    } finally {
      await h.cleanup()
    }
  })

  it('releases a source slot on WebSocket upgrade and does not double-decrement when the WebSocket closes', async () => {
    const h = await startLimitServer()
    try {
      const held: { client: Socket; serverSocket: Socket }[] = []
      for (let i = 0; i < MAX_HTTP_CONNECTIONS_PER_SOURCE - 1; i++) {
        const pair = await h.openPartial('192.0.2.30')
        expect(pair.serverSocket.destroyed).toBe(false)
        held.push(pair)
      }

      // Upgrading to /channel leaves the HTTP connection pool immediately.
      const channel = await h.openChannel('192.0.2.30')
      expect(h.accepted.length).toBe(1)

      // With the WebSocket still open, the source can still hold its full HTTP connection quota.
      const lastSlot = await h.openPartial('192.0.2.30')
      expect(lastSlot.serverSocket.destroyed).toBe(false)
      held.push(lastSlot)

      const overCap = await h.openPartial('192.0.2.30')
      expect(overCap.serverSocket.destroyed).toBe(true)

      // Closing the upgraded WebSocket must not decrement the HTTP count a second time.
      const wsClosed = new Promise<void>((resolve) =>
        channel.serverSocket.once('close', () => resolve()),
      )
      channel.ws.close()
      await wsClosed

      const stillOverCap = await h.openPartial('192.0.2.30')
      expect(stillOverCap.serverSocket.destroyed).toBe(true)

      // Closing one actual HTTP connection frees a slot.
      await h.closeAndWait(held[0]!.client, held[0]!.serverSocket)
      const reopened = await h.openPartial('192.0.2.30')
      expect(reopened.serverSocket.destroyed).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  it('reaps timed-out partial connections and lets the source reconnect', async () => {
    const h = await startLimitServer({ requestTimeoutMs: 60 })
    try {
      const closedPromises: Promise<void>[] = []
      for (let i = 0; i < MAX_HTTP_CONNECTIONS_PER_SOURCE; i++) {
        const pair = await h.openPartial('192.0.2.40')
        expect(pair.serverSocket.destroyed).toBe(false)
        closedPromises.push(
          new Promise<void>((resolve) => pair.serverSocket.once('close', () => resolve())),
        )
      }

      await Promise.all(closedPromises)

      const page = await h.httpGet('192.0.2.40', '/')
      expect(page.status).toBe(200)
      expect(page.body).toContain('kettu-web')
    } finally {
      await h.cleanup()
    }
  })

  it('still enforces the global HTTP connection cap across distinct sources', async () => {
    const h = await startLimitServer()
    try {
      const held: { client: Socket; serverSocket: Socket }[] = []
      const sources = Math.ceil(MAX_HTTP_CONNECTIONS / MAX_HTTP_CONNECTIONS_PER_SOURCE)
      for (let s = 0; s < sources && held.length < MAX_HTTP_CONNECTIONS; s++) {
        for (
          let i = 0;
          i < MAX_HTTP_CONNECTIONS_PER_SOURCE && held.length < MAX_HTTP_CONNECTIONS;
          i++
        ) {
          const pair = await h.openPartial(`10.10.${s}.1`)
          expect(pair.serverSocket.destroyed).toBe(false)
          held.push(pair)
        }
      }

      const overflow = await h.openPartial('10.99.0.1')
      expect(overflow.serverSocket.destroyed).toBe(true)

      await h.closeAndWait(held[0]!.client, held[0]!.serverSocket)
      const page = await h.httpGet('10.99.0.1', '/')
      expect(page.status).toBe(200)
    } finally {
      await h.cleanup()
    }
  })
})
