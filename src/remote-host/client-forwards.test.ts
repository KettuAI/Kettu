import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserForward } from '@shared/browser'
import type { ForwardOpen, StreamCancel, StreamEnd } from '@shared/remote/streams'
import { ClientForwards } from './client-forwards'
import { HostForwards } from './forwards'

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!
    await cleanup()
  }
})

/** Picks a currently unused port on loopback and immediately releases it. */
async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Starts a local TCP server occupying a specific address and returns its port. */
async function occupyPort(
  options: { host?: string; port?: number; ipv6Only?: boolean } = {},
  banner = 'local-service',
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () =>
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${banner.length}\r\n\r\n${banner}`),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: options.port ?? 0, ...options }, () => resolve())
  })
  const port = (server.address() as net.AddressInfo).port
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    })
  cleanups.push(close)
  return { port, close }
}

/** Starts an HTTP server on 127.0.0.1 and returns its port. */
async function startHttpServer(
  handler: http.RequestListener,
  onUpgrade?: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void,
): Promise<number> {
  const server = http.createServer(handler)
  const sockets = new Set<net.Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  if (onUpgrade) server.on('upgrade', onUpgrade)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  )
  return (server.address() as net.AddressInfo).port
}

/** Wires a ClientForwards and HostForwards pair together in memory as a real tunnel. */
function tunnelPair(
  clientOptions: Partial<ConstructorParameters<typeof ClientForwards>[0]> = {},
  hostConnect?: (host: BrowserForward['host'], port: number) => net.Socket,
) {
  let nextStream = 1
  const sentToHost: (ForwardOpen | StreamEnd | StreamCancel)[] = []
  const ref: { client?: ClientForwards } = {}
  const host = new HostForwards({
    send: (msg) => {
      queueMicrotask(() => ref.client?.message(msg))
    },
    sendBytes: (stream, data) => {
      const copy = new Uint8Array(data)
      queueMicrotask(() => ref.client?.bytes(stream, copy))
    },
    transport: { buffered: () => 0, drained: () => Promise.resolve() },
    ...(hostConnect ? { connect: hostConnect } : {}),
    log: () => {},
  })
  const client = new ClientForwards({
    send: (msg) => {
      sentToHost.push(msg)
      if (msg.type === 'forward.open') {
        host.open(msg.stream, msg as unknown as Record<string, unknown>)
      } else if (msg.type === 'stream.end') {
        host.end(msg.stream)
      } else if (msg.type === 'stream.cancel') {
        host.cancel(msg.stream)
      }
      return true
    },
    sendBytes: (stream, data) => {
      host.bytes(stream, new Uint8Array(data))
      return Promise.resolve()
    },
    nextStream: () => {
      const id = nextStream
      nextStream += 2
      return id
    },
    log: () => {},
    ...clientOptions,
  })
  ref.client = client
  cleanups.push(() => {
    client.closeAll()
    host.close()
  })
  return { client, host, sentToHost }
}

/** Grants `forward` (and optional companion `forwards`) on `HostForwards` via `observe`. */
function grant(
  host: HostForwards,
  sessionId: string,
  forward: BrowserForward,
  forwards?: BrowserForward[],
): void {
  host.observe({
    type: 'event',
    event: {
      type: 'browser.call',
      call: { sessionId, forward, ...(forwards ? { forwards } : {}) },
    },
  })
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.once('error', reject)
    req.end()
  })
}

describe('ClientForwards port binding and lifecycle', () => {
  it('binds the preferred original port on 127.0.0.1 when free and reuses it for the same session/port', async () => {
    const targetPort = await freePort()
    const { client } = tunnelPair()

    const [first, second] = await Promise.all([
      client.listen('s1', { host: 'localhost', port: targetPort }),
      client.listen('s1', { host: 'localhost', port: targetPort }),
    ])
    expect(first).toBe(targetPort)
    expect(second).toBe(targetPort)

    // Subsequent call also reuses the exact same listener without creating a duplicate.
    const third = await client.listen('s1', { host: 'localhost', port: targetPort })
    expect(third).toBe(targetPort)

    // Closing the session releases the port so a local server can bind it immediately.
    client.close('s1')
    const rebound = await occupyPort({ host: '127.0.0.1', port: targetPort })
    expect(rebound.port).toBe(targetPort)
  })

  it('falls back to an ephemeral port without hijacking an existing local 127.0.0.1 service', async () => {
    const local = await occupyPort({ host: '127.0.0.1' }, 'local-127-service')
    const { client } = tunnelPair()

    const forwarded = await client.listen('s1', { host: 'localhost', port: local.port })
    expect(forwarded).not.toBeNull()
    expect(forwarded).not.toBe(local.port)

    // Direct requests to the occupied port still reach the user's own local service.
    const direct = await httpGet(local.port, '/')
    expect(direct.body).toBe('local-127-service')
  })

  it('detects local 0.0.0.0, dual-stack ::, and IPv6 ::1 services and falls back without shadowing them', async () => {
    const wildcardV4 = await occupyPort({ host: '0.0.0.0' }, 'local-wildcard-v4')
    const wildcardDual = await occupyPort({}, 'local-wildcard-dual')
    const loopbackV6 = await occupyPort({ host: '::1', ipv6Only: true }, 'local-loopback-v6')
    const { client } = tunnelPair()

    const forwardedV4 = await client.listen('s1', { host: 'localhost', port: wildcardV4.port })
    expect(forwardedV4).not.toBeNull()
    expect(forwardedV4).not.toBe(wildcardV4.port)

    const forwardedDual = await client.listen('s1', { host: 'localhost', port: wildcardDual.port })
    expect(forwardedDual).not.toBeNull()
    expect(forwardedDual).not.toBe(wildcardDual.port)

    const forwardedV6 = await client.listen('s1', { host: 'localhost', port: loopbackV6.port })
    expect(forwardedV6).not.toBeNull()
    expect(forwardedV6).not.toBe(loopbackV6.port)

    expect((await httpGet(wildcardV4.port, '/')).body).toBe('local-wildcard-v4')
    expect((await httpGet(wildcardDual.port, '/')).body).toBe('local-wildcard-dual')
  })

  it('falls back gracefully on direct EADDRINUSE race even if port probe missed occupation', async () => {
    const local = await occupyPort({ host: '127.0.0.1' }, 'race-service')
    const { client } = tunnelPair({ probePort: async () => false })

    const forwarded = await client.listen('s1', { host: 'localhost', port: local.port })
    expect(forwarded).not.toBeNull()
    expect(forwarded).not.toBe(local.port)
  })

  it('skips privileged (< 1024) and reserved Kettu internal ports and uses an ephemeral port', async () => {
    const probePort = vi.fn(async () => false)
    const reserved = await freePort()
    const perCallReserved = await freePort()
    const { client } = tunnelPair({
      probePort,
      isPortReserved: (port) => port === reserved,
    })

    const privPort = await client.listen('s1', { host: 'localhost', port: 80 })
    const reservedOut = await client.listen('s1', { host: 'localhost', port: reserved })
    const perCallOut = await client.listen('s1', { host: 'localhost', port: perCallReserved }, [
      perCallReserved,
    ])

    expect(privPort).not.toBeNull()
    expect(privPort).toBeGreaterThanOrEqual(1024)
    expect(reservedOut).not.toBeNull()
    expect(reservedOut).not.toBe(reserved)
    expect(perCallOut).not.toBeNull()
    expect(perCallOut).not.toBe(perCallReserved)
    // Never even probed skipped ports.
    expect(probePort).not.toHaveBeenCalled()
  })

  it('falls back when another session already holds the preferred port and cleans up on close/closeAll', async () => {
    const sharedPort = await freePort()
    const { client } = tunnelPair()

    const s1Port = await client.listen('s1', { host: 'localhost', port: sharedPort })
    const s2Port = await client.listen('s2', { host: 'localhost', port: sharedPort })
    expect(s1Port).toBe(sharedPort)
    expect(s2Port).not.toBeNull()
    expect(s2Port).not.toBe(sharedPort)

    client.closeAll()
    const rebound = await occupyPort({ host: '127.0.0.1', port: sharedPort })
    expect(rebound.port).toBe(sharedPort)
  })

  it('releases a listener cleanly if close() is called while port probing is still pending', async () => {
    const targetPort = await freePort()
    let finishProbe!: (occupied: boolean) => void
    const { client } = tunnelPair({
      probePort: () => new Promise<boolean>((resolve) => (finishProbe = resolve)),
    })

    const pending = client.listen('s1', { host: 'localhost', port: targetPort })
    client.close('s1')
    finishProbe(false)
    expect(await pending).toBeNull()

    // Ensure no leaked listener remained bound to targetPort.
    const rebound = await occupyPort({ host: '127.0.0.1', port: targetPort })
    expect(rebound.port).toBe(targetPort)
  })
})

describe('ClientForwards + HostForwards end-to-end CORS and WebSocket forwarding', () => {
  it('preserves original ports and CORS headers seamlessly for frontend + companion backend when free', async () => {
    // Simulate remote dev servers behind a virtual host port map so local ports can match the remote ports.
    const remoteFrontendPort = await freePort()
    const remoteBackendPort = await freePort()
    const actualFrontend = await startHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null }))
    })
    const actualBackend = await startHttpServer((req, res) => {
      const origin = req.headers.origin
      if (origin === `http://localhost:${remoteFrontendPort}`) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Credentials', 'true')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ host: req.headers.host, origin: origin ?? null }))
    })

    const portMap = new Map<number, number>([
      [remoteFrontendPort, actualFrontend],
      [remoteBackendPort, actualBackend],
    ])
    const { client, host } = tunnelPair({}, (_host, port) =>
      net.connect({ host: '127.0.0.1', port: portMap.get(port) ?? port, allowHalfOpen: true }),
    )

    grant(host, 's1', { host: 'localhost', port: remoteFrontendPort }, [
      { host: 'localhost', port: remoteBackendPort },
    ])

    const localFrontend = await client.listen('s1', { host: 'localhost', port: remoteFrontendPort })
    const localBackend = await client.listen('s1', { host: 'localhost', port: remoteBackendPort })
    expect(localFrontend).toBe(remoteFrontendPort)
    expect(localBackend).toBe(remoteBackendPort)

    const apiRes = await httpGet(localBackend!, '/api', {
      Host: `localhost:${localBackend}`,
      Origin: `http://localhost:${localFrontend}`,
    })
    expect(apiRes.status).toBe(200)
    expect(apiRes.headers['access-control-allow-origin']).toBe(
      `http://localhost:${remoteFrontendPort}`,
    )
    expect(JSON.parse(apiRes.body)).toEqual({
      host: `localhost:${remoteBackendPort}`,
      origin: `http://localhost:${remoteFrontendPort}`,
    })
  })

  it('keeps Host, Origin, CORS ACAO, Location, and WebSocket HMR consistent when the frontend falls back to an ephemeral port', async () => {
    // Occupy the frontend port locally so it must fall back, while the companion backend port stays free.
    const occupiedFrontend = await occupyPort({ host: '127.0.0.1' }, 'my-local-app')
    const remoteFrontendPort = occupiedFrontend.port
    const remoteBackendPort = await freePort()

    const actualFrontend = await startHttpServer(
      (req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: `http://localhost:${remoteFrontendPort}/after-login` })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            host: req.headers.host,
            origin: req.headers.origin ?? null,
            referer: req.headers.referer ?? null,
          }),
        )
      },
      (req, socket) => {
        // Strict dev-server HMR origin/host check.
        if (
          req.headers.host !== `localhost:${remoteFrontendPort}` ||
          req.headers.origin !== `http://localhost:${remoteFrontendPort}`
        ) {
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
          return
        }
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
        )
        socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])))
      },
    )

    const actualBackend = await startHttpServer((req, res) => {
      const origin = req.headers.origin
      // Backend strictly allows only the remote frontend's original origin.
      if (origin === `http://localhost:${remoteFrontendPort}`) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ host: req.headers.host, origin: origin ?? null }))
    })

    const portMap = new Map<number, number>([
      [remoteFrontendPort, actualFrontend],
      [remoteBackendPort, actualBackend],
    ])
    const { client, host } = tunnelPair({}, (_host, port) =>
      net.connect({ host: '127.0.0.1', port: portMap.get(port) ?? port, allowHalfOpen: true }),
    )

    grant(host, 's1', { host: 'localhost', port: remoteFrontendPort }, [
      { host: 'localhost', port: remoteBackendPort },
    ])

    const localFrontend = await client.listen('s1', { host: 'localhost', port: remoteFrontendPort })
    const localBackend = await client.listen('s1', { host: 'localhost', port: remoteBackendPort })
    expect(localFrontend).not.toBeNull()
    expect(localFrontend).not.toBe(remoteFrontendPort)
    expect(localBackend).toBe(remoteBackendPort)

    // 1. Frontend request receives rewritten Host / Origin / Referer.
    const pageRes = await httpGet(localFrontend!, '/', {
      Host: `localhost:${localFrontend}`,
      Origin: `http://localhost:${localFrontend}`,
      Referer: `http://localhost:${localFrontend}/app`,
    })
    expect(JSON.parse(pageRes.body)).toEqual({
      host: `localhost:${remoteFrontendPort}`,
      origin: `http://localhost:${remoteFrontendPort}`,
      referer: `http://localhost:${remoteFrontendPort}/app`,
    })

    // 2. Redirect Location stays on the local fallback port rather than jumping to the occupied local app.
    const redirectRes = await httpGet(localFrontend!, '/redirect', {
      Host: `localhost:${localFrontend}`,
    })
    expect(redirectRes.status).toBe(302)
    expect(redirectRes.headers.location).toBe(`http://localhost:${localFrontend}/after-login`)

    // 3. Companion backend CORS preflight + GET from the fallback frontend origin succeed end to end.
    const preflight = await httpGet(
      localBackend!,
      '/api',
      { Host: `localhost:${localBackend}`, Origin: `http://localhost:${localFrontend}` },
      'OPTIONS',
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-origin']).toBe(
      `http://localhost:${localFrontend}`,
    )

    const apiRes = await httpGet(localBackend!, '/api', {
      Host: `localhost:${localBackend}`,
      Origin: `http://localhost:${localFrontend}`,
    })
    expect(apiRes.headers['access-control-allow-origin']).toBe(`http://localhost:${localFrontend}`)
    expect(JSON.parse(apiRes.body)).toEqual({
      host: `localhost:${remoteBackendPort}`,
      origin: `http://localhost:${remoteFrontendPort}`,
    })

    // 4. An unauthorized foreign origin is still rejected by backend CORS (never forged).
    const foreignRes = await httpGet(localBackend!, '/api', {
      Host: `localhost:${localBackend}`,
      Origin: 'https://evil.example',
    })
    expect(foreignRes.headers['access-control-allow-origin']).toBeUndefined()

    // 5. WebSocket / HMR upgrade passes strict Host & Origin checks and streams frames bidirectionally.
    const wsReply = await new Promise<string>((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: localFrontend! })
      let received = ''
      let sentPayload = false
      sock.once('error', reject)
      sock.once('connect', () => {
        sock.write(
          [
            'GET /hmr HTTP/1.1',
            `Host: localhost:${localFrontend}`,
            `Origin: http://localhost:${localFrontend}`,
            'Connection: Upgrade',
            'Upgrade: websocket',
            '',
            '',
          ].join('\r\n'),
        )
      })
      sock.on('data', (chunk) => {
        received += chunk.toString('latin1')
        if (!sentPayload && received.includes('101 Switching Protocols\r\n')) {
          sentPayload = true
          sock.write('ping-hmr')
        } else if (received.includes('echo:ping-hmr')) {
          sock.end()
          resolve(received)
        }
      })
    })
    expect(wsReply).toContain('101 Switching Protocols')
    expect(wsReply).toContain('echo:ping-hmr')
  })
})
