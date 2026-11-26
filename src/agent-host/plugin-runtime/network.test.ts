import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { domainCovers } from '@shared/plugins'
import type { ProxySettings } from '@shared/settings'
import type { Env } from '../find-command'
import { applyProxy } from '../shell-env'
import {
  FETCH_REQUEST_BYTES,
  FETCH_RESPONSE_BYTES,
  createHttpsTransport,
  httpsTransport,
  isPublicAddress,
  isPublicHost,
  networkFetch,
  publicLookup,
  type HttpRequest,
  type HttpTransport,
} from './network'

const PERMISSIONS = ['network:api.example.com', 'network:*.cdn.example.org', 'sessions.summary']

function setup() {
  const sent: HttpRequest[] = []
  const transport: HttpTransport = vi.fn(async (request) => {
    sent.push(request)
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }
  })
  const run = (url: unknown, init?: unknown, permissions: string[] = PERMISSIONS) =>
    networkFetch(transport).run({ pluginId: 'p0123456789ab', permissions }, [url, init])
  return { run, sent, transport }
}

describe('the domains a network permission covers', () => {
  it('is the host itself, or what lies under it for a wildcard, and never a look-alike', () => {
    expect(domainCovers('api.example.com', 'api.example.com')).toBe(true)
    expect(domainCovers('api.example.com', 'v2.api.example.com')).toBe(false)
    expect(domainCovers('api.example.com', 'example.com')).toBe(false)
    expect(domainCovers('api.example.com', 'evilapi.example.com')).toBe(false)
    expect(domainCovers('*.cdn.example.org', 'a.cdn.example.org')).toBe(true)
    expect(domainCovers('*.cdn.example.org', 'a.b.cdn.example.org')).toBe(true)
    expect(domainCovers('*.cdn.example.org', 'cdn.example.org')).toBe(false)
    expect(domainCovers('*.cdn.example.org', 'acdn.example.org')).toBe(false)
    expect(domainCovers('*.cdn.example.org', 'cdn.example.org.evil.com')).toBe(false)
  })
})

describe('network.fetch', () => {
  it('reaches a granted host over https and hands back the response', async () => {
    const { run, sent } = setup()
    expect(await run('HTTPS://API.Example.com/v1/items?limit=2')).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'ok',
    })
    expect(sent[0]).toMatchObject({ method: 'GET', body: null })
    expect(sent[0]!.url.href).toBe('https://api.example.com/v1/items?limit=2')
    expect(sent[0]!.headers).toEqual({ 'user-agent': 'Kettu', 'accept-encoding': 'identity' })
    await run('https://a.b.cdn.example.org/x.js')
    expect(sent).toHaveLength(2)
  })

  it('refuses a host no permission names, saying which permission it would need', async () => {
    const { run, transport } = setup()
    const refused = [
      'https://evil.example.net/',
      'https://example.com/',
      'https://v2.api.example.com/',
      'https://cdn.example.org/',
      'https://api.example.com.evil.net/',
      // Trailing dot, an address and a name without a dot are not the host a permission names.
      'https://api.example.com./',
      'https://93.184.216.34/',
      'https://[::1]/',
      'https://localhost/',
    ]
    for (const url of refused) {
      await expect(run(url), url).rejects.toThrow(/not among the domains this plugin may reach/)
    }
    await expect(run('https://evil.example.net/x')).rejects.toThrow(
      'It needs the permission "network:evil.example.net"',
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses a plugin with no network permission at all', async () => {
    const { run, transport } = setup()
    await expect(run('https://api.example.com/', undefined, ['sessions.summary'])).rejects.toThrow(
      'network:api.example.com',
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses what is not a plain https address on the default port', async () => {
    const { run, transport } = setup()
    for (const url of [
      'http://api.example.com/',
      'ftp://api.example.com/',
      'https://api.example.com:8443/',
      'https://user:secret@api.example.com/',
      'file:///etc/passwd',
      'not a url',
      '//api.example.com/',
      42,
      undefined,
      `https://api.example.com/${'a'.repeat(3000)}`,
    ]) {
      await expect(run(url), String(url).slice(0, 40)).rejects.toThrow()
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('takes a method, headers and a body it can send, and no more', async () => {
    const { run, sent, transport } = setup()
    await run('https://api.example.com/', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'My plugin' },
      body: '{}',
    })
    expect(sent[0]).toMatchObject({ method: 'POST', body: '{}' })
    expect(sent[0]!.headers).toEqual({
      'user-agent': 'My plugin',
      'accept-encoding': 'identity',
      'content-type': 'application/json',
    })
    const bad: unknown[] = [
      { method: 'TRACE' },
      { method: 'CONNECT' },
      { method: 5 },
      { body: 5 },
      { body: 'x' },
      { method: 'POST', body: 'x'.repeat(FETCH_REQUEST_BYTES + 1) },
      { headers: { Host: 'example.net' } },
      { headers: { 'Content-Length': '5' } },
      { headers: { 'Proxy-Authorization': 'Basic abc' } },
      { headers: { 'Proxy-Connection': 'keep-alive' } },
      { headers: { 'X Bad': 'x' } },
      { headers: { Accept: 5 } },
      { headers: 'text' },
      'POST',
      ['GET'],
    ]
    for (const init of bad) {
      await expect(
        run('https://api.example.com/', init),
        JSON.stringify(init)?.slice(0, 40),
      ).rejects.toThrow()
    }
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('refuses reserved local and internal hosts even when a permission names them', async () => {
    const { run, transport } = setup()
    const perms = [
      'network:app.localhost',
      'network:printer.local',
      'network:*.google.internal',
      'network:host.docker.internal',
      'network:box.localdomain',
      'network:*.home.arpa',
    ]
    for (const url of [
      'https://app.localhost/',
      'https://printer.local/',
      'https://metadata.google.internal/',
      'https://host.docker.internal/',
      'https://box.localdomain/',
      'https://router.home.arpa/',
    ]) {
      await expect(run(url, undefined, perms), url).rejects.toThrow(
        'is on this computer or a private network',
      )
    }
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('the addresses a plugin may connect to', () => {
  it('are public ones: not this computer, a private network or a link-local address', () => {
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      'not an address',
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    for (const address of [
      '8.8.8.8',
      '93.184.216.34',
      '172.32.0.1',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
      // What a proxy tool in fake-IP mode answers with.
      '198.18.0.12',
    ]) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it('are filtered out of a name that resolves to several', async () => {
    const lookup = publicLookup((_, __, callback) =>
      callback(null, [
        { address: '10.0.0.5', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ]),
    )
    const answers = await new Promise<unknown[]>((resolve) => {
      lookup('api.example.com', { all: true }, (error, address) => resolve([error, address]))
    })
    expect(answers).toEqual([null, [{ address: '93.184.216.34', family: 4 }]])
    const one = await new Promise<unknown[]>((resolve) => {
      lookup('api.example.com', {}, (error, address, family) => resolve([error, address, family]))
    })
    expect(one).toEqual([null, '93.184.216.34', 4])
  })

  it('fail a name that resolves only to this computer or a private network', async () => {
    const lookup = publicLookup((_, __, callback) =>
      callback(null, [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ]),
    )
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      lookup('rebinding.example.com', { all: true }, (failure) => resolve(failure))
    })
    expect(error?.message).toContain('resolves to an address on this computer')
  })

  it('keep the request away from a server on this computer even under a granted name', async () => {
    let connections = 0
    const server = createServer(() => {
      connections++
    })
    server.on('connection', () => connections++)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      // `localhost` resolves to this computer as a name under a permission would.
      await expect(
        httpsTransport({
          url: new URL(`https://localhost:${port}/`),
          method: 'GET',
          headers: {},
          body: null,
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow('resolves to an address on this computer')
      expect(connections).toBe(0)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('recognizes public hostnames versus loopback, private IPs, and reserved local/internal names', () => {
    for (const host of [
      '',
      '127.0.0.1',
      '127.9.8.7',
      '0.0.0.0',
      '10.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '::1',
      '[::1]',
      '[::]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[::ffff:a00:1]',
      '[fe80::1]',
      'fe80::1%eth0',
      '[fc00::1]',
      'localhost',
      'LOCALHOST.',
      'app.localhost',
      'a.b.localhost',
      'local',
      'printer.local',
      'PRINTER.LOCAL.',
      'internal',
      'metadata.google.internal',
      'host.docker.internal',
      'localdomain',
      'localhost.localdomain',
      'home.arpa',
      'router.home.arpa',
      '1.0.0.127.in-addr.arpa',
      '1.0.0.0.ip6.arpa',
    ]) {
      expect(isPublicHost(host), host).toBe(false)
    }
    for (const host of [
      'api.example.com',
      'a.b.cdn.example.org',
      'localhost.example.com',
      'local.example.com',
      'internal.example.com',
      'api.proxy-only.invalid',
      '8.8.8.8',
    ]) {
      expect(isPublicHost(host), host).toBe(true)
    }
  })
})

// Minimal self-signed P-256 certificate with a SAN DNS entry, constructed directly in DER so
// proxy TLS tests verify real server identity without committing static keys or shelling out.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : body.length < 0x100
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 0xff])
  return Buffer.concat([Buffer.from([tag]), length, body])
}

function selfSignedCert(dnsName: string): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const ecdsaSha256 = der(0x30, der(0x06, Buffer.from('2a8648ce3d040302', 'hex')))
  const name = der(
    0x30,
    der(0x31, der(0x30, der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from(dnsName)))),
  )
  const validity = der(
    0x30,
    der(0x17, Buffer.from('250101000000Z')),
    der(0x17, Buffer.from('350101000000Z')),
  )
  const sanValue = der(0x30, der(0x82, Buffer.from(dnsName, 'ascii')))
  const sanExt = der(0x30, der(0x06, Buffer.from('551d11', 'hex')), der(0x04, sanValue))
  const bcExt = der(
    0x30,
    der(0x06, Buffer.from('551d13', 'hex')),
    der(0x01, Buffer.from([0xff])),
    der(0x04, der(0x30, der(0x01, Buffer.from([0xff])))),
  )
  const extensions = der(0xa3, der(0x30, bcExt, sanExt))
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    ecdsaSha256,
    name,
    validity,
    name,
    spki,
    extensions,
  )
  const signature = sign('sha256', tbs, privateKey)
  const certificate = der(0x30, tbs, ecdsaSha256, der(0x03, Buffer.from([0]), signature))
  const cert = `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert }
}

describe('network.fetch through a proxy', () => {
  const servers: Array<Server | https.Server> = []
  const openSockets = new Set<Duplex>()

  afterEach(async () => {
    for (const socket of openSockets) socket.destroy()
    openSockets.clear()
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
  })

  interface SeenUpstream {
    method: string
    url: string
    headers: IncomingMessage['headers']
    body: string
  }

  async function startHttpsUpstream(
    dnsName: string,
    handler: (seen: SeenUpstream, res: import('node:http').ServerResponse) => void,
    creds: { key: string; cert: string } = selfSignedCert(dnsName),
  ): Promise<{ port: number; cert: string; seen: SeenUpstream[] }> {
    const seen: SeenUpstream[] = []
    const server = https.createServer(creds, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const entry: SeenUpstream = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        seen.push(entry)
        handler(entry, res)
      })
    })
    server.on('connection', (socket) => {
      openSockets.add(socket)
      socket.on('close', () => openSockets.delete(socket))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { port: (server.address() as AddressInfo).port, cert: creds.cert, seen }
  }

  interface MockProxy {
    url: string
    port: number
    tunnels: string[]
    proxyAuthHeaders: Array<string | undefined>
  }

  async function startConnectProxy(options: {
    forwardPort?: number
    stall?: boolean
  }): Promise<MockProxy> {
    const tunnels: string[] = []
    const proxyAuthHeaders: Array<string | undefined> = []
    const server = createServer((_req, res) => {
      res.writeHead(405)
      res.end()
    })
    server.on('connection', (socket) => {
      openSockets.add(socket)
      socket.on('close', () => openSockets.delete(socket))
    })
    server.on('connect', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
      openSockets.add(clientSocket)
      clientSocket.on('close', () => openSockets.delete(clientSocket))
      tunnels.push(req.url ?? '')
      proxyAuthHeaders.push(req.headers['proxy-authorization'])
      if (options.stall) return
      if (options.forwardPort === undefined) {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      const upstreamSocket = net.connect(options.forwardPort, '127.0.0.1', () => {
        openSockets.add(upstreamSocket)
        upstreamSocket.on('close', () => openSockets.delete(upstreamSocket))
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstreamSocket.write(head)
        upstreamSocket.pipe(clientSocket)
        clientSocket.pipe(upstreamSocket)
      })
      upstreamSocket.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => upstreamSocket.destroy())
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return { url: `http://127.0.0.1:${port}`, port, tunnels, proxyAuthHeaders }
  }

  it('reaches an allowed domain through the proxy without requiring local DNS resolution', async () => {
    const host = 'api.proxy-only.invalid'
    const upstream = await startHttpsUpstream(host, (_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-via': 'upstream' })
      res.end('{"ok":true}')
    })
    const proxy = await startConnectProxy({ forwardPort: upstream.port })
    const localLookups: string[] = []
    const transport = createHttpsTransport({
      env: () => ({ HTTPS_PROXY: proxy.url }),
      platform: 'darwin',
      ca: upstream.cert,
      lookup: (hostname, _options, callback) => {
        localLookups.push(hostname)
        const error = new Error(`ENOTFOUND ${hostname}`) as NodeJS.ErrnoException
        error.code = 'ENOTFOUND'
        callback(error, '', 0)
      },
    })
    const call = networkFetch(transport)
    const answer = await call.run({ pluginId: 'p0123456789ab', permissions: [`network:${host}`] }, [
      `https://${host}/v1/items`,
      { method: 'POST', headers: { 'x-token': 'abc' }, body: '{"q":1}' },
    ])
    expect(answer).toEqual({
      status: 200,
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'x-via': 'upstream',
      }),
      body: '{"ok":true}',
    })
    expect(localLookups).toEqual([])
    expect(proxy.tunnels).toEqual([`${host}:443`])
    expect(upstream.seen).toHaveLength(1)
    expect(upstream.seen[0]).toMatchObject({
      method: 'POST',
      url: '/v1/items',
      body: '{"q":1}',
    })
    expect(upstream.seen[0]!.headers['x-token']).toBe('abc')
  })

  it('sends proxy credentials only to the proxy and supports lowercase proxy env vars', async () => {
    const host = 'api.proxy-only.invalid'
    const upstream = await startHttpsUpstream(host, (_seen, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('authed')
    })
    const proxy = await startConnectProxy({ forwardPort: upstream.port })
    const transport = createHttpsTransport({
      env: () => ({ https_proxy: `http://alice:secret@127.0.0.1:${proxy.port}` }),
      platform: 'linux',
      ca: upstream.cert,
    })
    const call = networkFetch(transport)
    const answer = await call.run({ pluginId: 'p0123456789ab', permissions: [`network:${host}`] }, [
      `https://${host}/auth`,
    ])
    expect(answer).toMatchObject({ status: 200, body: 'authed' })
    expect(proxy.proxyAuthHeaders).toEqual([
      `Basic ${Buffer.from('alice:secret').toString('base64')}`,
    ])
    expect(upstream.seen[0]!.headers['proxy-authorization']).toBeUndefined()
  })

  it('honors NO_PROXY by falling back to the direct path with the private-IP DNS guard', async () => {
    const proxiedHost = 'api.proxy-only.invalid'
    const bypassedHost = 'bypass.example.invalid'
    const bypassedSubdomain = 'sub.direct.example.org'
    const upstream = await startHttpsUpstream(proxiedHost, (_seen, res) => {
      res.writeHead(200)
      res.end('proxied')
    })
    const proxy = await startConnectProxy({ forwardPort: upstream.port })
    const resolvedLocally: string[] = []
    const transport = createHttpsTransport({
      env: () => ({
        HTTPS_PROXY: proxy.url,
        NO_PROXY: `${bypassedHost}, .direct.example.org`,
      }),
      platform: 'darwin',
      ca: upstream.cert,
      lookup: publicLookup((hostname, _options, callback) => {
        resolvedLocally.push(hostname)
        callback(null, [{ address: '127.0.0.1', family: 4 }])
      }),
    })
    const call = networkFetch(transport)
    const permissions = [
      `network:${proxiedHost}`,
      `network:${bypassedHost}`,
      'network:*.direct.example.org',
    ]

    await expect(
      call.run({ pluginId: 'p0123456789ab', permissions }, [`https://${bypassedHost}/`]),
    ).rejects.toThrow('resolves to an address on this computer or a private network')
    await expect(
      call.run({ pluginId: 'p0123456789ab', permissions }, [`https://${bypassedSubdomain}/`]),
    ).rejects.toThrow('resolves to an address on this computer or a private network')
    expect(resolvedLocally).toEqual([bypassedHost, bypassedSubdomain])
    expect(proxy.tunnels).toEqual([])

    const answer = await call.run({ pluginId: 'p0123456789ab', permissions }, [
      `https://${proxiedHost}/`,
    ])
    expect(answer).toMatchObject({ status: 200, body: 'proxied' })
    expect(proxy.tunnels).toEqual([`${proxiedHost}:443`])
    expect(resolvedLocally).toEqual([bypassedHost, bypassedSubdomain])
  })

  it('blocks undeclared domains, literal loopback/private IPs, and local/internal hosts in proxy mode', async () => {
    const proxy = await startConnectProxy({})
    const transport = createHttpsTransport({
      env: () => ({ HTTPS_PROXY: proxy.url }),
      platform: 'darwin',
    })
    const call = networkFetch(transport)
    const permissions = [
      'network:api.example.com',
      'network:app.localhost',
      'network:printer.local',
      'network:*.google.internal',
      'network:*.home.arpa',
    ]

    for (const url of [
      'https://evil.example.net/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://10.0.0.1/',
      'https://169.254.169.254/',
      'https://[::ffff:127.0.0.1]/',
      'https://localhost/',
      'https://app.localhost/',
      'https://printer.local/',
      'https://metadata.google.internal/',
      'https://router.home.arpa/',
    ]) {
      await expect(
        call.run({ pluginId: 'p0123456789ab', permissions }, [url]),
        url,
      ).rejects.toThrow()
    }

    // Direct transport calls also refuse loopback, private IPs, and reserved local/internal hosts
    // without touching the proxy.
    for (const url of [
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://10.0.0.1/',
      'https://169.254.169.254/',
      'https://[fc00::1]/',
      'https://localhost/',
      'https://app.localhost/',
      'https://printer.local/',
      'https://metadata.google.internal/',
    ]) {
      await expect(
        transport({
          url: new URL(url),
          method: 'GET',
          headers: {},
          body: null,
          signal: AbortSignal.timeout(5000),
        }),
        url,
      ).rejects.toThrow(/this computer or a private network/)
    }

    expect(proxy.tunnels).toEqual([])
  })

  it('never follows redirects automatically and re-checks any redirect target on follow-up calls', async () => {
    const host = 'api.proxy-only.invalid'
    const bypassedHost = 'bypass.example.invalid'
    let nextLocation = 'https://evil.example.net/secret'
    const upstream = await startHttpsUpstream(host, (_seen, res) => {
      res.writeHead(302, { location: nextLocation })
      res.end()
    })
    const proxy = await startConnectProxy({ forwardPort: upstream.port })
    const directLookups: string[] = []
    const transport = createHttpsTransport({
      env: () => ({ HTTPS_PROXY: proxy.url, NO_PROXY: bypassedHost }),
      platform: 'darwin',
      ca: upstream.cert,
      lookup: publicLookup((hostname, _options, callback) => {
        directLookups.push(hostname)
        callback(null, [{ address: '10.0.0.9', family: 4 }])
      }),
    })
    const call = networkFetch(transport)
    const permissions = [`network:${host}`, `network:${bypassedHost}`, 'network:*.google.internal']

    for (const target of [
      'https://evil.example.net/secret',
      'https://127.0.0.1/admin',
      'https://169.254.169.254/latest/meta-data/',
      'https://metadata.google.internal/computeMetadata/v1/',
    ]) {
      nextLocation = target
      const redirect = (await call.run({ pluginId: 'p0123456789ab', permissions }, [
        `https://${host}/go`,
      ])) as { status: number; headers: Record<string, string> }
      expect(redirect.status).toBe(302)
      expect(redirect.headers.location).toBe(target)
      await expect(
        call.run({ pluginId: 'p0123456789ab', permissions }, [redirect.headers.location]),
        target,
      ).rejects.toThrow()
    }

    // A redirect to an allowed domain that matches NO_PROXY falls back to direct + publicLookup.
    nextLocation = `https://${bypassedHost}/next`
    const bypassedRedirect = (await call.run({ pluginId: 'p0123456789ab', permissions }, [
      `https://${host}/go`,
    ])) as { status: number; headers: Record<string, string> }
    expect(bypassedRedirect.status).toBe(302)
    await expect(
      call.run({ pluginId: 'p0123456789ab', permissions }, [bypassedRedirect.headers.location]),
    ).rejects.toThrow('resolves to an address on this computer or a private network')
    expect(directLookups).toEqual([bypassedHost])

    // Only the initial hops to `host` ever went through the proxy.
    expect(proxy.tunnels).toEqual(Array(5).fill(`${host}:443`))
  })

  it('applies dynamic Settings › Advanced proxy updates to subsequent calls', async () => {
    const host = 'api.proxy-only.invalid'
    const creds = selfSignedCert(host)
    const upstreamFirst = await startHttpsUpstream(
      host,
      (_seen, res) => {
        res.writeHead(200)
        res.end('from-first-proxy')
      },
      creds,
    )
    const upstreamSecond = await startHttpsUpstream(
      host,
      (_seen, res) => {
        res.writeHead(200)
        res.end('from-second-proxy')
      },
      creds,
    )
    const firstProxy = await startConnectProxy({ forwardPort: upstreamFirst.port })
    const secondProxy = await startConnectProxy({ forwardPort: upstreamSecond.port })

    const baseEnv: Env = {}
    let proxySetting: ProxySettings = { mode: 'custom', url: firstProxy.url, noProxy: '' }
    const transport = createHttpsTransport({
      env: () => applyProxy(baseEnv, proxySetting, 'darwin'),
      platform: 'darwin',
      ca: creds.cert,
      lookup: publicLookup((_hostname, _options, callback) =>
        callback(null, [{ address: '127.0.0.1', family: 4 }]),
      ),
    })
    const call = networkFetch(transport)
    const ctx = { pluginId: 'p0123456789ab', permissions: [`network:${host}`] }

    expect(await call.run(ctx, [`https://${host}/a`])).toMatchObject({
      status: 200,
      body: 'from-first-proxy',
    })
    expect(firstProxy.tunnels).toEqual([`${host}:443`])
    expect(secondProxy.tunnels).toEqual([])

    proxySetting = { mode: 'custom', url: secondProxy.url, noProxy: '' }
    expect(await call.run(ctx, [`https://${host}/b`])).toMatchObject({
      status: 200,
      body: 'from-second-proxy',
    })
    expect(firstProxy.tunnels).toEqual([`${host}:443`])
    expect(secondProxy.tunnels).toEqual([`${host}:443`])

    // Switching back to environment mode with no env proxy returns to direct mode.
    proxySetting = { mode: 'environment' }
    await expect(call.run(ctx, [`https://${host}/c`])).rejects.toThrow(
      'resolves to an address on this computer or a private network',
    )
    expect(secondProxy.tunnels).toEqual([`${host}:443`])
  })

  it('still enforces response size, encoding, and abort limits through a proxy', async () => {
    const host = 'api.proxy-only.invalid'
    const upstream = await startHttpsUpstream(host, (seen, res) => {
      if (seen.url === '/large') {
        res.writeHead(200)
        res.end('x'.repeat(FETCH_RESPONSE_BYTES + 1))
        return
      }
      res.writeHead(200, { 'content-encoding': 'gzip' })
      res.end('encoded')
    })
    const proxy = await startConnectProxy({ forwardPort: upstream.port })
    const transport = createHttpsTransport({
      env: () => ({ HTTPS_PROXY: proxy.url }),
      platform: 'darwin',
      ca: upstream.cert,
    })
    const call = networkFetch(transport)
    const ctx = { pluginId: 'p0123456789ab', permissions: [`network:${host}`] }

    await expect(call.run(ctx, [`https://${host}/large`])).rejects.toThrow(/larger than/)
    await expect(call.run(ctx, [`https://${host}/gzip`])).rejects.toThrow(/encoded as gzip/)

    const stallingProxy = await startConnectProxy({ stall: true })
    const stallingTransport = createHttpsTransport({
      env: () => ({ HTTPS_PROXY: stallingProxy.url }),
      platform: 'darwin',
    })
    const controller = new AbortController()
    const pending = stallingTransport({
      url: new URL(`https://${host}/slow`),
      method: 'GET',
      headers: {},
      body: null,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(new Error('cancelled')), 50)
    await expect(pending).rejects.toThrow('cancelled')
  })
})
