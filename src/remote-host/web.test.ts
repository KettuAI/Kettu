// The web server on the direct port, through the listener on localhost: the client's files with
// their headers and cache rules, the frame artifacts run in, no way out of the root, and the
// WebSocket channel: who may open it, the limits, and its transport.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { connect, createServer, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket as WsClient, type ClientOptions } from 'ws'
import { ARTIFACT_CDNS } from '@shared/artifact-policy'
import type { Transport } from '@shared/remote/transport'
import { DirectListener } from './direct'
import { HandshakeLimits, SOURCE_BURST } from './limits'
import { WebServer } from './web'

const LOCALHOST = '127.0.0.1'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const INDEX = '<!doctype html><title>Kettu</title>'
const FRAME = '<!doctype html><title>Artifact</title>'
const SCRIPT = 'console.log("kettu")'
const SECRET = 'not for browsers'

const BUILD: Record<string, string> = {
  'index.html': INDEX,
  'frame.html': FRAME,
  'favicon.ico': 'icon',
  'manifest.webmanifest': '{}',
  'assets/index-B4x9.js': SCRIPT,
  'assets/index-C2e1.css': 'body{}',
  'assets/fonts/inter.woff2': 'font',
}

/** A build in `web/` beside a file it must never serve. */
async function build(files: Record<string, string> = BUILD): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-web-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'secret.txt'), SECRET)
  const root = path.join(dir, 'web')
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), text)
  }
  return root
}

async function serve(webRoot: string | null) {
  const accepted: Transport[] = []
  let refused = 0
  const limits = new HandshakeLimits()
  const direct = new DirectListener({
    server: {
      accept: (transport) => void accepted.push(transport),
      refusedOne: () => void refused++,
      setAddresses: () => {},
    },
    changed: () => {},
    log: () => {},
    host: LOCALHOST,
    interfaces: () => ({}),
    limits,
    webRoot,
  })
  cleanups.push(() => {
    direct.stop()
    for (const transport of accepted) transport.close()
  })
  await direct.apply({ enabled: true, port: 0, addresses: [] })
  const status = direct.status
  if (status.state !== 'listening') throw new Error(`Not listening: ${JSON.stringify(status)}`)
  return { port: status.port, accepted, limits, refused: () => refused }
}

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** A request with its path sent as it is, which fetch would have cleaned up first. */
function fetchRaw(
  port: number,
  pathname: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: LOCALHOST, port, path: pathname, method, headers, agent: false },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
      },
    )
    request.once('error', reject)
    request.end()
  })
}

function directives(policy: string | undefined): Map<string, string[]> {
  return new Map(
    (policy ?? '').split('; ').map((directive) => {
      const [name = '', ...sources] = directive.split(' ')
      return [name, sources]
    }),
  )
}

/** Opens a WebSocket, which rejects when the host does not take it. */
function openClient(
  port: number,
  pathname = '/channel',
  options?: ClientOptions,
): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const client = new WsClient(`ws://${LOCALHOST}:${port}${pathname}`, options)
    cleanups.push(() => client.terminate())
    client.once('open', () => resolve(client))
    client.once('error', reject)
  })
}

function closeCode(client: WsClient): Promise<number> {
  return new Promise((resolve) => client.once('close', (code) => resolve(code)))
}

function nextMessage(client: WsClient): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) =>
    client.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary })),
  )
}

/** The transport the host took for the newest WebSocket, and its client. */
async function channel(t: Awaited<ReturnType<typeof serve>>) {
  const client = await openClient(t.port)
  await expect.poll(() => t.accepted.length).toBeGreaterThan(0)
  return { client, transport: t.accepted.at(-1)! }
}

describe('the web server', () => {
  it('serves the page and its assets with their headers and cache rules', async () => {
    const { port } = await serve(await build())
    const page = await fetchRaw(port, '/')
    expect(page).toMatchObject({ status: 200, body: INDEX })
    expect(page.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(INDEX.length),
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'x-frame-options': 'DENY',
    })
    const policy = directives(page.headers['content-security-policy'] as string)
    expect(policy.get('default-src')).toEqual(["'self'"])
    expect(policy.get('script-src')).toEqual(["'self'"])
    expect(policy.get('connect-src')).toEqual(["'self'"])
    expect(policy.get('frame-ancestors')).toEqual(["'none'"])
    expect(policy.get('object-src')).toEqual(["'none'"])

    const script = await fetchRaw(port, '/assets/index-B4x9.js')
    expect(script).toMatchObject({ status: 200, body: SCRIPT })
    expect(script.headers).toMatchObject({
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    expect((await fetchRaw(port, '/assets/index-C2e1.css')).headers['content-type']).toBe(
      'text/css; charset=utf-8',
    )
    expect((await fetchRaw(port, '/assets/fonts/inter.woff2')).headers['content-type']).toBe(
      'font/woff2',
    )
    // Files at the top of the build are what they are, but could change with the next build.
    const icon = await fetchRaw(port, '/favicon.ico')
    expect(icon).toMatchObject({ status: 200, body: 'icon' })
    expect(icon.headers).toMatchObject({
      'content-type': 'image/x-icon',
      'cache-control': 'no-cache',
    })
    expect((await fetchRaw(port, '/manifest.webmanifest')).headers['content-type']).toBe(
      'application/manifest+json',
    )
  })

  it('answers HEAD with the headers alone', async () => {
    const { port } = await serve(await build())
    const head = await fetchRaw(port, '/assets/index-B4x9.js', 'HEAD')
    expect(head).toMatchObject({ status: 200, body: '' })
    expect(head.headers['content-length']).toBe(String(SCRIPT.length))
  })

  it('takes no other method', async () => {
    const { port } = await serve(await build())
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const answer = await fetchRaw(port, '/', method)
      expect(answer.status).toBe(405)
      expect(answer.headers.allow).toBe('GET, HEAD')
    }
  })

  it('answers the client routes with its page, and an unknown asset with 404', async () => {
    const { port } = await serve(await build())
    for (const route of ['/pair', '/pair?code=1', '/sessions/abc', '/index.html', '/assets']) {
      const answer = await fetchRaw(port, route)
      expect(answer, route).toMatchObject({ status: 200, body: INDEX })
      expect(answer.headers['cache-control']).toBe('no-cache')
    }
    const missing = await fetchRaw(port, '/assets/index-old.js')
    expect(missing.status).toBe(404)
    expect(missing.headers['content-type']).toBe('text/plain; charset=utf-8')
  })

  it("serves the artifact frame on an opaque origin that cannot reach the client's", async () => {
    const { port } = await serve(await build())
    for (const route of ['/frame.html', '/frame/art_01JC/?v=3&page=1.2', '/frame/art_01JC']) {
      const frame = await fetchRaw(port, route)
      expect(frame, route).toMatchObject({ status: 200, body: FRAME })
      expect(frame.headers).toMatchObject({
        'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      })
      expect(frame.headers['x-frame-options']).toBeUndefined()
      expect(frame.headers['permissions-policy']).toContain('camera=()')
      const csp = frame.headers['content-security-policy'] as string
      const policy = directives(csp)
      expect([...policy.keys()].slice(0, 3)).toEqual(['sandbox', 'frame-ancestors', 'default-src'])
      expect(policy.get('sandbox')).toEqual([
        'allow-scripts',
        'allow-popups',
        'allow-popups-to-escape-sandbox',
        'allow-forms',
        'allow-modals',
      ])
      expect(policy.get('frame-ancestors')).toEqual(["'self'"])
      expect(policy.get('default-src')).toEqual(["'none'"])
      expect(policy.get('script-src')).toEqual([
        "'unsafe-inline'",
        "'unsafe-eval'",
        'blob:',
        ...ARTIFACT_CDNS,
      ])
      expect(policy.get('connect-src')).toEqual([...ARTIFACT_CDNS])
      expect(policy.get('media-src')).toEqual(['data:', 'blob:'])
      expect(policy.get('frame-src')).toEqual(["'none'"])
      expect(policy.get('base-uri')).toEqual(["'none'"])
      // Only frame-ancestors names the client's origin.
      expect(csp.split("'self'")).toHaveLength(2)
    }
  })

  it('says a build without the client has none, and does not fail', async () => {
    const root = await build({ 'assets/index-B4x9.js': SCRIPT })
    for (const webRoot of [null, path.join(root, 'missing'), root]) {
      const { port } = await serve(webRoot)
      const answer = await fetchRaw(port, '/')
      expect(answer).toMatchObject({ status: 503, body: 'This Kettu has no web client.\n' })
      expect(answer.headers['content-type']).toBe('text/plain; charset=utf-8')
    }
  })

  it('never serves a file outside its build', async () => {
    const root = await build()
    await symlink(path.join(root, '../secret.txt'), path.join(root, 'linked.txt')).catch(() => {})
    const { port } = await serve(root)
    for (const route of [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/..%5csecret.txt',
      '//secret.txt',
      '/linked.txt',
    ]) {
      const answer = await fetchRaw(port, route)
      expect(answer.body, route).not.toContain(SECRET)
      expect([200, 400, 404], route).toContain(answer.status)
    }
  })
})

describe('HTTP connections', () => {
  it('are cut when slow to send a request, at first and after an answer', async () => {
    const web = new WebServer({
      root: null,
      server: { accept: (transport) => transport.close(), refusedOne: () => {} },
      limits: new HandshakeLimits(),
      log: () => {},
      requestTimeoutMs: 100,
    })
    const listener = createServer((socket) => web.take(socket))
    await new Promise<void>((resolve) => listener.listen(0, LOCALHOST, resolve))
    cleanups.push(() => {
      listener.close()
      web.endAll()
    })
    const { port } = listener.address() as { port: number }
    const open = (): Socket => {
      const socket = connect({ host: LOCALHOST, port })
      cleanups.push(() => void socket.destroy())
      return socket
    }
    /** Resolves once the host cuts it, well before the keep-alive timeout would. */
    const cut = (socket: Socket): Promise<void> =>
      new Promise((resolve, reject) => {
        const late = setTimeout(() => reject(new Error('Not cut')), 2_000)
        socket.once('close', () => {
          clearTimeout(late)
          resolve()
        })
      })

    const slow = open()
    const slowCut = cut(slow)
    slow.write('GET / HTTP/1.1\r\nHost: kettu\r\n')
    await slowCut

    const kept = open()
    const answered = new Promise<string>((resolve) =>
      kept.once('data', (chunk: Buffer) => resolve(chunk.toString())),
    )
    const keptCut = cut(kept)
    kept.write('GET / HTTP/1.1\r\nHost: kettu\r\n\r\n')
    expect(await answered).toMatch(/^HTTP\/1\.1 503 /)
    await keptCut
  })
})

describe('the WebSocket channel', () => {
  it('opens for a page of the same host, or a client that sends no Origin', async () => {
    const t = await serve(null)
    await openClient(t.port, '/channel', { origin: `http://${LOCALHOST}:${t.port}` })
    await openClient(t.port)
    await expect.poll(() => t.accepted.length).toBe(2)
    expect(t.limits.inFlight).toBe(2)
    expect(t.refused()).toBe(0)
  })

  it('leaves another upgrade an HTTP request', async () => {
    const t = await serve(await build())
    const answer = await fetchRaw(t.port, '/', 'GET', {
      Connection: 'Upgrade, HTTP2-Settings',
      Upgrade: 'h2c',
      'HTTP2-Settings': 'AAMAAABkAAQAoAAAAAIAAAAA',
    })
    expect(answer).toMatchObject({ status: 200, body: INDEX })
    expect(t.refused()).toBe(0)
  })

  it("refuses another site's page, an opaque origin and any other path", async () => {
    const t = await serve(null)
    await expect(
      openClient(t.port, '/channel', { origin: 'http://evil.example' }),
    ).rejects.toThrow()
    await expect(
      openClient(t.port, '/channel', { origin: `http://${LOCALHOST}:${t.port + 1}` }),
    ).rejects.toThrow()
    await expect(openClient(t.port, '/channel', { origin: 'null' })).rejects.toThrow()
    await expect(openClient(t.port, '/socket')).rejects.toThrow()
    expect(t.refused()).toBe(4)
    expect(t.accepted).toHaveLength(0)
    expect(t.limits.inFlight).toBe(0)
  })

  it('spends the handshakes of the direct port', async () => {
    const t = await serve(null)
    for (let i = 0; i < SOURCE_BURST; i++) await openClient(t.port)
    await expect(openClient(t.port)).rejects.toThrow()
    expect(t.refused()).toBe(1)
    // The host's first message settles the handshake.
    await expect.poll(() => t.accepted.length).toBe(SOURCE_BURST)
    t.accepted[0]!.send(new Uint8Array([1]))
    expect(t.limits.inFlight).toBe(SOURCE_BURST - 1)
  })

  it('carries each binary message whole, either way, keeping those before a listener', async () => {
    const t = await serve(null)
    const { client, transport } = await channel(t)
    client.send(new Uint8Array([1, 2, 3]))
    client.send(new Uint8Array([4]))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const received: number[][] = []
    transport.onMessage((message) => received.push([...message]))
    expect(received).toEqual([[1, 2, 3], [4]])

    const reply = nextMessage(client)
    transport.send(new Uint8Array([9, 8]))
    expect(await reply).toEqual({ data: Buffer.from([9, 8]), isBinary: true })
    await transport.drained()
    expect(transport.buffered()).toBe(0)

    const closed = closeCode(client)
    let ended = false
    transport.onClose(() => (ended = true))
    transport.close()
    expect(await closed).toBe(1000)
    await expect.poll(() => ended).toBe(true)
  })

  it('holds messages while paused and hands them over in order once it resumes', async () => {
    const t = await serve(null)
    const { client, transport } = await channel(t)
    const received: number[] = []
    transport.onMessage((message) => {
      received.push(message[0]!)
      if (message[0] === 2) transport.pause()
    })
    for (const n of [1, 2, 3, 4]) client.send(new Uint8Array([n]))
    await expect.poll(() => received).toEqual([1, 2])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).toEqual([1, 2])
    transport.resume()
    await expect.poll(() => received).toEqual([1, 2, 3, 4])
  })

  it('ends a connection that sends text or a message longer than Noise allows', async () => {
    const t = await serve(null)
    const text = await channel(t)
    const textClosed = closeCode(text.client)
    text.client.send('hello')
    expect(await textClosed).toBe(1003)

    const long = await channel(t)
    const longClosed = closeCode(long.client)
    let ended = false
    long.transport.onClose(() => (ended = true))
    long.client.send(new Uint8Array(65536))
    expect(await longClosed).toBe(1009)
    await expect.poll(() => ended).toBe(true)
  })
})
